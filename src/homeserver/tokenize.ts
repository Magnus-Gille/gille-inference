/** Deterministic raw-text tokenization. No generation, estimates or content logging. */
import type { HomeserverConfig } from "./config.js";
import type { McpPrincipal } from "./mcp.js";
import { AdmissionController, AdmissionRejected } from "./admission.js";
import { admitHostMemory, type HostMemoryAdmissionDeps } from "./host-memory-admission.js";
import { getRunningSnapshot } from "./model-admin.js";
import { assertModelKey } from "./lmstudio-admin.js";
import { isSystemOneDecisionModel } from "./systemone-request.js";
import { isEmbeddingModel } from "./embedding-request.js";
import { checkQuota, recordUsage } from "./quota.js";
import { classifyUpstreamError } from "./errors.js";
import { hasValidUtf16, parseTokenizeResponse } from "./tokenize-response.js";

export const TOKENIZE_MAX_TEXT_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 1_048_576;
export const TOKENIZE_TOOL = {
  name: "tokenize",
  description: "Get exact raw-text token counts, token IDs and pieces from a served llama.cpp model's own tokenizer. " +
    "Use a model id from list_models; tokenizer is a tool, not a separate model. No generation, chat template or added special tokens. " +
    "Pieces are Unicode strings or raw byte arrays for tokens splitting UTF-8 characters. Maximum 16384 UTF-8 input bytes. " +
    "May load the model through normal admission and memory checks. Counts toward request rate limits, but charges no inference credits. " +
    "Unsupported runtimes return an error; never substitute a guessed count or another encoding.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["model", "text"],
    properties: { model: { type: "string", maxLength: 200 }, text: { type: "string", maxLength: TOKENIZE_MAX_TEXT_BYTES } },
  },
  outputSchema: {
    type: "object", additionalProperties: false,
    required: ["model", "count", "tokens", "pieces", "add_special", "parse_special"],
    properties: {
      model: { type: "string" }, count: { type: "integer", minimum: 0 },
      tokens: { type: "array", items: { type: "integer", minimum: 0 } },
      pieces: { type: "array", items: { anyOf: [{ type: "string" }, { type: "array", items: { type: "integer", minimum: 0, maximum: 255 } }] } },
      add_special: { const: false }, parse_special: { const: false },
    },
  },
};

interface TokenizeContext {
  cfg: HomeserverConfig;
  principal: McpPrincipal;
  controller: AdmissionController;
  hostMemoryAdmission?: HostMemoryAdmissionDeps;
  inflight: { inc(alias: string): void; dec(alias: string): void; current(alias: string): number };
}
type ToolResult = { text: string; isError: boolean; structuredContent?: unknown; meta?: Record<string, unknown>; trace?: { traceOutcome: string; traceErrorClass?: string } };
function failure(code: string, text: string, retryable = false, retryAfterSeconds?: number): ToolResult {
  return { text, isError: true, meta: { m5_code: code, retryable, ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }) },
    trace: { traceOutcome: "error", traceErrorClass: code } };
}
class InvalidTokenizeResponse extends Error {}
async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new InvalidTokenizeResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new InvalidTokenizeResponse();
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new InvalidTokenizeResponse();
    throw error;
  }
}

export async function runTokenize(args: Record<string, unknown>, ctx: TokenizeContext): Promise<ToolResult> {
  const { model, text } = args;
  if (Object.keys(args).some(key => key !== "model" && key !== "text") ||
      typeof model !== "string" || typeof text !== "string" || !hasValidUtf16(text) ||
      Buffer.byteLength(text, "utf8") > TOKENIZE_MAX_TEXT_BYTES) {
    return failure("invalid_request", "tokenize requires {model, text}; text must be valid Unicode and at most 16384 UTF-8 bytes.");
  }
  try { assertModelKey(model); }
  catch { return failure("invalid_request", "Invalid model id; select a model from list_models."); }
  const { principal, cfg } = ctx;
  if (principal.modelAllowList.length && !principal.modelAllowList.includes(model)) {
    return failure("model_not_allowed", "This key is not permitted to use the requested model.");
  }
  if (cfg.backend !== "llamaswap" || isSystemOneDecisionModel(model, cfg.systemOneModels) || isEmbeddingModel(model)) {
    return failure("tokenizer_unsupported", "This tool supports llama.cpp text models through llama-swap; this runtime is not supported.");
  }
  // This utility produces no inference tokens or credits. Keep the same per-key request quota.
  const quota = checkQuota(principal.alias, principal.limits, 0);
  if (!quota.ok) return failure("rate_limited", "Tokenization request quota exceeded.", true, quota.retryAfterSeconds);
  let release: (() => void) | undefined;
  let counted = false;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    release = await ctx.controller.acquire({ lane: principal.tier, requestedModel: model, keyMaxParallel: principal.maxParallel,
      keyInflight: ctx.inflight.current(principal.alias), keyId: principal.alias });
    ctx.inflight.inc(principal.alias); counted = true;
    const memory = await admitHostMemory(cfg.hostMemoryAdmission, model, ctx.hostMemoryAdmission ?? { getRunning: getRunningSnapshot });
    if (memory !== null) return failure("server_busy", "Model memory admission refused tokenization.", true, memory.retryAfterSeconds ?? undefined);
    const origin = (process.env["LLAMASWAP_BASE_URL"] || cfg.lmStudioBaseUrl.replace(/\/v1\/?$/, "")).replace(/\/$/, "");
    timer = setTimeout(() => abort.abort(), Math.min(cfg.callTimeoutMs, 60_000));
    const response = await fetch(`${origin}/upstream/${encodeURIComponent(model)}/tokenize`, {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: text, add_special: false, parse_special: false, with_pieces: true }),
    });
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      return failure("tokenizer_unsupported", "The selected model or its native tokenizer endpoint is unavailable. No token count was estimated.");
    }
    if (!response.ok) return failure("upstream_error", "The tokenizer backend refused the request.", response.status >= 500);
    const parsed = parseTokenizeResponse(await readResponse(response));
    if (parsed === null) throw new InvalidTokenizeResponse();
    const result = { model, ...parsed, add_special: false, parse_special: false };
    return { text: JSON.stringify(result), isError: false, structuredContent: result };
  } catch (error) {
    if (error instanceof AdmissionRejected) return failure("server_busy", "The server is busy; tokenization was not started.", true, error.retryAfterSeconds);
    if (error instanceof InvalidTokenizeResponse) return failure("invalid_tokenizer_response", "The backend did not return a bounded native token/piece result. No token count was estimated.");
    const kind = classifyUpstreamError(error);
    if (kind !== null) return failure(kind, kind === "upstream_timeout" ? "The tokenizer request timed out." : "The tokenizer backend is unavailable.", true);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
    if (counted) ctx.inflight.dec(principal.alias);
    release?.();
    recordUsage(principal.alias, 0, Date.now(), quota.reservation);
  }
}
