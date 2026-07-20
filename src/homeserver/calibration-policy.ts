/**
 * Calibration judge-policy identity (issue #6).
 *
 * The harvest judge already versions the GRADING policy it writes into production evidence
 * (harvest.ts's HARVEST_JUDGE_POLICY / buildJudgePolicyStamp — issue #217). This module versions a
 * SIBLING, DISTINCT thing: the policy the CALIBRATION HARNESS itself uses to decide whether that
 * judge is trustworthy — judge prompt version, judge model, sampling profile, context policy,
 * rubric version, and the HOLD/GO thresholds. These are not the same axis: HARVEST_JUDGE_POLICY can
 * stay put while a calibration threshold tightens, and a calibration policy can be re-run against
 * unchanged harvest evidence to see whether a stricter bar still clears.
 *
 * Content-addressed for the same reason evidence-identity.ts content-addresses capability evidence
 * (issue #5): a policy change must SUPERSEDE — mint a new identity — rather than silently rewrite
 * the metrics/verdict computed under the old one (AC: "Judge-policy changes supersede rather than
 * rewrite old evidence"). Reuses the repo's one dependency-free canonical-JSON hasher
 * (learning-task-contract.ts's jcsCanonicalize) rather than inventing a second one.
 */

import { contentDigest } from "./evidence-identity.js";
import { jcsCanonicalize } from "./learning-task-contract.js";

// ─── Thresholds ─────────────────────────────────────────────────────────────────

export interface CalibrationThresholds {
  /** Minimum matched-label sample count for a stratum's precision/recall to be reportable at all;
   *  below this the stratum reports `sufficient: false` and a WIDE/insufficient confidence rather
   *  than a point estimate. */
  minStratumN: number;
  /** Minimum LOWER BOUND of the precision confidence interval required for GO, per lane/verifier
   *  class. A point estimate above the floor with a CI lower bound below it still fails — the gate
   *  reads the conservative end of the interval, never the point estimate. */
  minPrecisionLowerBound: number;
  /** Minimum LOWER BOUND of the recall confidence interval required for GO. */
  minRecallLowerBound: number;
  /** Maximum disagreement rate (judge verdict != independent label) UPPER BOUND allowed for GO. */
  maxDisagreementUpperBound: number;
  /** z-score for the confidence interval (1.96 = ~95%). */
  confidenceZ: number;
}

export const DEFAULT_CALIBRATION_THRESHOLDS: CalibrationThresholds = {
  minStratumN: 30,
  minPrecisionLowerBound: 0.9,
  minRecallLowerBound: 0.8,
  maxDisagreementUpperBound: 0.1,
  confidenceZ: 1.96,
};

// ─── Policy identity ────────────────────────────────────────────────────────────

/** The versioned, content-addressed subject of a calibration run. Every field participates in the
 *  content hash — changing ANY of them (including a threshold) mints a new policy id. */
export interface CalibrationPolicy {
  /** Judge system-prompt identity — bump when JUDGE_SYSTEM / TYPE_HINTS text changes materially.
   *  A label, not a digest: harvest.ts's judge prompt has no independently hashed source document
   *  yet (mirrors evidence-identity.ts's honest label-vs-digest distinction). */
  judgePromptVersion: string;
  /** Judge model id calibrated (e.g. "gpt-oss-120b"). */
  judgeModel: string;
  /** Sampling profile in force for the judge call (e.g. "temperature=0"). */
  samplingProfile: string;
  /** Context policy — mirrors harvest.ts's HARVEST_JUDGE_POLICY grading-policy epoch, so a
   *  calibration run can state exactly which production grading epoch it measured. */
  contextPolicy: string;
  /** Rubric/verdict-band version (pass/partial/fail definition and score bands). */
  rubricVersion: string;
  thresholds: CalibrationThresholds;
}

/** The current calibration policy (issue #6, first version). Bump `judgePromptVersion` et al. and
 *  mint a NEW `CalibrationPolicy` object (never mutate this one in place) when judge prompt, model,
 *  sampling, context policy, rubric, or thresholds change — see `supersedes` below. */
export const CURRENT_CALIBRATION_POLICY: CalibrationPolicy = {
  judgePromptVersion: "harvest-judge-system-v1",
  judgeModel: "gpt-oss-120b",
  samplingProfile: "temperature=0",
  contextPolicy: "ctx-tools-parts-v1",
  rubricVersion: "pass-partial-fail-v1",
  thresholds: DEFAULT_CALIBRATION_THRESHOLDS,
};

/** Content-addressed identity of a calibration policy — the id every metrics report and gate
 *  decision is stamped with. Two policies differing in ANY field (including a threshold) hash
 *  differently, so a threshold-only change is honestly a NEW policy identity, not a silent edit of
 *  the old verdict's meaning. */
export function calibrationPolicyId(policy: CalibrationPolicy): string {
  return contentDigest(jcsCanonicalize(policy));
}

/** One entry in the calibration-policy lineage: an id, the policy it hashes, and the id of the
 *  policy it supersedes (null for the first version in a lineage). Append-only by convention —
 *  callers build this list, never mutate a prior entry's `policy` in place. */
export interface CalibrationPolicyLineageEntry {
  id: string;
  policy: CalibrationPolicy;
  /** id of the CalibrationPolicy this entry supersedes, or null if it starts a new lineage. */
  supersedesId: string | null;
}

/**
 * Build a lineage entry for `next`, explicitly declaring it supersedes `previous` (or null to start
 * a fresh lineage). This is bookkeeping only — it does not mutate or delete anything the previous
 * policy id was already stamped on (old CalibrationGateDecision / CalibrationMetricsReport objects
 * keep their old policyId forever; only a NEW run stamps the new id). Throws if `next` and
 * `previous` hash identically — that is not a policy change, and calling this to "supersede" a
 * byte-identical policy would fabricate lineage that does not exist.
 */
export function supersedes(
  next: CalibrationPolicy,
  previous: CalibrationPolicy | null
): CalibrationPolicyLineageEntry {
  const id = calibrationPolicyId(next);
  if (previous === null) return { id, policy: next, supersedesId: null };
  const previousId = calibrationPolicyId(previous);
  if (previousId === id) {
    throw new Error(
      "calibration-policy: supersedes() called with two policies that hash identically — not a real change"
    );
  }
  return { id, policy: next, supersedesId: previousId };
}
