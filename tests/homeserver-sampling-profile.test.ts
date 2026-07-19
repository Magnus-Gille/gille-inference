import { describe, expect, it } from "vitest";
import { resolveLocalSampling } from "../src/homeserver/sampling-profile.js";

describe("model-aware local sampling", () => {
  it("uses VibeThinker's official stochastic profile by default", () => {
    expect(resolveLocalSampling("vibethinker-3b", {})).toEqual({
      temperature: 1,
      topP: 0.95,
      topK: 0,
      minP: 0,
    });
  });

  it("preserves explicit overrides, including zero", () => {
    expect(resolveLocalSampling("vibethinker-3b", { temperature: 0.7, topK: 12, minP: 0.1 })).toEqual({
      temperature: 0.7,
      topP: 0.95,
      topK: 12,
      minP: 0.1,
    });
  });

  it("preserves the existing generic-model defaults", () => {
    expect(resolveLocalSampling("mellum", {})).toEqual({
      temperature: 0,
      topP: undefined,
      topK: undefined,
      minP: undefined,
    });
  });
});
