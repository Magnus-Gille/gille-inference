
/**
 * Token price catalog for delegation savings accounting.
 *
 * Values are USD per 1M tokens. The catalog is deliberately versioned and
 * snapshot-like: historical savings rows should be reproducible even after a
 * vendor changes prices. Refresh this file intentionally when pricing changes.
 * Only first-party vendor tariffs may book a savings figure; benchmark registry
 * or reseller rates are deliberately not aliases for a delegator's own bill.
 */

export interface ModelTokenPrice {
  modelId: string;
  provider: "anthropic" | "openai" | "openrouter" | "local" | "unknown";
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** First-party vendor source for these standard, uncached token rates. */
  sourceUrl: string;
  /** Date the source was verified, in YYYY-MM-DD form. */
  checkedAt: string;
  /** Do not book savings after this date without a deliberate catalog refresh. */
  validUntil: string;
  /** Optional future effective date; prices never book before it. */
  availableFrom?: string;
  note?: string;
}

/** A deliberately non-priceable id which still needs an auditable answer in the catalog. */
export interface UnavailableModelTokenPrice {
  modelId: string;
  provider: "anthropic" | "openai" | "openrouter" | "local" | "unknown";
  sourceUrl: string;
  checkedAt: string;
  reason: string;
}

export type CatalogEntry = ModelTokenPrice | UnavailableModelTokenPrice;
export type ModelTokenPriceStatus =
  | { kind: "priced"; price: ModelTokenPrice }
  | { kind: "stale"; price: ModelTokenPrice }
  | { kind: "not-yet-effective"; price: ModelTokenPrice }
  | { kind: "unavailable"; entry: UnavailableModelTokenPrice }
  | { kind: "missing" };

export const DEFAULT_COST_CATALOG_VERSION = "2026-08-29";

export const DEFAULT_PREMIUM_BASELINE_MODEL_ID = "claude-fable-5";

const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const QWEN3_30B_MODEL_CARD_URL = "https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507";
const CATALOG_CHECKED_AT = "2026-08-29";
const CATALOG_VALID_UNTIL = "2026-09-28";

function priced(
  modelId: string,
  provider: ModelTokenPrice["provider"],
  inputUsdPerMTok: number,
  outputUsdPerMTok: number,
  sourceUrl: string,
  note?: string,
  availableFrom?: string
): ModelTokenPrice {
  return { modelId, provider, inputUsdPerMTok, outputUsdPerMTok, sourceUrl, checkedAt: CATALOG_CHECKED_AT, validUntil: CATALOG_VALID_UNTIL, note, availableFrom };
}

export const DEFAULT_MODEL_TOKEN_PRICES: readonly ModelTokenPrice[] = [
  {
    ...priced("claude-fable-5", "anthropic", 10, 50, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-opus-5", "anthropic", 5, 25, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-opus-4.8", "anthropic", 5, 25, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-opus-4.7", "anthropic", 5, 25, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-opus-4.6", "anthropic", 5, 25, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-opus-4.5", "anthropic", 5, 25, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-sonnet-5", "anthropic", 2, 10, ANTHROPIC_PRICING_URL, "The launch tariff is now the standard price; the previously announced 2026-09-01 increase was cancelled."),
  },
  {
    ...priced("claude-sonnet-4.6", "anthropic", 3, 15, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("claude-haiku-4.5", "anthropic", 1, 5, ANTHROPIC_PRICING_URL),
  },
  {
    ...priced("gpt-5", "openai", 1.25, 10, "https://developers.openai.com/api/docs/models/gpt-5"),
  },
  {
    ...priced("gpt-5.6-sol", "openai", 4, 20, "https://developers.openai.com/api/docs/models/gpt-5.6-sol", "Promotional Standard-processing tariff, guaranteed by OpenAI at least through 2026-11-21; prompts above 272K input tokens use the documented long-context multiplier."),
  },
  { ...priced("gpt-5.6", "openai", 4, 20, "https://developers.openai.com/api/docs/models/gpt-5.6-sol", "Official alias of gpt-5.6-sol; the same promotional and long-context conditions apply.") },
  { ...priced("gpt-5.5", "openai", 5, 30, OPENAI_PRICING_URL) },
  { ...priced("gpt-5.4", "openai", 2.5, 15, OPENAI_PRICING_URL) },
  { ...priced("gpt-5.4-mini", "openai", 0.75, 4.5, OPENAI_PRICING_URL) },
];

export const DEFAULT_UNAVAILABLE_MODEL_TOKEN_PRICES: readonly UnavailableModelTokenPrice[] = [
  {
    modelId: "qwen3-30b-instruct",
    provider: "local",
    sourceUrl: QWEN3_30B_MODEL_CARD_URL,
    checkedAt: CATALOG_CHECKED_AT,
    reason: "Open-weight local model; its model card does not establish a provider token tariff.",
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
 * Look up a cloud token price from the pinned, first-party catalog only. A benchmark or reseller
 * rate is not evidence of what the delegator actually paid.
 */
function isExpired(price: ModelTokenPrice, now: Date): boolean {
  return Number.isNaN(Date.parse(price.validUntil)) || now.getTime() > Date.parse(`${price.validUntil}T23:59:59.999Z`);
}

function isNotYetEffective(price: ModelTokenPrice, now: Date): boolean {
  return price.availableFrom !== undefined && now.getTime() < Date.parse(`${price.availableFrom}T00:00:00.000Z`);
}

export function inspectModelTokenPrice(
  modelId: string | null | undefined,
  options: { now?: Date; catalog?: readonly ModelTokenPrice[]; unavailable?: readonly UnavailableModelTokenPrice[] } = {}
): ModelTokenPriceStatus {
  if (!modelId || modelId.trim() === "") return { kind: "missing" };
  const normalized = normalizeModelId(modelId);
  const now = options.now ?? new Date();
  const direct = (options.catalog ?? DEFAULT_MODEL_TOKEN_PRICES).find((p) => normalizeModelId(p.modelId) === normalized);
  if (direct) {
    if (isNotYetEffective(direct, now)) return { kind: "not-yet-effective", price: direct };
    return isExpired(direct, now) ? { kind: "stale", price: direct } : { kind: "priced", price: direct };
  }
  const unavailable = (options.unavailable ?? DEFAULT_UNAVAILABLE_MODEL_TOKEN_PRICES)
    .find((entry) => normalizeModelId(entry.modelId) === normalized);
  if (unavailable) return { kind: "unavailable", entry: unavailable };

  return { kind: "missing" };
}

export function lookupModelTokenPrice(modelId: string | null | undefined, now = new Date()): ModelTokenPrice | null {
  const status = inspectModelTokenPrice(modelId, { now });
  return status.kind === "priced" ? status.price : null;
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
