/** Pure parsing of the backend chat response used by MCP ask, without side effects. */

/** Only the separately requested reasoning field is capped; generation/usage is unchanged. */
export const ASK_REASONING_MAX_BYTES = 16_384;
export class InvalidAskResponse extends Error {}

export interface AskReasoning {
  content: string | null;
  truncated: boolean | null;
}

function boundedAskReasoning(raw: unknown): AskReasoning {
  if (typeof raw !== "string") return { content: null, truncated: null };
  let bytes = 0;
  let end = 0;
  // Stop at a complete Unicode code point. Never decode a sliced UTF-8 byte sequence.
  for (const character of raw) {
    const next = Buffer.byteLength(character, "utf8");
    if (bytes + next > ASK_REASONING_MAX_BYTES) return { content: raw.slice(0, end), truncated: true };
    bytes += next;
    end += character.length;
  }
  return { content: raw, truncated: false };
}

export interface AskUsageMetadata {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export const ASK_TRUNCATION_FINISH_REASON = "length";

function emptyAskUsageMetadata(): AskUsageMetadata {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function askTruncatedOfFinishReason(finishReason: string | null): boolean | null {
  return finishReason === null ? null : finishReason === ASK_TRUNCATION_FINISH_REASON;
}

function parseAskUsageMetadata(rawUsage: unknown): AskUsageMetadata {
  if (rawUsage === null || rawUsage === undefined) {
    return emptyAskUsageMetadata();
  }
  if (typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return emptyAskUsageMetadata();
  }
  const usage = rawUsage as {
    prompt_tokens?: unknown;
    input_tokens?: unknown;
    completion_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    reasoning_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    prompt_tokens_details?: {
      cached_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
    completion_tokens_details?: {
      reasoning_tokens?: unknown;
    };
  };
  const promptTokens =
    nonNegativeIntegerOrNull(usage.prompt_tokens) ?? nonNegativeIntegerOrNull(usage.input_tokens);
  const completionTokens =
    nonNegativeIntegerOrNull(usage.completion_tokens) ?? nonNegativeIntegerOrNull(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      nonNegativeIntegerOrNull(usage.total_tokens) ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
    reasoningTokens:
      nonNegativeIntegerOrNull(usage.reasoning_tokens) ??
      nonNegativeIntegerOrNull(usage.completion_tokens_details?.reasoning_tokens),
    cacheCreationInputTokens:
      nonNegativeIntegerOrNull(usage.cache_creation_input_tokens) ??
      nonNegativeIntegerOrNull(usage.prompt_tokens_details?.cache_creation_input_tokens),
    cacheReadInputTokens:
      nonNegativeIntegerOrNull(usage.cache_read_input_tokens) ??
      nonNegativeIntegerOrNull(usage.prompt_tokens_details?.cache_read_input_tokens) ??
      nonNegativeIntegerOrNull(usage.prompt_tokens_details?.cached_tokens),
  };
}

export interface ParsedAskChatResponse {
  content: string;
  reasoning?: AskReasoning;
  usage: AskUsageMetadata;
  finishReason: string | null;
  truncated: boolean | null;
  actualTokens: number;
}

/** The caller must authorize reasoning and reconcile the returned token count. */
export function parseAskChatResponse(
  text: string,
  options: { includeReasoning: boolean; promptChars: number },
): ParsedAskChatResponse {
  const json = JSON.parse(text) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: unknown }; finish_reason?: string | null }>;
    usage?: unknown;
  };
  // Preserve the existing permissive contract for absent/null choices and messages.
  if (json === null || typeof json !== "object" || Array.isArray(json) ||
      (json.choices != null && !Array.isArray(json.choices))) throw new InvalidAskResponse();
  const message = json.choices?.[0]?.message;
  if (message != null && (typeof message !== "object" || Array.isArray(message) ||
      (message.content != null && typeof message.content !== "string"))) throw new InvalidAskResponse();
  const usage = parseAskUsageMetadata(json.usage);
  const finishReason = typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : null;
  return {
    content: message?.content ?? "",
    ...(options.includeReasoning ? { reasoning: boundedAskReasoning(message?.reasoning_content) } : {}),
    usage,
    finishReason,
    truncated: askTruncatedOfFinishReason(finishReason),
    actualTokens: usage.totalTokens ??
      (usage.promptTokens !== null && usage.completionTokens !== null
        ? usage.promptTokens + usage.completionTokens
        : Math.ceil(options.promptChars / 4)),
  };
}
