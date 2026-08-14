import { describe, expect, it, vi } from "vitest";

import { runStrixComparison } from "../scripts/compare-strix-benchmarks.js";

const provenance = {
  schemaVersion: 1,
  modelArtifactSha256: "a".repeat(64), runtimeCommit: "b".repeat(40),
  runtimeBinarySha256: "c".repeat(64), serverArgsSha256: "d".repeat(64),
  backend: "vulkan", quant: "Q4_K_M", kernel: "6.14", mesaVersion: "25.2", rocmVersion: null,
  contextSize: 65536, kvTypeK: "q8_0", kvTypeV: "q8_0", flashAttention: "on",
  batch: 2048, ubatch: 512, parallelism: 1, speculation: "none", draftDepth: null,
};
const summary = {
  fixtureId: "code", taskType: "code", concurrency: 1, batches: 1, requests: 1,
  successfulRequests: 1, oraclePasses: 1, successRate: 1, oraclePassRate: 1,
  p50TtftMs: 100, p95TtftMs: 100, p50TotalMs: 1000, p95TotalMs: 1000,
  aggregateTokensPerSecond: 80, usefulCompletionsPerMinute: 60,
  promptTokensPerSecond: 1000, predictedTokensPerSecond: 80, cacheHitRate: 0, acceptanceRate: null,
};

describe("runStrixComparison", () => {
  it("writes machine and human reports after the control check passes", () => {
    const control = JSON.stringify({ schemaVersion: 1, model: "qwen", fixtureSha256: "e".repeat(64), provenance, summaries: [summary] });
    const candidate = JSON.stringify({ schemaVersion: 1, model: "qwen", fixtureSha256: "e".repeat(64), provenance: { ...provenance, backend: "hip", runtimeBinarySha256: "f".repeat(64) }, summaries: [summary] });
    const write = vi.fn();
    const exit = runStrixComparison([
      "--control", "a.json", "--candidate", "b.json", "--axis", "backend", "--out", "/tmp/comparison",
    ], {
      readFile: (path) => path === "a.json" ? control : candidate,
      write,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });
    expect(exit).toBe(0);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![1]).toContain("No automatic winner");
  });
});
