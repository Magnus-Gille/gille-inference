/**
 * Deep-research harness — shared type contract.
 *
 * Every module in the deep-research pipeline imports from here. The design philosophy
 * (docs/deep-research-harness-design.md §1) is that the *harness* carries the long-horizon
 * intelligence: a fixed `plan → search → read → distill → verify → gap → synth → cite`
 * sequence of BOUNDED model calls, with deterministic glue (dedup, citation enforcement,
 * source-tier ranking, gap-loop budget) in code.
 *
 * The ports here (`SearchProvider`, `Reader`, `ChatFn`) are dependency-injection seams so
 * the whole pipeline is unit-testable offline with fakes — no M5, no network, no keys.
 * Adapters (SearXNG/Brave search, Trafilatura reader, the gateway OpenAI client) are wired
 * by the CLI from config.
 */

import type { DeepResearchConfig } from "./deep-research-config.js";
import type { DelegationRecord } from "./ledger.js";

// ─── Enums / unions ────────────────────────────────────────────────────────────

/** Source-hierarchy rank. Anthropic found agents bias toward SEO-optimized content over
 * authoritative sources — the harness corrects this in code, so tier is first-class. */
export type SourceTier = "primary" | "secondary" | "tertiary";

/** Run shape. `quick` ≈ Perplexity's 3–5-search bar; `thorough` runs the full gap loop. */
export type ResearchDepth = "quick" | "thorough";

/** Where the model-bound stages (plan/synth) run. `local` = sovereign default;
 * `hybrid` = a frontier API brain for plan+synth only (raw pages never leave the box). */
export type BrainMode = "local" | "hybrid";

// ─── Stage 1: search ───────────────────────────────────────────────────────────

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

/** Pluggable search provider (SearXNG primary, Brave/Tavily fallback). */
export interface SearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchHit[]>;
}

// ─── Stage 2: read ─────────────────────────────────────────────────────────────

export interface ReadResult {
  url: string;
  title?: string;
  /** Full-page clean main-text markdown (NOT a snippet) — the citation-span search space. */
  markdown: string;
  /** True when extraction produced too little main text → escalate to a JS/anti-bot reader. */
  isThin: boolean;
  /** Name of the reader adapter that produced this. */
  fetchedVia?: string;
}

/** Pluggable reader (Trafilatura primary, Crawl4AI/Jina fallback on thin/JS pages). */
export interface Reader {
  readonly name: string;
  read(url: string): Promise<ReadResult>;
}

// ─── Sources (deduped, id-assigned, tier-ranked) ────────────────────────────────

export interface Source {
  /** Stable citation id, e.g. "S1". Claims cite sources by this id. */
  id: string;
  url: string;
  title: string;
  tier: SourceTier;
  /** Full clean text — the literal span search space for deterministic citation enforcement. */
  markdown: string;
  /** Content hash for near-duplicate detection across sources. */
  contentHash: string;
}

// ─── Stage 3: distill (per-source extraction; high volume) ───────────────────────

export interface ExtractedClaim {
  /** A single, self-contained factual claim. */
  text: string;
  /** Verbatim supporting quote pulled from the source (the citation anchor). */
  quote: string;
}

export interface DistilledNote {
  sourceId: string;
  /** Model's self-tagged tier; code may override with a domain-based rank. */
  tier: SourceTier;
  claims: ExtractedClaim[];
  summary?: string;
}

// ─── Stage 4: verify / triangulate ──────────────────────────────────────────────

export type ClaimStatus = "single" | "agreed" | "disputed";

/** A claim clustered across sources. DISPUTED clusters are the lever that beats single-pass
 * systems — sources disagree and the harness surfaces it rather than silently picking one. */
export interface ClaimCluster {
  /** Canonical claim text (representative member of the cluster). */
  text: string;
  status: ClaimStatus;
  /** Sources supporting the claim. */
  sourceIds: string[];
  /** Sources contradicting it (populated when status === "disputed"). */
  disputedBy?: string[];
  quotes: { sourceId: string; quote: string }[];
}

// ─── Stage 0/5: plan & gap ──────────────────────────────────────────────────────

export interface ResearchPlan {
  subQuestions: string[];
  queries: string[];
}

export interface GapAssessment {
  /** True → coverage sufficient, stop the loop. */
  sufficient: boolean;
  gaps: string[];
  /** Fresh queries to run if not sufficient and budget remains. */
  newQueries: string[];
}

// ─── Stage 7: citation enforcement (deterministic) ──────────────────────────────

export interface ClaimCitation {
  claimText: string;
  sourceId: string;
  /** The literal span found in the source markdown (when resolved). */
  matchedSpan?: string;
  /** Similarity of the best-matching span to the claim's quote, 0..1. */
  matchRatio?: number;
}

export interface CitationCheck {
  /** Claims whose cited source contained a matching span. */
  resolved: ClaimCitation[];
  /** Claims that cited a source but no span matched → drop or bounded re-cite. */
  unresolved: ClaimCitation[];
  /** resolved / (resolved + unresolved); 1 when there are no claims. */
  precision: number;
}

// ─── Phase-2: report-sentence → cited-source verification ────────────────────────
// The MVP `CitationCheck` above verifies DISTILLED-CLAIM → source. It is blind to the
// synthesizer inventing a NEW sentence and attaching a valid [S#] marker. The check below
// verifies every cited SENTENCE of the synthesized report against its cited source's evidence.

