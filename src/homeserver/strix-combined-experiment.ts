import type { StrixBenchmarkResult } from "./strix-benchmark.js";

export type KvRuntime = "production" | "candidate";
export type KvType = "f16" | "q8_0";

export interface StrixKvArm {
  id: "production-f16-kv" | "production-q8-kv" | "candidate-q8-kv";
  runtime: KvRuntime;
  kvK: KvType;
  kvV: KvType;
  purpose: string;
}

export interface StrixKvCandidateConfig {
  schemaVersion: 1;
  status: "build-passed-gpu-validation-pending";
  candidateId: string;
  productionRuntime: {
    commit: string;
    llamaBenchPath: string;
    llamaBenchSha256: string;
    vulkanLibraryPath: string;
    vulkanLibrarySha256: string;
  };
  candidateRuntime: {
    backportCommit: string;
    sourceArchivePath: string;
    sourceArchiveSha256: string;
    llamaBenchPath: string;
    llamaServerPath: string;
    backendOpsPath: string;
    llamaBenchSha256: string;
    llamaServerSha256: string;
    backendOpsSha256: string;
    vulkanLibraryPath: string;
    vulkanLibrarySha256: string;
  };
  model: {
    path: string;
    id: string;
    quant: string;
    artifactSha256: string;
  };
  localExperiment: {
    backend: "vulkan";
    flashAttention: "on";
    batch: number;
    ubatch: number;
    parallelism: 1;
    speculation: "none";
    contexts: number[];
    ppTokens: number;
    tgTokens: number;
    repetitions: number;
    arms: StrixKvArm[];
    backendCorrectnessCommand: string[];
    executionPolicy: string;
    residencyPolicy: string;
  };
  promotionGate: {
    minimumCycles: number;
    deploymentStatus: "not-authorized-by-evidence";
  };
}

export interface StrixCombinedArgs {
  configPath: string;
  mmapConfigPath: string;
  outDir: string;
  llamaSwapOrigin: string;
  expectedResidentModel: string | null;
  maxRuntimeSeconds: number;
  ackExclusiveWindow: true;
}

export interface StrixKvRunPlan {
  cycle: number;
  sequence: number;
  arm: StrixKvArm;
  llamaBenchPath: string;
  expectedRuntimeCommit: string;
  outPrefix: string;
}

export interface StrixResidentEntry {
  model: string;
  state: string;
  ttl?: number;
}

export interface StrixCombinedRunEvidence {
  cycle: number;
  sequence: number;
  armId: StrixKvArm["id"];
  reportPath: string;
}

export interface StrixCombinedExecutionResult {
  mmapExitCode: 0 | 2;
  runs: StrixCombinedRunEvidence[];
  initialResidency: StrixResidentEntry[];
  finalResidency: StrixResidentEntry[];
  restored: true;
  deploymentStatus: "not-authorized-by-evidence";
}

export interface StrixCombinedExecutionDependencies {
  snapshot(): Promise<StrixResidentEntry[]>;
  runMmap(): Promise<number>;
  unload(): Promise<void>;
  runBackendCorrectness(): Promise<void>;
  runBenchmark(plan: StrixKvRunPlan): Promise<StrixCombinedRunEvidence>;
  restore(initial: StrixResidentEntry[]): Promise<void>;
  interruptedBy(): string | null;
}

export interface StrixKvMeasuredRun {
  cycle: number;
  armId: StrixKvArm["id"];
  peakRssBytes: number | null;
  maxTemperatureC: number | null;
  results: StrixBenchmarkResult[];
}

export interface StrixKvCellComparison {
  contextDepth: number;
  phase: "pp" | "tg";
  productionF16: number;
  productionQ8: number;
  candidateQ8: number;
  candidateVsProductionQ8: number;
  candidateVsProductionF16: number;
}

