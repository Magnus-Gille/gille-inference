import { getModelById } from "../runner/models.js";

/**
 * Token price catalog for delegation savings accounting.
 *
 * Values are USD per 1M tokens. The catalog is deliberately versioned and
 * snapshot-like: historical savings rows should be reproducible even after a
 * vendor changes prices. Refresh this file intentionally when pricing changes.
 */

export interface ModelTokenPrice {
  modelId: string;
  provider: "anthropic" | "openai" | "openrouter" | "local" | "unknown";
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  source: string;
  note?: string;
}

export const DEFAULT_COST_CATALOG_VERSION = "2026-07-08";

export const DEFAULT_PREMIUM_BASELINE_MODEL_ID = "claude-fable-5";

export const DEFAULT_MODEL_TOKEN_PRICES: readonly ModelTokenPrice[] = [
  {
    modelId: "claude-fable-5",
    provider: "anthropic",
    inputUsdPerMTok: 10,
    outputUsdPerMTok: 50,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "claude-opus-4.8",
    provider: "anthropic",
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "claude-opus-4.7",
    provider: "anthropic",
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "claude-opus-4.6",
    provider: "anthropic",
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "claude-opus-4.5",
    provider: "anthropic",
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 25,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "claude-sonnet-5",
    provider: "anthropic",
    inputUsdPerMTok: 2,
    outputUsdPerMTok: 10,
    source: "Anthropic pricing, checked 2026-07-08",
    note: "Introductory price through 2026-08-31; standard price is $3/$15 from 2026-09-01.",
  },
  {
    modelId: "claude-sonnet-5-standard",
    provider: "anthropic",
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    source: "Anthropic pricing, checked 2026-07-08",
    note: "Standard price starting 2026-09-01.",
  },
  {
    modelId: "claude-sonnet-4.6",
    provider: "anthropic",
    inputUsdPerMTok: 3,
    outputUsdPerMTok: 15,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "claude-haiku-4.5",
    provider: "anthropic",
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    source: "Anthropic pricing, checked 2026-07-08",
  },
  {
    modelId: "gpt-5.5",
    provider: "openai",
    inputUsdPerMTok: 5,
    outputUsdPerMTok: 30,
    source: "OpenAI model docs, checked 2026-07-08",
  },
  {
    modelId: "gpt-5.4",
    provider: "openai",
    inputUsdPerMTok: 2.5,
    outputUsdPerMTok: 15,
    source: "OpenAI model docs, checked 2026-07-08",
  },
  {
    modelId: "gpt-5.4-mini",
    provider: "openai",
    inputUsdPerMTok: 0.75,
    outputUsdPerMTok: 4.5,
    source: "OpenAI model docs, checked 2026-07-08",
  },
];

function normalizeModelId(id: string): string {
  const stripped = id
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, "")
    .replace(/^openai\//, "")
    .replace(/-\d{8}$/, "");
  return stripped
    .replace(/^(claude-(?:opus|sonnet|haiku)-\d)-(\d)$/, "$1.$2")
    .replace(/^(gpt-\d)-(\d)(-mini)?$/, "$1.$2$3");
}

/**
 * Look up a cloud token price. First checks the pinned frontier catalog, then falls back to the
 * benchmark model registry's OpenRouter price fields for evaluated non-frontier models.
 */
export function lookupModelTokenPrice(modelId: string | null | undefined): ModelTokenPrice | null {
  if (!modelId || modelId.trim() === "") return null;
  const normalized = normalizeModelId(modelId);
  const direct = DEFAULT_MODEL_TOKEN_PRICES.find((p) => normalizeModelId(p.modelId) === normalized);
  if (direct) return direct;

  const registry = getModelById(modelId) ?? getModelById(normalized);
  if (
    registry &&
    (registry.openRouterPricePerMInputToken > 0 || registry.openRouterPricePerMOutputToken > 0)
  ) {
    return {
      modelId: registry.id,
      provider: "openrouter",
      inputUsdPerMTok: registry.openRouterPricePerMInputToken,
      outputUsdPerMTok: registry.openRouterPricePerMOutputToken,
      source: "src/runner/models.ts OpenRouter registry",
    };
  }

  return null;
}

export function estimateTokenCostUsd(
  modelId: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined
): number | null {
  const price = lookupModelTokenPrice(modelId);
  if (!price || promptTokens == null || completionTokens == null) return null;
  return roundUsd(
    (promptTokens / 1_000_000) * price.inputUsdPerMTok +
      (completionTokens / 1_000_000) * price.outputUsdPerMTok
  );
}

export function estimateLocalTokenCostUsd(
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  usdPerMTok: number
): number {
  if (promptTokens == null || completionTokens == null || usdPerMTok <= 0) return 0;
  return roundUsd(((promptTokens + completionTokens) / 1_000_000) * usdPerMTok);
}

export function roundUsd(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}
