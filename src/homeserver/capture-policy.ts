import { createHash } from "node:crypto";
import { shouldCaptureOwnerContent } from "./owner-log.js";
import { RETENTION_DATA_CLASSES } from "./retention-registry.js";

/**
 * Effective content-capture preflight (INFER-344).
 *
 * `describeCapturePolicy` answers, for the AUTHENTICATED caller only, what the gateway would
 * persist for each route class. It is content-free, read-only and deliberately derived from the
 * same `shouldCaptureOwnerContent` decision the runtime uses, so the advertisement cannot drift
 * from the behaviour. It never reads logs, keystore rows, paths or backend configuration.
 *
 * Honesty rules (do not weaken):
 *  - A capturing route is never described as non-retaining. The gateway does not itself enforce a
 *    retention window (pruning is an operator job), so `horizon_days` is "unknown" whenever data is
 *    persisted; the documented target is exposed separately as `declared_days`.
 *  - `none` means no durable per-request record at all, so retention is "not_applicable".
 *  - Tier and scope are reported separately and never conflated.
 *  - Observing a policy is not authorization to process data under it.
 */

export const CAPTURE_POLICY_CONTRACT = "capture-policy-v1";

export type CaptureMode = "content" | "metadata_only" | "none";
export type CaptureRouteClass = "chat" | "ask" | "code_loop" | "delegate" | "embeddings";
export type RetentionHorizon = number | "unknown" | "not_applicable";

export interface CaptureRouteEntry {
  /** Whether this principal's tier/scope may reach the route at all. */
  available: boolean;
  /** Default persistence for the route when called by this principal. */
  capture: CaptureMode;
  retention: { horizon_days: RetentionHorizon; declared_days: number | null };
  /** True when `X-Content-Capture: none` / `content_capture:"none"` is honoured on this route. */
  per_call_opt_out: boolean;
}

export interface CapturePolicy {
  contract: typeof CAPTURE_POLICY_CONTRACT;
  /** ISO time the policy was computed; a snapshot, never a standing guarantee. */
  observed_at: string;
  /** Hash of the inputs that determine the result; changes when the effective policy changes. */
  policy_id: string;
  principal: { tier: "owner" | "guest"; scope: string };
  routes: Record<CaptureRouteClass, CaptureRouteEntry>;
}

export interface CapturePolicyInput {
  ownerRequestLog: "on" | "off";
  requestLog: "on" | "off";
  principal: Readonly<{
    tier: "owner" | "guest";
    scope: string;
    isAdmin: boolean;
    keyHash: string | null;
  }>;
  /** `isKeyedExposureFingerprintAvailable()`: the per-call opt-out is only honoured when true. */
  optOutAvailable: boolean;
  /** Caller holds an explicit embedding grant. */
  embeddingGranted: boolean;
  now: Date;
}

const OWNER_LOG_DECLARED_DAYS = RETENTION_DATA_CLASSES["transient-task-artifact"].retentionDays;
const METADATA_DECLARED_DAYS = RETENTION_DATA_CLASSES["operational-telemetry"].retentionDays;

function metadataOrNone(requestLog: "on" | "off"): CaptureMode {
  return requestLog === "on" ? "metadata_only" : "none";
}

function retentionFor(capture: CaptureMode, declared: number | null): CaptureRouteEntry["retention"] {
  if (capture === "none") return { horizon_days: "not_applicable", declared_days: null };
  return { horizon_days: "unknown", declared_days: declared };
}

export function describeCapturePolicy(input: CapturePolicyInput): CapturePolicy {
  const { principal, optOutAvailable } = input;
  const scope = principal.scope;
  const owner = principal.tier === "owner";
  const monitor = scope === "monitor";
  const ownerContent = shouldCaptureOwnerContent(input.ownerRequestLog, principal);
  const chatCapture: CaptureMode = ownerContent ? "content" : metadataOrNone(input.requestLog);
  const chatDeclared = ownerContent ? OWNER_LOG_DECLARED_DAYS : METADATA_DECLARED_DAYS;
  const optOutOnOwnerContent = optOutAvailable && ownerContent;

  const chatAvailable = !monitor && scope !== "ask";
  const askAvailable = !monitor;
  const codeLoopAvailable =
    owner && principal.keyHash !== null && (scope === "admin" || scope === "agent");
  const delegateAvailable = owner && principal.isAdmin && !monitor && scope !== "ask";
  const embeddingsAvailable = chatAvailable && input.embeddingGranted;

  const entry = (
    available: boolean,
    capture: CaptureMode,
    declared: number | null,
    optOut: boolean,
  ): CaptureRouteEntry => ({
    available,
    capture,
    retention: retentionFor(capture, declared),
    per_call_opt_out: available && optOut,
  });

  // code_loop keeps its result in the gateway store regardless of the owner-log switch; the
  // per-call opt-out keeps it in memory only. Its retention window is not declared anywhere.
  const routes: Record<CaptureRouteClass, CaptureRouteEntry> = {
    chat: entry(chatAvailable, chatCapture, chatDeclared, optOutOnOwnerContent),
    ask: entry(askAvailable, chatCapture, chatDeclared, optOutOnOwnerContent),
    code_loop: entry(codeLoopAvailable, "content", null, optOutAvailable),
    // The capability ledger keeps a payload-derived prompt excerpt; the opt-out is refused here.
    delegate: entry(
      delegateAvailable,
      "content",
      RETENTION_DATA_CLASSES["transient-task-artifact"].retentionDays,
      false,
    ),
    // Embedding inputs are never persisted; only content-blind request metadata is. Opt-out refused.
    embeddings: entry(embeddingsAvailable, metadataOrNone(input.requestLog), METADATA_DECLARED_DAYS, false),
  };

  // Identity of the effective policy: only the inputs that change the answer, never secrets.
  const policyId = createHash("sha256")
    .update(JSON.stringify({
      v: CAPTURE_POLICY_CONTRACT,
      tier: principal.tier,
      scope,
      real_key: principal.keyHash !== null,
      admin: principal.isAdmin,
      owner_log: input.ownerRequestLog,
      request_log: input.requestLog,
      opt_out: optOutAvailable,
      embeddings: input.embeddingGranted,
    }))
    .digest("hex")
    .slice(0, 16);

  return {
    contract: CAPTURE_POLICY_CONTRACT,
    observed_at: input.now.toISOString(),
    policy_id: policyId,
    principal: { tier: principal.tier, scope },
    routes,
  };
}
