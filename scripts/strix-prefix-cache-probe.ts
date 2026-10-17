#!/usr/bin/env tsx
/**
 * Reproduce llama.cpp tool-turn context-checkpoint reuse without retaining prompt or model text.
 *
 * The probe targets an already-running reviewed endpoint. It never selects a slot, changes server
 * state, launches a model, or exposes the bearer credential to model tools. All request content is
 * deterministic public synthetic text. Durable artifacts contain cache/timing counts and hashes.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  analyzePrefixCacheObservations,
  analyzePrefixCacheStressObservations,
  type PrefixCacheObservation,
  type PrefixCachePhase,
  type PrefixCacheStressAnalysis,
} from "../src/homeserver/strix-prefix-cache.js";
import {
  validateServerProvenance,
  type StrixServerProvenance,
} from "../src/homeserver/strix-server-benchmark.js";

interface ProbePlan {
  baseUrl: string;
  model: string;
  provenancePath: string;
  outPrefix: string;
  apiKeyEnv: string;
  stableItems: number;
  maxTokens: number;
  timeoutMs: number;
  maxQuotaRetries: number;
  maxRetryAfterSeconds: number;
  stressCycles: number;
  stressMaxTokens: number;
}

interface ProbeDependencies {
  fetchImpl: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => string;
  monotonicMs: () => number;
  env: Readonly<Record<string, string | undefined>>;
  readFile: (path: string) => string;
  writePair: (prefix: string, json: string, markdown: string) => { jsonPath: string; markdownPath: string };
  sourceRevision: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

interface CompletionMetadata {
  observation: PrefixCacheObservation;
  content: string;
}

interface JsonObject {
  [key: string]: unknown;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+:/-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const FULL_COMMIT = /^[0-9a-f]{40}$/;
const PROBE_SOURCE_PATHS = [
  "package.json",
  "scripts/strix-prefix-cache-probe.ts",
  "src/homeserver/strix-prefix-cache.ts",
];
const STRESS_INSTRUCTION = "Emit the decimal integers from 1 through 1000 in ascending order, separated by single spaces. Continue until the response limit. Do not explain or summarize.";

function committedProbeRevision(): string {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    shell: false,
  });
  if (root.status !== 0 || root.stdout.trim() === "") throw new Error("probe must run from a Git worktree");
  const status = spawnSync(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", ...PROBE_SOURCE_PATHS],
    { cwd: root.stdout.trim(), encoding: "utf8", shell: false },
  );
  if (status.status !== 0) throw new Error("cannot verify probe source state");
  if (status.stdout.trim() !== "") throw new Error("probe source paths must be committed before a live run");
  const revision = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root.stdout.trim(),
    encoding: "utf8",
    shell: false,
  });
  const commit = revision.stdout.trim();
  if (revision.status !== 0 || !FULL_COMMIT.test(commit)) throw new Error("cannot resolve probe source commit");
  return commit;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function integer(raw: string, flag: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function httpUrl(raw: string): string {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("--base-url must be an HTTP(S) URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseStrixPrefixCacheArgs(argv: string[]): ProbePlan {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    const allowed = new Set([
      "--base-url", "--model", "--provenance", "--out", "--api-key-env", "--stable-items",
      "--max-tokens", "--timeout-ms", "--max-quota-retries", "--max-retry-after-s",
      "--stress-cycles", "--stress-max-tokens",
    ]);
    if (!allowed.has(flag)) throw new Error(`unrecognized argument: ${flag}`);
    const value = requiredValue(argv, index, flag);
    values.set(flag, value);
    index++;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined || value === "") throw new Error(`${flag} is required`);
    return value;
  };
  const model = required("--model");
  if (!MODEL_RE.test(model)) throw new Error("--model is unsafe");
  const apiKeyEnv = required("--api-key-env");
  if (!ENV_RE.test(apiKeyEnv)) throw new Error("--api-key-env must name an uppercase environment variable");
  return {
    baseUrl: httpUrl(required("--base-url")),
    model,
    provenancePath: resolve(required("--provenance")),
    outPrefix: resolve(required("--out")),
    apiKeyEnv,
    stableItems: integer(values.get("--stable-items") ?? "1800", "--stable-items", 100, 10_000),
    maxTokens: integer(values.get("--max-tokens") ?? "1", "--max-tokens", 1, 32),
    timeoutMs: integer(values.get("--timeout-ms") ?? "180000", "--timeout-ms", 1_000, 600_000),
    maxQuotaRetries: integer(values.get("--max-quota-retries") ?? "5", "--max-quota-retries", 0, 10),
    maxRetryAfterSeconds: integer(values.get("--max-retry-after-s") ?? "60", "--max-retry-after-s", 1, 60),
    stressCycles: integer(values.get("--stress-cycles") ?? "0", "--stress-cycles", 0, 16),
    stressMaxTokens: integer(values.get("--stress-max-tokens") ?? "384", "--stress-max-tokens", 64, 4_096),
  };
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function nonNegative(record: JsonObject, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label}.${key} is unavailable`);
  return value;
}

async function boundedJson(response: Response): Promise<JsonObject> {
  if (response.body === null) throw new Error("completion response body is empty");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`completion response exceeds ${MAX_RESPONSE_BYTES} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return object(JSON.parse(text) as unknown, "completion response");
}

function parseCompletion(
  label: PrefixCachePhase,
  body: JsonObject,
  requestWallMs: number,
  quotaWaitMs: number,
  quotaRetries: number,
): CompletionMetadata {
  const usage = object(body["usage"], "usage");
  const details = object(usage["prompt_tokens_details"], "usage.prompt_tokens_details");
  const timings = object(body["timings"], "timings");
  const promptTokens = nonNegative(usage, "prompt_tokens", "usage");
  const completionTokens = nonNegative(usage, "completion_tokens", "usage");
  const cachedTokens = nonNegative(details, "cached_tokens", "usage.prompt_tokens_details");
  const promptN = nonNegative(timings, "prompt_n", "timings");
  const cacheN = nonNegative(timings, "cache_n", "timings");
  const promptMs = nonNegative(timings, "prompt_ms", "timings");
  if (cachedTokens !== cacheN) throw new Error(`${label}: usage cached_tokens disagrees with timings.cache_n`);
  if (promptTokens !== promptN + cacheN) throw new Error(`${label}: prompt token accounting does not reconcile`);
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) throw new Error(`${label}: choices are unavailable`);
  const first = object(choices[0], `${label}.choices[0]`);
  const message = object(first["message"], `${label}.message`);
  const content = typeof message["content"] === "string" ? message["content"] as string : "";
  return {
    content,
    observation: {
      label,
      promptTokens,
      cachedTokens,
      promptN,
      cacheN,
      promptMs,
      requestWallMs,
      quotaWaitMs,
      quotaRetries,
      finishReason: typeof first["finish_reason"] === "string" ? first["finish_reason"] : null,
      responseContentPresent: content.length > 0,
      completionTokens,
    },
  };
}

function stablePrefix(items: number): string {
  return `checkpoint_probe_v1 ${Array.from(
    { length: items },
    (_, index) => `synthetic_fact_${String(index).padStart(4, "0")}=cache_probe_value_${index % 97};`,
  ).join(" ")}`;
}

function toolCall(phase: number): JsonObject {
  return {
    id: `cache_probe_call_${phase}`,
    type: "function",
    function: { name: "cache_probe", arguments: JSON.stringify({ phase }) },
  };
}

const TOOL = {
  type: "function",
  function: {
    name: "cache_probe",
    description: "Return a public synthetic phase marker.",
    parameters: {
      type: "object",
      properties: { phase: { type: "integer" } },
      required: ["phase"],
      additionalProperties: false,
    },
  },
};

async function oneCompletion(input: {
  label: PrefixCachePhase;
  messages: JsonObject[];
  tools: boolean;
  plan: ProbePlan;
  key: string;
  deps: ProbeDependencies;
  maxTokens: number;
  toolChoiceNone?: boolean;
}): Promise<CompletionMetadata> {
  let quotaRetries = 0;
  let quotaWaitMs = 0;
  while (true) {
    const attemptStarted = input.deps.monotonicMs();
    const response = await input.deps.fetchImpl(`${input.plan.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.key}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(input.plan.timeoutMs),
      body: JSON.stringify({
        model: input.plan.model,
        messages: input.messages,
        ...(input.tools ? { tools: [TOOL] } : {}),
        max_tokens: input.maxTokens,
        ...(input.toolChoiceNone ? { tool_choice: "none" } : {}),
        temperature: 0,
        seed: 1,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (response.status === 429 && quotaRetries < input.plan.maxQuotaRetries) {
      const retryAfter = Number(response.headers.get("retry-after"));
      if (!Number.isInteger(retryAfter) || retryAfter < 1 || retryAfter > input.plan.maxRetryAfterSeconds) {
        throw new Error(`${input.label}: invalid Retry-After on HTTP 429`);
      }
      await response.body?.cancel();
      quotaRetries++;
      quotaWaitMs += retryAfter * 1000;
      await input.deps.sleep(retryAfter * 1000);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${input.label}: HTTP ${response.status}`);
    }
    const body = await boundedJson(response);
    return parseCompletion(
      input.label,
      body,
      Math.max(0, input.deps.monotonicMs() - attemptStarted),
      quotaWaitMs,
      quotaRetries,
    );
  }
}

function markdownReport(input: {
  model: string;
  startedAt: string;
  probeCommit: string;
  runtimeCommit: string;
  observations: PrefixCacheObservation[];
  analysis: ReturnType<typeof analyzePrefixCacheObservations>;
  stressAnalysis: PrefixCacheStressAnalysis | null;
  status: "healthy" | "regression" | "unobservable";
}): string {
  const decisionReason = input.analysis.state === "healthy"
    ? input.stressAnalysis?.reason ?? input.analysis.reason
    : input.analysis.reason;
  const lines = [
    `# Strix tool-turn prefix-cache probe — ${input.model}`,
    "",
    `Started: ${input.startedAt}`,
    `Probe commit: \`${input.probeCommit}\``,
    `Runtime commit: \`${input.runtimeCommit}\``,
    `Decision: **${input.status}** — ${decisionReason}`,
    "",
    "| Phase | Prompt | Cached | Evaluated | Generated | Prompt ms | Request ms | Quota wait ms | Retries |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const row of input.observations) {
    lines.push(`| ${row.label} | ${row.promptTokens} | ${row.cachedTokens} | ${row.promptN} | ${row.completionTokens} | ${row.promptMs.toFixed(1)} | ${row.requestWallMs.toFixed(1)} | ${row.quotaWaitMs} | ${row.quotaRetries} |`);
  }
  lines.push(
    "",
    "## Interpretation",
    "",
    `- Warm-control evaluated tail: ${input.analysis.warmControlEvalTokens ?? "unobservable"} tokens.`,
    `- Exact extended-repeat penalty: ${input.analysis.extendedRepeatPenaltyTokens ?? "unobservable"} tokens.`,
    `- Extended cached-boundary growth: ${input.analysis.extendedCacheGrowthTokens ?? "unobservable"} tokens.`,
    `- Configured checkpoint minimum: ${input.analysis.configuredCheckpointMinStepTokens} tokens.`,
    ...(input.stressAnalysis === null ? [] : [
      `- Checkpoint-crossing generations: ${input.stressAnalysis.checkpointCrossingCycles}/${input.stressAnalysis.expectedCycles}.`,
      `- Final stress audit evaluated: ${input.stressAnalysis.finalAuditEvalTokens ?? "unobservable"} tokens.`,
      `- Final stress audit bound: ${input.stressAnalysis.maxHealthyAuditEvalTokens ?? "unobservable"} tokens.`,
    ]),
    "- Request wall time excludes declared quota wait; server prompt_ms is the authoritative prefill span.",
    "- Synthetic prompts and model text are never written to the artifact.",
  );
  return `${lines.join("\n")}\n`;
}

function atomicPair(prefix: string, json: string, markdown: string): { jsonPath: string; markdownPath: string } {
  const jsonPath = `${prefix}.json`;
  const markdownPath = `${prefix}.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  const token = randomUUID();
  const jsonTemp = `${jsonPath}.${token}.tmp`;
  const markdownTemp = `${markdownPath}.${token}.tmp`;
  try {
    writeFileSync(jsonTemp, json, { encoding: "utf8", mode: 0o600, flag: "wx" });
    writeFileSync(markdownTemp, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(jsonTemp, jsonPath);
    renameSync(markdownTemp, markdownPath);
  } finally {
    rmSync(jsonTemp, { force: true });
    rmSync(markdownTemp, { force: true });
  }
  return { jsonPath, markdownPath };
}

export async function runStrixPrefixCacheProbe(
  argv: string[],
  deps: ProbeDependencies = {
    fetchImpl: fetch,
    sleep: async (milliseconds) => new Promise((accept) => setTimeout(accept, milliseconds)),
    now: () => new Date().toISOString(),
    monotonicMs: () => performance.now(),
    env: process.env,
    readFile: (path) => readFileSync(path, "utf8"),
    writePair: atomicPair,
    sourceRevision: committedProbeRevision,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  },
): Promise<number> {
  try {
    const plan = parseStrixPrefixCacheArgs(argv);
    const key = deps.env[plan.apiKeyEnv];
    if (key === undefined || key === "") throw new Error(`credential environment variable is absent: ${plan.apiKeyEnv}`);
    const provenance = validateServerProvenance(JSON.parse(deps.readFile(plan.provenancePath)) as unknown);
    if (plan.stressCycles > 0 && plan.stressMaxTokens < provenance.checkpointMinStep) {
      throw new Error(`--stress-max-tokens must be at least the captured checkpoint minimum (${provenance.checkpointMinStep})`);
    }
    const probeCommit = deps.sourceRevision();
    const startedAt = deps.now();
    const system = { role: "system", content: stablePrefix(plan.stableItems) };
    const baseline = [system, { role: "user", content: "Return one letter." }];
    const observations: PrefixCacheObservation[] = [];
    const run = async (
      label: PrefixCachePhase,
      messages: JsonObject[],
      tools: boolean,
      maxTokens = plan.maxTokens,
      toolChoiceNone = false,
    ): Promise<CompletionMetadata> => {
      const result = await oneCompletion({ label, messages, tools, plan, key, deps, maxTokens, toolChoiceNone });
      observations.push(result.observation);
      return result;
    };

    await run("baseline-cold", baseline, false);
    await run("baseline-warm", baseline, false);
    const phaseOne = [
      system,
      { role: "user", content: "Use the synthetic cache probe for phase one." },
      { role: "assistant", content: null, tool_calls: [toolCall(1)] },
      { role: "tool", tool_call_id: "cache_probe_call_1", content: "public_phase_1_ok" },
      { role: "user", content: "Return one letter." },
    ];
    const phaseOneOutput = (await run("tool-turn-cold", phaseOne, true)).content;
    await run("tool-turn-warm", phaseOne, true);
    const phaseTwo = [
      ...phaseOne,
      { role: "assistant", content: phaseOneOutput },
      { role: "user", content: "Use the synthetic cache probe for phase two." },
      { role: "assistant", content: null, tool_calls: [toolCall(2)] },
      { role: "tool", tool_call_id: "cache_probe_call_2", content: "public_phase_2_ok" },
      { role: "user", content: "Return one letter." },
    ];
    await run("extended-tool-turn-first", phaseTwo, true);
    await run("extended-tool-turn-repeat", phaseTwo, true);

    if (plan.stressCycles > 0) {
      let stressTranscript: JsonObject[] = [
        system,
        { role: "user", content: "Begin the public synthetic checkpoint stress cycle." },
        { role: "assistant", content: null, tool_calls: [toolCall(100)] },
        { role: "tool", tool_call_id: "cache_probe_call_100", content: "public_stress_phase_100_ok" },
        { role: "user", content: STRESS_INSTRUCTION },
      ];
      for (let cycle = 1; cycle <= plan.stressCycles; cycle++) {
        const generated = await run(
          `stress-cycle-${cycle}-generate`,
          stressTranscript,
          true,
          plan.stressMaxTokens,
          true,
        );
        if (cycle < plan.stressCycles) {
          const phase = 100 + cycle;
          stressTranscript = [
            ...stressTranscript,
            { role: "assistant", content: generated.content },
            { role: "user", content: `Continue with public synthetic checkpoint stress phase ${phase}.` },
            { role: "assistant", content: null, tool_calls: [toolCall(phase)] },
            { role: "tool", tool_call_id: `cache_probe_call_${phase}`, content: `public_stress_phase_${phase}_ok` },
            { role: "user", content: STRESS_INSTRUCTION },
          ];
        }
      }
      await run("stress-final-audit", stressTranscript, true, plan.maxTokens, true);
    }

    const analysis = analyzePrefixCacheObservations(observations, provenance.checkpointMinStep);
    const stressAnalysis = plan.stressCycles === 0
      ? null
      : analyzePrefixCacheStressObservations(observations, provenance.checkpointMinStep, plan.stressCycles);
    const states = [analysis.state, stressAnalysis?.state].filter((state): state is NonNullable<typeof state> => state !== undefined);
    const status = states.includes("regression") ? "regression"
      : states.includes("unobservable") ? "unobservable"
        : "healthy";
    const syntheticPlanSha256 = createHash("sha256").update(JSON.stringify({
      stableItems: plan.stableItems,
      baseline,
      phaseOne,
      phaseTwo: [...phaseOne, { role: "assistant", content: "<MODEL_OUTPUT_NOT_RETAINED>" }, ...phaseTwo.slice(phaseOne.length + 1)],
      stress: {
        cycles: plan.stressCycles,
        maxTokens: plan.stressMaxTokens,
        instruction: STRESS_INSTRUCTION,
        modelOutputPlaceholder: "<MODEL_OUTPUT_NOT_RETAINED>",
      },
      tools: [TOOL],
    })).digest("hex");
    const endpointOrigin = new URL(plan.baseUrl).origin;
    const artifact = {
      schemaVersion: 2,
      kind: "strix-tool-turn-prefix-cache",
      startedAt,
      probeCommit,
      model: plan.model,
      endpointOrigin,
      syntheticPlanSha256,
      stableItems: plan.stableItems,
      maxTokens: plan.maxTokens,
      stressCycles: plan.stressCycles,
      stressMaxTokens: plan.stressMaxTokens,
      provenance,
      observations,
      analysis,
      stressAnalysis,
      contentRetention: "none",
    };
    const json = `${JSON.stringify(artifact, null, 2)}\n`;
    const markdown = markdownReport({
      model: plan.model,
      startedAt,
      probeCommit,
      runtimeCommit: provenance.runtimeCommit,
      observations,
      analysis,
      stressAnalysis,
      status,
    });
    const paths = deps.writePair(plan.outPrefix, json, markdown);
    deps.stdout(JSON.stringify({ status, ...paths }));
    return status === "healthy" ? 0 : status === "regression" ? 1 : 2;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStrixPrefixCacheProbe(process.argv.slice(2));
}
