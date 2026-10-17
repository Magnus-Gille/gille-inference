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
import { failureDiagnostic } from "../src/homeserver/strix-failure-diagnostic.js";
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
// Stop 35s + unload <=161s + restore request 600s + ready polling <=611s + final
// snapshot 10s = 1417s, plus <=161s for an already in-flight initial unload.
// Reserve another 222s before the wrapper's own abort deadline.
const CLEANUP_RESERVE_MS = 1_800_000;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact is not a non-empty regular file: ${path}`);
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { signal });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function commandOutput(command: string, args: string[], overrides: NodeJS.ProcessEnv = {}, deadlineAt = Infinity): string | null {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: Math.max(1, Math.min(30_000, deadlineAt - Date.now())), killSignal: "SIGKILL", maxBuffer: 256 * 1024,
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
    }, deadlineAt),
    devices: (path) => commandOutput(path, ["--list-devices"], {
      GGML_VK_VISIBLE_DEVICES: "0",
      LD_LIBRARY_PATH: [dirname(config.runtime.vulkanLibraryPath), process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":"),
    }, deadlineAt),
    kernel: () => readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
    mesa: () => commandOutput("vulkaninfo", ["--summary"], {}, deadlineAt),
    rocm: () => commandOutput("rocminfo", ["--version"], {}, deadlineAt),
  },
  signal?: AbortSignal,
  deadlineAt = Infinity,
): Promise<ArtifactPreflight> {
  const checkBudget = (): void => {
    signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new Error("artifact preflight exceeded work deadline");
  };
  checkBudget();
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
    checkBudget();
    const observed = await sha256File(path, signal);
    checkBudget();
    if (observed !== expected) throw new Error(`${label} hash differs from the reviewed config`);
    hashes[label] = observed;
  }
  checkBudget();
  const runtimeVersion = probes.version(config.runtime.binaryPath);
  if (runtimeVersion === null || !runtimeVersion.includes(config.runtime.commit)) {
    throw new Error("runtime --version does not prove the configured immutable commit");
  }
  checkBudget();
  const runtimeDevices = probes.devices(config.runtime.binaryPath);
  if (runtimeDevices === null || !runtimeDevices.includes(config.server.device) || !/vulkan/i.test(runtimeDevices)) {
    throw new Error("runtime --list-devices does not prove the configured Vulkan device");
  }
  checkBudget();
  const kernel = probes.kernel();
  checkBudget();
  const mesaVersion = probes.mesa();
  checkBudget();
  const rocmVersion = probes.rocm();
  checkBudget();
  return {
    hashes,
    runtimeVersion,
    runtimeDevicesSha256: createHash("sha256").update(runtimeDevices).digest("hex"),
    kernel,
    mesaVersion,
    rocmVersion,
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

export async function waitHealthy(child: ChildProcess, port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("ephemeral llama-server exited before ready");
    try {
      const timeout = AbortSignal.timeout(2_000);
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
      });
      await response.body?.cancel();
      signal?.throwIfAborted();
      if (response.ok) return;
      lastError = new Error(`ephemeral health returned ${response.status}`);
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;
    }
    await sleep(250, signal);
  }
  throw new Error("ephemeral llama-server did not become ready before timeout", { cause: lastError });
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

export async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 30_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error("ephemeral llama-server did not exit after SIGKILL");
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

export async function runArm(
  config: StrixSpeculationExperimentConfig,
  plan: StrixSpeculationRunPlan,
  host: ArtifactPreflight,
  signal: AbortSignal,
  dependencies: { portIsFree?: typeof portIsFree; spawn?: typeof spawn } = {},
): Promise<ArmExecution> {
  signal.throwIfAborted();
  const free = await (dependencies.portIsFree ?? portIsFree)(config.server.port);
  signal.throwIfAborted();
  if (!free) throw new Error(`ephemeral port ${config.server.port} is occupied`);
  const provenancePath = `${plan.outPrefix}.provenance.json`;
  atomicWrite(provenancePath, `${JSON.stringify(provenance(config, plan, host), null, 2)}\n`);
  const logHash = createHash("sha256");
  let logBytes = 0;
  const child = (dependencies.spawn ?? spawn)(plan.serverArgv[0]!, plan.serverArgv.slice(1), {
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
    await waitHealthy(child, config.server.port, signal);
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

interface StrixExperimentCliDependencies {
  platform: NodeJS.Platform;
  environment: NodeJS.ProcessEnv;
  preflight: typeof preflightStrixSpeculationArtifacts;
  snapshot: typeof runningSnapshot;
  unload: typeof unloadAll;
  stop: typeof stopActiveChild;
  restore: typeof restoreResidency;
  runArm: typeof runArm;
}

export async function runStrixSpeculationExperiment(
  argv: string[],
  overrides: Partial<StrixExperimentCliDependencies> = {},
): Promise<number> {
  const startedAtMs = Date.now();
  const dependencies: StrixExperimentCliDependencies = {
    platform: process.platform, environment: process.env,
    preflight: preflightStrixSpeculationArtifacts, snapshot: runningSnapshot,
    unload: unloadAll, stop: stopActiveChild, restore: restoreResidency, runArm,
    ...overrides,
  };
  if (activeChild !== null) throw new Error("previous ephemeral child termination is unverified");
  const args = parseStrixSpeculationExperimentArgs(argv);
  if (dependencies.platform !== "linux") throw new Error("Strix speculation experiment requires Linux");
  const outerDeadlineAt = Number(dependencies.environment["M5_MAINTENANCE_CHILD_DEADLINE_AT"]);
  if (!Number.isSafeInteger(outerDeadlineAt) || outerDeadlineAt <= startedAtMs) {
    throw new Error("valid maintenance child deadline required; run inside maintenance:run");
  }
  const workDeadlineAt = Math.min(startedAtMs + args.maxRuntimeSeconds * 1000, outerDeadlineAt - CLEANUP_RESERVE_MS);
  if (workDeadlineAt <= startedAtMs) throw new Error("maintenance deadline has insufficient cleanup reserve");
  const configText = readFileSync(args.configPath, "utf8");
  if (Buffer.byteLength(configText) > MAX_CONFIG_BYTES) throw new Error("config exceeds 64 KiB");
  const config = validateStrixSpeculationExperimentConfig(JSON.parse(configText) as unknown);
  const outputRoot = prepareFreshStrixOutputDirectory(args.outDir);
  let interruptedBy: NodeJS.Signals | "deadline" | null = null;
  let forcedStopError: unknown;
  let restorationBlockedByUnverifiedChild = false;
  let restorationAttempted = false;
  let restorationCompleted = false;
  let finalReadyIdentityVerified = false;
  const executions: ArmExecution[] = [];
  const interruption = new AbortController();
  const interrupt = (reason: NodeJS.Signals | "deadline"): void => {
    interruptedBy ??= reason;
    if (!interruption.signal.aborted) interruption.abort(new Error(`speculation experiment interrupted by ${reason}`));
    void dependencies.stop().catch((error: unknown) => { forcedStopError ??= error; });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    interrupt(signal);
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  const enforceDeadline = (): void => {
    if (Date.now() >= workDeadlineAt) interrupt("deadline");
    interruption.signal.throwIfAborted();
  };
  const timer = setTimeout(() => interrupt("deadline"), Math.max(0, workDeadlineAt - Date.now()));
  timer.unref();
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    enforceDeadline();
    const host = await dependencies.preflight(config, undefined, interruption.signal, workDeadlineAt);
    enforceDeadline(); // Includes synchronous artifact probes that can delay timer delivery.
    const execution = await executeStrixSpeculationExperiment(config, args, {
      snapshot: async () => {
        const snapshot = await dependencies.snapshot(args.llamaSwapOrigin);
        if (restorationCompleted) finalReadyIdentityVerified = readyIdentityMatches(snapshot, args.expectedResidentModel);
        return snapshot;
      },
      unload: async () => { enforceDeadline(); await dependencies.unload(args.llamaSwapOrigin); },
      runArm: async (plan) => {
        const result = await dependencies.runArm(config, plan, host, interruption.signal);
        executions.push(result);
        return { cycle: plan.cycle, position: plan.position, sequence: plan.sequence, armId: plan.arm.id, reportPath: result.reportPath };
      },
      confirmStopped: async () => {
        try { await dependencies.stop(); } catch (error) {
          restorationBlockedByUnverifiedChild = true;
          throw error;
        }
      },
      restore: async (initial) => {
        restorationAttempted = true;
        await dependencies.restore(args.llamaSwapOrigin, initial);
        restorationCompleted = true;
      },
      interruptedBy: () => {
        if (Date.now() >= workDeadlineAt) interrupt("deadline");
        return interruptedBy;
      },
    });
    if (forcedStopError !== undefined) throw forcedStopError;
    enforceDeadline();
    const postflight = await dependencies.preflight(config, undefined, interruption.signal, workDeadlineAt);
    enforceDeadline();
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
        blockedByUnverifiedChild: restorationBlockedByUnverifiedChild,
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
    if (Date.now() >= workDeadlineAt) interrupt("deadline");
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
        blockedByUnverifiedChild: restorationBlockedByUnverifiedChild,
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
    (error) => { console.error(JSON.stringify(failureDiagnostic(error))); process.exitCode = 1; },
  );
}
