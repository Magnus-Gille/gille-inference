#!/usr/bin/env tsx
/** Exact-artifact, Latin-rotated direct/native-MTP qualification inside maintenance:run. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runStrixServerBenchmark } from "./strix-server-benchmark.js";
import { writeArtifactPair } from "./synthesize-strix-speculation-policy.js";
import {
  executeStrixSpeculationExperiment,
  mergeStrixSpeculationCycleReports,
  parseStrixSpeculationExperimentArgs,
  validateStrixSpeculationExperimentConfig,
  type StrixMergedSpeculationReport,
  type StrixSpeculationExperimentConfig,
  type StrixSpeculationRunPlan,
} from "../src/homeserver/strix-speculation-experiment.js";
import type { StrixResidentEntry } from "../src/homeserver/strix-combined-experiment.js";
import {
  renderStrixSpeculationPolicyMarkdown,
  synthesizeStrixSpeculationPolicy,
} from "../src/homeserver/strix-speculation-policy.js";
import {
  buildStrixChildEnvironment,
  restoreResidency,
  runningSnapshot,
  unloadAll,
} from "../src/homeserver/strix-residency.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_SERVER_LOG_BYTES = 8 * 1024 * 1024;
const READY_TIMEOUT_MS = 600_000;
let activeChild: ChildProcess | null = null;
let activeStop: Promise<void> | null = null;

interface ArtifactPreflight {
  hashes: Record<string, string>;
  runtimeVersion: string;
  runtimeDevicesSha256: string;
  kernel: string;
  mesaVersion: string | null;
  rocmVersion: string | null;
}

interface ArmExecution {
  plan: StrixSpeculationRunPlan;
  report: unknown;
  reportPath: string;
  provenancePath: string;
  logSha256: string;
  logBytes: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve original error */ }
    throw error;
  }
}

export function prepareFreshStrixOutputDirectory(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) throw new Error("--out-dir must be a directory");
    if (readdirSync(resolved).length !== 0) throw new Error("--out-dir must be empty to prevent stale evidence reuse");
  } else {
    mkdirSync(resolved, { recursive: true, mode: 0o700 });
  }
  return resolved;
}

function assertSameArtifactPreflight(before: ArtifactPreflight, after: ArtifactPreflight): void {
  if (JSON.stringify(before.hashes) !== JSON.stringify(after.hashes) ||
      before.runtimeVersion !== after.runtimeVersion ||
      before.runtimeDevicesSha256 !== after.runtimeDevicesSha256) {
    throw new Error("runtime or evidence artifacts changed during the experiment");
  }
}

