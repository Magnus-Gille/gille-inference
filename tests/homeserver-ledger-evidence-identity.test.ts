/**
 * Ledger integration tests for content-addressed evidence identity (issue #5).
 *
 * Scope: recordDelegation/importDelegations binding an EvidenceIdentityBundle to a delegations
 * row, and the new identity-aware readers (listEvidenceIdentityBuckets / getVerdictForIdentity /
 * compareEvidenceIdentities / reconstructEvidenceIdentity) that group by that identity WITHOUT
 * touching getVerdict/shouldDelegate's existing (task_type, model_id) routing behavior — see
 * homeserver-ledger.test.ts, which stays green unmodified as the routing-policy regression guard.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import {
  recordDelegation,
  importDelegations,
  getVerdict,
  listEvidenceIdentityBuckets,
  getVerdictForIdentity,
  compareEvidenceIdentities,
  reconstructEvidenceIdentity,
  type ImportableDelegation,
} from "../src/homeserver/ledger.js";
import {
  buildEvidenceIdentityBundle,
  contentDigest,
  digestIdentity,
  evidenceIdentityHash,
  labelIdentity,
  type EvidenceIdentityBundle,
} from "../src/homeserver/evidence-identity.js";
import { upsertEvidenceIdentitySnapshot } from "../src/homeserver/evidence-identity-store.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ledger-evidence-identity-test-"));
  initDb(join(dir, "test.db"));
});

const MODEL = "identity-test-model";
let counter = 0;
function uniqueType(): string {
  return `identity-t-${counter++}`;
}

/** Deliberately PARTIAL — only some of the nine fields are known — matching what a realistic
 *  future call site would have on hand today (served-model cmd + harness identity, nothing about
 *  sampling/tool-policy/logical-task/rendered-prompt/verifier yet). Used everywhere the test only
 *  cares about bucketing/verdict behavior, not the disclosure flag itself. */
function harnessBundle(harnessVersion: string, lane: EvidenceIdentityBundle["lane"] = "delegate"): EvidenceIdentityBundle {
  return buildEvidenceIdentityBundle({
    modelArtifact: digestIdentity({ id: "model-x", version: "q4", digest: contentDigest("model-x-q4"), origin: "server-observed" }),
    configEpoch: digestIdentity({ id: "epoch", version: "1", digest: contentDigest("epoch-1"), origin: "server-observed" }),
    harness: digestIdentity({ id: "homeserver-executor", version: harnessVersion, digest: contentDigest(`harness-${harnessVersion}`), origin: "learning-task-stamp" }),
    taxonomyVersion: labelIdentity("gille-inference/task-types@v1", "learning-task-stamp"),
    lane,
  });
}

/** Every one of the nine identity fields plus lane specified — the "complete" disclosure case. */
function completeHarnessBundle(harnessVersion: string, lane: EvidenceIdentityBundle["lane"] = "delegate"): EvidenceIdentityBundle {
  return buildEvidenceIdentityBundle({
    ...harnessBundle(harnessVersion, lane),
    logicalTask: digestIdentity({ id: "task", version: "v1", digest: contentDigest("task"), origin: "learning-task-stamp" }),
    renderedPrompt: digestIdentity({ id: "prompt", version: "v1", digest: contentDigest("prompt"), origin: "learning-task-stamp" }),
    verifierRubric: digestIdentity({ id: "verifier", version: "v1", digest: contentDigest("verifier"), origin: "operator-declared" }),
    sampling: digestIdentity({ id: "sampling", version: "v1", digest: contentDigest("sampling"), origin: "server-observed" }),
    toolPolicy: digestIdentity({ id: "tool-policy", version: "v1", digest: contentDigest("tool-policy"), origin: "learning-task-stamp" }),
  });
}

