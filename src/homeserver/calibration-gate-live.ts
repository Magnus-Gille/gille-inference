/**
 * calibration-gate-live.ts — computes a LIVE #6 `CalibrationGateDecision` from already-read ledger
 * rows and an optional Quality Receipts export (issue #37), OR from the verifier-anchored feed
 * (issue #48), OR both merged (the default).
 *
 * Before this module existed, `scripts/routing-lifecycle-cli.ts`'s `review` command only ever
 * sourced a `CalibrationGateDecision` from an explicit `--calibration-gate <path>` file, and
 * defaulted to `null` otherwise — the CLI never actually evaluated the #6 gate against current
 * evidence, so the decision artifact it produced always carried `calibrationGate: null` unless an
 * operator remembered to hand it a previously-computed gate file.
 *
 * This function factors out the exact sample → join → metrics → evaluate sequence
 * `scripts/harvest-judge-calibration-gate.ts` already performs (calibration-sample.ts's
 * `buildStratifiedSampleSpec`/`stratumKeyOf`/`seededRand`, calibration-quality-receipts.ts's
 * `joinSampleToReceipts`, calibration-metrics.ts's `computeCalibrationMetrics`, calibration-gate.ts's
 * `evaluateCalibrationGate`) so both CLI entry points compute the SAME live gate from the same
 * inputs without duplicating — and risking drift in — that sequence.
 *
 * Deliberately takes already-read `rows`/`receipts` rather than performing IO itself (ledger DB
 * reads and `--receipts` file parsing stay in the calling script) — same DB/fs-injection discipline
 * as routing-lifecycle.ts's own pure core.
 *
 * Honest by construction, not merely by convention: with no receipts supplied and no admissible
 * anchored judge (the common case today — see `docs/harvest-judge-calibration-gate-2026-07-20.md`'s
 * "HONEST CURRENT STATE"), this computes a real HOLD ("0 of N sampled rows joined to an independent
 * Quality Receipt"), never a null/skipped gate — exactly what routing-lifecycle.ts's
 * `validateCandidate` needs in order to correctly refuse an organic-judge-dependent route change by
 * default (a null gate was ALREADY treated as most-restrictive by `validateCandidate`'s
 * `gateAdmitsOrganicEvidence` check; this module's job is only to stop leaving that check
 * permanently starved of live evidence).
 *
 * `mode` (issue #48) selects the trusted-LABEL SOURCE fed into the join — the HOLD/GO machinery
 * itself (`evaluateCalibrationGate`, `computeCalibrationMetrics`) is untouched and reused verbatim
 * regardless of mode:
 *   - "human": exactly the #37 behavior — only the caller-supplied `receipts`.
 *   - "anchored": only the verifier-anchored feed (anchored-calibration.ts) — can reach GO with
 *     ZERO human labels once an organic judge's rolling anchored agreement clears kappa.
 *   - "both" (DEFAULT): human and anchored receipts merged (anchored-calibration.ts's
 *     `mergeCalibrationReceipts`) — human labels stay fully optional/additive, never required.
 * `#7`/`#37` callers that never pass `mode` get "both" and see IDENTICAL behavior to before this
 * change whenever their rows contain no verifier-anchored overlap evidence (the anchored feed then
 * contributes zero receipts) — no consumer changes required.
 */
import type { CalibrationSampleRow } from "./ledger.js";
import { buildStratifiedSampleSpec, seededRand, stratumKeyOf } from "./calibration-sample.js";
import { joinSampleToReceipts, type QualityReceiptRef } from "./calibration-quality-receipts.js";
import { computeCalibrationMetrics } from "./calibration-metrics.js";
import { evaluateCalibrationGate, type CalibrationGateDecision } from "./calibration-gate.js";
import { CURRENT_CALIBRATION_POLICY, calibrationPolicyId } from "./calibration-policy.js";
import {
  computeAnchoredCalibration,
  anchoredReceiptsFrom,
  mergeCalibrationReceipts,
  type AnchoredCalibrationConfig,
} from "./anchored-calibration.js";