async function sha256File(path: string): Promise<string> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact is not a non-empty regular file: ${path}`);
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function commandOutput(command: string, args: string[], overrides: NodeJS.ProcessEnv = {}): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024,
    env: buildStrixChildEnvironment(process.env, overrides),
  });
  if (result.error || result.status !== 0) return null;
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().replace(/\0/g, "");
  return text === "" ? null : text.slice(0, 8_192);
}

export async function preflightStrixSpeculationArtifacts(
  config: StrixSpeculationExperimentConfig,
  probes: {
    version(path: string): string | null;
    devices(path: string): string | null;
    kernel(): string;
    mesa(): string | null;
    rocm(): string | null;
  } = {
    version: (path) => commandOutput(path, ["--version"], {
      GGML_VK_VISIBLE_DEVICES: "0",
      LD_LIBRARY_PATH: [dirname(config.runtime.vulkanLibraryPath), process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":"),
    }),
    devices: (path) => commandOutput(path, ["--list-devices"], {
      GGML_VK_VISIBLE_DEVICES: "0",
      LD_LIBRARY_PATH: [dirname(config.runtime.vulkanLibraryPath), process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":"),
    }),
    kernel: () => readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    mesa: () => commandOutput("vulkaninfo", ["--summary"]),
    rocm: () => commandOutput("rocminfo", ["--version"]),
  },
): Promise<ArtifactPreflight> {
  const binary = statSync(config.runtime.binaryPath);
  if (!binary.isFile() || (binary.mode & 0o111) === 0) throw new Error("runtime binary is not an executable regular file");
  const artifacts: Array<[string, string, string]> = [
    ["runtimeBinary", config.runtime.binaryPath, config.runtime.binarySha256],
    ["vulkanLibrary", config.runtime.vulkanLibraryPath, config.runtime.vulkanLibrarySha256],
    ["model", config.model.path, config.model.artifactSha256],
    ["fixtures", config.benchmark.fixturesPath, config.benchmark.fixturesSha256],
  ];
  if (config.model.mmprojPath !== null) artifacts.push(["mmproj", config.model.mmprojPath, config.model.mmprojSha256!]);
  const hashes: Record<string, string> = {};
  for (const [label, path, expected] of artifacts) {
    const observed = await sha256File(path);
    if (observed !== expected) throw new Error(`${label} hash differs from the reviewed config`);
    hashes[label] = observed;
  }
  const runtimeVersion = probes.version(config.runtime.binaryPath);
  if (runtimeVersion === null || !runtimeVersion.includes(config.runtime.commit)) {
    throw new Error("runtime --version does not prove the configured immutable commit");
  }
  const runtimeDevices = probes.devices(config.runtime.binaryPath);
  if (runtimeDevices === null || !runtimeDevices.includes(config.server.device) || !/vulkan/i.test(runtimeDevices)) {
    throw new Error("runtime --list-devices does not prove the configured Vulkan device");
  }
  return {
    hashes,
    runtimeVersion,
    runtimeDevicesSha256: createHash("sha256").update(runtimeDevices).digest("hex"),
    kernel: probes.kernel(),
    mesaVersion: probes.mesa(),
    rocmVersion: probes.rocm(),
  };
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveFree) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolveFree(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolveFree(true)));
  });
}

async function waitHealthy(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("ephemeral llama-server exited before ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) { await response.body?.cancel(); return; }
    } catch { /* still loading */ }
    await sleep(250);
  }
  throw new Error("ephemeral llama-server did not become ready before timeout");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    sleep(30_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit, rejectExit) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolveExit(); return; }
      const timeout = setTimeout(() => rejectExit(new Error("ephemeral llama-server did not exit after SIGKILL")), 5_000);
      child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
    });
  }
}

function stopActiveChild(): Promise<void> {
  if (activeChild === null) return Promise.resolve();
  activeStop ??= stopChild(activeChild);
  return activeStop;
}

function readBoundedJson(path: string): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_REPORT_BYTES) throw new Error(`invalid bounded report: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function failureDiagnostic(error: unknown): { type: string; message: string } {
  const type = error instanceof AggregateError ? "AggregateError" : error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  return { type, message: raw.replace(/[\r\n\0]+/g, " ").slice(0, 512) };
}

function readyIdentityMatches(snapshot: StrixResidentEntry[], expected: string | null): boolean {
  if (expected === null) return snapshot.length === 0;
  return snapshot.length === 1 && snapshot[0]!.model === expected && snapshot[0]!.state === "ready";
}

function provenance(config: StrixSpeculationExperimentConfig, plan: StrixSpeculationRunPlan, host: ArtifactPreflight): Record<string, unknown> {
  return {
    schemaVersion: 1,
    modelArtifactSha256: config.model.artifactSha256,
    runtimeCommit: config.runtime.commit,
    runtimeBinarySha256: config.runtime.binarySha256,
    serverArgsSha256: plan.serverArgsSha256,
    backend: "vulkan",
    quant: config.model.quant,
    kernel: host.kernel,
    mesaVersion: host.mesaVersion,
    rocmVersion: host.rocmVersion,
    contextSize: config.server.contextSize,
    kvTypeK: config.server.kvTypeK,
    kvTypeV: config.server.kvTypeV,
    flashAttention: config.server.flashAttention,
    batch: config.server.batch,
    ubatch: config.server.ubatch,
    parallelism: config.server.parallelism,
    speculation: plan.arm.speculation,
    draftDepth: plan.arm.draftDepth,
    cacheRamMiB: config.server.cacheRamMiB,
    contextCheckpoints: config.server.contextCheckpoints,
    checkpointMinStep: config.server.checkpointMinStep,
    cacheIdleSlots: config.server.cacheIdleSlots,
  };
}

