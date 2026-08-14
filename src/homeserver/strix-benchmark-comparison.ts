import {
  validateServerProvenance,
  type StrixServerProvenance,
  type StrixServerSummary,
} from "./strix-server-benchmark.js";

type JsonObject = Record<string, unknown>;
export type StrixComparisonAxis = "backend" | "quant" | "kv" | "speculation" | "runtime" | "parallelism";

export interface StrixComparisonArgs {
  controlPath: string;
  candidatePath: string;
  axis: StrixComparisonAxis;
  outPrefix: string;
}

export interface StrixComparableServerReport {
  schemaVersion: 1;
  model: string;
  fixtureSha256: string;
  provenance: StrixServerProvenance;
  summaries: StrixServerSummary[];
}

export interface StrixComparisonRow {
  fixtureId: string;
  taskType: string;
  concurrency: number;
  qualityNonInferior: boolean;
  successRateDelta: number;
  oraclePassRateDelta: number;
  p95TtftRatio: number | null;
  promptThroughputRatio: number | null;
  predictedThroughputRatio: number | null;
  aggregateThroughputRatio: number | null;
  usefulWorkRatio: number | null;
  cacheHitRateDelta: number | null;
  acceptanceRateDelta: number | null;
}

export interface StrixComparisonReport {
  schemaVersion: 1;
  axis: StrixComparisonAxis;
  model: string;
  fixtureSha256: string;
  control: StrixServerProvenance;
  candidate: StrixServerProvenance;
  rows: StrixComparisonRow[];
  limitations: string[];
}

const AXES = new Set<StrixComparisonAxis>(["backend", "quant", "kv", "speculation", "runtime", "parallelism"]);

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseStrixComparisonArgs(argv: string[]): StrixComparisonArgs {
  let controlPath: string | null = null;
  let candidatePath: string | null = null;
  let axis: StrixComparisonAxis | null = null;
  let outPrefix: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const next = (): string => {
      const value = nextValue(argv, index, flag);
      index++;
      return value;
    };
    if (flag === "--control") controlPath = next();
    else if (flag === "--candidate") candidatePath = next();
    else if (flag === "--axis") {
      const value = next() as StrixComparisonAxis;
      if (!AXES.has(value)) throw new Error(`unsupported comparison axis: ${value}`);
      axis = value;
    } else if (flag === "--out") outPrefix = next();
    else throw new Error(`unrecognized argument: ${flag}`);
  }
  if (controlPath === null) throw new Error("--control is required");
  if (candidatePath === null) throw new Error("--candidate is required");
  if (axis === null) throw new Error("--axis is required");
  if (outPrefix === null || outPrefix.trim() === "") throw new Error("--out is required");
  if (controlPath === candidatePath) throw new Error("control and candidate must be distinct files");
  return { controlPath, candidatePath, axis, outPrefix };
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function nullableFinite(value: unknown, label: string): number | null {
  return value === null ? null : finite(value, label);
}

