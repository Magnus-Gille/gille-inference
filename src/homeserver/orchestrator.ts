import { loadConfig } from "./config.js";
import { classifyTask, taskTypeEmitsJson } from "./taxonomy.js";
import { shouldDelegate, recordDelegation, type Outcome, type ErrorClass } from "./ledger.js";
import type { Verifier } from "./verifier.js";
import { getLoaded, getRunningCmd } from "./model-admin.js";
import { routingTarget, FRONTIER, UNKNOWN_ROUTE } from "./routing-table.js";
import { gateEligible, gateDecision, type GateConfig } from "./disagreement-gate.js";
import { runLmStudioInference } from "../runner/lmstudio-client.js";
import { orinAllowsTask, runOrinInference, type ComputeNodeId } from "./nodes.js";
import type { LocalInferenceResult } from "../runner/local-client.js";
import { runInference, type ResponseFormat } from "../runner/openrouter-client.js";
import { randomUUID } from "node:crypto";
import { defaultLogger } from "./access-log.js";
import {
  buildDelegationCostTrace,
  tryRecordDelegationCost,
  type DelegationCostTrace,
} from "./delegation-cost.js";
import {
  evaluateDelegatePolicy,
  type DelegatePolicyDecision,
} from "./delegate-policy.js";
import { resolveLocalSampling } from "./sampling-profile.js";
import {
  scheduleShadowEvaluation,
  type ShadowInference,
  type ShadowLedgerRow,
} from "./shadow-lane.js";
import type { HomeserverConfig } from "./config.js";
import { recordTaskExposureBestEffort } from "./task-exposure.js";
import type { HuginRequestStamp } from "./learning-task-contract.js";
import {
  buildEvidenceIdentityBundle,
  evidenceIdentityFromAdmittedStamp,
  evidenceIdentityFromServedModelCmd,
  unknownIdentity,
  type EvidenceIdentityBundle,
  type EvidenceLane,
} from "./evidence-identity.js";

/**
 * The orchestrator: the decision point where a frontier brain (Opus) hands a task down
 * to the local model — or decides not to.
 *
 *   classify → consult ledger (shouldDelegate) → call local → verify → record → escalate?
 *
 * The "smart" model never appears in this file: this is the *substrate* that a frontier
 * orchestrator drives. It calls the local model, grades the result against a verifier,
 * writes the outcome to the ledger so the system learns, and tells the caller whether to
 * escalate (route to a frontier model) when the local attempt is unusable.
 */

export interface DelegationTask {
  prompt: string;
  /** Override classification; otherwise inferred from the prompt. */
  taskType?: string;
  systemPrompt?: string;
  maxTokens?: number;
  /**
   * Sampling temperature for the local call. Defaults to 0 (deterministic) — correct for the
   * verifiable sub-tasks the ledger is built on. Reasoning-specialist models that recommend
   * stochastic decoding (e.g. VibeThinker at ~0.6–1.0) can set this per-task so the probe
   * measures the model as its authors intend rather than under a degrading temp=0.
   */
  temperature?: number;
  /** Nucleus sampling override for the local call. */
  topP?: number;
  /** Top-k override; llama.cpp uses 0 to disable the cutoff. */
  topK?: number;
  /** Min-p override; llama.cpp uses 0 to disable the filter. */
  minP?: number;
  /** How to grade the local output. Omit for passthrough (recorded "unverified"). */
  verifier?: Verifier;
  /** Label stored in the ledger's verifier column. */
  verifierName?: string;
  /** Force a specific model id; otherwise the currently-loaded model is used. */
  modelId?: string;
  /** Explicit macro-routing decision from Hugin; this gateway never auto-selects Orin. */
  nodeId?: ComputeNodeId;
  /**
   * Explicit structured-output response_format forwarded to the local call. When omitted, JSON-shaped
   * task types (taxonomy `jsonOutput`) default to `{ type: "json_object" }` — see resolveResponseFormat
   * / config.autoJsonResponseFormat. Grammar-constrains decoding → prevents the gpt-oss-120b harmony/PEG
   * 500 on strict-JSON prompts (#166). An explicit value (e.g. a full json_schema) always wins.
   */
  responseFormat?: ResponseFormat;
  /** Provenance: 'probe' | 'gateway' | 'build-chunk' | 'cli'. */
  source?: string;
  /** Authenticated gateway/MCP key alias when the caller has one. */
  keyAlias?: string | null;
  /**
   * Authoritative canonical logical-task fingerprint (#4), taken directly from an admitted
   * LearningTaskContract Hugin request stamp's `raw_fingerprint.digest` — the pre-context/system-
   * wrapping identity, distinct from `prompt` (the rendered text actually sent to the model).
   * Absent for every unstamped caller; those lanes continue to record rendered-prompt identity only.
   */
  canonicalTaskFingerprintSha256?: string | null;
  /**
   * #5: the SAME admitted LearningTaskContract Hugin request stamp `canonicalTaskFingerprintSha256`
   * is drawn from — carried through in full so the delegate lane can bind ledger evidence to its
   * mechanically-verified prompt/harness/tool-policy/taxonomy identity (see evidence-identity.ts's
   * `evidenceIdentityFromAdmittedStamp`), joined with the served-model artifact/config epoch this
   * lane actually used. Absent for every unstamped/legacy caller, exactly like the fingerprint above
   * — those callers continue to record a null (legacy) evidence identity, never a fabricated one.
   */
  learningTaskStamp?: HuginRequestStamp;
  /**
   * The cloud "smart" model that delegated this task. Used only for cost accounting; callers should
   * pass the real delegator model id so savings can be measured against actual spend avoided.
   */
  delegatorModelId?: string;
  /** Fixed high-end baseline override for savings accounting. Defaults from config. */
  premiumBaselineModelId?: string;
  /**
   * OpenRouter model ID to call when local escalates (e.g. "anthropic/claude-sonnet-4-6").
   * When omitted, escalation just sets the flag — the caller handles it.
   */
  frontierModelId?: string;
  /** Token budget for the frontier fallback call (defaults to maxTokens ?? 4096). */
  frontierMaxTokens?: number;
}

