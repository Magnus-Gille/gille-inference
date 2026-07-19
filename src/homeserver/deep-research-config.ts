import { loadEnv } from "../env.js";
import type { BrainMode } from "./deep-research-types.js";

/**
 * Action-protocol dialect for the model-driven ReAct loop.
 * - `generic`: the harness's own `{"action":"search|read|reflect|answer",...}` JSON-per-turn protocol.
 * - `tongyi`: Tongyi-DeepResearch-30B-A3B's NATIVE in-text format — `<tool_call>{name,arguments}</tool_call>`
 *   actions (`search`/`visit` tools), `<answer>…</answer>` final answer, `<tool_response>…</tool_response>`
 *   observations. This is the format the model was RL-trained on (verified from the owner's inference code).
 */
export type AgentDialect = "generic" | "tongyi";

/**
 * Deep-research harness configuration (env-driven, mirrors `config.ts`).
 *
 * Defaults are tuned to the live M5 (docs/deep-research-harness-design.md §1b/§4c, validated
 * 2026-06-20): the box has ~64 GB fast VRAM, NO Docker, and already serves `mellum`,
 * `qwen3-coder-next-80b`, `qwen35-a3b`, `gemma4` behind llama-swap. Cartography measured
 * `mellum` = 100% on summarize/extract at 138 t/s (→ distiller) and `qwen3-coder-next-80b`
 * = best generalist (→ planner/synthesizer). Tongyi-DR-30B-A3B is the Phase-0 upgrade for
 * the plan/gap/synth roles; until it is pulled, these defaults run the MVP end-to-end.
 */

export interface DeepResearchConfig {
  // ── Model role assignment (see §4c) ──
  /** PLAN + GAP brain. Default: the box's best generalist. Upgrade target: tongyi-dr. */
  plannerModel: string;
  /** Per-source DISTILL extractor (high volume). Default: mellum (100% summarize @138 t/s). */
  distillModel: string;
  /** SYNTHESIS + popular-summary model (quality-critical). */
  synthModel: string;
  /** Contradiction-resolution model; empty → reuse plannerModel. */
  verifyModel: string;

  // ── Brain mode (§5) ──
  /** `local` (sovereign default) or `hybrid` (frontier API for plan+synth only). */
  brain: BrainMode;

  // ── Per-role sampling (the 2026-06-20 follow-up: reasoning MoEs degenerate-loop at temp 0 and
  //    blank when their reasoning_content overruns a tight token budget). Defaults preserve the
  //    historical behavior (temp 0, no floor) for the non-thinking mellum/80b-coder roster. ──
  /** Temperature for PLAN + GAP calls (0 = deterministic, right for non-thinking models). */
  plannerTemp: number;
  /** Temperature for the DISTILL call. */
  distillTemp: number;
  /** Temperature for SYNTHESIS + popular-summary calls. */
  synthTemp: number;
  /** Min max_tokens floor for PLAN/GAP (reasoning models need room before they emit `content`). */
  plannerMinTokens: number;
  /** Min max_tokens floor for DISTILL. */
  distillMinTokens: number;
  /** Min max_tokens floor for SYNTHESIS/popular. */
  synthMinTokens: number;

  // ── Synthesis strategy (the 2026-06-21 grounding-repair win) ──
  /** `oneshot` (one synth call, historical default) or `reground` (synth → deterministic
   *  report-sentence verify → feed the UNSUPPORTED sentences back to the model to re-ground or
   *  remove). The harness uses its own citation verifier to drive a bounded model repair — pure
   *  harness intelligence, targeting the judged citation_quality weakness. */
  synthStrategy: "oneshot" | "reground";
  /** Max grounding-repair rounds when synthStrategy=reground (each round = 1 synth call). */
  synthRepairRounds: number;
  /** Atomic-sentence discipline: instruct the synthesizer to write ONE checkable claim per sentence
   *  and cite every contributing source. Orthogonal to synthStrategy (composes with reground). The
   *  biggest single grounding lever measured (the coder's failure was long recombined sentences):
   *  80b report-sentence support 3% → ~58% at 1 call. Default off (behavior-preserving). */
  synthAtomic: boolean;

