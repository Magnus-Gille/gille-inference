/**
 * Structured access logging for the home-server gateway and orchestrator.
 *
 * SECURITY CONTRACT: This module logs metadata only. It MUST NEVER log prompt text,
 * message content, response bodies, or bearer tokens. Fields are narrowly typed so the
 * type system enforces this by construction — there is no string field that accepts
 * arbitrary user content. Only principal alias (never the raw token) and tier are logged.
 *
 * Output: one line of JSON per event written to the injected writer (default:
 * process.stdout). log() is always best-effort — a writer failure is swallowed and never
 * propagates to the caller, so logging can never break a request.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type AccessLogEvent = "gateway_request" | "delegate_decision";

export interface AccessLogRecord {
  /** ISO 8601 timestamp, auto-filled when omitted. */
  ts: string;
  event: AccessLogEvent;
  /** Unique identifier for the request (crypto.randomUUID()). */
  requestId: string;
  /** HTTP method, e.g. "POST". */
  method?: string | null;
  /** Gateway route, e.g. "/v1/chat/completions". */
  route?: string | null;
  /**
   * Principal alias from the keystore (e.g. "alice", "static:admin").
   * NEVER the raw bearer token — only the human-readable alias.
   */
  principal?: string | null;
  /** Owner or guest tier, or null for unauthenticated (should not reach log in normal flow). */
  tier?: "owner" | "guest" | null;
  /** Model id from the request body or orchestrator selection. */
  model?: string | null;
  /** HTTP status code sent to the client. */
  status?: number | null;
  /** Short outcome label: "ok", "pass", "fail", "error", "partial", "unverified", etc. */
  outcome?: string | null;
  /** Canonical error class (matches ErrorCode for gateway; ErrorClass for orchestrator). */
  errorClass?: string | null;
  /** Prompt tokens from upstream usage frame; null when streaming without a trailing frame. */
  promptTokens?: number | null;
  /** Completion tokens from upstream usage frame; null when not available. */
  completionTokens?: number | null;
  /** Total tokens; auto-computed from prompt+completion if both present and totalTokens omitted. */
  totalTokens?: number | null;
  /** Milliseconds the request spent waiting in the admission queue (null when not applicable). */
  queueWaitMs?: number | null;
  /** Total wall-clock milliseconds from request entry to response send. */
  totalMs?: number | null;
  /** Admission outcome: 'admitted' | 'preempted' | 'busy' | 'n/a'. */
  admission?: string | null;
  /** Retry-After value in seconds, populated on 429/503. */
  retryAfterS?: number | null;

  // ── delegate_decision extra fields ──────────────────────────────────────────
  /** Task type from the taxonomy classifier (only for delegate_decision events). */
  taskType?: string | null;
  /** Orchestrator routing decision: 'delegate' | 'escalate' | 'blocked'. */
  decision?: string | null;
  /** Verifier score [0,1], null when unverified. */
  score?: number | null;
  /** True when the local attempt failed and was escalated to frontier. */
  escalated?: boolean | null;
  /** Delegate-policy mode in force for this decision, if evaluated. */
  delegatePolicyMode?: "off" | "shadow" | "enforce" | null;
  /** Delegate-policy action for this lane, if evaluated. */
  delegatePolicyAction?: "allow" | "shadow" | "deny" | null;
}

// ─── Logger factory ─────────────────────────────────────────────────────────

export interface AccessLogger {
  log(rec: Partial<AccessLogRecord>): void;
}

/**
 * Create an access logger with an optional writer injection.
 *
 * @param writer  Called with each completed log line (including trailing "\n").
 *                Defaults to process.stdout.write bound to stdout.
 *                Pass a no-op to disable logging (for HOMESERVER_ACCESS_LOG=off).
 */
export function createAccessLogger(
  writer: (line: string) => void = (line) => process.stdout.write(line)
): AccessLogger {
  return {
    log(rec: Partial<AccessLogRecord>): void {
      try {
        const ts = rec.ts ?? new Date().toISOString();

        // Auto-compute totalTokens when the individual components are present.
        let totalTokens = rec.totalTokens ?? null;
        if (
          totalTokens === null &&
          typeof rec.promptTokens === "number" &&
          typeof rec.completionTokens === "number"
        ) {
          totalTokens = rec.promptTokens + rec.completionTokens;
        }

        const full: AccessLogRecord = {
          ts,
          event: rec.event ?? "gateway_request",
          requestId: rec.requestId ?? "",
          method: rec.method ?? null,
          route: rec.route ?? null,
          principal: rec.principal ?? null,
          tier: rec.tier ?? null,
          model: rec.model ?? null,
          status: rec.status ?? null,
          outcome: rec.outcome ?? null,
          errorClass: rec.errorClass ?? null,
          promptTokens: rec.promptTokens ?? null,
          completionTokens: rec.completionTokens ?? null,
          totalTokens,
          queueWaitMs: rec.queueWaitMs ?? null,
          totalMs: rec.totalMs ?? null,
          admission: rec.admission ?? null,
          retryAfterS: rec.retryAfterS ?? null,
          // delegate_decision extras — only include when relevant
          ...(rec.taskType !== undefined ? { taskType: rec.taskType } : {}),
          ...(rec.decision !== undefined ? { decision: rec.decision } : {}),
          ...(rec.score !== undefined ? { score: rec.score } : {}),
          ...(rec.escalated !== undefined ? { escalated: rec.escalated } : {}),
          ...(rec.delegatePolicyMode !== undefined ? { delegatePolicyMode: rec.delegatePolicyMode } : {}),
          ...(rec.delegatePolicyAction !== undefined ? { delegatePolicyAction: rec.delegatePolicyAction } : {}),
        };

        writer(JSON.stringify(full) + "\n");
      } catch {
        // Best-effort: never throw out of log() — a writer error must not affect a request.
      }
    },
  };
}

// ─── Module-level default instance ──────────────────────────────────────────

/**
 * Module-level singleton used by the gateway and orchestrator.
 * Replaced by a no-op when HOMESERVER_ACCESS_LOG=off (see config wiring in gateway.ts).
 * Exported as a mutable variable so the gateway can swap it at startup.
 */
export let defaultLogger: AccessLogger = createAccessLogger();

/** Replace the default logger (used by gateway startup to install a no-op when logging is off). */
export function setDefaultLogger(logger: AccessLogger): void {
  defaultLogger = logger;
}
