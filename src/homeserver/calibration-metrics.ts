/**
 * Calibration metrics (issue #6): precision, recall, and disagreement of the harvest judge against
 * independent Hugin Quality Receipt labels, computed PER LANE and PER VERIFIER CLASS, each with an
 * explicit denominator and a Wilson-score confidence interval — never a bare point estimate a small
 * stratum could pass off as precise.
 *
 * Central safety rule (AC: "known wrong answers cannot earn trusted truth-quality evidence through
 * format checks"): a stratum's numbers are always REPORTED, but only a stratum whose verifier class
 * is explicitly TRUSTED truth-quality evidence (calibration-sample.ts's verifierClassOf ==
 * "llm-judge" or an explicit "truth-oriented:*" allowlist entry) can ever satisfy the HOLD/GO gate.
 * `mechanical-format`, `ungraded`, and any `unclassified:*` verifier — an unknown identity, per the
 * AC "untrusted until classified" — are reported for transparency and structurally EXCLUDED from
 * gate-satisfying evidence. This is enforced by the type itself (`GroupMetrics.trustedForGate`),
 * not by a caller remembering to filter, so a known-wrong answer passed only by a format check can
 * never masquerade as calibration proof no matter how good its raw numbers look.
 */

import type { JoinedSampleRow } from "./calibration-quality-receipts.js";
import { predictedVerdictOf, verifierClassOf, type StratumKey } from "./calibration-sample.js";
import type { CalibrationThresholds } from "./calibration-policy.js";

// ─── Trust classification ────────────────────────────────────────────────────────

/** True iff `verifierClass` (calibration-sample.ts's verifierClassOf output) is explicitly
 *  recognised as trusted truth-quality evidence for calibration purposes. */
export function isTrustedTruthQualityVerifierClass(verifierClass: string): boolean {
  return verifierClass === "llm-judge" || verifierClass.startsWith("truth-oriented:");
}

// ─── Confidence intervals ────────────────────────────────────────────────────────

export interface RateEstimate {
  numerator: number;
  denominator: number;
  /** null (never a fabricated 0) when denominator is 0 — "no evidence" is distinct from "evidence
   *  of a zero rate". */
  point: number | null;
  ciLower: number | null;
  ciUpper: number | null;
}

/**
 * Wilson score interval for a binomial proportion — better small-N behaviour than a naive normal
 * approximation (does not produce an interval outside [0,1] and does not collapse to a zero-width
 * interval at n=1 the way a naive `p ± z*sqrt(p(1-p)/n)` does at p=0 or p=1). `denominator: 0`
 * yields an honest null estimate rather than a divide-by-zero NaN.
 */
export function wilsonInterval(numerator: number, denominator: number, z = 1.96): RateEstimate {
  if (denominator <= 0) return { numerator, denominator, point: null, ciLower: null, ciUpper: null };
  const n = denominator;
  const p = numerator / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    numerator,
    denominator,
    point: Math.round(p * 10000) / 10000,
    ciLower: Math.round(Math.max(0, center - margin) * 10000) / 10000,
    ciUpper: Math.round(Math.min(1, center + margin) * 10000) / 10000,
  };
}

// ─── Grouped metrics ──────────────────────────────────────────────────────────────

export interface GroupMetrics {
  /** "lane:<value>" or "verifierClass:<value>" — human-legible, still content-blind. */
  groupKey: string;
  verifierClass: string | null;
  trustedForGate: boolean;
  sampledN: number;
  matchedN: number;
  unmatchedN: number;
  /** Matched rows whose Quality Receipt rating was `conflicted` — excluded from precision/recall/
   *  disagreement per the learning-task-contract's own rule that conflicted evidence "cannot
   *  support admission." Tracked separately so it is never silently folded into "unmatched". */
  conflictedN: number;
  precision: RateEstimate;
  recall: RateEstimate;
  disagreement: RateEstimate;
  /** denominator >= thresholds.minStratumN for BOTH precision and recall — a small-N group must
   *  report wide/insufficient confidence, never false precision (AC). */
  sufficient: boolean;
}

function emptyGroupMetrics(groupKey: string, verifierClass: string | null, trustedForGate: boolean): GroupMetrics {
  return {
    groupKey,
    verifierClass,
    trustedForGate,
    sampledN: 0,
    matchedN: 0,
    unmatchedN: 0,
    conflictedN: 0,
    precision: wilsonInterval(0, 0),
    recall: wilsonInterval(0, 0),
    disagreement: wilsonInterval(0, 0),
    sufficient: false,
  };
}

/**
 * `trustedForGate` is an EXPLICIT input, not derived from `verifierClass` inside this function
 * (issue #6 dogfood review finding): a `byVerifierClass` group is homogeneous by construction (every
 * row already shares that exact class), so its trust follows directly from the class. A `byLane`
 * group is NOT homogeneous — a lane mixes judge-graded and format-verified rows — so the caller must
 * pre-FILTER `rows` to the trusted population before calling this for a lane, exactly as
 * `computeCalibrationMetrics` already did for `longContextRows`. Deriving trust from a nullable
 * `verifierClass` (the earlier version of this function) made every lane group's `trustedForGate`
 * permanently `false` regardless of its actual rows — silently vacuous, never a real gate check.
 */
