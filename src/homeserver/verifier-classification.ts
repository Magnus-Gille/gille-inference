/**
 * Verifier classification — STRUCTURAL vs QUALITY-BEARING (issue #156, proposal 1).
 *
 * The capability ledger grades every delegation with a named verifier (see verifier-registry.ts).
 * But not all verifiers measure the same thing:
 *
 *   - STRUCTURAL verifiers check SHAPE / PRESENCE, not correctness: `nonEmpty(...)` (the model
 *     emitted SOMETHING), `jsonValid` (it parses), `maxLength(...)` (it fits a length window).
 *   - QUALITY-BEARING verifiers actually grade the answer: `answerIs`, `exact`, `containsAll`,
 *     `numeric`, plus the probe-native `predicate` / `tsGate` and any other named check.
 *
 * For most task types a structural pass is a fine signal. For JUDGMENT-QUALITY task types
 * (code-review at minimum) it is a TRAP: a model can pass `nonEmpty` on every review while finding
 * 0 of 34 real seeded bugs and still earn a viable / delegate-local verdict at passRate 1.0
 * (the 2026-07-05 ground-truth sweep — mellum: 5.9% recall, 25% precision, table passRate 1.0).
 * Structural pass ≠ review quality. This module names that distinction so the verdict computation
 * can exclude inadmissible evidence (see ledger.getVerdict + config.judgmentQualityTaskTypes).
 *
 * JUDGMENT CALL (flagged, #156): the exact structural set below is a conservative default —
 * nonEmpty/jsonValid/maxLength are the only verifiers that provably say nothing about correctness.
 * "Everything else is quality-bearing" is deliberately permissive: it treats an unrecognised /
 * future verifier name as quality-bearing rather than silently dropping its evidence. `matches` is
 * pattern-dependent (a `/./` pattern is structural in spirit); it is classified quality-bearing
 * here — revisit if a match pattern is ever used as a mere presence check for a judgment type.
 */

/**
 * Verifiers that check only SHAPE / PRESENCE, not correctness. Names match verifier-registry.ts's
 * stable labels; parameterised labels (`nonEmpty(1)`, `nonEmpty(0)`) are matched on their base name.
 */
export const STRUCTURAL_VERIFIERS: ReadonlySet<string> = new Set(["nonEmpty", "jsonValid", "maxLength"]);

/**
 * Sentinel names the orchestrator writes for a row that NO real verifier graded (orchestrator.ts
 * records `verifier: "none"` when the task carried no verifier — including no-verifier FAILURE rows
 * stored as `outcome:"error"`). These are admissibility-equivalent to a null verifier: nothing was
 * checked, so they are neither structural nor quality-bearing. `"custom"` is deliberately NOT here —
 * it marks a real (if unnamed) verifier function and stays quality-bearing.
 */
export const UNGRADED_VERIFIER_SENTINELS: ReadonlySet<string> = new Set(["none"]);

/** Strip a parameter suffix so `nonEmpty(1)` / `maxLength(...)` classify by their base name. */
export function verifierBaseName(name: string): string {
  const paren = name.indexOf("(");
  return (paren >= 0 ? name.slice(0, paren) : name).trim();
}

/** True iff `name` is a known structural (shape/presence-only) verifier. Null/empty → false. */
export function isStructuralVerifier(name: string | null | undefined): boolean {
  if (name == null) return false;
  const base = verifierBaseName(name);
  return base.length > 0 && STRUCTURAL_VERIFIERS.has(base);
}

/**
 * True iff a row graded by `name` is admissible as evidence of ANSWER QUALITY: a NAMED, NON-
 * structural verifier. A structural verifier (shape/presence only), an ungraded row (null / empty
 * verifier), or the orchestrator's `"none"` ungraded sentinel is NOT quality-bearing — for a
 * judgment-quality task type it must not count toward the verdict in EITHER direction. Any other
 * named verifier is treated as quality-bearing (the conservative default above).
 */
export function isQualityBearingVerifier(name: string | null | undefined): boolean {
  if (name == null) return false;
  const base = verifierBaseName(name);
  if (base.length === 0) return false;
  if (UNGRADED_VERIFIER_SENTINELS.has(base)) return false; // ungraded sentinel — no verifier ran
  return !STRUCTURAL_VERIFIERS.has(base);
}

