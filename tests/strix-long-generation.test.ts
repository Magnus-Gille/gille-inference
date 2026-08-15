import { describe, expect, it } from "vitest";

import {
  buildLongGenerationServerArgs,
  evaluateLongGenerationEquivalence,
  type StrixLongGenerationSample,
} from "../src/homeserver/strix-long-generation.js";

function sample(runtime: "production" | "candidate", overrides: Partial<StrixLongGenerationSample> = {}): StrixLongGenerationSample {
  return {
    runtime,
    ok: true,
    finishReason: "length",
    promptTokens: 64,
    completionTokens: 4_096,
    outputSha256: "a".repeat(64),
    outputBytes: 16_384,
    responseBytes: 32_768,
    ttftMs: 100,
    totalMs: 50_000,
    predictedTokensPerSecond: 82,
    serverArgsSha256: "d".repeat(64),
    serverLogSha256: "b".repeat(64),
    serverLogBytes: 1_024,
    ...overrides,
  };
}

describe("Strix long-generation equivalence gate", () => {
  it("builds an explicit Q8-KV server command without changing the shared controls", () => {
    expect(buildLongGenerationServerArgs({
      port: 5818,
      modelPath: "/models/model.gguf",
      commonArgs: ["-ngl", "99", "-c", "131072", "-fa", "on"],
      kvK: "q8_0",
      kvV: "q8_0",
    })).toEqual([
      "--host", "127.0.0.1", "--port", "5818", "-m", "/models/model.gguf",
      "-ngl", "99", "-c", "131072", "-fa", "on",
      "-ctk", "q8_0", "-ctv", "q8_0", "--mmap", "--metrics",
    ]);
    expect(() => buildLongGenerationServerArgs({
      port: 5818,
      modelPath: "/models/model.gguf",
      commonArgs: ["-ctk", "f16"],
      kvK: "q8_0",
      kvV: "q8_0",
    })).toThrow(/controlled/);
    expect(() => buildLongGenerationServerArgs({
      port: 5818,
      modelPath: "/models/model.gguf",
      commonArgs: ["--spec-type", "draft-mtp"],
      kvK: "q8_0",
      kvV: "q8_0",
    })).toThrow(/controlled/);
  });

  it("passes only complete byte-identical deterministic generations", () => {
    expect(evaluateLongGenerationEquivalence(sample("production"), sample("candidate"), 3_072)).toMatchObject({
      decision: "pass",
      outputHashesMatch: true,
      completionTokensMatch: true,
      serverArgsMatch: true,
      deploymentAuthorized: false,
    });
  });

  it("rejects mismatches, short generations, and incomplete streams", () => {
    expect(evaluateLongGenerationEquivalence(
      sample("production"),
      sample("candidate", { outputSha256: "c".repeat(64) }),
      3_072,
    )).toMatchObject({ decision: "reject", outputHashesMatch: false });
    expect(evaluateLongGenerationEquivalence(
      sample("production"),
      sample("candidate", { completionTokens: 2_000 }),
      3_072,
    ).reasons.join(" ")).toMatch(/minimum/);
    expect(evaluateLongGenerationEquivalence(
      sample("production"),
      sample("candidate", { ok: false, finishReason: null, outputSha256: null }),
      3_072,
    )).toMatchObject({ decision: "reject" });
    expect(evaluateLongGenerationEquivalence(
      sample("production"),
      sample("candidate", { serverArgsSha256: "e".repeat(64) }),
      3_072,
    ).reasons.join(" ")).toMatch(/arguments differ/);
  });
});
