import { describe, expect, it } from "vitest";
import {
  evaluateM3Qualification,
  M3_QUALIFICATION_CONTRACT,
  type M3QualificationCandidate,
  type M3QualificationInput,
  type QualificationPurposeEvidence,
  type QualificationSignal,
  type QualificationThresholds,
} from "../src/homeserver/m3-qualification.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const POLICY = "ctx-tools-parts-v1|ctx=24000";

function measured<T>(value: T, sampleSize = 10, provenance: "independently-verified" | "operator-attested" = "independently-verified"): QualificationSignal<T> {
  return { status: "measured", value, sampleSize, source: "fixture", provenance };
}

function unknown<T>(status: "unknown" | "unproven" = "unknown"): QualificationSignal<T> {
  return { status, reason: "fixture lacks this signal" };
}

function purpose(): QualificationPurposeEvidence {
  return {
    candidateBound: true,
    opportunities: measured(10),
    attempts: measured(10),
    useful: measured(8),
    feedback: {
      assessed: measured(10),
      pass: measured(8),
      partial: measured(1),
      redo: measured(1),
      wrong: measured(0),
    },
  };
}

function thresholds(): QualificationThresholds {
  return {
    version: "test-thresholds-v1",
    rationale: "fixture-only explicit thresholds",
    review: {
      reviewerId: "reviewer-fixture",
      reviewedAt: "2026-08-31T00:00:00.000Z",
      decisionRef: "review-fixture-1",
    },
    expectedPolicyStamp: POLICY,
    acceptedTaskTypes: ["code-edit"],
    maxEvidenceAgeMs: 172_800_000,
    minOrganicOpportunities: 2,
    minOrganicAttempts: 2,
    minQualityRate: 0.7,
    minFeedbackCoverage: 0.8,
    maxErrorRate: 0.1,
    maxP90LatencyMs: 500,
    maxBusyRate: 0.1,
    maxCostPerAcceptedUsd: 0.25,
    maxLocalToBaselineRatio: null,
  };
}

function candidate(): M3QualificationCandidate {
  return {
    key: {
      taskType: "code-edit",
      nodeId: "m5-fixture",
      modelId: "model-fixture",
      lane: "non-judgment-delegate",
      verifier: "truth-rubric-fixture",
    },
    identity: {
      evidenceIdentitySha256: DIGEST,
      artifactSha256: DIGEST,
      runtimeSha256: DIGEST,
      verifierSha256: DIGEST,
    },
    eligibility: {
      nonJudgmentLane: true,
      dataClass: "controlled-external-ok",
      destinationClass: "owned-local",
    },
    policy: { fullStamps: [POLICY] },
    verifier: {
      kind: "truth-oriented",
      trusted: true,
      trustPolicyId: "verifier-policy-fixture-v1",
    },
    safety: {
      boundedTaskType: measured(true),
      lowBlastRadius: measured(true),
      rollbackPathTested: measured(true),
      watchdogPathTested: measured(true),
    },
    samples: {
      organic: purpose(),
      evaluation: purpose(),
      synthetic: purpose(),
      unknown: purpose(),
    },
    qualityRate: measured(0.8),
    errorRate: measured(0.02),
    p90LatencyMs: measured(100),
    busyRate: measured(0.02),
    cost: {
      localCostPerAcceptedUsd: measured(0.1, 8),
      baselineCostPerAcceptedUsd: measured(1, 8),
      localProvenance: "fixture-local-cost-calibration-v1",
      baselineProvenance: "fixture-baseline-cost-calibration-v1",
      calibrated: measured(true),
      exactOneCostCoverage: measured(true),
    },
  };
}

function input(overrides: Partial<M3QualificationInput> = {}): M3QualificationInput {
  return {
    contract: M3_QUALIFICATION_CONTRACT,
    version: 1,
    evaluation: { asOf: "2026-09-03T00:00:00.000Z" },
    window: {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-02T00:00:00.000Z",
    },
    snapshot: {
      sha256: DIGEST,
      immutable: true,
      observedAt: "2026-09-02T00:00:00.000Z",
    },
    thresholds: thresholds(),
    candidates: [candidate()],
    ...overrides,
  };
}

