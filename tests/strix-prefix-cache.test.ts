import { describe, expect, it } from "vitest";

import {
  analyzePrefixCacheObservations,
  analyzePrefixCacheStressObservations,
  type PrefixCacheObservation,
} from "../src/homeserver/strix-prefix-cache.js";

function row(
  label: PrefixCacheObservation["label"],
  promptN: number,
  cacheN: number,
  promptTokens = promptN + cacheN,
  completionTokens = 1,
): PrefixCacheObservation {
  return {
    label,
    promptTokens,
    cachedTokens: cacheN,
    promptN,
    cacheN,
    promptMs: promptN * 4,
    requestWallMs: promptN * 5,
    quotaWaitMs: 0,
    quotaRetries: 0,
    finishReason: "length",
    responseContentPresent: true,
    completionTokens,
  };
}

describe("Strix tool-turn prefix-cache analysis", () => {
  it("detects cache invalidation beyond the configured checkpoint window", () => {
    const observations = [
      row("baseline-cold", 26_835, 0),
      row("baseline-warm", 16, 26_819),
      row("tool-turn-cold", 27_153, 0),
      row("tool-turn-warm", 16, 27_137),
      row("extended-tool-turn-first", 90, 27_137),
      row("extended-tool-turn-repeat", 500, 26_727),
    ];

    expect(analyzePrefixCacheObservations(observations, 256)).toEqual({
      state: "regression",
      cacheActive: true,
      warmControlEvalTokens: 16,
      extendedFirstEvalTokens: 90,
      extendedRepeatEvalTokens: 500,
      extendedRepeatPenaltyTokens: 484,
      extendedCacheGrowthTokens: -410,
      configuredCheckpointMinStepTokens: 256,
      maxHealthyRepeatEvalTokens: 280,
      reason: "exact extended repeat re-evaluated 500 tokens; warm controls require 16, checkpoint minimum is 256, and tolerance is 8",
    });
  });

  it("passes when the exact repeat stays inside the configured checkpoint window", () => {
    const observations = [
      row("baseline-cold", 26_835, 0),
      row("baseline-warm", 16, 26_819),
      row("tool-turn-cold", 27_153, 0),
      row("tool-turn-warm", 16, 27_137),
      row("extended-tool-turn-first", 90, 27_137),
      row("extended-tool-turn-repeat", 90, 27_137),
    ];

    expect(analyzePrefixCacheObservations(observations, 256)).toMatchObject({
      state: "healthy",
      cacheActive: true,
      extendedRepeatPenaltyTokens: 74,
      extendedCacheGrowthTokens: 0,
      maxHealthyRepeatEvalTokens: 280,
    });
  });

  it("fails closed when cache metadata or a required phase is absent", () => {
    const observations = [
      row("baseline-cold", 100, 0),
      row("baseline-warm", 100, 0),
    ];
    expect(analyzePrefixCacheObservations(observations, 256)).toMatchObject({
      state: "unobservable",
      cacheActive: false,
    });
  });
});

describe("Strix checkpoint-crossing prefix-cache stress analysis", () => {
  const base = [
    row("baseline-cold", 26_835, 0),
    row("baseline-warm", 16, 26_819),
    row("tool-turn-cold", 27_153, 0),
    row("tool-turn-warm", 16, 27_137),
    row("extended-tool-turn-first", 90, 27_137),
    row("extended-tool-turn-repeat", 90, 27_137),
  ];

  it("passes after several checkpoint-crossing generations when the final exact input stays cached", () => {
    const observations = [
      ...base,
      row("stress-cycle-1-generate", 27_400, 0, 27_400, 384),
      row("stress-cycle-2-generate", 460, 27_400, 27_860, 384),
      row("stress-cycle-3-generate", 470, 27_860, 28_330, 384),
      row("stress-cycle-4-generate", 475, 28_330, 28_805, 384),
      row("stress-final-audit", 120, 28_685, 28_805, 1),
    ];

    expect(analyzePrefixCacheStressObservations(observations, 256, 4)).toEqual({
      state: "healthy",
      expectedCycles: 4,
      checkpointCrossingCycles: 4,
      generatedTokens: [384, 384, 384, 384],
      finalPromptTokens: 28_805,
      finalAuditEvalTokens: 120,
      finalAuditCachedTokens: 28_685,
      warmControlEvalTokens: 16,
      maxHealthyAuditEvalTokens: 280,
      reason: "final exact audit evaluated 120 tokens within the 280-token checkpoint-aware bound after 4 crossing cycles",
    });
  });

  it("flags invalidation when the final exact audit falls behind by more than one checkpoint interval", () => {
    const observations = [
      ...base,
      row("stress-cycle-1-generate", 27_400, 0, 27_400, 384),
      row("stress-cycle-2-generate", 460, 27_400, 27_860, 384),
      row("stress-cycle-3-generate", 470, 27_860, 28_330, 384),
      row("stress-cycle-4-generate", 475, 28_330, 28_805, 384),
      row("stress-final-audit", 1_200, 27_605, 28_805, 1),
    ];

    expect(analyzePrefixCacheStressObservations(observations, 256, 4)).toMatchObject({
      state: "regression",
      checkpointCrossingCycles: 4,
      finalAuditEvalTokens: 1_200,
      maxHealthyAuditEvalTokens: 280,
    });
  });

  it("fails closed when a generation does not cross the checkpoint interval", () => {
    const observations = [
      ...base,
      row("stress-cycle-1-generate", 27_400, 0, 27_400, 200),
      row("stress-cycle-2-generate", 460, 27_400, 27_860, 384),
      row("stress-final-audit", 120, 27_740, 27_860, 1),
    ];

    expect(analyzePrefixCacheStressObservations(observations, 256, 2)).toMatchObject({
      state: "unobservable",
      checkpointCrossingCycles: 1,
      expectedCycles: 2,
    });
  });
});