export interface StrixKvMicrobenchmarkEvaluation {
  decision: "advance-to-agent-gate" | "reject";
  reasons: string[];
  comparisons: StrixKvCellComparison[];
  medianPeakRssBytes: Record<StrixKvArm["id"], number | null>;
  maxObservedTemperatureC: Record<StrixKvArm["id"], number | null>;
  deploymentAuthorized: false;
}

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
const REQUIRED_CONTEXTS = [8192, 32768, 65536, 131072] as const;
const EXPECTED_ARMS: Array<Pick<StrixKvArm, "id" | "runtime" | "kvK" | "kvV">> = [
  { id: "production-f16-kv", runtime: "production", kvK: "f16", kvV: "f16" },
  { id: "production-q8-kv", runtime: "production", kvK: "q8_0", kvV: "q8_0" },
  { id: "candidate-q8-kv", runtime: "candidate", kvK: "q8_0", kvV: "q8_0" },
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(record: Record<string, unknown>, key: string, max = 1_024): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`${key} must be a bounded single-line string`);
  }
  return value;
}

function absolutePath(record: Record<string, unknown>, key: string): string {
  const value = boundedString(record, key);
  if (!value.startsWith("/")) throw new Error(`${key} must be an absolute path`);
  return value;
}

function sha256(record: Record<string, unknown>, key: string): string {
  const value = boundedString(record, key, 64);
  if (!HASH_RE.test(value)) throw new Error(`${key} must be a lowercase SHA-256`);
  return value;
}

function commit(record: Record<string, unknown>, key: string): string {
  const value = boundedString(record, key, 40);
  if (!COMMIT_RE.test(value)) throw new Error(`${key} must be a full lowercase Git commit`);
  return value;
}

function positiveInteger(record: Record<string, unknown>, key: string, max: number): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > max) {
    throw new Error(`${key} must be a positive integer at most ${max}`);
  }
  return value as number;
}

function stringArray(record: Record<string, unknown>, key: string, maxItems: number): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) throw new Error(`${key} must be a bounded non-empty array`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 1_024 || /[\r\n\0]/.test(item)) {
      throw new Error(`${key}[${index}] must be a bounded single-line string`);
    }
    return item;
  });
}

