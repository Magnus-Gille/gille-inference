import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  preflightStrixSpeculationArtifacts,
  prepareFreshStrixOutputDirectory,
  runArm,
  runStrixSpeculationExperiment,
  stopChild,
  waitHealthy,
} from "../scripts/strix-speculation-experiment.js";

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
      device: "Vulkan0",
      gpuLayers: 999,
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
      cacheIdleSlots: "on",
      commonArgs: ["--jinja", "--reasoning-format", "auto", "--reasoning", "auto"],
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
      contextCheckpoints: 32, checkpointMinStep: 8_192, cacheIdleSlots: "on",
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
        version: () => `llama.cpp ${config.runtime.commit}`,
        devices: () => "Vulkan0: AMD Radeon 8060S (Vulkan)",
        kernel: () => "test-kernel", mesa: () => "test-mesa", rocm: () => null,
      })).resolves.toMatchObject({ hashes: { model: digest("model"), fixtures: digest("fixtures") }, kernel: "test-kernel" });
      const expired = new AbortController();
      expired.abort(new Error("preflight cancelled"));
      const unusedProbe = vi.fn();
      await expect(preflightStrixSpeculationArtifacts(config, {
        version: unusedProbe, devices: unusedProbe, kernel: unusedProbe, mesa: unusedProbe, rocm: unusedProbe,
      }, expired.signal)).rejects.toThrow(/preflight cancelled/);
      expect(unusedProbe).not.toHaveBeenCalled();
      const budget = Date.now() + 300000;
      const now = vi.spyOn(Date, "now");
      const devices = vi.fn(() => "Vulkan0 (Vulkan)");
      try {
        await expect(preflightStrixSpeculationArtifacts(config, {
          version: () => { now.mockReturnValue(budget); return config.runtime.commit; },
          devices, kernel: () => "test", mesa: () => null, rocm: () => null,
        }, undefined, budget)).rejects.toThrow(/work deadline/);
        expect(devices).not.toHaveBeenCalled();
      } finally { now.mockRestore(); }
      raw.model.artifactSha256 = "0".repeat(64);
      await expect(preflightStrixSpeculationArtifacts(validateStrixSpeculationExperimentConfig(raw), {
        version: () => `llama.cpp ${config.runtime.commit}`,
        devices: () => "Vulkan0: AMD Radeon 8060S (Vulkan)",
        kernel: () => "test", mesa: () => null, rocm: () => null,
      })).rejects.toThrow(/model hash differs/i);
      raw.model.artifactSha256 = digest("model");
      await expect(preflightStrixSpeculationArtifacts(validateStrixSpeculationExperimentConfig(raw), {
        version: () => `llama.cpp ${config.runtime.commit.slice(0, 8)}`,
        devices: () => "Vulkan0: AMD Radeon 8060S (Vulkan)",
        kernel: () => "test", mesa: () => null, rocm: () => null,
      })).rejects.toThrow(/immutable commit/i);
      await expect(preflightStrixSpeculationArtifacts(validateStrixSpeculationExperimentConfig(raw), {
        version: () => `llama.cpp ${config.runtime.commit}`,
        devices: () => "CPU",
        kernel: () => "test", mesa: () => null, rocm: () => null,
      })).rejects.toThrow(/Vulkan device/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requires a fresh output directory so stale arm artifacts cannot be reused", () => {
    const root = mkdtempSync(join(tmpdir(), "strix-spec-output-"));
    try {
      const fresh = join(root, "fresh");
      expect(prepareFreshStrixOutputDirectory(fresh)).toBe(fresh);
      expect(() => prepareFreshStrixOutputDirectory(fresh)).not.toThrow();
      writeFileSync(join(fresh, "stale.json"), "{}\n");
      expect(() => prepareFreshStrixOutputDirectory(fresh)).toThrow(/must be empty/i);
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
      "--device", "Vulkan0", "-ngl", "999",
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
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => copy.server.commonArgs.push("--device", "CPU")))).toThrow(/controlled.*device/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.server.device = "CPU"; }))).toThrow(/Vulkan0/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.server.device = "Vulkan1"; }))).toThrow(/Vulkan0/i);
    expect(() => validateStrixSpeculationExperimentConfig(mutate((copy) => { copy.server.cacheIdleSlots = "off"; }))).toThrow(/cacheIdleSlots must be on/i);
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

  it("runs every balanced arm, restores the ready model identity, and never authorizes deployment", async () => {
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
      confirmStopped: async () => { events.push("stopped"); },
      restore: async () => { restored = true; events.push("restore"); },
      interruptedBy: () => null,
    });

    expect(events).toEqual([
      "unload",
      "direct", "draft-mtp-1", "draft-mtp-2",
      "draft-mtp-1", "draft-mtp-2", "direct",
      "draft-mtp-2", "direct", "draft-mtp-1",
      "stopped", "restore",
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
    const wrongFixture = structuredClone(report) as any;
    wrongFixture.fixtureSha256 = "7".repeat(64);
    expect(() => mergeStrixSpeculationCycleReports(config, arm, [0, 1, 2].map((cycle) => ({
      cycle, armId: arm.id, report: wrongFixture,
    })))).toThrow(/fixture digest/i);
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
      confirmStopped: async () => {},
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

  it("rejects non-ready residency instead of claiming it can be restored exactly", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    await expect(executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => [{ model: "qwen38-27b", state: "loading", ttl: 1800 }],
      unload: async () => {},
      confirmStopped: async () => {},
      runArm: async () => { throw new Error("must not run"); },
      restore: async () => {},
      interruptedBy: () => null,
    })).rejects.toThrow(/ready-only/i);
  });

  it("fails closed when a deadline lands during final residency verification", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    let snapshots = 0;
    let interrupted: string | null = null;
    await expect(executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => {
        snapshots++;
        if (snapshots === 2) interrupted = "deadline";
        return [{ model: "qwen38-27b", state: "ready", ttl: 1800 }];
      },
      unload: async () => {},
      confirmStopped: async () => {},
      runArm: async (plan) => ({
        cycle: plan.cycle, position: plan.position, sequence: plan.sequence,
        armId: plan.arm.id, reportPath: `${plan.outPrefix}.json`,
      }),
      restore: async () => {},
      interruptedBy: () => interrupted,
    })).rejects.toThrow(/interrupted by deadline/i);
  });
});