describe("recordDelegation + evidence identity — new-identity-new-bucket (AC1)", () => {
  it("does NOT inherit a prior identity's verdict when the harness identity changes", () => {
    const t = uniqueType();
    const v1 = harnessBundle("v1");
    const v2 = harnessBundle("v2");

    // v1: all fails.
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "a", outcome: "fail", evidenceIdentity: v1 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "b", outcome: "fail", evidenceIdentity: v1 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "c", outcome: "fail", evidenceIdentity: v1 });

    // v2: all pass — a genuinely different config epoch/harness must not carry v1's failing verdict.
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "d", outcome: "pass", evidenceIdentity: v2 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "e", outcome: "pass", evidenceIdentity: v2 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "f", outcome: "pass", evidenceIdentity: v2 });

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(2);

    const v1Bucket = getVerdictForIdentity(t, MODEL, evidenceIdentityHash(v1), DEFAULT_POLICY)!;
    const v2Bucket = getVerdictForIdentity(t, MODEL, evidenceIdentityHash(v2), DEFAULT_POLICY)!;
    expect(v1Bucket.attempts).toBe(3);
    expect(v1Bucket.passes).toBe(0);
    expect(v1Bucket.fails).toBe(3);
    expect(v2Bucket.attempts).toBe(3);
    expect(v2Bucket.passes).toBe(3);
    expect(v2Bucket.fails).toBe(0);
  });

  it("each bucket's disclosure is 'complete' when every identity field and lane are known", () => {
    const t = uniqueType();
    const bundle = completeHarnessBundle("complete-v1");
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass", evidenceIdentity: bundle });
    const bucket = getVerdictForIdentity(t, MODEL, evidenceIdentityHash(bundle), DEFAULT_POLICY)!;
    expect(bucket.disclosure).toBe("complete");
  });

  it("a bucket's disclosure is 'partial' when the bundle exists but some field is still unknown", () => {
    const t = uniqueType();
    const bundle = harnessBundle("partial-v1"); // only some of the nine fields specified
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass", evidenceIdentity: bundle });
    const bucket = getVerdictForIdentity(t, MODEL, evidenceIdentityHash(bundle), DEFAULT_POLICY)!;
    expect(bucket.disclosure).toBe("partial");
  });
});

