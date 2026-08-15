export type StrixMmapVariant = "mmap" | "no-mmap";

export interface StrixMmapAbArgs {
  configPath: string;
  outPrefix: string;
  llamaSwapOrigin: string;
  cycles: number;
  ackExclusiveWindow: true;
}

export interface StrixMmapAbConfig {
  schemaVersion: 1;
  binaryPath: string;
  modelPath: string;
  modelId: string;
  runtimeCommit: string;
  runtimeBinarySha256: string;
  modelArtifactSha256: string;
  backend: "vulkan" | "hip";
  quant: string;
  biosUma: string;
  powerMode: string;
  port: number;
  commonArgs: string[];
}

export interface StrixMmapRequestResult {
  ok: boolean;
  exactAnswer: boolean;
  ttftMs: number | null;
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
  promptTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
  outputSha256: string | null;
}

export interface StrixMmapTrial {
  variant: StrixMmapVariant;
  sequence: number;
  startedAt: string;
  endedAt: string;
  startupReadyMs: number;
  peakRssBytes: number;
  minMemAvailableBytes: number;
  minSwapFreeBytes: number;
  maxTemperatureC: number | null;
  first: StrixMmapRequestResult;
  warm: StrixMmapRequestResult;
}

export interface StrixMmapVariantSummary {
  trials: number;
  startupReadyMs: number;
  peakRssBytes: number;
  minMemAvailableBytes: number;
  minSwapFreeBytes: number;
  firstTtftMs: number | null;
  firstTotalMs: number;
  warmTtftMs: number | null;
  warmTotalMs: number;
  promptTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
}

export interface StrixMmapEvaluation {
  decision: "promote" | "reject";
  exploratory: true;
  reasons: string[];
  mmap: StrixMmapVariantSummary;
  noMmap: StrixMmapVariantSummary;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ORDER: StrixMmapVariant[] = ["mmap", "no-mmap", "no-mmap", "mmap"];
const CONTROLLED_ARGS = new Set([
  "-m", "--model", "--host", "--no-host", "--port", "--reuse-port",
  "--mmap", "--no-mmap", "--metrics", "--log-file", "--log-prompts-dir",
]);

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseLoopbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("--llama-swap-origin must be a valid loopback HTTP origin");
  }
  if (
    url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username !== "" || url.password !== "" || (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" || url.hash !== ""
  ) {
    throw new Error("--llama-swap-origin must be a credential-free loopback HTTP origin");
  }
  return url.origin;
}

export function parseStrixMmapAbArgs(argv: string[]): StrixMmapAbArgs {
  let configPath: string | null = null;
  let outPrefix: string | null = null;
  let llamaSwapOrigin = "http://127.0.0.1:8091";
  let cycles = 1;
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
    else if (flag === "--out") outPrefix = value;
    else if (flag === "--llama-swap-origin") llamaSwapOrigin = parseLoopbackOrigin(value);
    else if (flag === "--cycles") {
      cycles = Number(value);
      if (!Number.isInteger(cycles) || cycles < 1 || cycles > 4) throw new Error("--cycles must be an integer from 1 to 4");
    } else throw new Error(`unrecognized argument: ${flag}`);
  }
  if (configPath === null || configPath.trim() === "") throw new Error("--config is required");
  if (outPrefix === null || outPrefix.trim() === "") throw new Error("--out is required");
  if (!ackExclusiveWindow) throw new Error("--ack-exclusive-window is required; run only inside maintenance:run");
  return { configPath, outPrefix, llamaSwapOrigin, cycles, ackExclusiveWindow: true };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(record: Record<string, unknown>, key: string, max = 500): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`config.${key} must be a bounded single-line string`);
  }
  return value;
}

