import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { preflightStrixSpeculationArtifacts } from "../scripts/strix-speculation-experiment.js";

import {
  buildStrixSpeculationRunPlans,
  executeStrixSpeculationExperiment,
  mergeStrixSpeculationCycleReports,
  parseStrixSpeculationExperimentArgs,
  validateStrixSpeculationExperimentConfig,
} from "../src/homeserver/strix-speculation-experiment.js";

function fixture(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "hardware-validation-pending",
    runtime: {
      commit: "a".repeat(40),
      binaryPath: "/runtime/bin/llama-server",
      binarySha256: "b".repeat(64),
      vulkanLibraryPath: "/runtime/lib/libggml-vulkan.so",
      vulkanLibrarySha256: "c".repeat(64),
    },
    model: {
      id: "qwen38-27b",
      path: "/models/qwen38.gguf",
      artifactSha256: "d".repeat(64),
      quant: "Q4_K_M",
      mmprojPath: "/models/qwen38-mmproj.gguf",
      mmprojSha256: "e".repeat(64),
    },
    server: {
      port: 5919,
      backend: "vulkan",
      contextSize: 65_536,
      kvTypeK: "q8_0",
      kvTypeV: "q8_0",
      flashAttention: "on",
      batch: 2_048,
      ubatch: 512,
      parallelism: 1,
      cacheRamMiB: 2_048,
      contextCheckpoints: 32,
      checkpointMinStep: 8_192,
      cacheIdleSlots: "off",
      commonArgs: ["-ngl", "999", "--jinja", "--reasoning-format", "auto", "--reasoning", "auto"],
    },
    benchmark: {
      fixturesPath: "/experiment/strix-agent-fixtures.json",
      fixturesSha256: "f".repeat(64),
      concurrency: [1, 16],
      maxTokens: 128,
      timeoutMs: 300_000,
      speculativeDepths: [1, 2],
      minimumUsefulWorkGainPercent: 3,
    },
    promotionGate: { deploymentStatus: "not-authorized-by-evidence" },
  };
}

function cycleReport(serverArgsSha256: string, speculation: "none" | "draft-mtp", draftDepth: number | null, wallMs: number): Record<string, unknown> {
  const request = {
    ok: true, oraclePass: true, ttftMs: 10, totalMs: wallMs,
    promptTokens: 10, completionTokens: 10, promptTokensPerSecond: 100,
    predictedTokensPerSecond: 50, cachedPromptTokens: 0,
    outputSha256: "9".repeat(64), finishReason: "stop", errorClass: null,
  };
  const batch = {
    fixtureId: "code_fix", taskType: "code", concurrency: 1, repetition: 0,
    wallMs, speculation: speculation === "none" ? null : {
      draftTokens: 10, acceptedTokens: 8, verificationSteps: 4, acceptanceRate: 0.8,
    }, requests: [request],
  };
  return {
    schemaVersion: 1, startedAt: "2026-08-15T22:00:00.000Z", finishedAt: "2026-08-15T22:01:00.000Z",
    endpointOrigin: "http://127.0.0.1:5919", model: "qwen38-27b",
    fixtureSha256: "f".repeat(64), provenanceSha256: "8".repeat(64),
    provenance: {
      schemaVersion: 1, modelArtifactSha256: "d".repeat(64), runtimeCommit: "a".repeat(40),
      runtimeBinarySha256: "b".repeat(64), serverArgsSha256, backend: "vulkan", quant: "Q4_K_M",
      kernel: "test", mesaVersion: "test", rocmVersion: null, contextSize: 65_536,
      kvTypeK: "q8_0", kvTypeV: "q8_0", flashAttention: "on", batch: 2_048,
      ubatch: 512, parallelism: 1, speculation, draftDepth, cacheRamMiB: 2_048,
      contextCheckpoints: 32, checkpointMinStep: 8_192, cacheIdleSlots: "off",
    },
    configuration: { concurrency: [1], repetitions: 1, maxTokens: 128, timeoutMs: 300_000, metricsEnabled: true },
    batches: [batch],
    summaries: [{
      fixtureId: "code_fix", taskType: "code", concurrency: 1, batches: 1, requests: 1,
      successfulRequests: 1, oraclePasses: 1, successRate: 1, oraclePassRate: 1,
      p50TtftMs: 10, p95TtftMs: 10, p50TotalMs: wallMs, p95TotalMs: wallMs,
      aggregateTokensPerSecond: 10 / (wallMs / 1000), usefulCompletionsPerMinute: 60_000 / wallMs,
      promptTokensPerSecond: 100, predictedTokensPerSecond: 50, cacheHitRate: 0,
      acceptanceRate: speculation === "none" ? null : 0.8,
    }], measurementLimits: [],
  };
}

