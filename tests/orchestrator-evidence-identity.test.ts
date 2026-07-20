/**
 * Production wiring for issue #5 (content-addressed evidence identity) — the call-site
 * integration PR #28 deliberately deferred. #28 shipped the pure derivation
 * (evidence-identity.ts), the snapshot store, and the ledger plumbing; NOTHING populated
 * `DelegationRecord.evidenceIdentity` on a real write path until this file's subject
 * (orchestrator.ts's delegateImpl / maybeScheduleEscalationShadow) existed.
 *
 * Unlike the other orchestrator-*.test.ts files, ledger.js is DELIBERATELY NOT mocked here — the
 * whole point is to prove a real recordDelegation() write, through the real evidence-identity-store,
 * lands a reconstructable identity and buckets it correctly (mirrors
 * homeserver-ledger-evidence-identity.test.ts's real-ledger discipline, one layer up the stack).
 *
 * Covers, end to end through delegate():
 *   - AC2 reconstructability: a stamped delegate-lane write's evidence_identity_hash resolves back
 *     to the EXACT bundle evidenceIdentityFromAdmittedStamp + evidenceIdentityFromServedModelCmd
 *     would have produced.
 *   - AC5 comparison: two stamped writes differing in exactly the harness axis land in two distinct
 *     buckets that compareEvidenceIdentities can present side by side.
 *   - Per-lane correctness: the primary "delegate" lane and the "delegate-shadow" lane, on the SAME
 *     stamped task, bind to their OWN served-model identity — neither copies the other's.
 *   - An unstamped caller keeps writing a null ("legacy") identity, exactly as before — no crash, no
 *     fabricated partial bundle.
 *   - A served-model observation that resolves to a placeholder model path fails the write closed
 *     (assertAdmissibleEvidenceIdentity, exercised through the real write path this time).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { getDb, initDb } from "../src/db.js";

// ── mocks: inference clients + the served-model resolver. Ledger/evidence-identity(-store) are
// REAL — see file header. ──
const lmInferenceMock = vi.fn();
vi.mock("../src/runner/lmstudio-client.js", () => ({
  runLmStudioInference: (modelId: string, prompt: string, opts: unknown) =>
    lmInferenceMock(modelId, prompt, opts),
}));

const frontierMock = vi.fn();
vi.mock("../src/runner/openrouter-client.js", () => ({
  runInference: (modelId: string, prompt: string, opts: unknown) => frontierMock(modelId, prompt, opts),
}));

/** modelId -> the llama-swap /running `cmd` string this test wants "observed" for it. */
const servedCmdByModel = new Map<string, string | null>();
vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "primary-model" }],
  getRunningCmd: async (modelId: string) => servedCmdByModel.get(modelId) ?? null,
}));

