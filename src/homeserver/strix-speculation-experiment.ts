import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { StrixResidentEntry } from "./strix-combined-experiment.js";
import { validateComparableServerReport } from "./strix-benchmark-comparison.js";
import {
  aggregateServerBatches,
  type StrixServerBatch,
  type StrixServerProvenance,
} from "./strix-server-benchmark.js";

export interface StrixSpeculationExperimentArgs {
  configPath: string;
  outDir: string;
  llamaSwapOrigin: string;
  expectedResidentModel: string | null;
  maxRuntimeSeconds: number;
  ackExclusiveWindow: true;
}

export interface StrixSpeculationArm {
  id: "direct" | `draft-mtp-${number}`;
  speculation: "none" | "draft-mtp";
  draftDepth: number | null;
}

export interface StrixSpeculationExperimentConfig {
  schemaVersion: 1;
  status: "hardware-validation-pending";
  runtime: {
    commit: string;
    binaryPath: string;
    binarySha256: string;
    vulkanLibraryPath: string;
    vulkanLibrarySha256: string;
  };
  model: {
    id: string;
    path: string;
    artifactSha256: string;
    quant: string;
    mmprojPath: string | null;
    mmprojSha256: string | null;
  };
  server: {
    port: number;
    backend: "vulkan";
    contextSize: number;
    kvTypeK: string;
    kvTypeV: string;
    flashAttention: "on";
    batch: number;
    ubatch: number;
    parallelism: 1;
    cacheRamMiB: number;
    contextCheckpoints: number;
    checkpointMinStep: number;
    cacheIdleSlots: "on" | "off";
    commonArgs: string[];
  };
  benchmark: {
    fixturesPath: string;
    fixturesSha256: string;
    concurrency: number[];
    maxTokens: number;
    timeoutMs: number;
    speculativeDepths: number[];
    minimumUsefulWorkGainPercent: number;
  };
  promotionGate: { deploymentStatus: "not-authorized-by-evidence" };
}

export interface StrixSpeculationRunPlan {
  cycle: number;
  position: number;
  sequence: number;
  arm: StrixSpeculationArm;
  serverArgv: string[];
  serverArgsSha256: string;
  outPrefix: string;
}

export interface StrixSpeculationRunEvidence {
  cycle: number;
  position: number;
  sequence: number;
  armId: StrixSpeculationArm["id"];
  reportPath: string;
}

export interface StrixSpeculationCycleReport {
  cycle: number;
  armId: StrixSpeculationArm["id"];
  report: unknown;
}

export interface StrixMergedSpeculationReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  endpointOrigin: string;
  model: string;
  fixtureSha256: string;
  provenanceSha256: string;
  provenance: StrixServerProvenance;
  configuration: Record<string, unknown>;
  batches: StrixServerBatch[];
  summaries: ReturnType<typeof aggregateServerBatches>;
  measurementLimits: string[];
}

export interface StrixSpeculationExecutionResult {
  runs: StrixSpeculationRunEvidence[];
  initialResidency: StrixResidentEntry[];
  finalResidency: StrixResidentEntry[];
  restored: true;
  deploymentStatus: "not-authorized-by-evidence";
}

export interface StrixSpeculationExecutionDependencies {
  snapshot(): Promise<StrixResidentEntry[]>;
  unload(): Promise<void>;
  runArm(plan: StrixSpeculationRunPlan): Promise<StrixSpeculationRunEvidence>;
  restore(initial: StrixResidentEntry[]): Promise<void>;
  interruptedBy(): string | null;
}

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
const CONTROLLED_FLAGS = new Set([
  "-m", "--model", "-mm", "--mmproj", "--host", "--port", "--metrics",
  "-c", "--ctx-size", "-ctk", "--cache-type-k", "-ctv", "--cache-type-v",
  "-fa", "--flash-attn", "-b", "--batch-size", "-ub", "--ubatch-size",
  "-np", "--parallel", "--cache-ram", "--spec-type", "--spec-draft-n-max",
  "--ctx-checkpoints", "--checkpoint-min-step",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(record: Record<string, unknown>, key: string, label: string, max = 1_024): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`${label}.${key} must be a bounded single-line string`);
  }
  return value;
}