export function validateStrixMmapAbConfig(value: unknown): StrixMmapAbConfig {
  const record = object(value, "config");
  if (record["schemaVersion"] !== 1) throw new Error("config.schemaVersion must be 1");
  const binaryPath = boundedString(record, "binaryPath", 1_024);
  const modelPath = boundedString(record, "modelPath", 1_024);
  if (!binaryPath.startsWith("/") || !modelPath.startsWith("/")) throw new Error("binaryPath and modelPath must be absolute");
  const modelId = boundedString(record, "modelId");
  if (!MODEL_RE.test(modelId)) throw new Error("config.modelId must be a safe model identifier");
  const runtimeCommit = boundedString(record, "runtimeCommit");
  if (!/^[a-f0-9]{40}$/.test(runtimeCommit)) throw new Error("config.runtimeCommit must be a full lowercase Git revision");
  const runtimeBinarySha256 = boundedString(record, "runtimeBinarySha256");
  const modelArtifactSha256 = boundedString(record, "modelArtifactSha256");
  if (!HASH_RE.test(runtimeBinarySha256) || !HASH_RE.test(modelArtifactSha256)) {
    throw new Error("config runtime/model hashes must be lowercase SHA-256 values");
  }
  const backend = record["backend"];
  if (backend !== "vulkan" && backend !== "hip") throw new Error("config.backend must be vulkan or hip");
  const quant = boundedString(record, "quant", 80);
  const biosUma = boundedString(record, "biosUma", 120);
  const powerMode = boundedString(record, "powerMode", 120);
  const port = record["port"];
  if (!Number.isInteger(port) || (port as number) < 1_024 || (port as number) > 65_535) {
    throw new Error("config.port must be an integer from 1024 to 65535");
  }
  const rawArgs = record["commonArgs"];
  if (!Array.isArray(rawArgs) || rawArgs.length === 0 || rawArgs.length > 128) throw new Error("config.commonArgs must be a non-empty bounded array");
  const commonArgs = rawArgs.map((item, index) => {
    if (typeof item !== "string" || item.length === 0 || item.length > 1_024 || /[\r\n\0]/.test(item)) {
      throw new Error(`config.commonArgs[${index}] must be a bounded single-line string`);
    }
    const flag = item.split("=", 1)[0]!;
    if (CONTROLLED_ARGS.has(flag)) throw new Error(`${flag} is controlled by the runner`);
    return item;
  });
  return {
    schemaVersion: 1, binaryPath, modelPath, modelId, runtimeCommit,
    runtimeBinarySha256, modelArtifactSha256, backend, quant,
    biosUma, powerMode, port: port as number, commonArgs,
  };
}

export function mmapTrialOrder(cycles: number): StrixMmapVariant[] {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > 4) throw new Error("cycles must be an integer from 1 to 4");
  return Array.from({ length: cycles }, () => ORDER).flat();
}

export function buildMmapServerArgs(config: StrixMmapAbConfig, variant: StrixMmapVariant): string[] {
  if (variant !== "mmap" && variant !== "no-mmap") throw new Error("invalid mmap variant");
  return [
    "--host", "127.0.0.1", "--port", String(config.port),
    "-m", config.modelPath,
    ...config.commonArgs,
    variant === "mmap" ? "--mmap" : "--no-mmap",
    "--metrics",
  ];
}

/** Run a mutation and make restoration mandatory. A failed restore takes precedence because the
 * host is no longer proven to be back at its pre-run state. */
