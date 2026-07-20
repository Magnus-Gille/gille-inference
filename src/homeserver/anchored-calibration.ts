/**
 * anchored-calibration.ts — verifier-anchored judge auto-calibration (issue #48).
 *
 * The #6 gate (calibration-gate.ts) is sound machinery — HOLD/GO computed from measured
 * precision/recall/disagreement against an INDEPENDENT label, fail-closed on insufficient/absent
 * evidence. Its only historical weakness is the LABEL SOURCE: #37 fed it exclusively from
 * human-audited Hugin Quality Receipts, so the loop stalled at HOLD waiting for a person
 * (docs/harvest-judge-calibration-gate-2026-07-20.md's "HONEST CURRENT STATE"). This module is a
 * SECOND, machine-computed label source that needs no human: wherever the SAME attempt was graded
 * BOTH by an organic judge (harvest.ts's `llm-judge:<model>` / `harvest-shadow:llm-judge:<model>`)
 * AND by a deterministic verifier (tsGate/sqlExec exec-graded checks, issue #12's seeded-bug
 * `reviewGroundTruth` corpus — calibration-sample.ts's `truth-oriented:*` classes), the verifier's
 * own outcome IS ground truth by construction (grimnir docs/autonomous-improvement-design.md §3,
 * anchor class 1). It never modifies, reimplements, or bypasses evaluateCalibrationGate /
 * computeCalibrationMetrics / joinSampleToReceipts — it only produces `QualityReceiptRef`s those
 * functions already know how to consume, so the existing HOLD/GO machinery is reused VERBATIM.
 *
 * Two distinct computations live here:
 *
 * 1. `computeAnchoredCalibration` — per ORGANIC-JUDGE IDENTITY (model + judgePolicy epoch, exactly
 *    the pair harvest.ts's `judgePolicy` stamp already distinguishes), measure agreement against the
 *    deterministic-verifier-anchored truth on OVERLAP ITEMS: rows sharing the same content-addressed
 *    binding key (calibration-quality-receipts.ts's `bindingKeyOf` — the SAME "same attempt" key #37
 *    already joins human receipts on) where one row is organic-judge-graded and another is
 *    deterministic-verifier-graded. A judge identity is ADMISSIBLE only while its rolling (window R)
 *    anchored-agreement conservative CI lower bound is >= kappa AND its overlap sample is sufficient
 *    — insufficient sample or a stale (aged-out) window fails closed, exactly mirroring #6's own
 *    "insufficient audited sample -> HOLD" posture, just one layer earlier and per-judge rather than
 *    per-lane.
 *
 * 2. `anchoredReceiptsFrom` — turns ONLY the admissible judges' fresh, non-self-graded overlap items
 *    into synthesized `QualityReceiptRef`s (rating = the VERIFIER's outcome, never the judge's own —
 *    attaching a judge's own verdict as its own "independent" label would be circular and always
 *    trivially agree). A judge that fails admissibility contributes zero receipts, so its evidence
 *    is honestly UNMATCHED in `joinSampleToReceipts` and the underlying #6 gate falls back to its
 *    existing fail-closed HOLD for that judge's lanes — unchanged machinery, exactly as required.
 *
 * Family-diversity (no self-grading): an overlap item whose organic-judge model is the SAME FAMILY
 * (routing-table-generator.ts's `modelFamilyOf`) as the candidate model it graded is marked
 * `selfGraded` and is excluded from BOTH the agreement statistics and the receipt feed — grading your
 * own family is not independent evidence, mirroring harvest.ts's existing (exact-id) `isSelfGrade`
 * skip one level broader.
 *
 * Human labels remain fully optional and additive: `mergeCalibrationReceipts` combines this module's
 * anchored receipts with any human Quality Receipts a caller supplies (calibration-gate-live.ts's
 * `mode: "both"`, the default) — never required, never overridden silently. Where a binding key has
 * BOTH a human and an anchored receipt and they disagree, the merge is honestly `"conflicted"` (the
 * same closed rating value calibration-metrics.ts already excludes from precision/recall/disagreement
 * per the learning-task-contract's "disagreement ... cannot support admission" rule) — never a
 * silent pick of one side.
 */

