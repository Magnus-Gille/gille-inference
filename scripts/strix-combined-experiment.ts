#!/usr/bin/env tsx
/**
 * Combined Strix maintenance experiment: mmap ABBA plus the causal F16/stock-Q8/patched-Q8
 * direct benchmark matrix. This command must itself run as the child of maintenance:run.
 * It never edits services, llama-swap configuration, model files, or deployment state.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { DEFAULT_DEPS, runStrixBenchmark } from "./strix-benchmark.js";
import { runStrixMmapAb } from "./strix-mmap-ab.js";
import {
  assertStrixBenchmarkCoverage,
  type StrixBenchmarkReport,
} from "../src/homeserver/strix-benchmark.js";
import {
  buildStrixBenchmarkArgv,
  evaluateStrixKvMicrobenchmarks,
  executeStrixCombinedExperiment,
  parseStrixCombinedArgs,
  validateStrixKvCandidateConfig,
  type StrixCombinedRunEvidence,
  type StrixKvCandidateConfig,
  type StrixKvRunPlan,
} from "../src/homeserver/strix-combined-experiment.js";
import { validateStrixMmapAbConfig } from "../src/homeserver/strix-mmap-ab.js";
import {
  buildStrixChildEnvironment,
  restoreResidency,
  runningSnapshot,
  unloadAll,
} from "../src/homeserver/strix-residency.js";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 8 * 1024 * 1024;
let activeChild: ChildProcess | null = null;

export interface BackendEvidence {
  pathSha256: string;
  argvSha256: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  stdoutSha256: string;
  stderrSha256: string;
  stdoutBytes: number;
  stderrBytes: number;
  outputWithinLimit: boolean;
}

export function armStrixRuntimeDeadline(maxRuntimeSeconds: number, onDeadline: () => void): NodeJS.Timeout {
  return setTimeout(onDeadline, maxRuntimeSeconds * 1_000);
}

function readBoundedJson(path: string, limit = MAX_REPORT_BYTES): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error(`invalid bounded JSON artifact: ${path}`);
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function sha256File(path: string): Promise<string> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact is not a non-empty regular file: ${path}`);
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function executable(path: string, label: string): void {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error(`${label} is not an executable regular file`);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* preserve original write failure */ }
    throw error;
  }
}

function commandVersion(path: string): string | null {
  const result = spawnSync(path, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024,
    env: buildStrixChildEnvironment(),
  });
  if (result.error) return null;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().replace(/\0/g, "");
  return output.length === 0 ? null : output.slice(0, 8_192);
}

