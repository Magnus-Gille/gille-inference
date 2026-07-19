/**
 * probe-runner.ts — reusable probe-execution core for the weekly model scout.
 *
 * Extracted from the proven loop in scripts/m5-cartography.ts. Parameterised on
 * endpoint + apiKey so it works equally against:
 *   - the live M5 gateway (authed)
 *   - an ephemeral llama-server on a scratch port (no auth)
 *
 * Runs probes sequentially — the GPU is serial; never parallelise probe calls.
 */

import type { Probe } from "./probes.js";
import { resolveLocalSampling } from "./sampling-profile.js";
import type { ProbeRunResult, ProbeRunSummary, TaskTypeScore } from "./scout-types.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ChatCallResult {
  output: string;
  latencyMs: number;
  tokPerSec: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningChars: number | null;
  finishReason?: string | null;
}

export type ChatFn = (model: string, probe: Probe) => Promise<ChatCallResult>;

function failedReviewMetrics(
  probe: Probe
): NonNullable<ProbeRunResult["reviewMetrics"]> | undefined {
  if (probe.reviewExpectedFindings === undefined) return undefined;
  return {
    expectedFindings: probe.reviewExpectedFindings,
    truePositives: 0,
    reportedFindings: 0,
    cleanControl: probe.reviewExpectedFindings === 0,
    cleanConfabulated: false,
  };
}

// ── makeChatFn ────────────────────────────────────────────────────────────────

