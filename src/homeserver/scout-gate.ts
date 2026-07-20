/**
 * scout-gate.ts — safety gate between "the probe battery liked this model" and "auto-serve it into
 * live llama-swap unattended." (#176)
 *
 * The incident: the weekly Model Scout auto-promoted `gemma-4-12B-agentic-fable5-composer2.5-v2-
 * 3.5x-tau2-GGUF` — a trending community fine-tune — into production because the only gate was
 * `passRate >= 0.7 && avgTokPerSec >= MIN_TOKPS`. It scored 1.0 on BOTH `sql` and `code-review`,
 * the two task types where even the 80B struggles: a textbook benchmark-gamed model (its own name
 * advertises τ²-bench / a "3.5x" claim / a distill of another family). One aggregate pass-rate
 * cannot tell "genuinely capable" from "tuned to the probe phrasing."
 *
 * This module adds two cheap, PURE checks over data the scout already has, so a suspicious winner is
 * FLAGGED (→ not auto-served; a human can still promote it manually) instead of silently going live:
 *
 *   1. Capability plausibility — implausibly-high scores on the KNOWN-HARD task types (sql /
 *      code-review / reason-hard, the universal local gaps). A small trending fine-tune that is
 *      perfect on several of these at once is far likelier gamed than SOTA; our best 80B is not.
 *   2. Name gaming-tells — the repo name advertises a benchmark/marketing claim (τ²/tau2, a
 *      multiplier like "3.5x", "composer", "fable", named benchmarks). A tell in the name is not
 *      proof, but it is exactly the signal to require a human look before serving.
 *
 * Both only DELAY auto-serve (raise a flag), never hard-reject — a false flag costs a manual ack,
 * an unflagged gamed model costs a bad production model routed to real traffic. Conservative by
 * design. The gate operates on `scoresByTaskType` (a plain Record) so it is identical whether called
 * from the scout (rich summary in hand) or the promoter (only the durable RegistryEntry).
 *
 * Designed to COMPOSE with #158's promotion-misconfig gate (HTTP-error / empty-output / truncation
 * rate): both populate the same additive `RegistryEntry.gateFlags: string[]`, and the promoter
 * refuses to auto-serve any winner whose gateFlags is non-empty — so the two issues add checks
 * without re-threading each other's fields.
 */

export interface ScoutGateConfig {
  /** Task types where a top score is implausible for a small trending model (universal local gaps). */
  hardTaskTypes: string[];
  /** A per-hard-type score at/above this counts as "implausibly high". */
  suspiciousScore: number;
  /** Flag when at least this many hard task types are implausibly high at once. */
  minSuspiciousHardTypes: number;
  /** Repo-name patterns that advertise benchmark-gaming / marketing claims. */
  nameTells: ReadonlyArray<RegExp>;
  /** #158: probe error rate at/above this flags the candidate as misconfigured/broken (not served). */
  maxErrorRate: number;
  /** #158: empty assistant-content rate at/above this blocks unattended serving. */
  maxEmptyOutputRate: number;
  /** #158: finish_reason=length rate at/above this blocks unattended serving. */
  maxTruncationRate: number;
  /** #158: minimum seeded-bug recall required for unattended serving. */
  minReviewRecall: number;
  /** #158: minimum finding precision required for unattended serving. */
  minReviewPrecision: number;
  /** #158: maximum clean-control confabulation rate allowed for unattended serving. */
  maxReviewCleanConfabulationRate: number;
}

/**
 * Curated name gaming-tells. Precise on purpose — a noisy flag humans learn to ignore is worse than
 * no flag. Deliberately EXCLUDES broad legit descriptors like "agentic"/"instruct". The incident
 * name trips composer + fable + multiplier + tau2 (redundantly); a clean id like
 * "Qwen3-Coder-Next-80B-Instruct" or "Mixtral-8x7B" trips none (the multiplier guard requires a
 * word boundary after `x`, so MoE notation like `8x7b` does not match).
 */
