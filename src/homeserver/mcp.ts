import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { clampMaxTokensForModel, type HomeserverConfig } from "./config.js";
import { listModels } from "./model-admin.js";
import { AdmissionController, AdmissionRejected, type Lane } from "./admission.js";
import { checkQuota, recordUsage, type QuotaReservation } from "./quota.js";
import { reserveCredits, reconcileCredits, recordUsage as recordCreditUsage } from "./keystore.js";
import { recordOwnerRequest } from "./owner-log.js";
import { recordRequest, inflightInc, inflightDec, recordRateLimited, recordAdmissionRejection } from "./metrics.js";
import { recordRequestLog } from "./request-log.js";
import { recordDelegation } from "./ledger.js";
import { buildDelegationCostTrace, tryRecordDelegationCost } from "./delegation-cost.js";
import { evaluateDelegatePolicy } from "./delegate-policy.js";
import { classifyTask } from "./taxonomy.js";
import { canonicalizeModelTrusted } from "./catalogue.js";
import { classifyUpstreamError, makeError } from "./errors.js";
import {
  describeBlindContextAvailability,
  expandBlindContext,
  MAX_BLIND_CONTEXT_ROOTS,
  type BlindContextConfig,
} from "./blind-context.js";
import { codeLoopToolDefs, isCodeLoopToolName } from "./code-loop.js";
import { handleCodeLoopTool } from "./code-loop-runtime.js";
import { recordMessageTaskExposuresBestEffort } from "./task-exposure.js";
import {
  allowAdoptionEvidenceReportForPrincipal,
  parseAdoptionEvidence,
  recordAdoptionEvidence,
} from "./adoption-evidence.js";
import type { HuginRequestStamp, LearningTaskCapabilityEpoch } from "./learning-task-contract.js";
import type { KeyScope } from "./keystore.js";
// #33: reuse PR #32's exact derivation VERBATIM (never fork it) — see orchestrator.ts's
// deriveEvidenceIdentity doc comment for why this is lane-agnostic and safe to share.
import { deriveEvidenceIdentity } from "./orchestrator.js";
import { currentTraceHeaders } from "./tracing.js";

/**
 * MCP (Model Context Protocol) Streamable-HTTP transport for the gateway.
 *
 * A friend on Claude Code adds the box in ONE command —
 *   claude mcp add --transport http local-llm https://inference.example.com/mcp \
 *     --header "Authorization: Bearer hs_..."
 * — and Claude can then offload self-contained sub-tasks to the local models AS TOOLS,
 * under the SAME bearer auth + credit metering + model allow-list as the rest of the
 * gateway (the `/mcp` route reuses resolvePrincipal before dispatching here).
 *
 * The transport is hand-rolled JSON-RPC 2.0 (one message per POST body) — the surface is
 * tiny (initialize / initialized / ping / tools/list / tools/call) and the gateway is a
 * raw node:http server, so we deliberately do NOT pull in @modelcontextprotocol/sdk.
 *
 * We are stateless: `initialize` emits an `Mcp-Session-Id` header for clients that expect
 * one, but we never require it back.
 */

// ─── The principal shape this module needs (a structural subset of the gateway's) ──────

export interface McpPrincipal {
  alias: string;
  tier: "owner" | "guest";
  scope: KeyScope;
  modelAllowList: string[];
  limits: { rpm: number; tpm: number; dailyTokenBudget: number };
  maxParallel: number;
  keyHash: string | null;
  creditLimit: number;
}

interface McpTraceOverride {
  traceOutcome: string;
  traceErrorClass?: string;
}

interface McpPostResult {
  trace?: McpTraceOverride;
}

// ─── JSON-RPC 2.0 wire types ───────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: unknown;
  params?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

/**
 * M3: the route/surface label for the MCP `ask` INFERENCE row+metric. The outer /mcp transport row
 * (written by the gateway's handleRequest finally) stays "/mcp"; the inference row written here is
 * "/mcp/ask". Distinct routes mean the two rows are unambiguous and inference is counted via
 * "/mcp/ask" — never double-counted against the transport. See docs/observability.md.
 */
const MCP_INFERENCE_ROUTE = "/mcp/ask";

// JSON-RPC error codes (subset we emit).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

function rpcResult(id: string | number | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

// ─── Tool definitions ──────────────────────────────────────────────────────────────────

const ASK_DESCRIPTION =
  "Offload a self-contained sub-task to the user's PRIVATE home inference server (local models, " +
  "no data leaves the box). Ideal for code generation/refactoring, drafting, classification, " +
  "summarization, extraction, and short reasoning where you would otherwise spend frontier tokens. " +
  "Pick a model from list_models; pass the full prompt (and an optional system instruction). " +
  "Successful calls return the model text plus structuredContent {model,text,finish_reason,truncated,metered,usage}. " +
  "A token-limit finish (finish_reason=length) returns isError:true while preserving the partial text in content and the same structuredContent; the truncated call is already metered and any retry is a new billable call. " +
  "Use this liberally for bounded work to save cost and keep data local. " +
  "Call list_models for the live, content-blind ask.files capability state before using file " +
  "attachments. " +
  "OWNER-TIER KEYS ONLY: an optional `files` array of absolute paths on the box is expanded " +
  "SERVER-SIDE into the prompt as local context, so this tool can orchestrate over local data it " +
  "never ingests — only the box reads the file and the local model sees its content. Requires " +
  "HOMESERVER_BLIND_CONTEXT_ROOTS to be configured (disabled by default); a guest key supplying " +
  "`files` is always rejected, never silently ignored.";

const ASK_FILES_REASON_VALUES = ["enabled", "owner_tier_required", "unconfigured", "no_resolved_roots"] as const;
const MAX_SAFE_ROOT_COUNT = MAX_BLIND_CONTEXT_ROOTS;
const STRUCTURED_LIST_MODELS_MIN_M5_CLIENT_VERSION = [1, 2, 1] as const;

type AskFilesReason = (typeof ASK_FILES_REASON_VALUES)[number];

interface AskFilesCapability {
  files_enabled: boolean;
  files_reason: AskFilesReason;
  resolved_root_count: number | null;
}

interface ListModelsStructuredContent {
  models: Array<{ id: string; description: string }>;
  ask_capabilities: AskFilesCapability;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export const ASK_FILES_META_KEY = "gille-inference/ask_capabilities";

const ASK_FILES_CAPABILITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    files_enabled: { type: "boolean" },
    files_reason: { type: "string", enum: ASK_FILES_REASON_VALUES },
    resolved_root_count: {
      oneOf: [
        { type: "integer", minimum: 0, maximum: MAX_SAFE_ROOT_COUNT },
        { type: "null" },
      ],
    },
  },
  required: ["files_enabled", "files_reason", "resolved_root_count"],
  oneOf: [
    {
      properties: {
        files_enabled: { const: true },
        files_reason: { const: "enabled" },
        resolved_root_count: { type: "integer", minimum: 1, maximum: MAX_SAFE_ROOT_COUNT },
      },
    },
    {
      properties: {
        files_enabled: { const: false },
        files_reason: { const: "owner_tier_required" },
        resolved_root_count: { type: "null" },
      },
    },
    {
      properties: {
        files_enabled: { const: false },
        files_reason: { const: "unconfigured" },
        resolved_root_count: { const: 0 },
      },
    },
    {
      properties: {
        files_enabled: { const: false },
        files_reason: { const: "no_resolved_roots" },
        resolved_root_count: { const: 0 },
      },
    },
  ],
} as const;

