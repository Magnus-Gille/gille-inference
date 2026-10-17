export type StrixBackend = "vulkan" | "hip";
export type FlashAttentionMode = "on" | "off" | "auto";

export interface StrixBenchmarkPlan {
  llamaBenchPath: string;
  modelPath: string;
  modelId: string;
  quant: string;
  backend: StrixBackend;
  contexts: number[];
  kvTypeK: string;
  kvTypeV: string;
  flashAttention: FlashAttentionMode;
  batch: number;
  ubatch: number;
  parallelism: 1;
  speculation: "none";
  ppTokens: number;
  tgTokens: number;
  repetitions: number;
  gpuLayers: number;
  outPrefix: string;
}

export interface LlamaBenchRow {
  build_commit: string;
  build_number: number;
  cpu_info: string;
  gpu_info: string;
  backends: string;
  model_filename: string;
  model_type: string;
  model_size: number;
  model_n_params: number;
  n_batch: number;
  n_ubatch: number;
  type_k: string;
  type_v: string;
  flash_attn: number;
  n_prompt: number;
  n_gen: number;
  n_depth: number;
  avg_ts: number;
  stddev_ts: number;
  [key: string]: unknown;
}

export interface StrixBenchmarkResult {
  phase: "pp" | "tg";
  contextDepth: number;
  tokens: number;
  tokensPerSecond: number;
  tokensPerSecondStddev: number;
  ttftMs: null;
  acceptanceRate: null;
}

export interface StrixSystemSnapshot {
  kernel: string | null;
  mesaVersion: string | null;
  rocmVersion: string | null;
}

export interface StrixTelemetry {
  peakRssBytes: number | null;
  availableRamBeforeBytes: number | null;
  availableRamAfterBytes: number | null;
  maxTemperatureC: number | null;
  averagePowerW: number | null;
}

export interface StrixBenchmarkReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  model: {
    id: string;
    artifactPath: string;
    artifactSha256: string;
    quant: string;
    sizeBytes: number;
    parameters: number;
  };
  runtime: {
    commit: string;
    buildNumber: number;
    backend: string;
    cpuInfo: string;
    gpuInfo: string;
    kernel: string | null;
    mesaVersion: string | null;
    rocmVersion: string | null;
  };
  configuration: {
    contexts: number[];
    ppTokens: number;
    tgTokens: number;
    kvTypeK: string;
    kvTypeV: string;
    flashAttention: FlashAttentionMode;
    batch: number;
    ubatch: number;
    parallelism: 1;
    speculation: "none";
    repetitions: number;
    gpuLayers: number;
  };
  telemetry: StrixTelemetry;
  results: StrixBenchmarkResult[];
  measurementLimits: {
    ttft: string;
    acceptanceRate: string;
    ram: string;
    powerAndTemperature: string;
  };
}

const REQUIRED_CONTEXTS = [8192, 32768, 65536, 131072] as const;
const DEFAULT_CONTEXTS = [...REQUIRED_CONTEXTS];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9._+-]+$/;

