import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LearningTaskContractError,
  createLearningTaskCapabilityEpoch,
  createLearningTaskGatewayEcho,
  jcsCanonicalize,
  parseHuginRequestStamp,
  parseLearningTaskGatewayEcho,
  validateHuginRequestStamp,
} from "../src/homeserver/learning-task-contract.js";
import { canonicalTaskText, taskTextFingerprint } from "../src/homeserver/task-exposure.js";

/**
 * Issue #2, acceptance criterion 7: exercise gille-inference's real LearningTaskContract v1
 * implementation against Grimnir's own normative fixtures, not just PR #20's bespoke mocks
 * (kept unmodified in tests/homeserver-learning-task-contract.test.ts).
 *
 * Vendored from Magnus-Gille/grimnir @ bc8cf09, tests/fixtures/learning-task-contract/. See
 * tests/fixtures/learning-task-contract/PROVENANCE.md for the sync record and re-sync rule.
 *
 * gille-inference only implements one slice of Grimnir's full LearningTaskContract v1 record:
 * the Hugin request stamp / preflight / gateway-echo transport contract
 * (`src/homeserver/learning-task-contract.ts`), plus the shared `trim-utf8-sha256-v1` raw
 * fingerprint and `jcs-rfc8785-utf8-v1` canonicalization algorithms
 * (`src/homeserver/task-exposure.ts`). This file runs every vendored vector that exercises that
 * slice and documents, per fixture file, what is deliberately not run because gille has no
 * corresponding implementation to validate against:
 *
 *   - jcs-conformance-vectors.json  -- RUN (all 3 vectors) against `jcsCanonicalize`.
 *   - raw-fingerprint-vectors.json  -- RUN (all 2 vectors) against `canonicalTaskText` /
 *     `taskTextFingerprint`.
 *   - positive.json                -- RUN for every record whose `transport.state` is
 *     "m5-admitted" with a known (non-"not-applicable") `hugin_request_stamp": structural parse,
 *     full semantic validation (with a freshly advertised live epoch substituted for the
 *     response, exactly as the sibling bespoke-fixture test's `liveStamp()` helper does, since a
 *     capability epoch's HMAC secret is per-process and cannot be reproduced from a static
 *     fixture), gateway-echo structural parse, and exact reproduction of the
 *     `principal_binding_digest`. Records whose macro route is direct-gateway (no Hugin stamp) or
 *     that omit `transport` (quality-receipt, experiment-product-rating, pipeline-accounting) are
 *     skipped -- there is no Hugin-stamp transport to validate.
 *   - negative.json                -- RUN only the 6 of 102 cases whose mutation(s) stay inside
 *     `/transport/hugin_request_stamp/**` or `/transport/gateway_echo/**` AND whose expected
 *     defect is one gille's transport-slice code actually enforces (by name: "admitted M5
 *     transport requires a known Hugin stamp", "Hugin contract request matches record revision",
 *     "gateway capability echo matches requested feature set", "gateway principal substitution is
 *     rejected", "gateway admission cannot precede Hugin attempt start", "request retry telemetry
 *     is forbidden in immutable stamp"). The other 96 cases assert Grimnir's full joined-record
 *     consumer-side rules -- governance/policy manifests, tombstone/erasure protocol, pipeline
 *     accounting/denominators, lineage/correction chains, capability/experiment/quality-receipt
 *     cross-field coherence, exposure-lane semantics -- none of which gille-inference implements
 *     or has a function to run them against. Two borderline cases ("preflight advertisement must
 *     be fresh at stamp time", "partial preflight advertisement fails closed") were tried and
 *     dropped: tampering a signed preflight response is caught by the capability epoch's HMAC
 *     check before gille's freshness comparison ever runs, so they cannot be reproduced from a
 *     bare substituted value without either defeating the epoch signature (dishonest) or
 *     re-signing the tampered response with gille's own secret (which no longer represents an
 *     externally-tampered advertisement).
 *   - positive-derived.json        -- SKIPPED entirely. Correction-chain / evaluation-clock /
 *     capture-denominator accounting is Grimnir consumer-side logic; gille has no implementation.
 *   - positive-erased.json         -- SKIPPED entirely. Tombstone/erasure-protocol validation is
 *     Grimnir storage-side logic; gille has no implementation.
 *   - source-documents.json,
 *     source-document-negative.json -- SKIPPED entirely. Verifying that a `source_ref` pointer's
 *     digest matches its referenced document is a Grimnir/Hugin consumer-side responsibility;
 *     gille's schema only validates the shape of the digest pointer, never a referenced document.
 *   - validation-context.json      -- SKIPPED entirely. Trusted-evidence/governance-attestation
 *     context feeds Grimnir's full-record validator only; gille has no implementation.
 */

