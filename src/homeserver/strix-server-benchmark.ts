import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;

export type StrixServerTaskType = "code" | "prose" | "reasoning" | "json" | "tool";

export type StrixServerOracle =
  | { kind: "exact"; value: string }
  | { kind: "contains_all"; values: string[] }
  | { kind: "json_fields"; fields: Record<string, string | number | boolean | null> }
  | { kind: "tool_name"; name: string };

export interface StrixServerFixture {
  id: string;
  taskType: StrixServerTaskType;
  request: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    tools?: unknown[];
    tool_choice?: unknown;
    response_format?: unknown;
  };
  oracle: StrixServerOracle;
}

export interface StrixServerBenchmarkPlan {
  baseUrl: string;
  metricsUrl: string | null;
  model: string;
  fixturesPath: string;
  provenancePath: string;
  outPrefix: string;
  concurrency: number[];
  repetitions: number;
  maxTokens: number;
  timeoutMs: number;
  apiKeyEnv: string | null;
}

export interface StrixServerProvenance {
  schemaVersion: 1;
  modelArtifactSha256: string;
  runtimeCommit: string;
  runtimeBinarySha256: string;
  serverArgsSha256: string;
  backend: "vulkan" | "hip";
  quant: string;
  kernel: string;
  mesaVersion: string | null;
  rocmVersion: string | null;
  contextSize: number;
  kvTypeK: string;
  kvTypeV: string;
  flashAttention: "on" | "off" | "auto";
  batch: number;
  ubatch: number;
  parallelism: number;
  speculation: string;
  draftDepth: number | null;
  cacheRamMiB: number;
  contextCheckpoints: number;
  checkpointMinStep: number;
  cacheIdleSlots: "on" | "off";
}

export interface SpeculationSnapshot {
  draftTokens: number;
  acceptedTokens: number;
  verificationSteps: number;
}

export interface SpeculationDelta extends SpeculationSnapshot {
  acceptanceRate: number | null;
}

export interface StrixServerRequestResult {
  ok: boolean;
  oraclePass: boolean;
  ttftMs: number | null;
  totalMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  promptTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
  cachedPromptTokens: number | null;
  outputSha256: string | null;
  finishReason: string | null;
  errorClass: string | null;
}

export interface StrixServerBatch {
  fixtureId: string;
  taskType: StrixServerTaskType;
  concurrency: number;
  repetition: number;
  wallMs: number;
  speculation: SpeculationDelta | null;
  requests: StrixServerRequestResult[];
}

