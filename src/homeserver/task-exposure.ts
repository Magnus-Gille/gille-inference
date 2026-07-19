import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";

/**
 * Content-blind task-exposure registry (#257).
 *
 * A daily Hugin task may become a trustworthy holdout only if the same task text has not already
 * reached an owned runtime through another client. This registry stores a versioned digest plus
 * content-blind execution metadata — never the task, prompt, answer, diff, or file content.
 */

export const TASK_FINGERPRINT_VERSION = "trim-utf8-sha256-v1" as const;
export const TASK_EXPOSURE_LOOKUP_MAX = 100;

export const TASK_EXPOSURE_LANES = [
  "chat",
  "mcp-ask",
  "delegate",
  "delegate-disagreement",
  "delegate-shadow",
  "code-loop",
] as const;
export type TaskExposureLane = (typeof TASK_EXPOSURE_LANES)[number];

export interface TaskFingerprint {
  version: typeof TASK_FINGERPRINT_VERSION;
  sha256: string;
}

export interface TaskExposureRecord {
  taskText: string;
  lane: TaskExposureLane;
  modelId?: string | null;
  harnessId?: string | null;
  /** Stable for recovered/backfilled records; generated for an ordinary live event. */
  eventKey?: string;
  ts?: string;
}

export interface TaskExposureLookupRequest {
  fingerprint_version: typeof TASK_FINGERPRINT_VERSION;
  fingerprints: string[];
}

export interface TaskExposureLookupResult {
  fingerprint_sha256: string;
  seen: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  lanes: string[];
  model_ids: string[];
  harness_ids: string[];
}

export interface TaskExposureLookupResponse {
  schema_version: 1;
  fingerprint_version: typeof TASK_FINGERPRINT_VERSION;
  coverage: {
    /** Complete for the declared gateway-controlled lanes only, and only from `from`. */
    coverage_complete: boolean;
    from: string;
    through: string;
    lanes: readonly TaskExposureLane[];
    historical_backfill_complete: false;
    historical_backfill_from: string | null;
    historical_backfill_through: string | null;
    historical_events_imported: number;
    historical_rows_skipped_inexact: number;
    incomplete_before: string;
    incomplete_reasons: string[];
  };
  results: TaskExposureLookupResult[];
}

