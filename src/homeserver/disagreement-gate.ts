/**
 * disagreement-gate.ts — cross-model disagreement as an instance-level escalation gate.
 *
 * The research-and-real-data result (docs/cascade-gate-experiment-design.md): a second cheap
 * LOCAL model's DISAGREEMENT with the primary predicts when the primary's answer would diverge
 * from a frontier model far better than the primary's own confidence (AUROC 0.986 vs 0.807 on
 * 57 replayed real owner sub-tasks). Small models cannot self-detect their errors (Tan et al.,
 * EMNLP 2025); an external cheap signal can.
 *
 * This module is the PURE core of that gate — no I/O — so it is unit-testable in isolation:
 *   - the agreement/answer-comparison primitives (moved here from the experiment script so they
 *     are production code, re-exported by scripts that still import them);
 *   - `gateDecision()` — turn two outputs + a threshold into escalate-or-not;
 *   - `gateEligible()` — the pure policy for WHEN it is worth spending the second local call.
 *
 * The orchestrator wires the I/O (running the secondary model) around these; see
 * orchestrator.ts `runSecondaryInference` / the gate block in delegateImpl.
 */
import type { Outcome } from "./ledger.js";

// ── Answer-comparison primitives (the validated cascade-experiment heuristics) ──

export function normTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[`*_#>|]/g, " ")
    .replace(/[^\p{L}\p{N}\s.+-]/gu, " ")
    .split(/\s+/)
    // strip edge punctuation so "bob." == "bob", but keep internal dots/hyphens (10.0.0.7, top-3)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

/** Jaccard similarity over normalised token sets ∈ [0,1]; 1 = identical, 0 = disjoint. */
export function jaccard(a: string, b: string): number {
  const sa = new Set(normTokens(a));
  const sb = new Set(normTokens(b));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Extract the ANSWER from a model output for agreement comparison. The disagreement signal
 * must compare ANSWERS, not chain-of-thought: two models can agree on the answer yet produce
 * very different reasoning text (which would inflate full-text disagreement to noise). Uses the
 * last `ANSWER:` tag when present; otherwise the whole output (short leaf answers / code).
 */
export function extractAnswer(out: string): string {
  const i = out.toUpperCase().lastIndexOf("ANSWER:");
  return (i >= 0 ? out.slice(i + "ANSWER:".length) : out).trim();
}

/**
 * Parse only a PURE numeric answer (optionally $/%/comma-decorated). Returns null for
 * ordinals ("2nd"), dates, or any answer with letters — those must compare as TEXT, not
 * be coerced to a number (which created false agreement: "1st" vs "2nd" → 1 vs 2). Only
 * decoration ($, %, thousands commas) and EDGE whitespace are stripped — internal whitespace is
 * NOT, so a list-like answer ("1 2") fails closed to text comparison instead of collapsing to 12.
 */
export function pureNum(s: string): number | null {
  const t = s.trim().replace(/[$,%]/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(t) ? parseFloat(t) : null;
}

/**
 * Disagreement score ∈ [0,1] on the EXTRACTED answers: higher = more disagreement = more
 * likely the primary answer is wrong. Numeric-aware: when both answers reduce to a number,
 * compare numerically (66 == 66.0, binary 0/1) so surface form doesn't create phantom
 * disagreement; otherwise graded token-Jaccard on the short answer (handles "yes"/"Yes.").
 */
export function disagreementScore(a: string, b: string): number {
  const na = extractAnswer(a);
  const nb = extractAnswer(b);
  const fa = pureNum(na);
  const fb = pureNum(nb);
  if (fa !== null && fb !== null) return Math.abs(fa - fb) < 1e-6 ? 0 : 1;
  return 1 - jaccard(na, nb);
}

// ── Gate decision + eligibility (the production policy) ──

/** Operating mode of the gate. */
export type GateMode = "off" | "shadow" | "on";

export interface GateConfig {
  mode: GateMode;
  /** The SECOND local model whose answer is compared against the primary's. */
  secondaryModel: string;
  /** disagreementScore ≥ threshold → "disagree". Default 0.3 reproduces the validated
   *  operating point (escalate ~10.5% of real sub-tasks, catch 100% of frontier-divergent). */
  threshold: number;
}

export interface GateDecision {
  score: number;
  /** True when score ≥ threshold — the two local models disagree on the answer. */
  disagree: boolean;
}

/**
 * Pure: compare the primary and secondary outputs and decide whether they disagree at/above
 * the configured threshold. `threshold` is clamped to [0,1]. EXACT agreement (score 0) never
 * counts as disagreement — even at threshold 0 — so a mis-set threshold can't escalate every
 * unverified delegation (the `score > 0` guard).
 */
export function gateDecision(
  primaryOutput: string,
  secondaryOutput: string,
  threshold: number
): GateDecision {
  const t = Math.min(1, Math.max(0, threshold));
  const score = disagreementScore(primaryOutput, secondaryOutput);
  return { score, disagree: score > 0 && score >= t };
}

export interface GateEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Pure policy: should we spend a second LOCAL call to gate this delegation?
 *
 * The gate fills the gap left by deterministic verifiers — so it only runs on the UNVERIFIED
 * path, where there is no authoritative verdict to trust and the system is currently keeping
 * the task local on faith. Where a verifier already produced a verdict (pass/fail/partial) we
 * trust that signal and never pay for a second model. We also require a configured secondary
 * model that DIFFERS from the primary (a model cannot disagree with itself).
 *
 *   - mode "off"                      → never eligible.
 *   - outcome ≠ "unverified"          → not eligible (a verifier already decided).
 *   - no secondary / same as primary  → not eligible (no independent signal).
 *   - else (mode shadow|on)           → eligible.
 */
export function gateEligible(args: {
  config: GateConfig;
  outcome: Outcome;
  primaryModelId: string;
}): GateEligibility {
  const { config, outcome, primaryModelId } = args;
  if (config.mode === "off") return { eligible: false, reason: "gate off" };
  if (outcome !== "unverified") {
    return { eligible: false, reason: `verifier verdict present (${outcome}) — trust it` };
  }
  const secondary = config.secondaryModel?.trim();
  if (!secondary) return { eligible: false, reason: "no secondary model configured" };
  if (secondary === primaryModelId) {
    return { eligible: false, reason: "secondary model == primary (no independent signal)" };
  }
  return { eligible: true, reason: `gate ${config.mode}` };
}