function requireNext(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function parseContexts(raw: string): number[] {
  const contexts = [...new Set(raw.split(",").map((part) => positiveInteger(part.trim(), "--contexts")))].sort(
    (left, right) => left - right
  );
  for (const required of REQUIRED_CONTEXTS) {
    if (!contexts.includes(required)) throw new Error(`required context ${required} is missing`);
  }
  return contexts;
}

function safeValue(raw: string, flag: string): string {
  if (!SAFE_VALUE_RE.test(raw)) throw new Error(`${flag} contains unsupported characters`);
  return raw;
}

export function parseStrixBenchmarkArgs(argv: string[]): StrixBenchmarkPlan {
  let llamaBenchPath: string | null = null;
  let modelPath: string | null = null;
  let modelId: string | null = null;
  let quant: string | null = null;
  let backend: StrixBackend | null = null;
  let outPrefix: string | null = null;
  let contexts: number[] = [...DEFAULT_CONTEXTS];
  let kvTypeK = "q8_0";
  let kvTypeV = "q8_0";
  let flashAttention: FlashAttentionMode = "on";
  let batch = 2048;
  let ubatch = 512;
  let parallelism = 1;
  let speculation = "none";
  let ppTokens = 512;
  let tgTokens = 128;
  let repetitions = 5;
  let gpuLayers = -1;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const next = (): string => {
      const value = requireNext(argv, index, flag);
      index++;
      return value;
    };
    if (flag === "--llama-bench") llamaBenchPath = next();
    else if (flag === "--model") modelPath = next();
    else if (flag === "--model-id") modelId = next();
    else if (flag === "--quant") quant = safeValue(next(), flag);
    else if (flag === "--backend") {
      const value = next().toLowerCase();
      if (value !== "vulkan" && value !== "hip") throw new Error("--backend must be vulkan or hip");
      backend = value;
    } else if (flag === "--out") outPrefix = next();
    else if (flag === "--contexts") contexts = parseContexts(next());
    else if (flag === "--kv-k") kvTypeK = safeValue(next(), flag);
    else if (flag === "--kv-v") kvTypeV = safeValue(next(), flag);
    else if (flag === "--fa") {
      const value = next();
      if (value !== "on" && value !== "off" && value !== "auto") throw new Error("--fa must be on, off, or auto");
      flashAttention = value;
    } else if (flag === "--batch") batch = positiveInteger(next(), flag);
    else if (flag === "--ubatch") ubatch = positiveInteger(next(), flag);
    else if (flag === "--parallelism") parallelism = positiveInteger(next(), flag);
    else if (flag === "--speculation") speculation = next();
    else if (flag === "--pp") ppTokens = positiveInteger(next(), flag);
    else if (flag === "--tg") tgTokens = positiveInteger(next(), flag);
    else if (flag === "--repetitions") repetitions = positiveInteger(next(), flag);
    else if (flag === "--gpu-layers") {
      const raw = next();
      gpuLayers = Number(raw);
      if (!Number.isInteger(gpuLayers) || gpuLayers < -1) throw new Error("--gpu-layers must be -1 or a non-negative integer");
    } else throw new Error(`unrecognized argument: ${flag}`);
  }

  if (llamaBenchPath === null) throw new Error("--llama-bench is required");
  if (modelPath === null) throw new Error("--model is required");
  if (modelId === null || !MODEL_ID_RE.test(modelId)) throw new Error("--model-id must use owner/model form");
  if (quant === null) throw new Error("--quant is required");
  if (backend === null) throw new Error("--backend is required");
  if (outPrefix === null || outPrefix.trim().length === 0) throw new Error("--out is required");
  if (parallelism !== 1) throw new Error("direct llama-bench mode supports parallelism 1 only");
  if (speculation !== "none") throw new Error("direct llama-bench mode does not support speculation");

  return {
    llamaBenchPath,
    modelPath,
    modelId,
    quant,
    backend,
    contexts,
    kvTypeK,
    kvTypeV,
    flashAttention,
    batch,
    ubatch,
    parallelism: 1,
    speculation: "none",
    ppTokens,
    tgTokens,
    repetitions,
    gpuLayers,
    outPrefix,
  };
}

export function buildLlamaBenchArgs(plan: StrixBenchmarkPlan): string[] {
  return [
    "-m", plan.modelPath,
    "-p", String(plan.ppTokens),
    "-n", String(plan.tgTokens),
    "-d", [0, ...plan.contexts].join(","),
    "-b", String(plan.batch),
    "-ub", String(plan.ubatch),
    "-ctk", plan.kvTypeK,
    "-ctv", plan.kvTypeV,
    "-fa", plan.flashAttention,
    "-ngl", String(plan.gpuLayers),
    "-r", String(plan.repetitions),
    "-o", "json",
  ];
}

function expectedBackend(rowBackend: string, backend: StrixBackend): boolean {
  const measured = rowBackend.toLowerCase();
  return backend === "vulkan" ? measured.includes("vulkan") : measured.includes("hip") || measured.includes("rocm");
}

function requireFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`llama-bench row has invalid ${field}`);
  return value;
}

export function normalizeLlamaBenchRows(rows: LlamaBenchRow[], backend: StrixBackend): StrixBenchmarkResult[] {
  if (rows.length === 0) throw new Error("llama-bench returned no rows");
  const commits = new Set(rows.map((row) => row.build_commit));
  if (commits.size !== 1) throw new Error("llama-bench rows contain mixed runtime commits");
  if (rows.some((row) => !expectedBackend(row.backends, backend))) {
    throw new Error(`measured backend does not match requested ${backend}`);
  }
  return rows.map((row) => {
    let phase: "pp" | "tg";
    let tokens: number;
    if (row.n_prompt > 0 && row.n_gen === 0) {
      phase = "pp";
      tokens = row.n_prompt;
    } else if (row.n_gen > 0 && row.n_prompt === 0) {
      phase = "tg";
      tokens = row.n_gen;
    } else {
      throw new Error("llama-bench row is neither a pure PP nor pure TG result");
    }
    return {
      phase,
      contextDepth: requireFinite(row.n_depth, "n_depth"),
      tokens: requireFinite(tokens, phase === "pp" ? "n_prompt" : "n_gen"),
      tokensPerSecond: requireFinite(row.avg_ts, "avg_ts"),
      tokensPerSecondStddev: requireFinite(row.stddev_ts, "stddev_ts"),
      ttftMs: null,
      acceptanceRate: null,
    };
  });
}

