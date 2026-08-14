import { describe, expect, it } from "vitest";

import {
  compareStrixServerReports,
  parseStrixComparisonArgs,
  renderStrixComparisonMarkdown,
} from "../src/homeserver/strix-benchmark-comparison.js";

const provenance = {
  schemaVersion: 1 as const,
  modelArtifactSha256: "a".repeat(64),
  runtimeCommit: "b".repeat(40),
  runtimeBinarySha256: "c".repeat(64),
  serverArgsSha256: "d".repeat(64),
  backend: "vulkan" as const,
  quant: "Q4_K_M",
  kernel: "6.14.0",
  mesaVersion: "25.2.0",
  rocmVersion: "7.2.1",
  contextSize: 65536,
  kvTypeK: "q8_0",
  kvTypeV: "q8_0",
  flashAttention: "on" as const,
  batch: 2048,
  ubatch: 512,
  parallelism: 1,
  speculation: "none",
  draftDepth: null,
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    model: "qwen3.6",
    fixtureSha256: "e".repeat(64),
    provenance,
    summaries: [{
      fixtureId: "code", taskType: "code", concurrency: 1, batches: 3, requests: 3,
      successfulRequests: 3, oraclePasses: 3, successRate: 1, oraclePassRate: 1,
      p50TtftMs: 100, p95TtftMs: 120, p50TotalMs: 1000, p95TotalMs: 1100,
      aggregateTokensPerSecond: 80, usefulCompletionsPerMinute: 60,
      promptTokensPerSecond: 1000, predictedTokensPerSecond: 80,
      cacheHitRate: 0.66, acceptanceRate: null,
    }],
    ...overrides,
  };
}

describe("Strix benchmark comparison", () => {
  it("parses an explicit one-axis comparison", () => {
    expect(parseStrixComparisonArgs([
      "--control", "control.json", "--candidate", "candidate.json", "--axis", "backend", "--out", "result",
    ])).toEqual({ controlPath: "control.json", candidatePath: "candidate.json", axis: "backend", outPrefix: "result" });
  });

  it("fails closed when a supposedly controlled field changes", () => {
    const candidate = report({ provenance: { ...provenance, backend: "hip", quant: "Q5_K_M" } });
    expect(() => compareStrixServerReports(report(), candidate, "backend")).toThrow(/quant/);
  });

  it("compares identical workload cells and preserves quality as a separate gate", () => {
    const candidate = report({
      provenance: { ...provenance, backend: "hip", runtimeBinarySha256: "f".repeat(64), serverArgsSha256: "1".repeat(64) },
      summaries: [{
        ...report().summaries[0], p95TtftMs: 90, promptTokensPerSecond: 1300,
        predictedTokensPerSecond: 70, aggregateTokensPerSecond: 70, usefulCompletionsPerMinute: 66,
      }],
    });
    const comparison = compareStrixServerReports(report(), candidate, "backend");
    expect(comparison.rows[0]).toMatchObject({
      fixtureId: "code",
      qualityNonInferior: true,
      p95TtftRatio: 0.75,
      promptThroughputRatio: 1.3,
      predictedThroughputRatio: 0.875,
      usefulWorkRatio: 1.1,
    });
    expect(renderStrixComparisonMarkdown(comparison)).toContain("No automatic winner");
  });

  it("rejects missing cells instead of silently comparing unequal workloads", () => {
    const other = report({
      provenance: { ...provenance, backend: "hip", runtimeBinarySha256: "f".repeat(64) },
      summaries: [{ ...report().summaries[0], fixtureId: "other" }],
    });
    expect(() => compareStrixServerReports(report(), other, "backend")).toThrow(/cell set/);
  });
});