export interface DelegationMetrics {
  latencyMs: number;
  ttftMs: number;
  promptTokens: number;
  completionTokens: number;
  tokPerSec: number;
}

export interface DelegationOutcome {
  /** Did we actually call the local model? (false when policy said escalate.) */
  delegated: boolean;
  /** True when local failed or policy blocked — check frontierOutput for the fallback result. */
  escalate: boolean;
  taskType: string;
  nodeId: ComputeNodeId;
  modelId: string;
  decisionReason: string;
  outcome?: Outcome;
  score?: number | null;
  output?: string;
  metrics?: DelegationMetrics;
  verifierNotes?: string;
  ledgerId?: string;
  /** Frontier fallback output, set when frontierModelId was given and the call succeeded. */
  frontierOutput?: string;
  /** The OpenRouter model that handled the frontier fallback. */
  frontierModelId?: string;
  /** Error from the frontier fallback call, if it also failed. */
  frontierError?: string;
  /**
   * True when the local call was retried once after a transient harmony/PEG format-500 (#164).
   * Set on both the recovered path (retry succeeded) and the twice-failed path (retry also failed);
   * makes the retry observable to callers without parsing notes.
   */
  formatRetried?: boolean;
  /**
   * Set when the cross-model disagreement gate ran (unverified path, gate ≠ off). `wouldEscalate`
   * is the gate's verdict; in "shadow" mode it is recorded but does NOT drive `escalate`.
   */
  gate?: {
    mode: "shadow" | "on";
    model: string;
    score: number;
    wouldEscalate: boolean;
    latencyMs?: number;
    secondaryError?: string;
  };
  /** Content-blind per-task savings estimate. Verified savings is zero unless outcome === "pass". */
  costTrace?: DelegationCostTrace;
  /** Content-blind production delegation gate result, present when HOMESERVER_DELEGATE_POLICY != off. */
  delegatePolicy?: DelegatePolicyDecision;
}

const TIMEOUT_SENTINEL = "__hs_timeout__";

/** delegate() calls currently in flight. Shadow work is admitted only when this reaches zero. */
let activeDelegations = 0;

/**
 * Schedule candidate evidence after a no-local-attempt escalation. This deliberately owns no
 * caller-visible state: scheduling is synchronous, execution is fire-and-forget, and every failure
 * is folded into shadow telemetry/ledger state by shadow-lane.ts.
 */
