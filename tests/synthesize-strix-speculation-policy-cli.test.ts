import { describe, expect, it, vi } from "vitest";

import { runStrixSpeculationPolicySynthesis } from "../scripts/synthesize-strix-speculation-policy.js";

const provenance = {
  schemaVersion: 1,
  modelArtifactSha256: "a".repeat(64), runtimeCommit: "b".repeat(40),
  runtimeBinarySha256: "c".repeat(64), serverArgsSha256: "d".repeat(64),
  backend: "vulkan", quant: "Q4_K_M", kernel: "6.14", mesaVersion: "25.2", rocmVersion: null,
  contextSize: 65536, kvTypeK: "q8_0", kvTypeV: "q8_0", flashAttention: "on",
  batch: 2048, ubatch: 512, parallelism: 1, speculation: "none", draftDepth: null,
  cacheRamMiB: 8192, contextCheckpoints: 32, checkpointMinStep: 8192, cacheIdleSlots: "on",
};
const summary = {
  fixtureId: "code", taskType: "code", concurrency: 1, batches: 3, requests: 3,
  successfulRequests: 3, oraclePasses: 3, successRate: 1, oraclePassRate: 1,
  p50TtftMs: 100, p95TtftMs: 100, p50TotalMs: 1_000, p95TotalMs: 1_000,
  aggregateTokensPerSecond: 80, usefulCompletionsPerMinute: 60,
  promptTokensPerSecond: 1_000, predictedTokensPerSecond: 80, cacheHitRate: 0, acceptanceRate: null,
};

describe("runStrixSpeculationPolicySynthesis", () => {
  it("writes content-blind machine and human policy artifacts", () => {
    const direct = JSON.stringify({
      schemaVersion: 1, model: "qwen", fixtureSha256: "e".repeat(64), provenance, summaries: [summary],
    });
    const candidate = JSON.stringify({
      schemaVersion: 1,
      model: "qwen",
      fixtureSha256: "e".repeat(64),
      provenance: { ...provenance, speculation: "draft-mtp", draftDepth: 2, serverArgsSha256: "f".repeat(64) },
      summaries: [{ ...summary, aggregateTokensPerSecond: 100, predictedTokensPerSecond: 100, usefulCompletionsPerMinute: 75, acceptanceRate: 0.7 }],
    });
    const write = vi.fn();
    const stdout = vi.fn();
    const exit = runStrixSpeculationPolicySynthesis([
      "--direct", "direct.json", "--candidate", "mtp2.json", "--min-batches", "3", "--out", "/tmp/policy",
    ], {
      readFile: (path) => path === "direct.json" ? direct : candidate,
      write,
      stdout,
      stderr: vi.fn(),
    });

    expect(exit).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]![1]).toContain('"selection": "speculative"');
    expect(write.mock.calls[1]![1]).toContain("offline policy");
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"speculativeCells":1'));
  });
});