async function runArm(
  config: StrixSpeculationExperimentConfig,
  plan: StrixSpeculationRunPlan,
  host: ArtifactPreflight,
  signal: AbortSignal,
): Promise<ArmExecution> {
  if (!(await portIsFree(config.server.port))) throw new Error(`ephemeral port ${config.server.port} is occupied`);
  const provenancePath = `${plan.outPrefix}.provenance.json`;
  atomicWrite(provenancePath, `${JSON.stringify(provenance(config, plan, host), null, 2)}\n`);
  const logHash = createHash("sha256");
  let logBytes = 0;
  const child = spawn(plan.serverArgv[0]!, plan.serverArgv.slice(1), {
    shell: false,
    stdio: ["ignore", "ignore", "pipe"],
    env: buildStrixChildEnvironment(process.env, {
      GGML_VK_VISIBLE_DEVICES: "0",
      LD_LIBRARY_PATH: [dirname(config.runtime.vulkanLibraryPath), process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":"),
    }),
  });
  activeChild = child;
  activeStop = null;
  child.stderr?.on("data", (chunk: Buffer) => {
    logBytes += chunk.length;
    logHash.update(chunk);
    if (logBytes > MAX_SERVER_LOG_BYTES) child.kill("SIGTERM");
  });
  try {
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    await waitHealthy(child, config.server.port);
    const exitCode = await runStrixServerBenchmark([
      "--base-url", `http://127.0.0.1:${config.server.port}/v1`,
      "--metrics-url", `http://127.0.0.1:${config.server.port}/metrics`,
      "--model", config.model.id,
      "--fixtures", config.benchmark.fixturesPath,
      "--provenance", provenancePath,
      "--out", plan.outPrefix,
      "--concurrency", config.benchmark.concurrency.join(","),
      "--repetitions", "1",
      "--max-tokens", String(config.benchmark.maxTokens),
      "--timeout-ms", String(config.benchmark.timeoutMs),
    ], undefined, signal);
    if (exitCode !== 0) throw new Error(`${plan.arm.id} benchmark failed with exit code ${exitCode}`);
  } finally {
    await stopActiveChild();
    if (activeChild === child) { activeChild = null; activeStop = null; }
  }
  if (logBytes > MAX_SERVER_LOG_BYTES) throw new Error(`${plan.arm.id} server log exceeded ${MAX_SERVER_LOG_BYTES} bytes`);
  const reportPath = `${plan.outPrefix}.json`;
  return { plan, report: readBoundedJson(reportPath), reportPath, provenancePath, logSha256: logHash.digest("hex"), logBytes };
}

