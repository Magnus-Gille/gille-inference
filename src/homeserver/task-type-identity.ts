/**
 * Canonical task-type identity — issue #80.
 *
 * Background: #74's advisory-only guardrail (`isAdvisoryOnlyTaskType` in delegate-policy.ts) and
 * the `/v1/capabilities/review-lane` preflight (`reviewLaneCapability` in review-bounded.ts) both
 * compared a task type by EXACT string match, while `code-loop.ts` accepted a caller-supplied
 * `task_type` and passed it through untrimmed. `"review-bounded "` therefore skipped the guardrail.
 * It was fail-safe (a whitespace-variant bucket has no certified evidence rows, so the ordinary
 * evidence gates deny or shadow it anyway) — but a guardrail whose entire job is to be the
 * INDEPENDENT last line of defense must not depend on another gate catching the same input.
 *
 * Normalization is `trim()` + `toLowerCase()`. Case-folding is safe here because every task-type id
 * in taxonomy.ts is a lowercase kebab literal: folding can only map a variant ONTO a canonical id,
 * never invent a new one. For the advisory-only guardrail that direction is the fail-safe one — it
 * can only ever catch MORE input as advisory-only, never less.
 *
 * Deliberately NOT applied to the recorded ledger bucket: `orchestrator.resolveTaskType` trims but
 * otherwise preserves an explicit caller-supplied type verbatim (#155), so a caller's domain
 * bucket keeps the spelling it asserted. This module is for POLICY/LOOKUP comparisons, which must
 * agree with each other regardless of how a caller or an operator spelled the same lane.
 *
 * This is a leaf module (no imports) on purpose: taxonomy.ts already imports review-bounded.ts, so
 * a shared helper living in either of those would close an import cycle.
 */

/**
 * Canonical comparison form of a task-type string: trimmed and case-folded.
 *
 * Use this for a GUARDRAIL — a check whose failure direction is "treat more input as restricted".
 * Do NOT use it to advertise what a task type will actually do (see `ingressTaskType`).
 */
export function normalizeTaskType(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * The form ingress actually records: trimmed, otherwise verbatim — exactly what
 * `orchestrator.resolveTaskType` produces for a non-blank explicit task type (#155).
 *
 * Use this whenever the answer must PREDICT real behavior rather than restrict it. Case-folding
 * here would be a lie: routing (`routeViaTable`), the judgment-verifier guard, and the evidence
 * bucket all key off the recorded spelling, so `"Code-Review"` is a different bucket from
 * `"code-review"` no matter what a capability advertisement claims.
 *
 * The asymmetry with `normalizeTaskType` is deliberate and both halves fail safe:
 * - the advisory-only guardrail case-folds, so a spelling variant can only ever be caught by it;
 * - a capability advertisement only trims, so it never promises a lane the pipeline won't take.
 */
export function ingressTaskType(raw: string): string {
  return raw.trim();
}

/**
 * The single promotion test shared by the policy guardrail and the capability preflight, so the
 * two can never disagree about whether a lane is promoted.
 *
 * Both sides are normalized: an operator who wrote `Review-Bounded` in
 * `delegatePolicy.promotedAdvisoryTaskTypes` promoted the canonical lane, and a caller who asked
 * for `"review-bounded "` is asking for that same lane. Promotion still requires that deliberate
 * operator entry — the list defaults to empty, and normalizing never adds a lane to it.
 */
export function isPromotedAdvisoryTaskType(
  taskType: string,
  promotedAdvisoryTaskTypes: readonly string[]
): boolean {
  const canonical = normalizeTaskType(taskType);
  return promotedAdvisoryTaskTypes.some((promoted) => normalizeTaskType(promoted) === canonical);
}