interface GatewayResponse {
  choices: Array<{
    finish_reason?: string | null;
    message: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  timings?: {
    predicted_per_second?: number;
  };
}

/**
 * Returns a ChatFn that POSTs to `<endpoint>/chat/completions`.
 * `endpoint` should already include `/v1` (trailing slash is stripped).
 * Sets `Authorization: Bearer <apiKey>` only when apiKey is non-empty.
 */
export function makeChatFn(opts: {
  endpoint: string;
  apiKey?: string;
  timeoutMs?: number;
}): ChatFn {
  const base = opts.endpoint.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 180_000;

  return async (model: string, probe: Probe): Promise<ChatCallResult> => {
    const messages: Array<{ role: string; content: string }> = [];
    if (probe.systemPrompt) {
      messages.push({ role: "system", content: probe.systemPrompt });
    }
    messages.push({ role: "user", content: probe.prompt });

    const sampling = resolveLocalSampling(model, { temperature: probe.temperature });
    const body = JSON.stringify({
      model,
      messages,
      max_tokens: probe.maxTokens ?? 2048,
      temperature: sampling.temperature,
      ...(sampling.topP !== undefined ? { top_p: sampling.topP } : {}),
      ...(sampling.topK !== undefined ? { top_k: sampling.topK } : {}),
      ...(sampling.minP !== undefined ? { min_p: sampling.minP } : {}),
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.apiKey && opts.apiKey.length > 0) {
      headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - t0;

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "(unreadable)");
      throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = (await resp.json()) as GatewayResponse;
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error("No choices in response");

    const output = msg.content ?? "";
    const reasoningChars =
      msg.reasoning_content != null ? msg.reasoning_content.length : null;
    const promptTokens = data.usage?.prompt_tokens ?? null;
    const completionTokens = data.usage?.completion_tokens ?? null;

    let tokPerSec: number | null = null;
    if (data.timings?.predicted_per_second != null) {
      tokPerSec = data.timings.predicted_per_second;
    } else if (completionTokens != null) {
      // Use at least 1 ms to avoid division by zero in synchronous test mocks;
      // in real network calls latencyMs is always > 0.
      const elapsedSec = Math.max(latencyMs, 1) / 1000;
      tokPerSec = Math.round((completionTokens / elapsedSec) * 10) / 10;
    }

    return {
      output,
      latencyMs,
      tokPerSec,
      promptTokens,
      completionTokens,
      reasoningChars,
      finishReason: data.choices[0]?.finish_reason ?? null,
    };
  };
}

// ── summarize ─────────────────────────────────────────────────────────────────

/** Pure aggregation: fold a flat ProbeRunResult[] into a ProbeRunSummary. */
export function summarize(
  model: string,
  endpoint: string,
  results: ProbeRunResult[]
): ProbeRunSummary {
  const totalRuns = results.length;
  let pass = 0;
  let partial = 0;
  let fail = 0;
  let error = 0;
  let tokSum = 0;
  let tokCount = 0;
  let emptyOutputs = 0;
  let truncations = 0;
  const finishReasonCounts = new Map<string, number>();
  let reviewRuns = 0;
  let seededBugs = 0;
  let truePositives = 0;
  let reportedFindings = 0;
  let cleanControls = 0;
  let confabulatedCleanControls = 0;

  for (const r of results) {
    if (r.outcome === "pass") pass++;
    else if (r.outcome === "partial") partial++;
    else if (r.outcome === "fail") fail++;
    else error++; // "error" | "unverified" both land here

    if (r.emptyOutput) emptyOutputs++;
    if (r.truncated) truncations++;
    // A non-null latency means the HTTP/model call completed and returned a response. Keep an
    // explicit `missing` bucket when that response omitted finish_reason; transport errors are
    // already represented by the independent error count and must not be conflated with it.
    if (r.latencyMs !== null) {
      const reason = r.finishReason ?? "missing";
      finishReasonCounts.set(reason, (finishReasonCounts.get(reason) ?? 0) + 1);
    }
    if (r.reviewMetrics) {
      reviewRuns++;
      seededBugs += r.reviewMetrics.expectedFindings;
      truePositives += r.reviewMetrics.truePositives;
      reportedFindings += r.reviewMetrics.reportedFindings;
      if (r.reviewMetrics.cleanControl) cleanControls++;
      if (r.reviewMetrics.cleanConfabulated) confabulatedCleanControls++;
    }

    if (r.tokPerSec != null) {
      tokSum += r.tokPerSec;
      tokCount++;
    }
  }

  const passRate = totalRuns > 0 ? pass / totalRuns : 0;
  const avgTokPerSec =
    tokCount > 0 ? Math.round((tokSum / tokCount) * 10) / 10 : null;

  // Group by taskType
  const byMap = new Map<string, TaskTypeScore>();
  for (const r of results) {
    let g = byMap.get(r.taskType);
    if (!g) {
      g = { taskType: r.taskType, attempts: 0, passes: 0, partials: 0, fails: 0, errors: 0, passRate: 0 };
      byMap.set(r.taskType, g);
    }
    g.attempts++;
    if (r.outcome === "pass") g.passes++;
    else if (r.outcome === "partial") g.partials++;
    else if (r.outcome === "fail") g.fails++;
    else g.errors++;
  }
  for (const g of byMap.values()) {
    g.passRate = g.attempts > 0 ? g.passes / g.attempts : 0;
  }
  const byTaskType = Array.from(byMap.values()).sort((a, b) =>
    a.taskType.localeCompare(b.taskType)
  );

  return {
    model,
    endpoint,
    totalRuns,
    pass,
    partial,
    fail,
    error,
    passRate,
    avgTokPerSec,
    emptyOutputs,
    truncations,
    finishReasons: Object.fromEntries([...finishReasonCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
    ...(reviewRuns > 0
      ? {
          reviewMetrics: {
            seededBugs,
            truePositives,
            reportedFindings,
            cleanControls,
            confabulatedCleanControls,
            recall: seededBugs > 0 ? truePositives / seededBugs : 0,
            precision: reportedFindings > 0 ? truePositives / reportedFindings : 0,
            cleanConfabulationRate:
              cleanControls > 0 ? confabulatedCleanControls / cleanControls : 0,
          },
        }
      : {}),
    byTaskType,
    results,
  };
}

// ── runProbes ─────────────────────────────────────────────────────────────────

export interface RunProbesOpts {
  model: string;
  endpoint: string;
  probes: Probe[];
  repeats?: number;
  apiKey?: string;
  timeoutMs?: number;
  /** Override the chat function (used in tests and for custom backends). */
  chat?: ChatFn;
  /** Called after each probe×repeat result is built. */
  onResult?: (r: ProbeRunResult) => void;
}

/**
 * Execute the probe battery sequentially (never parallelise — the GPU is serial).
 * Mirrors the loop structure from scripts/m5-cartography.ts lines ~440-465.
 * A thrown chat error records outcome="error" and does NOT abort the run.
 */
export async function runProbes(opts: RunProbesOpts): Promise<ProbeRunSummary> {
  const repeats = opts.repeats ?? 1;
  const chat: ChatFn = opts.chat ?? makeChatFn({ endpoint: opts.endpoint, apiKey: opts.apiKey, timeoutMs: opts.timeoutMs });

  const results: ProbeRunResult[] = [];

  for (const probe of opts.probes) {
    for (let rep = 1; rep <= repeats; rep++) {
      let r: ProbeRunResult;
      try {
        const call = await chat(opts.model, probe);
        const finishReason = call.finishReason ?? null;
        const emptyOutput = call.output.trim().length === 0;
        const truncated = finishReason === "length";
        const vr = emptyOutput
          ? { outcome: "error" as const, score: 0, notes: "empty output" }
          : await probe.verifier(call.output);
        const reviewMetrics = vr.reviewMetrics ?? failedReviewMetrics(probe);
        r = {
          probeId: probe.id,
          taskType: probe.taskType,
          verifierName: probe.verifierName,
          repeat: rep,
          outcome: vr.outcome,
          score: vr.score ?? null,
          latencyMs: call.latencyMs,
          tokPerSec: call.tokPerSec,
          notes: vr.notes ?? null,
          finishReason,
          emptyOutput,
          truncated,
          ...(reviewMetrics ? { reviewMetrics } : {}),
        };
      } catch (err: unknown) {
        const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        const reviewMetrics = failedReviewMetrics(probe);
        r = {
          probeId: probe.id,
          taskType: probe.taskType,
          verifierName: probe.verifierName,
          repeat: rep,
          outcome: "error",
          score: 0,
          latencyMs: null,
          tokPerSec: null,
          notes: msg,
          finishReason: null,
          emptyOutput: false,
          truncated: false,
          ...(reviewMetrics ? { reviewMetrics } : {}),
        };
      }

      results.push(r);
      opts.onResult?.(r);
    }
  }

  return summarize(opts.model, opts.endpoint, results);
}
