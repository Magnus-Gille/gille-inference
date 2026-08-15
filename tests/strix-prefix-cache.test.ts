import { describe, expect, it } from "vitest";

import {
  analyzePrefixCacheObservations,
  type PrefixCacheObservation,
} from "../src/homeserver/strix-prefix-cache.js";

function row(
  label: PrefixCacheObservation["label"],
  promptN: number,
  cacheN: number,
  promptTokens = promptN + cacheN,
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