export async function runStrixSpeculationExperiment(argv: string[]): Promise<number> {
  const args = parseStrixSpeculationExperimentArgs(argv);
  if (process.platform !== "linux") throw new Error("Strix speculation experiment requires Linux");
  const configText = readFileSync(args.configPath, "utf8");
  if (Buffer.byteLength(configText) > MAX_CONFIG_BYTES) throw new Error("config exceeds 64 KiB");
  const config = validateStrixSpeculationExperimentConfig(JSON.parse(configText) as unknown);
  const outputRoot = prepareFreshStrixOutputDirectory(args.outDir);
  const host = await preflightStrixSpeculationArtifacts(config); // Hash everything before unloading.
  let interruptedBy: NodeJS.Signals | "deadline" | null = null;
  let forcedStopError: unknown;
  let restorationAttempted = false;
  let restorationCompleted = false;
  let finalReadyIdentityVerified = false;
  const executions: ArmExecution[] = [];
  const interruption = new AbortController();
  const interrupt = (reason: NodeJS.Signals | "deadline"): void => {
    interruptedBy ??= reason;
    if (!interruption.signal.aborted) interruption.abort(new Error(`speculation experiment interrupted by ${reason}`));
    void stopActiveChild().catch((error: unknown) => { forcedStopError ??= error; });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupt(signal);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  const timer = setTimeout(() => interrupt("deadline"), args.maxRuntimeSeconds * 1_000);
  timer.unref();
  const startedAt = new Date().toISOString();
  try {
    const execution = await executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => {
        const snapshot = await runningSnapshot(args.llamaSwapOrigin);
        if (restorationCompleted) finalReadyIdentityVerified = readyIdentityMatches(snapshot, args.expectedResidentModel);
        return snapshot;
      },
      unload: async () => await unloadAll(args.llamaSwapOrigin),
      runArm: async (plan) => {
        const result = await runArm(config, plan, host, interruption.signal);
        executions.push(result);
        return { cycle: plan.cycle, position: plan.position, sequence: plan.sequence, armId: plan.arm.id, reportPath: result.reportPath };
      },
      restore: async (initial) => {
        restorationAttempted = true;
        await restoreResidency(args.llamaSwapOrigin, initial);
        restorationCompleted = true;
      },
      interruptedBy: () => interruptedBy,
    });
    if (forcedStopError !== undefined) throw forcedStopError;
    const postflight = await preflightStrixSpeculationArtifacts(config);
    assertSameArtifactPreflight(host, postflight);
    if (interruptedBy !== null) throw new Error(`speculation experiment interrupted by ${interruptedBy}`);
    const armMap = new Map(executions.map((item) => [item.plan.arm.id, item.plan.arm]));
    const merged = new Map<string, StrixMergedSpeculationReport>();
    for (const arm of armMap.values()) {
      const report = mergeStrixSpeculationCycleReports(config, arm, executions
        .filter((item) => item.plan.arm.id === arm.id)
        .map((item) => ({ cycle: item.plan.cycle, armId: arm.id, report: item.report })));
      const path = `${outputRoot}/merged-${arm.id}.json`;
      atomicWrite(path, `${JSON.stringify(report, null, 2)}\n`);
      merged.set(arm.id, report);
    }
    const direct = merged.get("direct");
    if (direct === undefined) throw new Error("merged direct evidence is missing");
    const candidates = [...merged.entries()].filter(([id]) => id !== "direct").map(([, report]) => report);
    const policy = synthesizeStrixSpeculationPolicy(
      direct,
      candidates,
      config.benchmark.minimumUsefulWorkGainPercent / 100,
      armMap.size,
    );
    if (interruptedBy !== null) throw new Error(`speculation experiment interrupted by ${interruptedBy}`);
    const policyPrefix = `${outputRoot}/speculation-policy`;
    writeArtifactPair(
      `${policyPrefix}.json`, `${JSON.stringify(policy, null, 2)}\n`,
      `${policyPrefix}.md`, renderStrixSpeculationPolicyMarkdown(policy),
    );
    if (interruptedBy !== null) throw new Error(`speculation experiment interrupted by ${interruptedBy}`);
    atomicWrite(`${outputRoot}/receipt.json`, `${JSON.stringify({
      schemaVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      label: "LOCAL-MEASURED",
      deploymentStatus: "not-authorized-by-evidence",
      host,
      initialResidency: execution.initialResidency,
      finalResidency: execution.finalResidency,
      restoration: {
        attempted: restorationAttempted,
        completed: restorationCompleted,
        readyModelIdentityVerified: finalReadyIdentityVerified,
        ttlPreservationClaimed: false,
      },
      runs: executions.map((item) => ({
        cycle: item.plan.cycle, position: item.plan.position, armId: item.plan.arm.id,
        serverArgsSha256: item.plan.serverArgsSha256, reportPath: item.reportPath,
        provenancePath: item.provenancePath, serverStderrSha256: item.logSha256, serverStderrBytes: item.logBytes,
      })),
      policyPath: `${policyPrefix}.json`,
      rollback: "No production configuration was changed; the pre-experiment ready model identity was restored and verified. TTL preservation is not claimed.",
    }, null, 2)}\n`);
    console.log(JSON.stringify({ status: "complete", runs: executions.length, deploymentStatus: "not-authorized-by-evidence" }));
    return 0;
  } catch (error) {
    const incomplete = {
      schemaVersion: 1,
      status: "incomplete",
      startedAt,
      finishedAt: new Date().toISOString(),
      interruptedBy,
      completedRuns: executions.length,
      deploymentStatus: "not-authorized-by-evidence",
      reason: interruptedBy === null ? "experiment_failed" : "experiment_interrupted",
      failure: failureDiagnostic(error),
      forcedStopFailure: forcedStopError === undefined ? null : failureDiagnostic(forcedStopError),
      restoration: {
        attempted: restorationAttempted,
        completed: restorationCompleted,
        readyModelIdentityVerified: finalReadyIdentityVerified,
        ttlPreservationClaimed: false,
      },
    };
    try {
      atomicWrite(`${outputRoot}/incomplete.json`, `${JSON.stringify(incomplete, null, 2)}\n`);
    } catch (receiptError) {
      throw new AggregateError([error, receiptError], "experiment failed and incomplete receipt publication also failed");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStrixSpeculationExperiment(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; },
  );
}