export function makeStrixBenchmarkReport(input: {
  plan: StrixBenchmarkPlan;
  modelSha256: string;
  rows: LlamaBenchRow[];
  startedAt: string;
  finishedAt: string;
  system: StrixSystemSnapshot;
  telemetry: StrixTelemetry;
}): StrixBenchmarkReport {
  if (!/^[a-f0-9]{64}$/.test(input.modelSha256)) throw new Error("model SHA-256 must be 64 lowercase hex characters");
  const first = input.rows[0];
  if (first === undefined) throw new Error("llama-bench returned no rows");
  const results = normalizeLlamaBenchRows(input.rows, input.plan.backend);
  return {
    schemaVersion: 1,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    model: {
      id: input.plan.modelId,
      artifactPath: input.plan.modelPath,
      artifactSha256: input.modelSha256,
      quant: input.plan.quant,
      sizeBytes: first.model_size,
      parameters: first.model_n_params,
    },
    runtime: {
      commit: first.build_commit,
      buildNumber: first.build_number,
      backend: first.backends,
      cpuInfo: first.cpu_info,
      gpuInfo: first.gpu_info,
      kernel: input.system.kernel,
      mesaVersion: input.system.mesaVersion,
      rocmVersion: input.system.rocmVersion,
    },
    configuration: {
      contexts: input.plan.contexts,
      ppTokens: input.plan.ppTokens,
      tgTokens: input.plan.tgTokens,
      kvTypeK: input.plan.kvTypeK,
      kvTypeV: input.plan.kvTypeV,
      flashAttention: input.plan.flashAttention,
      batch: input.plan.batch,
      ubatch: input.plan.ubatch,
      parallelism: 1,
      speculation: "none",
      repetitions: input.plan.repetitions,
      gpuLayers: input.plan.gpuLayers,
    },
    telemetry: input.telemetry,
    results,
    measurementLimits: {
      ttft: "TTFT is not measured by llama-bench; use the streaming agent/server harness for TTFT.",
      acceptanceRate: "Not applicable because this direct llama-bench profile disables speculation.",
      ram: "Peak RSS is sampled from the benchmark process and is not equivalent to total unified GPU memory residency.",
      powerAndTemperature: "Linux hwmon values are recorded only when readable; temperature is the highest readable channel and power is the average of the highest readable power channel per sample, not wall power. Null means unavailable, not zero.",
    },
  };
}

export function assertStrixBenchmarkCoverage(
  results: StrixBenchmarkResult[],
  contexts: number[]
): void {
  for (const depth of [0, ...contexts]) {
    for (const phase of ["pp", "tg"] as const) {
      if (!results.some((result) => result.contextDepth === depth && result.phase === phase)) {
        throw new Error(`benchmark result is missing ${phase.toUpperCase()} coverage at context depth ${depth}`);
      }
    }
  }
}

function number(value: number | null, digits = 1): string {
  return value === null ? "unknown" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function renderStrixBenchmarkMarkdown(report: StrixBenchmarkReport): string {
  const byDepth = new Map<number, { pp: number | null; tg: number | null }>();
  for (const result of report.results) {
    const current = byDepth.get(result.contextDepth) ?? { pp: null, tg: null };
    current[result.phase] = result.tokensPerSecond;
    byDepth.set(result.contextDepth, current);
  }
  const lines = [
    `# Strix Halo benchmark — ${report.model.id}`,
    "",
    `Model SHA-256: \`${report.model.artifactSha256}\``,
    `Runtime: \`${report.runtime.commit}\` (${report.runtime.backend})`,
    `Quant: ${report.model.quant}; KV: ${report.configuration.kvTypeK}/${report.configuration.kvTypeV}; FA: ${report.configuration.flashAttention}; batch/ubatch: ${report.configuration.batch}/${report.configuration.ubatch}`,
    `System: kernel ${report.runtime.kernel ?? "unknown"}; Mesa ${report.runtime.mesaVersion ?? "unknown"}; ROCm ${report.runtime.rocmVersion ?? "unknown"}`,
    "",
    "| Context depth | PP tok/s | TG tok/s |",
    "|---:|---:|---:|",
  ];
  for (const [depth, values] of [...byDepth.entries()].sort(([left], [right]) => left - right)) {
    lines.push(`| ${depth.toLocaleString("en-US")} | ${number(values.pp)} | ${number(values.tg)} |`);
  }
  lines.push(
    "",
    "## Telemetry",
    "",
    `- Peak process RSS: ${report.telemetry.peakRssBytes === null ? "unknown" : `${number(report.telemetry.peakRssBytes / 1024 ** 3, 2)} GiB`}`,
    `- Maximum sampled temperature: ${report.telemetry.maxTemperatureC === null ? "unknown" : `${number(report.telemetry.maxTemperatureC)} °C`}`,
    `- Average sampled power: ${report.telemetry.averagePowerW === null ? "unknown" : `${number(report.telemetry.averagePowerW)} W`}`,
    "",
    "## Measurement limits",
    "",
    `- ${report.measurementLimits.ttft}`,
    `- ${report.measurementLimits.acceptanceRate}`,
    `- ${report.measurementLimits.ram}`,
    `- ${report.measurementLimits.powerAndTemperature}`,
  );
  return `${lines.join("\n")}\n`;
}
