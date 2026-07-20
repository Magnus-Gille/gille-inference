/**
 * HOLD/GO gate for organic-harvest-judge calibration (issue #6).
 *
 * Produces a machine-readable, reviewable decision artifact from measured metrics — never from a
 * hand-typed claim. The verdict computation (`evaluateCalibrationGate`) is PURE and fail-closed: it
 * can only ever compute HOLD from insufficient/failing evidence, and even a GO-eligible measurement
 * does NOT itself enable verdict-impacting harvest. Enabling that requires a SEPARATE, explicit,
 * human-authored `attachReviewedDecision` call this module never invokes on its own — see that
 * function's doc comment. This file is issue #6's entire deliverable boundary: it does not touch
 * routing, does not flip HARVEST_MODE, and does not auto-approve anything (issue #6's non-goals;
 * that adoption step is issue #7's).
 */

import type { CalibrationThresholds } from "./calibration-policy.js";
import type { CalibrationMetricsReport, GroupMetrics } from "./calibration-metrics.js";

export type CalibrationVerdict = "HOLD" | "GO";

/** A human-authored record that a reviewer looked at a SPECIFIC gate decision (by its
 *  `policyId` + `generatedAt`) and approved enabling verdict-impacting harvest FROM it. Optional and
 *  additive — `evaluateCalibrationGate` never produces one; only `attachReviewedDecision` does. */
export interface ReviewedEnablementDecision {
  reviewerId: string;
  /** Free-text reason IS permitted here (unlike calibration artifacts derived from sampled evidence)
   *  — this is the reviewer's own authored decision, not extracted from task content. */
  reason: string;
  decisionRef: string;
  reviewedAt: string;
}

export interface CalibrationGateDecision {
  schemaVersion: 1;
  policyId: string;
  generatedAt: string;
  verdict: CalibrationVerdict;
  /** Specific, non-generic reasons — every HOLD names the exact insufficiency (AC: "a specific
   *  insufficient-sample reason"), and a GO lists every threshold that was in fact cleared. */
  reasons: string[];
  thresholds: CalibrationThresholds;
  metrics: CalibrationMetricsReport;
  /**
   * Enabling verdict-impacting harvest requires an explicit reviewed decision recorded FROM this
   * exact gate (AC). `evaluateCalibrationGate` always leaves this null; a human-authored call to
   * `attachReviewedDecision` is the only way it is ever populated, and populating it does not
   * retroactively change `verdict` — a HOLD gate cannot be "enabled" (see that function's guard).
   */
  enabling: ReviewedEnablementDecision | null;
}

function groupReasons(kind: "lane" | "verifierClass", groups: readonly GroupMetrics[], t: CalibrationThresholds): string[] {
  const reasons: string[] = [];
  for (const g of groups) {
    if (!g.trustedForGate) {
      reasons.push(
        `${kind} ${g.groupKey}: verifier class ${JSON.stringify(g.verifierClass)} is not trusted truth-quality ` +
          `evidence (format-only or unclassified) — excluded from GO-supporting evidence regardless of its raw numbers`
      );
      continue;
    }
    if (!g.sufficient) {
      reasons.push(
        `${kind} ${g.groupKey}: insufficient audited sample — precision n=${g.precision.denominator}, ` +
          `recall n=${g.recall.denominator}, both need >= ${t.minStratumN} for a reportable confidence interval`
      );
      continue;
    }
    if (g.precision.ciLower === null || g.precision.ciLower < t.minPrecisionLowerBound) {
      reasons.push(
        `${kind} ${g.groupKey}: precision CI lower bound ${g.precision.ciLower ?? "n/a"} < required ${t.minPrecisionLowerBound}`
      );
    }
    if (g.recall.ciLower === null || g.recall.ciLower < t.minRecallLowerBound) {
      reasons.push(
        `${kind} ${g.groupKey}: recall CI lower bound ${g.recall.ciLower ?? "n/a"} < required ${t.minRecallLowerBound}`
      );
    }
    if (g.disagreement.ciUpper === null || g.disagreement.ciUpper > t.maxDisagreementUpperBound) {
      reasons.push(
        `${kind} ${g.groupKey}: disagreement CI upper bound ${g.disagreement.ciUpper ?? "n/a"} > allowed ${t.maxDisagreementUpperBound}`
      );
    }
  }
  return reasons;
}

