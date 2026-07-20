import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "./config.js";

/**
 * DEPRECATED (#146) — the live box runs llama-swap; this adapter has no production
 * traffic. Kept for one release for callers still explicitly pointed at LM Studio via
 * HOMESERVER_BACKEND=lmstudio. Scheduled for removal; do not build new features on it.
 *
 * Programmatic control of LM Studio: list / load / unload / download models and swap
 * which one is active. Model *management* uses the `lms` CLI (stable, scriptable);
 * model *introspection* uses LM Studio's REST API (`/api/v1/models`), which is richer
 * than the OpenAI-compatible `/v1/models` (gives quant, context, capabilities, and the
 * config of any loaded instance — including the context length, which we enforce).
 */

const execFileAsync = promisify(execFile);

// ─── Input validation (argv flag-smuggling defense) ─────────────────────────────
// Model keys reach `lms` as CLI arguments via the HTTP admin endpoints. execFile/spawn
// stop *shell* injection, but a value beginning with "-" could still be parsed by `lms`
// as a flag (argument injection). Validate against an allowlist and reject leading "-";
// callers also append "--" before the positional key as belt-and-braces.
const MODEL_KEY_RE = /^[A-Za-z0-9._/@:-]+$/;

export function assertModelKey(key: string, field = "modelKey"): void {
  // Reject flag-smuggling ("-…"), absolute paths ("/…"), path traversal (".."), and
  // anything outside the catalogue-key charset. `lms` accepts file paths as well as
  // catalogue names, so an unvalidated key is a path-traversal vector too.
  if (
    !key ||
    key.length > 200 ||
    key.startsWith("-") ||
    key.startsWith("/") ||
    key.includes("..") ||
    !MODEL_KEY_RE.test(key)
  ) {
    throw new Error(
      `invalid ${field}: must match ${MODEL_KEY_RE}, not begin with '-' or '/', not contain '..', max 200 chars`
    );
  }
}

export function assertGpu(gpu: string): void {
  if (!/^(max|off|0(\.\d+)?|1(\.0+)?)$/.test(gpu)) {
    throw new Error(`invalid gpu offload "${gpu}": expected "max", "off", or 0..1`);
  }
}

/** Coerce a CLI numeric option to a safe positive integer string. */
function posIntArg(value: number, fallback: number): string {
  const n = Math.trunc(value);
  return String(Number.isFinite(n) && n > 0 ? n : fallback);
}

// ─── Types ───────────────────────────────────────────────────────────────────────

export interface ModelInfo {
  key: string;
  type: "llm" | "embedding" | string;
  displayName: string;
  architecture?: string;
  quantization?: string;
  bitsPerWeight?: number;
  sizeBytes?: number;
  paramsString?: string | null;
  maxContextLength?: number;
  vision?: boolean;
  toolUse?: boolean;
  /** True if at least one instance is loaded in memory. */
  loaded: boolean;
  /** Context length of the (first) loaded instance, if any. */
  loadedContext?: number | null;
}

export interface LoadOptions {
  contextLength?: number;
  parallel?: number;
  /** "max" | "off" | 0..1 */
  gpu?: string;
  ttlSeconds?: number;
  /** API identifier to assign; defaults to the model key so the OpenAI id stays stable. */
  identifier?: string;
}

export interface LoadResult {
  ok: boolean;
  modelKey: string;
  identifier: string;
  contextLength?: number;
  durationMs: number;
  message: string;
}

// ─── REST introspection ────────────────────────────────────────────────────────

interface RestModel {
  type: string;
  key: string;
  display_name: string;
  architecture?: string;
  quantization?: { name?: string; bits_per_weight?: number };
  size_bytes?: number;
  params_string?: string | null;
  max_context_length?: number;
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean };
  loaded_instances?: Array<{ id: string; config?: { context_length?: number } }>;
}