describe("speculation child lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function childFixture(): ChildProcess {
    return Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
  }

  it("does not spawn if cancellation arrives during the port probe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strix-abort-probe-"));
    const controller = new AbortController();
    const reason = new Error("deadline during port probe");
    const spawnChild = vi.fn(() => { throw new Error("spawned after cancellation"); });
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const plan = buildStrixSpeculationRunPlans(config, dir)[0]!;
    try {
      await expect(runArm(config, plan, {
        hashes: {}, runtimeVersion: "fixture", runtimeDevicesSha256: "0".repeat(64),
        kernel: "fixture", mesaVersion: null, rocmVersion: null,
      }, controller.signal, {
        portIsFree: async () => { controller.abort(reason); return true; },
        spawn: spawnChild as unknown as typeof spawn,
      })).rejects.toBe(reason);
      expect(spawnChild).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not poll health with an already aborted signal", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline before health polling");
    controller.abort(reason);
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(waitHealthy(childFixture(), 5919, controller.signal)).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not accept ready health after cancellation during fetch", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline during health fetch");
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort(reason);
      return new Response(null, { status: 200 });
    }));
    await expect(waitHealthy(childFixture(), 5919, controller.signal)).rejects.toBe(reason);
  });

  it("passes cancellation to an in-flight health request", async () => {
    const controller = new AbortController();
    const reason = new Error("deadline with health request pending");
    const fetchMock = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitHealthy(childFixture(), 5919, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels the delay between health polls without another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = waitHealthy(childFixture(), 5919, controller.signal).then(
      () => ({ error: null }), (error: unknown) => ({ error }),
    );
    setTimeout(() => controller.abort(new Error("deadline between polls")), 25);
    await vi.advanceTimersByTimeAsync(250);
    expect((await outcome).error).toBeInstanceOf(Error);
    expect(String((await outcome).error)).toMatch(/abort|deadline/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cleans the TERM wait timer and listener when exit is confirmed", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    vi.mocked(child.kill).mockImplementation(() => {
      setTimeout(() => { child.exitCode = 0; child.emit("exit", 0, null); }, 10);
      return true;
    });
    const stopped = stopChild(child);
    await vi.advanceTimersByTimeAsync(10);
    await stopped;
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with no dangling listeners when TERM and KILL cannot confirm exit", async () => {
    vi.useFakeTimers();
    const child = childFixture();
    const checked = expect(stopChild(child)).rejects.toThrow("did not exit after SIGKILL");
    await vi.advanceTimersByTimeAsync(35_000);
    await checked;
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks restoration if child termination cannot be confirmed after an arm failure", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    const restore = vi.fn(async () => {});
    await expect(executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => [{ model: "qwen38-27b", state: "ready" }],
      unload: async () => {},
      runArm: async () => { throw new Error("arm failed"); },
      confirmStopped: async () => { throw new Error("child still alive after SIGKILL"); },
      restore,
      interruptedBy: () => null,
    })).rejects.toThrow(/termination unverified|restoration blocked/i);
    expect(restore).not.toHaveBeenCalled();
  });

  it("also requires confirmed termination when every arm succeeded", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    const restore = vi.fn(async () => {});
    await expect(executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => [{ model: "qwen38-27b", state: "ready" }],
      unload: async () => {},
      runArm: async (plan) => ({
        cycle: plan.cycle, position: plan.position, sequence: plan.sequence,
        armId: plan.arm.id, reportPath: `${plan.outPrefix}.json`,
      }),
      confirmStopped: async () => { throw new Error("unverified child exit"); },
      restore,
      interruptedBy: () => null,
    })).rejects.toThrow(/restoration blocked/i);
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not unload or restore if cancellation arrives during the initial snapshot", async () => {
    const config = validateStrixSpeculationExperimentConfig(fixture());
    const args = parseStrixSpeculationExperimentArgs([
      "--config", "config.json", "--out-dir", "/evidence",
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", "7200",
      "--ack-exclusive-window",
    ]);
    let interrupted: string | null = null;
    const unload = vi.fn(async () => {});
    const restore = vi.fn(async () => {});
    await expect(executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => {
        interrupted = "deadline";
        return [{ model: "qwen38-27b", state: "ready" }];
      },
      unload,
      runArm: async () => { throw new Error("must not run"); },
      confirmStopped: async () => {},
      restore,
      interruptedBy: () => interrupted,
    })).rejects.toThrow(/interrupted by deadline/i);
    expect(unload).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });
});