export function validateStrixKvCandidateConfig(value: unknown): StrixKvCandidateConfig {
  const root = object(value, "candidate config");
  if (root["schemaVersion"] !== 1) throw new Error("schemaVersion must be 1");
  if (root["status"] !== "build-passed-gpu-validation-pending") throw new Error("candidate status is not pending GPU validation");
  const candidateId = boundedString(root, "candidateId", 160);
  if (!SAFE_ID_RE.test(candidateId)) throw new Error("candidateId contains unsafe characters");

  const production = object(root["productionRuntime"], "productionRuntime");
  const candidate = object(root["candidateRuntime"], "candidateRuntime");
  const model = object(root["model"], "model");
  const experiment = object(root["localExperiment"], "localExperiment");
  const gate = object(root["promotionGate"], "promotionGate");

  if (experiment["backend"] !== "vulkan" || experiment["flashAttention"] !== "on") {
    throw new Error("combined experiment requires Vulkan with Flash Attention on");
  }
  if (experiment["parallelism"] !== 1 || experiment["speculation"] !== "none") {
    throw new Error("combined experiment requires direct single-stream inference");
  }
  const rawContexts = experiment["contexts"];
  if (!Array.isArray(rawContexts) || !rawContexts.every(Number.isInteger)) throw new Error("contexts must be an integer array");
  if (new Set(rawContexts).size !== rawContexts.length) throw new Error("contexts must not contain duplicates");
  if (rawContexts.length !== REQUIRED_CONTEXTS.length || rawContexts.some((depth, index) => depth !== REQUIRED_CONTEXTS[index])) {
    throw new Error(`contexts must equal ${REQUIRED_CONTEXTS.join(",")}`);
  }

  const rawArms = experiment["arms"];
  if (!Array.isArray(rawArms) || rawArms.length !== EXPECTED_ARMS.length) throw new Error("exactly three causal arms are required");
  const arms = rawArms.map((raw, index): StrixKvArm => {
    const arm = object(raw, `arms[${index}]`);
    const expected = EXPECTED_ARMS[index]!;
    if (arm["id"] !== expected.id || arm["runtime"] !== expected.runtime || arm["kvK"] !== expected.kvK || arm["kvV"] !== expected.kvV) {
      throw new Error("causal arms must remain production-F16, production-Q8, candidate-Q8 in that order");
    }
    return { ...expected, purpose: boundedString(arm, "purpose", 300) } as StrixKvArm;
  });

  const backendCorrectnessCommand = stringArray(experiment, "backendCorrectnessCommand", 16);
  if (backendCorrectnessCommand[0] !== "test-backend-ops" ||
      JSON.stringify(backendCorrectnessCommand.slice(1)) !== JSON.stringify(["test", "-b", "Vulkan", "-o", "FLASH_ATTN_EXT", "-j", "1"])) {
    throw new Error("backend correctness command must be the focused serial Vulkan FLASH_ATTN_EXT test");
  }
  const minimumCycles = positiveInteger(gate, "minimumCycles", 4);
  if (minimumCycles < 2) throw new Error("minimumCycles must be at least 2");
  if (gate["deploymentStatus"] !== "not-authorized-by-evidence") throw new Error("candidate must not claim deployment authorization");

  const modelId = boundedString(model, "id", 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(modelId)) throw new Error("model.id must use owner/model form");
  return {
    schemaVersion: 1,
    status: "build-passed-gpu-validation-pending",
    candidateId,
    productionRuntime: {
      commit: commit(production, "commit"),
      llamaBenchPath: absolutePath(production, "llamaBenchPath"),
      llamaBenchSha256: sha256(production, "llamaBenchSha256"),
      vulkanLibraryPath: absolutePath(production, "vulkanLibraryPath"),
      vulkanLibrarySha256: sha256(production, "vulkanLibrarySha256"),
    },
    candidateRuntime: {
      backportCommit: commit(candidate, "backportCommit"),
      sourceArchivePath: absolutePath(candidate, "sourceArchivePath"),
      sourceArchiveSha256: sha256(candidate, "sourceArchiveSha256"),
      llamaBenchPath: absolutePath(candidate, "llamaBenchPath"),
      llamaServerPath: absolutePath(candidate, "llamaServerPath"),
      backendOpsPath: absolutePath(candidate, "backendOpsPath"),
      llamaBenchSha256: sha256(candidate, "llamaBenchSha256"),
      llamaServerSha256: sha256(candidate, "llamaServerSha256"),
      backendOpsSha256: sha256(candidate, "backendOpsSha256"),
      vulkanLibraryPath: absolutePath(candidate, "vulkanLibraryPath"),
      vulkanLibrarySha256: sha256(candidate, "vulkanLibrarySha256"),
    },
    model: {
      path: absolutePath(model, "path"), id: modelId,
      quant: boundedString(model, "quant", 80), artifactSha256: sha256(model, "artifactSha256"),
    },
    localExperiment: {
      backend: "vulkan", flashAttention: "on",
      batch: positiveInteger(experiment, "batch", 65_536),
      ubatch: positiveInteger(experiment, "ubatch", 65_536),
      parallelism: 1, speculation: "none", contexts: [...REQUIRED_CONTEXTS],
      ppTokens: positiveInteger(experiment, "ppTokens", 1_000_000),
      tgTokens: positiveInteger(experiment, "tgTokens", 1_000_000),
      repetitions: positiveInteger(experiment, "repetitions", 100),
      arms, backendCorrectnessCommand,
      executionPolicy: boundedString(experiment, "executionPolicy", 500),
      residencyPolicy: boundedString(experiment, "residencyPolicy", 500),
    },
    promotionGate: { minimumCycles, deploymentStatus: "not-authorized-by-evidence" },
  };
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function loopbackOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("--llama-swap-origin must be a valid loopback HTTP origin"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username !== "" || url.password !== "" || (url.pathname !== "" && url.pathname !== "/") ||
      url.search !== "" || url.hash !== "") throw new Error("--llama-swap-origin must be a credential-free loopback HTTP origin");
  return url.origin;
}

