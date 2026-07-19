/**
 * scout-types.ts — frozen type contract for the weekly Model Scout (Job A).
 *
 * Shared by hf-trending.ts (discovery), probe-runner.ts (benchmark), model-registry.ts
 * (durable record), weekly-model-scout.ts (orchestrator), promote-model.ts (auto-serve), and
 * post-model-scout-panels.ts (Heimdall). Mirrors the gate-e-types.ts "frozen contract" pattern:
 * these shapes are the integration boundary — keep them stable.
 */

// ── Discovery (HuggingFace trending) ────────────────────────────────────────────────

/** A trending model row from the HF `?sort=trendingScore` API (subset we use). */
export interface TrendingModel {
  id: string; // "org/name"
  downloads: number;
  likes: number;
  trendingScore: number;
}

/** One GGUF file in a repo, with its (best-known) size + parsed quant label. */
export interface GgufFile {
  rfilename: string; // e.g. "Model-Q4_K_M.gguf"
  sizeBytes: number | null; // null when the size is unknown (HEAD failed / not in siblings)
  quant: string; // parsed quant tag, e.g. "Q4_K_M" / "Q3_K_S" / "IQ4_XS"; "" if unparseable
}

/** A chosen quant for a candidate: the file plus its size in GiB and a fit verdict. */
export interface QuantPick {
  file: GgufFile; // the (first) file of the chosen quant group
  sizeGB: number; // total sizeBytes / 1024^3 (summed over shards), rounded to 2dp
  parts: string[]; // ordered remote rfilenames of the chosen group — [single] when not sharded.
  //                  The DEFINITIVE shard list, so callers never re-derive (avoids cross-group mixups).
}

// ── Benchmark (probe-runner) ────────────────────────────────────────────────────────

/** Per (probe, repeat) outcome from running the probe battery against one endpoint. */
export interface ProbeRunResult {
  probeId: string;
  taskType: string;
  verifierName: string;
  repeat: number;
  outcome: string; // pass | partial | fail | error | unverified
  score: number | null;
  latencyMs: number | null;
  tokPerSec: number | null;
  notes: string | null;
  /** OpenAI-compatible terminal reason; null when the backend omitted it or the call errored. */
  finishReason?: string | null;
  /** True when the assistant content was empty after trimming. */
  emptyOutput?: boolean;
  /** True when finish_reason says generation stopped at the token limit. */
  truncated?: boolean;
  /** Sufficient statistics emitted only by reviewGroundTruth probes. */
  reviewMetrics?: {
    expectedFindings: number;
    truePositives: number;
    reportedFindings: number;
    cleanControl: boolean;
    cleanConfabulated: boolean;
  };
}

/** Per-task-type roll-up across all probes+repeats of that task type. */
export interface TaskTypeScore {
  taskType: string;
  attempts: number; // total runs (incl. errors)
  passes: number;
  partials: number;
  fails: number;
  errors: number;
  passRate: number; // passes / attempts, in [0,1]; 0 when attempts === 0
}

/** Full result of benchmarking one model at one endpoint. */
export interface ProbeRunSummary {
  model: string;
  endpoint: string;
  totalRuns: number;
  pass: number;
  partial: number;
  fail: number;
  error: number;
  passRate: number; // overall passes / totalRuns, in [0,1]
  avgTokPerSec: number | null;
  emptyOutputs: number;
  truncations: number;
  /** Terminal finish-reason distribution for successful HTTP calls (`missing` when omitted). */
  finishReasons: Record<string, number>;
  reviewMetrics?: {
    seededBugs: number;
    truePositives: number;
    reportedFindings: number;
    cleanControls: number;
    confabulatedCleanControls: number;
    recall: number;
    precision: number;
    cleanConfabulationRate: number;
  };
  byTaskType: TaskTypeScore[];
  results: ProbeRunResult[];
}

// ── Verdict + durable registry ──────────────────────────────────────────────────────

export type ScoutVerdict = "winner" | "interesting" | "skip" | "load_failed";

/** One durable line in data/model-scout-registry.jsonl — every model ever evaluated. */
export interface RegistryEntry {
  id: string; // HF "org/name"
  quant: string; // chosen quant tag
  sizeGB: number;
  evaluatedAt: string; // ISO timestamp
  verdict: ScoutVerdict;
  passRate: number; // overall, in [0,1]
  avgTokPerSec: number | null;
  scoresByTaskType: Record<string, number>; // taskType -> passRate [0,1]
  /** Probe-run reliability summary (#158), persisted so promote-model can recompute the misconfig gate. */
  probeErrors?: number;
  probeTotalRuns?: number;
  probeErrorRate?: number; // probeErrors / probeTotalRuns, in [0,1]
  probeEmptyOutputs?: number;
  probeEmptyOutputRate?: number;
  probeTruncations?: number;
  probeTruncationRate?: number;
  probeFinishReasons?: Record<string, number>;
  /** Ground-truth reviewer evidence (#158); deliberately separate from code-review passRate. */
  codeReviewSeededBugs?: number;
  codeReviewTruePositives?: number;
  codeReviewReportedFindings?: number;
  codeReviewCleanControls?: number;
  codeReviewConfabulatedCleanControls?: number;
  codeReviewRecall?: number;
  codeReviewPrecision?: number;
  codeReviewCleanConfabulationRate?: number;
  served: boolean; // promoted into live llama-swap?
  configKey?: string; // llama-swap config entry id, if promoted
  ggufDir?: string; // absolute path to the per-model dir holding ALL local GGUF parts (scratch, then models dir)
  ggufPath?: string; // absolute path to part 1 inside ggufDir (what llama-server -m points at)
  sharded?: boolean; // true if the GGUF is multi-part (ggufPath points at part 1)
  trendingScore?: number;
  downloads?: number;
  likes?: number;
  notes?: string;
  /**
   * Auto-serve gate flags (#176). Empty/absent ⇒ nothing tripped, a winner may auto-promote. Any
   * flag (benchmark-gamed capability plausibility, name gaming-tell, or #158 promotion-misconfig)
   * means the promoter must NOT auto-serve it — a human reviews and promotes manually. Shared field
   * so #176's and #158's gates compose without re-threading each other's data.
   */
  gateFlags?: string[];
}
