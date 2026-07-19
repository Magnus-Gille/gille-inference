import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * OWNER-ONLY full request log.
 *
 * When the authenticated principal is a real OWNER keystore key, the gateway persists the
 * FULL request + response — the prompt messages, the completion text, and the usage/latency
 * metrics — to a private table for the operator's own analysis (e.g. "what did I actually
 * delegate to the box, and how well did it answer?").
 *
 * GUESTS ARE NEVER CONTENT-LOGGED. The single guard lives at each capture site:
 *   principal.tier === "owner" && principal.keyHash !== null
 * — which captures only real minted owner keys and deliberately EXCLUDES implicit-admin and
 * legacy static-key admins (both have keyHash === null). The rationale: a content log is a
 * privacy-sensitive surface, so we log only the operator's own deliberately-minted owner keys,
 * never an ambient bootstrap/legacy posture that may not represent a real human operator. A
 * guest tier, a legacy static key, or implicit-admin therefore NEVER produces a row.
 *
 * Writes are strictly best-effort: every insert is wrapped in try/catch so a log failure can
 * NEVER affect (fail, slow, or alter) the request itself. The schema is additive and created
 * idempotently in the shared eval DB, coexisting with runs / api_keys / etc.
 */

export type OwnerLogRoute = "chat" | "mcp" | "audio" | "image";

export interface OwnerLogRow {
  /** Key alias of the owner principal (NOT the key hash). */
  alias: string;
  /** The model id requested/used. */
  model: string | null;
  /** Which surface produced this: the OpenAI chat proxy or the MCP `ask` tool. */
  route: OwnerLogRoute;
  /** The request `messages` array, serialized as JSON. */
  messagesJson: string;
  /** The FULL completion text. */
  completion: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  tokPerSec: number | null;
  /** Free-form outcome label (e.g. "ok", "upstream_error"). */
  outcome: string;
}

let _olInit = false;

function ensureSchema(db: Database.Database): void {
  if (_olInit) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_request_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                TEXT NOT NULL,
      alias             TEXT NOT NULL,
      model             TEXT,
      route             TEXT NOT NULL,
      messages_json     TEXT NOT NULL,
      completion        TEXT NOT NULL,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      latency_ms        INTEGER,
      tok_per_sec       REAL,
      outcome           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owner_request_log_ts ON owner_request_log(ts);
  `);
  _olInit = true;
}

function olDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

/**
 * Persist one owner request/response row. Best-effort: any failure (schema, disk, serialization)
 * is swallowed so the in-flight request is never affected. Callers MUST have already applied the
 * owner-only guard (tier === "owner" && keyHash !== null) before calling this.
 */
export function recordOwnerRequest(row: OwnerLogRow): void {
  try {
    olDb()
      .prepare(
        `INSERT INTO owner_request_log
           (ts, alias, model, route, messages_json, completion,
            prompt_tokens, completion_tokens, latency_ms, tok_per_sec, outcome)
         VALUES
           (@ts, @alias, @model, @route, @messagesJson, @completion,
            @promptTokens, @completionTokens, @latencyMs, @tokPerSec, @outcome)`
      )
      .run({
        ts: new Date().toISOString(),
        alias: row.alias,
        model: row.model,
        route: row.route,
        messagesJson: row.messagesJson,
        completion: row.completion,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        latencyMs: row.latencyMs,
        tokPerSec: row.tokPerSec,
        outcome: row.outcome,
      });
  } catch (err) {
    // Never let a log write break a request. Surface the detail server-side only.
    console.error("[owner-log] failed to record owner request (ignored):", err);
  }
}

// ─── Reader (for later analysis) ────────────────────────────────────────────────────

export interface OwnerLogEntry extends OwnerLogRow {
  id: number;
  ts: string;
}

interface OwnerLogDbRow {
  id: number;
  ts: string;
  alias: string;
  model: string | null;
  route: string;
  messages_json: string;
  completion: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  tok_per_sec: number | null;
  outcome: string;
}

/** Read the most recent owner-log entries (newest first). For operator analysis. */
export function getOwnerLog(limit = 100): OwnerLogEntry[] {
  const rows = olDb()
    .prepare(`SELECT * FROM owner_request_log ORDER BY id DESC LIMIT @limit`)
    .all({ limit }) as OwnerLogDbRow[];
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    alias: r.alias,
    model: r.model,
    route: r.route as OwnerLogRoute,
    messagesJson: r.messages_json,
    completion: r.completion,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    latencyMs: r.latency_ms,
    tokPerSec: r.tok_per_sec,
    outcome: r.outcome,
  }));
}