  // ── Local model gateway (every local call routes here; §6b) ──
  /** OpenAI-compatible base for local calls. Gateway (:8080, metered) by default; an on-box
   *  internal run may point straight at llama-swap (:8091) to skip auth. */
  gatewayUrl: string;
  /** Bearer key for the gateway (empty when pointing at an unauthed llama-swap). */
  gatewayApiKey: string;

  // ── Hybrid brain (only used when brain === "hybrid" or a SENSITIVE flag is absent) ──
  hybridBaseUrl: string;
  hybridApiKey: string;
  /** Frontier model for the PLAN stage in hybrid mode. */
  hybridPlanModel: string;
  /** Frontier model for the SYNTHESIS stage in hybrid mode. */
  hybridSynthModel: string;

  // ── Loop budgets (the deterministic intelligence; §3) ──
  /** Gap-loop iteration budget. Default 3 (local-deep-researcher's IterDRAG default). */
  maxIters: number;
  /** Max NEW sources fetched+distilled per iteration (bounds wall-clock + tokens). */
  maxSourcesPerIter: number;
  /** Max search queries issued per iteration. */
  maxQueriesPerIter: number;
  /** Hits requested per query from the search provider. */
  resultsPerQuery: number;
  /** Truncate a fetched page to this many chars before the distill call (KV/latency guard). */
  distillMaxChars: number;

  // ── Search providers (§4b) ──
  searchProvider: string;
  searchFallbackProvider: string;
  /** SearXNG base URL (JSON API). */
  searchUrl: string;
  /** API key for Brave/Tavily fallback. */
  searchApiKey: string;
  /** Python interpreter (venv) that runs the ddgs helper. */
  ddgsPython: string;
  /** Path to scripts/ddgs_search.py (the Docker-free search shell-out). */
  ddgsScript: string;

  // ── Reader providers (§4b) ──
  readerProvider: string;
  readerFallbackProvider: string;
  /** Below this many chars of extracted main text, a page is "thin" → escalate to JS reader. */
  readerThinChars: number;
  /** Command invoked to run Trafilatura (shelled out; in-process Python lib on the box). */
  trafilaturaCmd: string;
  /** Jina Reader base (last-resort anti-bot fetch). */
  jinaBaseUrl: string;

  // ── Circuit breaker (§4b fallback) ──
  /** Consecutive provider failures before the breaker trips to the fallback. */
  breakerThreshold: number;
  /** Cooldown (ms) before a tripped provider is retried. */
  breakerCooldownMs: number;

  // ── Citation enforcement (§3/§6a) ──
  /** Min normalized similarity of a claim's quote to a source span to count as resolved. */
  citationMatchThreshold: number;
  /** Min span similarity for a REPORT SENTENCE to count as grounded in its cited source. Lower
   *  than `citationMatchThreshold` — synthesized prose paraphrases the distilled claims. Default
   *  0.45, calibrated against the 2026-06-20 live M5 dogfood (over-claims <=0.30, paraphrase >=0.43). */
  reportSentenceMatchThreshold: number;

  // ── Model-driven ReAct agent mode (the Tongyi-DR specialist path; issue #40) ──
  // ALONGSIDE the deterministic pipeline: a reasoning model drives a search/read/reflect/answer
  // loop over multiple turns, while the harness keeps hard guardrails (turn + token caps, parse-
  // failure / stall force-finalize) in code and reuses the deterministic citation verifier as the
  // trust anchor. This is the architecture Tongyi-DeepResearch-30B-A3B was RL-trained for.
  /** The single driving "brain" model for the agent loop (default tongyi-dr). */
  agentModel: string;
  /** Action-protocol dialect the loop speaks. Default `tongyi` (the agent model is tongyi-dr,
   *  which emits its native `<tool_call>`/`<answer>` format, not the harness's generic JSON). */
  agentDialect: AgentDialect;
  /** Hard cap on ReAct turns before the loop force-finalizes. */
  agentMaxTurns: number;
  /** Cumulative completion-token budget; the loop force-finalizes once it is exceeded. */
  agentTokenBudget: number;
  /** Sampling temperature for the agent brain (reasoning models loop at temp 0 → default 0.7). */
  agentTemp: number;
  /** Retries when a brain call returns a blank body (after stripping <think>). */
  agentMaxBlankRetries: number;
  /** Truncate a read page to this many chars in the READ observation (context guard). */
  agentReadCharCap: number;
  /** Auto-attribute `[S#]` citations to the agent's answer post-hoc (deterministic reverse-citation;
   *  issue #46). Tongyi-DR answers grounded-but-uncited, so the trust anchor sees 0/0 cited; this
   *  matches each substantive uncited sentence to its read source with the same hardened matcher and
   *  appends the marker (never fabricating). Default ON for the `tongyi` dialect (which doesn't
   *  self-cite), OFF for `generic` (which already self-cites). Env `RESEARCH_AGENT_AUTOCITE`
   *  ("true"/"1" / "false"/"0") overrides the dialect default explicitly. */
  agentAutoCite: boolean;