let delegate: typeof import("../src/homeserver/orchestrator.js").delegate;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let loadRoutingTable: typeof import("../src/homeserver/routing-table.js").loadRoutingTable;
let shadowLaneIdle: typeof import("../src/homeserver/shadow-lane.js").shadowLaneIdle;
let resetShadowLane: typeof import("../src/homeserver/shadow-lane.js").resetShadowLane;
let evidenceIdentityFromAdmittedStamp: typeof import("../src/homeserver/evidence-identity.js").evidenceIdentityFromAdmittedStamp;
let evidenceIdentityFromServedModelCmd: typeof import("../src/homeserver/evidence-identity.js").evidenceIdentityFromServedModelCmd;
let buildEvidenceIdentityBundle: typeof import("../src/homeserver/evidence-identity.js").buildEvidenceIdentityBundle;
let evidenceIdentityHash: typeof import("../src/homeserver/evidence-identity.js").evidenceIdentityHash;
let listEvidenceIdentityBuckets: typeof import("../src/homeserver/ledger.js").listEvidenceIdentityBuckets;
let reconstructEvidenceIdentity: typeof import("../src/homeserver/ledger.js").reconstructEvidenceIdentity;
let compareEvidenceIdentities: typeof import("../src/homeserver/ledger.js").compareEvidenceIdentities;
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import type { HuginRequestStamp } from "../src/homeserver/learning-task-contract.js";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-evidence-identity-test-"));
  initDb(join(dir, "test.db"));

  const orch = await import("../src/homeserver/orchestrator.js");
  const cfg = await import("../src/homeserver/config.js");
  const rt = await import("../src/homeserver/routing-table.js");
  const shadow = await import("../src/homeserver/shadow-lane.js");
  const ei = await import("../src/homeserver/evidence-identity.js");
  const ledger = await import("../src/homeserver/ledger.js");
  delegate = orch.delegate;
  setConfig = cfg.setConfig;
  resetConfig = cfg.resetConfig;
  loadRoutingTable = rt.loadRoutingTable;
  shadowLaneIdle = shadow.shadowLaneIdle;
  resetShadowLane = shadow.resetShadowLane;
  evidenceIdentityFromAdmittedStamp = ei.evidenceIdentityFromAdmittedStamp;
  evidenceIdentityFromServedModelCmd = ei.evidenceIdentityFromServedModelCmd;
  buildEvidenceIdentityBundle = ei.buildEvidenceIdentityBundle;
  evidenceIdentityHash = ei.evidenceIdentityHash;
  listEvidenceIdentityBuckets = ledger.listEvidenceIdentityBuckets;
  reconstructEvidenceIdentity = ledger.reconstructEvidenceIdentity;
  compareEvidenceIdentities = ledger.compareEvidenceIdentities;
});

beforeEach(() => {
  vi.clearAllMocks();
  servedCmdByModel.clear();
  resetConfig();
  resetShadowLane();
  setConfig({ useRoutingTable: "off", disagreementGate: "off", accessLog: "off", delegationCostLog: "off" });
});

function lmOk(response = "ok") {
  return {
    ok: true as const,
    response,
    promptTokens: 10,
    completionTokens: 20,
    durationMs: 100,
    ttftMs: 30,
    tokensPerSecond: 50,
  };
}

let uniqueCounter = 0;
/** A fresh task type per test avoids any ledger cross-contamination (shouldDelegate/getVerdict see
 *  it as "unknown" -> always delegate:true, exactly like homeserver-ledger-evidence-identity.test.ts). */
function uniqueType(): string {
  return `evidence-wiring-${uniqueCounter++}`;
}

/**
 * A structurally valid HuginRequestStamp (the fields evidenceIdentityFromAdmittedStamp actually
 * reads: task_type, raw_input, hugin_envelope, origin_config.{harness,tool_policy}). This is a
 * hand-built object typed as HuginRequestStamp, not run through the zod schema/admission store —
 * delegateImpl (orchestrator.ts) consumes an ALREADY-ADMITTED stamp and never re-validates it
 * itself (gateway.ts's validateHuginRequestStamp is the semantic gate, out of this file's scope —
 * covered end-to-end at the HTTP layer in homeserver-gateway-spine.test.ts).
 */