/**
 * Evaluate the gate from measured metrics. GO requires EVERY trusted-for-gate lane AND verifier
 * class group (plus the long-context rollup) to be `sufficient` and clear all three thresholds at
 * the CONSERVATIVE (confidence-interval) bound — a single failing trusted group holds the whole
 * gate, because a judge that is unsafe on one lane is not safe to trust globally. A report with NO
 * trusted-for-gate groups at all (e.g. zero llm-judge evidence sampled) is HOLD by construction —
 * there is nothing here that could ever compute a GO from an empty trusted population.
 */
export function evaluateCalibrationGate(p: {
  policyId: string;
  generatedAt: string;
  metrics: CalibrationMetricsReport;
  thresholds: CalibrationThresholds;
}): CalibrationGateDecision {
  const { policyId, generatedAt, metrics, thresholds } = p;
  const reasons: string[] = [];

  const trustedLanes = metrics.byLane.filter((g) => g.trustedForGate);
  const trustedVerifierClasses = metrics.byVerifierClass.filter((g) => g.trustedForGate);

  if (trustedLanes.length === 0 && trustedVerifierClasses.length === 0) {
    reasons.push(
      "no trusted truth-quality evidence sampled at all (no llm-judge / explicitly-classified-truth-oriented " +
        "rows joined to an independent label) — insufficient audited sample"
    );
  }
  if (metrics.totalMatched === 0) {
    reasons.push(
      `0 of ${metrics.totalSampled} sampled rows joined to an independent Quality Receipt — insufficient audited sample`
    );
  }

  reasons.push(...groupReasons("lane", trustedLanes, thresholds));
  reasons.push(...groupReasons("verifierClass", trustedVerifierClasses, thresholds));
  if (metrics.longContext.trustedForGate) {
    reasons.push(...groupReasons("verifierClass", [metrics.longContext], thresholds));
  } else {
    reasons.push("long-context stratum: no trusted truth-quality evidence sampled — insufficient audited sample");
  }

  const verdict: CalibrationVerdict = reasons.length === 0 ? "GO" : "HOLD";
  const finalReasons =
    verdict === "GO"
      ? [
          `all ${trustedLanes.length} trusted lane group(s), ${trustedVerifierClasses.length} trusted verifier-class ` +
            `group(s), and the long-context stratum cleared precision >= ${thresholds.minPrecisionLowerBound}, ` +
            `recall >= ${thresholds.minRecallLowerBound}, disagreement <= ${thresholds.maxDisagreementUpperBound} ` +
            `(all at the conservative CI bound) with n >= ${thresholds.minStratumN} per group`,
        ]
      : reasons;

  return {
    schemaVersion: 1,
    policyId,
    generatedAt,
    verdict,
    reasons: finalReasons,
    thresholds,
    metrics,
    enabling: null,
  };
}

/**
 * Record a human reviewer's decision to enable verdict-impacting harvest FROM an exact gate
 * decision (AC: "Enabling verdict-impacting harvest requires an explicit reviewed decision recorded
 * FROM this gate — never automatic"). This function is the ONLY way `enabling` is ever populated —
 * `evaluateCalibrationGate` never calls it, and nothing in this repository calls it automatically.
 * It refuses to attach a reviewed decision to a HOLD gate: a human cannot "enable" evidence the
 * measured gate itself says is insufficient — that would defeat the entire point of a measured gate.
 * Reviewing a HOLD gate happens by improving the sample/labels and re-running the harness, not by
 * overriding this function. Returns a NEW object; never mutates its input.
 */
export function attachReviewedDecision(
  gate: CalibrationGateDecision,
  decision: ReviewedEnablementDecision
): CalibrationGateDecision {
  if (gate.verdict !== "GO") {
    throw new Error(
      `calibration-gate: refusing to attach a reviewed enablement decision to a ${gate.verdict} gate ` +
        `(policyId=${gate.policyId}, generatedAt=${gate.generatedAt}) — only a measured GO can be enabled`
    );
  }
  return { ...gate, enabling: decision };
}