describe("evaluateM3Qualification", () => {
  it("returns diagnostic PASS and analysis GO for one fully evidenced TEST candidate", () => {
    const result = evaluateM3Qualification(input());

    expect(result.analysisVerdict).toBe("GO");
    expect(result.candidates[0]?.diagnostic).toBe("PASS");
    expect(result.selectedCandidate).toEqual(candidate().key);
    expect(result.enablingDecision).toBeNull();
  });

  it("holds when thresholds are absent", () => {
    const result = evaluateM3Qualification(input({ thresholds: null }));

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.reasons).toContain("missing_thresholds");
    expect(result.enablingDecision).toBeNull();
  });

  it("holds for missing immutable snapshot or candidate identity", () => {
    const value = input();
    value.snapshot.immutable = false;
    value.candidates[0]!.identity.artifactSha256 = "";

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.reasons).toContain("invalid_snapshot");
    expect(result.candidates[0]?.reasons).toContain("invalid_identity");
  });

  it("holds for stale and mixed full policy stamps", () => {
    const stale = input();
    stale.candidates[0]!.policy.fullStamps = ["ctx-tools-parts-v1|ctx=23000"];
    const mixed = input();
    mixed.candidates[0]!.policy.fullStamps = [POLICY, "ctx-tools-parts-v1|ctx=23001"];

    expect(evaluateM3Qualification(stale).candidates[0]?.reasons).toContain("stale_policy");
    expect(evaluateM3Qualification(mixed).candidates[0]?.reasons).toContain("mixed_policy");
  });

  it("rejects untrusted and format-only verifiers", () => {
    const untrusted = input();
    untrusted.candidates[0]!.verifier.trusted = false;
    const formatOnly = input();
    formatOnly.candidates[0]!.key.verifier = "jsonValid";

    expect(evaluateM3Qualification(untrusted).candidates[0]?.reasons).toContain("untrusted_verifier");
    expect(evaluateM3Qualification(formatOnly).candidates[0]?.reasons).toContain("format_only_verifier");
  });

  it("classifies the actual verifier label and rejects unknown or judgment task types", () => {
    const value = input();
    value.thresholds!.acceptedTaskTypes = ["unknown-task"];
    value.candidates[0]!.key.taskType = "unknown-task";
    value.candidates[0]!.key.verifier = "jsonValid";

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.reasons).toContain("invalid_thresholds");
    expect(result.candidates[0]?.reasons).toEqual(expect.arrayContaining([
      "unknown_task_type",
      "format_only_verifier",
    ]));

    const judgment = input();
    judgment.thresholds!.acceptedTaskTypes = ["code-review"];
    judgment.candidates[0]!.key.taskType = "code-review";
    const judgmentResult = evaluateM3Qualification(judgment);
    expect(judgmentResult.candidates[0]?.reasons).toContain("judgment_task_type");
    expect(judgmentResult.analysisVerdict).toBe("HOLD");
  });

  it("does not let synthetic or evaluation samples satisfy organic thresholds", () => {
    const value = input();
    const organic = value.candidates[0]!.samples.organic;
    organic.opportunities = measured(1, 1);
    organic.attempts = measured(1, 1);
    organic.useful = measured(1, 1);
    organic.feedback.assessed = measured(1, 1);
    organic.feedback.pass = measured(1, 1);
    organic.feedback.partial = measured(0, 1);
    organic.feedback.redo = measured(0, 1);
    organic.feedback.wrong = measured(0, 1);

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.candidates[0]?.reasons).toContain("insufficient_organic_sample");
  });

  it("holds for missing or uncalibrated local and baseline costs", () => {
    const value = input();
    value.candidates[0]!.cost.localCostPerAcceptedUsd = unknown("unproven");
    value.candidates[0]!.cost.calibrated = measured(false);

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.candidates[0]?.reasons).toContain("unproven_cost");
    expect(result.candidates[0]?.reasons).toContain("uncalibrated_cost");
  });

  it("holds when lane busy evidence is unavailable", () => {
    const value = input();
    value.candidates[0]!.busyRate = unknown();

    const result = evaluateM3Qualification(value);

    expect(result.candidates[0]?.reasons).toContain("missing_busy_signal");
  });

  it("rejects rate, latency, busy, and cost populations that do not bind to organic denominators", () => {
    const value = input();
    value.candidates[0]!.qualityRate = measured(0.8, 9);
    value.candidates[0]!.errorRate = measured(0.02, 9);
    value.candidates[0]!.p90LatencyMs = measured(100, 9);
    value.candidates[0]!.busyRate = measured(0.02, 9);
    value.candidates[0]!.cost.localCostPerAcceptedUsd = measured(0.1, 7);

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.candidates[0]?.reasons).toEqual(expect.arrayContaining([
      "quality_denominator_mismatch",
      "error_denominator_mismatch",
      "latency_denominator_mismatch",
      "busy_denominator_mismatch",
      "cost_denominator_mismatch",
    ]));
  });

  it("holds for inconsistent, nonfinite, and negative counts", () => {
    const inconsistent = input();
    inconsistent.candidates[0]!.samples.organic.attempts = measured(11);
    const nonfinite = input();
    nonfinite.candidates[0]!.samples.organic.opportunities = measured(Number.NaN);
    const negative = input();
    negative.candidates[0]!.samples.organic.useful = measured(-1);

    expect(evaluateM3Qualification(inconsistent).candidates[0]?.reasons).toContain("inconsistent_counts");
    expect(evaluateM3Qualification(nonfinite).candidates[0]?.reasons).toContain("invalid_metric");
    expect(evaluateM3Qualification(negative).candidates[0]?.reasons).toContain("invalid_metric");
  });

  it("does not treat zero-sample measured booleans as proven safety or cost evidence", () => {
    const value = input();
    value.candidates[0]!.safety.boundedTaskType = measured(true, 0);
    value.candidates[0]!.cost.calibrated = measured(true, 0);

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.candidates[0]?.reasons).toContain("invalid_metric");
    expect(result.candidates[0]?.safety.boundedTaskType.status).toBe("unproven");
    expect(result.candidates[0]?.evidence.calibrated.status).toBe("unproven");
  });

  it("holds duplicate candidate keys and never throws for malformed typed input", () => {
    const duplicate = input({ candidates: [candidate(), candidate()] });
    const malformed = input() as unknown as { candidates: Array<M3QualificationCandidate>; window: { start: string; end: string } };
    malformed.candidates[0]!.qualityRate = measured(Number.POSITIVE_INFINITY);
    malformed.window.end = "before-start";

    const duplicateResult = evaluateM3Qualification(duplicate);
    const malformedResult = evaluateM3Qualification(malformed as M3QualificationInput);

    expect(duplicateResult.analysisVerdict).toBe("HOLD");
    expect(duplicateResult.candidates.every((item) => item.reasons.includes("duplicate_candidate"))).toBe(true);
    expect(malformedResult.analysisVerdict).toBe("HOLD");
    expect(malformedResult.reasons).toContain("invalid_window");
    expect(malformedResult.candidates[0]?.reasons).toContain("invalid_metric");
  });

  it("holds every candidate sharing a complete evidence identity", () => {
    const first = candidate();
    const second = candidate();
    second.key.modelId = "model-second";

    const result = evaluateM3Qualification(input({ candidates: [first, second] }));

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.candidates.every((item) => item.reasons.includes("duplicate_identity"))).toBe(true);
  });

  it("rejects evidence outside the explicit freshness bound and reviews after the window", () => {
    const value = input();
    value.snapshot.observedAt = "2026-08-01T00:00:00.000Z";
    value.thresholds!.maxEvidenceAgeMs = 1000;
    value.thresholds!.review.reviewedAt = "2026-09-02T00:00:00.000Z";

    const result = evaluateM3Qualification(value);

    expect(result.reasons).toContain("stale_snapshot");
    expect(result.reasons).toContain("snapshot_before_window_end");
    expect(result.reasons).toContain("review_after_window");
  });

  it("holds an old evidence window even when its snapshot is fresh", () => {
    const value = input({
      window: {
        start: "2026-08-31T06:00:00.000Z",
        end: "2026-08-31T12:00:00.000Z",
      },
    });
    value.thresholds!.review.reviewedAt = "2026-08-30T00:00:00.000Z";

    const result = evaluateM3Qualification(value);

    expect(result.candidates[0]?.diagnostic).toBe("PASS");
    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.selectedCandidate).toBeNull();
    expect(result.reasons).toContain("stale_window");
    expect(result.reasons).not.toContain("stale_snapshot");
  });

  it("treats operator attestation as unproven and keeps analysis separate from activation", () => {
    const value = input();
    value.candidates[0]!.qualityRate = measured(0.8, 10, "operator-attested");

    const result = evaluateM3Qualification(value);

    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.candidates[0]?.reasons).toContain("unproven_quality");
    expect(result.enablingDecision).toBeNull();
  });

  it("uses stable candidate keys when more than one candidate passes, but keeps analysis HOLD", () => {
    const first = candidate();
    const second = candidate();
    second.key.modelId = "model-aardvark";
    second.identity.artifactSha256 = DIGEST_B;
    const result = evaluateM3Qualification(input({ candidates: [first, second] }));

    expect(result.candidates.map((item) => item.key.modelId)).toEqual(["model-aardvark", "model-fixture"]);
    expect(result.selectedCandidate).toBeNull();
    expect(result.analysisVerdict).toBe("HOLD");
    expect(result.reasons).toContain("multiple_passing_candidates");
  });
});
