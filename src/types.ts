// ─── Task definitions ────────────────────────────────────────────────────────

export type TaskCategory =
  | "simple-coding"
  | "refactoring"
  | "architecture"
  | "debugging"
  | "multi-file"
  | "reasoning"
  | "non-coding"
  // Analysis-only sentinel for runs whose task_id is not in the task registry.
  // NEVER a valid task-definition category (excluded from VALID_CATEGORIES) —
  // it exists so unregistered task_ids surface honestly instead of being
  // silently mislabeled as "non-coding" (see analysis/stats.ts).
  | "unknown";

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;

export interface HiddenTest {
  input: string;
  expectedOutput: string;
  description: string;
}

export interface TaskDefinition {
  id: string;
  category: TaskCategory;
  title: string;
  prompt: string;
  systemPrompt?: string;
  expectedCapabilities: string[];
  difficulty: DifficultyLevel;
  tags: string[];
  maxTokens: number;
  hiddenTests?: HiddenTest[];
}

// ─── Model registry ──────────────────────────────────────────────────────────

export interface ModelSpec {
  /** OpenRouter model ID, e.g. "qwen/qwen3-14b" */
  id: string;
  shortName: string;
  family: string;
  parametersBillions: number;
  quantizationNote?: string;
  /** USD per million input tokens (OpenRouter pricing) */
  openRouterPricePerMInputToken: number;
  /** USD per million output tokens (OpenRouter pricing) */
  openRouterPricePerMOutputToken: number;
  /** Maximum context length (prompt + completion) supported by this model on OpenRouter */
  contextLength: number;
  /** Estimated tokens/sec on M4 Max 128 GB (unified memory) */
  estimatedTokPerSec128GB?: number;
  /** Estimated tokens/sec on M3 Ultra 256 GB (unified memory) */
  estimatedTokPerSec256GB?: number;
  fitsIn128GB: boolean;
  fitsIn256GB: boolean;
}

// ─── Run records ─────────────────────────────────────────────────────────────

export type RunStatus = "pending" | "completed" | "failed";

export interface RunRecord {
  id: string;
  batchId: string;
  taskId: string;
  modelId: string;
  status: RunStatus;
  prompt: string;
  response?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  costUsd?: number;
  provider?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

// ─── Judge records ───────────────────────────────────────────────────────────

export type JudgeModel = "anthropic/claude-opus-4-5" | "openai/o4-mini";

export type ScoreLevel = "fail" | "acceptable" | "good";

export interface JudgeScores {
  correctness: ScoreLevel;
  completeness: ScoreLevel;
  quality: ScoreLevel;
}

export interface JudgeRecord {
  id: string;
  runId: string;
  judgeModel: JudgeModel;
  scores: JudgeScores;
  rationale: string;
  flaggedForReview: boolean;
  createdAt: string;
}

// ─── Analysis / aggregation ──────────────────────────────────────────────────

export type ScoresByCategory = Partial<Record<TaskCategory, JudgeScores[]>>;
export type ScoresByDifficulty = Partial<Record<DifficultyLevel, JudgeScores[]>>;

export interface ModelAggregate {
  modelId: string;
  shortName: string;
  taskCount: number;
  scoresByCategory: ScoresByCategory;
  scoresByDifficulty: ScoresByDifficulty;
  totalCostUsd: number;
  avgTokensPerTask: number;
}
