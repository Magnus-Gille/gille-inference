import type { StrategyConfig } from "./types.js";

/**
 * Strategy A: Cloud-Only
 * Orchestrator and sub-task executor both run via OpenRouter.
 * This is the baseline — full API cost but maximum quality.
 */
export const STRATEGY_CLOUD_ONLY: StrategyConfig = {
  id: "cloud-only",
  label: "Cloud-Only (Opus orchestrates Sonnet)",
  orchestratorModel: {
    modelId: "anthropic/claude-opus-4-5",
    provider: "openrouter",
  },
  executionModel: {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "openrouter",
  },
};

/**
 * Strategy B-1: Hybrid with Gemma4-26B
 * Opus orchestrates via OpenRouter; sub-tasks run on local Gemma4-26B.
 * Orchestrator cost only — execution is free.
 */
export const STRATEGY_HYBRID_GEMMA4: StrategyConfig = {
  id: "hybrid-gemma4",
  label: "Hybrid (Opus orchestrates local Gemma4-26B)",
  orchestratorModel: {
    modelId: "anthropic/claude-opus-4-5",
    provider: "openrouter",
  },
  executionModel: {
    modelId: "gemma4:26b",
    provider: "local",
  },
};

/**
 * Strategy B-2: Hybrid with Qwen3.5-35B
 * Opus orchestrates via OpenRouter; sub-tasks run on local Qwen3.5.
 */
export const STRATEGY_HYBRID_QWEN35: StrategyConfig = {
  id: "hybrid-qwen35",
  label: "Hybrid (Opus orchestrates local Qwen3.5-35B)",
  orchestratorModel: {
    modelId: "anthropic/claude-opus-4-5",
    provider: "openrouter",
  },
  executionModel: {
    modelId: "qwen3.5:35b-a3b",
    provider: "local",
  },
};

/**
 * Strategy C: Fully Local
 * Both orchestrator and sub-task executor run on local Gemma4-26B.
 * Zero API cost — tests whether a local model can handle synthesis too.
 */
export const STRATEGY_FULLY_LOCAL: StrategyConfig = {
  id: "fully-local",
  label: "Fully Local (Gemma4-26B orchestrates and executes)",
  orchestratorModel: {
    modelId: "gemma4:26b",
    provider: "local",
  },
  executionModel: {
    modelId: "gemma4:26b",
    provider: "local",
  },
};

export const ALL_STRATEGIES: StrategyConfig[] = [
  STRATEGY_CLOUD_ONLY,
  STRATEGY_HYBRID_GEMMA4,
  STRATEGY_HYBRID_QWEN35,
  STRATEGY_FULLY_LOCAL,
];

export function getStrategyById(id: string): StrategyConfig | undefined {
  return ALL_STRATEGIES.find((s) => s.id === id);
}
