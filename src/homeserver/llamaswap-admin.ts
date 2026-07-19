/**
 * llama-swap backend adapter.
 *
 * llama-swap API (v227):
 *   GET  <origin>/v1/models        → {data:[{id,object,created,owned_by}]}
 *   GET  <origin>/running          → {running:[{model,state,cmd,proxy,ttl,...}]}
 *   POST <origin>/api/models/unload         → unload all (200 "OK")
 *   POST <origin>/api/models/unload/:id     → unload one
 *
 * There is no native load endpoint — a first POST /v1/chat/completions
 * auto-spawns the model. There is no download endpoint.
 *
 * Context-length is parsed from the running entry's `cmd` field:
 *   -c <N>  or  --ctx-size <N>
 */

import { loadConfig } from "./config.js";
import {
  assertModelKey,
  assertGpu,
  type ModelInfo,
  type LoadOptions,
  type LoadResult,
} from "./lmstudio-admin.js";

export type { ModelInfo, LoadOptions, LoadResult };
// Re-export validators so the facade shape matches typeof lmstudio-admin
export { assertModelKey, assertGpu };

/** Derive the llama-swap origin from config. Strips trailing /v1 from lmStudioBaseUrl,
 *  or uses LLAMASWAP_BASE_URL if set. */
function getOrigin(): string {
  const override = process.env["LLAMASWAP_BASE_URL"];
  if (override) return override.replace(/\/$/, "");
  const base = loadConfig().lmStudioBaseUrl;
  return base.replace(/\/v1$/, "");
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5000
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Parse context length from a llama-server command string.
 *  Matches `-c <N>` or `--ctx-size <N>`. Returns null if not found. */
function parseCtxFromCmd(cmd: string | undefined | null): number | null {
  if (!cmd) return null;
  // Try -c <N> (short form used by llama-server)
  const shortM = /(?:^|\s)-c\s+(\d+)/.exec(cmd);
  if (shortM) return parseInt(shortM[1]!, 10);
  // Try --ctx-size <N>
  const longM = /(?:^|\s)--ctx-size\s+(\d+)/.exec(cmd);
  if (longM) return parseInt(longM[1]!, 10);
  return null;
}

interface LlamaSwapRunningEntry {
  model: string;
  state: string;
  cmd?: string;
  proxy?: string;
  ttl?: number;
  [key: string]: unknown;
}

/** Fetch /running and return the array (empty if idle). */
async function fetchRunning(origin: string): Promise<LlamaSwapRunningEntry[]> {
  const res = await fetchWithTimeout(`${origin}/running`, {}, 5000);
  if (!res.ok) return [];
  const data = (await res.json()) as { running?: LlamaSwapRunningEntry[] };
  return data.running ?? [];
}

/** List all configured models, merged with running state. */
export async function listModels(): Promise<ModelInfo[]> {
  const origin = getOrigin();
  const [modelsRes, running] = await Promise.all([
    fetchWithTimeout(`${origin}/v1/models`, {}, 5000),
    fetchRunning(origin),
  ]);
  if (!modelsRes.ok) throw new Error(`llama-swap GET /v1/models returned ${modelsRes.status}`);
  const data = (await modelsRes.json()) as { data?: Array<{ id: string; object?: string; created?: number; owned_by?: string }> };
  const runningMap = new Map(running.filter(r => r.state === "ready").map(r => [r.model, r]));

  return (data.data ?? []).map((m) => {
    const runEntry = runningMap.get(m.id);
    const loaded = runEntry !== undefined;
    const loadedContext = loaded ? (parseCtxFromCmd(runEntry!.cmd) ?? null) : null;
    return {
      key: m.id,
      type: "llm" as const,
      displayName: m.id,
      loaded,
      loadedContext,
      // quant / sizeBytes / paramsString / vision / toolUse / maxContextLength / bitsPerWeight
      // are not available from llama-swap — sparse-but-valid ModelInfo.
    };
  });
}

/** Return currently loaded models (state:"ready") with their parsed context lengths. */
export async function getLoaded(): Promise<Array<{ key: string; contextLength: number | null }>> {
  const origin = getOrigin();
  const running = await fetchRunning(origin);
  return running
    .filter((r) => r.state === "ready")
    .map((r) => ({ key: r.model, contextLength: parseCtxFromCmd(r.cmd) }));
}

/** Unload a model by key (POST /api/models/unload/:id), or unload all (POST /api/models/unload). */
export async function unloadModel(
  modelKey?: string
): Promise<{ ok: boolean; message: string }> {
  if (modelKey !== undefined) assertModelKey(modelKey);
  const origin = getOrigin();
  const url = modelKey
    ? `${origin}/api/models/unload/${encodeURIComponent(modelKey)}`
    : `${origin}/api/models/unload`;
  try {
    const res = await fetchWithTimeout(url, { method: "POST" }, 10_000);
    if (res.status >= 400) {
      const body = await res.text().catch(() => "");
      return { ok: false, message: body || `HTTP ${res.status}` };
    }
    return { ok: true, message: modelKey ? `unloaded ${modelKey}` : "unloaded all" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Load a model by triggering a warm-up chat completion.
 *
 * llama-swap has no native load endpoint; a first POST /v1/chat/completions
 * auto-spawns the model. The ctx/parallel/gpu/ttl options in LoadOptions are
 * IGNORED here — those are controlled by llama-swap's config.yaml, not by the caller.
 *
 * If the model is already running (state:"ready") this returns immediately with ok:true.
 */
export async function loadModel(
  modelKey: string,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  void opts; // opts ignored — llama-swap owns startup config
  assertModelKey(modelKey);
  const origin = getOrigin();
  const start = Date.now();

  // Check if already loaded
  const running = await fetchRunning(origin);
  const alreadyLoaded = running.some((r) => r.model === modelKey && r.state === "ready");
  if (alreadyLoaded) {
    return {
      ok: true,
      modelKey,
      identifier: modelKey,
      durationMs: Date.now() - start,
      message: "already loaded",
    };
  }

  // Warm-up: a minimal chat completion triggers llama-swap to spawn the model.
  const cfg = loadConfig();
  const timeoutMs = cfg.callTimeoutMs ?? 300_000;
  try {
    const res = await fetchWithTimeout(
      `${origin}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: modelKey,
          messages: [{ role: "user", content: "." }],
          max_tokens: 1,
        }),
      },
      timeoutMs
    );
    const durationMs = Date.now() - start;
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      return { ok: false, modelKey, identifier: modelKey, durationMs, message: msg || `HTTP ${res.status}` };
    }
    return { ok: true, modelKey, identifier: modelKey, durationMs, message: "loaded" };
  } catch (err) {
    const durationMs = Date.now() - start;
    return {
      ok: false,
      modelKey,
      identifier: modelKey,
      durationMs,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ensure a model is loaded. If already running with state:"ready", returns a no-op success.
 * Otherwise delegates to loadModel() for a warm-up. minContext and opts are noted for
 * context checking but ctx is owned by llama-swap config — no reload is forced.
 */
export async function ensureLoaded(
  modelKey: string,
  _minContext?: number,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  assertModelKey(modelKey);
  const origin = getOrigin();
  const start = Date.now();
  const running = await fetchRunning(origin);
  const entry = running.find((r) => r.model === modelKey && r.state === "ready");
  if (entry) {
    return {
      ok: true,
      modelKey,
      identifier: modelKey,
      durationMs: Date.now() - start,
      message: `already loaded`,
    };
  }
  return loadModel(modelKey, opts);
}

/**
 * Download a model — NOT supported by llama-swap.
 *
 * Returns a soft-unsupported result (ok:true, started:false) so the gateway does
 * not log a 500 for an intentionally-unsupported operation. Models must be
 * pre-downloaded and listed in llama-swap's config.yaml; restart llama-swap to pick
 * up new models.
 */
export async function downloadModel(
  modelKey: string,
  _opts?: { wait?: boolean; timeoutMs?: number }
): Promise<{ ok: boolean; started: boolean; message: string }> {
  assertModelKey(modelKey);
  return {
    ok: true,
    started: false,
    message:
      `downloadModel is not supported by llama-swap. ` +
      `Add the model to config.yaml and restart llama-swap.`,
  };
}