import type { CalibrationSampleRow } from "./ledger.js";
import { verifierClassOf, predictedVerdictOf } from "./calibration-sample.js";
import { bindingKeyOf, type QualityReceiptRef, type QualityReceiptRating } from "./calibration-quality-receipts.js";
import { wilsonInterval, type RateEstimate } from "./calibration-metrics.js";
import { modelFamilyOf } from "./routing-table-generator.js";
import { contentDigest } from "./evidence-identity.js";
import { jcsCanonicalize } from "./learning-task-contract.js";

// ─── Judge identity ───────────────────────────────────────────────────────────────

/** Matches harvest.ts's real (`llm-judge:<model>`) and shadow (`harvest-shadow:llm-judge:<model>`)
 *  verifier-name convention — the exact prefix calibration-sample.ts's `verifierClassOf` collapses
 *  to the `"llm-judge"` class. */
const LLM_JUDGE_PREFIX = /^(harvest-shadow:)?llm-judge:/;

/** Recover the judge's own model id from a row's `verifier` field, or null when `verifier` is not
 *  organic-judge-shaped. Exported so callers/tests can reason about judge identity without
 *  duplicating the prefix convention. */
export function judgeModelOf(verifier: string | null | undefined): string | null {
  const trimmed = verifier?.trim();
  if (!trimmed || !LLM_JUDGE_PREFIX.test(trimmed)) return null;
  return trimmed.replace(LLM_JUDGE_PREFIX, "");
}

/** "model+config epoch" identity string (issue #48 AC) — the pair that must BOTH match for two rows
 *  to count as the same organic judge. A null `judgePolicy` (pre-#217 evidence) stamps as
 *  `"(unknown)"`, its own honestly-distinct epoch — never silently merged with a real policy id. */
export function judgeIdentityOf(judgeModel: string, judgePolicy: string | null | undefined): string {
  return `${judgeModel}@${judgePolicy ?? "(unknown)"}`;
}

// ─── Overlap items ────────────────────────────────────────────────────────────────

export type Verdict = "pass" | "partial" | "fail";

export interface AnchoredOverlapItem {
  bindingKey: string;
  /** Organic judge row's timestamp — the evidence age the rolling window measures. */
  ts: string;
  candidateModelId: string;
  candidateFamily: string;
  judgeIdentity: string;
  judgeModel: string;
  judgePolicy: string;
  judgeFamily: string;
  judgeVerdict: Verdict;
  /** The deterministic verifier's own outcome for this same binding — ground truth by construction. */
  anchorVerdict: Verdict;
  agree: boolean;
  /** True iff judgeFamily === candidateFamily — excluded from agreement stats AND the receipt feed
   *  (no self-grading), never merely down-weighted. */
  selfGraded: boolean;
}

function isDeterministicVerifierAnchorClass(verifierClass: string): boolean {
  return verifierClass.startsWith("truth-oriented:");
}

