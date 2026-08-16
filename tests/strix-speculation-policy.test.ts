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
  serverArgsInvariantSha256: "9".repeat(64),
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
  const batches = 3;
  const requests = batches * concurrency;
  return {
    fixtureId: "code",
    taskType: "code",
    concurrency,
    batches,
    requests,
    successfulRequests: requests,
    oraclePasses: requests,
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
  const summaries = usefulByConcurrency.map((useful, index) =>
    summary(index === 0 ? 1 : 16, useful, speculation === "none" ? null : acceptanceRate));
  const batches = summaries.flatMap((item) => Array.from({ length: item.batches }, (_, repetition) => ({
    fixtureId: item.fixtureId,
    taskType: item.taskType,
    concurrency: item.concurrency,
    repetition,
    wallMs: item.concurrency / (item.usefulCompletionsPerMinute / 60_000),
    speculation: speculation === "none" || acceptanceRate === null ? null : {
      draftTokens: 100,
      acceptedTokens: acceptanceRate * 100,
      verificationSteps: 10,
      acceptanceRate,
    },
    requests: Array.from({ length: item.concurrency }, () => ({
      ok: true,
      oraclePass: true,
      outputSha256: "a".repeat(64) as string | null,
    })),
  })));
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
    batches,
    summaries,
  };
}

function recomputeSummaryFromBatches(value: ReturnType<typeof report>): void {
  for (const item of value.summaries) {
    const batches = value.batches.filter((batch) =>
      batch.fixtureId === item.fixtureId && batch.taskType === item.taskType && batch.concurrency === item.concurrency);
    const requests = batches.flatMap((batch) => batch.requests);
    const successful = requests.filter((request) => request.ok).length;
    const oraclePasses = requests.filter((request) => request.oraclePass).length;
    const wallMs = batches.reduce((sum, batch) => sum + batch.wallMs, 0);
    item.batches = batches.length;
    item.requests = requests.length;
    item.successfulRequests = successful;
    item.oraclePasses = oraclePasses;
    item.successRate = requests.length === 0 ? 0 : successful / requests.length;
    item.oraclePassRate = requests.length === 0 ? 0 : oraclePasses / requests.length;
    item.usefulCompletionsPerMinute = wallMs === 0 ? 0 : oraclePasses / (wallMs / 60_000);
  }
}