function buildStamp(opts: { harnessDigestSeed?: string; rawInputDigestSeed?: string } = {}): HuginRequestStamp {
  const harnessSeed = opts.harnessDigestSeed ?? "harness-v1";
  const rawInputSeed = opts.rawInputDigestSeed ?? "raw-input-v1";
  const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
  return {
    task_instance_id: `task-${uniqueCounter}`,
    attempt_id: "attempt-1",
    client_id: "test-client",
    expected_transport_principal_id: "service:test",
    idempotency_key: `opaque:idem-${uniqueCounter}`,
    request_id: `opaque:req-${uniqueCounter}`,
    stamped_at: "2026-07-20T00:00:00.000Z",
    contract_request: { contract_version: "grimnir.learning-task/v1", schema_revision: 1, features: [] },
    preflight: {
      request: {
        request_id: "opaque:preflight-req",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        requested_at: "2026-07-20T00:00:00.000Z",
        requested_capabilities: { contract_version: "grimnir.learning-task/v1", schema_revision: 1, features: [] },
      },
      response: {
        advertisement_id: "opaque:preflight-resp",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: "2026-07-20T00:00:00.000Z",
        expires_at: "2026-07-20T00:15:00.000Z",
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: { contract_version: "grimnir.learning-task/v1", schema_revision: 1, features: [] },
      },
    },
    source: {
      component: "hugin",
      system: "broker",
      id: "broker-001",
      created_at: "2026-07-20T00:00:00.000Z",
      accepted_at: "2026-07-20T00:00:00.000Z",
      principal: { id: "principal:owner", authentication: "gateway-owner-auth", scope: "owner" },
      content_owner: { id: "principal:owner", authority: "authenticated-owner" },
    },
    task_type: {
      id: "summarize",
      taxonomy_id: "gille-inference/task-types",
      taxonomy_version: "gille-inference-task-types-test-v1",
    },
    raw_input: {
      algorithm: "sha256",
      canonicalization: "jcs-rfc8785-utf8-v1",
      source_ref: `source-doc:test/raw/${rawInputSeed}`,
      source_type: "raw-input",
      source_version: "raw-input-v1",
      digest: sha(rawInputSeed),
    },
    raw_fingerprint: { algorithm: "sha256", version: "trim-utf8-sha256-v1", digest: sha(`fingerprint-${rawInputSeed}`) },
    hugin_envelope: {
      algorithm: "sha256",
      canonicalization: "jcs-rfc8785-utf8-v1",
      source_ref: "source-doc:test/prompt/1",
      source_type: "prompt-stage",
      source_version: "prompt-stage-v2",
      digest: sha("hugin-envelope-v1"),
    },
    origin_config: {
      prompt: {
        id: "test-prompt",
        version: "v1",
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:test/config/prompt-v1",
          source_type: "origin-prompt-config",
          source_version: "config-source-v1",
          digest: sha("prompt-config-v1"),
        },
      },
      harness: {
        id: "homeserver-executor",
        version: harnessSeed,
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: `source-doc:test/config/${harnessSeed}`,
          source_type: "origin-harness-config",
          source_version: "config-source-v1",
          digest: sha(harnessSeed),
        },
      },
      tool_policy: {
        id: "bounded-delegate",
        version: "v1",
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:test/config/tool-policy-v1",
          source_type: "origin-tool-policy-config",
          source_version: "config-source-v1",
          digest: sha("tool-policy-v1"),
        },
      },
    },
    macro_decision: {
      policy_id: "hugin-runtime-selection",
      version: "homeserver-delegate-learning-task-v1",
      decision_id: "learning-task:test",
      target: "m5",
      service: "gille-inference",
    },
  } as HuginRequestStamp;
}

describe("delegate-lane write binds a real evidence identity (AC2 reconstructability)", () => {
  it("a stamped write's evidence_identity_hash resolves back to exactly the bundle the pure functions would derive", async () => {
    const t = uniqueType();
    const MODEL = "primary-model";
    const cmd = "llama-server -m /models/qwen3-30b-Q4_K_M.gguf -c 32768";
    servedCmdByModel.set(MODEL, cmd);
    lmInferenceMock.mockResolvedValue(lmOk("answer"));
    const stamp = buildStamp();

    const out = await delegate({
      taskType: t,
      prompt: "summarize this",
      modelId: MODEL,
      learningTaskStamp: stamp,
      verifier: async () => ({ outcome: "pass", score: 1 }),
    });
    expect(out.delegated).toBe(true);
    expect(out.ledgerId).toBeDefined();

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(1);
    const hash = buckets[0]!.evidenceIdentityHash!;
    expect(hash).not.toBeNull();

    const expectedBundle = buildEvidenceIdentityBundle({
      ...evidenceIdentityFromAdmittedStamp(stamp),
      ...evidenceIdentityFromServedModelCmd(cmd),
      lane: "delegate",
    });
    expect(hash).toBe(evidenceIdentityHash(expectedBundle));

    const snapshot = reconstructEvidenceIdentity(hash);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.bundle).toEqual(expectedBundle);
    expect(snapshot!.bundle.lane).toBe("delegate");
    expect(snapshot!.bundle.harness.kind).toBe("digest");
    expect(snapshot!.bundle.modelArtifact.kind).toBe("digest");
  });
});