function maybeScheduleEscalationShadow(
  task: DelegationTask,
  outcome: DelegationOutcome,
  cfg: HomeserverConfig
): void {
  // The configured candidate is an M5/llama-swap model. An Orin rejection must not silently run on
  // a different node and then be recorded as Orin evidence.
  if (outcome.nodeId !== "m5") return;

  const inheritedMaxTokens = task.maxTokens ?? cfg.defaultMaxTokens;
  const effectiveMaxTokens =
    cfg.shadowLane.maxTokens > 0
      ? Math.min(inheritedMaxTokens, cfg.shadowLane.maxTokens)
      : inheritedMaxTokens;
  const shadowConfig = { ...cfg.shadowLane, maxTokens: effectiveMaxTokens };

  // #5: the shadow candidate is a DIFFERENT model (often a different served config epoch entirely)
  // from whatever the primary lane would have used — resolved once here, alongside the model id, so
  // `record` below can bind the shadow row's evidence identity to ITS OWN served-model observation,
  // never the primary lane's. Undefined until resolveModelId has run.
  let shadowServedFields: Pick<EvidenceIdentityBundle, "modelArtifact" | "configEpoch"> | undefined;

  scheduleShadowEvaluation(
    {
      taskType: outcome.taskType,
      nodeId: "m5",
      prompt: task.prompt,
      systemPrompt: task.systemPrompt,
      verifier: task.verifier,
      verifierName: task.verifierName,
      delegated: outcome.delegated,
      frontierOutput: outcome.frontierOutput,
      escalationReason: outcome.decisionReason,
      keyAlias: task.keyAlias,
    },
    {
      config: shadowConfig,
      queueDepth: () => activeDelegations,
      resolveModelId: async () => {
        const modelId = shadowConfig.model || (await currentModel());
        // Only pay for the served-model /running lookup when the original task was stamped — an
        // unstamped task's shadow row stays a null/legacy identity anyway (see `record` below), so
        // there is nothing to join the served fields against.
        if (modelId && task.learningTaskStamp) shadowServedFields = await resolveServedModelIdentity(modelId);
        return modelId;
      },
      infer: async (modelId, job, laneCfg): Promise<ShadowInference> => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, laneCfg.timeoutMs);
        try {
          if (task.keyAlias) {
            recordTaskExposureBestEffort({
              taskText: job.prompt,
              lane: "delegate-shadow",
              modelId,
              harnessId: "delegate-shadow",
              canonicalFingerprintSha256: task.canonicalTaskFingerprintSha256,
            });
          }
          const sampling = resolveLocalSampling(modelId, task);
          const responseFormat = resolveResponseFormat(
            job.taskType,
            task.responseFormat,
            cfg.autoJsonResponseFormat
          );
          const result = await runLmStudioInference(modelId, job.prompt, {
            systemPrompt: job.systemPrompt,
            maxTokens: laneCfg.maxTokens,
            ...sampling,
            responseFormat,
            signal: controller.signal,
          });
          if (timedOut) return { ok: false, error: `timeout after ${laneCfg.timeoutMs}ms` };
          if (!result.ok) return { ok: false, error: result.error };
          return {
            ok: true,
            response: result.response,
            latencyMs: result.durationMs,
            ttftMs: result.ttftMs,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            tokPerSec: result.tokensPerSecond,
          };
        } catch (err) {
          return {
            ok: false,
            error: timedOut
              ? `timeout after ${laneCfg.timeoutMs}ms`
              : err instanceof Error
                ? err.message
                : String(err),
          };
        } finally {
          clearTimeout(timer);
        }
      },
      record: (row: ShadowLedgerRow) => {
        // #5: same principle as deriveEvidenceIdentity above — an unstamped task (or a served-model
        // lookup that never resolved, e.g. resolveModelId returned null and the lane never ran)
        // stays a null/"legacy" identity rather than a synthesized partial one. Lane is always
        // "delegate-shadow": this row must never be mistaken for primary delegate-lane evidence.
        const evidenceIdentity: EvidenceIdentityBundle | undefined =
          task.learningTaskStamp && shadowServedFields
            ? buildEvidenceIdentityBundle({
                ...evidenceIdentityFromAdmittedStamp(task.learningTaskStamp),
                ...shadowServedFields,
                lane: "delegate-shadow",
              })
            : undefined;
        recordDelegation({ ...row, evidenceIdentity });
      },
    }
  );
}

/**
 * Pure helper: derives the access-log summary fields from a DelegationOutcome.
 *
 * - decision: reflects ROUTING — "delegate" when we actually attempted locally,
 *   "escalate" when policy blocked before any local call, "error" when delegate() threw.
 * - escalated: whether frontier escalation occurred (null only on a hard throw).
 * - outcome: the real verified outcome when present; "escalated" for a clean policy-block
 *   (no inference ran, so no error occurred); "error" only when delegate() itself threw.
 *
 * Exported for unit testing.
 */
export function summarizeDelegation(
  fo: DelegationOutcome | null | undefined
): { decision: string; outcome: string; escalated: boolean | null } {
  if (fo == null) {
    return { decision: "error", outcome: "error", escalated: null };
  }
  const decision = fo.delegated ? "delegate" : "escalate";
  const escalated = fo.escalate ?? false;
  // Use the real verified outcome when present; for a clean policy-block (delegated:false,
  // no inference ran) use a neutral "escalated" rather than "error".
  const outcome =
    fo.outcome != null
      ? fo.outcome
      : fo.delegated
        ? "unverified"
        : "escalated";
  return { decision, outcome, escalated };
}

/**
 * If the task carries a frontierModelId, call OpenRouter with the same prompt and attach
 * the result to the outcome. Failures are captured in frontierError — never thrown — so
 * the caller always gets a complete DelegationOutcome regardless of frontier health.
 */
async function callFrontier(
  task: DelegationTask,
  outcome: DelegationOutcome
): Promise<DelegationOutcome> {
  if (!task.frontierModelId) return outcome;
  try {
    const fr = await runInference(task.frontierModelId, task.prompt, {
      systemPrompt: task.systemPrompt,
      maxTokens: task.frontierMaxTokens ?? task.maxTokens ?? 4096,
      temperature: 0,
    });
    if (fr.ok) {
      return { ...outcome, frontierOutput: fr.response, frontierModelId: task.frontierModelId };
    }
    return { ...outcome, frontierModelId: task.frontierModelId, frontierError: fr.error };
  } catch (err) {
    return {
      ...outcome,
      frontierModelId: task.frontierModelId,
      frontierError: err instanceof Error ? err.message : String(err),
    };
  }
}

