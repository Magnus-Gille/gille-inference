import { loadConfig, type HomeserverConfig } from "./config.js";
import type { LocalInferenceResult } from "../runner/local-client.js";
import type { ResponseFormat } from "../runner/openrouter-client.js";

/** Stable identities used in logs, metrics and ledger evidence. */
export type ComputeNodeId = "m5" | "orin";

export function isComputeNodeId(value: unknown): value is ComputeNodeId {
  return value === "m5" || value === "orin";
}

/**
 * Orin is deliberately opt-in. An empty URL means this gateway has no remote-node capability,
 * preserving the M5-only behaviour of existing deployments.
 */
export function orinEnabled(cfg: HomeserverConfig = loadConfig()): boolean {
  return cfg.orin.url !== "";
}

export function orinAllowsTask(taskType: string, cfg: HomeserverConfig = loadConfig()): boolean {
  return orinEnabled(cfg) && cfg.orin.eligibleTaskTypes.includes(taskType);
}

/** A content-blind availability/inventory probe for /healthz and deployment checks. */
export async function probeOrin(cfg: HomeserverConfig = loadConfig()): Promise<{
  id: "orin";
  configured: boolean;
  ok: boolean;
  model: string;
  modelAvailable: boolean;
}> {
  if (!orinEnabled(cfg)) {
    return { id: "orin", configured: false, ok: false, model: cfg.orin.model, modelAvailable: false };
  }
  try {
    const res = await fetch(`${cfg.orin.url}/api/tags`, { signal: AbortSignal.timeout(cfg.orin.healthTimeoutMs) });
    if (!res.ok) return { id: "orin", configured: true, ok: false, model: cfg.orin.model, modelAvailable: false };
    const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const modelAvailable = (body.models ?? []).some((m) => m.name === cfg.orin.model || m.model === cfg.orin.model);
    return { id: "orin", configured: true, ok: modelAvailable, model: cfg.orin.model, modelAvailable };
  } catch {
    return { id: "orin", configured: true, ok: false, model: cfg.orin.model, modelAvailable: false };
  }
}

export interface OrinChatResult {
  response: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
}

/**
 * The Jetson's Ollama build deliberately exposes its native `/api/chat` surface, not OpenAI's
 * optional `/v1` compatibility shim. Keep that implementation detail at the node boundary and
 * normalize it for the gateway above it.
 */
export async function runOrinChat(
  model: string,
  messages: Array<{ role: string; content: unknown }>,
  opts: { maxTokens: number; temperature: number; topP?: number; topK?: number; minP?: number; signal?: AbortSignal },
  cfg: HomeserverConfig = loadConfig()
): Promise<{ ok: true; value: OrinChatResult } | { ok: false; error: string }> {
  if (!orinEnabled(cfg) || model !== cfg.orin.model) return { ok: false, error: "orin unavailable or model not allowed" };
  const started = Date.now();
  try {
    const res = await fetch(`${cfg.orin.url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        options: {
          num_predict: opts.maxTokens,
          temperature: opts.temperature,
          top_p: opts.topP,
          top_k: opts.topK,
          min_p: opts.minP,
        },
      }),
      signal: opts.signal,
    });
    if (!res.ok) return { ok: false, error: `orin HTTP ${res.status}` };
    const body = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const response = body.message?.content;
    if (!response) return { ok: false, error: "orin empty response" };
    const durationMs = Date.now() - started;
    return {
      ok: true,
      value: {
        response,
        durationMs,
        promptTokens: body.prompt_eval_count ?? 0,
        completionTokens: body.eval_count ?? 0,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** OpenAI-shaped local inference used only by an explicit, eligible Orin delegation. */
export async function runOrinInference(
  model: string,
  prompt: string,
  opts: { systemPrompt?: string; maxTokens: number; temperature: number; topP?: number; topK?: number; minP?: number; responseFormat?: ResponseFormat; signal?: AbortSignal },
  cfg: HomeserverConfig = loadConfig()
): Promise<LocalInferenceResult> {
  // Ollama's native API has no equivalent to the gateway's response_format contract. The Orin
  // allow-list contains only small extract/classify lanes, so reject no request here; callers can
  // still deterministically verify the output and Hugin retains the fallback decision.
  const r = await runOrinChat(
    model,
    [...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []), { role: "user", content: prompt }],
    opts,
    cfg
  );
  if (!r.ok) return r;
  const { response, durationMs, promptTokens, completionTokens } = r.value;
  return { ok: true, response, durationMs, ttftMs: durationMs, promptTokens, completionTokens, tokensPerSecond: completionTokens / Math.max(durationMs / 1000, 0.001), provider: "local-ollama" };
}