export interface TaskExposureBackfillSummary {
  ownerRowsScanned: number;
  delegationRowsScanned: number;
  eventsImported: number;
  rowsSkippedInexact: number;
  sourceFrom: string | null;
  sourceThrough: string | null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const initialized = new WeakSet<Database.Database>();
const unhealthyDbs = new WeakSet<Database.Database>();
let unboundCaptureFailure = false;

interface ExposureDbRow {
  fingerprint_sha256: string;
  ts: string;
  lane: string;
  model_id: string | null;
  harness_id: string | null;
}

interface OwnerRequestDbRow {
  id: number;
  ts: string;
  route: string;
  messages_json: string;
}

interface DelegationDbRow {
  id: string;
  ts: string;
  source: string | null;
  model_id: string;
  prompt_excerpt: string | null;
}

/**
 * Canonical task-text contract shared with Hugin's daily factory:
 * exact JavaScript String.trim(), no Unicode normalization, then exact UTF-8 bytes.
 */
export function canonicalTaskText(text: string): string {
  return text.trim();
}

export function taskTextFingerprint(text: string): TaskFingerprint {
  const canonical = canonicalTaskText(text);
  return {
    version: TASK_FINGERPRINT_VERSION,
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name) as { ok: number } | undefined;
  return row?.ok === 1;
}

function metaGet(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM task_exposure_meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function metaSet(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO task_exposure_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

export function ensureTaskExposureSchema(
  db: Database.Database = getDb(),
  nowIso = new Date().toISOString()
): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_exposure_events (
      event_key          TEXT PRIMARY KEY,
      ts                 TEXT NOT NULL,
      fingerprint_version TEXT NOT NULL,
      fingerprint_sha256 TEXT NOT NULL,
      lane               TEXT NOT NULL,
      model_id           TEXT,
      harness_id         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_exposure_fingerprint
      ON task_exposure_events(fingerprint_version, fingerprint_sha256, ts);

    CREATE TABLE IF NOT EXISTS task_exposure_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT OR IGNORE INTO task_exposure_meta (key, value) VALUES ('live_capture_started_at', ?)`
  ).run(nowIso);
  initialized.add(db);
}

function cleanMetadataId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "unknown" || trimmed === "none") return null;
  // Metadata is returned by the lookup. Bound it even though production callers pass trusted ids.
  return trimmed.slice(0, 160);
}

function insertExposure(
  db: Database.Database,
  input: TaskExposureRecord,
  eventKey: string,
  ts: string
): boolean {
  const canonical = canonicalTaskText(input.taskText);
  if (canonical === "") return false;
  const fingerprint = taskTextFingerprint(canonical);
  const info = db.prepare(
    `INSERT OR IGNORE INTO task_exposure_events
       (event_key, ts, fingerprint_version, fingerprint_sha256, lane, model_id, harness_id)
     VALUES
       (@eventKey, @ts, @version, @sha256, @lane, @modelId, @harnessId)`
  ).run({
    eventKey,
    ts,
    version: fingerprint.version,
    sha256: fingerprint.sha256,
    lane: input.lane,
    modelId: cleanMetadataId(input.modelId),
    harnessId: cleanMetadataId(input.harnessId),
  });
  return info.changes > 0;
}

/** Strict recorder for initialization/backfill/tests. Does not store the raw task. */
export function recordTaskExposure(
  input: TaskExposureRecord,
  db: Database.Database = getDb()
): boolean {
  ensureTaskExposureSchema(db);
  return insertExposure(
    db,
    input,
    input.eventKey ?? `live:${randomUUID()}`,
    input.ts ?? new Date().toISOString()
  );
}

function markCaptureGap(db: Database.Database): void {
  unhealthyDbs.add(db);
  try {
    ensureTaskExposureSchema(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO task_exposure_meta (key, value) VALUES ('first_live_capture_gap_at', ?)`
    ).run(now);
  } catch {
    // The original write may have failed because the DB itself is unavailable. In-process state
    // still makes every subsequent lookup fail closed until the gateway restarts.
  }
}

/** Availability-safe live capture. A failed write makes coverage incomplete; it never logs text. */
export function recordTaskExposureBestEffort(input: TaskExposureRecord): boolean {
  let db: Database.Database | null = null;
  try {
    db = getDb();
    return recordTaskExposure(input, db);
  } catch (err) {
    if (db === null) unboundCaptureFailure = true;
    else markCaptureGap(db);
    console.error("[task-exposure] content-blind capture failed; coverage is now incomplete:", err);
    return false;
  }
}

function contentText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((part) => {
      if (part === null || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      return p["type"] === "text" && typeof p["text"] === "string" ? p["text"] : "";
    })
    .filter((part) => part !== "");
  return parts.length > 0 ? parts.join("") : null;
}

/** Extract every exact user turn. Recording all is conservative and avoids false fresh holdouts. */
export function taskTextsFromMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const out: string[] = [];
  for (const message of messages) {
    if (message === null || typeof message !== "object") continue;
    const m = message as Record<string, unknown>;
    if (m["role"] !== "user") continue;
    const text = contentText(m["content"]);
    if (text !== null && canonicalTaskText(text) !== "") out.push(text);
  }
  return out;
}

export function recordMessageTaskExposuresBestEffort(input: {
  messages: unknown;
  lane: "chat" | "mcp-ask";
  modelId?: string | null;
  harnessId: string;
}): number {
  let recorded = 0;
  for (const text of taskTextsFromMessages(input.messages)) {
    if (recordTaskExposureBestEffort({
      taskText: text,
      lane: input.lane,
      modelId: input.modelId,
      harnessId: input.harnessId,
    })) recorded++;
  }
  return recorded;
}

function backfillOwnerRequests(db: Database.Database): {
  scanned: number;
  imported: number;
  from: string | null;
  through: string | null;
} {
  if (!tableExists(db, "owner_request_log")) return { scanned: 0, imported: 0, from: null, through: null };
  const rows = db.prepare(
    `SELECT id, ts, route, messages_json
     FROM owner_request_log
     WHERE route IN ('chat', 'mcp')
     ORDER BY id`
  ).all() as OwnerRequestDbRow[];
  let imported = 0;
  let from: string | null = null;
  let through: string | null = null;
  for (const row of rows) {
    let messages: unknown;
    try {
      messages = JSON.parse(row.messages_json);
    } catch {
      continue;
    }
    const texts = taskTextsFromMessages(messages);
    for (let i = 0; i < texts.length; i++) {
      if (insertExposure(db, {
        taskText: texts[i]!,
        lane: row.route === "mcp" ? "mcp-ask" : "chat",
        // Historical owner-log model labels were user supplied; omit rather than return a secret
        // or invented id. Live capture uses the trusted canonical model label.
        modelId: null,
        harnessId: row.route === "mcp" ? "mcp-ask" : "openai-chat",
      }, `backfill:owner-request:${row.id}:user:${i}:${TASK_FINGERPRINT_VERSION}`, row.ts)) imported++;
    }
    if (from === null) from = row.ts;
    else if (row.ts.localeCompare(from) < 0) from = row.ts;
    if (through === null) through = row.ts;
    else if (row.ts.localeCompare(through) > 0) through = row.ts;
  }
  return { scanned: rows.length, imported, from, through };
}