export async function preflightArtifacts(
  config: StrixKvCandidateConfig,
  mmapConfigPath: string,
  versionCommand: (path: string) => string | null = commandVersion,
): Promise<{
  mmapConfig: ReturnType<typeof validateStrixMmapAbConfig>;
  hashes: Record<string, string>;
  versions: Record<string, string | null>;
}> {
  const mmapText = readFileSync(mmapConfigPath, "utf8");
  if (Buffer.byteLength(mmapText) > MAX_CONFIG_BYTES) throw new Error("mmap config exceeds 64 KiB");
  const mmapConfig = validateStrixMmapAbConfig(JSON.parse(mmapText) as unknown);
  if (mmapConfig.modelPath !== config.model.path || mmapConfig.modelArtifactSha256 !== config.model.artifactSha256 ||
      mmapConfig.runtimeCommit !== config.productionRuntime.commit || mmapConfig.backend !== config.localExperiment.backend ||
      mmapConfig.quant !== config.model.quant) {
    throw new Error("mmap and KV candidate configs do not bind the same production runtime/model/backend/quant");
  }

  const artifacts: Array<[string, string, string, boolean]> = [
    ["model", config.model.path, config.model.artifactSha256, false],
    ["mmapServer", mmapConfig.binaryPath, mmapConfig.runtimeBinarySha256, true],
    ["productionBench", config.productionRuntime.llamaBenchPath, config.productionRuntime.llamaBenchSha256, true],
    ["productionVulkan", config.productionRuntime.vulkanLibraryPath, config.productionRuntime.vulkanLibrarySha256, false],
    ["candidateSourceArchive", config.candidateRuntime.sourceArchivePath, config.candidateRuntime.sourceArchiveSha256, false],
    ["candidateBench", config.candidateRuntime.llamaBenchPath, config.candidateRuntime.llamaBenchSha256, true],
    ["candidateServer", config.candidateRuntime.llamaServerPath, config.candidateRuntime.llamaServerSha256, true],
    ["candidateBackendOps", config.candidateRuntime.backendOpsPath, config.candidateRuntime.backendOpsSha256, true],
    ["candidateVulkan", config.candidateRuntime.vulkanLibraryPath, config.candidateRuntime.vulkanLibrarySha256, false],
  ];
  for (const [, path, , mustExecute] of artifacts) {
    if (mustExecute) executable(path, path);
    else if (!statSync(path).isFile()) throw new Error(`artifact is not a regular file: ${path}`);
  }
  const hashes: Record<string, string> = {};
  for (const [label, path, expected] of artifacts) {
    const observed = await sha256File(path);
    if (observed !== expected) throw new Error(`${label} hash differs from the reviewed config`);
    hashes[label] = observed;
  }
  const versions = {
    mmapServer: versionCommand(mmapConfig.binaryPath),
    candidateServer: versionCommand(config.candidateRuntime.llamaServerPath),
  };
  if (versions.mmapServer === null || !versions.mmapServer.includes(config.productionRuntime.commit.slice(0, 8))) {
    throw new Error("mmap server version does not prove the pinned production commit");
  }
  if (versions.candidateServer === null || !versions.candidateServer.includes(config.candidateRuntime.backportCommit.slice(0, 8))) {
    throw new Error("candidate server version does not prove the pinned backport commit");
  }
  return {
    mmapConfig,
    hashes,
    versions,
  };
}

export async function runBackendCorrectness(config: StrixKvCandidateConfig): Promise<BackendEvidence> {
  const argv = config.localExperiment.backendCorrectnessCommand.slice(1);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const stdoutHash = createHash("sha256");
  const stderrHash = createHash("sha256");
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const child = spawn(config.candidateRuntime.backendOpsPath, argv, {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    env: buildStrixChildEnvironment(process.env, { GGML_VK_VISIBLE_DEVICES: "0" }),
  });
  activeChild = child;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdoutHash.update(chunk);
    if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderrHash.update(chunk);
    if (stderrBytes > MAX_CHILD_OUTPUT_BYTES) child.kill("SIGTERM");
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  }).finally(() => { if (activeChild === child) activeChild = null; });
  const evidence: BackendEvidence = {
    pathSha256: config.candidateRuntime.backendOpsSha256,
    argvSha256: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    exitCode,
    stdoutSha256: stdoutHash.digest("hex"),
    stderrSha256: stderrHash.digest("hex"),
    stdoutBytes,
    stderrBytes,
    outputWithinLimit: stdoutBytes <= MAX_CHILD_OUTPUT_BYTES && stderrBytes <= MAX_CHILD_OUTPUT_BYTES,
  };
  return evidence;
}

function validateBenchmarkReport(
  value: unknown,
  config: StrixKvCandidateConfig,
  plan: StrixKvRunPlan,
): StrixBenchmarkReport {
  if (value === null || typeof value !== "object") throw new Error("benchmark report must be an object");
  const report = value as StrixBenchmarkReport;
  if (report.schemaVersion !== 1 || report.model.artifactSha256 !== config.model.artifactSha256 ||
      report.model.id !== config.model.id || report.runtime.commit !== plan.expectedRuntimeCommit ||
      !report.runtime.backend.toLowerCase().includes("vulkan") ||
      report.configuration.kvTypeK !== plan.arm.kvK || report.configuration.kvTypeV !== plan.arm.kvV ||
      JSON.stringify(report.configuration.contexts) !== JSON.stringify(config.localExperiment.contexts) ||
      report.configuration.flashAttention !== "on" || report.configuration.parallelism !== 1 ||
      report.configuration.speculation !== "none") {
    throw new Error(`benchmark report provenance/configuration mismatch for ${plan.arm.id}`);
  }
  assertStrixBenchmarkCoverage(report.results, config.localExperiment.contexts);
  return report;
}