describe("Strix speculation experiment contract", () => {
  it("preflights every exact artifact before residency can be unloaded", async () => {
    const root = mkdtempSync(join(tmpdir(), "strix-spec-preflight-"));
    try {
      const raw = fixture() as any;
      const files = {
        binary: join(root, "llama-server"), vulkan: join(root, "libggml-vulkan.so"),
        model: join(root, "model.gguf"), mmproj: join(root, "mmproj.gguf"), fixtures: join(root, "fixtures.json"),
      };
      const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
      for (const [label, path] of Object.entries(files)) writeFileSync(path, label);
      chmodSync(files.binary, 0o755);
      raw.runtime.binaryPath = files.binary; raw.runtime.binarySha256 = digest("binary");
      raw.runtime.vulkanLibraryPath = files.vulkan; raw.runtime.vulkanLibrarySha256 = digest("vulkan");
      raw.model.path = files.model; raw.model.artifactSha256 = digest("model");
      raw.model.mmprojPath = files.mmproj; raw.model.mmprojSha256 = digest("mmproj");
      raw.benchmark.fixturesPath = files.fixtures; raw.benchmark.fixturesSha256 = digest("fixtures");
      const config = validateStrixSpeculationExperimentConfig(raw);
      await expect(preflightStrixSpeculationArtifacts(config, {
        version: () => `llama.cpp ${config.runtime.commit.slice(0, 8)}`,
        kernel: () => "test-kernel", mesa: () => "test-mesa", rocm: () => null,
      })).resolves.toMatchObject({ hashes: { model: digest("model"), fixtures: digest("fixtures") }, kernel: "test-kernel" });
      raw.model.artifactSha256 = "0".repeat(64);
      await expect(preflightStrixSpeculationArtifacts(validateStrixSpeculationExperimentConfig(raw), {
        version: () => `llama.cpp ${config.runtime.commit.slice(0, 8)}`,
        kernel: () => "test", mesa: () => null, rocm: () => null,
      })).rejects.toThrow(/model hash differs/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("validates exact artifacts and creates a position-balanced Latin rotation", () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const plans = buildStrixSpeculationRunPlans(config, "/evidence");

    expect(plans.map((plan) => plan.arm.id)).toEqual([
      "direct", "draft-mtp-1", "draft-mtp-2",
      "draft-mtp-1", "draft-mtp-2", "direct",
      "draft-mtp-2", "direct", "draft-mtp-1",
    ]);
    expect(plans.map((plan) => plan.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(plans.map((plan) => plan.cycle))).toEqual(new Set([0, 1, 2]));
    for (const armId of ["direct", "draft-mtp-1", "draft-mtp-2"]) {
      const positions = plans.filter((plan) => plan.arm.id === armId).map((plan) => plan.position).sort();
      expect(positions).toEqual([0, 1, 2]);
    }
  });

  it("builds deterministic argv and controls every speculation-sensitive flag", () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const plans = buildStrixSpeculationRunPlans(config, "/evidence");
    const direct = plans[0]!;
    const depthOne = plans[1]!;

    expect(direct.serverArgv[0]).toBe(config.runtime.binaryPath);
    expect(direct.serverArgv).not.toContain("--spec-type");
    expect(direct.serverArgv).not.toContain("--spec-draft-n-max");
    expect(depthOne.serverArgv).toContain("draft-mtp");
    expect(depthOne.serverArgv.slice(depthOne.serverArgv.indexOf("--spec-draft-n-max"))).toEqual(["--spec-draft-n-max", "1"]);
    expect(depthOne.serverArgv).toEqual(expect.arrayContaining([
      "--host", "127.0.0.1", "--port", "5919", "-m", config.model.path,
      "-mm", config.model.mmprojPath!, "-c", "65536", "-ctk", "q8_0", "-ctv", "q8_0",
      "-fa", "on", "-b", "2048", "-ub", "512", "-np", "1", "--cache-ram", "2048", "--metrics",
    ]));
    expect(depthOne.serverArgsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(depthOne.outPrefix).toBe("/evidence/cycle-00-position-01-draft-mtp-1");
  });

  it("rejects uncontrolled flags, malformed arms, unsafe paths, and false deployment authority", () => {
    const mutate = (change: (copy: any) => void): unknown => {
      const copy = structuredClone(fixture());
      change(copy);
      return copy;
    };
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => copy.server.commonArgs.push("--spec-type", "draft-mtp")))).toThrow(/controlled.*spec-type/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.benchmark.speculativeDepths = [2, 1]; }))).toThrow(/strictly increasing/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.benchmark.speculativeDepths = [1]; }))).toThrow(/at least two/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.model.path = "relative.gguf"; }))).toThrow(/absolute/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.promotionGate.deploymentStatus = "authorized"; }))).toThrow(/must not claim/i);
  });

  it("requires an explicit bounded exclusive-window CLI object", () => {
    const argv = [
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ];
    expect(parseStrixSpeculationExperimentArgs(argv)).toMatchObject({
      expectedResidentModel: "qwen38-27b",
      maxRuntimeSeconds: 7200,
      ackExclusiveWindow: true,
    });
    expect(() => parseStrixSpeculationExperimentArgs(argv.filter((value) => value !== "--ack-exclusive-window"))).toThrow(/ack-exclusive/i);
    expect(() => parseStrixSpeculationExperimentArgs([...argv, "--config", "other.json"])).toThrow(/duplicate/i);
    expect(() => parseStrixSpeculationExperimentArgs(argv.map((value) => value === "qwen38-27b" ? "bad value" : value))).toThrow(/safe model/i);
    expect(() => parseStrixSpeculationExperimentArgs(argv.map((value) => value === "7200" ? "0" : value))).toThrow(/max-runtime/i);
  });

  it("runs every balanced arm, restores exact residency, and never authorizes deployment", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    const events: string[] = [];
    let restored = false;
    const result = await executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => [{ model: "qwen38-27b", state: "ready" }],
      unload: async () => { events.push("unload"); },
      runArm: async (plan) => {
        events.push(plan.arm.id);
        return { cycle: plan.cycle, position: plan.position, sequence: plan.sequence, armId: plan.arm.id, reportPath: `${plan.outPrefix}.json` };
      },
      restore: async () => { restored = true; events.push("restore"); },
      interruptedBy: () => null,
    });

    expect(events).toEqual([
      "unload",
      "direct", "draft-mtp-1", "draft-mtp-2",
      "draft-mtp-1", "draft-mtp-2", "direct",
      "draft-mtp-2", "direct", "draft-mtp-1",
      "restore",
    ]);
    expect(restored).toBe(true);
    expect(result).toMatchObject({ restored: true, deploymentStatus: "not-authorized-by-evidence" });
    expect(result.runs).toHaveLength(9);
  });

  it("merges each arm's Latin cycles into paired repetitions and recomputes summaries", () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const plans = buildStrixSpeculationRunPlans(config, "/evidence");
    const arm = plans.find((plan) => plan.arm.id === "draft-mtp-1")!.arm;
    const sha = plans.find((plan) => plan.arm.id === arm.id)!.serverArgsSha256;
    const merged = mergeStrixSpeculationCycleReports(config, arm, [0, 1, 2].map((cycle) => ({
      cycle, armId: arm.id, report: cycleReport(sha, "draft-mtp", 1, 1_000 + cycle * 100),
    })));

    expect(merged.batches.map((batch) => batch.repetition)).toEqual([0, 1, 2]);
    expect(merged.summaries[0]).toMatchObject({ batches: 3, requests: 3, oraclePasses: 3, acceptanceRate: 0.8 });
    expect(merged.measurementLimits.at(-1)).toMatch(/does not authorize deployment/i);
  });

  it("rejects incomplete, duplicated, or provenance-mismatched cycle evidence", () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const plans = buildStrixSpeculationRunPlans(config, "/evidence");
    const arm = plans[0]!.arm;
    const report = cycleReport(plans[0]!.serverArgsSha256, "none", null, 1_000);
    expect(() => mergeStrixSpeculationCycleReports(config, arm, [
      { cycle: 0, armId: arm.id, report }, { cycle: 1, armId: arm.id, report },
    ])).toThrow(/exactly 3/i);
    expect(() => mergeStrixSpeculationCycleReports(config, arm, [0, 0, 2].map((cycle) => ({ cycle, armId: arm.id, report })))).toThrow(/contiguous and unique/i);
    const bad = structuredClone(report) as any;
    bad.provenance.runtimeCommit = "7".repeat(40);
    expect(() => mergeStrixSpeculationCycleReports(config, arm, [
      { cycle: 0, armId: arm.id, report }, { cycle: 1, armId: arm.id, report: bad }, { cycle: 2, armId: arm.id, report },
    ])).toThrow(/controlled.*provenance/i);
  });

  it("restores on an arm failure and reports a simultaneous restoration failure", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    let restored = false;
    const dependencies = {
      snapshot: async () => [{ model: "qwen38-27b", state: "ready" }],
      unload: async () => {},
      runArm: async () => { throw new Error("arm failed"); },
      restore: async () => { restored = true; },
      interruptedBy: () => null,
    };
    await expect(executeStrixSpeculationExperiment(config, args, dependencies)).rejects.toThrow("arm failed");
    expect(restored).toBe(true);
    await expect(executeStrixSpeculationExperiment(config, args, {
      ...dependencies,
      restore: async () => { throw new Error("restore failed"); },
    })).rejects.toThrow(/both failed/i);
  });
});
