import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { CONTENT_CAPTURE_SUPPRESSED, type ContentCapture } from "./content-capture.js";

/**
 * OWNER-ONLY full request log.
 *
 * When the authenticated principal is a real OWNER keystore key, the gateway persists the
 * FULL request + response — the prompt messages, the completion text, and the usage/latency
 * metrics — to a private table for the operator's own analysis (e.g. "what did I actually
 * delegate to the box, and how well did it answer?").
 *
 * GUESTS ARE NEVER CONTENT-LOGGED. Chat, MCP ask, audio and image capture use
 * shouldCaptureOwnerContent below:
 *   logging enabled AND owner tier AND a real minted key
 * — which captures only real minted owner keys and deliberately EXCLUDES legacy static-key
 * admins (keyHash === null). The rationale: a content log is a privacy-sensitive surface, so we
 * log only the operator's own deliberately-minted owner keys, never a legacy posture that may not
 * represent a real human operator. A guest tier or legacy static key therefore NEVER produces a
 * row.
 *
 * PER-CALL OPT-OUT (#487): a row recorded with `contentCapture: "suppressed"` keeps only metadata.
 * recordOwnerRequest itself discards `messagesJson` / `completion` for such a row (empty strings,
 * matching the retention redaction value) and marks `content_capture = 'suppressed'`, so no caller
 * path — success, error, or retry — can persist content once the caller opted out. Readers that
 * mine content (harvest, replay, exposure backfill) also exclude marked rows explicitly.
 *
 * Writes are strictly best-effort: every insert is wrapped in try/catch so a log failure can
 * NEVER affect (fail, slow, or alter) the request itself. The schema is additive and created
 * idempotently in the shared eval DB, coexisting with runs / api_keys / etc.
 */

/**
 * Shared eligibility for full owner-content logging. This is deliberately narrower than
 * owner-tier content-blind exposure and independent of tool scope or delegation telemetry.
 * Call at the route's existing decision point; async work keeps that captured decision.
 */
export function shouldCaptureOwnerContent(
  mode: "on" | "off",
  principal: Readonly<{ tier: "owner" | "guest"; keyHash: string | null }>,
): boolean {
  return mode === "on" && principal.tier === "owner" && principal.keyHash !== null;
}

export type OwnerLogRoute = "chat" | "mcp" | "audio" | "image" | "review-cascade";

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
  /** #487: "suppressed" stores metadata only. Omitted/"default" keeps the full-content row. */
  contentCapture?: ContentCapture;
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
  // #487: additive, idempotent migration. NULL is the legacy/full-content state.
  const cols = db.prepare(`PRAGMA table_info(owner_request_log)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "content_capture")) {
    db.exec(`ALTER TABLE owner_request_log ADD COLUMN content_capture TEXT`);
  }
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
  const suppressed = row.contentCapture === "suppressed";
  try {
    olDb()
      .prepare(
        `INSERT INTO owner_request_log
           (ts, alias, model, route, messages_json, completion,
            prompt_tokens, completion_tokens, latency_ms, tok_per_sec, outcome, content_capture)
         VALUES
           (@ts, @alias, @model, @route, @messagesJson, @completion,
            @promptTokens, @completionTokens, @latencyMs, @tokPerSec, @outcome, @contentCapture)`
      )
      .run({
        ts: new Date().toISOString(),
        alias: row.alias,
        model: row.model,
        route: row.route,
        messagesJson: suppressed ? "" : row.messagesJson,
        completion: suppressed ? "" : row.completion,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        latencyMs: row.latencyMs,
        tokPerSec: row.tokPerSec,
        outcome: row.outcome,
        contentCapture: suppressed ? CONTENT_CAPTURE_SUPPRESSED : null,
      });
  } catch (err) {
    // Never let a log write break a request. Surface the detail server-side only. A suppressed
    // row's driver error could quote bound values, so report only the error class for it.
    if (suppressed) {
      console.error("[owner-log] failed to record metadata-only owner request (ignored):", err instanceof Error ? err.name : "unknown");
    } else {
      console.error("[owner-log] failed to record owner request (ignored):", err);
    }
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
  content_capture: string | null;
}

/**
 * #487: SQL predicate (with leading AND) excluding metadata-only rows from content readers. Returns
 * "" for a database whose owner_request_log predates the column (no row there can be suppressed).
 * Readers that open the DB directly (scripts) use this instead of assuming the migration ran.
 */
export function ownerLogContentRowsPredicate(db: Database.Database): string {
  const cols = db.prepare(`PRAGMA table_info(owner_request_log)`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === "content_capture")
    ? `AND (content_capture IS NULL OR content_capture <> '${CONTENT_CAPTURE_SUPPRESSED}')`
    : "";
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
    contentCapture: r.content_capture === CONTENT_CAPTURE_SUPPRESSED ? "suppressed" : "default",
  }));
}