interface GatewayEchoLike {
  echoed_request: unknown;
  gateway_request_id: string;
  admission_id: string;
  admitted_at: string;
  authenticated_principal_id: string;
  authentication: "gateway-owner-auth" | "service-auth";
  principal_binding_digest: { algorithm: "sha256"; version: string; digest: string };
  capabilities: unknown;
}

interface GrimnirTransportRecord {
  record_id: string;
  record_kind: string;
  transport?: {
    state: string;
    hugin_request_stamp: unknown;
    gateway_echo?: GatewayEchoLike;
  };
}

interface JcsConformanceVector {
  name: string;
  input: unknown;
  expected: string;
}

interface RawFingerprintVector {
  name: string;
  input_text: string;
  trimmed_utf8: string;
  expected_sha256: string;
}

interface FixtureMutation {
  op: string;
  path: string;
  value?: unknown;
}

interface NegativeCase {
  name: string;
  from_positive: number | null;
  mutations: FixtureMutation[] | null;
  expected_error: string;
}

function fixturePath(name: string): URL {
  return new URL(`./fixtures/learning-task-contract/${name}`, import.meta.url);
}

function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(fixturePath(name), "utf8")) as T;
}

const jcsVectors = loadFixture<JcsConformanceVector[]>("jcs-conformance-vectors.json");
const rawFingerprintVectors = loadFixture<RawFingerprintVector[]>("raw-fingerprint-vectors.json");
const positiveRecords = loadFixture<GrimnirTransportRecord[]>("positive.json");
const negativeCases = loadFixture<NegativeCase[]>("negative.json");