/** One report sentence judged against the sources it cites. */
export interface SentenceCitation {
  /** The sentence with its `[S#]` markers stripped. */
  sentence: string;
  /** Source ids this sentence cites, in first-seen order. */
  citedSourceIds: string[];
  /** The cited source id whose evidence matched (only when supported). */
  supportedBy?: string;
  /** The literal evidence span that matched (only when supported). */
  matchedSpan?: string;
  /** Best span ratio across the cited sources, 0..1. */
  matchRatio: number;
}

export interface ReportCitationCheck {
  /** Cited sentences whose content was found in (at least one of) their cited sources. */
  supported: SentenceCitation[];
  /** Cited sentences found in NONE of their cited sources → likely hallucinated. */
  unsupported: SentenceCitation[];
  /** Substantive sentences carrying NO citation marker (visibility metric; not graded). */
  uncitedSentenceCount: number;
  /** supported / (supported + unsupported); 1 when no sentence carries a citation. */
  precision: number;
}

// ─── Final outputs ──────────────────────────────────────────────────────────────

export interface ReportSection {
  heading: string;
  markdown: string;
}

export interface ResearchReport {
  query: string;
  /** ISO timestamp, injected by the caller (Date.* is unavailable in some run contexts). */
  generatedAtIso: string;
  sections: ReportSection[];
  /** Disputed claim clusters, surfaced as an explicit uncertainty checklist. */
  disputed: ClaimCluster[];
  sources: Source[];
  brain: BrainMode;
  iterations: number;
  /** Distilled-claim → source citation-enforcement result. */
  citations: CitationCheck;
  /** Report-sentence → cited-source verification (Phase-2: catches synthesis over-claiming). */
  reportCitations: ReportCitationCheck;
  /** The fully-rendered detailed report (the `report.md` body). */
  markdown: string;
}

/** Simon-Willison-style 1500–2500-word accessible summary (the `~/mimir/reading/<slug>.md` body). */
export interface PopularSummary {
  title: string;
  markdown: string;
}

// ─── Model-call port (the gateway OpenAI client adapter implements this) ──────────

export interface ChatRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Stop sequences (OpenAI `stop`). Tongyi-DR uses `["\n<tool_response>", "<tool_response>"]`
   *  so generation halts before the harness-injected observation. Optional/back-compat. */
  stop?: string[];
  /** Nucleus sampling (OpenAI `top_p`). Tongyi-DR native = 0.95. Optional/back-compat. */
  topP?: number;
  /** Presence penalty (OpenAI `presence_penalty`). Tongyi-DR native = 1.1. Optional/back-compat. */
  presencePenalty?: number;
}

export interface ChatResponse {
  text: string;
  promptTokens: number;
  completionTokens: number;
  /** The model id that actually served the call (for ledger attribution). */
  model: string;
}

/** A single bounded model call. Adapters: gateway-local (default) or a frontier API (hybrid). */
export type ChatFn = (req: ChatRequest) => Promise<ChatResponse>;

/** Per-stage model clients. `planner` also serves the gap stage; `verifier` defaults to it. */
export interface StageChatFns {
  /** PLAN + GAP — the "brain" (Tongyi-DR / qwen3-coder-next-80b / API). */
  planner: ChatFn;
  /** DISTILL — per-source extractor, runs ×N at volume (mellum / Qwen3-30B-A3B). */
  distiller: ChatFn;
  /** SYNTHESIZE + POPULAR SUMMARY — quality-critical (qwen3-coder-next-80b / GPT-OSS-120B / API). */
  synthesizer: ChatFn;
  /** VERIFY — contradiction resolution. Falls back to `planner` when omitted. */
  verifier?: ChatFn;
}

// ─── Pipeline I/O ────────────────────────────────────────────────────────────────

export interface ResearchRequest {
  query: string;
  depth?: ResearchDepth;
  brain?: BrainMode;
  /** Force every stage local (full sovereignty; accept the synthesis-quality dip). */
  sensitive?: boolean;
  /** Injected wall-clock ISO so the pipeline stays deterministic-testable. */
  nowIso: string;
}

export type ResearchStage =
  | "plan"
  | "search"
  | "read"
  | "distill"
  | "verify"
  | "gap"
  | "synthesize"
  | "cite"
  | "popular"
  | "done";

export interface ResearchProgress {
  stage: ResearchStage;
  iteration: number;
  /** Free-text human-readable detail (e.g. "fetched 12/15 sources"). */
  detail: string;
}

/** Optional ledger sink — the CLI passes `recordDelegation` so each sub-step's outcome is
 * recorded per (taskType, modelId), and the ledger auto-learns which models do which roles. */
export type RecordLedgerFn = (rec: DelegationRecord) => void;

export interface ResearchDeps {
  search: SearchProvider;
  read: Reader;
  chat: StageChatFns;
  config: DeepResearchConfig;
  onProgress?: (p: ResearchProgress) => void;
  recordLedger?: RecordLedgerFn;
  /** Verbose diagnostic log sink (CLI passes console.error). */
  log?: (msg: string) => void;
}

export interface ResearchResult {
  report: ResearchReport;
  popular: PopularSummary;
  /** Stage-by-stage metrics for the build journal / dogfooding analysis. */
  stats: ResearchStats;
}

export interface ResearchStats {
  iterations: number;
  searchQueries: number;
  sourcesFetched: number;
  sourcesDistilled: number;
  claimsExtracted: number;
  claimsDisputed: number;
  /** Distilled-claim → source citation precision (the MVP gate). */
  citationPrecision: number;
  /** Report-sentence → cited-source support precision (Phase-2 hallucination gate). */
  reportSentencePrecision: number;
  /** Total completion tokens across all model calls (cost/throughput proxy). */
  totalCompletionTokens: number;
  /** Per-stage model-call counts, for spotting the expensive stages. */
  modelCalls: Record<string, number>;
}
