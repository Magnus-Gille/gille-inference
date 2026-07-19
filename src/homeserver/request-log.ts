import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * DURABLE, CONTENT-BLIND, PSEUDONYMOUS request log.
 *
 * Unlike owner-log.ts — which captures the FULL prompt + completion and is therefore strictly
 * owner-only — THIS table is METADATA-ONLY for EVERYONE, including the owner. It exists so the
 * operator can answer fleet questions WITHOUT ever storing non-owner content:
 *
 *   • #distinct users         → COUNT(DISTINCT alias)
 *   • #concurrent / activity  → rows grouped by ts windows
 *   • time-to-first-token     → ttft_ms (streaming) percentiles per model
 *   • throughput / outcomes   → completion_tokens / total_ms, outcome breakdown
 *
 * PRIVACY INVARIANT (enforced by construction):
 *   • There is NO column for prompt/response/messages/completion/content. The schema below is
 *     the single source of truth — the column allow-list in requestLogColumns() lets tests assert
 *     no content column can ever sneak in.
 *   • The per-key identity is the PSEUDONYM `alias` (the user explicitly chose "pseudonymous
 *     per-key by alias"). `key_hash` (sha256 of the minted key, nullable) is stored ONLY so the
 *     owner can join their own rows; the RAW plaintext key is NEVER stored.
 *   • Writes are strictly BEST-EFFORT — every insert is wrapped in try/catch, so a log failure
 *     can never fail, slow, or alter a request. Written on EVERY request from both the HTTP and
 *     the MCP path. Gate via HOMESERVER_REQUEST_LOG (config.requestLog; default "on").
 *
 * The schema is additive and created idempotently in the shared eval DB, coexisting with
 * runs / api_keys / owner_request_log / etc.
 */

/** A single content-blind row. `model` is already canonicalized ("none"/"unknown"/<id>). */
export interface RequestLogRow {
  /** The request id (uuid for the HTTP path; per-call uuid for MCP). PRIMARY KEY. */
  requestId: string;
  /** Pseudonymous key alias (e.g. "alice", "static:admin"). Null for unauthenticated routes. */
  alias: string | null;
  /** "owner" | "guest" | null (non-inference / unauthenticated). */
  tier: string | null;
  /** sha256(token) for a minted store key; null for legacy static / implicit-admin / no-key. */
  keyHash: string | null;
  /** Canonical model label — caller passes "none"/"unknown"/<catalogue id>, never a raw string. */
  model: string;
  /** Actual compute node, never caller-provided free text. */
  node?: "m5" | "orin";
  /** Gateway route, e.g. "/v1/chat/completions", "/mcp", "/healthz". */
  route: string;
  /** HTTP status sent to the client. */
  status: number;
  /** Short outcome label: "ok" | "error" | "rate_limited" | "busy" | "auth_failed" | … */
  outcome: string;
  /** Canonical error class when status >= 400, else null. */
  errorClass: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  /** Milliseconds spent waiting in the owner admission queue (null when not applicable). */
  queueWaitMs: number | null;
  /** Time-to-first-token in ms (streaming only); null for non-streaming requests. */
  ttftMs: number | null;
  /** Total wall-clock ms from request entry to response send. */
  totalMs: number;
  /** Admission outcome: "admitted" | "busy" | "n/a". */
  admission: string | null;
}

/** The ordered column list — the single source of truth for the schema AND the privacy assertion. */
const COLUMNS = [
  "id",
  "ts",
  "alias",
  "tier",
  "key_hash",
  "model",
  "node",
  "route",
  "status",
  "outcome",
  "error_class",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "queue_wait_ms",
  "ttft_ms",
  "total_ms",
  "admission",
] as const;

/** Expose the column names so tests can assert no content column exists. */
export function requestLogColumns(): string[] {
  return [...COLUMNS];
}

let _rlInit = false;

function ensureSchema(db: Database.Database): void {
  // Keep the established failure semantics if an operator has explicitly dropped the table: reads
  // should surface that outage rather than silently recreating storage. But if a test/recovery has
  // recreated an older-shaped table, run the additive migration even though this module is warm.
  if (_rlInit) {
    const exists = db
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'request_log'`)
      .get() as { present: 1 } | undefined;
    if (!exists) return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS request_log (
      id                TEXT PRIMARY KEY,
      ts                INTEGER NOT NULL,
      alias             TEXT,
      tier              TEXT,
      key_hash          TEXT,
      model             TEXT NOT NULL,
      node              TEXT NOT NULL DEFAULT 'm5',
      route             TEXT NOT NULL,
      status            INTEGER NOT NULL,
      outcome           TEXT NOT NULL,
      error_class       TEXT,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      total_tokens      INTEGER,
      queue_wait_ms     INTEGER,
      ttft_ms           INTEGER,
      total_ms          INTEGER NOT NULL,
      admission         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_request_log_ts    ON request_log(ts);
    CREATE INDEX IF NOT EXISTS idx_request_log_alias ON request_log(alias);
    CREATE INDEX IF NOT EXISTS idx_request_log_model ON request_log(model);
  `);
  const cols = db.prepare(`PRAGMA table_info(request_log)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "node")) db.exec(`ALTER TABLE request_log ADD COLUMN node TEXT NOT NULL DEFAULT 'm5'`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_request_log_node ON request_log(node)`);
  _rlInit = true;
}

function rlDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

/** Eagerly create the request_log schema (idempotent). Useful for migrations and tests. */
export function ensureRequestLogSchema(): void {
  ensureSchema(getDb());
}

/**
 * Persist one content-blind request row. Strictly best-effort: ANY failure (schema, disk,
 * duplicate id) is swallowed so the in-flight request is never affected. There is deliberately
 * no `content`/`prompt`/`response` parameter — the type makes content capture impossible.
 */
export function recordRequestLog(row: RequestLogRow): void {
  try {
    rlDb()
      .prepare(
        `INSERT INTO request_log
           (id, ts, alias, tier, key_hash, model, node, route, status, outcome, error_class,
            prompt_tokens, completion_tokens, total_tokens, queue_wait_ms, ttft_ms, total_ms, admission)
         VALUES
           (@id, @ts, @alias, @tier, @keyHash, @model, @node, @route, @status, @outcome, @errorClass,
            @promptTokens, @completionTokens, @totalTokens, @queueWaitMs, @ttftMs, @totalMs, @admission)`
      )
      .run({
        id: row.requestId,
        ts: Date.now(),
        alias: row.alias,
        tier: row.tier,
        keyHash: row.keyHash,
        model: row.model,
        node: row.node ?? "m5",
        route: row.route,
        status: row.status,
        outcome: row.outcome,
        errorClass: row.errorClass,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        totalTokens: row.totalTokens,
        queueWaitMs: row.queueWaitMs,
        ttftMs: row.ttftMs,
        totalMs: row.totalMs,
        admission: row.admission,
      });
  } catch (err) {
    // Never let a log write break a request. Surface the detail server-side only.
    console.error("[request-log] failed to record request (ignored):", err);
  }
}

// ─── Reader (for the owner's own queries) ──────────────────────────────────────────────

export interface RequestLogEntry extends Omit<RequestLogRow, "requestId"> {
  id: string;
  ts: number;
}

interface RequestLogDbRow {
  id: string;
  ts: number;
  alias: string | null;
  tier: string | null;
  key_hash: string | null;
  model: string;
  node: "m5" | "orin";
  route: string;
  status: number;
  outcome: string;
  error_class: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  queue_wait_ms: number | null;
  ttft_ms: number | null;
  total_ms: number;
  admission: string | null;
}

/**
 * GRAND-TOTAL aggregate over the durable log. This is the ONLY shape that may be exposed on the
 * PUBLIC, UNAUTHENTICATED portal surface (`GET /portal/stats`): coarse fleet-wide totals with NO
 * per-user, per-key, per-alias, per-model, or content dimension whatsoever.
 *
 *   • totalTokens   — SUM(total_tokens) across every row (NULL counts as 0).
 *   • totalRequests — COUNT(*) of logged requests.
 *   • since         — MIN(ts) (epoch ms) of the earliest logged request, or null on an empty log.
 *
 * Because it reads the DURABLE table (not the in-process Prometheus counters), the totals survive
 * gateway restarts — the honest "served so far" figure.
 */
export interface RequestLogTotals {
  totalTokens: number;
  totalRequests: number;
  /** Epoch ms of the earliest logged request; null when the log is empty. */
  since: number | null;
}

export function requestLogTotals(): RequestLogTotals {
  const r = rlDb()
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COUNT(*)                       AS total_requests,
              MIN(ts)                        AS since
         FROM request_log`
    )
    .get() as { total_tokens: number | null; total_requests: number; since: number | null };
  return {
    totalTokens: r.total_tokens ?? 0,
    totalRequests: r.total_requests ?? 0,
    since: r.since ?? null,
  };
}

// ─── Origin-side TTL cache for the public /portal/stats aggregate ──────────────────────
//
// requestLogTotals() does a full-table SUM+COUNT+MIN scan. The endpoint is PUBLIC and
// UNAUTHENTICATED, so every hit would re-scan SQLite (cost grows with the table). The
// client-side Cache-Control header only helps cooperating clients; this origin cache
// prevents repeated DB scans within the TTL regardless of client behaviour.
//
// TTL matches the Cache-Control max-age (30 s) — an evicted entry fetches fresh data and
// the client will see a consistent age window. The memo is process-local; restarts naturally
// clear it. Tests call bustStatsCache() to reset between cases.

const STATS_TTL_MS = 30_000;

let _statsMemo: { value: RequestLogTotals; expiresAt: number } | null = null;

/**
 * TTL-cached wrapper around requestLogTotals(). At most one DB scan per TTL window.
 * Propagates throws from requestLogTotals() (the caller decides error handling).
 */
export function cachedRequestLogTotals(): RequestLogTotals {
  const now = Date.now();
  if (_statsMemo !== null && now < _statsMemo.expiresAt) {
    return _statsMemo.value;
  }
  const value = requestLogTotals(); // throws on DB error — caller handles
  _statsMemo = { value, expiresAt: now + STATS_TTL_MS };
  return value;
}

/** Evict the stats TTL cache. Call in tests to isolate cases. */
export function bustStatsCache(): void {
  _statsMemo = null;
}

/** Read the most recent request-log entries (newest first). For operator analysis. */
export function getRequestLog(limit = 100): RequestLogEntry[] {
  const rows = rlDb()
    .prepare(`SELECT * FROM request_log ORDER BY ts DESC, id DESC LIMIT @limit`)
    .all({ limit }) as RequestLogDbRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    alias: r.alias,
    tier: r.tier,
    keyHash: r.key_hash,
    model: r.model,
    node: r.node,
    route: r.route,
    status: r.status,
    outcome: r.outcome,
    errorClass: r.error_class,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    queueWaitMs: r.queue_wait_ms,
    ttftMs: r.ttft_ms,
    totalMs: r.total_ms,
    admission: r.admission,
  }));
}