describe("operator comparison of two harness versions on the SAME task/model (AC5)", () => {
  it("two writes differing in exactly the harness axis land in two distinct, comparable buckets", async () => {
    const t = uniqueType();
    const MODEL = "primary-model";
    servedCmdByModel.set(MODEL, "llama-server -m /models/mellum.gguf -c 8192");
    lmInferenceMock.mockResolvedValue(lmOk("v1 answer"));
    const stampV1 = buildStamp({ harnessDigestSeed: "harness-v1" });
    const outV1 = await delegate({
      taskType: t,
      prompt: "task",
      modelId: MODEL,
      learningTaskStamp: stampV1,
      verifier: async () => ({ outcome: "fail", score: 0 }),
    });
    expect(outV1.delegated).toBe(true);

    lmInferenceMock.mockResolvedValue(lmOk("v2 answer"));
    const stampV2 = buildStamp({ harnessDigestSeed: "harness-v2" });
    const outV2 = await delegate({
      taskType: t,
      prompt: "task",
      modelId: MODEL,
      learningTaskStamp: stampV2,
      verifier: async () => ({ outcome: "pass", score: 1 }),
    });
    expect(outV2.delegated).toBe(true);

    const hashV1 = evidenceIdentityHash(
      buildEvidenceIdentityBundle({
        ...evidenceIdentityFromAdmittedStamp(stampV1),
        ...evidenceIdentityFromServedModelCmd("llama-server -m /models/mellum.gguf -c 8192"),
        lane: "delegate",
      })
    );
    const hashV2 = evidenceIdentityHash(
      buildEvidenceIdentityBundle({
        ...evidenceIdentityFromAdmittedStamp(stampV2),
        ...evidenceIdentityFromServedModelCmd("llama-server -m /models/mellum.gguf -c 8192"),
        lane: "delegate",
      })
    );
    expect(hashV1).not.toBe(hashV2);

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(2);

    const cmp = compareEvidenceIdentities(t, MODEL, hashV1, hashV2, DEFAULT_POLICY);
    expect(cmp.left!.fails).toBe(1);
    expect(cmp.left!.passes).toBe(0);
    expect(cmp.right!.passes).toBe(1);
    expect(cmp.right!.fails).toBe(0);
  });
});