const LIST_MODELS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          description: { type: "string" },
        },
        required: ["id", "description"],
      },
    },
    ask_capabilities: ASK_FILES_CAPABILITY_SCHEMA,
  },
  required: ["models", "ask_capabilities"],
} as const;

const ASK_USAGE_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt_tokens: { type: ["integer", "null"], minimum: 0 },
    completion_tokens: { type: ["integer", "null"], minimum: 0 },
    total_tokens: { type: ["integer", "null"], minimum: 0 },
    reasoning_tokens: { type: ["integer", "null"], minimum: 0 },
    cache_creation_input_tokens: { type: ["integer", "null"], minimum: 0 },
    cache_read_input_tokens: { type: ["integer", "null"], minimum: 0 },
  },
  required: [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "reasoning_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ],
} as const;

const ASK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    model: { type: "string" },
    text: { type: "string" },
    finish_reason: { type: ["string", "null"] },
    truncated: { type: ["boolean", "null"] },
    metered: { const: true },
    usage: ASK_USAGE_OUTPUT_SCHEMA,
  },
  required: ["model", "text", "finish_reason", "truncated", "metered", "usage"],
} as const;

const CODE_LOOP_OWNER_INSTRUCTIONS =
  "code_loop is OWNER-AGENT ONLY, async, and OS-caged. Delegate only self-contained seed-file work; never credentials, network, live checkouts, or side effects. Caller reviews/applies the diff.";

/**
 * The code_loop owner-agent gate. A real minted owner key preserves the deliberate
 * owner-content/privacy boundary; agent or admin scope supplies route authority. Implicit-admin,
 * legacy static admins (both keyHash === null), inference scope, and guests are excluded.
 */
function isCodeLoopOwner(principal: McpPrincipal): boolean {
  return (
    principal.tier === "owner"
    && principal.keyHash !== null
    && (principal.scope === "admin" || principal.scope === "agent")
  );
}

/**
 * Adoption evidence is written only by a real, minted owner credential with agent/admin scope.
 * The report itself intentionally carries no principal/session identity, but an authenticated
 * gate prevents guests and legacy static keys from poisoning the operator's adoption measure.
 */
function isAdoptionReporter(principal: McpPrincipal): boolean {
  return isCodeLoopOwner(principal);
}

function isAskFilesOwner(principal: McpPrincipal): boolean {
  return principal.tier === "owner";
}

function askFilesCapability(principal: McpPrincipal, cfg: HomeserverConfig): AskFilesCapability {
  if (!isAskFilesOwner(principal)) {
    return {
      files_enabled: false,
      files_reason: "owner_tier_required",
      resolved_root_count: null,
    };
  }
  const availability = describeBlindContextAvailability(cfg.blindContextRoots);
  return {
    files_enabled: availability.enabled,
    files_reason: availability.reason,
    resolved_root_count: availability.resolvedRootCount,
  };
}

function buildListModelsStructuredContent(models: readonly string[], capability: AskFilesCapability): ListModelsStructuredContent {
  return {
    models: models.map((id) => ({ id, description: strengthHint(id) })),
    ask_capabilities: capability,
  };
}

function parseSemverTriplet(raw: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemverTriplets(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let i = 0; i < left.length; i++) {
    if (left[i] === right[i]) continue;
    return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}

function supportsStructuredListModelsContent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return true;
  const match = /\bm5-cli\/([^\s]+)/.exec(userAgent);
  if (!match) return true;
  const version = parseSemverTriplet(match[1]!);
  if (!version) return false;
  return compareSemverTriplets(version, STRUCTURED_LIST_MODELS_MIN_M5_CLIENT_VERSION) >= 0;
}

function renderListModelsText(content: ListModelsStructuredContent): string {
  const lines =
    content.models.length === 0
      ? ["No models are available to this key."]
      : ["Models available to you:", ...content.models.map((model) => `- ${model.id} — ${model.description}`)];
  lines.push(
    "",
    "Current ask.files capability:",
    `files_enabled: ${content.ask_capabilities.files_enabled}`,
    `files_reason: ${content.ask_capabilities.files_reason}`,
    `resolved_root_count: ${content.ask_capabilities.resolved_root_count === null ? "null" : content.ask_capabilities.resolved_root_count}`
  );
  return lines.join("\n");
}

const ADOPTION_REPORT_DESCRIPTION =
  "Record one content-free M5 adoption observation for the private operator dashboard. " +
  "Use this when an eligible task was completed, refused, failed, or could not even attempt M5; " +
  "report missing M5 tool and missing/auth-unavailable credentials distinctly. A full daily telemetry cap is non-fatal and does not affect the inference result; do not retry until the next UTC day. Never include task text, output, paths, repositories, or identifiers.";

type AdoptionReportRejectionReason =
  | "invalid_report"
  | "principal_rate_limited"
  | "daily_capacity_reached"
  | "storage_unavailable";

function rejectAdoptionReport(reason: AdoptionReportRejectionReason): {
  text: string;
  isError: boolean;
  structuredContent: { accepted: false; reason: AdoptionReportRejectionReason };
} {
  // Adoption evidence is optional telemetry, not part of the inference result. A full bounded
  // aggregate must therefore never turn a successful M5 call into a hard MCP failure; callers can
  // inspect `accepted:false` without retrying until the next UTC day.
  const nonFatal = reason === "daily_capacity_reached";
  return {
    text: nonFatal
      ? `Adoption report not recorded (${reason}); M5 inference result is unaffected.`
      : `Adoption report was not accepted (${reason}).`,
    isError: !nonFatal,
    structuredContent: { accepted: false, reason },
  };
}

/**
 * The gateway needs this narrow transport classifier before its finally block emits per-request
 * telemetry. It intentionally recognizes only a parseable `tools/call` envelope by exact name;
 * normal MCP methods and every other tool retain their ordinary access/request logging.
 */
export function isAdoptionEvidenceToolCall(rawBody: string): boolean {
  try {
    const message = JSON.parse(rawBody) as JsonRpcRequest;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.method !== "tools/call") return false;
    const params = message.params;
    return Boolean(
      params &&
      typeof params === "object" &&
      !Array.isArray(params) &&
      (params as { name?: unknown }).name === "record_adoption_evidence"
    );
  } catch {
    return false;
  }
}