function laneForDelegationSource(source: string | null): {
  lane: TaskExposureLane;
  harnessId: string;
} {
  if (source === "code-loop") return { lane: "code-loop", harnessId: "code-loop:historical" };
  if (source === "mcp-ask") return { lane: "mcp-ask", harnessId: "mcp-ask" };
  if (source?.includes("shadow")) return { lane: "delegate-shadow", harnessId: "delegate-shadow" };
  return { lane: "delegate", harnessId: source ? `delegate:${source}` : "delegate" };
}

function backfillDelegations(db: Database.Database): {
  scanned: number;
  imported: number;
  skippedInexact: number;
  from: string | null;
  through: string | null;
} {
  if (!tableExists(db, "delegations")) {
    return { scanned: 0, imported: 0, skippedInexact: 0, from: null, through: null };
  }
  const rows = db.prepare(
    `SELECT id, ts, source, model_id, prompt_excerpt
     FROM delegations
     ORDER BY ts, id`
  ).all() as DelegationDbRow[];
  let imported = 0;
  let skippedInexact = 0;
  let from: string | null = null;
  let through: string | null = null;
  for (const row of rows) {
    if (from === null) from = row.ts;
    else if (row.ts.localeCompare(from) < 0) from = row.ts;
    if (through === null) through = row.ts;
    else if (row.ts.localeCompare(through) > 0) through = row.ts;
    // recordDelegation stores prompt.slice(0, 280). A shorter excerpt is provably complete;
    // exactly 280 characters is ambiguous and must never manufacture a false full-task hash.
    if (row.prompt_excerpt === null || row.prompt_excerpt.length >= 280) {
      skippedInexact++;
      continue;
    }
    const mapped = laneForDelegationSource(row.source);
    if (insertExposure(db, {
      taskText: row.prompt_excerpt,
      lane: mapped.lane,
      modelId: row.model_id,
      harnessId: mapped.harnessId,
    }, `backfill:delegation:${row.id}:${TASK_FINGERPRINT_VERSION}`, row.ts)) imported++;
  }
  return { scanned: rows.length, imported, skippedInexact, from, through };
}

function minIso(values: Array<string | null>): string | null {
  return values.filter((v): v is string => v !== null).sort()[0] ?? null;
}

function maxIso(values: Array<string | null>): string | null {
  return values.filter((v): v is string => v !== null).sort().at(-1) ?? null;
}

/** Idempotent historical import. It deliberately never claims full pre-capture history. */
export function backfillTaskExposures(
  db: Database.Database = getDb(),
  nowIso = new Date().toISOString()
): TaskExposureBackfillSummary {
  ensureTaskExposureSchema(db, nowIso);
  const summary = db.transaction(() => {
    const owner = backfillOwnerRequests(db);
    const delegations = backfillDelegations(db);
    const out: TaskExposureBackfillSummary = {
      ownerRowsScanned: owner.scanned,
      delegationRowsScanned: delegations.scanned,
      eventsImported: owner.imported + delegations.imported,
      rowsSkippedInexact: delegations.skippedInexact,
      sourceFrom: minIso([owner.from, delegations.from]),
      sourceThrough: maxIso([owner.through, delegations.through]),
    };
    metaSet(db, "historical_backfill_completed_at", nowIso);
    metaSet(db, "historical_backfill_from", out.sourceFrom ?? "");
    metaSet(db, "historical_backfill_through", out.sourceThrough ?? "");
    metaSet(db, "historical_events_imported", String(
      (db.prepare(`SELECT COUNT(*) AS n FROM task_exposure_events WHERE event_key LIKE 'backfill:%'`).get() as { n: number }).n
    ));
    metaSet(db, "historical_rows_skipped_inexact", String(out.rowsSkippedInexact));
    return out;
  })();
  return summary;
}

/** Startup composition root: migrations + idempotent backfill before the port opens. */
export function initializeTaskExposureRegistry(
  db: Database.Database = getDb(),
  nowIso = new Date().toISOString()
): TaskExposureBackfillSummary {
  ensureTaskExposureSchema(db, nowIso);
  // A successfully initialized process starts a new provably-contiguous live window. This both
  // recovers from a prior detected write gap and protects against the harder case where the gap
  // marker itself could not be persisted before a process restart. Older unseen candidates remain
  // quarantined because `coverage.from` moves forward; historical positive matches survive.
  db.transaction(() => {
    metaSet(db, "live_capture_started_at", nowIso);
    db.prepare(`DELETE FROM task_exposure_meta WHERE key = 'first_live_capture_gap_at'`).run();
  })();
  unhealthyDbs.delete(db);
  unboundCaptureFailure = false;
  return backfillTaskExposures(db, nowIso);
}

