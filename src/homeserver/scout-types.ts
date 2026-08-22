/**
 * scout-types.ts — frozen type contract for the model-evaluation evidence registry.
 *
 * The filename is retained for compatibility with existing evidence rows and imports. The
 * registry is now populated only by explicitly requested evaluation runs; no discovery scheduler
 * or automatic roster mutator consumes this contract.
 */

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

export type EvaluationVerdict = "winner" | "interesting" | "skip" | "load_failed";
/** Compatibility alias for older callers and historical registry tooling. */
export type ScoutVerdict = EvaluationVerdict;

/** One durable line in the historical model-evaluation registry. */
export interface RegistryEntry {
  id: string; // operator-supplied durable model id
  quant: string; // evaluated quant tag
  sizeGB: number;
  evaluatedAt: string; // ISO timestamp
  verdict: ScoutVerdict;
  passRate: number; // overall, in [0,1]
  avgTokPerSec: number | null;
  scoresByTaskType: Record<string, number>; // taskType -> passRate [0,1]
  /** Probe-run reliability summary (#158), persisted for later evidence review. */
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
  /**
   * #12: exact corpus/probe-battery identity used for THIS evaluation. Lets a durable row be
   * matched back to the precise probe set (prompts, seeded-bug expectations, verifiers) that
   * produced it, independent of code-comment references that can drift from what actually ran.
   */
  probeBatteryVersion?: string;
  corpusFingerprint?: string;
  /**
   * #12: exact ephemeral serving configuration used to produce this row's probe evidence. A row
   * missing this cannot be vouched for as "tested under a known configuration" — see
   * scout-gate.ts servingConfigFlags.
   */
  evalServingConfig?: {
    ctx: number;
    repeats: number;
    ngl?: number;
    flashAttn?: string;
  };
  /** Always false for the manual evaluator; retained for historical adopted rows. */
  served: boolean;
  /** Legacy roster-adoption metadata, retained only so historical rows remain readable. */
  configKey?: string;
  ggufDir?: string;
  ggufPath?: string;
  sharded?: boolean;
  /** Legacy discovery metadata; new manual rows omit these fields. */
  trendingScore?: number;
  downloads?: number;
  likes?: number;
  notes?: string;
  /**
   * Evaluation gate flags (#176/#158). Flags describe evidence requiring human review; they never
   * authorize a roster mutation.
   */
  gateFlags?: string[];
}