/**
 * Static tool catalogue. inputSchemas are fixed; the *visible model set* is conveyed at call
 * time (list_models) and enforced server-side (ask), not by mutating these schemas. The
 * owner-agent code_loop_* tools (#116) are appended only for a real minted owner key carrying
 * agent or admin scope — everyone else never sees them in tools/list.
 */
function toolDefs(principal: McpPrincipal, cfg: HomeserverConfig): McpToolDef[] {
  const filesCapability = askFilesCapability(principal, cfg);
  const base: McpToolDef[] = [
    {
      name: "list_models",
      description:
        "List the local models THIS key is permitted to use, each with a one-line strength hint, " +
        "plus the live call-time ask.files capability state for this request.",
      inputSchema: { type: "object", properties: {}, required: [] },
      outputSchema: LIST_MODELS_OUTPUT_SCHEMA,
    },
    {
      name: "ask",
      description: ASK_DESCRIPTION,
      _meta: { [ASK_FILES_META_KEY]: filesCapability },
      inputSchema: {
        type: "object",
        properties: {
          model: { type: "string", description: "one of the available model ids (see list_models)" },
          prompt: { type: "string", description: "the task / question for the model" },
          system: { type: "string", description: "optional system instruction" },
          max_tokens: { type: "number", description: "optional cap on the completion length" },
          temperature: { type: "number", minimum: 0, maximum: 2, description: "sampling temperature" },
          top_p: { type: "number", minimum: 0, maximum: 1, description: "nucleus sampling probability" },
          top_k: { type: "integer", minimum: 0, description: "top-k cutoff; 0 disables it in llama.cpp" },
          min_p: { type: "number", minimum: 0, maximum: 1, description: "min-p cutoff; 0 disables it" },
          delegator_model_id: {
            type: "string",
            description:
              "optional actual known cloud delegator model id for savings accounting; omit when unknown, never guess",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "OWNER-ONLY: absolute paths on the box, expanded server-side into the prompt as " +
              "local context (allow-listed roots only; see HOMESERVER_BLIND_CONTEXT_ROOTS). A " +
              "guest key supplying this is rejected, never silently ignored.",
          },
        },
        required: ["model", "prompt"],
      },
      outputSchema: ASK_OUTPUT_SCHEMA,
    },
  ];
  if (isAdoptionReporter(principal)) {
    base.push({
      name: "record_adoption_evidence",
      description: ADOPTION_REPORT_DESCRIPTION,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          harness: { type: "string", enum: ["claude", "codex_cli", "codex_app", "pi", "direct_cli", "evaluation_runner"] },
          execution_mode: { type: "string", enum: ["ask", "code_loop", "delegate"] },
          traffic_purpose: { type: "string", enum: ["organic", "evaluation", "synthetic"] },
          result: { type: "string", enum: ["completed", "refused", "failed", "not_attempted"] },
          deterministic_check: { type: "string", enum: ["pass", "fail", "not_run"] },
          reviewer_usefulness: { type: "string", enum: ["pass", "partial", "redo", "wrong", "not_reported"] },
          fallback_reason: { type: "string", enum: ["none", "m5_tool_missing", "m5_auth_unavailable", "m5_unreachable", "m5_busy", "m5_refused", "local_result_unusable", "other_known"] },
          eligible_opportunities: { type: "integer", minimum: 0, maximum: 10_000 },
        },
        required: ["harness", "execution_mode", "traffic_purpose", "result", "deterministic_check", "reviewer_usefulness", "fallback_reason", "eligible_opportunities"],
      },
    });
  }
  if (isCodeLoopOwner(principal)) base.push(...(codeLoopToolDefs() as McpToolDef[]));
  return base;
}

// ─── Model strength hints (substring-matched against the live model ids) ───────────────

/**
 * One-line capability hint per model. Matched on substrings of the model key so it survives
 * minor id/version drift (qwen3-coder-next-80b-mlx etc.) without a hardcoded id list.
 */
function strengthHint(modelKey: string): string {
  const k = modelKey.toLowerCase();
  if (k.includes("vibethinker")) return "verifiable math, code, and STEM reasoning";
  if (k.includes("coder")) return "best for hard agentic coding";
  if (k.includes("mellum")) return "very fast, simple code completions";
  if (k.includes("gemma")) return "general / multimodal-capable";
  if (k.includes("qwen3") || k.includes("a3b")) return "general";
  return "general";
}

/**
 * The model ids this principal may use.
 *   • Scoped key (non-empty allow-list): the allow-list IS the grant and is authoritative —
 *     return it directly. We do NOT gate on what listModels() currently reports as loaded,
 *     so a friend always sees exactly the models their key was issued for (and the matching
 *     `ask` enforcement is purely allow-list based, so the two never disagree).
 *   • Open key (empty allow-list = all): fall back to the live catalogue from listModels().
 */
async function visibleModels(principal: McpPrincipal): Promise<string[]> {
  const allow = principal.modelAllowList;
  if (allow.length > 0) return allow;
  return (await listModels()).map((m) => m.key);
}

// ─── Shared metered chat path (used by BOTH the MCP `ask` tool and, ideally, /v1) ──────

export interface RunChatArgs {
  model: string;
  messages: Array<{ role: string; content: string }>;
  /** Exact caller-authored task before optional blind-context expansion (#257). */
  exposureTaskText?: string;
  maxTokens: number;
  delegatorModelId?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  /**
   * #33: an already-ADMITTED LearningTaskContract Hugin request stamp, when the caller has one —
   * threaded straight through to the ledger write's evidence-identity derivation (lane "mcp-ask"),
   * exactly like `DelegationTask.learningTaskStamp` on the delegate lane. NOT YET reachable from
   * the public MCP `ask` tool (see mcp.ts's `ask` inputSchema / callTool "ask" branch, which have
   * no stamp intake or LearningTaskContract admission of their own): the `ask` tool is a plain
   * metered call with no pre-declared task type and no idempotent-admission surface today, so
   * wiring in real stamp INTAKE (schema field, `validateHuginRequestStamp`, principal binding) is
   * a distinct, larger follow-up — filed separately rather than bolted on here. This field exists
   * so the write-site derivation is in place and directly unit-testable now, the same "ready but
   * dormant until a real caller supplies one" shape the delegate lane had between #28 and #32.
   */
  learningTaskStamp?: HuginRequestStamp;
}

