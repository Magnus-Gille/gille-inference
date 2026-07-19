import { describe, expect, it } from "vitest";
import {
  clampMaxTokensForModel,
  parseModelMaxTokens,
  type HomeserverConfig,
} from "../src/homeserver/config.js";

const cfg = {
  perRequestMaxTokens: 12_288,
  modelMaxTokens: { "vibethinker-3b": 32_768 },
} as HomeserverConfig;

describe("per-model max_tokens ceilings", () => {
  it("keeps the fleet default when max_tokens is omitted", () => {
    expect(clampMaxTokensForModel(cfg, "vibethinker-3b", null)).toBe(12_288);
  });

  it("permits an explicit VibeThinker request up to its larger ceiling", () => {
    expect(clampMaxTokensForModel(cfg, "vibethinker-3b", 20_000)).toBe(20_000);
    expect(clampMaxTokensForModel(cfg, "vibethinker-3b", 99_999)).toBe(32_768);
  });

  it("does not widen ordinary models", () => {
    expect(clampMaxTokensForModel(cfg, "mellum", 99_999)).toBe(12_288);
  });

  it("does not inherit prototype properties from an untrusted model id", () => {
    expect(clampMaxTokensForModel(cfg, "constructor", 99_999)).toBe(12_288);
    expect(clampMaxTokensForModel(cfg, "__proto__", 99_999)).toBe(12_288);
  });

  it("parses valid CSV entries and ignores malformed/non-positive limits", () => {
    expect(parseModelMaxTokens("vibethinker-3b=32768,mellum=8192,bad,nope=-1,x=NaN")).toEqual({
      "vibethinker-3b": 32_768,
      mellum: 8_192,
    });
  });
});