function validateSummary(value: unknown, label: string): StrixServerSummary {
  const row = object(value, label);
  const fixtureId = row["fixtureId"];
  const taskType = row["taskType"];
  if (typeof fixtureId !== "string" || fixtureId.length === 0) throw new Error(`${label}.fixtureId is invalid`);
  if (typeof taskType !== "string" || taskType.length === 0) throw new Error(`${label}.taskType is invalid`);
  return {
    fixtureId,
    taskType: taskType as StrixServerSummary["taskType"],
    concurrency: finite(row["concurrency"], `${label}.concurrency`),
    batches: finite(row["batches"], `${label}.batches`),
    requests: finite(row["requests"], `${label}.requests`),
    successfulRequests: finite(row["successfulRequests"], `${label}.successfulRequests`),
    oraclePasses: finite(row["oraclePasses"], `${label}.oraclePasses`),
    successRate: finite(row["successRate"], `${label}.successRate`),
    oraclePassRate: finite(row["oraclePassRate"], `${label}.oraclePassRate`),
    p50TtftMs: nullableFinite(row["p50TtftMs"], `${label}.p50TtftMs`),
    p95TtftMs: nullableFinite(row["p95TtftMs"], `${label}.p95TtftMs`),
    p50TotalMs: nullableFinite(row["p50TotalMs"], `${label}.p50TotalMs`),
    p95TotalMs: nullableFinite(row["p95TotalMs"], `${label}.p95TotalMs`),
    aggregateTokensPerSecond: nullableFinite(row["aggregateTokensPerSecond"], `${label}.aggregateTokensPerSecond`),
    usefulCompletionsPerMinute: finite(row["usefulCompletionsPerMinute"], `${label}.usefulCompletionsPerMinute`),
    promptTokensPerSecond: nullableFinite(row["promptTokensPerSecond"], `${label}.promptTokensPerSecond`),
    predictedTokensPerSecond: nullableFinite(row["predictedTokensPerSecond"], `${label}.predictedTokensPerSecond`),
    cacheHitRate: nullableFinite(row["cacheHitRate"], `${label}.cacheHitRate`),
    acceptanceRate: nullableFinite(row["acceptanceRate"], `${label}.acceptanceRate`),
  };
}