interface AskUsageMetadata {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

export type RunChatResult =
  | {
      ok: true;
      text: string;
      totalTokens: number;
      finishReason: string | null;
      truncated: boolean | null;
      usage: AskUsageMetadata;
    }
  | {
      ok: false;
      code: "credits_exhausted" | "rate_limited" | "server_busy" | "model_not_allowed" | "upstream_error";
      message: string;
      traceOutcome: string;
      traceErrorClass: string;
    };

const ASK_TRUNCATION_FINISH_REASON = "length";

function emptyAskUsageMetadata(): AskUsageMetadata {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

function askTruncatedOfFinishReason(finishReason: string | null): boolean | null {
  return finishReason === null ? null : finishReason === ASK_TRUNCATION_FINISH_REASON;
}

function isAskTokenLimitTruncation(result: Extract<RunChatResult, { ok: true }>): boolean {
  return result.truncated === true && result.finishReason === ASK_TRUNCATION_FINISH_REASON;
}

function askTruncationWarningText(partialText: string): string {
  const prefix = [
    `WARNING: The model response was truncated at the token limit (finish_reason=${ASK_TRUNCATION_FINISH_REASON}).`,
    "This partial response was metered, and any retry is a new billable call.",
    "",
    "Partial response follows:",
  ].join("\n");
  return partialText.length > 0 ? `${prefix}\n\n${partialText}` : prefix;
}

function parseAskUsageMetadata(rawUsage: unknown): AskUsageMetadata {
  if (rawUsage === null || rawUsage === undefined) {
    return emptyAskUsageMetadata();
  }
  if (typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return emptyAskUsageMetadata();
  }
  const usage = rawUsage as {
    prompt_tokens?: unknown;
    input_tokens?: unknown;
    completion_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    reasoning_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    prompt_tokens_details?: {
      cached_tokens?: unknown;
      cache_read_input_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
    };
    completion_tokens_details?: {
      reasoning_tokens?: unknown;
    };
  };
  const promptTokens =
    nonNegativeIntegerOrNull(usage.prompt_tokens) ?? nonNegativeIntegerOrNull(usage.input_tokens);
  const completionTokens =
    nonNegativeIntegerOrNull(usage.completion_tokens) ?? nonNegativeIntegerOrNull(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      nonNegativeIntegerOrNull(usage.total_tokens) ??
      (promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null),
    reasoningTokens:
      nonNegativeIntegerOrNull(usage.reasoning_tokens) ??
      nonNegativeIntegerOrNull(usage.completion_tokens_details?.reasoning_tokens),
    cacheCreationInputTokens:
      nonNegativeIntegerOrNull(usage.cache_creation_input_tokens) ??
      nonNegativeIntegerOrNull(usage.prompt_tokens_details?.cache_creation_input_tokens),
    cacheReadInputTokens:
      nonNegativeIntegerOrNull(usage.cache_read_input_tokens) ??
      nonNegativeIntegerOrNull(usage.prompt_tokens_details?.cache_read_input_tokens) ??
      nonNegativeIntegerOrNull(usage.prompt_tokens_details?.cached_tokens),
  };
}

function toAskStructuredContent(
  model: string,
  result: Extract<RunChatResult, { ok: true }>
): {
  model: string;
  text: string;
  finish_reason: string | null;
  truncated: boolean | null;
  metered: true;
  usage: {
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    reasoning_tokens: number | null;
    cache_creation_input_tokens: number | null;
    cache_read_input_tokens: number | null;
  };
} {
  return {
    model,
    text: result.text,
    finish_reason: result.finishReason,
    truncated: result.truncated,
    metered: true,
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.totalTokens,
      reasoning_tokens: result.usage.reasoningTokens,
      cache_creation_input_tokens: result.usage.cacheCreationInputTokens,
      cache_read_input_tokens: result.usage.cacheReadInputTokens,
    },
  };
}

function badRequestTrace(): McpTraceOverride {
  return { traceOutcome: "bad_request", traceErrorClass: "invalid_request_error" };
}

function genericToolErrorTrace(): McpTraceOverride {
  return { traceOutcome: "error", traceErrorClass: "mcp_tool_error" };
}

/**
 * Run a non-streaming chat completion through the SAME metered spine as
 * /v1/chat/completions — credit reserve → quota → admission → upstream fetch → reconcile —
 * but returning a structured result instead of writing to a ServerResponse. This is the
 * single helper the MCP `ask` tool calls so credit accounting and the model allow-list are
 * enforced identically, with no self-HTTP-call and no logic duplication of the reserve/
 * reconcile invariants (which live in keystore.ts and are reused verbatim here).
 *
 * Billing invariant (mirrors handleChatProxy): a failed / non-2xx upstream call charges
 * NOTHING — reconcile(reserve → 0).
 */
export async function runChatCompletion(
  principal: McpPrincipal,
  cfg: HomeserverConfig,
  controller: AdmissionController,
  inflight: { inc: (alias: string) => void; dec: (alias: string) => void; current: (alias: string) => number },
  args: RunChatArgs
): Promise<RunChatResult> {
  // Wall clock for the whole metered attempt — covers pre-admission rejections too, so every
  // request_log row (success OR failure) carries a real total_ms.
  const attemptStart = Date.now();

  // C3 / M1: canonicalize the user-supplied model into a label SAFE for /metrics + request_log
  // BEFORE any exit path, EXACTLY as the HTTP route does (canonicalizeModelTrusted). A known
  // catalogue id (or allow-list entry) is preserved; an arbitrary/secret string collapses to
  // "unknown" (never the raw value). Used for recordRequest() + recordRequestLog() on every path.
  const canonModel = canonicalizeModelTrusted(args.model, principal.modelAllowList);

  /**
   * M2: a pre-admission `ask` exit (model_not_allowed / credits_exhausted / rate_limited /
   * admission reject) must STILL emit one inference request_log row (route "/mcp/ask") with the
   * failing outcome — mirroring how the HTTP path logs these from its finally block — so a failed
   * ask is never invisible behind the transport's HTTP 200. Best-effort; never throws.
   */
  const logInferenceFailure = (status: number, outcome: string, errorClass: string, admission: string): void => {
    if (cfg.requestLog !== "on") return;
    recordRequestLog({
      requestId: randomUUID(),
      alias: principal.alias,
      tier: principal.tier,
      keyHash: principal.keyHash,
      model: canonModel ?? "none",
      route: MCP_INFERENCE_ROUTE,
      status,
      outcome,
      errorClass,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      queueWaitMs: null,
      ttftMs: null,
      totalMs: Date.now() - attemptStart,
      admission,
    });
  };

  // (1) Model allow-list (empty = all).
  if (principal.modelAllowList.length > 0 && !principal.modelAllowList.includes(args.model)) {
    // Mirror the HTTP path: outcome="forbidden" (lctx.outcome set at gateway.ts ~395/410).
    // recordRequest emits the metric so the rejection appears in homeserver_requests_total.
    recordRequest({
      model: canonModel,
      outcome: "forbidden",
      tier: principal.tier,
      promptTokens: null,
      completionTokens: null,
      durationMs: Date.now() - attemptStart,
      creditsCharged: null,
    });
    logInferenceFailure(403, "forbidden", "model_not_allowed", "n/a");
    return {
      ok: false,
      code: "model_not_allowed",
      message: `Your API key is not permitted to use model '${args.model}'. Allowed: ${principal.modelAllowList.join(", ")}.`,
      traceOutcome: "forbidden",
      traceErrorClass: "model_not_allowed",
    };
  }

  // Estimate cost: prompt chars/4 + the (capped) completion reservation.
  const promptChars = args.messages.reduce((s, m) => s + m.content.length, 0);
  const estTokens = Math.ceil(promptChars / 4) + args.maxTokens;

  // (2) Lifetime credit cap — atomic conditional reserve (same helper as the spine).
  let creditReserved = false;
  if (principal.keyHash !== null && principal.creditLimit > 0) {
    if (!reserveCredits(principal.keyHash, estTokens).ok) {
      // Mirror the HTTP path exactly: status=402, outcome="credits_exhausted"
      // (gateway.ts ~371-373). The HTTP path does NOT call recordRateLimited here — it relies
      // solely on recordRequest via the finally block. We emit both to match the intent: the
      // metric surfaces as a named outcome in homeserver_requests_total.
      recordRequest({
        model: canonModel,
        outcome: "credits_exhausted",
        tier: principal.tier,
        promptTokens: null,
        completionTokens: null,
        durationMs: Date.now() - attemptStart,
        creditsCharged: null,
      });
      logInferenceFailure(402, "credits_exhausted", "credits_exhausted", "n/a");
      return {
        ok: false,
        code: "credits_exhausted",
        message: "Your credit budget is exhausted. Contact the operator for more credits.",
        traceOutcome: "credits_exhausted",
        traceErrorClass: "credits_exhausted",
      };
    }
    creditReserved = true;
  }
  const releaseReserve = (): void => {
    if (creditReserved) {
      reconcileCredits(principal.keyHash!, estTokens, 0);
      creditReserved = false;
    }
  };

  // (3) Quota (RPM / TPM / daily). On success this returns a reservation handle (M1) so
  // recordUsage() reconciles the exact admitted event + daily delta — correct under concurrency.
  const q = checkQuota(principal.alias, principal.limits, estTokens);
  if (!q.ok) {
    releaseReserve();
    recordRateLimited("quota");
    logInferenceFailure(429, "rate_limited", "rate_limit_exceeded", "n/a");
    return {
      ok: false,
      code: "rate_limited",
      message: `Rate limit reached. Retry after ${q.retryAfterSeconds}s.`,
      traceOutcome: "rate_limited",
      traceErrorClass: "rate_limit_exceeded",
    };
  }
  const reservation: QuotaReservation = q.reservation;

  // (4) Admission (owner preempts guest on the serial GPU).
  let release: () => void;
  try {
    release = await controller.acquire({
      lane: principal.tier as Lane,
      requestedModel: args.model,
      keyMaxParallel: principal.maxParallel,
      keyInflight: inflight.current(principal.alias),
      keyId: principal.alias,
    });
  } catch (err) {
    releaseReserve();
    // M1: roll back the daily reservation the quota check already debited — this request never
    // ran, so it must not consume the caller's daily budget.
    recordUsage(principal.alias, 0, Date.now(), reservation);
    if (err instanceof AdmissionRejected) {
      // Mirror the HTTP path: an admission reject (503 busy) increments the per-lane rejection
      // counter and logs a content-blind "/mcp/ask" busy row.
      recordAdmissionRejection(principal.tier);
      logInferenceFailure(503, "busy", "server_busy", "busy");
      return {
        ok: false,
        code: "server_busy",
        message: `The server is busy. Retry after ${err.retryAfterSeconds}s.`,
        traceOutcome: "busy",
        traceErrorClass: "server_busy",
      };
    }
    throw err;
  }

  // OWNER-ONLY full request log. Strictly owner-tier AND a real minted key (keyHash !== null) —
  // EXCLUDES implicit-admin / legacy static admins, and NEVER logs guests. See owner-log.ts.
  // Owner-own content gate: the owner's minted-key traffic only (NOT guests, NOT legacy/implicit
  // admin). Reused for the owner-log AND the usage-telemetry delegation write below.
  const isOwnerContent = principal.tier === "owner" && principal.keyHash !== null;
  // Unlike the raw owner log, the content-blind exposure digest covers every owner-tier MCP
  // ingress. Otherwise a legacy/implicit owner call could later be misclassified as a fresh exam.
  const isOwnerExposure = principal.tier === "owner";
  const ownerLog = cfg.ownerRequestLog === "on" && isOwnerContent;
  const callStart = Date.now();

  if (isOwnerExposure) {
    recordMessageTaskExposuresBestEffort({
      messages: args.exposureTaskText !== undefined
        ? [{ role: "user", content: args.exposureTaskText }]
        : args.messages,
      lane: "mcp-ask",
      modelId: canonModel,
      harnessId: "mcp-ask",
    });
  }

  inflight.inc(principal.alias);
  // Content-blind concurrency gauge: increment on admission acquire, decrement on release (finally).
  inflightInc(principal.tier);
  // C2 (HIGH): actualTokens stays 0 until the call RESOLVES with a 2xx. If the upstream throws
  // (timeout / connection reset) the finally reconciles credits + the quota estimate to ZERO —
  // a failed request is never billed.
  let actualTokens = 0;
  // M2: carries the classified upstream failure kind so the finally / request_log row records
  // the distinct outcome + status label (upstream_unavailable → 502 / upstream_timeout → 504)
  // instead of collapsing both into the generic "error"/502. Mirrors the HTTP path's lctx.
  let upstreamFailureKind: "upstream_unavailable" | "upstream_timeout" | null = null;
  // M3: metrics breakdown, populated only on a successful completion (finally records it).
  let metricPrompt: number | null = null;
  let metricCompletion: number | null = null;
  try {
    const upstream = await fetch(`${cfg.lmStudioBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...currentTraceHeaders() },
      // #8: a single completion only — the MCP path never forwards an `n` parameter, so it cannot
      // be abused for GPU amplification / credit under-reservation.
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        max_tokens: args.maxTokens,
        ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
        ...(args.topP !== undefined ? { top_p: args.topP } : {}),
        ...(args.topK !== undefined ? { top_k: args.topK } : {}),
        ...(args.minP !== undefined ? { min_p: args.minP } : {}),
      }),
      signal: AbortSignal.timeout(cfg.callTimeoutMs),
    });
    const text = await upstream.text();

    if (upstream.status >= 400) {
      // No successful completion ⇒ no credit charge (actualTokens stays 0).
      if (upstream.status === 404 || /model.*not.*found/i.test(text)) {
        return {
          ok: false,
          code: "upstream_error",
          message: `The model '${args.model}' does not exist or is not loaded.`,
          traceOutcome: "bad_request",
          traceErrorClass: "invalid_request_error",
        };
      }
      return {
        ok: false,
        code: "upstream_error",
        message: `Upstream model error (HTTP ${upstream.status}).`,
        traceOutcome: "error",
        traceErrorClass: "upstream_error",
      };
    }

    let content = "";
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let usageMetadata = emptyAskUsageMetadata();
    let finishReason: string | null = null;
    let truncated: boolean | null = null;
    try {
      const json = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
        usage?: unknown;
      };
      content = json.choices?.[0]?.message?.content ?? "";
      usageMetadata = parseAskUsageMetadata(json.usage);
      promptTokens = usageMetadata.promptTokens;
      completionTokens = usageMetadata.completionTokens;
      finishReason = typeof json.choices?.[0]?.finish_reason === "string" ? json.choices[0].finish_reason : null;
      truncated = askTruncatedOfFinishReason(finishReason);
      actualTokens =
        usageMetadata.totalTokens ??
        (promptTokens !== null && completionTokens !== null
          ? promptTokens + completionTokens
          : Math.ceil(promptChars / 4));
    } catch {
      // 2xx non-JSON: surface the raw body, charge only the prompt estimate.
      content = text;
      actualTokens = Math.ceil(promptChars / 4);
    }
    metricPrompt = promptTokens;
    metricCompletion = completionTokens;
    // C3 / M1: the model label is canonModel (computed once at the top via canonicalizeModelTrusted,
    // EXACTLY as the HTTP path does) — a trusted catalogue/allow-list id or "unknown"/"none", never a
    // raw user string. No second per-path canonicalization here.
    if (ownerLog) {
      const latencyMs = Date.now() - callStart;
      const tokPerSec =
        completionTokens !== null && latencyMs > 0 ? completionTokens / (latencyMs / 1000) : null;
      recordOwnerRequest({
        alias: principal.alias,
        model: args.model,
        route: "mcp",
        messagesJson: JSON.stringify(args.messages),
        completion: content,
        promptTokens,
        completionTokens,
        latencyMs,
        tokPerSec,
        outcome: "ok",
      });
    }
    return {
      ok: true,
      text: content,
      totalTokens: actualTokens,
      finishReason,
      truncated,
      usage: usageMetadata,
    };
  } catch (err) {
    // R6 (graceful degradation): the upstream fetch threw — connection refused/reset (backend
    // down) or the AbortSignal timeout fired (slow / cold-loading backend). Map it to a structured
    // upstream_error tool result instead of letting it propagate to the gateway's top-level 500.
    // actualTokens is still 0, so the finally below reconciles credits + quota to ZERO (C2 — a
    // failed call is never billed) and records the failure row (status 502, errorClass
    // upstream_error). A non-upstream error is NOT masked: re-throw so a real logic bug surfaces.
    const kind = classifyUpstreamError(err);
    if (kind === "upstream_timeout") {
      // M2: set the failure kind so the finally / request_log row records the distinct 504 label.
      upstreamFailureKind = "upstream_timeout";
      return {
        ok: false,
        code: "upstream_error",
        message: "The model backend timed out (it may be loading a model) — please retry in a few seconds.",
        traceOutcome: "upstream_timeout",
        traceErrorClass: "upstream_timeout",
      };
    }
    if (kind === "upstream_unavailable") {
      // M2: set the failure kind so the finally / request_log row records the distinct 502 label.
      upstreamFailureKind = "upstream_unavailable";
      return {
        ok: false,
        code: "upstream_error",
        message: "The model backend is unavailable — please retry shortly.",
        traceOutcome: "upstream_unavailable",
        traceErrorClass: "upstream_unavailable",
      };
    }
    throw err;
  } finally {
    release();
    inflight.dec(principal.alias);
    inflightDec(principal.tier);
    // M1: reconcile the exact admitted quota event + daily delta via the reservation handle.
    recordUsage(principal.alias, actualTokens, Date.now(), reservation);
    let creditsCharged = 0;
    if (principal.keyHash !== null) {
      if (creditReserved) reconcileCredits(principal.keyHash, estTokens, actualTokens);
      else recordCreditUsage(principal.keyHash, actualTokens);
      creditsCharged = actualTokens;
    }
    const totalMs = Date.now() - callStart;
    const ok = actualTokens > 0;
    // M2: map the classified upstream failure kind to distinct outcome/status labels so the
    // request_log row mirrors the HTTP path (upstream_unavailable→502, upstream_timeout→504)
    // rather than collapsing both into the generic "error"/502.
    const failOutcome = upstreamFailureKind ?? "error";
    const failStatus = upstreamFailureKind === "upstream_timeout" ? 504 : 502;
    // M3: feed the MCP call into the SAME Prometheus counters as /v1/chat/completions so token +
    // credit totals increment for MCP traffic too. C3/M1: canonModel is the canonicalized label.
    recordRequest({
      model: canonModel,
      outcome: ok ? "ok" : failOutcome,
      tier: principal.tier,
      promptTokens: metricPrompt,
      completionTokens: metricCompletion,
      durationMs: totalMs,
      creditsCharged,
    });
    // Durable CONTENT-BLIND request_log row for the MCP `ask` INFERENCE surface (best-effort; never
    // throws). M3: route is "/mcp/ask" — the DISTINCT inference label, so this row never conflates
    // with the outer "/mcp" transport row the gateway writes. Mirrors the HTTP path so the owner's
    // fleet queries cover MCP traffic too. ttft_ms is null — the `ask` tool is non-streaming. No
    // content is ever written here.
    if (cfg.requestLog === "on") {
      recordRequestLog({
        requestId: randomUUID(),
        alias: principal.alias,
        tier: principal.tier,
        keyHash: principal.keyHash,
        model: canonModel ?? "none",
        route: MCP_INFERENCE_ROUTE,
        status: ok ? 200 : failStatus,
        outcome: ok ? "ok" : failOutcome,
        errorClass: ok ? null : (upstreamFailureKind ?? "upstream_error"),
        promptTokens: metricPrompt,
        completionTokens: metricCompletion,
        totalTokens: ok ? actualTokens : null,
        queueWaitMs: null,
        ttftMs: null,
        totalMs,
        admission: "admitted",
      });
    }

    // Owner usage telemetry → capability ledger (RQ6/RQ7 dataset). Record the owner's own ask as a
    // task-typed delegation so the real Claude→local offload channel self-measures by task type.
    // SCOPE: ADMITTED owner asks only — this lives in the post-admission finally, so pre-admission
    // rejections (model_not_allowed / credits_exhausted / rate_limited / busy) are deliberately NOT
    // recorded as delegations: they never ran inference, and counting non-runs would skew the usage
    // distribution. Those rejections are still captured content-blind in request_log. Owner-tier +
    // minted-key ONLY (mirrors owner-log) — guest content is never excerpted. Usage-only: outcome
    // "unverified" (no verifier on the ask path) / "error"+infra on upstream failure → these rows
    // never feed capability VERDICT math. Best-effort; never breaks a request.
    if (isOwnerContent) {
      try {
        const askPrompt =
          args.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n") ||
          args.messages.map((m) => m.content).join("\n");
        const taskType = classifyTask(askPrompt).taskType;
        // #202: MCP `ask` is the primary real Claude→M5 offload path, but unlike /delegate it
        // historically never evaluated delegate policy. Evaluate the exact same evidence rule in
        // forced SHADOW mode and persist the decision only in the content-blind cost trace below.
        // This is deliberately annotation-only even if a future global policy is `enforce`: the MCP
        // caller already selected a local model, so changing this response path would be a material
        // routing behavior change rather than the requested evidence collection.
        const delegatePolicy = evaluateDelegatePolicy({
          taskType,
          modelId: args.model,
          verifierName: null,
          hasVerifier: false,
          source: "mcp-ask",
          explicitModelOverride: true,
          policy: cfg.policy,
          delegatePolicy: { ...cfg.delegatePolicy, mode: "shadow" },
        });
        const tokPerSec =
          ok && metricCompletion !== null && totalMs > 0 ? metricCompletion / (totalMs / 1000) : null;
        // #33: reuse PR #32's exact derivation (orchestrator.ts's deriveEvidenceIdentity), tagged
        // with THIS lane's own identity ("mcp-ask") so an mcp-ask row can never be mistaken for (or
        // copy) a delegate/delegate-shadow/code-loop row's config identity. `args.learningTaskStamp`
        // is `undefined` for every real caller today (see the RunChatArgs field doc) — landing the
        // same null/legacy identity unstamped callers have always landed, never a fabricated one.
        const evidenceIdentity = await deriveEvidenceIdentity(args.learningTaskStamp, args.model, "mcp-ask");
        const ledgerId = recordDelegation({
          taskType,
          modelId: args.model,
          prompt: askPrompt,
          outcome: ok ? "unverified" : "error",
          errorClass: ok ? null : "infra",
          latencyMs: totalMs,
          ttftMs: null,
          promptTokens: metricPrompt,
          completionTokens: metricCompletion,
          tokPerSec,
          source: "mcp-ask",
          keyAlias: principal.alias,
          evidenceIdentity,
        });
        if (cfg.delegationCostLog === "on") {
          tryRecordDelegationCost(
            buildDelegationCostTrace({
              taskType,
              localModelId: args.model,
              delegated: true,
              escalated: false,
              outcome: ok ? "unverified" : "error",
              metrics:
                metricPrompt !== null && metricCompletion !== null
                  ? { promptTokens: metricPrompt, completionTokens: metricCompletion }
                  : null,
              ledgerId,
              keyAlias: principal.alias,
              source: "mcp-ask",
              // #83: keep caller-stamped and configured-default separate (see the matching
              // orchestrator.ts attachCostTrace comment) so the cost row records provenance
              // instead of merging them before buildDelegationCostTrace ever sees them.
              delegatorModelId: args.delegatorModelId ?? null,
              defaultDelegatorModelId: cfg.defaultDelegatorModelId,
              premiumBaselineModelId: cfg.premiumBaselineModelId,
              m5MarginalUsdPerMTok: cfg.m5MarginalUsdPerMTok,
              m5AmortizedUsdPerMTok: cfg.m5AmortizedUsdPerMTok,
              delegatePolicyMode: delegatePolicy?.mode,
              delegatePolicyAction: delegatePolicy?.action,
            })
          );
        }
      } catch (err) {
        // Never let a telemetry write break the request.
        console.error("[mcp-ask] delegation ledger write failed (ignored):", err);
      }
    }
  }
}

// ─── tools/call dispatch ───────────────────────────────────────────────────────────────

interface ToolCallContext {
  principal: McpPrincipal;
  cfg: HomeserverConfig;
  controller: AdmissionController;
  gatewayRequestId: string;
  userAgent: string | null;
  learningTaskCapabilityEpoch: LearningTaskCapabilityEpoch;
  inflight: { inc: (alias: string) => void; dec: (alias: string) => void; current: (alias: string) => number };
}

/** A tools/call result: a text content block + isError flag. Never throws for a tool error. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext
): Promise<{ text: string; isError: boolean; structuredContent?: unknown; trace?: McpTraceOverride }> {
  if (name === "list_models") {
    const models = await visibleModels(ctx.principal);
    const structuredContent = buildListModelsStructuredContent(
      models,
      askFilesCapability(ctx.principal, ctx.cfg)
    );
    return {
      text: renderListModelsText(structuredContent),
      isError: false,
      ...(supportsStructuredListModelsContent(ctx.userAgent) ? { structuredContent } : {}),
    };
  }

  if (name === "record_adoption_evidence" && isAdoptionReporter(ctx.principal)) {
    // Reserve the transient slot before parsing. Invalid/content-bearing reports are deliberately
    // correlation-log-suppressed too, so they must not become an invisible unbounded flood.
    if (!allowAdoptionEvidenceReportForPrincipal(ctx.principal.keyHash!)) {
      return rejectAdoptionReport("principal_rate_limited");
    }
    const parsed = parseAdoptionEvidence(args);
    if (!parsed.ok) {
      return rejectAdoptionReport("invalid_report");
    }
    try {
      if (!recordAdoptionEvidence(parsed.value)) {
        return rejectAdoptionReport("daily_capacity_reached");
      }
    } catch {
      // Do not expose a database path, rate state, or driver diagnostic in the tool response.
      return rejectAdoptionReport("storage_unavailable");
    }
    return { text: "Accepted.", isError: false, structuredContent: { accepted: true } };
  }

  if (name === "ask") {
    const model = typeof args["model"] === "string" ? (args["model"] as string) : "";
    const prompt = typeof args["prompt"] === "string" ? (args["prompt"] as string) : "";
    const system = typeof args["system"] === "string" ? (args["system"] as string) : undefined;
    const rawDelegatorModelId = args["delegator_model_id"] ?? args["delegatorModelId"];
    if (
      rawDelegatorModelId !== undefined &&
      (typeof rawDelegatorModelId !== "string" || rawDelegatorModelId.trim() === "")
    ) {
      return {
        text: "'delegator_model_id' must be a non-empty string when supplied.",
        isError: true,
        trace: badRequestTrace(),
      };
    }
    const delegatorModelId = typeof rawDelegatorModelId === "string" ? rawDelegatorModelId : undefined;
    if (model === "" || prompt === "") {
      return { text: "Both 'model' and 'prompt' are required.", isError: true, trace: badRequestTrace() };
    }
    const samplerSpecs = [
      ["temperature", 0, 2, false],
      ["top_p", 0, 1, false],
      ["top_k", 0, Number.MAX_SAFE_INTEGER, true],
      ["min_p", 0, 1, false],
    ] as const;
    for (const [field, min, max, integer] of samplerSpecs) {
      const value = args[field];
      if (value === undefined) continue;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < min ||
        value > max ||
        (integer && !Number.isInteger(value))
      ) {
        return {
          text: `'${field}' must be ${integer ? "an integer" : "a number"} in [${min}, ${max}].`,
          isError: true,
          trace: badRequestTrace(),
        };
      }
    }

    // #128 (blind-context delegation): `files` is OWNER-TIER ONLY, enforced HERE — the earliest
    // point in the request that has BOTH the resolved principal tier (ctx.principal, set by the
    // gateway's resolvePrincipal before the /mcp dispatch) AND the tool-specific `files` argument
    // (only visible once we're inside the `ask` branch of tools/call — the outer JSON-RPC dispatch
    // never inspects per-tool params). A guest key carrying `files` is NEVER silently ignored: it
    // is rejected before any credit reservation / quota / admission work runs, using the same
    // OpenAI-shaped error vocabulary (errors.ts) as the rest of the gateway.
    let files: string[] | undefined;
    if (args["files"] !== undefined) {
      const raw = args["files"];
      // `raw.length > 0` matters: `[].every(...)` is vacuously true, so without it an empty
      // array would slip through as a SILENT no-op — for a guest that would contradict the
      // "supplying `files` is never silently ignored" contract this error message states.
      if (!Array.isArray(raw) || raw.length === 0 || !raw.every((f) => typeof f === "string" && f.length > 0)) {
        return {
          text: "'files' must be a non-empty array of absolute path strings.",
          isError: true,
          trace: badRequestTrace(),
        };
      }
      files = raw as string[];
    }
    if (files !== undefined && files.length > 0 && !isAskFilesOwner(ctx.principal)) {
      const env = makeError("route_not_allowed", {
        message: "File attachments ('files') require an owner-tier API key. This key is 'guest'.",
      });
      return {
        text: env.body.error.message,
        isError: true,
        trace: { traceOutcome: "forbidden", traceErrorClass: "route_not_allowed" },
      };
    }

    // Cap max_tokens at the per-request ceiling (floor at 1).
    const requested = typeof args["max_tokens"] === "number" ? (args["max_tokens"] as number) : null;
    const maxTokens = clampMaxTokensForModel(ctx.cfg, model, requested);

    let promptWithContext = prompt;
    if (files !== undefined && files.length > 0) {
      const blindCfg: BlindContextConfig = {
        roots: ctx.cfg.blindContextRoots,
        maxFileBytes: ctx.cfg.blindContextMaxFileBytes,
        maxTotalBytes: ctx.cfg.blindContextMaxTotalBytes,
      };
      const expansion = expandBlindContext(files, blindCfg);
      if (!expansion.ok) {
        return { text: expansion.error.message, isError: true, trace: badRequestTrace() };
      }
      promptWithContext = `${expansion.text}\n\n${prompt}`;
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (system !== undefined && system !== "") messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: promptWithContext });

    const r = await runChatCompletion(ctx.principal, ctx.cfg, ctx.controller, ctx.inflight, {
      model,
      messages,
      exposureTaskText: prompt,
      maxTokens,
      delegatorModelId,
      temperature: args["temperature"] as number | undefined,
      topP: args["top_p"] as number | undefined,
      topK: args["top_k"] as number | undefined,
      minP: args["min_p"] as number | undefined,
    });
    if (r.ok) {
      const structuredContent = toAskStructuredContent(model, r);
      if (isAskTokenLimitTruncation(r)) {
        return {
          text: askTruncationWarningText(r.text),
          isError: true,
          structuredContent,
        };
      }
      return { text: r.text, isError: false, structuredContent };
    }
    return {
      text: r.message,
      isError: true,
      trace: { traceOutcome: r.traceOutcome, traceErrorClass: r.traceErrorClass },
    };
  }

  // Owner-only code_loop_* tools (#116). The gate is re-checked here (not just at tools/list): a
  // NON-owner calling one falls THROUGH to the byte-identical unknown-tool error below — the tool
  // is invisible, never "forbidden" (which would leak its existence). Maintenance mode is read
  // from the live admission snapshot so an explicit evaluation window refuses a start.
  if (isCodeLoopToolName(name) && isCodeLoopOwner(ctx.principal)) {
    const out = await handleCodeLoopTool(
      name,
      args,
      ctx.cfg,
      () => ctx.controller.snapshot().maintenanceMode === true,
      {
        authenticatedPrincipalId: ctx.principal.alias,
        authentication: "gateway-owner-auth",
        gatewayRequestId: ctx.gatewayRequestId,
        capabilityEpoch: ctx.learningTaskCapabilityEpoch,
      },
    );
    return { ...out, structuredContent: JSON.parse(out.text) };
  }

  return { text: `Unknown tool '${name}'.`, isError: true, trace: badRequestTrace() };
}

// ─── HTTP dispatch (one JSON-RPC message per POST body) ────────────────────────────────

/**
 * Handle a single POST /mcp body. The caller (gateway) has ALREADY authenticated the
 * principal (reusing resolvePrincipal) and read the raw body. We parse one JSON-RPC message,
 * dispatch it, and write the appropriate HTTP response:
 *   • requests (have id)      → 200 application/json with the result/error envelope
 *   • notifications (no id)   → 202 Accepted, empty body
 *   • parse / shape errors    → 200 with a JSON-RPC error object (no id known → null)
 *
 * Always resolves; never throws to the gateway's top-level handler.
 */
export async function handleMcpPost(rawBody: string, res: ServerResponse, ctx: ToolCallContext): Promise<McpPostResult> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(rawBody) as JsonRpcRequest;
  } catch {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcError(null, PARSE_ERROR, "Parse error"));
    return { trace: badRequestTrace() };
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcError(null, INVALID_REQUEST, "Invalid Request"));
    return { trace: badRequestTrace() };
  }

  const method = msg.method;
  const isNotification = msg.id === undefined || msg.id === null;
  const id = (msg.id ?? null) as string | number | null;

  // Notifications carry no id and expect no JSON-RPC body — just 202 Accepted.
  if (isNotification) {
    if (method === "notifications/initialized") {
      res.writeHead(202);
      res.end();
      return {};
    }
    // This server implements only the initialization notification. Preserve the no-body wire
    // response for every other notification, but classify the unsupported method as client input
    // so a 202 transport response cannot look healthy in content-blind telemetry.
    res.writeHead(202);
    res.end();
    return { trace: badRequestTrace() };
  }

  if (method === "initialize") {
    res.writeHead(200, { "content-type": "application/json", "Mcp-Session-Id": randomUUID() });
    res.end(
      rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "m5-local-models", version: "1.0.0" },
        ...(isCodeLoopOwner(ctx.principal) ? { instructions: CODE_LOOP_OWNER_INSTRUCTIONS } : {}),
      })
    );
    return {};
  }

  if (method === "ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcResult(id, {}));
    return {};
  }

  if (method === "tools/list") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcResult(id, { tools: toolDefs(ctx.principal, ctx.cfg) }));
    return {};
  }

  if (method === "tools/call") {
    const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof params.name === "string" ? params.name : "";
    const toolArgs = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const out = await callTool(name, toolArgs, ctx);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(rpcResult(id, { content: [{ type: "text", text: out.text }], isError: out.isError, ...(out.structuredContent === undefined ? {} : { structuredContent: out.structuredContent }) }));
    const trace = out.trace ?? (out.isError ? genericToolErrorTrace() : undefined);
    return trace === undefined ? {} : { trace };
  }

  // Unknown method.
  res.writeHead(200, { "content-type": "application/json" });
  res.end(rpcError(id, METHOD_NOT_FOUND, "Method not found"));
  return { trace: badRequestTrace() };
}