describe("speculation CLI deadline and receipt integration", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup(workSeconds = 13800, outerSeconds = 14395) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const root = mkdtempSync(join(tmpdir(), "strix-spec-cli-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(fixture()));
    const outDir = join(root, "output");
    const argv = ["--config", configPath, "--out-dir", outDir,
      "--expected-resident-model", "qwen38-27b", "--max-runtime-seconds", String(workSeconds),
      "--ack-exclusive-window"];
    const dependencies = {
      platform: "linux" as const,
      environment: { M5_MAINTENANCE_CHILD_DEADLINE_AT: String(outerSeconds * 1000) },
      preflight: vi.fn(async () => ({ hashes: {}, runtimeVersion: "test", runtimeDevicesSha256: "test",
        kernel: "test", mesaVersion: null, rocmVersion: null })),
      snapshot: vi.fn(async () => [{ model: "qwen38-27b", state: "ready" }]),
      unload: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      restore: vi.fn(async () => {}),
      runArm: vi.fn(async () => { throw new Error("arm failed"); }),
    };
    return { argv, dependencies, outDir };
  }

  it("counts slow artifact preflight and never unloads after the deadline", async () => {
    const { argv, dependencies, outDir } = setup(300, 3000);
    dependencies.preflight.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 301000));
      return { hashes: {}, runtimeVersion: "test", runtimeDevicesSha256: "test", kernel: "test", mesaVersion: null, rocmVersion: null };
    });
    const result = runStrixSpeculationExperiment(argv, dependencies);
    const rejected = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(301000);
    await rejected;
    expect(dependencies.unload).not.toHaveBeenCalled();
    expect(dependencies.snapshot).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(outDir, "incomplete.json"), "utf8"))).toMatchObject({
      interruptedBy: "deadline", restoration: { attempted: false },
    });
  });

  it("reserves complete stop and slow restoration time inside the outer fence", async () => {
    const { argv, dependencies, outDir } = setup();
    dependencies.runArm.mockImplementation(async (_config, _plan, _host, signal) => {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      throw new Error("unreachable");
    });
    dependencies.stop.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 35000)); });
    dependencies.restore.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 1370000)); });
    const result = runStrixSpeculationExperiment(argv, dependencies);
    const rejected = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(14395000);
    await rejected;
    const receipt = JSON.parse(readFileSync(join(outDir, "incomplete.json"), "utf8"));
    expect(receipt.restoration).toMatchObject({ attempted: true, completed: true });
    expect(Date.parse(receipt.finishedAt)).toBeLessThan(14395000);
    expect(dependencies.restore).toHaveBeenCalledTimes(1);
  });

  it("leaves time for an in-flight unload followed by full restoration", async () => {
    const { argv, dependencies, outDir } = setup(300, 2200);
    dependencies.preflight.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 299000));
      return { hashes: {}, runtimeVersion: "test", runtimeDevicesSha256: "test", kernel: "test", mesaVersion: null, rocmVersion: null };
    });
    dependencies.unload.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 161000)); });
    dependencies.restore.mockImplementation(async () => { await new Promise((resolve) => setTimeout(resolve, 1371000)); });
    const result = runStrixSpeculationExperiment(argv, dependencies);
    const rejected = expect(result).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(2200000);
    await rejected;
    expect(dependencies.runArm).not.toHaveBeenCalled();
    const receipt = JSON.parse(readFileSync(join(outDir, "incomplete.json"), "utf8"));
    expect(receipt.restoration).toMatchObject({ attempted: true, completed: true });
    expect(Date.parse(receipt.finishedAt)).toBeLessThan(2200000);
  });

  it("rejects missing or expired outer deadlines before preflight or unload", async () => {
    const { argv, dependencies } = setup(300, 1400);
    await expect(runStrixSpeculationExperiment(argv, dependencies)).rejects.toThrow(/maintenance.*deadline|cleanup reserve/i);
    expect(dependencies.preflight).not.toHaveBeenCalled();
    expect(dependencies.unload).not.toHaveBeenCalled();
    await expect(runStrixSpeculationExperiment(argv, { ...dependencies, environment: {} })).rejects.toThrow(/maintenance.*deadline/i);
  });

  it("publishes both arm and restoration diagnostics in the incomplete receipt", async () => {
    const { argv, dependencies, outDir } = setup();
    dependencies.restore.mockRejectedValue(new Error("restore HTTP 503\nretry later"));
    await expect(runStrixSpeculationExperiment(argv, dependencies)).rejects.toThrow(/both failed/);
    const receipt = JSON.parse(readFileSync(join(outDir, "incomplete.json"), "utf8"));
    expect(receipt.failure.errors).toEqual([
      { type: "Error", message: "arm failed" },
      { type: "Error", message: "restore HTTP 503 retry later" },
    ]);
    expect(receipt.restoration).toMatchObject({ attempted: true, completed: false });
  });
});