export function parseStrixCombinedArgs(argv: string[]): StrixCombinedArgs {
  let configPath: string | null = null;
  let mmapConfigPath: string | null = null;
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
    if (flag === "--ack-exclusive-window") { ackExclusiveWindow = true; continue; }
    const value = requiredValue(argv, index, flag);
    index++;
    if (flag === "--config") configPath = value;
    else if (flag === "--mmap-config") mmapConfigPath = value;
    else if (flag === "--out-dir") outDir = value;
    else if (flag === "--llama-swap-origin") llamaSwapOrigin = loopbackOrigin(value);
    else if (flag === "--expected-resident-model") {
      expectedResidentModel = value === "none" ? null : value;
      if (expectedResidentModel !== null && !SAFE_ID_RE.test(expectedResidentModel)) throw new Error("unsafe expected resident model");
    } else if (flag === "--max-runtime-seconds") {
      maxRuntimeSeconds = Number(value);
      if (!Number.isInteger(maxRuntimeSeconds) || maxRuntimeSeconds < 600 || maxRuntimeSeconds > 86_400) {
        throw new Error("--max-runtime-seconds must be an integer from 600 through 86400");
      }
    } else throw new Error(`unrecognized argument: ${flag}`);
  }
  if (!configPath) throw new Error("--config is required");
  if (!mmapConfigPath) throw new Error("--mmap-config is required");
  if (!outDir) throw new Error("--out-dir is required");
  if (expectedResidentModel === undefined) throw new Error("--expected-resident-model is required");
  if (maxRuntimeSeconds === null) throw new Error("--max-runtime-seconds is required");
  if (!ackExclusiveWindow) throw new Error("--ack-exclusive-window is required; run only inside maintenance:run");
  return {
    configPath,
    mmapConfigPath,
    outDir,
    llamaSwapOrigin,
    expectedResidentModel,
    maxRuntimeSeconds,
    ackExclusiveWindow: true,
  };
}

export function buildStrixKvRunPlans(config: StrixKvCandidateConfig, outDir: string): StrixKvRunPlan[] {
  const plans: StrixKvRunPlan[] = [];
  for (let cycle = 0; cycle < config.promotionGate.minimumCycles; cycle++) {
    const arms = cycle % 2 === 0 ? config.localExperiment.arms : [...config.localExperiment.arms].reverse();
    for (const arm of arms) {
      const runtime = arm.runtime === "production" ? config.productionRuntime : config.candidateRuntime;
      plans.push({
        cycle,
        sequence: plans.length,
        arm,
        llamaBenchPath: runtime.llamaBenchPath,
        expectedRuntimeCommit: arm.runtime === "production" ? config.productionRuntime.commit : config.candidateRuntime.backportCommit,
        outPrefix: `${outDir.replace(/\/+$/, "")}/cycle-${cycle + 1}-${arm.id}`,
      });
    }
  }
  return plans;
}

export function buildStrixBenchmarkArgv(config: StrixKvCandidateConfig, plan: StrixKvRunPlan): string[] {
  return [
    "--llama-bench", plan.llamaBenchPath,
    "--model", config.model.path,
    "--model-id", config.model.id,
    "--quant", config.model.quant,
    "--backend", config.localExperiment.backend,
    "--contexts", config.localExperiment.contexts.join(","),
    "--kv-k", plan.arm.kvK,
    "--kv-v", plan.arm.kvV,
    "--fa", config.localExperiment.flashAttention,
    "--batch", String(config.localExperiment.batch),
    "--ubatch", String(config.localExperiment.ubatch),
    "--parallelism", String(config.localExperiment.parallelism),
    "--speculation", config.localExperiment.speculation,
    "--pp", String(config.localExperiment.ppTokens),
    "--tg", String(config.localExperiment.tgTokens),
    "--repetitions", String(config.localExperiment.repetitions),
    "--out", plan.outPrefix,
  ];
}

