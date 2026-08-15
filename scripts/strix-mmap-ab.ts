#!/usr/bin/env tsx
/**
 * One-axis mmap/no-mmap A/B for a pinned llama-server and GGUF on Strix Halo.
 *
 * This runner deliberately mutates llama-swap residency. It must be invoked inside the
 * repository-owned exclusive maintenance window and requires an explicit acknowledgement flag.
 * It never changes the live config or service and restores the pre-run resident model in finally.
 */
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  createReadStream, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import {
  buildMmapServerArgs,
  evaluateMmapAb,
  mmapTrialOrder,
  parseStrixMmapAbArgs,
  validateStrixMmapAbConfig,
  withRequiredRestoration,
  type StrixMmapAbConfig,
  type StrixMmapRequestResult,
  type StrixMmapTrial,
  type StrixMmapVariant,
} from "../src/homeserver/strix-mmap-ab.js";

interface RunningEntry { model: string; state: string; ttl?: number }
interface HostSample { rssBytes: number; memAvailableBytes: number; swapFreeBytes: number; temperatureC: number | null }
interface SamplerResult { peakRssBytes: number; minMemAvailableBytes: number; minSwapFreeBytes: number; maxTemperatureC: number | null }

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const READY_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 180_000;
const RESTORE_TIMEOUT_MS = 600_000;
let activeEphemeralChild: ChildProcess | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readMeminfo(): { memAvailableBytes: number; swapFreeBytes: number } {
  const text = readFileSync("/proc/meminfo", "utf8");
  const field = (name: string): number => {
    const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s+kB$`, "m"));
    if (!match) throw new Error(`/proc/meminfo is missing ${name}`);
    return Number(match[1]) * 1024;
  };
  return { memAvailableBytes: field("MemAvailable"), swapFreeBytes: field("SwapFree") };
}

function readRss(pid: number): number {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = text.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function readMaxTemperatureC(): number | null {
  const values: number[] = [];
  try {
    for (const hwmon of readdirSync("/sys/class/hwmon")) {
      const root = `/sys/class/hwmon/${hwmon}`;
      for (const file of readdirSync(root)) {
        if (!/^temp\d+_input$/.test(file)) continue;
        try {
          const value = Number(readFileSync(`${root}/${file}`, "utf8").trim()) / 1_000;
          if (Number.isFinite(value) && value > -50 && value < 200) values.push(value);
        } catch { /* unreadable sensor */ }
      }
    }
  } catch { /* hwmon absent */ }
  return values.length === 0 ? null : Math.max(...values);
}

function sampleHost(pid: number): HostSample {
  const memory = readMeminfo();
  return { rssBytes: readRss(pid), ...memory, temperatureC: readMaxTemperatureC() };
}

function startSampler(pid: number): { stop(): SamplerResult } {
  const samples: HostSample[] = [];
  const capture = (): void => {
    try { samples.push(sampleHost(pid)); } catch { /* a transient disappearing proc entry is expected on exit */ }
  };
  capture();
  const timer = setInterval(capture, 100);
  return {
    stop(): SamplerResult {
      clearInterval(timer);
      capture();
      if (samples.length === 0) throw new Error("host sampler captured no observations");
      const temperatures = samples.flatMap((sample) => sample.temperatureC === null ? [] : [sample.temperatureC]);
      return {
        peakRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
        minMemAvailableBytes: Math.min(...samples.map((sample) => sample.memAvailableBytes)),
        minSwapFreeBytes: Math.min(...samples.map((sample) => sample.swapFreeBytes)),
        maxTemperatureC: temperatures.length === 0 ? null : Math.max(...temperatures),
      };
    },
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

async function readBounded(response: Response, limit = MAX_RESPONSE_BYTES): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error(`response exceeds ${limit} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function runningSnapshot(origin: string): Promise<RunningEntry[]> {
  const response = await fetch(`${origin}/running`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`llama-swap /running returned ${response.status}`);
  const parsed = JSON.parse(await readBounded(response)) as unknown;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray((parsed as { running?: unknown }).running)) {
    throw new Error("llama-swap returned malformed residency evidence");
  }
  const entries = (parsed as { running: unknown[] }).running;
  if (!entries.every((entry) => entry !== null && typeof entry === "object" &&
    typeof (entry as RunningEntry).model === "string" && typeof (entry as RunningEntry).state === "string")) {
    throw new Error("llama-swap returned malformed residency entries");
  }
  return entries as RunningEntry[];
}

async function unloadAll(origin: string): Promise<void> {
  const response = await fetch(`${origin}/api/models/unload`, {
    method: "POST", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`llama-swap unload returned ${response.status}`);
  await readBounded(response, 4_096);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await runningSnapshot(origin)).length === 0) return;
    await sleep(250);
  }
  throw new Error("llama-swap did not become empty after unload");
}

