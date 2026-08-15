import { describe, expect, it } from "vitest";

import {
  parseStrixSpeculationPolicyArgs,
  synthesizeStrixSpeculationPolicy,
} from "../src/homeserver/strix-speculation-policy.js";

const baseProvenance = {
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
  cacheRamMiB: 8192,
  contextCheckpoints: 32,
  checkpointMinStep: 8192,
  cacheIdleSlots: "on" as const,
};

function summary(concurrency: number, useful: number, acceptanceRate: number | null = null) {
  return {
    fixtureId: "code",
    taskType: "code",
    concurrency,
    batches: 3,
    requests: 3,
    successfulRequests: 3,
    oraclePasses: 3,
    successRate: 1,
    oraclePassRate: 1,
    p50TtftMs: 100,
    p95TtftMs: 120,
    p50TotalMs: 1_000,
    p95TotalMs: 1_100,
    aggregateTokensPerSecond: useful,
    usefulCompletionsPerMinute: useful,
    promptTokensPerSecond: 1_000,
    predictedTokensPerSecond: useful,
    cacheHitRate: 0.66,
    acceptanceRate,
  };
}

function report(
  speculation: string,
  draftDepth: number | null,
  usefulByConcurrency: number[],
  acceptanceRate: number | null = 0.7,
) {
  return {
    schemaVersion: 1,
    model: "qwen38-27b",
    fixtureSha256: "e".repeat(64),
    provenance: {
      ...baseProvenance,
      serverArgsSha256: speculation === "none" ? "d".repeat(64) : "f".repeat(64 - String(draftDepth).length) + String(draftDepth),
      speculation,
      draftDepth,
    },
    summaries: usefulByConcurrency.map((useful, index) =>
      summary(index === 0 ? 1 : 16, useful, speculation === "none" ? null : acceptanceRate)),
  };
}

describe("Strix speculation policy synthesis", () => {
  it("parses repeated candidates and an explicit useful-work margin", () => {
    expect(parseStrixSpeculationPolicyArgs([
      "--direct", "direct.json",
      "--candidate", "mtp1.json",
      "--candidate", "mtp2.json",
      "--min-gain-percent", "3",
      "--out", "policy",
    ])).toEqual({
      directPath: "direct.json",
      candidatePaths: ["mtp1.json", "mtp2.json"],
      minimumUsefulWorkGain: 0.03,
      outPrefix: "policy",
    });
  });

  it("selects depth per workload cell and disables speculation when it loses", () => {
    const policy = synthesizeStrixSpeculationPolicy(
      report("none", null, [100, 100]),
      [
        report("draft-mtp", 1, [120, 130]),
        report("draft-mtp", 2, [150, 80]),
      ],
      0.03,
    );

    expect(policy.cells).toMatchObject([
      { concurrency: 1, selection: "speculative", speculation: "draft-mtp", draftDepth: 2, serverArgsSha256: "f".repeat(63) + "2", usefulWorkRatio: 1.5 },
      { concurrency: 16, selection: "speculative", speculation: "draft-mtp", draftDepth: 1, serverArgsSha256: "f".repeat(63) + "1", usefulWorkRatio: 1.3 },
    ]);

    const slower = synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [report("draft-dflash", 15, [99])],
      0,
    );
    expect(slower.cells[0]).toMatchObject({ selection: "direct", speculation: "none", draftDepth: null, serverArgsSha256: "d".repeat(64) });
    expect(slower.cells[0]?.reason).toMatch(/did not beat direct/i);
  });

  it("fails closed when quality regresses or acceptance is unobservable", () => {
    const qualityRegression = report("draft-mtp", 2, [150]);
    qualityRegression.summaries[0]!.oraclePassRate = 0.5;
    qualityRegression.summaries[0]!.oraclePasses = 1;

    const policy = synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [qualityRegression, report("draft-mtp", 1, [140], null)],
      0.03,
    );

    expect(policy.cells[0]).toMatchObject({ selection: "direct", speculation: "none" });
    expect(policy.cells[0]?.reason).toMatch(/no eligible speculative arm/i);
    expect(policy.cells[0]?.rejections).toEqual(expect.arrayContaining([
      expect.stringMatching(/quality/i),
      expect.stringMatching(/acceptance/i),
    ]));
  });

  it("rejects a non-direct control and uncontrolled candidate changes", () => {
    expect(() => synthesizeStrixSpeculationPolicy(
      report("draft-mtp", 1, [100]),
      [report("draft-mtp", 2, [120])],
      0.03,
    )).toThrow(/direct control/i);

    const changedBackend = report("draft-mtp", 1, [120]);
    changedBackend.provenance.backend = "hip";
    expect(() => synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [changedBackend],
      0.03,
    )).toThrow(/backend/i);
  });
});
