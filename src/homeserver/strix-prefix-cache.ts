export type PrefixCachePhase =
  | "baseline-cold"
  | "baseline-warm"
  | "tool-turn-cold"
  | "tool-turn-warm"
  | "extended-tool-turn-first"
  | "extended-tool-turn-repeat";

export interface PrefixCacheObservation {
  label: PrefixCachePhase;
  promptTokens: number;
  cachedTokens: number;
  promptN: number;
  cacheN: number;
  promptMs: number;
  requestWallMs: number;
  quotaWaitMs: number;
  quotaRetries: number;
  finishReason: string | null;
  responseContentPresent: boolean;
}

export interface PrefixCacheAnalysis {
  state: "healthy" | "regression" | "unobservable";
  cacheActive: boolean;
  warmControlEvalTokens: number | null;
  extendedFirstEvalTokens: number | null;
  extendedRepeatEvalTokens: number | null;
  extendedRepeatPenaltyTokens: number | null;
  extendedCacheGrowthTokens: number | null;
  configuredCheckpointMinStepTokens: number;
  maxHealthyRepeatEvalTokens: number | null;
  reason: string;
}

const REQUIRED_PHASES: PrefixCachePhase[] = [
  "baseline-cold",
  "baseline-warm",
  "tool-turn-cold",
  "tool-turn-warm",
  "extended-tool-turn-first",
  "extended-tool-turn-repeat",
];

export function analyzePrefixCacheObservations(
  observations: PrefixCacheObservation[],
  checkpointMinStepTokens: number,
  repeatToleranceTokens = 8,
): PrefixCacheAnalysis {
  if (!Number.isInteger(checkpointMinStepTokens) || checkpointMinStepTokens < 0) {
    throw new Error("checkpointMinStepTokens must be a non-negative integer");
  }
  const byLabel = new Map(observations.map((row) => [row.label, row]));
  const missing = REQUIRED_PHASES.filter((label) => !byLabel.has(label));
  const baselineWarm = byLabel.get("baseline-warm");
  const toolWarm = byLabel.get("tool-turn-warm");
  const extendedFirst = byLabel.get("extended-tool-turn-first");
  const extendedRepeat = byLabel.get("extended-tool-turn-repeat");
  const cacheActive = (baselineWarm?.cachedTokens ?? 0) > 0 && (toolWarm?.cachedTokens ?? 0) > 0;

  if (missing.length > 0 || !cacheActive || baselineWarm === undefined || toolWarm === undefined ||
      extendedFirst === undefined || extendedRepeat === undefined) {
    return {
      state: "unobservable",
      cacheActive,
      warmControlEvalTokens: null,
      extendedFirstEvalTokens: extendedFirst?.promptN ?? null,
      extendedRepeatEvalTokens: extendedRepeat?.promptN ?? null,
      extendedRepeatPenaltyTokens: null,
      extendedCacheGrowthTokens: null,
      configuredCheckpointMinStepTokens: checkpointMinStepTokens,
      maxHealthyRepeatEvalTokens: null,
      reason: missing.length > 0
        ? `missing required phases: ${missing.join(", ")}`
        : "warm controls did not expose active prompt-cache reuse",
    };
  }

  const warmControlEvalTokens = Math.max(baselineWarm.promptN, toolWarm.promptN);
  const maxHealthyRepeatEvalTokens = warmControlEvalTokens + checkpointMinStepTokens + repeatToleranceTokens;
  const extendedRepeatPenaltyTokens = Math.max(0, extendedRepeat.promptN - warmControlEvalTokens);
  const extendedCacheGrowthTokens = extendedRepeat.cachedTokens - extendedFirst.cachedTokens;
  const healthy = extendedRepeat.promptN <= maxHealthyRepeatEvalTokens;
  return {
    state: healthy ? "healthy" : "regression",
    cacheActive,
    warmControlEvalTokens,
    extendedFirstEvalTokens: extendedFirst.promptN,
    extendedRepeatEvalTokens: extendedRepeat.promptN,
    extendedRepeatPenaltyTokens,
    extendedCacheGrowthTokens,
    configuredCheckpointMinStepTokens: checkpointMinStepTokens,
    maxHealthyRepeatEvalTokens,
    reason: healthy
      ? `exact extended repeat evaluated ${extendedRepeat.promptN} tokens within the ${maxHealthyRepeatEvalTokens}-token checkpoint-aware bound`
      : `exact extended repeat re-evaluated ${extendedRepeat.promptN} tokens; warm controls require ${warmControlEvalTokens}, checkpoint minimum is ${checkpointMinStepTokens}, and tolerance is ${repeatToleranceTokens}`,
  };
}