async function fetchWithTimeout(url: string, timeoutMs = 5000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** List every model on disk, annotated with whether/how it is loaded. */
export async function listModels(): Promise<ModelInfo[]> {
  const { lmStudioRestUrl } = loadConfig();
  const res = await fetchWithTimeout(`${lmStudioRestUrl}/models`);
  if (!res.ok) throw new Error(`LM Studio REST /models returned ${res.status}`);
  const data = (await res.json()) as { models?: RestModel[] };
  return (data.models ?? []).map((m) => {
    const loaded = (m.loaded_instances ?? []).length > 0;
    const loadedContext = loaded ? m.loaded_instances?.[0]?.config?.context_length ?? null : null;
    return {
      key: m.key,
      type: m.type,
      displayName: m.display_name,
      architecture: m.architecture,
      quantization: m.quantization?.name,
      bitsPerWeight: m.quantization?.bits_per_weight,
      sizeBytes: m.size_bytes,
      paramsString: m.params_string ?? null,
      maxContextLength: m.max_context_length,
      vision: m.capabilities?.vision,
      toolUse: m.capabilities?.trained_for_tool_use,
      loaded,
      loadedContext,
    };
  });
}

/** The currently loaded LLM instances (key + context length). */
export async function getLoaded(): Promise<Array<{ key: string; contextLength: number | null }>> {
  const models = await listModels();
  return models
    .filter((m) => m.loaded && m.type === "llm")
    .map((m) => ({ key: m.key, contextLength: m.loadedContext ?? null }));
}

/**
 * LM Studio has no llama-swap-style `/running` cmd string to observe (#5). This deprecated
 * backend honestly reports null — an unobserved served-model identity — rather than fabricating
 * one; evidence-identity.ts's `evidenceIdentityFromServedModelCmd(null)` turns this into an
 * explicit `unknown("not-observed")`, never a guessed model/config identity.
 */
export async function getRunningCmd(_modelId: string): Promise<string | null> {
  return null;
}

// ─── CLI management ────────────────────────────────────────────────────────────

const SUCCESS_RE = /loaded successfully in ([\d.]+)s/i;

/**
 * Load (or reload) a model via `lms load`. Output is captured and discarded so the
 * progress spinner never floods logs. Returns the parsed load time and context.
 */
export async function loadModel(modelKey: string, opts: LoadOptions = {}): Promise<LoadResult> {
  const cfg = loadConfig();
  const identifier = opts.identifier ?? modelKey;
  assertModelKey(modelKey);
  assertModelKey(identifier, "identifier");
  const gpu = opts.gpu ?? "max";
  assertGpu(gpu);
  const contextLength = opts.contextLength ?? cfg.minContextLength;
  // All options come first; the model key is positional after `--` (end-of-options).
  const args = [
    "load",
    "-c",
    posIntArg(contextLength, cfg.minContextLength),
    "--parallel",
    posIntArg(opts.parallel ?? 1, 1),
    "--gpu",
    gpu,
    "-y",
    "--identifier",
    identifier,
  ];
  if (opts.ttlSeconds !== undefined) args.push("--ttl", posIntArg(opts.ttlSeconds, 3600));
  args.push("--", modelKey);

  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync("lms", args, {
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;
    const combined = `${stdout}\n${stderr}`;
    const m = SUCCESS_RE.exec(combined);
    return {
      ok: true,
      modelKey,
      identifier,
      contextLength,
      durationMs,
      message: m ? `loaded in ${m[1]}s` : "loaded",
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, modelKey, identifier, durationMs, message: msg };
  }
}

/** Unload a specific model instance, or all instances when no key is given. */
export async function unloadModel(modelKey?: string): Promise<{ ok: boolean; message: string }> {
  if (modelKey) assertModelKey(modelKey);
  const args = modelKey ? ["unload", "--", modelKey] : ["unload", "--all"];
  try {
    const { stdout, stderr } = await execFileAsync("lms", args, { timeout: 60_000 });
    return { ok: true, message: `${stdout}${stderr}`.trim() || "unloaded" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ensure `modelKey` is loaded with at least `minContext` context. If it is already
 * loaded with enough context, this is a no-op. Otherwise it (re)loads at the floor.
 * This is what fixes the "loaded at 4096" failure mode automatically.
 */
export async function ensureLoaded(
  modelKey: string,
  minContext = loadConfig().minContextLength,
  opts: LoadOptions = {}
): Promise<LoadResult> {
  assertModelKey(modelKey);
  const loaded = await getLoaded();
  const current = loaded.find((l) => l.key === modelKey);
  if (current && (current.contextLength ?? 0) >= minContext) {
    return {
      ok: true,
      modelKey,
      identifier: modelKey,
      contextLength: current.contextLength ?? undefined,
      durationMs: 0,
      message: `already loaded at ${current.contextLength} ctx`,
    };
  }
  if (current) await unloadModel(modelKey);
  return loadModel(modelKey, { ...opts, contextLength: minContext });
}

/**
 * Download a model from the LM Studio catalogue via `lms get`. Downloads can be many
 * GB and take a long time, so by default this is spawned detached and returns
 * immediately; pass `wait: true` to block (with a long timeout) for scripted use.
 */
export async function downloadModel(
  modelKey: string,
  opts: { wait?: boolean; timeoutMs?: number } = {}
): Promise<{ ok: boolean; started: boolean; message: string }> {
  assertModelKey(modelKey);
  if (opts.wait) {
    try {
      const { stdout, stderr } = await execFileAsync("lms", ["get", "-y", "--", modelKey], {
        timeout: opts.timeoutMs ?? 3_600_000,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { ok: true, started: true, message: `${stdout}${stderr}`.slice(-500) };
    } catch (err) {
      return { ok: false, started: true, message: err instanceof Error ? err.message : String(err) };
    }
  }
  // Fire-and-forget: detach so a long download survives the request lifecycle.
  const child = spawn("lms", ["get", "-y", "--", modelKey], { detached: true, stdio: "ignore" });
  child.unref();
  return { ok: true, started: true, message: `download started for ${modelKey} (detached)` };
}
