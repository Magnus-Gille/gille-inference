import { describe, expect, it, vi } from "vitest";

import { runStrixPrefixCacheProbe } from "../scripts/strix-prefix-cache-probe.js";

const ARGV = [
  "--base-url", "http://m5:8080/v1",
  "--model", "qwen36-a3b",
  "--provenance", "provenance.json",
  "--out", "result/prefix-cache",
  "--api-key-env", "TEST_KEY",
  "--stable-items", "1800",
  "--max-tokens", "1",
  "--timeout-ms", "180000",
  "--max-quota-retries", "2",
  "--max-retry-after-s", "60",
];

const PROVENANCE = JSON.stringify({
  schemaVersion: 1,
  modelArtifactSha256: "a".repeat(64),
  runtimeCommit: "b".repeat(40),
  runtimeBinarySha256: "c".repeat(64),
  serverArgsSha256: "d".repeat(64),
  backend: "vulkan",
  quant: "Q4_K_M",
  kernel: "6.14.0",
  mesaVersion: "26.1.4",
  rocmVersion: null,
  contextSize: 131072,
  kvTypeK: "f16",
  kvTypeV: "f16",
  flashAttention: "on",
  batch: 2048,
  ubatch: 512,
  parallelism: 1,
  speculation: "none",
  draftDepth: null,
  cacheRamMiB: 8192,
  contextCheckpoints: 32,
  checkpointMinStep: 256,
  cacheIdleSlots: "on",
});

function completion(promptN: number, cacheN: number): Response {
  return Response.json({
    choices: [{ finish_reason: "length", message: { content: "private-model-text" } }],
    usage: {
      prompt_tokens: promptN + cacheN,
      prompt_tokens_details: { cached_tokens: cacheN },
    },
    timings: {
      prompt_n: promptN,
      cache_n: cacheN,
      prompt_ms: promptN * 4,
    },
  });
}

describe("Strix prefix-cache probe CLI", () => {
  it("honors Retry-After, emits no prompt/model/credential content, and exits one on regression", async () => {
    const responses = [
      new Response("quota", { status: 429, headers: { "retry-after": "1" } }),
      completion(26_835, 0),
      completion(16, 26_819),
      completion(27_153, 0),
      completion(16, 27_137),
      completion(90, 27_137),
      completion(500, 26_727),
    ];
    const fetchImpl = vi.fn(async () => responses.shift()!);
    const sleep = vi.fn(async () => undefined);
    const writePair = vi.fn(() => ({ jsonPath: "result.json", markdownPath: "result.md" }));

    const exit = await runStrixPrefixCacheProbe(ARGV, {
      fetchImpl: fetchImpl as typeof fetch,
      sleep,
      now: () => "2026-08-15T19:00:00.000Z",
      monotonicMs: (() => { let value = 0; return () => value += 10; })(),
      env: { TEST_KEY: "secret" },
      readFile: () => PROVENANCE,
      writePair,
      sourceRevision: () => "e".repeat(40),
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(exit).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledWith(1000);
    const [, json, markdown] = writePair.mock.calls[0]!;
    expect(JSON.parse(json).analysis.state).toBe("regression");
    expect(JSON.parse(json).probeCommit).toBe("e".repeat(40));
    expect(json).not.toContain("private-model-text");
    expect(json).not.toContain("secret");
    expect(json).not.toContain("synthetic_fact");
    expect(markdown).toContain("extended-tool-turn-repeat");
    expect(markdown).toContain("regression");
  });

  it("fails closed before transport when the credential is absent", async () => {
    const fetchImpl = vi.fn();
    const exit = await runStrixPrefixCacheProbe(ARGV, {
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async () => undefined,
      now: () => "2026-08-15T19:00:00.000Z",
      monotonicMs: () => 0,
      env: {},
      readFile: () => PROVENANCE,
      writePair: vi.fn(() => ({ jsonPath: "x", markdownPath: "y" })),
      sourceRevision: () => "e".repeat(40),
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(exit).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