function computeGroup(
  groupKey: string,
  verifierClass: string | null,
  trustedForGate: boolean,
  rows: readonly JoinedSampleRow[],
  z: number,
  minStratumN: number
): GroupMetrics {
  let matchedN = 0;
  let unmatchedN = 0;
  let conflictedN = 0;
  let precisionNum = 0;
  let precisionDen = 0; // judge said "pass"
  let recallNum = 0;
  let recallDen = 0; // receipt says truly pass
  let disagreeNum = 0;
  let disagreeDen = 0;

  for (const jr of rows) {
    if (!jr.matched || jr.receipt === null) {
      unmatchedN++;
      continue;
    }
    if (jr.receipt.rating === "conflicted") {
      conflictedN++;
      continue;
    }
    const predicted = predictedVerdictOf(jr.row);
    if (predicted === null) {
      // Sampled and labeled, but the ledger row itself carries no judge-derived verdict (e.g. a
      // non-judge verifier row swept into the group by lane). Not usable for judge precision/recall.
      unmatchedN++;
      continue;
    }
    matchedN++;
    const trulyPass = jr.receipt.rating === "pass";
    const predictedPass = predicted === "pass";

    disagreeDen++;
    if (predicted !== jr.receipt.rating) disagreeNum++;

    if (predictedPass) {
      precisionDen++;
      if (trulyPass) precisionNum++;
    }
    if (trulyPass) {
      recallDen++;
      if (predictedPass) recallNum++;
    }
  }

  const precision = wilsonInterval(precisionNum, precisionDen, z);
  const recall = wilsonInterval(recallNum, recallDen, z);
  const disagreement = wilsonInterval(disagreeNum, disagreeDen, z);

  return {
    groupKey,
    verifierClass,
    trustedForGate,
    sampledN: rows.length,
    matchedN,
    unmatchedN,
    conflictedN,
    precision,
    recall,
    disagreement,
    sufficient: precisionDen >= minStratumN && recallDen >= minStratumN,
  };
}

export interface CalibrationMetricsReport {
  policyId: string;
  totalSampled: number;
  totalMatched: number;
  totalUnmatched: number;
  totalConflicted: number;
  byLane: GroupMetrics[];
  byVerifierClass: GroupMetrics[];
  /** Long-context / starvation stratum (issue #6 AC), surfaced explicitly rather than buried inside
   *  byVerifierClass — the `xl` prompt-size bucket from calibration-sample.ts, joined across every
   *  lane/verifier class, on trusted (llm-judge / truth-oriented) evidence only. */
  longContext: GroupMetrics;
}

/**
 * Compute the full metrics report from a joined sample. `strataByRowId` (calibration-sample.ts's
 * StratumKey, keyed by row id) supplies the prompt-size bucket needed for the long-context rollup;
 * every other grouping reads directly off the sampled row.
 */
export function computeCalibrationMetrics(p: {
  policyId: string;
  joined: readonly JoinedSampleRow[];
  strataByRowId: ReadonlyMap<string, StratumKey>;
  thresholds: CalibrationThresholds;
}): CalibrationMetricsReport {
  const { policyId, joined, strataByRowId, thresholds } = p;
  const z = thresholds.confidenceZ;

  // `byLaneAllRows` tracks every OBSERVED lane (so a lane with zero trusted evidence still surfaces
  // in the report, honestly at sampledN 0, rather than silently vanishing); `byLaneTrustedRows`
  // holds only the TRUSTED-verifier-class subset — a lane is not homogeneous the way a verifierClass
  // group is (it mixes judge-graded and format-verified rows), so byLane's precision/recall must be
  // computed over trusted rows only, exactly like the long-context rollup already does (see the
  // `computeGroup` doc comment above for why this is not merely cosmetic).
  const byLaneAllRows = new Map<string, JoinedSampleRow[]>();
  const byLaneTrustedRows = new Map<string, JoinedSampleRow[]>();
  const byVerifierClassRows = new Map<string, JoinedSampleRow[]>();
  const longContextRows: JoinedSampleRow[] = [];

  let totalMatched = 0;
  let totalUnmatched = 0;
  let totalConflicted = 0;

  for (const jr of joined) {
    const laneKey = jr.row.lane ?? "unknown";
    const vClass = verifierClassOf(jr.row.verifier);
    const trusted = isTrustedTruthQualityVerifierClass(vClass);

    const laneAll = byLaneAllRows.get(laneKey);
    if (laneAll) laneAll.push(jr);
    else byLaneAllRows.set(laneKey, [jr]);
    if (trusted) {
      const laneTrusted = byLaneTrustedRows.get(laneKey);
      if (laneTrusted) laneTrusted.push(jr);
      else byLaneTrustedRows.set(laneKey, [jr]);
    }

    const vClassGroup = byVerifierClassRows.get(vClass);
    if (vClassGroup) vClassGroup.push(jr);
    else byVerifierClassRows.set(vClass, [jr]);

    const stratum = strataByRowId.get(jr.row.id);
    if (stratum?.promptSizeBucket === "xl" && trusted) longContextRows.push(jr);

    if (!jr.matched || jr.receipt === null) totalUnmatched++;
    else if (jr.receipt.rating === "conflicted") totalConflicted++;
    else totalMatched++;
  }

  const byLane = [...byLaneAllRows.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((lane) =>
      computeGroup(`lane:${lane}`, "trusted-judge-evidence", true, byLaneTrustedRows.get(lane) ?? [], z, thresholds.minStratumN)
    );

  const byVerifierClass = [...byVerifierClassRows.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([vClass, rows]) =>
      computeGroup(`verifierClass:${vClass}`, vClass, isTrustedTruthQualityVerifierClass(vClass), rows, z, thresholds.minStratumN)
    );

  const longContext = computeGroup(
    "stratum:long-context",
    "trusted-judge-evidence",
    true,
    longContextRows,
    z,
    thresholds.minStratumN
  );

  return {
    policyId,
    totalSampled: joined.length,
    totalMatched,
    totalUnmatched,
    totalConflicted,
    byLane,
    byVerifierClass,
    longContext,
  };
}

/** Convenience for callers that already grouped rows without going through
 *  calibration-sample.ts's stratum builder (kept exported so `emptyGroupMetrics` is testable). */
export { emptyGroupMetrics };