export const GAMING_NAME_TELLS: ReadonlyArray<RegExp> = [
  /\bcomposer/i, // no trailing \b: must still match "composer2.5" (digit right after)
  /\bfable\d*\b/i,
  /\b\d+(?:\.\d+)?x\b/i, // multiplier / speedup / "3.5x" claims
  /τ²|\btau-?2\b/i, // τ²-bench
  /\b(?:swe-?bench|mmlu|gsm8k|humaneval|mbpp|bfcl|livecodebench|aime)\b/i, // named benchmarks
];

export const DEFAULT_SCOUT_GATE_CONFIG: ScoutGateConfig = {
  hardTaskTypes: ["sql", "code-review", "reason-hard"],
  suspiciousScore: 0.95,
  minSuspiciousHardTypes: 2,
  nameTells: GAMING_NAME_TELLS,
  maxErrorRate: 0.2,
  maxEmptyOutputRate: 0.2,
  maxTruncationRate: 0.2,
  minReviewRecall: 0.5,
  minReviewPrecision: 0.75,
  maxReviewCleanConfabulationRate: 0.25,
};

/** Env-driven override of the gate config (used by the scout + promoter scripts). */
export function loadScoutGateConfig(env: NodeJS.ProcessEnv = process.env): ScoutGateConfig {
  const hard = env["SCOUT_HARD_TASK_TYPES"];
  const hardTaskTypes = hard
    ? hard.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SCOUT_GATE_CONFIG.hardTaskTypes;
  // Invalid / out-of-range env values fall back to the default — a config typo must NEVER silently
  // disable the gate (a NaN threshold never trips) or flood it (minHardTypes=0 flags everything).
  const boundedFloat = (v: string | undefined, def: number, loExcl: number, hiIncl: number): number => {
    if (v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) && n > loExcl && n <= hiIncl ? n : def;
  };
  const boundedInt = (v: string | undefined, def: number, lo: number, hi: number): number => {
    if (v === undefined) return def;
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : def;
  };
  const boundedInclusiveFloat = (v: string | undefined, def: number, lo: number, hi: number): number => {
    if (v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : def;
  };
  return {
    hardTaskTypes,
    suspiciousScore: boundedFloat(env["SCOUT_SUSPICIOUS_SCORE"], DEFAULT_SCOUT_GATE_CONFIG.suspiciousScore, 0, 1),
    minSuspiciousHardTypes: boundedInt(
      env["SCOUT_SUSPICIOUS_MIN_HARD_TYPES"],
      DEFAULT_SCOUT_GATE_CONFIG.minSuspiciousHardTypes,
      1,
      hardTaskTypes.length
    ),
    nameTells: DEFAULT_SCOUT_GATE_CONFIG.nameTells,
    maxErrorRate: boundedFloat(env["SCOUT_MAX_ERROR_RATE"], DEFAULT_SCOUT_GATE_CONFIG.maxErrorRate, 0, 1),
    maxEmptyOutputRate: boundedFloat(
      env["SCOUT_MAX_EMPTY_OUTPUT_RATE"],
      DEFAULT_SCOUT_GATE_CONFIG.maxEmptyOutputRate,
      0,
      1
    ),
    maxTruncationRate: boundedFloat(
      env["SCOUT_MAX_TRUNCATION_RATE"],
      DEFAULT_SCOUT_GATE_CONFIG.maxTruncationRate,
      0,
      1
    ),
    minReviewRecall: boundedFloat(
      env["SCOUT_MIN_REVIEW_RECALL"],
      DEFAULT_SCOUT_GATE_CONFIG.minReviewRecall,
      0,
      1
    ),
    minReviewPrecision: boundedFloat(
      env["SCOUT_MIN_REVIEW_PRECISION"],
      DEFAULT_SCOUT_GATE_CONFIG.minReviewPrecision,
      0,
      1
    ),
    maxReviewCleanConfabulationRate: boundedInclusiveFloat(
      env["SCOUT_MAX_REVIEW_CLEAN_CONFABULATION_RATE"],
      DEFAULT_SCOUT_GATE_CONFIG.maxReviewCleanConfabulationRate,
      0,
      1
    ),
  };
}

/**
 * Hard task types the candidate scored implausibly high on. Returns a flag string listing them only
 * when at least `minSuspiciousHardTypes` cross the threshold — one lucky single-probe pass is not
 * enough; simultaneous perfection on multiple universal-gap types is the gaming signal.
 */
export function plausibilityFlags(
  scoresByTaskType: Record<string, number>,
  cfg: ScoutGateConfig = DEFAULT_SCOUT_GATE_CONFIG
): string[] {
  const hits: string[] = [];
  for (const t of cfg.hardTaskTypes) {
    const score = scoresByTaskType[t];
    if (typeof score === "number" && score >= cfg.suspiciousScore) hits.push(`${t}=${score}`);
  }
  if (hits.length >= cfg.minSuspiciousHardTypes) {
    return [`implausible-capability: perfect on hard types [${hits.join(", ")}] — likely benchmark-gamed, review before serving`];
  }
  return [];
}

/** Gaming-tell substrings present in the model id (the served name should never advertise a benchmark). */
export function nameTellFlags(id: string, cfg: ScoutGateConfig = DEFAULT_SCOUT_GATE_CONFIG): string[] {
  const base = id.split("/").pop() ?? id;
  const matched = cfg.nameTells
    .map((re) => base.match(re)?.[0])
    .filter((m): m is string => typeof m === "string");
  if (matched.length === 0) return [];
  // de-dup while preserving order
  const uniq = [...new Set(matched.map((m) => m.toLowerCase()))];
  return [`name-gaming-tell: ${uniq.join(", ")} — benchmark/marketing claim in the model name`];
}

/**
 * #158 promotion-misconfig gate: flag a candidate whose HTTP/verifier error, empty-output, or
 * finish_reason=length rate is too high to auto-serve. A model can clear the
 * passRate bar while still erroring on a concerning fraction of probes (e.g. gpt-oss's harmony-500s,
 * or a model that returns empty under the production token budget), which is a serving/config problem,
 * not a capability one. Populates the SAME `gateFlags` field as the #176 checks so they compose.
 */
export function misconfigFlags(
  summary: {
    error: number;
    totalRuns: number;
    emptyOutputs?: number;
    truncations?: number;
  },
  cfg: ScoutGateConfig = DEFAULT_SCOUT_GATE_CONFIG
): string[] {
  if (summary.totalRuns <= 0) return [];
  const flags: string[] = [];
  const checks: Array<{
    count: number;
    threshold: number;
    name: string;
    description: string;
  }> = [
    { count: summary.error, threshold: cfg.maxErrorRate, name: "high-error-rate", description: "errored" },
    {
      count: summary.emptyOutputs ?? 0,
      threshold: cfg.maxEmptyOutputRate,
      name: "high-empty-output-rate",
      description: "returned empty output",
    },
    {
      count: summary.truncations ?? 0,
      threshold: cfg.maxTruncationRate,
      name: "high-truncation-rate",
      description: "ended with finish_reason=length",
    },
  ];
  for (const check of checks) {
    const rate = check.count / summary.totalRuns;
    if (rate >= check.threshold) {
      flags.push(
        `${check.name}: ${check.count}/${summary.totalRuns} probes ${check.description} (${(rate * 100).toFixed(0)}%) — model likely misconfigured/budget-starved, not auto-served`
      );
    }
  }
  return flags;
}

/**
 * #158 ground-truth review gate. Overall scout pass-rate cannot protect this lane: review is only
 * part of the battery, so a model that finds zero seeded bugs can still clear the global winner
 * threshold by passing unrelated probes. Keep the three dimensions separate and hold weak review
 * evidence for human inspection instead of hiding it inside one aggregate score.
 */
export function reviewQualityFlags(
  summary: {
    recall: number;
    precision: number;
    cleanConfabulationRate: number;
  },
  cfg: ScoutGateConfig = DEFAULT_SCOUT_GATE_CONFIG
): string[] {
  const flags: string[] = [];
  if (summary.recall < cfg.minReviewRecall) {
    flags.push(
      `low-review-recall: ${(summary.recall * 100).toFixed(1)}% < ${(cfg.minReviewRecall * 100).toFixed(1)}% — seeded bugs are missed, not auto-served`
    );
  }
  if (summary.precision < cfg.minReviewPrecision) {
    flags.push(
      `low-review-precision: ${(summary.precision * 100).toFixed(1)}% < ${(cfg.minReviewPrecision * 100).toFixed(1)}% — findings are too noisy, not auto-served`
    );
  }
  if (summary.cleanConfabulationRate > cfg.maxReviewCleanConfabulationRate) {
    flags.push(
      `high-review-clean-confabulation: ${(summary.cleanConfabulationRate * 100).toFixed(1)}% > ${(cfg.maxReviewCleanConfabulationRate * 100).toFixed(1)}% — clean controls are accused, not auto-served`
    );
  }
  return flags;
}

/**
 * #12 promotion serving-config gate: a row must record the EXACT serving parameters (context
 * length, repeats, and — when known — gpu-layers/flash-attention) used to produce its probe
 * evidence, or the promoter cannot vouch that "passed the battery" and "will behave the same way
 * once served" are the same claim. A legacy row, a hand-written row, or any writer that skips this
 * bookkeeping is held for manual review — the same pattern as the #158 missing-review-ground-truth
 * fallback in promote-model.ts's partitionServableWinners.
 */
export function servingConfigFlags(entry: {
  evalServingConfig?: { ctx: number; repeats: number; ngl?: number; flashAttn?: string } | undefined;
}): string[] {
  const cfg = entry.evalServingConfig;
  const valid =
    cfg !== undefined &&
    typeof cfg.ctx === "number" &&
    Number.isFinite(cfg.ctx) &&
    cfg.ctx > 0 &&
    typeof cfg.repeats === "number" &&
    Number.isFinite(cfg.repeats) &&
    cfg.repeats > 0;
  if (!valid) {
    return [
      "missing-serving-config: no exact eval serving configuration (ctx/repeats) recorded — cannot verify what configuration was actually tested, not auto-served",
    ];
  }
  return [];
}

export interface GateResult {
  /** True when nothing tripped — safe to auto-serve. */
  autoServable: boolean;
  /** Human-readable reasons the candidate was gated (empty ⇒ clean). */
  flags: string[];
}

/**
 * Evaluate the full auto-serve gate for a candidate. A "winner" (met the probe thresholds) is only
 * auto-servable when this returns `autoServable: true`. Any flag routes it to human review instead.
 */
export function evaluateScoutGate(
  entry: { id: string; scoresByTaskType: Record<string, number> },
  cfg: ScoutGateConfig = DEFAULT_SCOUT_GATE_CONFIG
): GateResult {
  const flags = [...plausibilityFlags(entry.scoresByTaskType, cfg), ...nameTellFlags(entry.id, cfg)];
  return { autoServable: flags.length === 0, flags };
}

/**
 * Strip gaming/marketing tell tokens from a raw model name so the SERVED llama-swap key (and the
 * portal id) never advertises a benchmark, even if a human manually promotes a flagged candidate.
 * Applied BEFORE kebab-casing in deriveModelKey. May return "" when the name is ALL tells — the
 * caller (deriveModelKey) maps an empty result to the neutral "model" key. We deliberately do NOT
 * fall back to the raw name: the served id must never advertise a benchmark/marketing tell, even for
 * a manually-promoted candidate.
 */
export function sanitizeModelName(name: string): string {
  let s = name;
  for (const re of GAMING_NAME_TELLS) s = s.replace(new RegExp(re.source, "gi"), " ");
  return s.replace(/[\s._-]+/g, " ").trim();
}