  // ── Output (§6d) ──
  /** Local working dir for run artifacts: `<outputDir>/<slug>/report.md`. */
  outputDir: string;
  /** Optional NAS dir for detailed reports (rsync target). Empty → skip. */
  mimirResearchDir: string;
  /** Optional NAS dir for popular summaries (Heimdall /read source). Empty → skip. */
  mimirReadingDir: string;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Tri-state boolean env: "true"/"1" → true, "false"/"0" → false, unset/blank → `fallback`. */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

let _drConfig: DeepResearchConfig | null = null;

export function loadDeepResearchConfig(): DeepResearchConfig {
  if (_drConfig) return _drConfig;
  loadEnv();

  const agentDialect: AgentDialect = envStr("RESEARCH_AGENT_DIALECT", "tongyi") === "generic" ? "generic" : "tongyi";

  _drConfig = {
    plannerModel: envStr("RESEARCH_PLANNER_MODEL", "qwen3-coder-next-80b"),
    distillModel: envStr("RESEARCH_DISTILL_MODEL", "mellum"),
    synthModel: envStr("RESEARCH_SYNTH_MODEL", "qwen3-coder-next-80b"),
    verifyModel: envStr("RESEARCH_VERIFY_MODEL", ""),

    brain: process.env["RESEARCH_BRAIN"] === "hybrid" ? "hybrid" : "local",

    plannerTemp: Math.max(0, envNum("RESEARCH_PLANNER_TEMP", 0)),
    distillTemp: Math.max(0, envNum("RESEARCH_DISTILL_TEMP", 0)),
    synthTemp: Math.max(0, envNum("RESEARCH_SYNTH_TEMP", 0)),
    plannerMinTokens: Math.max(0, envNum("RESEARCH_PLANNER_MIN_TOKENS", 0)),
    distillMinTokens: Math.max(0, envNum("RESEARCH_DISTILL_MIN_TOKENS", 0)),
    synthMinTokens: Math.max(0, envNum("RESEARCH_SYNTH_MIN_TOKENS", 0)),

    synthStrategy: process.env["RESEARCH_SYNTH_STRATEGY"] === "reground" ? "reground" : "oneshot",
    synthRepairRounds: Math.max(1, envNum("RESEARCH_SYNTH_REPAIR_ROUNDS", 1)),
    synthAtomic: process.env["RESEARCH_SYNTH_ATOMIC"] === "true" || process.env["RESEARCH_SYNTH_ATOMIC"] === "1",

    gatewayUrl: envStr("RESEARCH_GATEWAY_URL", "http://127.0.0.1:8080/v1").replace(/\/$/, ""),
    gatewayApiKey: envStr("RESEARCH_GATEWAY_API_KEY", ""),

    hybridBaseUrl: envStr("RESEARCH_HYBRID_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/$/, ""),
    hybridApiKey: envStr("RESEARCH_HYBRID_API_KEY", process.env["OPENROUTER_API_KEY"] ?? ""),
    hybridPlanModel: envStr("RESEARCH_HYBRID_PLAN_MODEL", "anthropic/claude-haiku-4.5"),
    hybridSynthModel: envStr("RESEARCH_HYBRID_SYNTH_MODEL", "anthropic/claude-haiku-4.5"),

    maxIters: Math.max(1, envNum("RESEARCH_MAX_ITERS", 3)),
    maxSourcesPerIter: Math.max(1, envNum("RESEARCH_MAX_SOURCES_PER_ITER", 12)),
    maxQueriesPerIter: Math.max(1, envNum("RESEARCH_MAX_QUERIES_PER_ITER", 5)),
    resultsPerQuery: Math.max(1, envNum("RESEARCH_RESULTS_PER_QUERY", 8)),
    distillMaxChars: Math.max(1000, envNum("RESEARCH_DISTILL_MAX_CHARS", 24000)),

    searchProvider: envStr("SEARCH_PROVIDER", "searxng"),
    searchFallbackProvider: envStr("SEARCH_FALLBACK_PROVIDER", "brave"),
    searchUrl: envStr("SEARCH_URL", "http://127.0.0.1:8888").replace(/\/$/, ""),
    searchApiKey: envStr("SEARCH_API_KEY", ""),
    ddgsPython: envStr("DDGS_PYTHON", "python3"),
    ddgsScript: envStr("DDGS_SCRIPT", "scripts/ddgs_search.py"),

    readerProvider: envStr("READER_PROVIDER", "trafilatura"),
    readerFallbackProvider: envStr("READER_FALLBACK_PROVIDER", "jina"),
    readerThinChars: Math.max(0, envNum("READER_THIN_CHARS", 500)),
    trafilaturaCmd: envStr("TRAFILATURA_CMD", "trafilatura"),
    jinaBaseUrl: envStr("JINA_BASE_URL", "https://r.jina.ai").replace(/\/$/, ""),

    breakerThreshold: Math.max(1, envNum("RESEARCH_BREAKER_THRESHOLD", 3)),
    breakerCooldownMs: Math.max(0, envNum("RESEARCH_BREAKER_COOLDOWN_MS", 60_000)),

    citationMatchThreshold: clamp01(envNum("RESEARCH_CITATION_THRESHOLD", 0.8)),
    reportSentenceMatchThreshold: clamp01(envNum("RESEARCH_REPORT_SENTENCE_THRESHOLD", 0.45)),

    agentModel: envStr("RESEARCH_AGENT_MODEL", "tongyi-dr"),
    agentDialect,
    agentMaxTurns: Math.max(1, envNum("RESEARCH_AGENT_MAX_TURNS", 12)),
    agentTokenBudget: Math.max(1, envNum("RESEARCH_AGENT_TOKEN_BUDGET", 60000)),
    agentTemp: Math.max(0, envNum("RESEARCH_AGENT_TEMP", 0.7)),
    agentMaxBlankRetries: Math.max(0, envNum("RESEARCH_AGENT_MAX_BLANK_RETRIES", 2)),
    agentReadCharCap: Math.max(500, envNum("RESEARCH_AGENT_READ_CHAR_CAP", 4000)),
    // Default ON for tongyi (non-citing dialect), OFF for generic (self-cites); env overrides explicitly.
    agentAutoCite: envBool("RESEARCH_AGENT_AUTOCITE", agentDialect === "tongyi"),

    outputDir: envStr("RESEARCH_OUTPUT_DIR", "./data/research"),
    mimirResearchDir: envStr("MIMIR_RESEARCH_DIR", ""),
    mimirReadingDir: envStr("MIMIR_READING_DIR", ""),
  };
  return _drConfig;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Test/CLI hook to override config (e.g. point at a fake gateway or a throwaway output dir). */
export function setDeepResearchConfig(partial: Partial<DeepResearchConfig>): DeepResearchConfig {
  const base = loadDeepResearchConfig();
  const merged = { ...base, ...partial };
  // Keep `agentAutoCite` consistent with a dialect override: switching dialect (e.g. CLI `--dialect
  // generic`) without an explicit `agentAutoCite` in the partial AND with no explicit
  // `RESEARCH_AGENT_AUTOCITE` env must re-derive the dialect default (tongyi=on / generic=off) —
  // otherwise the stale tongyi-computed default would leave generic incorrectly auto-citing.
  if (
    partial.agentDialect !== undefined &&
    partial.agentAutoCite === undefined &&
    (process.env["RESEARCH_AGENT_AUTOCITE"] ?? "") === ""
  ) {
    merged.agentAutoCite = partial.agentDialect === "tongyi";
  }
  _drConfig = merged;
  return _drConfig;
}

/** Reset the singleton — tests call this so env changes between cases are re-read. */
export function resetDeepResearchConfig(): void {
  _drConfig = null;
}