export async function withRequiredRestoration<T>(
  run: () => Promise<T>,
  restore: () => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let runError: unknown;
  try {
    result = await run();
  } catch (error) {
    runError = error;
  }
  try {
    await restore();
  } catch (error) {
    throw new Error(`benchmark restoration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (runError !== undefined) throw runError;
  return result as T;
}

function median(values: number[]): number {
  if (values.length === 0) throw new Error("cannot summarize an empty sample");
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 1 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}

function nullableMedian(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === values.length ? median(present) : null;
}

function summarize(trials: StrixMmapTrial[]): StrixMmapVariantSummary {
  return {
    trials: trials.length,
    startupReadyMs: median(trials.map((trial) => trial.startupReadyMs)),
    peakRssBytes: median(trials.map((trial) => trial.peakRssBytes)),
    minMemAvailableBytes: median(trials.map((trial) => trial.minMemAvailableBytes)),
    minSwapFreeBytes: median(trials.map((trial) => trial.minSwapFreeBytes)),
    firstTtftMs: nullableMedian(trials.map((trial) => trial.first.ttftMs)),
    firstTotalMs: median(trials.map((trial) => trial.first.totalMs)),
    warmTtftMs: nullableMedian(trials.map((trial) => trial.warm.ttftMs)),
    warmTotalMs: median(trials.map((trial) => trial.warm.totalMs)),
    promptTokensPerSecond: nullableMedian(trials.map((trial) => trial.first.promptTokensPerSecond)),
    predictedTokensPerSecond: nullableMedian(trials.map((trial) => trial.first.predictedTokensPerSecond)),
  };
}

function relative(candidate: number, baseline: number): number {
  return baseline === 0 ? Number.POSITIVE_INFINITY : (candidate - baseline) / baseline;
}

function rejectNullableRegression(
  reasons: string[], label: string, baseline: number | null, candidate: number | null,
  direction: "lower" | "higher", tolerance: number,
): void {
  if (baseline === null || candidate === null) {
    reasons.push(`${label} evidence is missing`);
    return;
  }
  const delta = relative(candidate, baseline);
  if ((direction === "lower" && delta > tolerance) || (direction === "higher" && delta < -tolerance)) {
    reasons.push(`${label} regresses beyond ${(tolerance * 100).toFixed(0)}% tolerance`);
  }
}

export function evaluateMmapAb(trials: StrixMmapTrial[]): StrixMmapEvaluation {
  if (trials.length < 4 || trials.length % 4 !== 0) throw new Error("trials must contain complete ABBA cycles");
  for (let index = 0; index < trials.length; index++) {
    if (trials[index]!.sequence !== index || trials[index]!.variant !== ORDER[index % ORDER.length]) {
      throw new Error("trials must preserve contiguous mmap/no-mmap/no-mmap/mmap order");
    }
  }
  const mmapTrials = trials.filter((trial) => trial.variant === "mmap");
  const noMmapTrials = trials.filter((trial) => trial.variant === "no-mmap");
  const mmap = summarize(mmapTrials);
  const noMmap = summarize(noMmapTrials);
  const reasons: string[] = [];

  if (trials.some((trial) => !trial.first.ok || !trial.warm.ok || !trial.first.exactAnswer || !trial.warm.exactAnswer)) {
    reasons.push("at least one request failed the exact correctness oracle");
  }
  const fingerprints = new Set(trials.flatMap((trial) => [trial.first.outputSha256, trial.warm.outputSha256]));
  if (fingerprints.has(null) || fingerprints.size !== 1 || !HASH_RE.test(String([...fingerprints][0]))) {
    reasons.push("output fingerprint differs across variants or is missing");
  }

  const startupDelta = relative(noMmap.startupReadyMs, mmap.startupReadyMs);
  const rssDelta = relative(noMmap.peakRssBytes, mmap.peakRssBytes);
  const materialStartup = startupDelta <= -0.05;
  const materialRss = rssDelta <= -0.10;
  if (!materialStartup && !materialRss) reasons.push("no-mmap does not materially improve cold startup or peak RSS");
  if (startupDelta > 0.03) reasons.push("cold startup regresses beyond 3% tolerance");

  rejectNullableRegression(reasons, "first TTFT", mmap.firstTtftMs, noMmap.firstTtftMs, "lower", 0.05);
  rejectNullableRegression(reasons, "warm TTFT", mmap.warmTtftMs, noMmap.warmTtftMs, "lower", 0.05);
  rejectNullableRegression(reasons, "prompt throughput", mmap.promptTokensPerSecond, noMmap.promptTokensPerSecond, "higher", 0.03);
  rejectNullableRegression(reasons, "generation throughput", mmap.predictedTokensPerSecond, noMmap.predictedTokensPerSecond, "higher", 0.03);
  if (relative(noMmap.firstTotalMs, mmap.firstTotalMs) > 0.05) reasons.push("first request latency regresses beyond 5% tolerance");
  if (relative(noMmap.warmTotalMs, mmap.warmTotalMs) > 0.05) reasons.push("warm request latency regresses beyond 5% tolerance");

  const consistentStartup = noMmapTrials.every((trial, index) => trial.startupReadyMs < mmapTrials[index]!.startupReadyMs);
  const consistentRss = noMmapTrials.every((trial, index) => trial.peakRssBytes < mmapTrials[index]!.peakRssBytes);
  if ((materialStartup && !consistentStartup) || (materialRss && !consistentRss)) {
    reasons.push("the material improvement is not directionally consistent within ABBA pairs");
  }

  if (reasons.length === 0) reasons.push("no-mmap materially improves cold startup or peak RSS");
  return { decision: reasons.length === 1 && reasons[0]!.startsWith("no-mmap materially") ? "promote" : "reject", exploratory: true, reasons, mmap, noMmap };
}
