/**
 * TDD-adjacent suite for experiment-import.ts (issue #8) — importing admissible Hugin
 * champion/challenger experiment outcomes into the capability ledger.
 *
 * Covers the acceptance criteria directly: a complete admissible outcome imports and is
 * reconstructable + query-joinable; re-import is idempotent; each rejection class fails closed
 * with a specific reason; a failed experiment is retained without routing impact; product rating
 * stays linked-not-flattened; placeholder identity is rejected.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import { getVerdict, getDelegationById, listEvidenceIdentityBuckets, reconstructEvidenceIdentity } from "../src/homeserver/ledger.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";
import {
  importHuginExperimentOutcome,
  getExperimentImportRecord,
  getActiveExperimentSubjectRecord,
  type HuginExperimentOutcomeBundle,
} from "../src/homeserver/experiment-import.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-experiment-import-test-"));
  initDb(join(dir, "test.db"));
});

// ─── fixture builders ─────────────────────────────────────────────────────────────

function digest(seed: string) {
  return {
    kind: "digest" as const,
    id: `id-${seed}`,
    version: "v1",
    digest: contentDigest(seed),
    origin: "server-observed" as const,
  };
}

function completeIdentity(seed: string, overrides: Record<string, unknown> = {}) {
  return {
    modelArtifact: digest(`${seed}-model`),
    configEpoch: digest(`${seed}-config`),
    logicalTask: digest(`${seed}-task`),
    renderedPrompt: digest(`${seed}-prompt`),
    harness: digest(`${seed}-harness`),
    taxonomyVersion: { kind: "label" as const, label: "gille-inference/task-types@v1", origin: "operator-declared" as const },
    verifierRubric: digest(`${seed}-verifier`),
    sampling: digest(`${seed}-sampling`),
    toolPolicy: digest(`${seed}-tools`),
    lane: "delegate" as const,
    ...overrides,
  };
}

let seq = 0;
function baseArm(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const seed = `arm-${seq}`;
  return {
    armId: overrides["armId"] ?? "champion",
    sampleId: overrides["sampleId"] ?? `sample-${seq}`,
    taskType: "reason-hard",
    modelId: "qwen3-coder-next-80b",
    outcome: "pass" as const,
    prompt: `experiment prompt ${seed}`,
    evidenceIdentity: completeIdentity(seed),
    verifier: { name: "tsGate", independent: true, mode: "deterministic" as const },
    exposure: { contaminationStatus: "clean" as const },
    policyEpoch: "epoch-v1",
    recordedAt: "2026-07-15T10:00:00.000Z",
    ...overrides,
  };
}

function baseBundle(overrides: Record<string, unknown> = {}): HuginExperimentOutcomeBundle {
  return {
    experimentId: overrides["experimentId"] as string ?? `exp-${++seq}`,
    runId: (overrides["runId"] as string) ?? "run-1",
    status: "completed",
    arms: (overrides["arms"] as unknown[]) ?? [baseArm({ experimentTag: overrides["experimentId"] })],
    ...overrides,
  } as HuginExperimentOutcomeBundle;
}

// ─── tests ──────────────────────────────────────────────────────────────────────

describe("importHuginExperimentOutcome — admission", () => {
  it("imports a complete admissible outcome; the row is reconstructable and query-joinable", () => {
    const experimentId = "exp-admit-1";
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-hard", modelId: "model-a" });
    const bundle = baseBundle({ experimentId, runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms).toHaveLength(1);
    expect(result.arms[0]!.status).toBe("imported");
    const delegationId = result.arms[0]!.delegationId!;
    expect(delegationId).toBeTruthy();

    // Reconstructable via the existing ledger row reader.
    const row = getDelegationById(delegationId);
    expect(row).not.toBeNull();
    expect(row!.outcome).toBe("pass");
    expect(row!.taskType).toBe("reason-hard");
    expect(row!.modelId).toBe("model-a");
    expect(row!.source).toBe("hugin-experiment-import");

    // Reconstructable via the identity-bucket reader — the exact bundle round-trips.
    const buckets = listEvidenceIdentityBuckets("reason-hard", "model-a", DEFAULT_POLICY);
    const bucket = buckets.find((b) => b.evidenceIdentityHash !== null);
    expect(bucket).toBeDefined();
    expect(bucket!.disclosure).toBe("complete");
    const reconstructed = reconstructEvidenceIdentity(bucket!.evidenceIdentityHash!);
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.bundle.lane).toBe("delegate");

    // Query-joinable via the natural-key registry.
    const record = getExperimentImportRecord({ experimentId, runId: "run-1", armId: "champion", sampleId: "s1" });
    expect(record).not.toBeNull();
    expect(record!.delegationId).toBe(delegationId);
    expect(record!.rating).toBeNull();

    // Feeds routing evidence (admissible, non-shadow, completed experiment).
    const verdict = getVerdict("reason-hard", "model-a", DEFAULT_POLICY);
    expect(verdict.attempts).toBe(1);
    expect(verdict.passes).toBe(1);
  });

  it("re-import of the same outcome is idempotent (no-op, same delegation id)", () => {
    const experimentId = "exp-idem-1";
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-idem", modelId: "model-b" });
    const bundle = baseBundle({ experimentId, runId: "run-1", arms: [arm] });

    const first = importHuginExperimentOutcome(bundle);
    expect(first.arms[0]!.status).toBe("imported");
    const id1 = first.arms[0]!.delegationId;

    const second = importHuginExperimentOutcome(bundle);
    expect(second.arms[0]!.status).toBe("idempotent-noop");
    expect(second.arms[0]!.delegationId).toBe(id1);

    const verdict = getVerdict("reason-idem", "model-b", DEFAULT_POLICY);
    expect(verdict.attempts).toBe(1);
  });

  it("rejects an incomplete observation (missing verifier/exposure/evidenceIdentity) — reason 'incomplete'", () => {
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-incomplete" });
    delete (arm as Record<string, unknown>)["verifier"];
    delete (arm as Record<string, unknown>)["exposure"];
    delete (arm as Record<string, unknown>)["evidenceIdentity"];
    const bundle = baseBundle({ experimentId: "exp-incomplete", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("incomplete");
    expect(getVerdict("reason-incomplete", "qwen3-coder-next-80b", DEFAULT_POLICY).attempts).toBe(0);
  });

  it("rejects identity-incomplete evidence (an unknown identity field) — reason 'identity-incomplete'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-identity-incomplete",
      evidenceIdentity: completeIdentity("partial", { modelArtifact: { kind: "unknown", reason: "not-observed" } }),
    });
    const bundle = baseBundle({ experimentId: "exp-identity-incomplete", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("identity-incomplete");
  });

  it("rejects placeholder/fictional identity — reason 'identity-incomplete' (mirrors recordDelegation's fail-closed gate)", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-placeholder",
      evidenceIdentity: completeIdentity("ph", {
        modelArtifact: { kind: "label", label: "fixture-model-v1", origin: "operator-declared" },
      }),
    });
    const bundle = baseBundle({ experimentId: "exp-placeholder", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("identity-incomplete");
    expect(result.arms[0]!.detail).toMatch(/placeholder/i);
  });

  it("rejects a non-independent verifier — reason 'non-independent-review'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-nonindep",
      verifier: { name: "self-graded", independent: false, mode: "deterministic" },
    });
    const bundle = baseBundle({ experimentId: "exp-nonindep", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("non-independent-review");
  });

  it("rejects an advisory judge — reason 'non-independent-review'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-advisory",
      verifier: { name: "advisory-llm-judge", independent: true, mode: "advisory-judge" },
    });
    const bundle = baseBundle({ experimentId: "exp-advisory", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.reason).toBe("non-independent-review");
  });

  it("rejects a calibrated judge missing its calibration evidence id — reason 'non-independent-review'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-uncalibrated",
      verifier: { name: "llm-judge", independent: true, mode: "calibrated-judge" },
    });
    const bundle = baseBundle({ experimentId: "exp-uncalibrated", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.reason).toBe("non-independent-review");
  });

  it("rejects a non-independent product review — reason 'non-independent-review'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-review-nonindep",
      review: {
        ratingId: "rat-1",
        reviewerId: "reviewer-1",
        independent: false,
        productOutcome: "accepted",
        reasonDigest: contentDigest("reason"),
        ratedAt: "2026-07-15T10:05:00.000Z",
      },
    });
    const bundle = baseBundle({ experimentId: "exp-review-nonindep", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.reason).toBe("non-independent-review");
  });

  it("rejects contaminated exposure — reason 'contaminated'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-contaminated",
      exposure: { contaminationStatus: "contaminated" },
    });
    const bundle = baseBundle({ experimentId: "exp-contaminated", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("contaminated");
  });

  it("rejects incomplete exposure coverage — reason 'contaminated'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-coverage-incomplete",
      exposure: { contaminationStatus: "coverage-incomplete" },
    });
    const bundle = baseBundle({ experimentId: "exp-coverage-incomplete", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.reason).toBe("contaminated");
  });

  it("rejects an expired observation — reason 'expired'", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const bundle = baseBundle({ experimentId: "exp-expired", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("expired");
  });

  it("rejects a stale re-observation of the same subject arriving after a newer one — reason 'superseded'", () => {
    const experimentId = "exp-stale";
    const first = baseBundle({
      experimentId,
      runId: "run-1",
      arms: [baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-stale", recordedAt: "2026-07-15T12:00:00.000Z" })],
    });
    expect(importHuginExperimentOutcome(first).arms[0]!.status).toBe("imported");

    const stale = baseBundle({
      experimentId,
      runId: "run-0-late-arrival",
      arms: [baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-stale", recordedAt: "2026-07-15T08:00:00.000Z" })],
    });
    const result = importHuginExperimentOutcome(stale);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("superseded");
  });

  it("rejects a correction claim that targets a run which is no longer active — reason 'superseded'", () => {
    const experimentId = "exp-stale-lineage";
    const runA = baseBundle({
      experimentId,
      runId: "run-A",
      arms: [baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-stale-lineage", recordedAt: "2026-07-15T09:00:00.000Z" })],
    });
    importHuginExperimentOutcome(runA);
    const runB = baseBundle({
      experimentId,
      runId: "run-B",
      arms: [baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-stale-lineage", recordedAt: "2026-07-15T10:00:00.000Z", supersedesRunId: "run-A" })],
    });
    expect(importHuginExperimentOutcome(runB).arms[0]!.status).toBe("imported");

    // run-C claims to correct run-A, but run-B is now active — stale lineage.
    const runC = baseBundle({
      experimentId,
      runId: "run-C",
      arms: [baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-stale-lineage", recordedAt: "2026-07-15T11:00:00.000Z", supersedesRunId: "run-A" })],
    });
    const result = importHuginExperimentOutcome(runC);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("superseded");
  });

  it("accepts a valid correction (supersedesRunId targets the active run) and supersedes the prior row", () => {
    const experimentId = "exp-correction";
    const runA = baseBundle({
      experimentId,
      runId: "run-A",
      arms: [baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-correction", modelId: "model-c", recordedAt: "2026-07-15T09:00:00.000Z" })],
    });
    const resA = importHuginExperimentOutcome(runA);
    expect(resA.arms[0]!.status).toBe("imported");
    const idA = resA.arms[0]!.delegationId!;

    const runB = baseBundle({
      experimentId,
      runId: "run-B",
      arms: [
        baseArm({
          armId: "champion",
          sampleId: "s1",
          taskType: "reason-correction",
          modelId: "model-c",
          recordedAt: "2026-07-15T10:00:00.000Z",
          supersedesRunId: "run-A",
        }),
      ],
    });
    const resB = importHuginExperimentOutcome(runB);
    expect(resB.arms[0]!.status).toBe("imported");
    const idB = resB.arms[0]!.delegationId!;
    expect(idB).not.toBe(idA);

    // Only ONE row is verdict-live: the superseded original is excluded from evidence.
    const verdict = getVerdict("reason-correction", "model-c", DEFAULT_POLICY);
    expect(verdict.attempts).toBe(1);

    const active = getActiveExperimentSubjectRecord({ experimentId, armId: "champion", sampleId: "s1" });
    expect(active!.delegationId).toBe(idB);
    expect(active!.runId).toBe("run-B");
  });

  it("rejects the same run resent with different content — reason 'conflicting'", () => {
    const experimentId = "exp-conflict";
    const arm1 = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-conflict", outcome: "pass" });
    const bundle1 = baseBundle({ experimentId, runId: "run-1", arms: [arm1] });
    expect(importHuginExperimentOutcome(bundle1).arms[0]!.status).toBe("imported");

    // Same natural key (experiment/run/arm/sample), but the outcome now differs.
    const arm2 = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-conflict", outcome: "fail" });
    const bundle2 = baseBundle({ experimentId, runId: "run-1", arms: [arm2] });
    const result = importHuginExperimentOutcome(bundle2);
    expect(result.arms[0]!.status).toBe("rejected");
    expect(result.arms[0]!.reason).toBe("conflicting");
  });

  it("retains a failed experiment's evidence without changing routing (shadow, not admissible)", () => {
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-failed-exp", modelId: "model-failed", outcome: "fail" });
    const bundle = baseBundle({ experimentId: "exp-failed", runId: "run-1", status: "failed", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("imported");
    expect(result.arms[0]!.shadow).toBe(true);

    // Retained (visible on the row) but invisible to default verdict math.
    const row = getDelegationById(result.arms[0]!.delegationId!);
    expect(row).not.toBeNull();
    expect(row!.shadow).toBe(true);
    const verdict = getVerdict("reason-failed-exp", "model-failed", DEFAULT_POLICY);
    expect(verdict.attempts).toBe(0);
  });

  it("an inconclusive experiment is retained as shadow evidence, not fed to routing", () => {
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-inconclusive", modelId: "model-inc", outcome: "unverified" });
    const bundle = baseBundle({ experimentId: "exp-inconclusive", runId: "run-1", status: "inconclusive", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("imported");
    expect(result.arms[0]!.shadow).toBe(true);
  });

  it("an unqualified partial outcome is retained but shadowed until explicitly policy-qualified", () => {
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-partial", modelId: "model-partial", outcome: "partial", score: 0.5 });
    const bundle = baseBundle({ experimentId: "exp-partial", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("imported");
    expect(result.arms[0]!.shadow).toBe(true);
    expect(getVerdict("reason-partial", "model-partial", DEFAULT_POLICY).attempts).toBe(0);
  });

  it("a policy-qualified partial IS admissible evidence", () => {
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-partial-qualified",
      modelId: "model-partial-q",
      outcome: "partial",
      score: 0.5,
      policyQualifiesPartial: true,
    });
    const bundle = baseBundle({ experimentId: "exp-partial-qualified", runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.shadow).toBe(false);
    expect(getVerdict("reason-partial-qualified", "model-partial-q", DEFAULT_POLICY).attempts).toBe(1);
  });

  it("links a product rating without flattening it into the mechanical outcome column", () => {
    const experimentId = "exp-rating";
    const arm = baseArm({
      armId: "champion",
      sampleId: "s1",
      taskType: "reason-rating",
      modelId: "model-rating",
      outcome: "pass", // mechanical outcome — independent of the product rating below
      review: {
        ratingId: "rat-42",
        reviewerId: "reviewer-42",
        independent: true,
        productOutcome: "rejected", // product judgment can DISAGREE with the mechanical pass
        reasonDigest: contentDigest("product-reason"),
        ratedAt: "2026-07-15T10:05:00.000Z",
      },
    });
    const bundle = baseBundle({ experimentId, runId: "run-1", arms: [arm] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms[0]!.status).toBe("imported");

    // Mechanical row: still a clean "pass" — untouched by the product verdict.
    const row = getDelegationById(result.arms[0]!.delegationId!);
    expect(row!.outcome).toBe("pass");

    // The rating is LINKED and query-joinable via the natural key, never merged into `outcome`.
    const record = getExperimentImportRecord({ experimentId, runId: "run-1", armId: "champion", sampleId: "s1" });
    expect(record!.rating).toEqual({
      ratingId: "rat-42",
      reviewerId: "reviewer-42",
      productOutcome: "rejected",
      reasonDigest: contentDigest("product-reason"),
      ratedAt: "2026-07-15T10:05:00.000Z",
    });

    // Routing evidence is unaffected by the disagreeing product rating (pass still counts as pass).
    const verdict = getVerdict("reason-rating", "model-rating", DEFAULT_POLICY);
    expect(verdict.passes).toBe(1);
  });

  it("multiple arms in one bundle are evaluated independently — one rejection does not block others", () => {
    const good = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-multi" });
    const bad = baseArm({ armId: "challenger", sampleId: "s1", taskType: "reason-multi", exposure: { contaminationStatus: "contaminated" } });
    const bundle = baseBundle({ experimentId: "exp-multi", runId: "run-1", arms: [good, bad] });

    const result = importHuginExperimentOutcome(bundle);
    expect(result.arms).toHaveLength(2);
    const goodResult = result.arms.find((a) => a.armId === "champion")!;
    const badResult = result.arms.find((a) => a.armId === "challenger")!;
    expect(goodResult.status).toBe("imported");
    expect(badResult.status).toBe("rejected");
    expect(badResult.reason).toBe("contaminated");
  });
});

describe("importHuginExperimentOutcome — structural DB sanity", () => {
  it("does not write an experiment_import_records row for a rejected observation", () => {
    const arm = baseArm({ armId: "champion", sampleId: "s1", taskType: "reason-no-row", exposure: { contaminationStatus: "contaminated" } });
    const bundle = baseBundle({ experimentId: "exp-no-row", runId: "run-1", arms: [arm] });
    importHuginExperimentOutcome(bundle);
    const record = getExperimentImportRecord({ experimentId: "exp-no-row", runId: "run-1", armId: "champion", sampleId: "s1" });
    expect(record).toBeNull();
    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM delegations WHERE task_type = 'reason-no-row'`)
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});