function markdownSummary(input: {
  startedAt: string;
  finishedAt: string;
  mmapExitCode: number;
  runs: StrixCombinedRunEvidence[];
  restored: boolean;
  kvDecision: "advance-to-agent-gate" | "reject";
}): string {
  return [
    "# Strix combined maintenance experiment",
    "",
    `Started: ${input.startedAt}`,
    `Finished: ${input.finishedAt}`,
    `mmap decision exit: ${input.mmapExitCode === 0 ? "promote" : "reject"}`,
    `KV runs with complete direct coverage: ${input.runs.length}`,
    `KV microbenchmark decision: ${input.kvDecision}`,
    `Residency restored: ${input.restored ? "yes" : "no"}`,
    "Deployment status: **not authorized by this evidence**",
    "",
    "Mmap and KV candidate decisions are independent. Passing microbenchmarks advance the KV candidate only to a representative agent-workload gate.",
    "",
  ].join("\n");
}

export async function runStrixCombined(argv: string[]): Promise<number> {
  const args = parseStrixCombinedArgs(argv);
  if (process.platform !== "linux") throw new Error("combined Strix experiment requires Linux");
  const configText = readFileSync(args.configPath, "utf8");
  if (Buffer.byteLength(configText) > MAX_CONFIG_BYTES) throw new Error("candidate config exceeds 64 KiB");
  const config = validateStrixKvCandidateConfig(JSON.parse(configText) as unknown);

  // Every expensive artifact is hashed before executeStrixCombinedExperiment can unload anything.
  const preflight = await preflightArtifacts(config, args.mmapConfigPath);
  let interruptedBy: NodeJS.Signals | null = null;
  let deadlineExceeded = false;
  const benchmarkAbort = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => {
    interruptedBy ??= signal;
    benchmarkAbort.abort();
    activeChild?.kill("SIGTERM");
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, onSignal);
  const deadlineTimer = armStrixRuntimeDeadline(args.maxRuntimeSeconds, () => {
    deadlineExceeded = true;
    // Deliver the same catchable signal to this module and the nested mmap runner. Both runners
    // terminate their active child and execute their required residency-restoration path.
    process.kill(process.pid, "SIGTERM");
  });
  const startedAt = new Date().toISOString();
  let backendEvidence: BackendEvidence | null = null;
  const reports: Array<{ evidence: StrixCombinedRunEvidence; report: StrixBenchmarkReport }> = [];
  try {
    const result = await executeStrixCombinedExperiment(config, args, {
      snapshot: async () => await runningSnapshot(args.llamaSwapOrigin),
      runMmap: async () => await runStrixMmapAb([
        "--config", args.mmapConfigPath,
        "--out", `${resolve(args.outDir)}/mmap-ab`,
        "--llama-swap-origin", args.llamaSwapOrigin,
        "--expected-resident-model", args.expectedResidentModel ?? "none",
        "--cycles", String(config.promotionGate.minimumCycles),
        "--ack-exclusive-window",
      ]),
      unload: async () => await unloadAll(args.llamaSwapOrigin),
      runBackendCorrectness: async () => {
        backendEvidence = await runBackendCorrectness(config);
        if (!backendEvidence.outputWithinLimit) throw new Error("backend correctness output exceeded its bound");
        if (backendEvidence.exitCode !== 0) {
          throw new Error(`focused Vulkan backend correctness failed with exit code ${backendEvidence.exitCode}`);
        }
      },
      runBenchmark: async (plan) => {
        const exitCode = await runStrixBenchmark(buildStrixBenchmarkArgv(config, plan), {
          ...DEFAULT_DEPS,
          hashModel: async (path) => {
            if (path !== config.model.path) throw new Error("benchmark requested an unreviewed model path");
            return config.model.artifactSha256;
          },
          stdout: () => {},
          stderr: (line) => console.error(line),
        }, benchmarkAbort.signal);
        if (exitCode !== 0) throw new Error(`benchmark runner failed for ${plan.arm.id} in cycle ${plan.cycle + 1}`);
        const reportPath = `${resolve(plan.outPrefix)}.json`;
        const report = validateBenchmarkReport(readBoundedJson(reportPath), config, plan);
        const evidence = { cycle: plan.cycle, sequence: plan.sequence, armId: plan.arm.id, reportPath } as const;
        reports.push({ evidence, report });
        return evidence;
      },
      restore: async (initial) => await restoreResidency(args.llamaSwapOrigin, initial),
      interruptedBy: () => interruptedBy,
    });
    const postflightModelSha256 = await sha256File(config.model.path);
    if (postflightModelSha256 !== config.model.artifactSha256) {
      throw new Error("model artifact hash changed across the combined experiment");
    }
    const finishedAt = new Date().toISOString();
    const receipt = {
      schemaVersion: 1,
      label: "LOCAL-MEASURED",
      startedAt,
      finishedAt,
      candidateId: config.candidateId,
      runtimeBound: { maxRuntimeSeconds: args.maxRuntimeSeconds, deadlineExceeded },
      preflight: { artifactSha256: preflight.hashes, runtimeVersions: preflight.versions },
      postflight: { modelArtifactSha256: postflightModelSha256 },
      mmap: { exitCode: result.mmapExitCode, reportPath: `${resolve(args.outDir)}/mmap-ab.json` },
      backendCorrectness: backendEvidence,
      kvEvaluation: evaluateStrixKvMicrobenchmarks(config, reports.map(({ evidence, report }) => ({
        cycle: evidence.cycle,
        armId: evidence.armId,
        peakRssBytes: report.telemetry.peakRssBytes,
        maxTemperatureC: report.telemetry.maxTemperatureC,
        results: report.results,
      }))),
      kvRuns: reports.map(({ evidence, report }) => ({
        ...evidence,
        runtimeCommit: report.runtime.commit,
        kvK: report.configuration.kvTypeK,
        kvV: report.configuration.kvTypeV,
        peakRssBytes: report.telemetry.peakRssBytes,
        maxTemperatureC: report.telemetry.maxTemperatureC,
        results: report.results,
      })),
      initialResidency: result.initialResidency,
      finalResidency: result.finalResidency,
      restored: result.restored,
      deploymentStatus: result.deploymentStatus,
      nextGate: "evaluate the isolated microbenchmark deltas, then run a representative agent workload before any deployment proposal",
    };
    const receiptPath = `${resolve(args.outDir)}/combined-receipt.json`;
    const markdownPath = `${resolve(args.outDir)}/combined-receipt.md`;
    atomicWrite(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    atomicWrite(markdownPath, markdownSummary({
      startedAt, finishedAt, mmapExitCode: result.mmapExitCode, runs: result.runs, restored: result.restored,
      kvDecision: receipt.kvEvaluation.decision,
    }));
    console.log(JSON.stringify({ status: receipt.kvEvaluation.decision, receiptPath, markdownPath, restored: true, deployed: false }));
    return 0;
  } catch (error) {
    const failurePath = `${resolve(args.outDir)}/combined-failure.json`;
    atomicWrite(failurePath, `${JSON.stringify({
      schemaVersion: 1,
      label: "LOCAL-MEASURED-INCOMPLETE",
      startedAt,
      failedAt: new Date().toISOString(),
      candidateId: config.candidateId,
      runtimeBound: { maxRuntimeSeconds: args.maxRuntimeSeconds, deadlineExceeded },
      error: error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) },
      interruptedBy,
      preflight: { artifactSha256: preflight.hashes, runtimeVersions: preflight.versions },
      backendCorrectness: backendEvidence,
      completedKvRuns: reports.map(({ evidence, report }) => ({
        ...evidence,
        runtimeCommit: report.runtime.commit,
        kvK: report.configuration.kvTypeK,
        kvV: report.configuration.kvTypeV,
      })),
      deploymentStatus: "not-authorized-by-evidence",
      note: "Inspect live residency and the maintenance-window receipt; this failure receipt does not claim restoration or deployment.",
    }, null, 2)}\n`);
    console.error(JSON.stringify({ status: "failed", failurePath, deployed: false }));
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    for (const signal of signals) process.removeListener(signal, onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStrixCombined(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