function pointerSegments(path: string): string[] {
  return path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** Applies a vendored fixture's RFC-6901-style "set" mutations to a deep clone of `base`. */
function applyMutations<T>(base: T, mutations: FixtureMutation[]): T {
  const mutated = structuredClone(base) as Record<string, unknown>;
  for (const mutation of mutations) {
    if (mutation.op !== "set") {
      throw new Error(`vendored negative.json mutation op "${mutation.op}" is not handled by this test`);
    }
    const segments = pointerSegments(mutation.path);
    const last = segments.pop();
    if (last === undefined) throw new Error(`empty mutation path`);
    let target: Record<string, unknown> = mutated;
    for (const segment of segments) target = target[segment] as Record<string, unknown>;
    target[last] = structuredClone(mutation.value);
  }
  return mutated as T;
}

function findNegativeCase(name: string): NegativeCase {
  const found = negativeCases.find((entry) => entry.name === name);
  if (!found) throw new Error(`vendored negative.json no longer has a case named "${name}"`);
  return found;
}

function hasKnownHuginRequestStamp(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "task_instance_id" in value;
}

/** Records whose macro route actually carries a known Hugin request stamp to validate. */
const m5AdmittedRecords = positiveRecords.filter(
  (record) => record.transport?.state === "m5-admitted" && hasKnownHuginRequestStamp(record.transport.hugin_request_stamp),
);

describe("LearningTaskContract v1 against Grimnir's vendored JCS/fingerprint vectors (bc8cf09)", () => {
  it.each(jcsVectors.map((vector) => [vector.name, vector] as const))(
    "canonicalizes %s exactly as Grimnir expects",
    (_name, vector) => {
      expect(jcsCanonicalize(vector.input)).toBe(vector.expected);
    },
  );

  it.each(rawFingerprintVectors.map((vector) => [vector.name, vector] as const))(
    "reproduces the trim-utf8-sha256-v1 raw fingerprint for %s",
    (_name, vector) => {
      expect(canonicalTaskText(vector.input_text)).toBe(vector.trimmed_utf8);
      expect(taskTextFingerprint(vector.input_text).sha256).toBe(vector.expected_sha256);
    },
  );
});

describe("LearningTaskContract v1 against Grimnir's vendored positive records (bc8cf09)", () => {
  it("has at least one m5-admitted record with a known Hugin stamp to exercise", () => {
    expect(m5AdmittedRecords.length).toBeGreaterThan(0);
  });

  for (const record of m5AdmittedRecords) {
    describe(`record ${record.record_id} (${record.record_kind})`, () => {
      it("parses the vendored hugin_request_stamp structurally", () => {
        expect(() => parseHuginRequestStamp(record.transport!.hugin_request_stamp)).not.toThrow();
      });

      it("validates end to end with a freshly advertised capability epoch substituted for the response", () => {
        const stamp = parseHuginRequestStamp(record.transport!.hugin_request_stamp);
        const epoch = createLearningTaskCapabilityEpoch();
        stamp.preflight.response = epoch.advertise(new Date(stamp.preflight.response.advertised_at));
        const validated = validateHuginRequestStamp(stamp, {
          capabilityEpoch: epoch,
          authenticatedPrincipalId: stamp.expected_transport_principal_id,
          authentication: "gateway-owner-auth",
          transportIdempotencyKey: stamp.idempotency_key,
          effectiveTaskType: stamp.task_type.id,
          now: new Date(stamp.stamped_at),
        });
        expect(validated.task_instance_id).toBe(stamp.task_instance_id);
      });

      it("parses the vendored gateway_echo structurally", () => {
        const echo = record.transport!.gateway_echo;
        expect(echo).toBeDefined();
        expect(() => parseLearningTaskGatewayEcho(echo)).not.toThrow();
      });

      it("reproduces the vendored principal_binding_digest byte-for-byte", () => {
        const stamp = parseHuginRequestStamp(record.transport!.hugin_request_stamp);
        const echo = record.transport!.gateway_echo!;
        const reproduced = createLearningTaskGatewayEcho(stamp, {
          authenticatedPrincipalId: echo.authenticated_principal_id,
          authentication: echo.authentication,
          gatewayRequestId: echo.gateway_request_id,
          admissionId: echo.admission_id,
          admittedAt: new Date(echo.admitted_at),
        });
        expect(reproduced.principal_binding_digest.digest).toBe(echo.principal_binding_digest.digest);
        expect(reproduced.echoed_request).toEqual(stamp);
      });
    });
  }
});

describe("LearningTaskContract v1 against Grimnir's vendored negative records (bc8cf09)", () => {
  it.each([
    "admitted M5 transport requires a known Hugin stamp",
    "Hugin contract request matches record revision",
    "gateway capability echo matches requested feature set",
    "request retry telemetry is forbidden in immutable stamp",
  ])("rejects %s the same way Grimnir does", (name) => {
    const negativeCase = findNegativeCase(name);
    expect(negativeCase.from_positive).not.toBeNull();
    const base = positiveRecords[negativeCase.from_positive as number]!;
    expect(negativeCase.mutations).not.toBeNull();
    const mutated = applyMutations(base, negativeCase.mutations as FixtureMutation[]);

    if (name === "gateway capability echo matches requested feature set") {
      expect(() => parseLearningTaskGatewayEcho(mutated.transport!.gateway_echo)).toThrow(LearningTaskContractError);
    } else {
      expect(() => parseHuginRequestStamp(mutated.transport!.hugin_request_stamp)).toThrow(LearningTaskContractError);
    }
  });

  it("rejects gateway principal substitution the same way Grimnir does", () => {
    const negativeCase = findNegativeCase("gateway principal substitution is rejected");
    const attackerPrincipal = negativeCase.mutations![0]!.value as string;
    const base = positiveRecords[negativeCase.from_positive as number]!;
    const stamp = parseHuginRequestStamp(base.transport!.hugin_request_stamp);
    const echo = base.transport!.gateway_echo!;

    expect(() =>
      createLearningTaskGatewayEcho(stamp, {
        authenticatedPrincipalId: attackerPrincipal,
        authentication: echo.authentication,
        gatewayRequestId: echo.gateway_request_id,
        admissionId: echo.admission_id,
        admittedAt: new Date(echo.admitted_at),
      }),
    ).toThrow(/principal/i);
  });

  it("rejects gateway admission preceding the Hugin attempt the same way Grimnir does", () => {
    const negativeCase = findNegativeCase("gateway admission cannot precede Hugin attempt start");
    const tamperedAdmittedAt = negativeCase.mutations![0]!.value as string;
    const base = positiveRecords[negativeCase.from_positive as number]!;
    const stamp = parseHuginRequestStamp(base.transport!.hugin_request_stamp);
    const echo = base.transport!.gateway_echo!;
    expect(Date.parse(tamperedAdmittedAt)).toBeLessThan(Date.parse(stamp.stamped_at));

    expect(() =>
      createLearningTaskGatewayEcho(stamp, {
        authenticatedPrincipalId: echo.authenticated_principal_id,
        authentication: echo.authentication,
        gatewayRequestId: echo.gateway_request_id,
        admissionId: echo.admission_id,
        admittedAt: new Date(tamperedAdmittedAt),
      }),
    ).toThrow(/precedes/i);
  });
});