export function parseTaskExposureLookupRequest(value: unknown):
  | { ok: true; value: TaskExposureLookupRequest }
  | { ok: false; message: string; param: string | null } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "Expected a JSON object.", param: null };
  }
  const obj = value as Record<string, unknown>;
  if (obj["fingerprint_version"] !== TASK_FINGERPRINT_VERSION) {
    return {
      ok: false,
      message: `fingerprint_version must be '${TASK_FINGERPRINT_VERSION}'.`,
      param: "fingerprint_version",
    };
  }
  const raw = obj["fingerprints"];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > TASK_EXPOSURE_LOOKUP_MAX) {
    return {
      ok: false,
      message: `fingerprints must contain 1-${TASK_EXPOSURE_LOOKUP_MAX} SHA-256 values.`,
      param: "fingerprints",
    };
  }
  if (!raw.every((fingerprint) => typeof fingerprint === "string" && SHA256_RE.test(fingerprint))) {
    return {
      ok: false,
      message: "Every fingerprint must be a lowercase 64-character SHA-256 hex string.",
      param: "fingerprints",
    };
  }
  const fingerprints = raw as string[];
  if (new Set(fingerprints).size !== fingerprints.length) {
    return { ok: false, message: "fingerprints must not contain duplicates.", param: "fingerprints" };
  }
  return {
    ok: true,
    value: { fingerprint_version: TASK_FINGERPRINT_VERSION, fingerprints },
  };
}

export function lookupTaskExposures(
  request: TaskExposureLookupRequest,
  db: Database.Database = getDb(),
  nowIso = new Date().toISOString()
): TaskExposureLookupResponse {
  // Deliberately no ensureSchema/backfill call: the HTTP lookup is read-only. Gateway startup owns
  // all migrations and backfill writes before accepting requests.
  if (!tableExists(db, "task_exposure_events") || !tableExists(db, "task_exposure_meta")) {
    throw new Error("task exposure registry is not initialized");
  }
  const placeholders = request.fingerprints.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT fingerprint_sha256, ts, lane, model_id, harness_id
     FROM task_exposure_events
     WHERE fingerprint_version = ? AND fingerprint_sha256 IN (${placeholders})
     ORDER BY ts, event_key`
  ).all(request.fingerprint_version, ...request.fingerprints) as ExposureDbRow[];

  const byFingerprint = new Map<string, ExposureDbRow[]>();
  for (const row of rows) {
    const list = byFingerprint.get(row.fingerprint_sha256) ?? [];
    list.push(row);
    byFingerprint.set(row.fingerprint_sha256, list);
  }
  const results = request.fingerprints.map((fingerprint): TaskExposureLookupResult => {
    const found = byFingerprint.get(fingerprint) ?? [];
    return {
      fingerprint_sha256: fingerprint,
      seen: found.length > 0,
      first_seen_at: found[0]?.ts ?? null,
      last_seen_at: found.at(-1)?.ts ?? null,
      lanes: [...new Set(found.map((row) => row.lane))].sort(),
      model_ids: [...new Set(found.map((row) => row.model_id).filter((v): v is string => v !== null))].sort(),
      harness_ids: [...new Set(found.map((row) => row.harness_id).filter((v): v is string => v !== null))].sort(),
    };
  });

  const liveCaptureStartedAt = metaGet(db, "live_capture_started_at");
  if (liveCaptureStartedAt === null) throw new Error("task exposure coverage metadata is missing");
  const firstGap = metaGet(db, "first_live_capture_gap_at");
  const reasons = [
    "pre-capture direct-delegate prompts may be truncated in the legacy ledger",
    "pre-capture code-loop instructions were not retained independently of request fingerprints",
    "raw loopback llama-swap calls outside the authenticated gateway are outside this registry",
  ];
  const captureHealthy = firstGap === null && !unhealthyDbs.has(db) && !unboundCaptureFailure;
  if (!captureHealthy) reasons.push("a live content-blind capture write failed");

  return {
    schema_version: 1,
    fingerprint_version: TASK_FINGERPRINT_VERSION,
    coverage: {
      coverage_complete: captureHealthy,
      from: liveCaptureStartedAt,
      through: nowIso,
      lanes: TASK_EXPOSURE_LANES,
      historical_backfill_complete: false,
      historical_backfill_from: metaGet(db, "historical_backfill_from") || null,
      historical_backfill_through: metaGet(db, "historical_backfill_through") || null,
      historical_events_imported: Number(metaGet(db, "historical_events_imported") ?? 0),
      historical_rows_skipped_inexact: Number(metaGet(db, "historical_rows_skipped_inexact") ?? 0),
      incomplete_before: liveCaptureStartedAt,
      incomplete_reasons: reasons,
    },
    results,
  };
}
