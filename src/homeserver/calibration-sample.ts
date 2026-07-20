/**
 * Stratified calibration sample specification (issue #6).
 *
 * Pure, DB-free bucketing and deterministic seeded sampling over `CalibrationSampleRow` — the
 * already content-blind row shape `ledger.listCalibrationSampleRows()` reads (no prompt text, no
 * prompt hash, no notes; see that function's doc comment for why). Nothing in this module ever
 * touches raw task content, so nothing it produces (a `StratifiedSampleSpec`, a drawn sample) can
 * leak it either — nothing here is IN a position to.
 *
 * Strata dimensions (issue #6 scope): task type, prompt-size bucket, model, verifier class, harness
 * surface, and pass/fail UNCERTAINTY (confident-pass / confident-fail / uncertain). "Uncertain" is
 * the honest bucket for `partial` verdicts and for judge scores sitting near a verdict-band
 * boundary — exactly the rows where the judge's own confidence is lowest and an independent label
 * matters most.
 */

import type { CalibrationSampleRow } from "./ledger.js";
import { bandVerdictFromScore } from "./harvest.js";
import { verifierBaseName, MECHANICAL_FORMAT_VERIFIERS } from "./verifier-classification.js";

// ─── Verifier class (stratification + trust) ─────────────────────────────────────
//
// A COARSER grouping than classifyVerifierKind (verifier-classification.ts): that function's
// default for an UNRECOGNISED verifier name is "truth-oriented" (a routing-weight-preserving
// choice — see its doc comment). Issue #6 requires the OPPOSITE default for calibration TRUST: "a
// known wrong answer that passed only a format/structural check MUST NOT earn trusted truth-quality
// evidence" AND "unknown verifier identities are untrusted until classified." So `verifierClassOf`
// buckets every verifier into one of a small set of NAMED classes, and only an explicitly
// allowlisted truth-oriented class is ever treated as trusted by calibration-metrics.ts's
// `isTrustedTruthQualityVerifier` — an unrecognised name lands in `unclassified:<base>`, not in
// `truth-oriented:<base>`, however classifyVerifierKind would have scored it. This is a deliberate,
// documented divergence from ledger.ts's routing-weight default, scoped ONLY to calibration trust —
// it does not change routing (issue #6's explicit non-goal).

/** Verifier base names calibration EXPLICITLY recognises as establishing truth by executing the
 *  candidate against real ground truth (mirrors verifier-classification.ts's own examples). Grow
 *  this only with a demonstrated, reviewed ground-truth verifier — never as a blanket default. */
const KNOWN_TRUTH_ORIENTED_VERIFIERS: ReadonlySet<string> = new Set(["tsGate", "sqlExec"]);

/** Verifier base-name prefix for the harvest judge's real (non-shadow) verdict-writing verifier
 *  (`llm-judge:<model>`) and its shadow-mode counterpart (`harvest-shadow:llm-judge:<model>`). Both
 *  are judge evidence — the exact thing this calibration harness measures the trustworthiness of. */
const LLM_JUDGE_PREFIX = /^(harvest-shadow:)?llm-judge:/;

/**
 * Bucket a verifier name into a stable class string for stratification. Mechanical-format
 * verifiers are grouped under one literal `"mechanical-format"` label (not split by base name) so
 * that class is directly comparable to the AC's "format checks" language; everything else keeps its
 * base name so a stratum table stays legible.
 */
export function verifierClassOf(verifierName: string | null | undefined): string {
  const trimmed = verifierName?.trim();
  if (!trimmed) return "ungraded";
  if (LLM_JUDGE_PREFIX.test(trimmed)) return "llm-judge";
  const base = verifierBaseName(trimmed);
  if (base.length === 0 || base === "none") return "ungraded";
  if (MECHANICAL_FORMAT_VERIFIERS.has(base)) return "mechanical-format";
  if (KNOWN_TRUTH_ORIENTED_VERIFIERS.has(base)) return `truth-oriented:${base}`;
  return `unclassified:${base}`;
}

// ─── Stratification dimensions ───────────────────────────────────────────────────

export type PromptSizeBucket = "xs" | "s" | "m" | "l" | "xl" | "unknown";

/**
 * Bucket boundaries in TOKENS (structured, content-blind field). `xl` is deliberately the
 * long-context / starvation-risk stratum (#6 AC: "including long-context and starvation strata") —
 * it lines up with harvest.ts's own escalateJudgeMaxTokens starvation path, which is triggered
 * specifically by large inputs.
 */
