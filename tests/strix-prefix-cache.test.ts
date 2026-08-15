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
  it("detects a cached-boundary stall after an extended tool conversation", () => {
    const observations = [
      row("baseline-cold", 26_835, 0),
      row("baseline-warm", 16, 26_819),
      row("tool-turn-cold", 27_153, 0),
      row("tool-turn-warm", 16, 27_137),
      row("extended-tool-turn-first", 90, 27_137),
      row("extended-tool-turn-repeat", 90, 27_137),
    ];

    expect(analyzePrefixCacheObservations(observations)).toEqual({
      state: "regression",
      cacheActive: true,
      warmControlEvalTokens: 16,
      extendedFirstEvalTokens: 90,
      extendedRepeatEvalTokens: 90,
      extendedRepeatPenaltyTokens: 74,
      extendedCacheGrowthTokens: 0,
      maxHealthyRepeatEvalTokens: 24,
      reason: "exact extended repeat re-evaluated 90 tokens; warm controls require 16 and tolerance is 8",
    });
  });

  it("passes when the exact extended repeat advances to the warm-control tail", () => {
    const observations = [
      row("baseline-cold", 26_835, 0),
      row("baseline-warm", 16, 26_819),
      row("tool-turn-cold", 27_153, 0),
      row("tool-turn-warm", 16, 27_137),
      row("extended-tool-turn-first", 90, 27_137),
      row("extended-tool-turn-repeat", 16, 27_211),
    ];

    expect(analyzePrefixCacheObservations(observations)).toMatchObject({
      state: "healthy",
      cacheActive: true,
      extendedRepeatPenaltyTokens: 0,
      extendedCacheGrowthTokens: 74,
    });
  });

  it("fails closed when cache metadata or a required phase is absent", () => {
    const observations = [
      row("baseline-cold", 100, 0),
      row("baseline-warm", 100, 0),
    ];
    expect(analyzePrefixCacheObservations(observations)).toMatchObject({
      state: "unobservable",
      cacheActive: false,
    });
  });
});