export function assertExpectedStrixResidency(entries: StrixResidentEntry[], expected: string | null): void {
  if (entries.some((entry) => entry.state === "starting")) throw new Error("llama-swap residency is not stable");
  const ready = entries.filter((entry) => entry.state === "ready");
  if (ready.length > 1) throw new Error("more than one ready model violates the serial-GPU contract");
  const observed = ready[0]?.model ?? null;
  if (observed !== expected) {
    throw new Error(`resident model changed: expected ${expected ?? "none"}, observed ${observed ?? "none"}`);
  }
}

export async function executeStrixCombinedExperiment(
  config: StrixKvCandidateConfig,
  args: StrixCombinedArgs,
  dependencies: StrixCombinedExecutionDependencies,
): Promise<StrixCombinedExecutionResult> {
  const initialResidency = await dependencies.snapshot();
  assertExpectedStrixResidency(initialResidency, args.expectedResidentModel);

  const mmapExitCode = await dependencies.runMmap();
  if (mmapExitCode !== 0 && mmapExitCode !== 2) throw new Error(`mmap experiment failed with exit code ${mmapExitCode}`);
  assertExpectedStrixResidency(await dependencies.snapshot(), args.expectedResidentModel);

  const plans = buildStrixKvRunPlans(config, args.outDir);
  const runs: StrixCombinedRunEvidence[] = [];
  let operationError: unknown;
  try {
    await dependencies.unload();
    const beforeBackend = dependencies.interruptedBy();
    if (beforeBackend !== null) throw new Error(`combined experiment interrupted by ${beforeBackend}`);
    await dependencies.runBackendCorrectness();
    for (const plan of plans) {
      const signal = dependencies.interruptedBy();
      if (signal !== null) throw new Error(`combined experiment interrupted by ${signal}`);
      runs.push(await dependencies.runBenchmark(plan));
      const afterRun = dependencies.interruptedBy();
      if (afterRun !== null) throw new Error(`combined experiment interrupted by ${afterRun}`);
    }
  } catch (error) {
    operationError = error;
  }

  let restoreError: unknown;
  try { await dependencies.restore(initialResidency); } catch (error) { restoreError = error; }
  const afterRestoreSignal = dependencies.interruptedBy();
  if (operationError === undefined && afterRestoreSignal !== null) {
    operationError = new Error(`combined experiment interrupted by ${afterRestoreSignal}`);
  }
  if (operationError !== undefined && restoreError !== undefined) {
    throw new AggregateError([operationError, restoreError], "combined experiment and required residency restoration both failed");
  }
  if (restoreError !== undefined) throw restoreError;
  if (operationError !== undefined) throw operationError;

  const finalResidency = await dependencies.snapshot();
  assertExpectedStrixResidency(finalResidency, args.expectedResidentModel);
  return {
    mmapExitCode,
    runs,
    initialResidency,
    finalResidency,
    restored: true,
    deploymentStatus: "not-authorized-by-evidence",
  };
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("cannot calculate a median without values");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function nullableMedian(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return present.length === 0 ? null : median(present);
}

function nullableMax(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return present.length === 0 ? null : Math.max(...present);
}

export function evaluateStrixKvMicrobenchmarks(
  config: StrixKvCandidateConfig,
  runs: StrixKvMeasuredRun[],
): StrixKvMicrobenchmarkEvaluation {
  const armIds = config.localExperiment.arms.map((arm) => arm.id);
  for (const armId of armIds) {
    const armRuns = runs.filter((run) => run.armId === armId);
    if (armRuns.length !== config.promotionGate.minimumCycles || new Set(armRuns.map((run) => run.cycle)).size !== armRuns.length) {
      throw new Error(`${armId} must have one run in every required cycle`);
    }
    for (const run of armRuns) assertCoverage(run.results, config.localExperiment.contexts, `${armId} cycle ${run.cycle + 1}`);
  }
  if (runs.length !== armIds.length * config.promotionGate.minimumCycles) throw new Error("unexpected extra KV benchmark runs");

  const depths = [0, ...config.localExperiment.contexts];
  const phases = ["pp", "tg"] as const;
  const cellMedian = (armId: StrixKvArm["id"], depth: number, phase: "pp" | "tg"): number => median(
    runs.filter((run) => run.armId === armId).map((run) => {
      const cell = run.results.find((result) => result.contextDepth === depth && result.phase === phase);
      if (cell === undefined) throw new Error(`missing ${armId} ${phase} cell at ${depth}`);
      if (!Number.isFinite(cell.tokensPerSecond) || cell.tokensPerSecond <= 0) throw new Error("tokens/s must be positive and finite");
      return cell.tokensPerSecond;
    }),
  );
  const comparisons: StrixKvCellComparison[] = [];
  for (const depth of depths) {
    for (const phase of phases) {
      const productionF16 = cellMedian("production-f16-kv", depth, phase);
      const productionQ8 = cellMedian("production-q8-kv", depth, phase);
      const candidateQ8 = cellMedian("candidate-q8-kv", depth, phase);
      comparisons.push({
        contextDepth: depth,
        phase,
        productionF16,
        productionQ8,
        candidateQ8,
        candidateVsProductionQ8: candidateQ8 / productionQ8,
        candidateVsProductionF16: candidateQ8 / productionF16,
      });
    }
  }

  const reasons: string[] = [];
  for (const depth of [32768, 65536]) {
    const comparison = comparisons.find((cell) => cell.contextDepth === depth && cell.phase === "pp")!;
    if (comparison.candidateVsProductionQ8 < 1.10) reasons.push(`candidate Q8 PP gain at ${depth} is below 10%`);
  }
  for (const comparison of comparisons) {
    if (comparison.candidateVsProductionQ8 < 0.95) {
      reasons.push(`candidate regresses stock Q8 ${comparison.phase.toUpperCase()} at ${comparison.contextDepth} by more than 5%`);
    }
    if (comparison.candidateVsProductionF16 < 0.95) {
      reasons.push(`candidate Q8 regresses production F16 ${comparison.phase.toUpperCase()} at ${comparison.contextDepth} by more than 5%`);
    }
  }
  const medianPeakRssBytes = Object.fromEntries(armIds.map((armId) => [
    armId,
    nullableMedian(runs.filter((run) => run.armId === armId).map((run) => run.peakRssBytes)),
  ])) as Record<StrixKvArm["id"], number | null>;
  const candidateRss = medianPeakRssBytes["candidate-q8-kv"];
  const stockQ8Rss = medianPeakRssBytes["production-q8-kv"];
  if (candidateRss !== null && stockQ8Rss !== null && candidateRss > stockQ8Rss * 1.05) {
    reasons.push("candidate peak RSS exceeds stock Q8 by more than 5%");
  }
  const maxObservedTemperatureC = Object.fromEntries(armIds.map((armId) => [
    armId,
    nullableMax(runs.filter((run) => run.armId === armId).map((run) => run.maxTemperatureC)),
  ])) as Record<StrixKvArm["id"], number | null>;
  if (reasons.length === 0) reasons.push("microbenchmark thresholds pass; representative agent quality/work gate remains required");
  return {
    decision: reasons.length === 1 && reasons[0]!.startsWith("microbenchmark thresholds pass") ? "advance-to-agent-gate" : "reject",
    reasons,
    comparisons,
    medianPeakRssBytes,
    maxObservedTemperatureC,
    deploymentAuthorized: false,
  };
}

function assertCoverage(results: StrixBenchmarkResult[], contexts: number[], label: string): void {
  for (const depth of [0, ...contexts]) {
    for (const phase of ["pp", "tg"] as const) {
      if (!results.some((result) => result.contextDepth === depth && result.phase === phase)) {
        throw new Error(`${label} is missing ${phase.toUpperCase()} coverage at ${depth}`);
      }
    }
  }
}