export interface StrixServerSummary {
  fixtureId: string;
  taskType: StrixServerTaskType;
  concurrency: number;
  batches: number;
  requests: number;
  successfulRequests: number;
  oraclePasses: number;
  successRate: number;
  oraclePassRate: number;
  p50TtftMs: number | null;
  p95TtftMs: number | null;
  p50TotalMs: number | null;
  p95TotalMs: number | null;
  aggregateTokensPerSecond: number | null;
  usefulCompletionsPerMinute: number;
  promptTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
  cacheHitRate: number | null;
  acceptanceRate: number | null;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
const FIXTURE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const TASK_TYPES = new Set<StrixServerTaskType>(["code", "prose", "reasoning", "json", "tool"]);
const REQUEST_FIELDS = new Set(["messages", "tools", "tool_choice", "response_format"]);

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function parseUrl(raw: string, flag: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${flag} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`${flag} must use HTTP(S)`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${flag} must not contain credentials, query, or fragment`);
  return url.toString().replace(/\/$/, "");
}

function defaultMetricsUrl(baseUrl: string): string | null {
  const url = new URL(baseUrl);
  if (!url.hostname.match(/^(127\.0\.0\.1|localhost|::1)$/)) return null;
  url.pathname = "/metrics";
  return url.toString();
}

export function parseStrixServerBenchmarkArgs(argv: string[]): StrixServerBenchmarkPlan {
  let baseUrl: string | null = null;
  let metricsUrl: string | null | undefined;
  let model: string | null = null;
  let fixturesPath: string | null = null;
  let provenancePath: string | null = null;
  let outPrefix: string | null = null;
  let concurrency = [1, 2, 4, 8];
  let repetitions = 3;
  let maxTokens = 128;
  let timeoutMs = 300_000;
  let apiKeyEnv: string | null = null;

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const next = (): string => {
      const value = requiredValue(argv, index, flag);
      index++;
      return value;
    };
    if (flag === "--base-url") baseUrl = parseUrl(next(), flag);
    else if (flag === "--metrics-url") metricsUrl = next() === "none" ? null : parseUrl(argv[index]!, flag);
    else if (flag === "--model") model = next();
    else if (flag === "--fixtures") fixturesPath = next();
    else if (flag === "--provenance") provenancePath = next();
    else if (flag === "--out") outPrefix = next();
    else if (flag === "--concurrency") {
      concurrency = [...new Set(next().split(",").map((value) => positiveInteger(value.trim(), flag)))].sort((a, b) => a - b);
    } else if (flag === "--repetitions") repetitions = positiveInteger(next(), flag);
    else if (flag === "--max-tokens") maxTokens = positiveInteger(next(), flag);
    else if (flag === "--timeout-ms") timeoutMs = positiveInteger(next(), flag);
    else if (flag === "--api-key-env") {
      apiKeyEnv = next();
      if (!ENV_RE.test(apiKeyEnv)) throw new Error("--api-key-env must name an uppercase environment variable");
    } else throw new Error(`unrecognized argument: ${flag}`);
  }

  if (baseUrl === null) throw new Error("--base-url is required");
  if (model === null || !MODEL_RE.test(model)) throw new Error("--model is required and must be a safe model identifier");
  if (fixturesPath === null || fixturesPath.trim() === "") throw new Error("--fixtures is required");
  if (provenancePath === null || provenancePath.trim() === "") throw new Error("--provenance is required");
  if (outPrefix === null || outPrefix.trim() === "") throw new Error("--out is required");
  return {
    baseUrl,
    metricsUrl: metricsUrl === undefined ? defaultMetricsUrl(baseUrl) : metricsUrl,
    model,
    fixturesPath,
    provenancePath,
    outPrefix,
    concurrency,
    repetitions,
    maxTokens,
    timeoutMs,
    apiKeyEnv,
  };
}

function requiredString(record: JsonObject, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`provenance.${key} must be a non-empty string`);
  return value;
}

export function validateServerProvenance(value: unknown): StrixServerProvenance {
  const record = object(value, "provenance");
  if (record["schemaVersion"] !== 1) throw new Error("provenance.schemaVersion must be 1");
  const hashFields = ["modelArtifactSha256", "runtimeBinarySha256", "serverArgsSha256"] as const;
  for (const field of hashFields) {
    if (!/^[a-f0-9]{64}$/.test(requiredString(record, field))) throw new Error(`provenance.${field} must be a lowercase SHA-256`);
  }
  const runtimeCommit = requiredString(record, "runtimeCommit");
  if (!/^[a-f0-9]{40}$/.test(runtimeCommit)) throw new Error("provenance.runtimeCommit must be a full Git revision");
  const backend = record["backend"];
  if (backend !== "vulkan" && backend !== "hip") throw new Error("provenance.backend must be vulkan or hip");
  const flashAttention = record["flashAttention"];
  if (flashAttention !== "on" && flashAttention !== "off" && flashAttention !== "auto") throw new Error("provenance.flashAttention is invalid");
  const nullableString = (key: string): string | null => {
    const item = record[key];
    if (item === null) return null;
    if (typeof item !== "string" || item.length === 0) throw new Error(`provenance.${key} must be a string or null`);
    return item;
  };
  const positive = (key: string): number => {
    const item = record[key];
    if (!Number.isInteger(item) || (item as number) <= 0) throw new Error(`provenance.${key} must be a positive integer`);
    return item as number;
  };
  const nonNegative = (key: string): number => {
    const item = record[key];
    if (!Number.isInteger(item) || (item as number) < 0) throw new Error(`provenance.${key} must be a non-negative integer`);
    return item as number;
  };
  const draftDepth = record["draftDepth"];
  if (draftDepth !== null && (!Number.isInteger(draftDepth) || (draftDepth as number) <= 0)) throw new Error("provenance.draftDepth must be null or a positive integer");
  const cacheIdleSlots = record["cacheIdleSlots"];
  if (cacheIdleSlots !== "on" && cacheIdleSlots !== "off") throw new Error("provenance.cacheIdleSlots must be on or off");
  return {
    schemaVersion: 1,
    modelArtifactSha256: requiredString(record, "modelArtifactSha256"),
    runtimeCommit,
    runtimeBinarySha256: requiredString(record, "runtimeBinarySha256"),
    serverArgsSha256: requiredString(record, "serverArgsSha256"),
    backend,
    quant: requiredString(record, "quant"),
    kernel: requiredString(record, "kernel"),
    mesaVersion: nullableString("mesaVersion"),
    rocmVersion: nullableString("rocmVersion"),
    contextSize: positive("contextSize"),
    kvTypeK: requiredString(record, "kvTypeK"),
    kvTypeV: requiredString(record, "kvTypeV"),
    flashAttention,
    batch: positive("batch"),
    ubatch: positive("ubatch"),
    parallelism: positive("parallelism"),
    speculation: requiredString(record, "speculation"),
    draftDepth: draftDepth as number | null,
    cacheRamMiB: nonNegative("cacheRamMiB"),
    contextCheckpoints: nonNegative("contextCheckpoints"),
    checkpointMinStep: nonNegative("checkpointMinStep"),
    cacheIdleSlots,
  };
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function primitiveRecord(value: unknown, label: string): Record<string, string | number | boolean | null> {
  const parsed = object(value, label);
  for (const [key, item] of Object.entries(parsed)) {
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      throw new Error(`${label}.${key} must be a JSON primitive`);
    }
  }
  return parsed as Record<string, string | number | boolean | null>;
}

function parseOracle(value: unknown, label: string): StrixServerOracle {
  const oracle = object(value, label);
  if (oracle["kind"] === "exact" && typeof oracle["value"] === "string") return { kind: "exact", value: oracle["value"] };
  if (oracle["kind"] === "contains_all" && Array.isArray(oracle["values"]) && oracle["values"].every((item) => typeof item === "string" && item.length > 0)) {
    return { kind: "contains_all", values: oracle["values"] as string[] };
  }
  if (oracle["kind"] === "json_fields") return { kind: "json_fields", fields: primitiveRecord(oracle["fields"], `${label}.fields`) };
  if (oracle["kind"] === "tool_name" && typeof oracle["name"] === "string" && FIXTURE_ID_RE.test(oracle["name"])) {
    return { kind: "tool_name", name: oracle["name"] };
  }
  throw new Error(`${label} has an unsupported oracle`);
}

export function validateServerFixtures(value: unknown): StrixServerFixture[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("fixture file must be a non-empty array");
  const ids = new Set<string>();
  return value.map((item, index) => {
    const fixture = object(item, `fixture[${index}]`);
    const id = fixture["id"];
    const taskType = fixture["taskType"];
    if (typeof id !== "string" || !FIXTURE_ID_RE.test(id)) throw new Error(`fixture id is unsafe at index ${index}`);
    if (ids.has(id)) throw new Error(`duplicate fixture id: ${id}`);
    ids.add(id);
    if (typeof taskType !== "string" || !TASK_TYPES.has(taskType as StrixServerTaskType)) throw new Error(`fixture ${id} has invalid taskType`);
    const request = object(fixture["request"], `fixture ${id}.request`);
    for (const key of Object.keys(request)) {
      if (!REQUEST_FIELDS.has(key)) throw new Error(`fixture ${id} request field is not allowed: ${key}`);
    }
    if (!Array.isArray(request["messages"]) || request["messages"].length === 0) throw new Error(`fixture ${id} needs messages`);
    const messages = request["messages"].map((message, messageIndex) => {
      const parsed = object(message, `fixture ${id}.messages[${messageIndex}]`);
      if (!["system", "user", "assistant"].includes(String(parsed["role"])) || typeof parsed["content"] !== "string") {
        throw new Error(`fixture ${id} has an invalid message`);
      }
      return parsed as { role: "system" | "user" | "assistant"; content: string };
    });
    return {
      id,
      taskType: taskType as StrixServerTaskType,
      request: {
        messages,
        ...(Array.isArray(request["tools"]) ? { tools: request["tools"] } : {}),
        ...(request["tool_choice"] !== undefined ? { tool_choice: request["tool_choice"] } : {}),
        ...(request["response_format"] !== undefined ? { response_format: request["response_format"] } : {}),
      },
      oracle: parseOracle(fixture["oracle"], `fixture ${id}.oracle`),
    };
  });
}

export function evaluateServerOutput(
  oracle: StrixServerOracle,
  output: { content: string; toolNames: string[] }
): boolean {
  if (oracle.kind === "exact") return output.content.trim() === oracle.value;
  if (oracle.kind === "contains_all") return oracle.values.every((value) => output.content.includes(value));
  if (oracle.kind === "tool_name") return output.toolNames.includes(oracle.name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.content);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  return Object.entries(oracle.fields).every(([key, value]) => Object.is((parsed as JsonObject)[key], value));
}

function counter(text: string, name: string): number {
  let total = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(name)) continue;
    const match = line.match(/(?:\{[^}]*\})?\s+(-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)$/i);
    if (match !== null) total += Number(match[1]);
  }
  return total;
}

export function parsePrometheusSpeculation(text: string): SpeculationSnapshot {
  return {
    draftTokens: counter(text, "llamacpp:spec_decode_num_draft_tokens_total"),
    acceptedTokens: counter(text, "llamacpp:spec_decode_num_accepted_tokens_total"),
    verificationSteps: counter(text, "llamacpp:spec_decode_num_drafts_total"),
  };
}

export function speculationDelta(before: SpeculationSnapshot, after: SpeculationSnapshot): SpeculationDelta {
  const draftTokens = Math.max(0, after.draftTokens - before.draftTokens);
  const acceptedTokens = Math.max(0, after.acceptedTokens - before.acceptedTokens);
  const verificationSteps = Math.max(0, after.verificationSteps - before.verificationSteps);
  return {
    draftTokens,
    acceptedTokens,
    verificationSteps,
    acceptanceRate: draftTokens > 0 ? acceptedTokens / draftTokens : null,
  };
}

export function outputSha256(content: string, toolNames: string[]): string {
  return createHash("sha256").update(JSON.stringify({ content, toolNames })).digest("hex");
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function aggregateServerBatches(batches: StrixServerBatch[]): StrixServerSummary[] {
  const groups = new Map<string, StrixServerBatch[]>();
  for (const batch of batches) {
    const key = `${batch.fixtureId}\u0000${batch.taskType}\u0000${batch.concurrency}`;
    groups.set(key, [...(groups.get(key) ?? []), batch]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const requests = group.flatMap((batch) => batch.requests);
    const successful = requests.filter((request) => request.ok);
    const passed = requests.filter((request) => request.oraclePass);
    const ttfts = successful.flatMap((request) => request.ttftMs === null ? [] : [request.ttftMs]);
    const totals = successful.map((request) => request.totalMs);
    const completionTokens = successful.reduce((sum, request) => sum + (request.completionTokens ?? 0), 0);
    const wallMs = group.reduce((sum, batch) => sum + batch.wallMs, 0);
    const promptRates = successful.flatMap((request) => request.promptTokensPerSecond === null ? [] : [request.promptTokensPerSecond]);
    const predictedRates = successful.flatMap((request) => request.predictedTokensPerSecond === null ? [] : [request.predictedTokensPerSecond]);
    const cacheKnown = successful.filter((request) => request.cachedPromptTokens !== null);
    const specDraft = group.reduce((sum, batch) => sum + (batch.speculation?.draftTokens ?? 0), 0);
    const specAccepted = group.reduce((sum, batch) => sum + (batch.speculation?.acceptedTokens ?? 0), 0);
    return {
      fixtureId: first.fixtureId,
      taskType: first.taskType,
      concurrency: first.concurrency,
      batches: group.length,
      requests: requests.length,
      successfulRequests: successful.length,
      oraclePasses: passed.length,
      successRate: requests.length === 0 ? 0 : successful.length / requests.length,
      oraclePassRate: requests.length === 0 ? 0 : passed.length / requests.length,
      p50TtftMs: percentile(ttfts, 0.5),
      p95TtftMs: percentile(ttfts, 0.95),
      p50TotalMs: percentile(totals, 0.5),
      p95TotalMs: percentile(totals, 0.95),
      aggregateTokensPerSecond: wallMs > 0 ? completionTokens / (wallMs / 1000) : null,
      usefulCompletionsPerMinute: wallMs > 0 ? passed.length / (wallMs / 60_000) : 0,
      promptTokensPerSecond: mean(promptRates),
      predictedTokensPerSecond: mean(predictedRates),
      cacheHitRate: cacheKnown.length === 0 ? null : cacheKnown.filter((request) => (request.cachedPromptTokens ?? 0) > 0).length / cacheKnown.length,
      acceptanceRate: specDraft > 0 ? specAccepted / specDraft : null,
    };
  }).sort((left, right) => left.fixtureId.localeCompare(right.fixtureId) || left.concurrency - right.concurrency);
}

function format(value: number | null, digits = 1): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

export function renderStrixServerMarkdown(input: {
  model: string;
  startedAt: string;
  endpointOrigin: string;
  fixtureSha256: string;
  summaries: StrixServerSummary[];
  limits: string[];
}): string {
  const lines = [
    `# Strix server benchmark — ${input.model}`,
    "",
    `Started: ${input.startedAt}`,
    `Endpoint origin: ${input.endpointOrigin}`,
    `Fixture SHA-256: \`${input.fixtureSha256}\``,
    "",
    "| Fixture | Type | N | Success | Oracle | PP tok/s | TG tok/s | p95 TTFT ms | Aggregate tok/s | Useful/min | Cache hit | Spec accept |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of input.summaries) {
    lines.push(`| ${row.fixtureId} | ${row.taskType} | ${row.concurrency} | ${format(row.successRate * 100)}% | ${format(row.oraclePassRate * 100)}% | ${format(row.promptTokensPerSecond)} | ${format(row.predictedTokensPerSecond)} | ${format(row.p95TtftMs, 0)} | ${format(row.aggregateTokensPerSecond)} | ${format(row.usefulCompletionsPerMinute)} | ${row.cacheHitRate === null ? "n/a" : `${format(row.cacheHitRate * 100)}%`} | ${row.acceptanceRate === null ? "n/a" : `${format(row.acceptanceRate * 100)}%`} |`);
  }
  lines.push("", "## Measurement limits", "", ...input.limits.map((limit) => `- ${limit}`));
  return `${lines.join("\n")}\n`;
}
