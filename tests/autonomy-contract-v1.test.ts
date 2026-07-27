import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  digestJson,
  validateJournalV1,
  verifyMicroRoutingTargetState,
  verifyOwnerAuthorization,
  verifyRuntimeNarrowing,
} from "../src/homeserver/autonomy-contract-v1.js";

const root = new URL("../contracts/grimnir-autonomy-v1/", import.meta.url).pathname;
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(root, "fixtures", name), "utf8"));
const artifact = (name: string): unknown => JSON.parse(readFileSync(join(root, name), "utf8"));
const pem = (name: string): string => readFileSync(join(root, "fixtures", name), "utf8");
const clone = <T>(value: T): T => structuredClone(value);

function authorizationInputs() {
  return {
    authorization: fixture("test-owner-authorization.json"),
    constitution: artifact("constitution.json"),
    coverage: fixture("coverage-armed-canary.json"),
    attestations: artifact("owner-attestations.json"),
    recoveryRegistry: fixture("test-recovery-worker-registry.json"),
    pinnedOwnerPublicKeyPem: pem("test-owner-ed25519-public.pem"),
    checkpoint: fixture("test-owner-authorization-checkpoint.json"),
  };
}

describe("ADR-008 W0.1 authorization and narrowing", () => {
  it("verifies the pinned owner authorization, exact target owner, and signed narrowing tail", () => {
    const inputs = authorizationInputs();
    const verified = verifyOwnerAuthorization(inputs);
    const narrowing = verifyRuntimeNarrowing(
      fixture("test-runtime-narrowing.json"),
      inputs.recoveryRegistry,
      verified,
      fixture("test-runtime-narrowing-checkpoint.json"),
    );
    expect(verifyMicroRoutingTargetState({
      coverage: inputs.coverage,
      attestations: inputs.attestations,
      verified,
      narrowing,
      targetScopeDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      writerOwner: "gille-inference",
      controllerIdentity: "micro-route-controller",
    })).toEqual({ admittedState: "armed-canary", effectiveState: "shadow" });
  });

  it("rejects a re-digested but owner-unauthorized coverage widening", () => {
    const inputs = authorizationInputs();
    const coverage = clone(inputs.coverage) as any;
    coverage.domains[0].coverage = "armed-fleet";
    coverage.domains[0].bindings[0].state = "armed-fleet";
    coverage.registry_digest = digestJson(coverage, "registry_digest");
    expect(() => verifyOwnerAuthorization({ ...inputs, coverage })).toThrow(/artifact digest binding mismatch/);
  });

  it("rejects a self-consistent constitution outside the exact pinned Grimnir epochs", () => {
    const inputs = authorizationInputs();
    const constitution = clone(inputs.constitution) as any;
    constitution.constitution_id = "attacker-autonomy-v1";
    constitution.constitution_digest = digestJson(constitution, "constitution_digest");
    expect(() => verifyOwnerAuthorization({ ...inputs, constitution })).toThrow(
      /artifact digest binding mismatch|exact supported Grimnir epoch/,
    );
  });

  it("rejects authorization replay and owner-key substitution", () => {
    const inputs = authorizationInputs();
    const replayCheckpoint = clone(inputs.checkpoint) as any;
    replayCheckpoint.minimum_sequence = 2;
    expect(() => verifyOwnerAuthorization({ ...inputs, checkpoint: replayCheckpoint })).toThrow(/sequence|checkpoint/);
    expect(() => verifyOwnerAuthorization({
      ...inputs,
      pinnedOwnerPublicKeyPem: pem("test-attacker-ed25519-public.pem"),
    })).toThrow(/independently pinned/);
  });

  it("rejects forged widening and a truncated signed narrowing ledger", () => {
    const inputs = authorizationInputs();
    const verified = verifyOwnerAuthorization(inputs);
    const widened = fixture("test-runtime-narrowing.json") as any;
    widened.entries[0].to_state = "armed-fleet";
    expect(() => verifyRuntimeNarrowing(widened, inputs.recoveryRegistry, verified, fixture("test-runtime-narrowing-checkpoint.json"))).toThrow(/widening/);
    const truncated = fixture("test-runtime-narrowing.json") as any;
    truncated.entries = [];
    expect(() => verifyRuntimeNarrowing(truncated, inputs.recoveryRegistry, verified, fixture("test-runtime-narrowing-checkpoint.json"))).toThrow(/truncation|checkpoint/);
  });

  it("rejects a post-authorization recovery-registry substitution that retains the old digest field", () => {
    const inputs = authorizationInputs();
    const verified = verifyOwnerAuthorization(inputs);
    const substitutedRegistry = clone(inputs.recoveryRegistry) as any;
    substitutedRegistry.registry_id = "attacker-recovery-registry";
    expect(() => verifyRuntimeNarrowing(
      fixture("test-runtime-narrowing.json"),
      substitutedRegistry,
      verified,
      fixture("test-runtime-narrowing-checkpoint.json"),
    )).toThrow(/substituted recovery registry/);
  });
});

describe("ADR-008 journal-v1 conformance", () => {
  const constitution = artifact("constitution.json");
  const coverage = fixture("coverage-armed-canary.json");
  const attestations = artifact("owner-attestations.json");

  it.each([
    "journal-happy-commit.json",
    "journal-r-exact-revert.json",
    "journal-r-forward-recovery.json",
    "journal-terminally-blocked.json",
  ])("accepts the exact upstream fixture %s", (name) => {
    expect(validateJournalV1(fixture(name), constitution, coverage, attestations)).toMatchObject({
      terminal: expect.any(String),
    });
  });

  it("rejects a re-digested illegal post-unknown retry", () => {
    const journal = fixture("journal-r-exact-revert.json") as any;
    journal.entries[2].phase = "apply";
    journal.entries[2].outcome = "applied";
    let previous: string | null = null;
    for (const entry of journal.entries) {
      entry.previous_receipt_digest = previous;
      entry.receipt_digest = digestJson(entry, "receipt_digest");
      previous = entry.receipt_digest;
    }
    expect(() => validateJournalV1(journal, constitution, coverage, attestations)).toThrow(/transition|executor|deadline/);
  });

  it("rejects receipt-chain mutation and non-opaque content references", () => {
    const chainMutation = fixture("journal-happy-commit.json") as any;
    chainMutation.entries[1].recorded_at = "2026-07-26T00:06:00Z";
    expect(() => validateJournalV1(chainMutation, constitution, coverage, attestations)).toThrow(/receipt/);
    const contentLeak = fixture("journal-happy-commit.json") as any;
    contentLeak.entries[1].content_refs = ["ref:private/locator"];
    contentLeak.entries[1].receipt_digest = digestJson(contentLeak.entries[1], "receipt_digest");
    expect(() => validateJournalV1(contentLeak, constitution, coverage, attestations)).toThrow(/content-blind|receipt/);
  });
});