describe("per-lane identity separation: primary delegate lane vs delegate-shadow lane", () => {
  it("the shadow lane's served-model identity is its OWN, never the primary lane's, on the same stamped task", async () => {
    setConfig({
      useRoutingTable: "on",
      shadowLane: {
        mode: "on",
        model: "shadow-model",
        taskTypes: [],
        maxTokens: 2048,
        timeoutMs: 60_000,
        agreementThreshold: 0.7,
      },
    });
    const GAP_TYPE = loadRoutingTable().escalateToFrontier[0]!;
    const shadowCmd = "llama-server -m /models/shadow-candidate.gguf -c 16384";
    servedCmdByModel.set("shadow-model", shadowCmd);
    frontierMock.mockResolvedValue({ ok: true, response: "frontier answer" });
    lmInferenceMock.mockResolvedValue(lmOk("shadow answer"));

    const stamp = buildStamp({ harnessDigestSeed: "shared-harness" });
    const out = await delegate({
      taskType: GAP_TYPE,
      prompt: "a task that gets escalated before any local attempt",
      learningTaskStamp: stamp,
      frontierModelId: "anthropic/claude-sonnet-5",
    });
    expect(out.delegated).toBe(false); // routing-table gap type escalates with zero local attempt
    await shadowLaneIdle();

    // Shadow rows are excluded from every default evidence read (#234) — includeShadow opts back in.
    const buckets = listEvidenceIdentityBuckets(GAP_TYPE, "shadow-model", DEFAULT_POLICY, "m5", { includeShadow: true });
    expect(buckets).toHaveLength(1);
    const shadowBucket = buckets[0]!;
    expect(shadowBucket.lane).toBe("delegate-shadow");

    const expectedShadowBundle = buildEvidenceIdentityBundle({
      ...evidenceIdentityFromAdmittedStamp(stamp),
      ...evidenceIdentityFromServedModelCmd(shadowCmd),
      lane: "delegate-shadow",
    });
    const snapshot = reconstructEvidenceIdentity(shadowBucket.evidenceIdentityHash!);
    expect(snapshot!.bundle).toEqual(expectedShadowBundle);
    // The shadow's modelArtifact/configEpoch must be derived from ITS OWN served cmd, never the
    // (never-observed, in this scenario) primary lane's model/config.
    expect(snapshot!.bundle.modelArtifact.kind).toBe("digest");
    if (snapshot!.bundle.modelArtifact.kind === "digest") {
      expect(snapshot!.bundle.modelArtifact.id).toBe("/models/shadow-candidate.gguf");
    }
  });
});

describe("unstamped/legacy callers keep working with a null identity", () => {
  it("a write with no learningTaskStamp lands in the null-hash legacy bucket, no crash", async () => {
    const t = uniqueType();
    const MODEL = "primary-model";
    servedCmdByModel.set(MODEL, "llama-server -m /models/mellum.gguf -c 8192");
    lmInferenceMock.mockResolvedValue(lmOk("legacy answer"));

    const out = await delegate({
      taskType: t,
      prompt: "legacy caller, no stamp",
      modelId: MODEL,
      // A real verifier so this row is "pass"/"fail" rather than "unverified" — listEvidenceIdentity-
      // Buckets (like getVerdict) only counts verdict-relevant outcomes; "unverified" rows are excluded
      // from either reader, which is orthogonal to this test's actual point (legacy null identity).
      verifier: async () => ({ outcome: "pass", score: 1 }),
    });
    expect(out.delegated).toBe(true);

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.evidenceIdentityHash).toBeNull();
    expect(buckets[0]!.disclosure).toBe("legacy");
    expect(buckets[0]!.lane).toBeNull();
  });

  it("an error-path write (local model failure) with no stamp ALSO lands legacy, no crash", async () => {
    const t = uniqueType();
    const MODEL = "primary-model";
    servedCmdByModel.set(MODEL, "llama-server -m /models/mellum.gguf -c 8192");
    lmInferenceMock.mockResolvedValue({ ok: false, error: "connection refused" });

    const out = await delegate({ taskType: t, prompt: "will error", modelId: MODEL });
    expect(out.outcome).toBe("error");

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.evidenceIdentityHash).toBeNull();
  });
});

describe("placeholder/fabricated served-model identity fails the write closed", () => {
  it("a served /running cmd that resolves to a placeholder model path throws and writes nothing", async () => {
    const t = uniqueType();
    const MODEL = "primary-model";
    // A cmd whose -m path is literally the placeholder token evidence-identity.ts rejects.
    servedCmdByModel.set(MODEL, "llama-server -m placeholder -c 4096");
    lmInferenceMock.mockResolvedValue(lmOk("should never be committed"));
    const stamp = buildStamp();

    await expect(
      delegate({ taskType: t, prompt: "tainted", modelId: MODEL, learningTaskStamp: stamp })
    ).rejects.toThrow(/placeholder|fictional/i);

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(0);
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM delegations WHERE task_type = ?`).get(t) as { n: number };
    expect(row.n).toBe(0);
  });
});