describe("placeholder identity is inadmissible for production evidence (AC4, write-time)", () => {
  it("recordDelegation throws and writes NOTHING when the bundle contains a placeholder field", () => {
    const t = uniqueType();
    const tainted = harnessBundle("v1");
    const withPlaceholder: EvidenceIdentityBundle = { ...tainted, modelArtifact: labelIdentity("fixture-model-v1", "operator-declared") };

    expect(() =>
      recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass", evidenceIdentity: withPlaceholder })
    ).toThrow(/placeholder|fictional/i);

    // Fail CLOSED at write: no row, no snapshot — the ledger must not carry a half-written row.
    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(0);
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM delegations WHERE task_type = ?`).get(t) as { n: number };
    expect(row.n).toBe(0);
  });

  it("importDelegations rejects a placeholder identity the same way, for organic harvest evidence", () => {
    const t = uniqueType();
    const withPlaceholder: EvidenceIdentityBundle = { ...harnessBundle("v1"), configEpoch: digestIdentity({ id: "x", version: "x", digest: "0".repeat(64), origin: "server-observed" }) };
    const rec: ImportableDelegation = {
      ts: "2026-07-20T00:00:00.000Z",
      taskType: t,
      modelId: MODEL,
      prompt: "harvested",
      outcome: "pass",
      evidenceIdentity: withPlaceholder,
    };
    expect(() => importDelegations([rec])).toThrow(/placeholder|fictional/i);
    expect(listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY)).toHaveLength(0);
  });

  it("read-time defense in depth: a placeholder-tainted snapshot that bypasses recordDelegation is excluded from buckets", () => {
    // Simulate a row that reached the identity_hash column through some OTHER path than
    // recordDelegation's gate (e.g. direct SQL restore) — the read side must not trust the
    // snapshot table blindly just because a hash is present on the row.
    const t = uniqueType();
    const db = getDb();
    const taintedBundle: EvidenceIdentityBundle = { ...harnessBundle("v1"), toolPolicy: labelIdentity("placeholder", "operator-declared") };
    const hash = upsertEvidenceIdentitySnapshot(taintedBundle, "2026-07-20T00:00:00.000Z", db);
    db.prepare(
      `INSERT INTO delegations (id, ts, task_type, node_id, model_id, prompt_hash, prompt_excerpt, outcome, escalated, evidence_identity_hash, evidence_lane)
       VALUES (@id, @ts, @taskType, 'm5', @modelId, @promptHash, @promptExcerpt, 'pass', 0, @hash, 'delegate')`
    ).run({
      id: "manual-tainted-row",
      ts: "2026-07-20T00:00:00.000Z",
      taskType: t,
      modelId: MODEL,
      promptHash: "deadbeef",
      promptExcerpt: "manual",
      hash,
    });

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets.find((b) => b.evidenceIdentityHash === hash)).toBeUndefined();
  });
});

describe("legacy rows are retained but visibly incomplete (AC6)", () => {
  it("a row written with no evidenceIdentity at all lands in the null-hash 'legacy' bucket", () => {
    const t = uniqueType();
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "legacy", outcome: "pass" }); // no evidenceIdentity — every real call site today
    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(1);
    expect(buckets[0]!.evidenceIdentityHash).toBeNull();
    expect(buckets[0]!.disclosure).toBe("legacy");
    expect(buckets[0]!.lane).toBeNull();
  });

  it("legacy and identity-complete rows for the same cell are NEVER silently merged into one bucket", () => {
    const t = uniqueType();
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "legacy-1", outcome: "fail" });
    const known = completeHarnessBundle("legacy-vs-known");
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "known-1", outcome: "pass", evidenceIdentity: known });

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(2);
    const legacyBucket = buckets.find((b) => b.evidenceIdentityHash === null)!;
    const knownBucket = buckets.find((b) => b.evidenceIdentityHash === evidenceIdentityHash(known))!;
    expect(legacyBucket.fails).toBe(1);
    expect(legacyBucket.passes).toBe(0);
    expect(knownBucket.passes).toBe(1);
    expect(knownBucket.disclosure).toBe("complete");

    // getVerdict (the routing-decision-affecting reader) is UNCHANGED: it still merges everything
    // in the (task_type, model_id) cell regardless of identity — Non-goal: no routing-policy change.
    const routingVerdict = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(routingVerdict.attempts).toBe(2);
    expect(routingVerdict.passes).toBe(1);
    expect(routingVerdict.fails).toBe(1);
  });
});

describe("per-lane identity separation (AC3)", () => {
  it("the SAME model/harness/config observed on two different lanes produces two distinct buckets", () => {
    const t = uniqueType();
    const chatBundle = harnessBundle("lane-test", "chat");
    const delegateBundle = harnessBundle("lane-test", "delegate");
    expect(evidenceIdentityHash(chatBundle)).not.toBe(evidenceIdentityHash(delegateBundle));

    recordDelegation({ taskType: t, modelId: MODEL, prompt: "chat-1", outcome: "pass", evidenceIdentity: chatBundle });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "chat-2", outcome: "pass", evidenceIdentity: chatBundle });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "delegate-1", outcome: "fail", evidenceIdentity: delegateBundle });

    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(2);
    const chatB = buckets.find((b) => b.lane === "chat")!;
    const delegateB = buckets.find((b) => b.lane === "delegate")!;
    expect(chatB.passes).toBe(2);
    expect(chatB.fails).toBe(0);
    expect(delegateB.passes).toBe(0);
    expect(delegateB.fails).toBe(1);
  });
});

describe("reconstructability round trip (AC2)", () => {
  it("resolves a recorded row's identity hash back to the exact bundle that produced it", () => {
    const t = uniqueType();
    const bundle = harnessBundle("reconstruct-v1");
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "x", outcome: "pass", evidenceIdentity: bundle });

    const hash = evidenceIdentityHash(bundle);
    const snapshot = reconstructEvidenceIdentity(hash);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.bundle).toEqual(bundle);
  });

  it("returns null for a hash never recorded", () => {
    expect(reconstructEvidenceIdentity("sha256:" + "ab".repeat(32))).toBeNull();
  });
});

describe("operator comparison of two harness versions on matched tasks (AC5)", () => {
  it("compareEvidenceIdentities returns both sides' verdicts side by side for the same task type/model", () => {
    const t = uniqueType();
    const v1 = harnessBundle("compare-v1");
    const v2 = harnessBundle("compare-v2");
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "a", outcome: "fail", evidenceIdentity: v1 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "b", outcome: "fail", evidenceIdentity: v1 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "c", outcome: "pass", evidenceIdentity: v2 });
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "d", outcome: "pass", evidenceIdentity: v2 });

    const cmp = compareEvidenceIdentities(t, MODEL, evidenceIdentityHash(v1), evidenceIdentityHash(v2), DEFAULT_POLICY);
    expect(cmp.left!.passes).toBe(0);
    expect(cmp.left!.fails).toBe(2);
    expect(cmp.right!.passes).toBe(2);
    expect(cmp.right!.fails).toBe(0);
  });

  it("a side that has never been observed in this cell comes back null, not a crash or a zeroed row", () => {
    const t = uniqueType();
    const v1 = harnessBundle("compare-only-v1");
    recordDelegation({ taskType: t, modelId: MODEL, prompt: "a", outcome: "pass", evidenceIdentity: v1 });
    const cmp = compareEvidenceIdentities(t, MODEL, evidenceIdentityHash(v1), "sha256:" + "cd".repeat(32), DEFAULT_POLICY);
    expect(cmp.left).not.toBeNull();
    expect(cmp.right).toBeNull();
  });
});

describe("aggregation version-awareness under the SAME (task_type, model_id) cell", () => {
  it("three distinct identities in one cell yield three distinct buckets whose attempts sum to the cell total", () => {
    const t = uniqueType();
    const bundles = [harnessBundle("agg-v1"), harnessBundle("agg-v2"), harnessBundle("agg-v3")];
    for (const [i, b] of bundles.entries()) {
      recordDelegation({ taskType: t, modelId: MODEL, prompt: `p${i}-1`, outcome: "pass", evidenceIdentity: b });
      recordDelegation({ taskType: t, modelId: MODEL, prompt: `p${i}-2`, outcome: "fail", evidenceIdentity: b });
    }
    const buckets = listEvidenceIdentityBuckets(t, MODEL, DEFAULT_POLICY);
    expect(buckets).toHaveLength(3);
    const totalAttempts = buckets.reduce((sum, b) => sum + b.attempts, 0);
    expect(totalAttempts).toBe(6);
    // Parity guard against the accumulateOutcomeRows refactor drifting from getVerdict: the SAME
    // rows summed across every identity bucket must equal what the routing-facing getVerdict sees.
    const routingVerdict = getVerdict(t, MODEL, DEFAULT_POLICY);
    expect(totalAttempts).toBe(routingVerdict.attempts);
    expect(buckets.reduce((sum, b) => sum + b.passes, 0)).toBe(routingVerdict.passes);
    expect(buckets.reduce((sum, b) => sum + b.fails, 0)).toBe(routingVerdict.fails);
  });
});

describe("importDelegations + evidence identity", () => {
  it("stores identity on an imported (harvested) row and makes it visible to listEvidenceIdentityBuckets", () => {
    const t = uniqueType();
    const bundle = harnessBundle("harvest-v1");
    const rec: ImportableDelegation = {
      ts: "2026-07-20T05:00:00.000Z",
      taskType: t,
      modelId: MODEL,
      prompt: "harvested-prompt",
      outcome: "pass",
      source: "harvest-organic",
      evidenceIdentity: bundle,
    };
    const res = importDelegations([rec]);
    expect(res.inserted).toBe(1);

    const bucket = getVerdictForIdentity(t, MODEL, evidenceIdentityHash(bundle), DEFAULT_POLICY);
    expect(bucket).not.toBeNull();
    expect(bucket!.passes).toBe(1);
  });

  it("re-importing the identical identity-stamped record is idempotent (no duplicate bucket growth)", () => {
    const t = uniqueType();
    const bundle = harnessBundle("harvest-idempotent");
    const rec: ImportableDelegation = {
      ts: "2026-07-20T06:00:00.000Z",
      taskType: t,
      modelId: MODEL,
      prompt: "harvested-prompt-2",
      outcome: "pass",
      source: "harvest-organic",
      evidenceIdentity: bundle,
    };
    expect(importDelegations([rec]).inserted).toBe(1);
    expect(importDelegations([rec]).inserted).toBe(0);

    const bucket = getVerdictForIdentity(t, MODEL, evidenceIdentityHash(bundle), DEFAULT_POLICY)!;
    expect(bucket.attempts).toBe(1);
  });
});
