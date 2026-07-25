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
 * here would be a lie about RECORDED IDENTITY: the orchestrator writes `taskType` to the ledger
 * verbatim (#155), so `"Code-Review"` remains a different recorded evidence bucket from
 * `"code-review"` no matter what a capability advertisement claims.
 *
 * #91 NOTE — policy DECISIONS no longer key off the raw spelling. `policyTaskTypeIdentity`
 * canonicalizes a spelling whose normalized form is a known taxonomy id, and routing
 * (`routeViaTable`), the judgment-verifier guard, the broad/low-risk lookups and the policy-side
 * evidence read all use that canonical identity. A case variant is therefore no longer a policy
 * bypass; it is only still a distinct RECORDED bucket.
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

/**
 * The single policy/lookup identity of a task type — issue #91.
 *
 * #80/#90 left a real gap: `isAdvisoryOnlyTaskType` case-folds its own input (a guardrail, so
 * over-catching is fail-safe), but every OTHER policy comparison — the judgment-verifier deny in
 * `decideDelegatePolicy`, `BROAD_TASK_TYPES`/`LOW_RISK_TASK_TYPES`, `taskTypeEmitsJson`, and the
 * routing-table lookup — still compared the #155 verbatim-ingress spelling by exact string match.
 * `"Code-Review"` is therefore a different bucket from `"code-review"` for those gates, including
 * the judgment-verifier deny, which is an AUTHORITY gate: with enough evidence accumulated on that
 * variant bucket, enforce-mode `decideDelegatePolicy` could return `allow` where canonical
 * `code-review` returns `deny`.
 *
 * The rule (decided on the orchestrator side, #155/#91): canonicalize a spelling ONLY when its
 * normalized (trim + case-fold) form is a KNOWN taxonomy id. That canonical identity is then used
 * for routing, the judgment/broad/low-risk lookups, the JSON response contract, and evidence-bucket
 * reads — so a real task type cannot dodge those gates by spelling. A spelling whose normalized form
 * is NOT a known id keeps its #155 ingress identity (trimmed, otherwise verbatim) and still falls
 * through to the existing unknown-lane policy unchanged — canonicalizing an unrecognized spelling
 * would fold arbitrary caller buckets together (e.g. two different ratatoskr domain buckets that
 * happen to differ only by case) and risk silently re-bucketing evidence already recorded under a
 * caller's own asserted type, which is exactly the kind of undocumented migration #91 rules out.
 *
 * `isKnownTaskType` is injected rather than imported directly: `taxonomy.ts` imports
 * `review-bounded.ts`, which imports this leaf module, so importing `taxonomy.ts` here would close
 * that cycle (see the file header). Every call site already has `isKnownTaskType` in scope.
 */
export function policyTaskTypeIdentity(
  taskType: string,
  isKnownTaskType: (id: string) => boolean
): string {
  const canonical = normalizeTaskType(taskType);
  return isKnownTaskType(canonical) ? canonical : ingressTaskType(taskType);
}
