import { describe, expect, it } from "vitest";

import {
  buildMmapServerArgs,
  evaluateMmapAb,
  parseStrixMmapAbArgs,
  validateStrixMmapAbConfig,
  withRequiredRestoration,
  type StrixMmapTrial,
} from "../src/homeserver/strix-mmap-ab.js";

const HASH = "a".repeat(64);

function config() {
  return validateStrixMmapAbConfig({
    schemaVersion: 1,
    binaryPath: "/home/magnus/llama.cpp/build/bin/llama-server",
    modelPath: "/home/magnus/models/Qwen3.6-35B-A3B-Q4_K_M.gguf",
    modelId: "qwen36-a3b",
    runtimeCommit: "8".repeat(40),
    runtimeBinarySha256: "1".repeat(64),
    modelArtifactSha256: "2".repeat(64),
    backend: "vulkan",
    quant: "Q4_K_M",
    biosUma: "512MiB fixed UMA + 100GiB dynamic TTM",
    powerMode: "performance",
    port: 5818,
    commonArgs: [
      "-ngl", "99", "-ub", "512", "-c", "131072", "-np", "1", "--jinja", "-fa", "on",
      "--chat-template-kwargs", '{"enable_thinking":false}',
    ],
  });
}

function trial(variant: "mmap" | "no-mmap", overrides: Partial<StrixMmapTrial> = {}): StrixMmapTrial {
  return {
    variant,
    sequence: 0,
    startedAt: "2026-08-15T20:00:00.000Z",
    endedAt: "2026-08-15T20:01:00.000Z",
    startupReadyMs: variant === "mmap" ? 10_000 : 8_500,
    peakRssBytes: variant === "mmap" ? 30_000 : 26_000,
    minMemAvailableBytes: variant === "mmap" ? 70_000 : 74_000,
    minSwapFreeBytes: 8_000,
    maxTemperatureC: 70,
    first: {
      ok: true,
      exactAnswer: true,
      ttftMs: 100,
      totalMs: 1_000,
      promptTokens: 24,
      completionTokens: 2,
      cachedPromptTokens: 0,
      promptTokensPerSecond: 1_000,
      predictedTokensPerSecond: 75,
      outputSha256: HASH,
    },
    warm: {
      ok: true,
      exactAnswer: true,
      ttftMs: 90,
      totalMs: 900,
      promptTokensPerSecond: 1_100,
      predictedTokensPerSecond: 76,
      outputSha256: HASH,
    },
    ...overrides,
  };
}

describe("Strix mmap A/B contract", () => {
  it("requires an explicit exclusive-window acknowledgement and bounded paths", () => {
    expect(parseStrixMmapAbArgs([
      "--config", "configs/strix-mmap.json",
      "--out", "data/strix/mmap",
      "--ack-exclusive-window",
    ])).toEqual({
      configPath: "configs/strix-mmap.json",
      outPrefix: "data/strix/mmap",
      llamaSwapOrigin: "http://127.0.0.1:8091",
      cycles: 1,
      ackExclusiveWindow: true,
    });
    expect(() => parseStrixMmapAbArgs(["--config", "x", "--out", "y"])).toThrow(/exclusive/);
    expect(() => parseStrixMmapAbArgs([
      "--config", "x", "--out", "y", "--ack-exclusive-window",
      "--llama-swap-origin", "https://example.com",
    ])).toThrow(/loopback/);
  });

  it("builds one-axis server argv and rejects configuration-owned variants", () => {
    const validated = config();
    expect(buildMmapServerArgs(validated, "mmap")).toEqual([
      "--host", "127.0.0.1", "--port", "5818",
      "-m", validated.modelPath,
      ...validated.commonArgs,
      "--mmap", "--metrics",
    ]);
    expect(buildMmapServerArgs(validated, "no-mmap").at(-2)).toBe("--no-mmap");
    expect(() => validateStrixMmapAbConfig({
      ...validated,
      commonArgs: [...validated.commonArgs, "--no-mmap"],
    })).toThrow(/controlled by the runner/);
  });

  it("promotes a consistent material win without correctness or steady-state regression", () => {
    const result = evaluateMmapAb([
      trial("mmap", { sequence: 0 }),
      trial("no-mmap", { sequence: 1 }),
      trial("no-mmap", { sequence: 2 }),
      trial("mmap", { sequence: 3 }),
    ]);
    expect(result.decision).toBe("promote");
    expect(result.reasons).toContain("no-mmap materially improves cold startup or peak RSS");
  });

  it("rejects output drift and steady decode regression even when startup improves", () => {
    const different = "b".repeat(64);
    const result = evaluateMmapAb([
      trial("mmap", { sequence: 0 }),
      trial("no-mmap", {
        sequence: 1,
        first: { ...trial("no-mmap").first, outputSha256: different, predictedTokensPerSecond: 65 },
      }),
      trial("no-mmap", {
        sequence: 2,
        first: { ...trial("no-mmap").first, outputSha256: different, predictedTokensPerSecond: 65 },
      }),
      trial("mmap", { sequence: 3 }),
    ]);
    expect(result.decision).toBe("reject");
    expect(result.reasons.join(" ")).toMatch(/fingerprint|generation throughput/);
  });

  it("restores after success and failure, and surfaces restoration failure first", async () => {
    const events: string[] = [];
    await expect(withRequiredRestoration(
      async () => { events.push("run"); return 42; },
      async () => { events.push("restore"); },
    )).resolves.toBe(42);
    expect(events).toEqual(["run", "restore"]);

    await expect(withRequiredRestoration(
      async () => { throw new Error("trial failed"); },
      async () => { events.push("restored-after-failure"); },
    )).rejects.toThrow("trial failed");
    expect(events).toContain("restored-after-failure");

    await expect(withRequiredRestoration(
      async () => { throw new Error("trial failed"); },
      async () => { throw new Error("residency unknown"); },
    )).rejects.toThrow("benchmark restoration failed: residency unknown");
  });
});