function groupByBindingKey(rows: readonly CalibrationSampleRow[]): Map<string, CalibrationSampleRow[]> {
  const groups = new Map<string, CalibrationSampleRow[]>();
  for (const row of rows) {
    const key = bindingKeyOf(row);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/**
 * Build every OVERLAP item observable in `rows`: for each content-addressed binding key with at
 * least one organic-judge row AND at least one deterministic-verifier-anchored row, emit one item
 * PER organic-judge row present, paired against that binding's single anchor verdict. A binding
 * whose anchor rows disagree with each other (an internally ambiguous ground truth — should not
 * happen for a real deterministic verifier re-run on identical input, but fails closed rather than
 * guessing) contributes NO items at all; legacy rows with no `evidenceIdentityHash` fall back to a
 * per-row binding key (`bindingKeyOf`), so they can never accidentally overlap with an unrelated row.
 */
export function buildAnchoredOverlapItems(rows: readonly CalibrationSampleRow[]): AnchoredOverlapItem[] {
  const items: AnchoredOverlapItem[] = [];
  for (const [bindingKey, groupRows] of groupByBindingKey(rows)) {
    const judgeRows = groupRows.filter((r) => verifierClassOf(r.verifier) === "llm-judge");
    const anchorRows = groupRows.filter((r) => isDeterministicVerifierAnchorClass(verifierClassOf(r.verifier)));
    if (judgeRows.length === 0 || anchorRows.length === 0) continue;

    const anchorVerdicts = new Set<Verdict>();
    for (const anchorRow of anchorRows) {
      const v = predictedVerdictOf(anchorRow);
      if (v !== null) anchorVerdicts.add(v);
    }
    if (anchorVerdicts.size !== 1) continue; // no usable, or internally ambiguous, ground truth
    const [anchorVerdict] = anchorVerdicts;

    for (const judgeRow of judgeRows) {
      const judgeVerdict = predictedVerdictOf(judgeRow);
      const judgeModel = judgeModelOf(judgeRow.verifier);
      if (judgeVerdict === null || judgeModel === null) continue;

      const candidateModelId = judgeRow.modelId;
      const candidateFamily = modelFamilyOf(candidateModelId);
      const judgeFamily = modelFamilyOf(judgeModel);

      items.push({
        bindingKey,
        ts: judgeRow.ts,
        candidateModelId,
        candidateFamily,
        judgeIdentity: judgeIdentityOf(judgeModel, judgeRow.judgePolicy),
        judgeModel,
        judgePolicy: judgeRow.judgePolicy ?? "(unknown)",
        judgeFamily,
        judgeVerdict,
        anchorVerdict: anchorVerdict as Verdict,
        agree: judgeVerdict === anchorVerdict,
        selfGraded: judgeFamily === candidateFamily,
      });
    }
  }
  return items;
}

// ─── Rolling window ───────────────────────────────────────────────────────────────

export type AnchoredWindow = { mode: "days"; days: number } | { mode: "count"; count: number };

export interface AnchoredCalibrationConfig {
  /** Minimum conservative (Wilson CI lower-bound) anchored-agreement rate for a judge identity's
   *  organic evidence to be admissible. Default 0.85 (issue #48 AC / grimnir design doc §6). */
  kappa: number;
  /** Minimum overlap-item sample (after window + self-grading filters) for a judge's agreement rate
   *  to be reportable at all — mirrors calibration-policy.ts's minStratumN conservatism. */
  minOverlapN: number;
  /** Rolling window R: "days" (time-based decay — the natural reading of "stale window ⇒ HOLD") or
   *  "count" (most-recent-N overlap items, evaluated per judge identity). */
  window: AnchoredWindow;
  /** z-score for the Wilson interval — defaults to the same 1.96 (~95%) the rest of #6 uses. */
  confidenceZ: number;
}

export const DEFAULT_ANCHORED_CALIBRATION_CONFIG: AnchoredCalibrationConfig = {
  kappa: 0.85,
  minOverlapN: 30,
  window: { mode: "days", days: 30 },
  confidenceZ: 1.96,
};

function itemsForJudge(items: readonly AnchoredOverlapItem[], judgeIdentity: string): AnchoredOverlapItem[] {
  // Self-graded items are excluded here (not merely down-weighted) — they must never contribute to
  // agreement stats OR the receipt feed for ANY judge identity, per the no-self-grading rule.
  return items.filter((it) => it.judgeIdentity === judgeIdentity && !it.selfGraded);
}

/** Apply the rolling window to one judge identity's (already self-grading-filtered) items. `asOf` is
 *  the freshness clock — always caller-supplied (never `Date.now()`), so this stays pure/deterministic
 *  and callers can advance time explicitly to exercise decay. */
function windowFilter(
  items: readonly AnchoredOverlapItem[],
  asOf: string,
  window: AnchoredWindow
): AnchoredOverlapItem[] {
  if (window.mode === "count") {
    return [...items].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, window.count);
  }
  const asOfMs = Date.parse(asOf);
  const cutoffMs = asOfMs - window.days * 86_400_000;
  return items.filter((it) => {
    const ts = Date.parse(it.ts);
    return ts >= cutoffMs && ts <= asOfMs;
  });
}

// ─── Per-judge agreement ──────────────────────────────────────────────────────────

export interface JudgeAnchoredAgreement {
  judgeIdentity: string;
  judgeModel: string;
  judgePolicy: string;
  /** Overlap items available for this identity BEFORE windowing (self-graded already excluded). */
  totalOverlapN: number;
  /** After the rolling window is applied — the population `agreement`/`sufficient`/`admissible`
   *  are actually computed from. */
  windowedN: number;
  agreement: RateEstimate;
  sufficient: boolean;
  /** `sufficient && agreement.ciLower >= kappa` — the ONLY thing anchoredReceiptsFrom consults to
   *  decide whether this judge contributes trusted labels. */
  admissible: boolean;
  windowFrom: string | null;
  windowTo: string | null;
  reasons: string[];
}

function summarizeJudge(
  judgeIdentity: string,
  allItems: readonly AnchoredOverlapItem[],
  asOf: string,
  config: AnchoredCalibrationConfig
): JudgeAnchoredAgreement {
  const candidateItems = itemsForJudge(allItems, judgeIdentity);
  const windowed = windowFilter(candidateItems, asOf, config.window);
  const numerator = windowed.filter((it) => it.agree).length;
  const denominator = windowed.length;
  const agreement = wilsonInterval(numerator, denominator, config.confidenceZ);
  const sufficient = denominator >= config.minOverlapN;
  const admissible = sufficient && agreement.ciLower !== null && agreement.ciLower >= config.kappa;

  // `judgeIdentity` is guaranteed to appear in `allItems` at least once (the caller derives the set
  // of identities from exactly this array — see computeAnchoredCalibration) even when EVERY item for
  // it happens to be self-graded (candidateItems/windowed both empty), so read judgeModel/judgePolicy
  // from the unfiltered population rather than the (possibly empty) filtered ones.
  const anyItem = allItems.find((it) => it.judgeIdentity === judgeIdentity)!;
  const { judgeModel, judgePolicy } = anyItem;
  const tsSorted = [...windowed].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const windowFrom = tsSorted.length > 0 ? tsSorted[0]!.ts : null;
  const windowTo = tsSorted.length > 0 ? tsSorted[tsSorted.length - 1]!.ts : null;

  const reasons: string[] = [];
  const windowDesc = config.window.mode === "days" ? `${config.window.days}d window` : `last ${config.window.count} items`;
  if (denominator === 0) {
    reasons.push(
      `judge ${judgeIdentity}: no verifier-anchored overlap evidence in the rolling window (${windowDesc}) — insufficient overlap sample`
    );
  } else if (!sufficient) {
    reasons.push(
      `judge ${judgeIdentity}: insufficient verifier-anchored overlap — n=${denominator} < required ${config.minOverlapN} (${windowDesc})`
    );
  } else if (!admissible) {
    reasons.push(
      `judge ${judgeIdentity}: anchored agreement CI lower bound ${agreement.ciLower ?? "n/a"} < required kappa=${config.kappa} (n=${denominator}, ${windowDesc})`
    );
  } else {
    reasons.push(
      `judge ${judgeIdentity}: anchored agreement CI lower bound ${agreement.ciLower} >= kappa=${config.kappa} over n=${denominator} (${windowDesc}) — organic evidence admissible`
    );
  }

  return {
    judgeIdentity,
    judgeModel,
    judgePolicy,
    totalOverlapN: candidateItems.length,
    windowedN: denominator,
    agreement,
    sufficient,
    admissible,
    windowFrom,
    windowTo,
    reasons,
  };
}

// ─── Top-level report ─────────────────────────────────────────────────────────────

export interface AnchoredCalibrationReport {
  generatedAt: string;
  config: AnchoredCalibrationConfig;
  /** Every overlap item observed (pre-window, INCLUDING self-graded ones, flagged) — kept for audit
   *  transparency; `judges[].reasons` and `anchoredReceiptsFrom` are the load-bearing outputs. */
  items: AnchoredOverlapItem[];
  judges: JudgeAnchoredAgreement[];
}

/**
 * PURE (no IO, no wall-clock read unless `asOf` is omitted — and even then only `new Date()`, never
 * a hidden global). Computes anchored overlap + per-judge-identity agreement over the FULL `rows`
 * population (deliberately NOT the #6/#37 stratified sample — overlap evidence is comparatively
 * scarce and down-sampling it further would only widen its own confidence interval for no benefit;
 * the stratified draw still governs what the outer #6 gate metrics themselves are computed over).
 */
export function computeAnchoredCalibration(p: {
  rows: readonly CalibrationSampleRow[];
  asOf?: string;
  config?: Partial<AnchoredCalibrationConfig>;
}): AnchoredCalibrationReport {
  const config: AnchoredCalibrationConfig = { ...DEFAULT_ANCHORED_CALIBRATION_CONFIG, ...p.config };
  const asOf = p.asOf ?? new Date().toISOString();
  const items = buildAnchoredOverlapItems(p.rows);
  const identities = [...new Set(items.map((it) => it.judgeIdentity))].sort();
  const judges = identities.map((identity) => summarizeJudge(identity, items, asOf, config));
  return { generatedAt: asOf, config, items, judges };
}

// ─── Receipt synthesis (the trusted-label feed) ──────────────────────────────────

/**
 * Turn ONLY admissible judges' fresh, non-self-graded overlap items into `QualityReceiptRef`s the
 * existing `joinSampleToReceipts`/`computeCalibrationMetrics`/`evaluateCalibrationGate` stack
 * consumes verbatim. The receipt's `rating` is always the ANCHOR (deterministic verifier) verdict —
 * never the judge's own — so the downstream comparison of "the sampled judge row's own predicted
 * verdict" against "this receipt" is a genuine, non-circular check. One receipt per binding key (the
 * ground truth is a property of the underlying attempt, not of which judge row happened to observe
 * it), so two admissible judges sharing a binding key can never violate `joinSampleToReceipts`'s
 * one-receipt-per-binding invariant.
 */
export function anchoredReceiptsFrom(report: AnchoredCalibrationReport): QualityReceiptRef[] {
  const admissibleIdentities = new Set(report.judges.filter((j) => j.admissible).map((j) => j.judgeIdentity));
  const byBindingKey = new Map<string, AnchoredOverlapItem>();
  for (const identity of admissibleIdentities) {
    const windowed = windowFilter(itemsForJudge(report.items, identity), report.generatedAt, report.config.window);
    for (const item of windowed) {
      if (!byBindingKey.has(item.bindingKey)) byBindingKey.set(item.bindingKey, item);
    }
  }
  const receipts: QualityReceiptRef[] = [];
  for (const [bindingKey, item] of byBindingKey) {
    receipts.push({
      receiptId: `anchored:${bindingKey}`,
      receiptDigest: contentDigest(
        jcsCanonicalize({ bindingKey, anchorVerdict: item.anchorVerdict, source: "verifier-anchored" })
      ),
      bindingKey,
      rating: item.anchorVerdict,
      disposition: "verifier-anchored",
      rubricVersion: "anchored-calibration-v1",
      reviewerId: `verifier-anchor:${item.judgeIdentity}`,
    });
  }
  return receipts;
}

// ─── Merge with optional human receipts ──────────────────────────────────────────

/**
 * Merge human-audited receipts (issue #37's feed, always OPTIONAL) with anchored receipts
 * (this module's feed). Where both exist for the SAME binding key and agree, one is kept — a
 * duplicate label, not new information. Where they DISAGREE, the merge is honestly `"conflicted"`
 * (the same closed rating value calibration-metrics.ts already excludes from
 * precision/recall/disagreement) — never a silent pick of one source over the other, and never a
 * throw (unlike joinSampleToReceipts's ambiguous-join guard against a CALLER's own duplicate
 * receipts) since two independently-computed anchors disagreeing is an expected, everyday outcome
 * this module must handle gracefully, not a caller bug.
 */
export function mergeCalibrationReceipts(
  human: readonly QualityReceiptRef[],
  anchored: readonly QualityReceiptRef[]
): QualityReceiptRef[] {
  const byBindingKey = new Map<string, QualityReceiptRef[]>();
  for (const r of [...human, ...anchored]) {
    const existing = byBindingKey.get(r.bindingKey);
    if (existing) existing.push(r);
    else byBindingKey.set(r.bindingKey, [r]);
  }

  const merged: QualityReceiptRef[] = [];
  for (const [bindingKey, list] of byBindingKey) {
    if (list.length === 1) {
      merged.push(list[0]!);
      continue;
    }
    const ratings = new Set(list.map((r) => r.rating));
    if (ratings.size === 1) {
      merged.push(list[0]!);
      continue;
    }
    const conflictRating: QualityReceiptRating = "conflicted";
    merged.push({
      receiptId: `merge-conflict:${bindingKey}`,
      receiptDigest: contentDigest(
        jcsCanonicalize({ bindingKey, sources: list.map((r) => ({ receiptId: r.receiptId, rating: r.rating })) })
      ),
      bindingKey,
      rating: conflictRating,
      disposition: "human-anchored-conflict",
      rubricVersion: "anchored-calibration-v1",
      reviewerId: "merge:human+anchored",
    });
  }
  return merged;
}