/**
 * True iff a row graded by `name` is admissible as evidence of JUDGMENT-QUALITY output (issue #168):
 * its base verifier name is in the caller's TRUSTED whitelist. This is the whitelist counterpart to
 * isQualityBearingVerifier's blacklist, and for a judgment-quality task type it is the RULE (see
 * ledger.getVerdict + config.trustedVerifiersForJudgment) — a whitelist is strictly stronger than
 * the blacklist and subsumes it, so the two are never run redundantly.
 *
 * Why stronger: the blacklist could only exclude KNOWN-structural verifiers; it still admitted
 * opaque/non-adversarial checks (`predicate`, `matches`) that a model passes while finding ~6% of
 * real seeded bugs. Requiring positive trust closes that gap. A null / empty / whitespace verifier
 * is never trusted (an ungraded row grades nothing). The whitelist is normally EMPTY until #158
 * lands a ground-truth reviewer-grading verifier, so judgment types honestly resolve to `unknown`.
 */
export function isTrustedJudgmentVerifier(
  name: string | null | undefined,
  trusted: ReadonlySet<string>
): boolean {
  if (name == null) return false;
  const base = verifierBaseName(name);
  if (base.length === 0) return false;
  return trusted.has(base);
}

/**
 * Verifier-KIND classification (issue #233) — a COARSER, orthogonal axis to structural/quality-bearing
 * above. `isQualityBearingVerifier` already distinguishes "checks nothing about content" (structural)
 * from "checks something about content" (quality-bearing) — but a quality-bearing deterministic
 * pattern/value check (`containsAll`, `exact`, `answerIs`, `numeric`, `matches`) is STILL gameable by
 * output that merely LOOKS right (contains the expected substring) without the full answer being
 * correct. The 2026-07-12 m5h harvest evidence: `qa-factual` showed 3/3 ledger *pass* yet one row was
 * confirmed factually wrong by a human; `classify` showed 6/7 pass with a confirmed-wrong row too — in
 * both cases the row's verifier checked shape/pattern, not truth.
 *
 * This module names that gap with a THIRD kind:
 *   - "mechanical-format": every verifier in {@link MECHANICAL_FORMAT_VERIFIERS} — deterministic
 *     shape/presence/pattern/fixed-value checks performed by string/regex/numeric comparison. Passing
 *     one is necessary but not sufficient evidence of a CORRECT answer.
 *   - "truth-oriented": establishes truth by executing the candidate against real ground truth
 *     (`tsGate` compiles+runs code; `sqlExec` runs SQL against a fixture and compares actual result
 *     rows) or by another model's judgment (harvest.ts's `llm-judge:<model>` / its shadow variant).
 *     An unrecognised/future verifier name (`predicate`, `custom`, a probe's ad-hoc check-cmd, …)
 *     defaults here too — the conservative default (mirrors `isQualityBearingVerifier`): never
 *     silently discount evidence just because the verifier's name isn't in the known mechanical set.
 *   - "ungraded": null / empty / the orchestrator's `"none"` sentinel — admissibility-equivalent to no
 *     verifier at all.
 *
 * A probe's `verifierName` may combine multiple checks with `+` (e.g. `"maxLength+predicate"`,
 * probes.ts) — each component is classified and the combo is "mechanical-format" only if EVERY
 * component is; if any component is truth-oriented (e.g. `predicate` ran real logic), the combo is,
 * since a genuine judgment contributed to the pass even alongside a shape check.
 */
export type VerifierKind = "mechanical-format" | "truth-oriented" | "ungraded";

/**
 * Deterministic verifiers that check output SHAPE, PATTERN, or a fixed EXPECTED VALUE via
 * string/regex/numeric comparison. Names match verifier-registry.ts / verifier.ts's stable labels.
 */
export const MECHANICAL_FORMAT_VERIFIERS: ReadonlySet<string> = new Set([
  "nonEmpty",
  "jsonValid",
  "maxLength",
  "matches",
  "containsAll",
  "containsNone",
  "exact",
  "answerIs",
  "numeric",
  // #234: token similarity to a frontier answer is useful candidate evidence, but it is not a
  // truth check. Keep it in the same discounted class as exact/answerIs.
  "shadow-vs-frontier",
]);

function classifyVerifierComponentKind(base: string): "mechanical-format" | "truth-oriented" {
  return MECHANICAL_FORMAT_VERIFIERS.has(base) ? "mechanical-format" : "truth-oriented";
}

/** Classify a (possibly `+`-combined) verifier name into a {@link VerifierKind}. */
export function classifyVerifierKind(name: string | null | undefined): VerifierKind {
  const trimmed = name?.trim();
  if (!trimmed) return "ungraded";
  const components = trimmed
    .split("+")
    .map((part) => verifierBaseName(part.trim()))
    .filter((base) => base.length > 0 && !UNGRADED_VERIFIER_SENTINELS.has(base));
  if (components.length === 0) return "ungraded";
  return components.some((base) => classifyVerifierComponentKind(base) === "truth-oriented")
    ? "truth-oriented"
    : "mechanical-format";
}
