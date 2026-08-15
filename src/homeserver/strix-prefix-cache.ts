export type PrefixCacheBasePhase =
  | "baseline-cold"
  | "baseline-warm"
  | "tool-turn-cold"
  | "tool-turn-warm"
  | "extended-tool-turn-first"
  | "extended-tool-turn-repeat";

export type PrefixCacheStressPhase = `stress-cycle-${number}-generate` | "stress-final-audit";
export type PrefixCachePhase = PrefixCacheBasePhase | PrefixCacheStressPhase;

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
  completionTokens: number;
}

export interface PrefixCacheStressAnalysis {
  state: "healthy" | "regression" | "unobservable";
  expectedCycles: number;
  checkpointCrossingCycles: number;
  generatedTokens: number[];
  finalPromptTokens: number | null;
  finalAuditEvalTokens: number | null;
  finalAuditCachedTokens: number | null;
  warmControlEvalTokens: number | null;
  maxHealthyAuditEvalTokens: number | null;
  reason: string;
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

const REQUIRED_PHASES: PrefixCacheBasePhase[] = [
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

export function analyzePrefixCacheStressObservations(
  observations: PrefixCacheObservation[],
  checkpointMinStepTokens: number,
  expectedCycles: number,
  repeatToleranceTokens = 8,
): PrefixCacheStressAnalysis {
  if (!Number.isInteger(checkpointMinStepTokens) || checkpointMinStepTokens <= 0) {
    throw new Error("checkpointMinStepTokens must be a positive integer for a stress analysis");
  }
  if (!Number.isInteger(expectedCycles) || expectedCycles <= 0) {
    throw new Error("expectedCycles must be a positive integer");
  }
  const byLabel = new Map(observations.map((row) => [row.label, row]));
  const baselineWarm = byLabel.get("baseline-warm");
  const toolWarm = byLabel.get("tool-turn-warm");
  const cycleRows = Array.from({ length: expectedCycles }, (_, index) =>
    byLabel.get(`stress-cycle-${index + 1}-generate`));
  const finalAudit = byLabel.get("stress-final-audit");
  const generatedTokens = cycleRows.flatMap((row) => row === undefined ? [] : [row.completionTokens]);
  const checkpointCrossingCycles = cycleRows.filter((row) =>
    row !== undefined && row.responseContentPresent && row.completionTokens >= checkpointMinStepTokens).length;
  const cacheActive = (baselineWarm?.cachedTokens ?? 0) > 0 && (toolWarm?.cachedTokens ?? 0) > 0;
  const warmControlEvalTokens = baselineWarm === undefined || toolWarm === undefined
    ? null
    : Math.max(baselineWarm.promptN, toolWarm.promptN);
  const missingCycle = cycleRows.findIndex((row) => row === undefined);

  if (!cacheActive || warmControlEvalTokens === null || missingCycle >= 0 || finalAudit === undefined ||
      checkpointCrossingCycles !== expectedCycles) {
    const reason = !cacheActive
      ? "warm controls did not expose active prompt-cache reuse"
      : missingCycle >= 0
        ? `missing stress generation cycle ${missingCycle + 1}`
        : finalAudit === undefined
          ? "missing final exact stress audit"
          : `only ${checkpointCrossingCycles}/${expectedCycles} generations crossed the ${checkpointMinStepTokens}-token checkpoint interval`;
    return {
      state: "unobservable",
      expectedCycles,
      checkpointCrossingCycles,
      generatedTokens,
      finalPromptTokens: finalAudit?.promptTokens ?? null,
      finalAuditEvalTokens: finalAudit?.promptN ?? null,
      finalAuditCachedTokens: finalAudit?.cachedTokens ?? null,
      warmControlEvalTokens,
      maxHealthyAuditEvalTokens: warmControlEvalTokens === null
        ? null
        : warmControlEvalTokens + checkpointMinStepTokens + repeatToleranceTokens,
      reason,
    };
  }

  const finalGenerate = cycleRows[cycleRows.length - 1]!;
  if (finalAudit.promptTokens !== finalGenerate.promptTokens) {
    return {
      state: "unobservable",
      expectedCycles,
      checkpointCrossingCycles,
      generatedTokens,
      finalPromptTokens: finalAudit.promptTokens,
      finalAuditEvalTokens: finalAudit.promptN,
      finalAuditCachedTokens: finalAudit.cachedTokens,
      warmControlEvalTokens,
      maxHealthyAuditEvalTokens: warmControlEvalTokens + checkpointMinStepTokens + repeatToleranceTokens,
      reason: `final audit prompt token count ${finalAudit.promptTokens} does not match final generation input ${finalGenerate.promptTokens}`,
    };
  }

  const maxHealthyAuditEvalTokens = warmControlEvalTokens + checkpointMinStepTokens + repeatToleranceTokens;
  const healthy = finalAudit.promptN <= maxHealthyAuditEvalTokens;
  return {
    state: healthy ? "healthy" : "regression",
    expectedCycles,
    checkpointCrossingCycles,
    generatedTokens,
    finalPromptTokens: finalAudit.promptTokens,
    finalAuditEvalTokens: finalAudit.promptN,
    finalAuditCachedTokens: finalAudit.cachedTokens,
    warmControlEvalTokens,
    maxHealthyAuditEvalTokens,
    reason: healthy
      ? `final exact audit evaluated ${finalAudit.promptN} tokens within the ${maxHealthyAuditEvalTokens}-token checkpoint-aware bound after ${expectedCycles} crossing cycles`
      : `final exact audit re-evaluated ${finalAudit.promptN} tokens beyond the ${maxHealthyAuditEvalTokens}-token checkpoint-aware bound after ${expectedCycles} crossing cycles`,
  };
}