function absolutePath(record: Record<string, unknown>, key: string, label: string): string {
  const value = boundedString(record, key, label);
  if (!value.startsWith("/")) throw new Error(`${label}.${key} must be an absolute path`);
  return value;
}

function hash(record: Record<string, unknown>, key: string, label: string): string {
  const value = boundedString(record, key, label, 64);
  if (!HASH_RE.test(value)) throw new Error(`${label}.${key} must be a lowercase SHA-256`);
  return value;
}

function positiveInteger(record: Record<string, unknown>, key: string, label: string, maximum: number): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${label}.${key} must be a positive integer at most ${maximum}`);
  }
  return value as number;
}

function nullableArtifact(record: Record<string, unknown>, pathKey: string, hashKey: string, label: string): [string | null, string | null] {
  const path = record[pathKey];
  const digest = record[hashKey];
  if (path === null && digest === null) return [null, null];
  if (typeof path !== "string" || !path.startsWith("/") || /[\r\n\0]/.test(path)) {
    throw new Error(`${label}.${pathKey} must be an absolute path or null`);
  }
  if (typeof digest !== "string" || !HASH_RE.test(digest)) {
    throw new Error(`${label}.${hashKey} must be a lowercase SHA-256 when ${pathKey} is set`);
  }
  return [path, digest];
}

function integerArray(record: Record<string, unknown>, key: string, label: string, minimumItems: number, maximumValue: number): number[] {
  const raw = record[key];
  if (!Array.isArray(raw) || raw.length < minimumItems || raw.length > 16) {
    throw new Error(`${label}.${key} must contain at least ${minimumItems} bounded integers`);
  }
  const values = raw.map((value, index) => {
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximumValue) {
      throw new Error(`${label}.${key}[${index}] must be a positive integer at most ${maximumValue}`);
    }
    return value as number;
  });
  for (let index = 1; index < values.length; index++) {
    if (values[index]! <= values[index - 1]!) throw new Error(`${label}.${key} must be strictly increasing and unique`);
  }
  return values;
}

function commonArgs(record: Record<string, unknown>): string[] {
  const raw = record["commonArgs"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128) throw new Error("server.commonArgs must be a bounded non-empty array");
  return raw.map((value, index) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || /[\r\n\0]/.test(value)) {
      throw new Error(`server.commonArgs[${index}] must be a bounded single-line string`);
    }
    const controlled = [...CONTROLLED_FLAGS].find((flag) => value === flag || value.startsWith(`${flag}=`));
    if (controlled !== undefined) throw new Error(`server.commonArgs contains controlled flag ${controlled}`);
    return value;
  });
}

export function validateStrixSpeculationExperimentConfig(value: unknown): StrixSpeculationExperimentConfig {
  const root = object(value, "config");
  if (root["schemaVersion"] !== 1) throw new Error("config.schemaVersion must be 1");
  if (root["status"] !== "hardware-validation-pending") throw new Error("config status must remain hardware-validation-pending");

  const runtime = object(root["runtime"], "runtime");
  const runtimeCommit = boundedString(runtime, "commit", "runtime", 40);
  if (!COMMIT_RE.test(runtimeCommit)) throw new Error("runtime.commit must be a full lowercase Git revision");
  const parsedRuntime = {
    commit: runtimeCommit,
    binaryPath: absolutePath(runtime, "binaryPath", "runtime"),
    binarySha256: hash(runtime, "binarySha256", "runtime"),
    vulkanLibraryPath: absolutePath(runtime, "vulkanLibraryPath", "runtime"),
    vulkanLibrarySha256: hash(runtime, "vulkanLibrarySha256", "runtime"),
  };

  const model = object(root["model"], "model");
  const modelId = boundedString(model, "id", "model", 160);
  if (!SAFE_ID_RE.test(modelId)) throw new Error("model.id must be a safe model identifier");
  const [mmprojPath, mmprojSha256] = nullableArtifact(model, "mmprojPath", "mmprojSha256", "model");
  const parsedModel = {
    id: modelId,
    path: absolutePath(model, "path", "model"),
    artifactSha256: hash(model, "artifactSha256", "model"),
    quant: boundedString(model, "quant", "model", 80),
    mmprojPath,
    mmprojSha256,
  };

  const server = object(root["server"], "server");
  const port = positiveInteger(server, "port", "server", 65_535);
  if (port < 1_024) throw new Error("server.port must be at least 1024");
  if (server["backend"] !== "vulkan") throw new Error("server.backend must be vulkan for this Strix reference experiment");
  if (server["flashAttention"] !== "on") throw new Error("server.flashAttention must be on");
  if (server["parallelism"] !== 1) throw new Error("server.parallelism must be exactly 1 for native MTP qualification");
  const rawCacheIdleSlots = server["cacheIdleSlots"];
  if (rawCacheIdleSlots !== "on" && rawCacheIdleSlots !== "off") throw new Error("server.cacheIdleSlots must be on or off");
  const cacheIdleSlots: "on" | "off" = rawCacheIdleSlots;
  const parsedServer = {
    port,
    backend: "vulkan" as const,
    contextSize: positiveInteger(server, "contextSize", "server", 1_048_576),
    kvTypeK: boundedString(server, "kvTypeK", "server", 40),
    kvTypeV: boundedString(server, "kvTypeV", "server", 40),
    flashAttention: "on" as const,
    batch: positiveInteger(server, "batch", "server", 65_536),
    ubatch: positiveInteger(server, "ubatch", "server", 65_536),
    parallelism: 1 as const,
    cacheRamMiB: positiveInteger(server, "cacheRamMiB", "server", 1_048_576),
    contextCheckpoints: positiveInteger(server, "contextCheckpoints", "server", 1_024),
    checkpointMinStep: positiveInteger(server, "checkpointMinStep", "server", 1_048_576),
    cacheIdleSlots,
    commonArgs: commonArgs(server),
  };
  if (parsedServer.ubatch > parsedServer.batch) throw new Error("server.ubatch must not exceed server.batch");

  const benchmark = object(root["benchmark"], "benchmark");
  const concurrency = integerArray(benchmark, "concurrency", "benchmark", 2, 64);
  if (concurrency[0] !== 1) throw new Error("benchmark.concurrency must include 1 as its first cell");
  if (!Array.isArray(benchmark["speculativeDepths"]) || benchmark["speculativeDepths"].length < 2) {
    throw new Error("benchmark.speculativeDepths must contain at least two depths");
  }
  const speculativeDepths = integerArray(benchmark, "speculativeDepths", "benchmark", 2, 16);
  const minimumUsefulWorkGainPercent = benchmark["minimumUsefulWorkGainPercent"];
  if (typeof minimumUsefulWorkGainPercent !== "number" || !Number.isFinite(minimumUsefulWorkGainPercent) ||
      minimumUsefulWorkGainPercent < 0 || minimumUsefulWorkGainPercent > 100) {
    throw new Error("benchmark.minimumUsefulWorkGainPercent must be between 0 and 100");
  }
  const parsedBenchmark = {
    fixturesPath: absolutePath(benchmark, "fixturesPath", "benchmark"),
    fixturesSha256: hash(benchmark, "fixturesSha256", "benchmark"),
    concurrency,
    maxTokens: positiveInteger(benchmark, "maxTokens", "benchmark", 32_768),
    timeoutMs: positiveInteger(benchmark, "timeoutMs", "benchmark", 3_600_000),
    speculativeDepths,
    minimumUsefulWorkGainPercent,
  };

  const promotionGate = object(root["promotionGate"], "promotionGate");
  if (promotionGate["deploymentStatus"] !== "not-authorized-by-evidence") {
    throw new Error("promotionGate must not claim deployment authority");
  }
  return {
    schemaVersion: 1,
    status: "hardware-validation-pending",
    runtime: parsedRuntime,
    model: parsedModel,
    server: parsedServer,
    benchmark: parsedBenchmark,
    promotionGate: { deploymentStatus: "not-authorized-by-evidence" },
  };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function loopbackOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("--llama-swap-origin must be a loopback HTTP origin"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username !== "" || url.password !== "" || (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" || url.hash !== "") {
    throw new Error("--llama-swap-origin must be a credential-free loopback HTTP origin");
  }
  return url.origin;
}

export function parseStrixSpeculationExperimentArgs(argv: string[]): StrixSpeculationExperimentArgs {
  let configPath: string | null = null;
  let outDir: string | null = null;
  let llamaSwapOrigin = "http://127.0.0.1:8091";
  let expectedResidentModel: string | null | undefined;
  let maxRuntimeSeconds: number | null = null;
  let ackExclusiveWindow = false;
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (seen.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    seen.add(flag);
    if (flag === "--ack-exclusive-window") {
      ackExclusiveWindow = true;
      continue;
    }
    const value = requiredValue(argv, index, flag);
    index++;
    if (flag === "--config") configPath = value;
    else if (flag === "--out-dir") outDir = value;
    else if (flag === "--llama-swap-origin") llamaSwapOrigin = loopbackOrigin(value);
    else if (flag === "--expected-resident-model") {
      expectedResidentModel = value === "none" ? null : value;
      if (expectedResidentModel !== null && !SAFE_ID_RE.test(expectedResidentModel)) {
        throw new Error("--expected-resident-model must be a safe model identifier or 'none'");
      }
    } else if (flag === "--max-runtime-seconds") {
      maxRuntimeSeconds = Number(value);
      if (!Number.isSafeInteger(maxRuntimeSeconds) || maxRuntimeSeconds < 300 || maxRuntimeSeconds > 14_400) {
        throw new Error("--max-runtime-seconds must be an integer from 300 to 14400");
      }
    } else throw new Error(`unrecognized argument: ${flag}`);
  }
  if (configPath === null || configPath.trim() === "") throw new Error("--config is required");
  if (outDir === null || outDir.trim() === "") throw new Error("--out-dir is required");
  if (expectedResidentModel === undefined) throw new Error("--expected-resident-model is required");
  if (maxRuntimeSeconds === null) throw new Error("--max-runtime-seconds is required");
  if (!ackExclusiveWindow) throw new Error("--ack-exclusive-window is required; run only inside maintenance:run");
  return { configPath, outDir, llamaSwapOrigin, expectedResidentModel, maxRuntimeSeconds, ackExclusiveWindow: true };
}

function arms(config: StrixSpeculationExperimentConfig): StrixSpeculationArm[] {
  return [
    { id: "direct", speculation: "none", draftDepth: null },
    ...config.benchmark.speculativeDepths.map((draftDepth): StrixSpeculationArm => ({
      id: `draft-mtp-${draftDepth}`,
      speculation: "draft-mtp",
      draftDepth,
    })),
  ];
}

function serverArgv(config: StrixSpeculationExperimentConfig, arm: StrixSpeculationArm): string[] {
  const argv = [
    config.runtime.binaryPath,
    "--host", "127.0.0.1", "--port", String(config.server.port),
    "-m", config.model.path,
  ];
  if (config.model.mmprojPath !== null) argv.push("-mm", config.model.mmprojPath);
  argv.push(
    "-c", String(config.server.contextSize),
    "-ctk", config.server.kvTypeK, "-ctv", config.server.kvTypeV,
    "-fa", config.server.flashAttention,
    "-b", String(config.server.batch), "-ub", String(config.server.ubatch),
    "-np", String(config.server.parallelism), "--cache-ram", String(config.server.cacheRamMiB),
    "--ctx-checkpoints", String(config.server.contextCheckpoints),
    "--checkpoint-min-step", String(config.server.checkpointMinStep),
    ...config.server.commonArgs,
    "--metrics",
  );
  if (arm.speculation !== "none") argv.push("--spec-type", arm.speculation, "--spec-draft-n-max", String(arm.draftDepth));
  return argv;
}

export function buildStrixSpeculationRunPlans(config: StrixSpeculationExperimentConfig, outDir: string): StrixSpeculationRunPlan[] {
  const experimentArms = arms(config);
  const outputRoot = resolve(outDir);
  const plans: StrixSpeculationRunPlan[] = [];
  let sequence = 0;
  for (let cycle = 0; cycle < experimentArms.length; cycle++) {
    for (let position = 0; position < experimentArms.length; position++) {
      const arm = experimentArms[(cycle + position) % experimentArms.length]!;
      const argv = serverArgv(config, arm);
      plans.push({
        cycle,
        position,
        sequence,
        arm,
        serverArgv: argv,
        serverArgsSha256: createHash("sha256").update(JSON.stringify(argv)).digest("hex"),
        outPrefix: `${outputRoot}/cycle-${String(cycle).padStart(2, "0")}-position-${String(position).padStart(2, "0")}-${arm.id}`,
      });
      sequence++;
    }
  }
  return plans;
}

function reportObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Merge one-repetition reports for one Latin-rotation arm into paired cycle repetitions. */
export function mergeStrixSpeculationCycleReports(
  config: StrixSpeculationExperimentConfig,
  arm: StrixSpeculationArm,
  reports: StrixSpeculationCycleReport[],
): StrixMergedSpeculationReport {
  const expectedCycles = arms(config).length;
  if (reports.length !== expectedCycles) throw new Error(`${arm.id} requires exactly ${expectedCycles} cycle reports`);
  const ordered = [...reports].sort((left, right) => left.cycle - right.cycle);
  const expectedArgvSha = createHash("sha256").update(JSON.stringify(serverArgv(config, arm))).digest("hex");
  let canonical: ReturnType<typeof validateComparableServerReport> | null = null;
  let firstRaw: Record<string, unknown> | null = null;
  const batches: StrixServerBatch[] = [];
  for (let cycle = 0; cycle < ordered.length; cycle++) {
    const item = ordered[cycle]!;
    if (item.cycle !== cycle) throw new Error(`${arm.id} cycle set must be contiguous and unique from zero`);
    if (item.armId !== arm.id) throw new Error(`${arm.id} report contains evidence for ${item.armId}`);
    const raw = reportObject(item.report, `${arm.id}[${cycle}]`);
    const comparable = validateComparableServerReport(raw, `${arm.id}[${cycle}]`);
    if (comparable.provenance.serverArgsSha256 !== expectedArgvSha ||
        comparable.provenance.speculation !== arm.speculation ||
        comparable.provenance.draftDepth !== arm.draftDepth) {
      throw new Error(`${arm.id} report provenance does not match its reviewed arm`);
    }
    if (canonical !== null && (
      comparable.model !== canonical.model || comparable.fixtureSha256 !== canonical.fixtureSha256 ||
      JSON.stringify({ ...comparable.provenance, serverArgsSha256: "", speculation: "", draftDepth: null }) !==
        JSON.stringify({ ...canonical.provenance, serverArgsSha256: "", speculation: "", draftDepth: null })
    )) throw new Error(`${arm.id} cycle reports changed controlled model, fixture, or provenance`);
    const rawBatches = raw["batches"];
    if (!Array.isArray(rawBatches) || rawBatches.length === 0) throw new Error(`${arm.id}[${cycle}].batches must be non-empty`);
    if (rawBatches.some((batch) => reportObject(batch, "batch")["repetition"] !== 0)) {
      throw new Error(`${arm.id}[${cycle}] must contain exactly one benchmark repetition`);
    }
    const expectedCells = new Set(comparable.summaries.map((summary) => `${summary.fixtureId}\0${summary.taskType}\0${summary.concurrency}`));
    const observedCells = new Set(rawBatches.map((batch) => {
      const record = reportObject(batch, "batch");
      return `${String(record["fixtureId"])}\0${String(record["taskType"])}\0${String(record["concurrency"])}`;
    }));
    if (rawBatches.length !== expectedCells.size || expectedCells.size !== observedCells.size || [...expectedCells].some((key) => !observedCells.has(key))) {
      throw new Error(`${arm.id}[${cycle}] batch cells differ from its summaries`);
    }
    batches.push(...rawBatches.map((batch) => ({ ...(batch as StrixServerBatch), repetition: cycle })));
    canonical ??= comparable;
    firstRaw ??= raw;
  }
  const raw = firstRaw!;
  const startedAt = ordered.map((item) => String(reportObject(item.report, "report")["startedAt"])).sort()[0]!;
  const finishedAt = ordered.map((item) => String(reportObject(item.report, "report")["finishedAt"])).sort().at(-1)!;
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    endpointOrigin: String(raw["endpointOrigin"]),
    model: canonical!.model,
    fixtureSha256: canonical!.fixtureSha256,
    provenanceSha256: String(raw["provenanceSha256"]),
    provenance: canonical!.provenance,
    configuration: { ...reportObject(raw["configuration"], "configuration"), repetitions: expectedCycles },
    batches,
    summaries: aggregateServerBatches(batches),
    measurementLimits: [
      ...((Array.isArray(raw["measurementLimits"]) ? raw["measurementLimits"] : []).filter((item): item is string => typeof item === "string")),
      "Latin rotation balances each arm across every execution position; repetition indexes identify paired cycles.",
      "This merged evidence does not authorize deployment.",
    ],
  };
}

function assertExpectedResidency(snapshot: StrixResidentEntry[], expected: string | null): void {
  if (snapshot.some((entry) => entry.state === "starting")) throw new Error("llama-swap residency is not stable");
  const ready = snapshot.filter((entry) => entry.state === "ready");
  if (ready.length > 1) throw new Error("more than one ready model violates the serial-GPU restore contract");
  const observed = ready[0]?.model ?? null;
  if (observed !== expected) throw new Error(`resident model changed: expected ${expected ?? "none"}, observed ${observed ?? "none"}`);
}

export async function executeStrixSpeculationExperiment(
  config: StrixSpeculationExperimentConfig,
  args: StrixSpeculationExperimentArgs,
  dependencies: StrixSpeculationExecutionDependencies,
): Promise<StrixSpeculationExecutionResult> {
  const initialResidency = await dependencies.snapshot();
  assertExpectedResidency(initialResidency, args.expectedResidentModel);
  const plans = buildStrixSpeculationRunPlans(config, args.outDir);
  const runs: StrixSpeculationRunEvidence[] = [];
  let operationError: unknown;
  try {
    await dependencies.unload();
    for (const plan of plans) {
      const before = dependencies.interruptedBy();
      if (before !== null) throw new Error(`speculation experiment interrupted by ${before}`);
      runs.push(await dependencies.runArm(plan));
      const after = dependencies.interruptedBy();
      if (after !== null) throw new Error(`speculation experiment interrupted by ${after}`);
    }
  } catch (error) {
    operationError = error;
  }

  let restoreError: unknown;
  try { await dependencies.restore(initialResidency); } catch (error) { restoreError = error; }
  const afterRestoreSignal = dependencies.interruptedBy();
  if (operationError === undefined && afterRestoreSignal !== null) {
    operationError = new Error(`speculation experiment interrupted by ${afterRestoreSignal}`);
  }
  if (operationError !== undefined && restoreError !== undefined) {
    throw new AggregateError([operationError, restoreError], "speculation experiment and required residency restoration both failed");
  }
  if (restoreError !== undefined) throw restoreError;
  if (operationError !== undefined) throw operationError;

  const finalResidency = await dependencies.snapshot();
  assertExpectedResidency(finalResidency, args.expectedResidentModel);
  return {
    runs,
    initialResidency,
    finalResidency,
    restored: true,
    deploymentStatus: "not-authorized-by-evidence",
  };
}