export function validateComparableServerReport(value: unknown, label: string): StrixComparableServerReport {
  const report = object(value, label);
  if (report["schemaVersion"] !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  if (typeof report["model"] !== "string" || report["model"].length === 0) throw new Error(`${label}.model is invalid`);
  if (typeof report["fixtureSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(report["fixtureSha256"])) throw new Error(`${label}.fixtureSha256 is invalid`);
  if (!Array.isArray(report["summaries"]) || report["summaries"].length === 0) throw new Error(`${label}.summaries must be non-empty`);
  return {
    schemaVersion: 1,
    model: report["model"],
    fixtureSha256: report["fixtureSha256"],
    provenance: validateServerProvenance(report["provenance"]),
    summaries: report["summaries"].map((summary, index) => validateSummary(summary, `${label}.summaries[${index}]`)),
  };
}

const ALLOWED_PROVENANCE_FIELDS: Record<StrixComparisonAxis, Set<keyof StrixServerProvenance>> = {
  backend: new Set(["backend", "runtimeBinarySha256", "serverArgsSha256", "mesaVersion", "rocmVersion"]),
  quant: new Set(["quant", "modelArtifactSha256", "serverArgsSha256"]),
  kv: new Set(["kvTypeK", "kvTypeV", "serverArgsSha256"]),
  speculation: new Set(["speculation", "draftDepth", "serverArgsSha256"]),
  runtime: new Set(["runtimeCommit", "runtimeBinarySha256", "serverArgsSha256"]),
  parallelism: new Set(["parallelism", "serverArgsSha256"]),
};

function assertControlledProvenance(control: StrixServerProvenance, candidate: StrixServerProvenance, axis: StrixComparisonAxis): void {
  const allowed = ALLOWED_PROVENANCE_FIELDS[axis];
  for (const key of Object.keys(control) as Array<keyof StrixServerProvenance>) {
    if (allowed.has(key)) continue;
    if (JSON.stringify(control[key]) !== JSON.stringify(candidate[key])) {
      throw new Error(`comparison axis ${axis} does not permit provenance field ${key} to change`);
    }
  }
  if (![...allowed].some((key) => JSON.stringify(control[key]) !== JSON.stringify(candidate[key]))) {
    throw new Error(`comparison axis ${axis} did not change any declared field`);
  }
}

function cellKey(row: StrixServerSummary): string {
  return `${row.fixtureId}\u0000${row.taskType}\u0000${row.concurrency}`;
}

function ratio(candidate: number | null, control: number | null): number | null {
  return candidate === null || control === null || control === 0 ? null : candidate / control;
}

function delta(candidate: number | null, control: number | null): number | null {
  return candidate === null || control === null ? null : candidate - control;
}

export function compareStrixServerReports(
  rawControl: unknown,
  rawCandidate: unknown,
  axis: StrixComparisonAxis
): StrixComparisonReport {
  const control = validateComparableServerReport(rawControl, "control");
  const candidate = validateComparableServerReport(rawCandidate, "candidate");
  if (control.model !== candidate.model) throw new Error("model identifier changed between control and candidate");
  if (control.fixtureSha256 !== candidate.fixtureSha256) throw new Error("fixture SHA-256 changed between control and candidate");
  assertControlledProvenance(control.provenance, candidate.provenance, axis);
  const controlCells = new Map(control.summaries.map((row) => [cellKey(row), row]));
  const candidateCells = new Map(candidate.summaries.map((row) => [cellKey(row), row]));
  if (controlCells.size !== candidateCells.size || [...controlCells.keys()].some((key) => !candidateCells.has(key))) {
    throw new Error("control and candidate cell sets differ");
  }
  const rows = [...controlCells.entries()].map(([key, controlRow]) => {
    const candidateRow = candidateCells.get(key)!;
    return {
      fixtureId: controlRow.fixtureId,
      taskType: controlRow.taskType,
      concurrency: controlRow.concurrency,
      qualityNonInferior: candidateRow.successRate >= controlRow.successRate && candidateRow.oraclePassRate >= controlRow.oraclePassRate,
      successRateDelta: candidateRow.successRate - controlRow.successRate,
      oraclePassRateDelta: candidateRow.oraclePassRate - controlRow.oraclePassRate,
      p95TtftRatio: ratio(candidateRow.p95TtftMs, controlRow.p95TtftMs),
      promptThroughputRatio: ratio(candidateRow.promptTokensPerSecond, controlRow.promptTokensPerSecond),
      predictedThroughputRatio: ratio(candidateRow.predictedTokensPerSecond, controlRow.predictedTokensPerSecond),
      aggregateThroughputRatio: ratio(candidateRow.aggregateTokensPerSecond, controlRow.aggregateTokensPerSecond),
      usefulWorkRatio: ratio(candidateRow.usefulCompletionsPerMinute, controlRow.usefulCompletionsPerMinute),
      cacheHitRateDelta: delta(candidateRow.cacheHitRate, controlRow.cacheHitRate),
      acceptanceRateDelta: delta(candidateRow.acceptanceRate, controlRow.acceptanceRate),
    } satisfies StrixComparisonRow;
  });
  return {
    schemaVersion: 1,
    axis,
    model: control.model,
    fixtureSha256: control.fixtureSha256,
    control: control.provenance,
    candidate: candidate.provenance,
    rows,
    limitations: [
      "No automatic winner is declared; apply the preregistered ticket threshold only after correctness and soak gates pass.",
      "A ratio above 1 favors the candidate for throughput/useful work; a TTFT ratio below 1 favors the candidate.",
      "Pairwise equality checks prove declared configuration control, not an exclusive or uncontaminated hardware window.",
    ],
  };
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${((value - 1) * 100).toFixed(1)}%`;
}

export function renderStrixComparisonMarkdown(report: StrixComparisonReport): string {
  const lines = [
    `# Strix comparison — ${report.model}`,
    "",
    `Axis: **${report.axis}**`,
    `Fixture SHA-256: \`${report.fixtureSha256}\``,
    "",
    "| Fixture | N | Quality non-inferior | Oracle Δ | TTFT Δ | PP Δ | TG Δ | Aggregate Δ | Useful/min Δ |",
    "|---|---:|:---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of report.rows) {
    lines.push(`| ${row.fixtureId} | ${row.concurrency} | ${row.qualityNonInferior ? "yes" : "no"} | ${(row.oraclePassRateDelta * 100).toFixed(1)} pp | ${percent(row.p95TtftRatio)} | ${percent(row.promptThroughputRatio)} | ${percent(row.predictedThroughputRatio)} | ${percent(row.aggregateThroughputRatio)} | ${percent(row.usefulWorkRatio)} |`);
  }
  lines.push("", "## Limits", "", ...report.limitations.map((limit) => `- ${limit}`));
  return `${lines.join("\n")}\n`;
}
