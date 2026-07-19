export interface LocalSamplingProfile {
  temperature: number;
  topP?: number;
  topK?: number;
  minP?: number;
}

/**
 * Resolve model-aware local decoding defaults. The local llama.cpp client retains its established
 * safety floor that maps a resolved temperature <= 0 to 0.6 for reasoning/MoE stability.
 * VibeThinker is trained/evaluated as a stochastic reasoning model; greedy/generic local defaults
 * under-measure it. Other models retain the established deterministic-request behavior (the local
 * client may apply its standing safety floor for models that degenerate at literal temperature 0).
 */
export function resolveLocalSampling(
  modelId: string,
  explicit: Partial<LocalSamplingProfile>
): LocalSamplingProfile {
  if (modelId.toLowerCase() === "vibethinker-3b") {
    return {
      temperature: explicit.temperature ?? 1,
      topP: explicit.topP ?? 0.95,
      topK: explicit.topK ?? 0,
      minP: explicit.minP ?? 0,
    };
  }
  return {
    temperature: explicit.temperature ?? 0,
    topP: explicit.topP,
    topK: explicit.topK,
    minP: explicit.minP,
  };
}