function attachCostTrace(
  task: DelegationTask,
  outcome: DelegationOutcome,
  cfg = loadConfig()
): DelegationOutcome {
  if (cfg.delegationCostLog === "off") return outcome;
  const trace = buildDelegationCostTrace({
    taskType: outcome.taskType,
    localModelId: outcome.modelId,
    delegated: outcome.delegated,
    escalated: outcome.escalate,
    outcome: outcome.outcome ?? null,
    metrics: outcome.metrics ?? null,
    ledgerId: outcome.ledgerId ?? null,
    keyAlias: task.keyAlias ?? null,
    source: task.source ?? null,
    delegatorModelId: task.delegatorModelId ?? cfg.defaultDelegatorModelId,
    premiumBaselineModelId: task.premiumBaselineModelId ?? cfg.premiumBaselineModelId,
    fallbackModelId: outcome.frontierModelId ?? task.frontierModelId ?? null,
    delegatePolicyMode: outcome.delegatePolicy?.mode ?? null,
    delegatePolicyAction: outcome.delegatePolicy?.action ?? null,
    m5MarginalUsdPerMTok: cfg.m5MarginalUsdPerMTok,
    m5AmortizedUsdPerMTok: cfg.m5AmortizedUsdPerMTok,
  });
  tryRecordDelegationCost(trace);
  return { ...outcome, costTrace: trace };
}

/**
 * Run the disagreement-gate's SECOND local model on the same prompt, with its own wall-clock
 * guard. Returns the output for comparison, or an error string — never throws (the gate is a
 * best-effort enhancement; a flaky secondary must not break the primary delegation).
 */
