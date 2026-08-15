import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildStrixBenchmarkArgv,
  buildStrixKvRunPlans,
  executeStrixCombinedExperiment,
  evaluateStrixKvMicrobenchmarks,
  parseStrixCombinedArgs,
  validateStrixKvCandidateConfig,
} from "../src/homeserver/strix-combined-experiment.js";

function fixture(): unknown {
  return JSON.parse(readFileSync("configs/strix-kv-dequant-qwen36.json", "utf8"));
}

describe("Strix combined experiment contract", () => {
  it("validates the pinned candidate and creates two mirrored causal cycles", () => {
    const config = validateStrixKvCandidateConfig(fixture());
    const plans = buildStrixKvRunPlans(config, "/evidence");
    expect(plans.map((plan) => plan.arm.id)).toEqual([
      "production-f16-kv", "production-q8-kv", "candidate-q8-kv",
      "candidate-q8-kv", "production-q8-kv", "production-f16-kv",
    ]);
    expect(plans.map((plan) => plan.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plans.filter((plan) => plan.arm.runtime === "candidate").every((plan) =>
      plan.expectedRuntimeCommit === config.candidateRuntime.backportCommit
    )).toBe(true);
  });

  it("builds direct benchmark argv with arm-specific runtime and KV but common controls", () => {
    const config = validateStrixKvCandidateConfig(fixture());
    const candidatePlan = buildStrixKvRunPlans(config, "/evidence")[2]!;
    const argv = buildStrixBenchmarkArgv(config, candidatePlan);
    expect(argv).toContain(config.candidateRuntime.llamaBenchPath);
    expect(argv.slice(argv.indexOf("--kv-k"), argv.indexOf("--kv-k") + 4)).toEqual(["--kv-k", "q8_0", "--kv-v", "q8_0"]);
    expect(argv).toContain("8192,32768,65536,131072");
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("bash");
  });

  it("fails closed when causal arms, contexts, cycles, or deployment status drift", () => {
    const base = fixture() as Record<string, any>;
    const mutate = (fn: (copy: Record<string, any>) => void): unknown => {
      const copy = structuredClone(base);
      fn(copy);
      return copy;
    };
    expect(() => validateStrixKvCandidateConfig(mutate((copy) => copy.localExperiment.arms.reverse()))).toThrow(/causal arms/);
    expect(() => validateStrixKvCandidateConfig(mutate((copy) => copy.localExperiment.contexts.push(65536)))).toThrow(/duplicates/);
    expect(() => validateStrixKvCandidateConfig(mutate((copy) => { copy.promotionGate.minimumCycles = 1; }))).toThrow(/at least 2/);
    expect(() => validateStrixKvCandidateConfig(mutate((copy) => { copy.promotionGate.deploymentStatus = "authorized"; }))).toThrow(/must not claim/);
  });

  it("requires the complete explicit exclusive-window CLI object", () => {
    const argv = [
      "--config", "candidate.json",
      "--mmap-config", "mmap.json",
      "--out-dir", "/evidence",
      "--expected-resident-model", "resident",
      "--max-runtime-seconds", "6300",
      "--ack-exclusive-window",
    ];
    expect(parseStrixCombinedArgs(argv)).toMatchObject({
      expectedResidentModel: "resident",
      maxRuntimeSeconds: 6300,
      ackExclusiveWindow: true,
    });
    expect(() => parseStrixCombinedArgs(argv.filter((item) => item !== "--ack-exclusive-window"))).toThrow(/ack-exclusive/);
    expect(() => parseStrixCombinedArgs([...argv, "--config", "other.json"])).toThrow(/duplicate/);
    expect(() => parseStrixCombinedArgs(argv.flatMap((item) => item === "resident" ? ["none"] : [item]))).not.toThrow();
    expect(() => parseStrixCombinedArgs(argv.flatMap((item) => item === "resident" ? ["bad value"] : [item]))).toThrow(/unsafe/);
    expect(() => parseStrixCombinedArgs(argv.filter((item, index) => argv[index - 1] !== "--max-runtime-seconds" && item !== "--max-runtime-seconds"))).toThrow(/max-runtime/);
    expect(() => parseStrixCombinedArgs(argv.map((item, index) => argv[index - 1] === "--max-runtime-seconds" ? "0" : item))).toThrow(/max-runtime/);
  });

  it("keeps mmap outcome separate, runs correctness first, and restores exact residency", async () => {
    const config = validateStrixKvCandidateConfig(fixture());
    const args = parseStrixCombinedArgs([
      "--config", "candidate.json", "--mmap-config", "mmap.json", "--out-dir", "/evidence",
      "--expected-resident-model", "resident", "--max-runtime-seconds", "6300", "--ack-exclusive-window",
    ]);
    const events: string[] = [];
    const result = await executeStrixCombinedExperiment(config, args, {
      snapshot: async () => [{ model: "resident", state: "ready" }],
      runMmap: async () => { events.push("mmap-reject"); return 2; },
      unload: async () => { events.push("unload"); },
      runBackendCorrectness: async () => { events.push("backend"); },
      runBenchmark: async (plan) => {
        events.push(plan.arm.id);
        return { cycle: plan.cycle, sequence: plan.sequence, armId: plan.arm.id, reportPath: `${plan.outPrefix}.json` };
      },
      restore: async () => { events.push("restore"); },
      interruptedBy: () => null,
    });
    expect(events).toEqual([
      "mmap-reject", "unload", "backend",
      "production-f16-kv", "production-q8-kv", "candidate-q8-kv",
      "candidate-q8-kv", "production-q8-kv", "production-f16-kv", "restore",
    ]);
    expect(result).toMatchObject({ mmapExitCode: 2, restored: true, deploymentStatus: "not-authorized-by-evidence" });
  });

  it("restores on benchmark failure and reports a simultaneous restoration failure", async () => {
    const config = validateStrixKvCandidateConfig(fixture());
    const args = parseStrixCombinedArgs([
      "--config", "candidate.json", "--mmap-config", "mmap.json", "--out-dir", "/evidence",
      "--expected-resident-model", "resident", "--max-runtime-seconds", "6300", "--ack-exclusive-window",
    ]);
    let restored = false;
    const dependencies = {
      snapshot: async () => [{ model: "resident", state: "ready" }],
      runMmap: async () => 0,
      unload: async () => {},
      runBackendCorrectness: async () => {},
      runBenchmark: async () => { throw new Error("benchmark failed"); },
      restore: async () => { restored = true; },
      interruptedBy: () => null,
    };
    await expect(executeStrixCombinedExperiment(config, args, dependencies)).rejects.toThrow("benchmark failed");
    expect(restored).toBe(true);
    await expect(executeStrixCombinedExperiment(config, args, {
      ...dependencies,
      restore: async () => { throw new Error("restore failed"); },
    })).rejects.toThrow(/both failed/);
  });

  it("fails after restoration when the runtime deadline arrives during restoration", async () => {
    const config = validateStrixKvCandidateConfig(fixture());
    const args = parseStrixCombinedArgs([
      "--config", "candidate.json", "--mmap-config", "mmap.json", "--out-dir", "/evidence",
      "--expected-resident-model", "resident", "--max-runtime-seconds", "6300", "--ack-exclusive-window",
    ]);
    let interruptedBy: string | null = null;
    await expect(executeStrixCombinedExperiment(config, args, {
      snapshot: async () => [{ model: "resident", state: "ready" }],
      runMmap: async () => 0,
      unload: async () => {},
      runBackendCorrectness: async () => {},
      runBenchmark: async (plan) => ({
        cycle: plan.cycle,
        sequence: plan.sequence,
        armId: plan.arm.id,
        reportPath: `${plan.outPrefix}.json`,
      }),
      restore: async () => { interruptedBy = "SIGTERM"; },
      interruptedBy: () => interruptedBy,
    })).rejects.toThrow(/interrupted by SIGTERM/);
  });

  it("advances only a complete two-cycle result with long-context PP gains and no regressions", () => {
    const config = validateStrixKvCandidateConfig(fixture());
    const makeResults = (ppFactor: number, tgFactor: number) => [0, ...config.localExperiment.contexts].flatMap((depth) => [
      { phase: "pp" as const, contextDepth: depth, tokens: 512, tokensPerSecond: 100 * ppFactor, tokensPerSecondStddev: 1, ttftMs: null, acceptanceRate: null },
      { phase: "tg" as const, contextDepth: depth, tokens: 128, tokensPerSecond: 100 * tgFactor, tokensPerSecondStddev: 1, ttftMs: null, acceptanceRate: null },
    ]);
    const runs = [0, 1].flatMap((cycle) => [
      { cycle, armId: "production-f16-kv" as const, peakRssBytes: 100, maxTemperatureC: 70, results: makeResults(1, 1) },
      { cycle, armId: "production-q8-kv" as const, peakRssBytes: 90, maxTemperatureC: 69, results: makeResults(1, 1) },
      { cycle, armId: "candidate-q8-kv" as const, peakRssBytes: 90, maxTemperatureC: 69, results: makeResults(1.2, 1) },
    ]);
    expect(evaluateStrixKvMicrobenchmarks(config, runs)).toMatchObject({
      decision: "advance-to-agent-gate",
      deploymentAuthorized: false,
    });
    const regressed = structuredClone(runs);
    const target = regressed.find((run) => run.armId === "candidate-q8-kv" && run.cycle === 1)!.results
      .find((cell) => cell.phase === "tg" && cell.contextDepth === 65536)!;
    target.tokensPerSecond = 80;
    expect(evaluateStrixKvMicrobenchmarks(config, regressed)).toMatchObject({ decision: "reject" });
  });
});