describe("Strix speculation policy synthesis", () => {
  it("parses repeated candidates and an explicit useful-work margin", () => {
    expect(parseStrixSpeculationPolicyArgs([
      "--direct", "direct.json",
      "--candidate", "mtp1.json",
      "--candidate", "mtp2.json",
      "--min-gain-percent", "3",
      "--min-batches", "4",
      "--out", "policy",
    ])).toEqual({
      directPath: "direct.json",
      candidatePaths: ["mtp1.json", "mtp2.json"],
      minimumUsefulWorkGain: 0.03,
      minimumBatches: 4,
      outPrefix: "policy",
    });

    for (const duplicate of ["--direct", "--min-gain-percent", "--min-batches", "--out"]) {
      const value = duplicate === "--min-gain-percent" ? "4" : duplicate === "--min-batches" ? "5" : "other";
      const args = ["--direct", "direct.json", "--candidate", "mtp1.json", "--out", "policy"];
      if (duplicate === "--direct" || duplicate === "--out") args.push(duplicate, value);
      else args.push(duplicate, value, duplicate, value);
      expect(() => parseStrixSpeculationPolicyArgs(args)).toThrow(/duplicate/i);
    }
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
      { concurrency: 1, selection: "speculative", speculation: "draft-mtp", draftDepth: 2, serverArgsSha256: "f".repeat(63) + "2", usefulWorkRatio: 1.5, minimumRepetitionUsefulWorkRatio: 1.5 },
      { concurrency: 16, selection: "speculative", speculation: "draft-mtp", draftDepth: 1, serverArgsSha256: "f".repeat(63) + "1", usefulWorkRatio: 1.3, minimumRepetitionUsefulWorkRatio: 1.3 },
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
    for (const batch of qualityRegression.batches) {
      for (const request of batch.requests) request.oraclePass = false;
    }
    recomputeSummaryFromBatches(qualityRegression);

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

  it("fails closed for under-sampled, unbalanced, or internally inconsistent evidence", () => {
    const direct = report("none", null, [100]);
    const oneBatch = report("draft-mtp", 1, [200]);
    oneBatch.batches = oneBatch.batches.slice(0, 1);
    recomputeSummaryFromBatches(oneBatch);
    const underSampled = synthesizeStrixSpeculationPolicy(direct, [oneBatch], 0.03, 3);
    expect(underSampled.cells[0]).toMatchObject({ selection: "direct", evidenceSufficient: true });
    expect(underSampled.cells[0]?.rejections).toEqual(expect.arrayContaining([expect.stringMatching(/minimum 3 batches/i)]));

    const unbalanced = report("draft-mtp", 1, [200]);
    unbalanced.batches.push({
      ...unbalanced.batches[0]!,
      repetition: 3,
      requests: [{ ok: true, oraclePass: true, outputSha256: "a".repeat(64) }],
    });
    recomputeSummaryFromBatches(unbalanced);
    const unbalancedPolicy = synthesizeStrixSpeculationPolicy(direct, [unbalanced], 0.03, 3);
    expect(unbalancedPolicy.cells[0]?.rejections).toEqual(expect.arrayContaining([expect.stringMatching(/balanced exposure/i)]));

    const impossibleAcceptance = report("draft-mtp", 1, [200], 1.5);
    const inconsistentPolicy = synthesizeStrixSpeculationPolicy(direct, [impossibleAcceptance], 0.03, 3);
    expect(inconsistentPolicy.cells[0]?.rejections).toEqual(expect.arrayContaining([expect.stringMatching(/acceptance.*between 0 and 1/i)]));

    const fractionalCounters = report("draft-mtp", 1, [200]);
    fractionalCounters.batches[0]!.speculation!.draftTokens = 100.5;
    expect(() => synthesizeStrixSpeculationPolicy(direct, [fractionalCounters], 0.03, 3)).toThrow(/draftTokens.*integer/i);
  });

  it("rejects an aggregate winner when any paired repetition is slower than direct", () => {
    const direct = report("none", null, [100]);
    const unstable = report("draft-mtp", 2, [120]);
    const directWall = direct.batches[0]!.wallMs;
    unstable.batches[0]!.wallMs = directWall / 1.5;
    unstable.batches[1]!.wallMs = directWall / 0.9;
    unstable.batches[2]!.wallMs = directWall / 1.5;
    recomputeSummaryFromBatches(unstable);
    expect(unstable.summaries[0]!.usefulCompletionsPerMinute).toBeGreaterThan(103);

    const policy = synthesizeStrixSpeculationPolicy(direct, [unstable], 0.03, 3);
    expect(policy.cells[0]).toMatchObject({ selection: "direct", minimumRepetitionUsefulWorkRatio: null });
    expect(policy.cells[0]?.rejections).toEqual(expect.arrayContaining([expect.stringMatching(/repetition 1.*slower/i)]));
  });

  it("rejects a faster arm when any paired greedy output hash differs from direct", () => {
    const candidate = report("draft-mtp", 2, [150]);
    candidate.batches[1]!.requests[0]!.outputSha256 = "b".repeat(64);

    const policy = synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [candidate],
      0.03,
    );

    expect(policy.cells[0]).toMatchObject({ selection: "direct", evidenceSufficient: true });
    expect(policy.cells[0]?.rejections).toEqual(expect.arrayContaining([
      expect.stringMatching(/repetition 1.*request 0.*output hash.*direct/i),
    ]));
  });

  it("rejects successful requests whose output equivalence is unobservable", () => {
    const candidate = report("draft-mtp", 2, [150]);
    candidate.batches[0]!.requests[0]!.outputSha256 = null;

    const policy = synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [candidate],
      0.03,
    );

    expect(policy.cells[0]).toMatchObject({ selection: "direct", evidenceSufficient: true });
    expect(policy.cells[0]?.rejections).toEqual(expect.arrayContaining([
      expect.stringMatching(/successful.*no output hash/i),
    ]));

    const malformed = report("draft-mtp", 2, [150]);
    malformed.batches[0]!.requests[0]!.outputSha256 = "NOT-A-SHA256";
    expect(() => synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [malformed],
      0.03,
    )).toThrow(/lowercase SHA-256 or null/i);
  });

  it("marks the policy evidence insufficient when the direct control is malformed", () => {
    const direct = report("none", null, [100]);
    direct.summaries[0]!.requests = 2;
    const policy = synthesizeStrixSpeculationPolicy(direct, [report("draft-mtp", 1, [200])], 0.03, 3);
    expect(policy.cells[0]).toMatchObject({
      selection: "direct",
      evidenceSufficient: false,
      directBatches: 3,
      directRequests: 2,
    });
    expect(policy.cells[0]?.reason).toMatch(/direct evidence is insufficient/i);
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

    const changedInvariantArgs = report("draft-mtp", 1, [120]);
    changedInvariantArgs.provenance.serverArgsInvariantSha256 = "8".repeat(64);
    expect(() => synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [changedInvariantArgs],
      0.03,
    )).toThrow(/server arguments.*outside.*speculation/i);

    const unchangedFullArgs = report("draft-mtp", 1, [120]);
    unchangedFullArgs.provenance.serverArgsSha256 = "d".repeat(64);
    expect(() => synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [unchangedFullArgs],
      0.03,
    )).toThrow(/server arguments.*did not change/i);
  });

  it("rejects duplicate workload cells instead of silently collapsing evidence", () => {
    const duplicated = report("none", null, [100]);
    duplicated.summaries.push({ ...duplicated.summaries[0]! });
    expect(() => synthesizeStrixSpeculationPolicy(
      duplicated,
      [report("draft-mtp", 1, [120])],
      0.03,
    )).toThrow(/duplicate.*cell/i);
  });

  it("rejects raw repetition cells that have no matching summary", () => {
    const candidate = report("draft-mtp", 1, [120]);
    candidate.batches.push({
      ...candidate.batches[0]!,
      fixtureId: "hidden",
      requests: [{ ok: true, oraclePass: true, outputSha256: "a".repeat(64) }],
    });
    expect(() => synthesizeStrixSpeculationPolicy(
      report("none", null, [100]),
      [candidate],
      0.03,
    )).toThrow(/raw batch cell.*matching summary/i);
  });
});
