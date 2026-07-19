// ─── Sub-task definitions ─────────────────────────────────────────────────────

export interface SubTaskDefinition {
  /** Unique ID within the compound task, e.g. "ct-001-a" */
  id: string;
  /** Human-readable label */
  title: string;
  /**
   * Prompt template. May include {{PREVIOUS_OUTPUT}} or named references like
   * {{SUB_A_OUTPUT}} which will be replaced with actual sub-task outputs before
   * the call is made.
   */
  promptTemplate: string;
  /** Optional system prompt override for this sub-task */
  systemPrompt?: string;
  /** Max tokens for this sub-task's response */
  maxTokens: number;
  /** Names of sub-task IDs whose outputs this sub-task depends on */
  dependsOn?: string[];
}

// ─── Compound task definitions ────────────────────────────────────────────────

export interface CompoundTaskDefinition {
  /** Unique ID, e.g. "ct-001" */
  id: string;
  title: string;
  /**
   * Human-readable description of the overall goal.
   * This is what gets stored as `prompt` in the shadow runs table so the judge
   * sees what was asked for.
   */
  description: string;
  subTasks: SubTaskDefinition[];
  /**
   * Synthesis prompt template. Will have all sub-task outputs injected via
   * {{<subtask-id>_OUTPUT}} placeholders (uppercase, dashes → underscores).
   * The synthesized result is the final output that gets judged.
   */
  synthesisPromptTemplate: string;
  synthesisSystemPrompt?: string;
  synthesisMaxTokens: number;
}

// ─── Strategy configs ─────────────────────────────────────────────────────────

export type ProviderType = "openrouter" | "local";

export interface ModelConfig {
  /** Model ID to pass to the inference function */
  modelId: string;
  /** Which provider to call */
  provider: ProviderType;
}

export interface StrategyConfig {
  /**
   * Short identifier, e.g. "cloud-only", "hybrid", "fully-local"
   */
  id: string;
  label: string;
  /** Model used for orchestration / synthesis calls */
  orchestratorModel: ModelConfig;
  /** Model used for sub-task execution */
  executionModel: ModelConfig;
}

// ─── Sub-task results ─────────────────────────────────────────────────────────

export interface SubTaskResult {
  subTaskId: string;
  ok: boolean;
  output: string;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  costUsd: number;
  errorMessage?: string;
}

// ─── Orchestration run records ────────────────────────────────────────────────

export type OrchestrationRunStatus = "pending" | "running" | "completed" | "failed";

export interface OrchestrationRunRecord {
  id: string;
  batchId: string;
  compoundTaskId: string;
  strategyId: string;
  orchestratorModel: string;
  executionModel: string;
  status: OrchestrationRunStatus;
  finalOutput?: string;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  subTaskResultsJson: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  /** ID of the shadow run inserted into the runs table for judge compatibility */
  shadowRunId?: string;
}