const PROMPT_SIZE_BOUNDARIES: ReadonlyArray<[PromptSizeBucket, number]> = [
  ["xs", 200],
  ["s", 1_000],
  ["m", 4_000],
  ["l", 16_000],
  ["xl", Infinity],
];

export function promptSizeBucketOf(promptTokens: number | null | undefined): PromptSizeBucket {
  if (promptTokens === null || promptTokens === undefined || !Number.isFinite(promptTokens) || promptTokens < 0) {
    return "unknown";
  }
  for (const [bucket, max] of PROMPT_SIZE_BOUNDARIES) {
    if (promptTokens <= max) return bucket;
  }
  return "xl";
}

export type UncertaintyBand = "confident-pass" | "confident-fail" | "uncertain";

/** Half-width around the pass/fail band boundaries (0.7 / 0.3) treated as "the judge itself was not
 *  confident" — independent of the row's own outcome bucket. A `partial` outcome is ALWAYS
 *  "uncertain" by definition (that band exists precisely because the judge would not commit). */
const NEAR_BOUNDARY_MARGIN = 0.05;

/**
 * Content-blind uncertainty classification for one sampled row. Uses the judge's numeric `score`
 * (content-blind — see ledger.CalibrationSampleRow) when present; falls back to the recorded
 * `outcome` for non-judge evidence (deterministic verifiers have no "score" but a `fail` outcome is
 * still a confident-fail signal in the sense that matters here — no judge uncertainty to measure).
 */
export function uncertaintyBandOf(row: Pick<CalibrationSampleRow, "outcome" | "score">): UncertaintyBand {
  if (row.score !== null && Number.isFinite(row.score)) {
    if (row.score >= 0.7 - NEAR_BOUNDARY_MARGIN && row.score < 0.7 + NEAR_BOUNDARY_MARGIN) return "uncertain";
    if (row.score >= 0.3 - NEAR_BOUNDARY_MARGIN && row.score < 0.3 + NEAR_BOUNDARY_MARGIN) return "uncertain";
    const band = bandVerdictFromScore(row.score);
    if (band === "pass") return "confident-pass";
    if (band === "fail") return "confident-fail";
    return "uncertain"; // partial, or unparseable score
  }
  if (row.outcome === "pass") return "confident-pass";
  if (row.outcome === "fail" || row.outcome === "error") return "confident-fail";
  return "uncertain"; // partial / unverified with no score
}

/** The judge's PREDICTED verdict for a row, content-blind (issue #6's join target). For real
 *  (`outcome`-writing) harvest evidence the outcome IS the verdict. For `harvest-shadow` evidence
 *  (always written as `outcome: "unverified"` by design — see harvest.ts) the intended verdict is
 *  recovered from the numeric score instead of the free-text `notes` field. Returns null when
 *  neither source yields a verdict (e.g. a non-judge-graded row with no score and an unverified
 *  outcome) — such a row cannot contribute to judge precision/recall and is excluded upstream. */
export function predictedVerdictOf(
  row: Pick<CalibrationSampleRow, "outcome" | "score" | "source">
): "pass" | "partial" | "fail" | null {
  if (row.outcome === "pass" || row.outcome === "partial" || row.outcome === "fail") return row.outcome;
  if (row.score !== null && Number.isFinite(row.score)) return bandVerdictFromScore(row.score);
  return null;
}

/**
 * The exact six issue #6 sampling dimensions. `lane` (chat/mcp-ask/delegate/...) is deliberately
 * NOT a seventh dimension here — it is not in the AC's stratification list, and it is instead a
 * separate METRICS rollup (calibration-metrics.ts's `byLane`, satisfying the AC's "metrics per lane
 * AND per verifier class" requirement without also fragmenting the sampling draw by it).
 */
export interface StratumKey {
  taskType: string;
  promptSizeBucket: PromptSizeBucket;
  modelId: string;
  verifierClass: string;
  /** `source` column value — the closest content-blind harness-surface proxy available today; see
   *  ledger.CalibrationSampleRow's doc comment. */
  harnessSurface: string;
  uncertaintyBand: UncertaintyBand;
}

/** Stable string key for a StratumKey — used for grouping and as the sample-spec map key. Order is
 *  fixed so two equal StratumKeys always produce the same string regardless of construction order. */