export type CalibrationLabelMode = "human" | "anchored" | "both";

export interface ComputeLiveCalibrationGateInputs {
  rows: readonly CalibrationSampleRow[];
  /** Human-audited (issue #37) receipts — always OPTIONAL; pass `[]` when none exist. */
  receipts: readonly QualityReceiptRef[];
  generatedAt: string;
  /** Maximum rows drawn per stratum — see calibration-sample.ts's BuildSampleSpecOptions. Default 40. */
  targetPerStratum?: number;
  /** Seeded PRNG seed for reproducible draws (never Math.random) — default 0. */
  seed?: number;
  /** Trusted-label feed selector (issue #48). Default `"both"`. */
  mode?: CalibrationLabelMode;
  /** Overrides for the anchored feed's kappa/window/min-sample — see anchored-calibration.ts's
   *  `DEFAULT_ANCHORED_CALIBRATION_CONFIG`. Ignored when `mode === "human"`. */
  anchoredConfig?: Partial<AnchoredCalibrationConfig>;
  /** Freshness clock for the anchored feed's rolling window. Defaults to `generatedAt` (NEVER
   *  wall-clock `Date.now()`) so this function stays fully pure/deterministic — a decision
   *  artifact's own timestamp IS the clock its own freshness decay is measured against. */
  anchoredAsOf?: string;
}

/**
 * PURE over its inputs (no IO). Draws the same stratified sample `harvest-judge-calibration-gate.ts`
 * draws, joins it to the mode-selected receipts (an empty set when none apply, so every sampled row
 * is then honestly UNMATCHED — exactly what drives the expected HOLD), computes metrics, and
 * evaluates the gate under `CURRENT_CALIBRATION_POLICY`.
 */
export function computeLiveCalibrationGate(inputs: ComputeLiveCalibrationGateInputs): CalibrationGateDecision {
  const {
    rows,
    receipts: humanReceipts,
    generatedAt,
    targetPerStratum = 40,
    seed = 0,
    mode = "both",
    anchoredConfig,
    anchoredAsOf,
  } = inputs;

  const spec = buildStratifiedSampleSpec(rows, { targetPerStratum, rand: seededRand(seed) });
  const selectedIds = new Set(spec.selectedRowIds);
  const selectedRows = rows.filter((r) => selectedIds.has(r.id));
  const strataByRowId = new Map(selectedRows.map((r) => [r.id, stratumKeyOf(r)]));

  let receipts: readonly QualityReceiptRef[];
  if (mode === "human") {
    receipts = humanReceipts;
  } else {
    // Anchored calibration runs over the FULL `rows` population (not `selectedRows`) — see
    // anchored-calibration.ts's own doc comment on why down-sampling scarce overlap evidence a
    // second time would only widen its confidence interval for no benefit. `joinSampleToReceipts`
    // below still only ever looks up receipts for the stratified `selectedRows`, so this cannot leak
    // extra evidence into the gate beyond what the existing stratified draw already governs.
    const anchoredReport = computeAnchoredCalibration({
      rows,
      asOf: anchoredAsOf ?? generatedAt,
      config: anchoredConfig,
    });
    const anchoredReceipts = anchoredReceiptsFrom(anchoredReport);
    receipts = mode === "anchored" ? anchoredReceipts : mergeCalibrationReceipts(humanReceipts, anchoredReceipts);
  }

  const joined = joinSampleToReceipts(selectedRows, receipts);
  const policyId = calibrationPolicyId(CURRENT_CALIBRATION_POLICY);
  const metrics = computeCalibrationMetrics({
    policyId,
    joined,
    strataByRowId,
    thresholds: CURRENT_CALIBRATION_POLICY.thresholds,
  });

  return evaluateCalibrationGate({
    policyId,
    generatedAt,
    metrics,
    thresholds: CURRENT_CALIBRATION_POLICY.thresholds,
  });
}
