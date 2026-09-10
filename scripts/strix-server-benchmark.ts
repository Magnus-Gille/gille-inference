#!/usr/bin/env tsx
/**
 * Streaming OpenAI/llama-server benchmark for agent-shaped Strix Halo workloads.
 *
 * The runner never launches, reconfigures, or unloads a model. It targets an already-reviewed
 * endpoint, keeps bearer material in an environment variable, emits output hashes instead of
 * model text, and optionally snapshots llama.cpp's content-blind speculative metrics.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  aggregateServerBatches,
  evaluateServerOutput,
  outputSha256,
  parsePrometheusSpeculation,
  parseStrixServerBenchmarkArgs,
  renderStrixServerMarkdown,
  speculationDelta,
  validateServerFixtures,
  validateServerProvenance,
  type SpeculationSnapshot,
  type StrixServerBatch,
  type StrixServerBenchmarkPlan,
  type StrixServerFixture,
  type StrixServerRequestResult,
} from "../src/homeserver/strix-server-benchmark.js";

interface CliDependencies {
  fetchImpl: typeof fetch;
  now: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readFile: (path: string) => string;
  writePair: (prefix: string, json: string, markdown: string) => { jsonPath: string; markdownPath: string };
}

interface StreamState {
  content: string;
  toolNames: string[];
  ttftMs: number | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  promptTokensPerSecond: number | null;
  predictedTokensPerSecond: number | null;
  cachedPromptTokens: number | null;
}

const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 4096;
const MAX_STREAM_BYTES = 16 * 1024 * 1024;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function meaningfulDelta(chunk: Record<string, unknown>): { content: string; toolNames: string[] } {
  const choices = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
  const choice = choices[0];
  if (choice === null || typeof choice !== "object" || Array.isArray(choice)) return { content: "", toolNames: [] };
  const delta = (choice as Record<string, unknown>)["delta"];
  if (delta === null || typeof delta !== "object" || Array.isArray(delta)) return { content: "", toolNames: [] };
  const deltaObject = delta as Record<string, unknown>;
  const text = [deltaObject["reasoning_content"], deltaObject["content"]]
    .filter((value): value is string => typeof value === "string")
    .join("");
  const toolNames = (Array.isArray(deltaObject["tool_calls"]) ? deltaObject["tool_calls"] : [])
    .flatMap((tool) => {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return [];
      const fn = (tool as Record<string, unknown>)["function"];
      if (fn === null || typeof fn !== "object" || Array.isArray(fn)) return [];
      const name = (fn as Record<string, unknown>)["name"];
      return typeof name === "string" && name.length > 0 ? [name] : [];
    });
  return { content: text, toolNames };
}

function applyChunk(state: StreamState, chunk: Record<string, unknown>, elapsedMs: number): void {
  const delta = meaningfulDelta(chunk);
  if ((delta.content.length > 0 || delta.toolNames.length > 0) && state.ttftMs === null) state.ttftMs = elapsedMs;
  state.content += delta.content;
  state.toolNames.push(...delta.toolNames.filter((name) => !state.toolNames.includes(name)));
  const choices = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
  const first = choices[0];
  if (first !== null && typeof first === "object" && !Array.isArray(first)) {
    const finish = (first as Record<string, unknown>)["finish_reason"];
    if (typeof finish === "string") state.finishReason = finish;
  }
  const usage = chunk["usage"];
  if (usage !== null && typeof usage === "object" && !Array.isArray(usage)) {
    const usageObject = usage as Record<string, unknown>;
    state.promptTokens = finite(usageObject["prompt_tokens"]);
    state.completionTokens = finite(usageObject["completion_tokens"]);
    const details = usageObject["prompt_tokens_details"];
    if (details !== null && typeof details === "object" && !Array.isArray(details)) {
      state.cachedPromptTokens = finite((details as Record<string, unknown>)["cached_tokens"]);
    }
  }
  const timings = chunk["timings"];
  if (timings !== null && typeof timings === "object" && !Array.isArray(timings)) {
    const timingObject = timings as Record<string, unknown>;
    state.promptTokensPerSecond = finite(timingObject["prompt_per_second"]);
    state.predictedTokensPerSecond = finite(timingObject["predicted_per_second"]);
    if (state.cachedPromptTokens === null) state.cachedPromptTokens = finite(timingObject["cache_n"]);
    if (state.promptTokens === null) state.promptTokens = finite(timingObject["prompt_n"]);
    if (state.completionTokens === null) state.completionTokens = finite(timingObject["predicted_n"]);
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} byte limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function streamOne(input: {
  fetchImpl: typeof fetch;
  plan: StrixServerBenchmarkPlan;
  fixture: StrixServerFixture;
  apiKey: string | null;
  signal?: AbortSignal;
}): Promise<StrixServerRequestResult> {
  const started = performance.now();
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (input.apiKey !== null) headers["authorization"] = `Bearer ${input.apiKey}`;
  let response: Response;
  try {
    response = await input.fetchImpl(`${input.plan.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: input.signal === undefined
        ? AbortSignal.timeout(input.plan.timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(input.plan.timeoutMs), input.signal]),
      body: JSON.stringify({
        model: input.plan.model,
        ...input.fixture.request,
        max_tokens: input.plan.maxTokens,
        temperature: 0,
        seed: 1,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  } catch (error) {
    return {
      ok: false, oraclePass: false, ttftMs: null, totalMs: performance.now() - started,
      promptTokens: null, completionTokens: null, promptTokensPerSecond: null,
      predictedTokensPerSecond: null, cachedPromptTokens: null, outputSha256: null,
      finishReason: null, errorClass: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network_error",
    };
  }
  if (!response.ok) {
    await readBoundedText(response, MAX_ERROR_BYTES).catch(() => "");
    return {
      ok: false, oraclePass: false, ttftMs: null, totalMs: performance.now() - started,
      promptTokens: null, completionTokens: null, promptTokensPerSecond: null,
      predictedTokensPerSecond: null, cachedPromptTokens: null, outputSha256: null,
      finishReason: null, errorClass: `http_${response.status}`,
    };
  }
  if (response.body === null) {
    return {
      ok: false, oraclePass: false, ttftMs: null, totalMs: performance.now() - started,
      promptTokens: null, completionTokens: null, promptTokensPerSecond: null,
      predictedTokensPerSecond: null, cachedPromptTokens: null, outputSha256: null,
      finishReason: null, errorClass: "empty_body",
    };
  }

  const state: StreamState = {
    content: "", toolNames: [], ttftMs: null, finishReason: null, promptTokens: null,
    completionTokens: null, promptTokensPerSecond: null, predictedTokensPerSecond: null,
    cachedPromptTokens: null,
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let parseErrors = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_STREAM_BYTES) {
      await reader.cancel();
      parseErrors++;
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          applyChunk(state, parsed as Record<string, unknown>, performance.now() - started);
        } else parseErrors++;
      } catch {
        parseErrors++;
      }
    }
  }
  const meaningful = state.content.length > 0 || state.toolNames.length > 0;
  const ok = parseErrors === 0 && meaningful && state.finishReason !== null;
  return {
    ok,
    oraclePass: ok && evaluateServerOutput(input.fixture.oracle, state),
    ttftMs: state.ttftMs,
    totalMs: performance.now() - started,
    promptTokens: state.promptTokens,
    completionTokens: state.completionTokens,
    promptTokensPerSecond: state.promptTokensPerSecond,
    predictedTokensPerSecond: state.predictedTokensPerSecond,
    cachedPromptTokens: state.cachedPromptTokens,
    outputSha256: meaningful ? outputSha256(state.content, state.toolNames) : null,
    finishReason: state.finishReason,
    errorClass: ok ? null : parseErrors > 0 ? "invalid_sse" : meaningful ? "missing_finish_reason" : "empty_output",
  };
}

async function metricsSnapshot(
  fetchImpl: typeof fetch,
  url: string | null,
  apiKey: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SpeculationSnapshot | null> {
  if (url === null) return null;
  const headers: Record<string, string> = { accept: "text/plain" };
  if (apiKey !== null) headers["authorization"] = `Bearer ${apiKey}`;
  try {
    const response = await fetchImpl(url, {
      headers,
      signal: signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]),
    });
    if (!response.ok) return null;
    return parsePrometheusSpeculation(await readBoundedText(response, 4 * 1024 * 1024));
  } catch {
    return null;
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

function writePair(prefix: string, json: string, markdown: string): { jsonPath: string; markdownPath: string } {
  const resolved = resolve(prefix);
  const jsonPath = `${resolved}.json`;
  const markdownPath = `${resolved}.md`;
  atomicWrite(jsonPath, json);
  atomicWrite(markdownPath, markdown);
  return { jsonPath, markdownPath };
}

const DEFAULT_DEPS: CliDependencies = {
  fetchImpl: fetch,
  now: () => new Date().toISOString(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
  readFile: (path) => readFileSync(path, "utf8"),
  writePair,
};

export async function runStrixServerBenchmark(
  argv: string[],
  deps: CliDependencies = DEFAULT_DEPS,
  signal?: AbortSignal,
): Promise<number> {
  try {
    signal?.throwIfAborted();
    const plan = parseStrixServerBenchmarkArgs(argv);
    const fixtureText = deps.readFile(plan.fixturesPath);
    if (Buffer.byteLength(fixtureText) > MAX_FIXTURE_BYTES) throw new Error("fixture file exceeds 2 MiB limit");
    const fixtures = validateServerFixtures(JSON.parse(fixtureText) as unknown);
    const fixtureSha256 = createHash("sha256").update(fixtureText).digest("hex");
    const provenanceText = deps.readFile(plan.provenancePath);
    const provenance = validateServerProvenance(JSON.parse(provenanceText) as unknown);
    const provenanceSha256 = createHash("sha256").update(provenanceText).digest("hex");
    const apiKey = plan.apiKeyEnv === null ? null : process.env[plan.apiKeyEnv] ?? null;
    if (plan.apiKeyEnv !== null && apiKey === null) throw new Error(`credential environment variable is not set: ${plan.apiKeyEnv}`);
    const startedAt = deps.now();
    const batches: StrixServerBatch[] = [];
    for (const fixture of fixtures) {
      for (const concurrency of plan.concurrency) {
        for (let repetition = 0; repetition < plan.repetitions; repetition++) {
          signal?.throwIfAborted();
          const before = await metricsSnapshot(deps.fetchImpl, plan.metricsUrl, apiKey, plan.timeoutMs, signal);
          const batchStarted = performance.now();
          const requests = await Promise.all(
            Array.from({ length: concurrency }, () => streamOne({ fetchImpl: deps.fetchImpl, plan, fixture, apiKey, signal }))
          );
          signal?.throwIfAborted();
          const wallMs = performance.now() - batchStarted;
          const after = await metricsSnapshot(deps.fetchImpl, plan.metricsUrl, apiKey, plan.timeoutMs, signal);
          signal?.throwIfAborted();
          batches.push({
            fixtureId: fixture.id,
            taskType: fixture.taskType,
            concurrency,
            repetition,
            wallMs,
            speculation: before !== null && after !== null ? speculationDelta(before, after) : null,
            requests,
          });
        }
      }
    }
    const summaries = aggregateServerBatches(batches);
    const endpointOrigin = new URL(plan.baseUrl).origin;
    const limits = [
      "The runner does not establish an exclusive maintenance window; hardware conclusions require the repository-owned fence from issue #196.",
      "Output text and credentials are never stored; deterministic oracles and SHA-256 output fingerprints are retained.",
      "Speculation acceptance is available only when the endpoint exposes llama.cpp speculative counters through --metrics.",
      "Internal PP/TG rates and cache hits depend on the endpoint returning llama.cpp timings/usage fields.",
    ];
    const report = {
      schemaVersion: 1,
      startedAt,
      finishedAt: deps.now(),
      endpointOrigin,
      model: plan.model,
      fixtureSha256,
      provenanceSha256,
      provenance,
      configuration: {
        concurrency: plan.concurrency,
        repetitions: plan.repetitions,
        maxTokens: plan.maxTokens,
        timeoutMs: plan.timeoutMs,
        metricsEnabled: plan.metricsUrl !== null,
      },
      batches,
      summaries,
      measurementLimits: limits,
    };
    signal?.throwIfAborted();
    const paths = deps.writePair(
      plan.outPrefix,
      `${JSON.stringify(report, null, 2)}\n`,
      renderStrixServerMarkdown({ model: plan.model, startedAt, endpointOrigin, fixtureSha256, summaries, limits })
    );
    deps.stdout(JSON.stringify({ status: "complete", ...paths, batches: batches.length, requests: batches.reduce((sum, batch) => sum + batch.requests.length, 0) }));
    return summaries.every((summary) => summary.successRate === 1) ? 0 : 2;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStrixServerBenchmark(process.argv.slice(2));
}
