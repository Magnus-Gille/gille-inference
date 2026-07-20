/**
 * Join to independent ground-truth labels (issue #6).
 *
 * The calibration harness's own judge-predicted verdict (calibration-sample.ts's
 * `predictedVerdictOf`) is not ground truth — it is the thing being calibrated. Ground truth comes
 * from an INDEPENDENT signal: a Hugin Quality Receipt (hugin#231; see grimnir
 * docs/learning-task-contract.md's `quality-receipt` record kind) where one exists for the sampled
 * row's exact binding.
 *
 * Content-blindness: a QualityReceiptRef carries only opaque identifiers, a content-derived digest,
 * and closed-enum rating/disposition fields — never review text, task text, or any free-form field.
 * This mirrors the learning-task-contract's own "carries opaque identifiers, exact hashes,
 * classifications" rule for the seam between Hugin and gille-inference.
 *
 * This module does not fetch receipts itself — gille-inference does not own the Hugin store (see
 * the contract's normative-ownership table: "Quality Receipt ... producer: Hugin"). It joins
 * whatever receipts the CALLER supplies (a real export, or in tests, a seeded fixture) against a
 * sampled row set by an explicit, caller-supplied binding key. Where no receipt is supplied for a
 * sampled row, that row is honestly UNMATCHED — never silently treated as passing or as absent
 * evidence to ignore. calibration-metrics.ts treats an under-matched stratum as insufficient, not
 * as a stratum that quietly skipped labeling.
 */

import type { CalibrationSampleRow } from "./ledger.js";

/** Closed rating vocabulary, matching the learning-task-contract's quality-receipt rating axis
 *  (pass/partial/fail) plus `conflicted` — the contract's own "disagreement in rating or disposition
 *  is conflicted and cannot support admission" state, which calibration-metrics.ts must also treat
 *  as a non-label rather than silently coercing to one side. */
export type QualityReceiptRating = "pass" | "partial" | "fail" | "conflicted";

/** One independently attributable label, content-blind by construction. */
export interface QualityReceiptRef {
  /** Native Hugin receipt id (content-derived per the contract; opaque to this module). */
  receiptId: string;
  /** "sha256:<hex>" digest of the native receipt artifact — never the artifact itself. */
  receiptDigest: string;
  /** Opaque binding key this receipt targets — MUST equal a sampled row's own binding key (see
   *  `bindingKeyOf` below) for the join to match. Never raw task text. */
  bindingKey: string;
  rating: QualityReceiptRating;
  /** Closed disposition vocabulary the caller supplies verbatim from the native receipt; kept
   *  opaque-string here (no attempt to re-close the enum) since this module does not own it. */
  disposition: string;
  rubricVersion: string;
  /** Opaque reviewer identifier — never a name, email, or free-text attribution. */
  reviewerId: string;
}

/**
 * The binding key a sampled ledger row is joined on. Deliberately the row's own opaque
 * `evidenceIdentityHash` when present (the strongest available immutable key — issue #5), falling
 * back to the row id (still opaque, still content-blind) when no identity bundle was recorded. A
 * caller producing real QualityReceiptRefs from a Hugin export MUST use the same convention so rows
 * and receipts actually meet; this function is exported so both sides use one definition.
 */
export function bindingKeyOf(row: Pick<CalibrationSampleRow, "id" | "evidenceIdentityHash">): string {
  return row.evidenceIdentityHash ?? `row:${row.id}`;
}

export interface JoinedSampleRow {
  row: CalibrationSampleRow;
  bindingKey: string;
  receipt: QualityReceiptRef | null;
  matched: boolean;
}

/**
 * Pure join: for every sampled row, look up a receipt by binding key. `receiptsByBindingKey`
 * accepts a plain array (not a pre-built index) so callers never have to worry about building a
 * consistent Map themselves; multiple receipts targeting the same binding key is a caller error we
 * fail closed on (a Quality Receipt is 1:1 with a binding in this v1 join — the contract's own
 * `quality_receipt.native_receipt.receipt_id` conflict key implies at most one EFFECTIVE receipt per
 * binding once corrections are collapsed, and this module does not implement correction collapsing,
 * so it refuses to silently pick one of several).
 */
export function joinSampleToReceipts(
  sampledRows: readonly CalibrationSampleRow[],
  receipts: readonly QualityReceiptRef[]
): JoinedSampleRow[] {
  const byKey = new Map<string, QualityReceiptRef[]>();
  for (const r of receipts) {
    const existing = byKey.get(r.bindingKey);
    if (existing) existing.push(r);
    else byKey.set(r.bindingKey, [r]);
  }
  for (const [key, rs] of byKey) {
    if (rs.length > 1) {
      throw new Error(
        `calibration-quality-receipts: ${rs.length} receipts target binding key ${JSON.stringify(key)} — ` +
          `ambiguous join (supply a pre-collapsed single effective receipt per binding)`
      );
    }
  }
  return sampledRows.map((row) => {
    const bindingKey = bindingKeyOf(row);
    const receipt = byKey.get(bindingKey)?.[0] ?? null;
    return { row, bindingKey, receipt, matched: receipt !== null };
  });
}