async function restoreResidency(origin: string, initial: RunningEntry[]): Promise<void> {
  await unloadAll(origin);
  const ready = initial.filter((entry) => entry.state === "ready");
  if (ready.length === 0) return;
  if (ready.length !== 1) throw new Error("cannot restore more than one initially ready model on the serial GPU");
  const model = ready[0]!.model;
  const response = await fetch(`${origin}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(RESTORE_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly OK." }],
      max_tokens: 8,
      temperature: 0,
      seed: 1,
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`restoring ${model} returned ${response.status}`);
  await readBounded(response);
  const deadline = Date.now() + RESTORE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await runningSnapshot(origin);
    if (current.length === 1 && current[0]!.model === model && current[0]!.state === "ready") return;
    await sleep(500);
  }
  throw new Error(`restored model ${model} did not reach the ready state`);
}

async function portIsFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function waitHealthy(child: ChildProcess, port: number): Promise<number> {
  const started = performance.now();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("ephemeral llama-server exited before ready");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        await readBounded(response, 64 * 1024);
        return performance.now() - started;
      }
    } catch { /* server is still loading */ }
    await sleep(250);
  }
  throw new Error("ephemeral llama-server did not become ready before timeout");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    sleep(30_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  }
}

async function streamedArithmetic(port: number, model: string): Promise<StrixMmapRequestResult> {
  const started = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "What is 17 multiplied by 19? Respond with only the integer." }],
      max_tokens: 16,
      temperature: 0,
      seed: 1,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!response.ok || response.body === null) {
    if (response.body !== null) await readBounded(response, 4_096).catch(() => "");
    return {
      ok: false, exactAnswer: false, ttftMs: null, totalMs: performance.now() - started,
      promptTokens: null, completionTokens: null, cachedPromptTokens: null,
      promptTokensPerSecond: null, predictedTokensPerSecond: null, outputSha256: null,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let output = "";
  let ttftMs: number | null = null;
  let finishReason: string | null = null;
  let parseErrors = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let cachedPromptTokens: number | null = null;
  let promptTokensPerSecond: number | null = null;
  let predictedTokensPerSecond: number | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
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
        const chunk = JSON.parse(data) as Record<string, unknown>;
        const choice = Array.isArray(chunk["choices"]) ? chunk["choices"][0] : null;
        if (choice !== null && typeof choice === "object") {
          const delta = (choice as Record<string, unknown>)["delta"];
          if (delta !== null && typeof delta === "object") {
            const part = [
              (delta as Record<string, unknown>)["reasoning_content"],
              (delta as Record<string, unknown>)["content"],
            ].filter((item): item is string => typeof item === "string").join("");
            if (part.length > 0 && ttftMs === null) ttftMs = performance.now() - started;
            output += part;
          }
          const finish = (choice as Record<string, unknown>)["finish_reason"];
          if (typeof finish === "string") finishReason = finish;
        }
        const usage = chunk["usage"];
        if (usage !== null && typeof usage === "object") {
          promptTokens = finite((usage as Record<string, unknown>)["prompt_tokens"]);
          completionTokens = finite((usage as Record<string, unknown>)["completion_tokens"]);
          const details = (usage as Record<string, unknown>)["prompt_tokens_details"];
          if (details !== null && typeof details === "object") {
            cachedPromptTokens = finite((details as Record<string, unknown>)["cached_tokens"]);
          }
        }
        const timings = chunk["timings"];
        if (timings !== null && typeof timings === "object") {
          const values = timings as Record<string, unknown>;
          promptTokensPerSecond = finite(values["prompt_per_second"]);
          predictedTokensPerSecond = finite(values["predicted_per_second"]);
          promptTokens ??= finite(values["prompt_n"]);
          completionTokens ??= finite(values["predicted_n"]);
          cachedPromptTokens ??= finite(values["cache_n"]);
        }
      } catch { parseErrors++; }
    }
  }
  const normalized = output.trim();
  const meaningful = normalized.length > 0;
  return {
    ok: parseErrors === 0 && meaningful && finishReason !== null,
    exactAnswer: normalized === "323",
    ttftMs,
    totalMs: performance.now() - started,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    promptTokensPerSecond,
    predictedTokensPerSecond,
    outputSha256: meaningful ? createHash("sha256").update(normalized).digest("hex") : null,
  };
}

async function runTrial(config: StrixMmapAbConfig, variant: StrixMmapVariant, sequence: number): Promise<StrixMmapTrial> {
  if (!(await portIsFree(config.port))) throw new Error(`ephemeral port ${config.port} is already occupied`);
  const startedAt = new Date().toISOString();
  const logHash = createHash("sha256");
  const child = spawn(config.binaryPath, buildMmapServerArgs(config, variant), {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, GGML_VK_VISIBLE_DEVICES: config.backend === "vulkan" ? "0" : process.env["GGML_VK_VISIBLE_DEVICES"] },
  });
  activeEphemeralChild = child;
  child.stderr?.on("data", (chunk: Buffer) => logHash.update(chunk));
  if (child.pid === undefined) throw new Error("ephemeral llama-server did not expose a pid");
  const sampler = startSampler(child.pid);
  try {
    const startupReadyMs = await waitHealthy(child, config.port);
    const first = await streamedArithmetic(config.port, config.modelId);
    const warm = await streamedArithmetic(config.port, config.modelId);
    const sampled = sampler.stop();
    return { variant, sequence, startedAt, endedAt: new Date().toISOString(), startupReadyMs, ...sampled, first, warm };
  } finally {
    try { sampler.stop(); } catch { /* already stopped */ }
    await stopChild(child);
    if (activeEphemeralChild === child) activeEphemeralChild = null;
    logHash.digest("hex");
  }
}

function commandOutput(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) return null;
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().replace(/\0/g, "");
  return text.length === 0 ? null : text.slice(0, 8_192);
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

function renderMarkdown(report: Record<string, unknown>): string {
  const evaluation = report["evaluation"] as ReturnType<typeof evaluateMmapAb>;
  const config = report["config"] as StrixMmapAbConfig;
  const pct = (candidate: number, baseline: number): string => `${(((candidate / baseline) - 1) * 100).toFixed(1)}%`;
  return [
    "# Strix Halo mmap A/B",
    "",
    `Decision: **${evaluation.decision.toUpperCase()}** (exploratory ABBA gate)`,
    "",
    `Model: ${config.modelId} (${config.quant}, ${config.backend})`,
    `Runtime: ${config.runtimeCommit}`,
    "",
    "| Metric (median) | mmap | no-mmap | delta |",
    "|---|---:|---:|---:|",
    `| Startup to ready (ms) | ${evaluation.mmap.startupReadyMs.toFixed(1)} | ${evaluation.noMmap.startupReadyMs.toFixed(1)} | ${pct(evaluation.noMmap.startupReadyMs, evaluation.mmap.startupReadyMs)} |`,
    `| Peak RSS (GiB) | ${(evaluation.mmap.peakRssBytes / 1024 ** 3).toFixed(2)} | ${(evaluation.noMmap.peakRssBytes / 1024 ** 3).toFixed(2)} | ${pct(evaluation.noMmap.peakRssBytes, evaluation.mmap.peakRssBytes)} |`,
    `| First TTFT (ms) | ${evaluation.mmap.firstTtftMs?.toFixed(1) ?? "n/a"} | ${evaluation.noMmap.firstTtftMs?.toFixed(1) ?? "n/a"} | — |`,
    `| Prompt processing (tok/s) | ${evaluation.mmap.promptTokensPerSecond?.toFixed(1) ?? "n/a"} | ${evaluation.noMmap.promptTokensPerSecond?.toFixed(1) ?? "n/a"} | — |`,
    `| Generation (tok/s) | ${evaluation.mmap.predictedTokensPerSecond?.toFixed(1) ?? "n/a"} | ${evaluation.noMmap.predictedTokensPerSecond?.toFixed(1) ?? "n/a"} | — |`,
    "",
    "## Decision evidence",
    "",
    ...evaluation.reasons.map((reason) => `- ${reason}`),
    "",
    "The model file was SHA-256-read before the trials, so this measures cold process/model load with a warm filesystem cache. No host-wide cache, swap, governor, or service setting was changed. Four trials are a promotion screen, not a significance claim.",
    "",
  ].join("\n");
}

export async function runStrixMmapAb(argv: string[]): Promise<number> {
  const plan = parseStrixMmapAbArgs(argv);
  if (process.platform !== "linux") throw new Error("the mmap A/B runner requires Linux");
  const configText = readFileSync(plan.configPath, "utf8");
  if (Buffer.byteLength(configText) > MAX_CONFIG_BYTES) throw new Error("config exceeds 64 KiB");
  const config = validateStrixMmapAbConfig(JSON.parse(configText) as unknown);
  for (const [label, path] of [["binary", config.binaryPath], ["model", config.modelPath]] as const) {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`${label} path is not a regular file`);
    if (label === "binary" && (stat.mode & 0o111) === 0) throw new Error("binary is not executable");
  }
  if (!(await portIsFree(config.port))) throw new Error(`ephemeral port ${config.port} is already occupied`);
  const runtimeVersion = commandOutput(config.binaryPath, ["--version"]);
  if (runtimeVersion === null || !runtimeVersion.includes(config.runtimeCommit.slice(0, 8))) {
    throw new Error("runtime --version does not prove the configured immutable commit");
  }
  const initialResidency = await runningSnapshot(plan.llamaSwapOrigin);
  if (initialResidency.some((entry) => entry.state === "starting")) throw new Error("llama-swap residency is not stable");
  if (initialResidency.filter((entry) => entry.state === "ready").length > 1) throw new Error("more than one ready model violates the serial-GPU restore contract");

  const startedAt = new Date().toISOString();
  // Hashing is provenance and a deliberate identical page-cache prime for all ABBA trials.
  const [runtimeBinarySha256, modelArtifactSha256] = await Promise.all([
    sha256File(config.binaryPath), sha256File(config.modelPath),
  ]);
  if (runtimeBinarySha256 !== config.runtimeBinarySha256) throw new Error("runtime binary hash differs from the reviewed config");
  if (modelArtifactSha256 !== config.modelArtifactSha256) throw new Error("model artifact hash differs from the reviewed config");
  const serverArgsSha256 = createHash("sha256").update(JSON.stringify(config.commonArgs)).digest("hex");
  const trials: StrixMmapTrial[] = [];
  let interruptedBy: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    interruptedBy ??= signal;
    activeEphemeralChild?.kill("SIGTERM");
  };
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.once(signal, onSignal);
  try {
    await withRequiredRestoration(async () => {
      for (const variant of mmapTrialOrder(plan.cycles)) {
        if (interruptedBy !== null) throw new Error(`benchmark interrupted by ${interruptedBy}`);
        await unloadAll(plan.llamaSwapOrigin);
        await sleep(2_000);
        if (interruptedBy !== null) throw new Error(`benchmark interrupted by ${interruptedBy}`);
        trials.push(await runTrial(config, variant, trials.length));
        await sleep(2_000);
      }
    }, async () => restoreResidency(plan.llamaSwapOrigin, initialResidency));
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
  }

  const evaluation = evaluateMmapAb(trials);
  const finalResidency = await runningSnapshot(plan.llamaSwapOrigin);
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    label: "LOCAL-MEASURED",
    config,
    provenance: {
      runtimeBinarySha256, modelArtifactSha256, serverArgsSha256,
      runtimeVersion,
      kernel: readFileSync("/proc/sys/kernel/osrelease", "utf8").trim(),
      mesa: commandOutput("vulkaninfo", ["--summary"]),
      rocm: commandOutput("rocminfo", ["--version"]),
    },
    filesystemCacheState: "model SHA-256 read completed before ABBA; warm filesystem cache, cold process/model load",
    initialResidency: initialResidency.map(({ model, state, ttl }) => ({ model, state, ttlSeconds: ttl ?? null })),
    finalResidency: finalResidency.map(({ model, state, ttl }) => ({ model, state, ttlSeconds: ttl ?? null })),
    order: mmapTrialOrder(plan.cycles),
    trials,
    evaluation,
    limitations: [
      "ABBA controls order but four trials are exploratory and do not support parametric significance claims.",
      "RSS and MemAvailable observe shared-memory pressure; neither is a board-power or physical-VRAM measurement.",
      "The exact arithmetic request is a correctness smoke, not an agent-quality benchmark.",
    ],
  };
  const jsonPath = `${resolve(plan.outPrefix)}.json`;
  const markdownPath = `${resolve(plan.outPrefix)}.md`;
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(markdownPath, renderMarkdown(report));
  console.log(JSON.stringify({ status: evaluation.decision, jsonPath, markdownPath, restored: true }));
  return evaluation.decision === "promote" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStrixMmapAb(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