export function stratumKeyString(k: StratumKey): string {
  return [k.taskType, k.promptSizeBucket, k.modelId, k.verifierClass, k.harnessSurface, k.uncertaintyBand].join(
    "␟" // unit-separator-ish marker unlikely to collide with real field values
  );
}

export function stratumKeyOf(row: CalibrationSampleRow): StratumKey {
  return {
    taskType: row.taskType,
    promptSizeBucket: promptSizeBucketOf(row.promptTokens),
    modelId: row.modelId,
    verifierClass: verifierClassOf(row.verifier),
    harnessSurface: row.source ?? "(unknown)",
    uncertaintyBand: uncertaintyBandOf(row),
  };
}

// ─── Sample specification ────────────────────────────────────────────────────────

export interface StratumSpec {
  key: StratumKey;
  /** Total content-blind rows observed in this stratum (the population, not the draw). */
  populationSize: number;
  /** How many rows this stratum's draw TARGETS — min(populationSize, targetPerStratum). */
  targetSize: number;
  /** True iff populationSize < targetPerStratum — the stratum is structurally under-sampled no
   *  matter how the draw goes; the metrics stage must report this honestly, never pad it. */
  underPopulated: boolean;
}

export interface StratifiedSampleSpec {
  /** Row ids selected by stratified sampling — content-blind identifiers, safe to persist in an
   *  artifact (issue #6 AC: no raw task text in calibration artifacts). */
  selectedRowIds: string[];
  strata: StratumSpec[];
  targetPerStratum: number;
  totalPopulation: number;
  totalSelected: number;
}

export interface BuildSampleSpecOptions {
  /** Maximum rows drawn PER STRATUM. Default 40 (comfortably above the default minStratumN=30 in
   *  calibration-policy.ts, so a fully-populated stratum can clear the confidence-interval floor). */
  targetPerStratum?: number;
  /** Seeded PRNG in [0,1) for reproducible draws — tests and CI must never depend on Math.random. */
  rand?: () => number;
}

/** Deterministic mulberry32 PRNG — small, dependency-free, reproducible from an integer seed. Used
 *  so a calibration run's exact sample is reproducible from (population + seed) alone, matching the
 *  AC's "current verdict ... honest and reproducible." */
export function seededRand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle using an injected `rand`, in place on a copy — never mutates the input. */
function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Build and draw a stratified sample spec from content-blind rows. Groups rows by StratumKey,
 * targets up to `targetPerStratum` rows per stratum (a fixed per-cell cap — deliberately simple
 * over a variance-optimal Neyman allocation, which would need a variance estimate this harness does
 * not have yet), and draws WITHOUT replacement using a seeded shuffle so the same (rows, seed) pair
 * always reproduces the same selection. A stratum with population below the target is fully
 * included and flagged `underPopulated: true` — never padded or silently dropped.
 */
export function buildStratifiedSampleSpec(
  rows: readonly CalibrationSampleRow[],
  opts: BuildSampleSpecOptions = {}
): StratifiedSampleSpec {
  const targetPerStratum = opts.targetPerStratum ?? 40;
  const rand = opts.rand ?? seededRand(0);

  const groups = new Map<string, { key: StratumKey; rows: CalibrationSampleRow[] }>();
  for (const row of rows) {
    const key = stratumKeyOf(row);
    const k = stratumKeyString(key);
    const existing = groups.get(k);
    if (existing) existing.rows.push(row);
    else groups.set(k, { key, rows: [row] });
  }

  const strata: StratumSpec[] = [];
  const selectedRowIds: string[] = [];
  for (const { key, rows: groupRows } of [...groups.values()].sort((a, b) =>
    stratumKeyString(a.key).localeCompare(stratumKeyString(b.key))
  )) {
    const targetSize = Math.min(groupRows.length, targetPerStratum);
    const drawn = shuffled(groupRows, rand).slice(0, targetSize);
    for (const row of drawn) selectedRowIds.push(row.id);
    strata.push({
      key,
      populationSize: groupRows.length,
      targetSize,
      underPopulated: groupRows.length < targetPerStratum,
    });
  }

  return {
    selectedRowIds,
    strata,
    targetPerStratum,
    totalPopulation: rows.length,
    totalSelected: selectedRowIds.length,
  };
}