async function runSecondaryInference(
  task: DelegationTask,
  secondaryModelId: string,
  maxTokens: number,
  timeoutMs: number,
  responseFormat: ResponseFormat | undefined
): Promise<{ ok: true; response: string; latencyMs: number } | { ok: false; error: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    if (task.keyAlias) {
      recordTaskExposureBestEffort({
        taskText: task.prompt,
        lane: "delegate-disagreement",
        modelId: secondaryModelId,
        harnessId: "delegate-disagreement",
        canonicalFingerprintSha256: task.canonicalTaskFingerprintSha256,
      });
    }
    const sampling = resolveLocalSampling(secondaryModelId, task);
    const res = await runLmStudioInference(secondaryModelId, task.prompt, {
      systemPrompt: task.systemPrompt,
      maxTokens,
      ...sampling,
      // Same grammar constraint as the primary (#166) — a fair second opinion on a JSON task must not
      // itself trip the harmony 500, and should be graded on the same output shape.
      responseFormat,
      signal: controller.signal,
    });
    // Mirror the primary path: a response that finished only because the abort raced its
    // completion is over-budget/possibly-truncated — never let it drive a gate decision.
    if (timedOut) return { ok: false, error: TIMEOUT_SENTINEL };
    if (res.ok) return { ok: true, response: res.response, latencyMs: res.durationMs };
    return { ok: false, error: res.error };
  } catch (err) {
    return { ok: false, error: timedOut ? TIMEOUT_SENTINEL : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The decision the evidence-based routing table makes for a task type:
 *  - "escalate"    → a characterized gap type (e.g. sql) with no reliable local model → frontier.
 *  - "local"       → use this specific local model (e.g. reason-math → qwen3-coder-next-80b).
 *  - "fallthrough" → the table has no opinion (flag off, explicit override, or UNKNOWN type) →
 *                    resolve the model the existing way (loaded model + ledger).
 */
export type RouteDecision =
  | { kind: "escalate" }
  | { kind: "local"; modelId: string }
  | { kind: "fallthrough" };

/**
 * Pure routing-table decision (no I/O — testable in isolation). Consulted by delegate() only when
 * `enabled` (HOMESERVER_USE_ROUTING_TABLE=on). An explicit caller-supplied model id ALWAYS wins
 * over the table (the table is the default policy, not a hard constraint), so it returns
 * "fallthrough" in that case — including for gap types, since the override is a deliberate choice.
 */
export function routeViaTable(
  taskType: string,
  opts: { enabled: boolean; explicitModelId?: string }
): RouteDecision {
  if (!opts.enabled || opts.explicitModelId) return { kind: "fallthrough" };
  const target = routingTarget(taskType);
  if (target === FRONTIER) return { kind: "escalate" };
  if (target === UNKNOWN_ROUTE) return { kind: "fallthrough" };
  return { kind: "local", modelId: target };
}

/**
 * Resolve the task type to record for a delegation (issue #155).
 *
 * Policy: an explicit caller-supplied `taskType` is domain knowledge the keyword classifier lacks
 * — e.g. ratatoskr asserting `taskType:"triage"` on production triage traffic (ratatoskr#31). Honor
 * it VERBATIM whenever it is non-blank, even for a bucket the classifier could never derive, so the
 * ledger records a real, routable task type instead of flattening the first production workload to
 * "other". Only when the field is ABSENT or blank (whitespace-only) do we fall back to the keyword
 * classifier (which may itself return "other"). Surrounding whitespace is trimmed so " triage " and
 * "triage" land in the same ledger bucket; the value is otherwise preserved as given.
 *
 * This deliberately drops the earlier `isKnownTaskType` gate: the old rule flattened any unknown
 * explicit type to the classifier's guess, which is exactly how a caller's domain knowledge was
 * being discarded. Callers on /delegate are already authenticated, so an explicit bucket is a
 * deliberate assertion, not untrusted injection — and an unrouted bucket simply sits in the ledger
 * as UNKNOWN (routingTarget → fallthrough) until enough evidence earns it a verdict.
 *
 * Pure (no I/O) so the boundary is unit-testable in isolation.
 */
export function resolveTaskType(task: { taskType?: string; prompt: string }): string {
  const explicit = task.taskType?.trim();
  if (explicit) return explicit;
  return classifyTask(task.prompt).taskType;
}

/** Get the model id to delegate to: explicit override, else first loaded LLM. */
export async function currentModel(override?: string): Promise<string | null> {
  if (override) return override;
  try {
    const loaded = await getLoaded();
    return loaded[0]?.key ?? null;
  } catch (err) {
    // A backend failure (not a genuine "no model loaded") must be visible — silently returning null
    // is exactly what hid the lmstudio-admin /api/v1/models 404 and made the router escalate everything.
    console.warn(
      `[orchestrator] currentModel: backend getLoaded() failed — treating as no local model: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Genuinely observed model-artifact/config-epoch identity (#5) for `modelId` on the active
 * backend, or an honest `unknown("not-observed")` pair when the backend has nothing to report or
 * the lookup itself fails. NEVER throws — a `/running` hiccup must degrade evidence quality, not
 * break serving, exactly like `currentModel`'s existing fail-open discipline above.
 *
 * Exported (#33) so the code_loop and MCP `ask` write paths can join their OWN served-model
 * observation against their own admitted stamp, without forking this lookup.
 */
export async function resolveServedModelIdentity(
  modelId: string
): Promise<Pick<EvidenceIdentityBundle, "modelArtifact" | "configEpoch">> {
  try {
    const cmd = await getRunningCmd(modelId);
    return evidenceIdentityFromServedModelCmd(cmd);
  } catch (err) {
    console.warn(
      `[orchestrator] resolveServedModelIdentity: served-model lookup failed for ${modelId}: ${err instanceof Error ? err.message : String(err)}`
    );
    const reason = unknownIdentity("not-observed", "served-model /running lookup failed");
    return { modelArtifact: reason, configEpoch: reason };
  }
}

/**
 * Build the #5 content-addressed evidence identity for one delegate-lane attempt: the admitted
 * LearningTaskContract stamp's own mechanically-bound fields (prompt/harness/tool-policy/taxonomy),
 * joined with the LIVE served-model artifact/config epoch THIS lane actually used, stamped with
 * this lane's own identity so a shadow-lane candidate model can never be mistaken for the primary
 * delegate lane's evidence (or vice versa).
 *
 * Returns `undefined` — never a bundle of all-unknown fields — for an unstamped caller, so an
 * ordinary legacy request keeps landing in the null/"legacy" bucket exactly as before (#28's
 * readers already disclose that honestly; synthesizing a mostly-unknown bundle here would only add
 * an untested partial-disclosure shape with no reconstructability benefit, since nothing about the
 * logical task/harness/tool-policy is mechanically known without a stamp).
 *
 * Exported (#33) — this derivation is lane-agnostic (the caller supplies its own `lane`), so the
 * code_loop write path (code-loop.ts) and the MCP `ask` write path (mcp.ts) reuse it VERBATIM
 * instead of forking the join logic PR #32 introduced for the delegate + delegate-shadow lanes.
 */
export async function deriveEvidenceIdentity(
  stamp: HuginRequestStamp | undefined,
  modelId: string,
  lane: EvidenceLane
): Promise<EvidenceIdentityBundle | undefined> {
  if (!stamp) return undefined;
  const stampFields = evidenceIdentityFromAdmittedStamp(stamp);
  const servedFields = await resolveServedModelIdentity(modelId);
  return buildEvidenceIdentityBundle({ ...stampFields, ...servedFields, lane });
}

/**
 * Signature of the transient llama.cpp harmony/PEG parse failure (issue #164).
 *
 * gpt-oss-120b uses the OpenAI harmony format; llama.cpp parses assistant turns with a strict PEG
 * grammar (`COMMON_CHAT_FORMAT_PEG_NATIVE`) and hard-throws HTTP 500 — surfaced by
 * runLmStudioInference as "…does not match the expected peg-native format" — when the model emits
 * bare JSON with no channel markup (which strict "output ONLY JSON" prompts induce). The failure is
 * PROVEN non-deterministic on identical requests, so a single retry of the same call recovers the
 * large majority. Named + exported so the boundary is unit-testable in isolation.
 *
 * Matches either (a) the generic "does not match the expected <X> format" wording or (b) any bare
 * mention of the peg-native / peg_native grammar. Case-insensitive; false for null/empty.
 */
const FORMAT_ERROR_RE = /does not match the expected .* format|peg[-_]native/i;
export function isTransientFormatError(error: string | null | undefined): boolean {
  return typeof error === "string" && FORMAT_ERROR_RE.test(error);
}

/**
 * Decide the structured-output `response_format` for a delegation's local call (#166 — the robust
 * prevention behind the #164 retry band-aid).
 *
 * Precedence:
 *   1. an explicit caller-supplied `explicit` value always wins (e.g. a full json_schema);
 *   2. otherwise a JSON-shaped task type (taxonomy `jsonOutput`, e.g. triage/source-distill) defaults
 *      to `{ type: "json_object" }` when `autoJson` is on — this grammar-constrains gpt-oss-120b's
 *      harmony decoder so it can't emit the bare-JSON-no-channel-markup that hard-throws a PEG 500;
 *   3. prose task types (and JSON types with autoJson off) get no format → unconstrained decoding.
 *
 * Pure + exported so the "does this task get grammar-constrained decoding" decision is unit-testable
 * in isolation from the delegate loop.
 */
export function resolveResponseFormat(
  taskType: string,
  explicit: ResponseFormat | undefined,
  autoJson: boolean
): ResponseFormat | undefined {
  if (explicit) return explicit;
  if (autoJson && taskTypeEmitsJson(taskType)) return { type: "json_object" };
  return undefined;
}

function classifyError(error: string): ErrorClass {
  if (error === TIMEOUT_SENTINEL) return "timeout";
  // A harmony/PEG parse failure (#164) is a genuine parse error, not generic infra — classify it as
  // such so a format-500 that survives its retry is queryable as errorClass="parse" in the ledger.
  if (isTransientFormatError(error)) return "parse";
  const e = error.toLowerCase();
  if (e.includes("empty response")) return "empty";
  if (e.includes("timeout") || e.includes("timed out")) return "timeout";
  if (e.includes("econnrefused") || e.includes("fetch failed") || e.includes("network") || e.includes("socket")) return "infra";
  return "infra";
}

/**
 * Run one delegation through the full policy + record loop.
 */
export async function delegate(task: DelegationTask): Promise<DelegationOutcome> {
  const requestId = randomUUID();
  const startMs = Date.now();
  let finalOutcome: DelegationOutcome | undefined;
  activeDelegations++;

  try {
    finalOutcome = await delegateImpl(task);
    return finalOutcome;
  } finally {
    activeDelegations--;
    const totalMs = Date.now() - startMs;
    const fo = finalOutcome;
    // Emit one delegate_decision log line covering classify→decision→outcome.
    // Uses the module-level defaultLogger (replaced by no-op when accessLog=off).
    const { decision, outcome: summaryOutcome, escalated } = summarizeDelegation(fo);
    defaultLogger.log({
      event: "delegate_decision",
      requestId,
      model: fo?.modelId ?? null,
      taskType: fo?.taskType ?? null,
      decision,
      outcome: summaryOutcome,
      score: fo?.score ?? null,
      escalated,
      totalMs,
      promptTokens: fo?.metrics?.promptTokens ?? null,
      completionTokens: fo?.metrics?.completionTokens ?? null,
      totalTokens:
        fo?.metrics != null
          ? fo.metrics.promptTokens + fo.metrics.completionTokens
          : null,
      delegatePolicyMode: fo?.delegatePolicy?.mode,
      delegatePolicyAction: fo?.delegatePolicy?.action,
    });
  }
}

/**
 * Internal implementation — called by delegate() which wraps it with access logging.
 */
async function delegateImpl(task: DelegationTask): Promise<DelegationOutcome> {
  const cfg = loadConfig();
  // Preserve an explicit caller-supplied taskType verbatim; classify only when absent/blank (#155).
  const taskType = resolveTaskType(task);
  const nodeId = task.nodeId ?? "m5";

  const finishNoLocalEscalation = async (
    base: DelegationOutcome
  ): Promise<DelegationOutcome> => {
    const outcome = attachCostTrace(task, await callFrontier(task, base), cfg);
    maybeScheduleEscalationShadow(task, outcome, cfg);
    return outcome;
  };

  // ── Evidence-based routing table (default-off; HOMESERVER_USE_ROUTING_TABLE=on) ──
  // When enabled it (a) force-escalates the characterized gap types (sql) to a frontier model
  // BEFORE any local attempt, and (b) selects the per-task-type local model (e.g. reason-math →
  // qwen3-coder-next-80b). An explicit task.modelId override bypasses it. When the table has no
  // opinion (off, override, or UNKNOWN type) we resolve the model exactly as before.
  const route = routeViaTable(taskType, {
    enabled: cfg.useRoutingTable === "on",
    explicitModelId: task.modelId,
  });
  if (route.kind === "escalate") {
    return finishNoLocalEscalation({
      delegated: false,
      escalate: true,
      taskType,
      nodeId,
      modelId: "(frontier)",
      decisionReason: `routing-table: ${taskType} is a frontier-escalation gap type → escalate`,
    });
  }
  const routedModelId = route.kind === "local" ? route.modelId : undefined;

  const modelId = nodeId === "orin" ? cfg.orin.model : await currentModel(task.modelId ?? routedModelId);
  if (nodeId === "orin" && (!task.modelId || task.modelId !== cfg.orin.model || !orinAllowsTask(taskType, cfg))) {
    return finishNoLocalEscalation({
      delegated: false,
      escalate: true,
      taskType,
      nodeId,
      modelId: modelId ?? cfg.orin.model,
      decisionReason: "Orin is only available for its configured model on explicitly eligible task types; Hugin must re-route to M5 or frontier",
    });
  }
  if (!modelId) {
    return finishNoLocalEscalation({
      delegated: false,
      escalate: true,
      taskType,
      nodeId,
      modelId: "(none)",
      decisionReason: "no local model loaded — escalate to frontier",
    });
  }

  // ── Production delegate policy (default off) ───────────────────────────────
  // This is the strict gate for automatic production delegation. It is separate from the legacy
  // learning policy below: shouldDelegate() may explore unknown lanes to learn, while this gate only
  // allows lanes that are verifier-backed, evidenced, fast enough, and not broad/judgment-unsafe.
  const delegatePolicy =
    cfg.delegatePolicy.mode === "off"
      ? undefined
      : evaluateDelegatePolicy({
          taskType,
          modelId,
          nodeId,
          verifierName: task.verifierName ?? (task.verifier ? "custom" : "none"),
          hasVerifier: task.verifier !== undefined,
          source: task.source,
          explicitModelOverride: task.modelId !== undefined,
          policy: cfg.policy,
          delegatePolicy: cfg.delegatePolicy,
        });

  if (delegatePolicy && cfg.delegatePolicy.mode === "enforce" && delegatePolicy.action !== "allow") {
    return finishNoLocalEscalation({
      delegated: false,
      escalate: true,
      taskType,
      nodeId,
      modelId,
      decisionReason: `delegate-policy ${delegatePolicy.action}: ${delegatePolicy.reason}`,
      delegatePolicy,
    });
  }

  // ── Learning policy gate: should we even try the local model for this kind of task? ──
  const decision = shouldDelegate(taskType, modelId, cfg.policy, Math.random, nodeId);
  if (!decision.delegate) {
    return finishNoLocalEscalation({
      delegated: false,
      escalate: true,
      taskType,
      nodeId,
      modelId,
      decisionReason: decision.reason,
      delegatePolicy,
    });
  }

  // ── Local inference (with a wall-clock guard against reasoning spirals) ──
  // Each attempt gets its own AbortController + timer: the timer ABORTS the request and is always
  // cleared, so a finished call lets the process exit immediately and a timeout actually cancels the
  // in-flight stream.
  const maxTokens = task.maxTokens ?? cfg.defaultMaxTokens;
  // ── Grammar-constrained structured output (#166) ──
  // JSON-shaped task types default to a json_object response_format (an explicit task.responseFormat
  // wins), which engages llama.cpp's constrained decoder and structurally prevents gpt-oss-120b's
  // harmony/PEG 500. Resolved once and shared by the primary AND the disagreement-gate secondary call.
  const responseFormat = resolveResponseFormat(taskType, task.responseFormat, cfg.autoJsonResponseFormat);
  const sampling = resolveLocalSampling(modelId, task);
  if (task.keyAlias) {
    recordTaskExposureBestEffort({
      taskText: task.prompt,
      lane: "delegate",
      modelId,
      harnessId: nodeId === "orin" ? "delegate-orin" : "delegate-local",
      canonicalFingerprintSha256: task.canonicalTaskFingerprintSha256,
    });
  }
  const runLocalOnce = async (): Promise<LocalInferenceResult> => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, cfg.callTimeoutMs);
    let r: LocalInferenceResult;
    try {
      r = nodeId === "orin"
        ? await runOrinInference(modelId, task.prompt, {
            systemPrompt: task.systemPrompt,
            maxTokens,
            temperature: sampling.temperature,
            topP: sampling.topP,
            topK: sampling.topK,
            minP: sampling.minP,
            responseFormat,
            signal: controller.signal,
          }, cfg)
        : await runLmStudioInference(modelId, task.prompt, {
            systemPrompt: task.systemPrompt,
            maxTokens,
            ...sampling,
            responseFormat,
            signal: controller.signal,
          });
    } catch (err) {
      // runLmStudioInference catches its own errors, but if an abort (or anything else)
      // ever escapes, fold it into a result instead of throwing out of delegate().
      r = timedOut
        ? { ok: false, error: TIMEOUT_SENTINEL }
        : { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
    return timedOut ? { ok: false, error: TIMEOUT_SENTINEL } : r;
  };

  let result = await runLocalOnce();
  // ── Retry-on-transient-parse-error (#164) ──
  // The gpt-oss-120b harmony/PEG failure is non-deterministic per identical request, so ONE retry of
  // the same call recovers the majority. Cap at exactly one retry (no loop); a different error class
  // (timeout/empty/infra) never triggers this. The robust grammar-constrained prevention is #166.
  let formatRetried = false;
  if (!result.ok && isTransientFormatError(result.error)) {
    formatRetried = true;
    result = await runLocalOnce();
  }
  // Surfaced on the ledger row + returned outcome so the retry is visible, not silent.
  const retryNote = formatRetried ? "format-retry(#164)" : undefined;

  // ── Infra / empty / timeout / (twice-failed) parse failures ──
  if (!result.ok) {
    const errorClass = classifyError(result.error);
    const failNote = result.error === TIMEOUT_SENTINEL ? `timeout after ${cfg.callTimeoutMs}ms` : result.error;
    const evidenceIdentity = await deriveEvidenceIdentity(task.learningTaskStamp, modelId, "delegate");
    const ledgerId = recordDelegation({
      taskType,
      nodeId,
      modelId,
      prompt: task.prompt,
      outcome: "error",
      errorClass,
      verifier: task.verifierName ?? (task.verifier ? "custom" : "none"),
      escalated: true,
      source: task.source,
      keyAlias: task.keyAlias,
      notes: [failNote, retryNote].filter(Boolean).join(" | "),
      evidenceIdentity,
    });
    return attachCostTrace(task, await callFrontier(task, {
      delegated: true,
      escalate: true,
      taskType,
      nodeId,
      modelId,
      decisionReason: delegatePolicy
        ? `${decision.reason} + delegate-policy(${delegatePolicy.mode}): ${delegatePolicy.action} — ${delegatePolicy.reason}`
        : decision.reason,
      outcome: "error",
      ledgerId,
      verifierNotes: result.error,
      formatRetried,
      delegatePolicy,
    }), cfg);
  }

  // ── Verify ──
  const metrics: DelegationMetrics = {
    latencyMs: result.durationMs,
    ttftMs: result.ttftMs,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    tokPerSec: result.tokensPerSecond,
  };

  let outcome: Outcome = "unverified";
  let score: number | null = null;
  let errorClass: ErrorClass | undefined;
  let notes: string | undefined;

  if (task.verifier) {
    const vr = await task.verifier(result.response);
    outcome = vr.outcome;
    score = vr.score;
    errorClass = vr.errorClass;
    notes = vr.notes;
  }

  // ── Cross-model disagreement gate (instance-level escalation; default-off) ──
  // On the UNVERIFIED path (no deterministic verdict to trust) run a SECOND cheap local model
  // and compare answers. When they disagree we escalate to frontier — the signal that beats
  // self-confidence on real sub-tasks (docs/cascade-gate-experiment-design.md). "shadow" mode
  // runs + records the gate but does NOT change routing (the live-ledger validation path).
  let gate: DelegationOutcome["gate"];
  const gateCfg: GateConfig = {
    mode: cfg.disagreementGate,
    secondaryModel: cfg.disagreementGateModel,
    threshold: cfg.disagreementGateThreshold,
  };
  if (nodeId === "m5" && gateEligible({ config: gateCfg, outcome, primaryModelId: modelId }).eligible) {
    const sec = await runSecondaryInference(
      task,
      gateCfg.secondaryModel,
      maxTokens,
      cfg.callTimeoutMs,
      responseFormat
    );
    const mode = gateCfg.mode as "shadow" | "on";
    if (sec.ok) {
      const d = gateDecision(result.response, sec.response, gateCfg.threshold);
      gate = { mode, model: gateCfg.secondaryModel, score: d.score, wouldEscalate: d.disagree, latencyMs: sec.latencyMs };
    } else {
      // Best-effort: a failed second opinion never escalates on its own (a flaky secondary
      // must not cause mass escalation) — record it and keep the primary's verdict.
      gate = { mode, model: gateCfg.secondaryModel, score: 0, wouldEscalate: false, secondaryError: sec.error };
    }
  }

  // The gate only DRIVES routing in "on" mode; in "shadow" it is recorded but inert.
  const gateEscalate = gate?.mode === "on" && gate.wouldEscalate;
  const gateNote = gate
    ? gate.secondaryError
      ? `gate(${gate.mode}):${gate.model} error=${gate.secondaryError.slice(0, 80)}`
      : `gate(${gate.mode}):${gate.model} score=${gate.score.toFixed(2)} disagree=${gate.wouldEscalate ? 1 : 0}`
    : undefined;
  const combinedNotes = [notes, gateNote, retryNote].filter(Boolean).join(" | ") || undefined;

  const verdictEscalate = outcome === "fail" || outcome === "error";
  const shouldEscalate = verdictEscalate || gateEscalate;

  const evidenceIdentity = await deriveEvidenceIdentity(task.learningTaskStamp, modelId, "delegate");
  const ledgerId = recordDelegation({
    taskType,
    nodeId,
    modelId,
    prompt: task.prompt,
    outcome,
    score,
    latencyMs: metrics.latencyMs,
    ttftMs: metrics.ttftMs,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    tokPerSec: metrics.tokPerSec,
    verifier: task.verifierName ?? (task.verifier ? "custom" : "none"),
    errorClass: errorClass ?? null,
    escalated: shouldEscalate,
    source: task.source,
    keyAlias: task.keyAlias,
    notes: combinedNotes,
    // #91: structured mirror of `gate` — the free-text note above stays for human-readable
    // debugging, but these columns are the queryable source of truth going forward.
    gateMode: gate?.mode ?? null,
    gateScore: gate?.score ?? null,
    gateWouldEscalate: gate?.wouldEscalate ?? null,
    gateError: gate?.secondaryError ?? null,
    evidenceIdentity,
  });

  const decisionReason = gateEscalate
    ? `${decision.reason} + disagreement-gate escalate (score=${gate!.score.toFixed(2)})`
    : decision.reason;
  const policyReason = delegatePolicy
    ? `${decisionReason} + delegate-policy(${delegatePolicy.mode}): ${delegatePolicy.action} — ${delegatePolicy.reason}`
    : decisionReason;
  const baseOutcome: DelegationOutcome = {
    delegated: true,
    escalate: shouldEscalate,
    taskType,
    nodeId,
    modelId,
    decisionReason: policyReason,
    outcome,
    score,
    output: result.response,
    metrics,
    verifierNotes: notes,
    ledgerId,
    gate,
    formatRetried,
    delegatePolicy,
  };
  return attachCostTrace(task, shouldEscalate ? await callFrontier(task, baseOutcome) : baseOutcome, cfg);
}
