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

/**
 * Identity-kind discriminator (#4). Both kinds share the SAME fingerprint algorithm/version
 * (`trim-utf8-sha256-v1`) but hash different byte domains — the discriminator, not the version
 * string, is what tells two otherwise-identical-looking digests apart:
 *
 *  - "rendered-prompt": the exact gateway/runtime prompt text this process sent to a model
 *    (`task.prompt` / `req.instruction`). Recorded for every lane, stamped or not. This is the
 *    registry's original (#257) identity.
 *  - "canonical-raw": the logical task's pre-context/system-wrapping identity, taken directly from
 *    an admitted LearningTaskContract Hugin request stamp's `raw_fingerprint.digest`. Gille never
 *    sees that raw text — only the already-hashed, already-authenticated digest Hugin stamped.
 *    Recorded ADDITIONALLY (never instead of) rendered-prompt, only for stamped traffic.
 *  - "legacy-inexact": rows written before this discriminator existed (in-place migrated rows) or
 *    imported by the historical backfill importer. Real evidence, but deliberately never upgraded
 *    to look like a first-class rendered-prompt/canonical-raw row (#4 AC7) — disclosed as inexact
 *    on every read instead.
 */
export const TASK_EXPOSURE_IDENTITY_KINDS = ["rendered-prompt", "canonical-raw", "legacy-inexact"] as const;
export type TaskExposureIdentityKind = (typeof TASK_EXPOSURE_IDENTITY_KINDS)[number];
/** Identity kinds a lookup caller may query for; "legacy-inexact" is disclosure-only DB row data. */
export type TaskExposureQueryIdentityKind = Extract<TaskExposureIdentityKind, "rendered-prompt" | "canonical-raw">;

/**
 * A single generic bucket for every authenticated EXTERNAL-SURFACE producer receipt (gille#10;
 * exposure-receipt-intake.ts). Deliberately NOT added to `TASK_EXPOSURE_LANES`/`EvidenceLane`
 * above: those are gille's own gateway-controlled execution lanes (what `coverage.lanes`
 * documents as "declared gateway-controlled lanes"), and are also reused as-is by ledger.ts's
 * capability-evidence identity — an external Codex App/Codex CLI/Pi observation is neither. The
 * actual producer surface (codex_app / codex_cli / pi) is carried separately in the new
 * `external_surface` column/field below, so per-surface cross-surface lineage stays visible
 * without widening the shared gateway-lane vocabulary.
 */
export const TASK_EXPOSURE_EXTERNAL_LANE = "external-producer" as const;
/** The widened row-level lane type accepted by `recordTaskExposure` — every gateway lane, plus
 *  the one generic external-producer bucket. Never exported as part of `TaskExposureLane`/
 *  `EvidenceLane` (see above). */
export type TaskExposureRowLane = TaskExposureLane | typeof TASK_EXPOSURE_EXTERNAL_LANE;

export interface TaskFingerprint {
  version: typeof TASK_FINGERPRINT_VERSION;
  sha256: string;
}

export interface TaskExposureRecord {
  /**
   * The rendered/gateway-observed task text. Optional (gille#10): an authenticated
   * EXTERNAL-SURFACE producer receipt (Codex App/Codex CLI/Pi) never sends gille raw task
   * bytes at all — content-blind throughout — so it supplies ONLY `canonicalFingerprintSha256`
   * below and omits this field entirely. Every existing gateway-observed lane still supplies it
   * exactly as before; this widening is purely additive.
   */
  taskText?: string;
  lane: TaskExposureRowLane;
  modelId?: string | null;
  harnessId?: string | null;
  /** Stable for recovered/backfilled records; generated for an ordinary live event. */
  eventKey?: string;
  ts?: string;
  /**
   * Authoritative canonical logical-task identity (#4), taken directly from an admitted
   * LearningTaskContract Hugin request stamp's `raw_fingerprint.digest` OR (gille#10) an
   * authenticated external-surface producer receipt's own pre-computed `trim-utf8-sha256-v1`
   * digest over the same logical task text gille never sees. Absent/null for every unstamped
   * lane (chat, mcp-ask, plain delegate/code-loop) — those continue to record rendered-prompt
   * identity only, exactly as before. When present alongside `taskText`, recorded as a SEPARATE
   * "canonical-raw" row alongside (never replacing) the rendered-prompt row; when `taskText` is
   * absent (the external-producer case), this is the ONLY row recorded.
   */
  canonicalFingerprintSha256?: string | null;
  /**
   * The external producer surface this exposure was observed on (gille#10) — "codex_app",
   * "codex_cli", or "pi". null/omitted for every gateway-observed lane. Stored alongside (never
   * instead of) `lane`, which for every external-producer row is the generic
   * `TASK_EXPOSURE_EXTERNAL_LANE` bucket — this field is what actually distinguishes Codex App
   * from Codex CLI from Pi for cross-surface lineage.
   */
  externalSurface?: string | null;
}

/** One query item for the legacy `fingerprints` array — always "rendered-prompt", label-only. */
export interface TaskExposureCanonicalQuery {
  /** Caller's claimed canonical-raw digest. Verified against `exact_bytes` when supplied. */
  fingerprint_sha256: string;
  /**
   * Exact bytes the caller asserts hash to `fingerprint_sha256` under `trim-utf8-sha256-v1`.
   * Required for a trustworthy negative ("unseen") freshness claim (#4 AC2) — a bare label can
   * only ever support a positive `seen` result (see `unseen_claim_supported` on the result).
   */
  exact_bytes?: {
    encoding: "utf-8";
    /** Exact UTF-8 byte length of `text` as transmitted (pre-trim). Cross-checked server-side. */
    byte_length: number;
    text: string;
  };
}

export interface TaskExposureLookupRequest {
  fingerprint_version: typeof TASK_FINGERPRINT_VERSION;
  /** Rendered-prompt identity, label-only lookups. Unchanged wire shape/semantics from #257. */
  fingerprints: string[];
  /** Canonical-raw identity lookups (#4). Optional and additive; absent = no canonical queries. */
  canonical?: TaskExposureCanonicalQuery[];
}

export interface TaskExposureLookupResult {
  fingerprint_sha256: string;
  identity_kind: TaskExposureQueryIdentityKind;
  seen: boolean;
  first_seen_at: string | null;
  last_seen_at: string | null;
  lanes: string[];
  model_ids: string[];
  harness_ids: string[];
  /**
   * Fail-closed disclosure (#4 AC3): true only when a `seen: false` result on THIS row is
   * trustworthy evidence that the task was never previously exposed. False for every bare-label
   * lookup (canonical-raw without `exact_bytes`) and whenever live capture itself is unhealthy —
   * such a result may still report a real positive `seen: true` match, but callers MUST NOT treat
   * `seen: false` here as a freshness guarantee.
   */
  unseen_claim_supported: boolean;
  /** True when at least one contributing row predates the identity-kind discriminator (#4 AC7). */
  includes_legacy_inexact: boolean;
  /**
   * Every distinct external-producer surface ("codex_app" / "codex_cli" / "pi") that reported
   * this exact fingerprint (gille#10), sorted, deduplicated. Empty when every contributing row
   * came from a gille-observed gateway lane. This is what makes cross-surface reuse — "seen on
   * Codex AND Pi" — visible without ever storing raw task content: `lanes` already reports the
   * gateway lane(s) alongside this, so a mixed native+external match shows both.
   */
  external_surfaces: string[];
}

/** One coverage-epoch's boundary record — a restart/gap is measurable, not just felt (#4 AC "restart"). */
export interface TaskExposureCoverageEpoch {
  epochId: string;
  startedAt: string;
  previousEpochId: string | null;
  /** Last row timestamp observed in the previous epoch (or its own start, if it captured nothing). */
  previousEpochLastSeenAt: string | null;
  /** Wall-clock gap between the previous epoch's last known liveness and this epoch's start. */
  gapMs: number | null;
}

/**
 * Direct-loopback capture/exclusion contract (#4; grimnir docs/learning-task-contract.md "Exposure
 * facts"). Raw inference traffic sent straight to the local runtime (llama-swap), bypassing this
 * authenticated gateway entirely, never reaches recordTaskExposureBestEffort — every capture path
 * in this file is only reachable from an authenticated gateway/MCP/code-loop request handler, so
 * the gateway cannot retroactively observe traffic it never received.
 *
 * Decision: EXCLUDE, disclosed — not silently included. A holdout candidate must not be judged
 * "unseen" against loopback traffic that was structurally never captured. Closing this gap means
 * routing that traffic through one of the six declared lanes, never inventing a seventh implicit
 * channel or quietly counting the gap as covered.
 */
export const DIRECT_LOOPBACK_TRAFFIC_DISCLOSURE = {
  captured: false,
  reason:
    "raw loopback calls sent directly to the local runtime, bypassing the authenticated gateway, fall outside all six declared lanes and are structurally uncapturable here; treat any holdout window as EXCLUDING this traffic, never as covering it",
} as const;

/**
 * Exact-match limits disclosure (#4; Non-goal: "Treating embedding similarity as definitive
 * contamination proof"). Both identity kinds are exact post-trim UTF-8 byte-hash matches and
 * nothing more: no Unicode normalization, no paraphrase/translation detection, no embeddings.
 * A `seen: false` result proves only that this exact byte form was not recorded — never that the
 * task is semantically fresh.
 */
export const EXACT_MATCH_SEMANTICS_DISCLOSURE = {
  contamination_proof: false,
  scope:
    "exact post-trim UTF-8 byte-hash match only (rendered-prompt and canonical-raw alike); does not detect Unicode-normalized equivalents, paraphrase, translation, or other semantic exposure",
} as const;

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
    /** Current coverage epoch (#4). A restart mints a new id — see `restart_count`/`*_gap_ms`. */
    coverage_epoch_id: string;
    /** How many epoch transitions (restarts / recovered write gaps) this registry has ever had. */
    restart_count: number;
    /** Sum of every measured restart-boundary gap, in milliseconds — the queryable "candidate loss
     *  at coverage boundaries" counter (#4). Zero means no restart has ever moved the boundary. */
    total_restart_gap_ms: number;
    /** When canonical-raw identity capture became possible on this deployment; null only if the
     *  schema has genuinely never been initialized (should not occur past `ensureTaskExposureSchema`). */
    canonical_identity_capture_started_at: string | null;
    direct_loopback_traffic: typeof DIRECT_LOOPBACK_TRAFFIC_DISCLOSURE;
    exact_match_semantics: typeof EXACT_MATCH_SEMANTICS_DISCLOSURE;
    /**
     * Queryable producer-heartbeat health per registered external surface (gille#10) — "a
     * queryable field beats a dashboard", same house style as the coverage-epoch counters above.
     * A surface only appears once some principal has ever reported a receipt/heartbeat for it;
     * an unregistered surface never blocks anything (there is no expectation of coverage for a
     * surface nobody has ever wired up). `healthy` is true when AT LEAST ONE principal for that
     * surface has heartbeated within `EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS`.
     */
    external_producer_heartbeats: ExternalProducerSurfaceHeartbeatStatus[];
    /** False whenever any REGISTERED external surface's heartbeat is missing/stale (gille#10 AC2)
     *  — see `unseen_claim_supported` below, which is fail-closed gated on this too. */
    external_producer_heartbeats_healthy: boolean;
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
  identity_kind: string;
  external_surface: string | null;
}

/** Missing/stale threshold for an external producer's heartbeat (gille#10 AC2). Deliberately
 *  generous — Codex App/Codex CLI/Pi sessions are bursty, not continuously polling — but still a
 *  real fail-closed bound: past this, a registered surface can no longer support an "unseen"
 *  claim anywhere in the registry, since the silent producer might have seen the task itself. */
export const EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS = 24 * 60 * 60 * 1000;

export interface ExternalProducerHeartbeatStatus {
  surface: string;
  principalAlias: string;
  lastHeartbeatAt: string;
  healthy: boolean;
}

export interface ExternalProducerSurfaceHeartbeatStatus {
  surface: string;
  healthy: boolean;
  /** Most recent heartbeat across every principal reporting for this surface. */
  last_heartbeat_at: string;
  principals: Array<{ principal_alias: string; last_heartbeat_at: string; healthy: boolean }>;
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
      harness_id         TEXT,
      identity_kind       TEXT NOT NULL DEFAULT 'legacy-inexact',
      coverage_epoch_id   TEXT NOT NULL DEFAULT 'legacy-pre-epoch'
    );
    CREATE INDEX IF NOT EXISTS idx_task_exposure_fingerprint
      ON task_exposure_events(fingerprint_version, fingerprint_sha256, ts);

    CREATE TABLE IF NOT EXISTS task_exposure_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_exposure_coverage_epochs (
      epoch_id                     TEXT PRIMARY KEY,
      started_at                   TEXT NOT NULL,
      previous_epoch_id            TEXT,
      previous_epoch_last_seen_at  TEXT,
      gap_ms                       INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_task_exposure_epochs_started
      ON task_exposure_coverage_epochs(started_at);

    -- External-surface producer heartbeats (gille#10). One row per (surface, principal) —
    -- a surface is heartbeat-healthy when AT LEAST ONE of its principals is fresh.
    CREATE TABLE IF NOT EXISTS task_exposure_external_heartbeats (
      surface            TEXT NOT NULL,
      principal_alias    TEXT NOT NULL,
      last_heartbeat_at  TEXT NOT NULL,
      PRIMARY KEY (surface, principal_alias)
    );
  `);
  // Additive column migration (#4) for DBs created before the identity-kind/coverage-epoch
  // discriminators existed — same guarded ALTER TABLE idiom as ledger.ts's node_id/shadow columns.
  // A pre-existing row predates ANY discriminated identity and is disclosed as 'legacy-inexact'
  // (#4 AC7): not silently upgraded to look like a first-class rendered-prompt/canonical-raw row.
  const cols = db.prepare(`PRAGMA table_info(task_exposure_events)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  db.transaction(() => {
    if (!names.has("identity_kind")) {
      db.exec(`ALTER TABLE task_exposure_events ADD COLUMN identity_kind TEXT NOT NULL DEFAULT 'legacy-inexact'`);
    }
    if (!names.has("coverage_epoch_id")) {
      db.exec(`ALTER TABLE task_exposure_events ADD COLUMN coverage_epoch_id TEXT NOT NULL DEFAULT 'legacy-pre-epoch'`);
    }
    if (!names.has("external_surface")) {
      // gille#10: nullable — only externally-sourced (identity_kind='canonical-raw', lane=
      // TASK_EXPOSURE_EXTERNAL_LANE) rows ever populate this; every pre-existing and every
      // gateway-observed row stays NULL.
      db.exec(`ALTER TABLE task_exposure_events ADD COLUMN external_surface TEXT`);
    }
  })();
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_task_exposure_identity
      ON task_exposure_events(identity_kind, fingerprint_version, fingerprint_sha256, ts);
    CREATE INDEX IF NOT EXISTS idx_task_exposure_epoch
      ON task_exposure_events(coverage_epoch_id, ts);
  `);
  db.prepare(
    `INSERT OR IGNORE INTO task_exposure_meta (key, value) VALUES ('live_capture_started_at', ?)`
  ).run(nowIso);
  // First moment canonical-raw identity capture became possible on this deployment (#4). Set once,
  // ever, via INSERT OR IGNORE — unlike live_capture_started_at this does NOT reset on restart; it
  // answers "since when could a canonical-raw row exist at all", not "since when is this epoch live".
  db.prepare(
    `INSERT OR IGNORE INTO task_exposure_meta (key, value) VALUES ('canonical_identity_capture_started_at', ?)`
  ).run(nowIso);
  initialized.add(db);
  bootstrapCoverageEpoch(db, nowIso);
}

/** Lazily mints coverage epoch #1 exactly once per DB (idempotent; a genuine restart never calls
 *  this — it calls `rotateCoverageEpoch` instead, from `initializeTaskExposureRegistry`). */
function bootstrapCoverageEpoch(db: Database.Database, nowIso: string): void {
  if (metaGet(db, "current_coverage_epoch_id") !== null) return;
  const epochId = `epoch:${randomUUID()}`;
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO task_exposure_coverage_epochs
         (epoch_id, started_at, previous_epoch_id, previous_epoch_last_seen_at, gap_ms)
       VALUES (@epochId, @startedAt, NULL, NULL, NULL)`
    ).run({ epochId, startedAt: nowIso });
    metaSet(db, "current_coverage_epoch_id", epochId);
  })();
}

/**
 * Mint a new coverage epoch on a genuine restart (#4). Measures the honest gap between the
 * previous epoch's last known liveness (its last recorded row, or its own start if it captured
 * nothing) and this epoch's start — the queryable "restart-induced boundary movement" the issue
 * asks for. Only `initializeTaskExposureRegistry` calls this; plain `ensureTaskExposureSchema`
 * calls (e.g. every `recordTaskExposure` in tests) never rotate an epoch on their own.
 */
function rotateCoverageEpoch(db: Database.Database, nowIso: string): void {
  // The MAX(ts) read, the previous-epoch read, and the new-epoch insert+meta-write run inside ONE
  // IMMEDIATE transaction (same idiom as learning-task-admission-store.ts's claimLearningTaskAdmission)
  // so a concurrent writer on another gateway process cannot land a row between the read and the
  // write and silently understate gap_ms — the SQLite writer lock is acquired before the read.
  db.transaction(() => {
    const previousEpochId = metaGet(db, "current_coverage_epoch_id");
    if (previousEpochId === null) return; // defensive; ensureTaskExposureSchema always sets this first
    const lastRow = db.prepare(
      `SELECT MAX(ts) AS ts FROM task_exposure_events WHERE coverage_epoch_id = ?`
    ).get(previousEpochId) as { ts: string | null };
    const previousEpochMeta = db.prepare(
      `SELECT started_at FROM task_exposure_coverage_epochs WHERE epoch_id = ?`
    ).get(previousEpochId) as { started_at: string } | undefined;
    const previousEpochLastSeenAt = lastRow.ts ?? previousEpochMeta?.started_at ?? null;
    const gapMs = previousEpochLastSeenAt === null
      ? null
      : Math.max(0, Date.parse(nowIso) - Date.parse(previousEpochLastSeenAt));
    const newEpochId = `epoch:${randomUUID()}`;
    db.prepare(
      `INSERT INTO task_exposure_coverage_epochs
         (epoch_id, started_at, previous_epoch_id, previous_epoch_last_seen_at, gap_ms)
       VALUES (@epochId, @startedAt, @previousEpochId, @previousEpochLastSeenAt, @gapMs)`
    ).run({ epochId: newEpochId, startedAt: nowIso, previousEpochId, previousEpochLastSeenAt, gapMs });
    metaSet(db, "current_coverage_epoch_id", newEpochId);
  }).immediate();
}

function currentCoverageEpochId(db: Database.Database): string {
  const id = metaGet(db, "current_coverage_epoch_id");
  if (id === null) {
    throw new Error("task exposure coverage epoch metadata is missing (schema not initialized)");
  }
  return id;
}

/** Queryable view over every coverage-epoch transition — "a queryable field beats a dashboard". */
export function listTaskExposureCoverageEpochs(
  db: Database.Database = getDb()
): TaskExposureCoverageEpoch[] {
  ensureTaskExposureSchema(db);
  const rows = db.prepare(
    `SELECT epoch_id, started_at, previous_epoch_id, previous_epoch_last_seen_at, gap_ms
       FROM task_exposure_coverage_epochs
      ORDER BY started_at, epoch_id`
  ).all() as Array<{
    epoch_id: string;
    started_at: string;
    previous_epoch_id: string | null;
    previous_epoch_last_seen_at: string | null;
    gap_ms: number | null;
  }>;
  return rows.map((row) => ({
    epochId: row.epoch_id,
    startedAt: row.started_at,
    previousEpochId: row.previous_epoch_id,
    previousEpochLastSeenAt: row.previous_epoch_last_seen_at,
    gapMs: row.gap_ms,
  }));
}

/**
 * Record (or refresh) an external producer's heartbeat for one surface (gille#10). Called both
 * whenever a receipt is admitted (evidence of liveness) AND from an explicit lightweight
 * heartbeat call with no exposure to report (an idle Codex App/Codex CLI/Pi session) — the two
 * are the same primitive. A stamp older than the current row is ignored (`MAX`, not overwrite) so
 * an out-of-order retry can never move a healthy heartbeat backwards into staleness.
 */
export function recordExternalProducerHeartbeat(
  input: { surface: string; principalAlias: string; ts?: string },
  db: Database.Database = getDb()
): void {
  ensureTaskExposureSchema(db);
  const ts = input.ts ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO task_exposure_external_heartbeats (surface, principal_alias, last_heartbeat_at)
     VALUES (@surface, @principalAlias, @ts)
     ON CONFLICT(surface, principal_alias) DO UPDATE SET
       last_heartbeat_at = CASE
         WHEN excluded.last_heartbeat_at > task_exposure_external_heartbeats.last_heartbeat_at
         THEN excluded.last_heartbeat_at
         ELSE task_exposure_external_heartbeats.last_heartbeat_at
       END`
  ).run({ surface: input.surface, principalAlias: input.principalAlias, ts });
}

/** Every registered (surface, principal) heartbeat with its computed health (gille#10). */
export function listExternalProducerHeartbeats(
  db: Database.Database = getDb(),
  nowIso: string = new Date().toISOString(),
  staleMs: number = EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS
): ExternalProducerHeartbeatStatus[] {
  ensureTaskExposureSchema(db);
  const rows = db.prepare(
    `SELECT surface, principal_alias, last_heartbeat_at
       FROM task_exposure_external_heartbeats
      ORDER BY surface, principal_alias`
  ).all() as Array<{ surface: string; principal_alias: string; last_heartbeat_at: string }>;
  const nowMs = Date.parse(nowIso);
  return rows.map((row) => ({
    surface: row.surface,
    principalAlias: row.principal_alias,
    lastHeartbeatAt: row.last_heartbeat_at,
    healthy: nowMs - Date.parse(row.last_heartbeat_at) <= staleMs,
  }));
}

/**
 * Roll the per-principal heartbeat rows up to one status per surface (gille#10 AC2): a surface is
 * healthy when AT LEAST ONE of its registered principals is currently fresh — a retired/replaced
 * subscription that never reports again must not permanently poison a surface still actively
 * covered by another principal.
 */
export function externalProducerSurfaceHeartbeats(
  db: Database.Database = getDb(),
  nowIso: string = new Date().toISOString(),
  staleMs: number = EXTERNAL_EXPOSURE_HEARTBEAT_STALE_MS
): ExternalProducerSurfaceHeartbeatStatus[] {
  const statuses = listExternalProducerHeartbeats(db, nowIso, staleMs);
  const bySurface = new Map<string, ExternalProducerHeartbeatStatus[]>();
  for (const status of statuses) {
    const list = bySurface.get(status.surface) ?? [];
    list.push(status);
    bySurface.set(status.surface, list);
  }
  return [...bySurface.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([surface, principals]) => {
    const lastHeartbeatAt = principals.map((p) => p.lastHeartbeatAt).sort().at(-1)!;
    return {
      surface,
      healthy: principals.some((p) => p.healthy),
      last_heartbeat_at: lastHeartbeatAt,
      principals: principals
        .map((p) => ({ principal_alias: p.principalAlias, last_heartbeat_at: p.lastHeartbeatAt, healthy: p.healthy }))
        .sort((a, b) => a.principal_alias.localeCompare(b.principal_alias)),
    };
  });
}

function cleanMetadataId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "unknown" || trimmed === "none") return null;
  // Metadata is returned by the lookup. Bound it even though production callers pass trusted ids.
  return trimmed.slice(0, 160);
}

/**
 * Insert one exposure event. When `input.canonicalFingerprintSha256` is present ALONGSIDE
 * `input.taskText`, records BOTH identities (#4): a "rendered-prompt" row (unchanged #257
 * behavior) AND a separate "canonical-raw" row sharing the same lane/model/harness/ts/epoch
 * metadata. `identityKindOverride` lets the historical backfill importer (which has neither a
 * live epoch nor a canonical identity) mark its rows 'legacy-inexact' instead of 'rendered-prompt'
 * — see the identity-kind doc comment above.
 *
 * gille#10: when `input.taskText` is ABSENT (the authenticated external-surface producer-receipt
 * path — content-blind, gille never receives raw task bytes at all), the rendered-prompt row is
 * skipped entirely and `canonicalFingerprintSha256` is REQUIRED — it is the only identity such a
 * receipt can ever carry.
 */
function insertExposure(
  db: Database.Database,
  input: TaskExposureRecord,
  eventKey: string,
  ts: string,
  identityKindOverride: Extract<TaskExposureIdentityKind, "rendered-prompt" | "legacy-inexact"> = "rendered-prompt"
): boolean {
  if (input.taskText === undefined && !input.canonicalFingerprintSha256) {
    throw new Error("recordTaskExposure requires taskText and/or canonicalFingerprintSha256");
  }
  const epochId = identityKindOverride === "legacy-inexact" ? "legacy-pre-epoch" : currentCoverageEpochId(db);
  const modelId = cleanMetadataId(input.modelId);
  const harnessId = cleanMetadataId(input.harnessId);
  const externalSurface = cleanMetadataId(input.externalSurface);
  const insertRow = (
    key: string,
    version: string,
    sha256: string,
    identityKind: TaskExposureIdentityKind
  ): boolean => db.prepare(
    `INSERT OR IGNORE INTO task_exposure_events
       (event_key, ts, fingerprint_version, fingerprint_sha256, lane, model_id, harness_id, identity_kind, coverage_epoch_id, external_surface)
     VALUES
       (@eventKey, @ts, @version, @sha256, @lane, @modelId, @harnessId, @identityKind, @epochId, @externalSurface)`
  ).run({
    eventKey: key,
    ts,
    version,
    sha256,
    lane: input.lane,
    modelId,
    harnessId,
    identityKind,
    epochId,
    externalSurface,
  }).changes > 0;

  let inserted = false;

  if (input.taskText !== undefined) {
    const canonical = canonicalTaskText(input.taskText);
    if (canonical === "" && !input.canonicalFingerprintSha256) return false;
    if (canonical !== "") {
      const fingerprint = taskTextFingerprint(canonical);
      inserted = insertRow(`${eventKey}#${identityKindOverride}`, fingerprint.version, fingerprint.sha256, identityKindOverride);
    }
  }

  if (input.canonicalFingerprintSha256) {
    if (!SHA256_RE.test(input.canonicalFingerprintSha256)) {
      throw new Error("canonical task fingerprint must be a lowercase 64-character SHA-256 hex string");
    }
    // Trust boundary (#4/#10): the WRITE side trusts an already-authenticated/admitted stamp's
    // raw_fingerprint.digest, or an authenticated external-surface producer receipt's own
    // pre-computed digest (validated upstream — validateHuginRequestStamp + the admission claim
    // for Hugin, ingestExposureReceipt's schema+auth checks for an external producer). The READ
    // side never extends that trust to an arbitrary lookup caller — see
    // parseTaskExposureLookupRequest's exact_bytes recomputation below.
    const canonicalInserted = insertRow(
      `${eventKey}#canonical-raw`,
      TASK_FINGERPRINT_VERSION,
      input.canonicalFingerprintSha256,
      "canonical-raw"
    );
    inserted = inserted || canonicalInserted;
  }
  return inserted;
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
      }, `backfill:owner-request:${row.id}:user:${i}:${TASK_FINGERPRINT_VERSION}`, row.ts, "legacy-inexact")) imported++;
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
    }, `backfill:delegation:${row.id}:${TASK_FINGERPRINT_VERSION}`, row.ts, "legacy-inexact")) imported++;
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
  // Detected BEFORE ensureTaskExposureSchema (which would otherwise lazily set this on a truly
  // fresh DB): a value already present means this is a genuine restart, not the first-ever boot,
  // and warrants a real coverage-epoch rotation (#4) rather than the bootstrap no-op.
  const isRestart = tableExists(db, "task_exposure_meta") && metaGet(db, "live_capture_started_at") !== null;
  ensureTaskExposureSchema(db, nowIso);
  if (isRestart) rotateCoverageEpoch(db, nowIso);
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
  // `fingerprints` may be empty (a caller doing a canonical-only lookup) — but see the combined
  // "at least one query total" check below, which preserves the original non-empty-request rule.
  const raw = obj["fingerprints"];
  if (!Array.isArray(raw) || raw.length > TASK_EXPOSURE_LOOKUP_MAX) {
    return {
      ok: false,
      message: `fingerprints must contain 0-${TASK_EXPOSURE_LOOKUP_MAX} SHA-256 values.`,
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

  let canonical: TaskExposureCanonicalQuery[] | undefined;
  const rawCanonical = obj["canonical"];
  if (rawCanonical !== undefined) {
    if (!Array.isArray(rawCanonical) || rawCanonical.length < 1 || rawCanonical.length > TASK_EXPOSURE_LOOKUP_MAX) {
      return {
        ok: false,
        message: `canonical must contain 1-${TASK_EXPOSURE_LOOKUP_MAX} queries.`,
        param: "canonical",
      };
    }
    const parsed: TaskExposureCanonicalQuery[] = [];
    for (let i = 0; i < rawCanonical.length; i++) {
      const item = rawCanonical[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        return { ok: false, message: `canonical[${i}] must be an object.`, param: "canonical" };
      }
      const o = item as Record<string, unknown>;
      const label = o["fingerprint_sha256"];
      if (typeof label !== "string" || !SHA256_RE.test(label)) {
        return {
          ok: false,
          message: `canonical[${i}].fingerprint_sha256 must be a lowercase 64-character SHA-256 hex string.`,
          param: "canonical",
        };
      }
      let exactBytes: TaskExposureCanonicalQuery["exact_bytes"];
      if (o["exact_bytes"] !== undefined) {
        const eb = o["exact_bytes"];
        if (eb === null || typeof eb !== "object" || Array.isArray(eb)) {
          return { ok: false, message: `canonical[${i}].exact_bytes must be an object.`, param: "canonical" };
        }
        const ebo = eb as Record<string, unknown>;
        if (ebo["encoding"] !== "utf-8") {
          return { ok: false, message: `canonical[${i}].exact_bytes.encoding must be 'utf-8'.`, param: "canonical" };
        }
        if (typeof ebo["text"] !== "string" || ebo["text"].length === 0) {
          return { ok: false, message: `canonical[${i}].exact_bytes.text must be a non-empty string.`, param: "canonical" };
        }
        const text = ebo["text"];
        const declaredLength = ebo["byte_length"];
        const actualLength = Buffer.byteLength(text, "utf8");
        // Byte-vector integrity (#4 AC2): the declared length must match the ACTUAL exact UTF-8
        // byte length of the transmitted text — catches truncation/encoding mismatches up front.
        if (typeof declaredLength !== "number" || !Number.isInteger(declaredLength) || declaredLength !== actualLength) {
          return {
            ok: false,
            message: `canonical[${i}].exact_bytes.byte_length does not match the exact UTF-8 byte length of 'text'.`,
            param: "canonical",
          };
        }
        // Recomputation, not label trust (#4 AC2): the caller's claimed fingerprint_sha256 is
        // ONLY accepted when it equals the digest gille independently recomputes from the exact
        // bytes it was just given — never accepted as a bare assertion for a negative claim.
        const recomputed = taskTextFingerprint(text);
        if (recomputed.sha256 !== label) {
          return {
            ok: false,
            message: `canonical[${i}].fingerprint_sha256 does not match the recomputed trim-utf8-sha256-v1 digest of the supplied exact bytes.`,
            param: "canonical",
          };
        }
        exactBytes = { encoding: "utf-8", byte_length: actualLength, text };
      }
      parsed.push({ fingerprint_sha256: label, ...(exactBytes ? { exact_bytes: exactBytes } : {}) });
    }
    if (new Set(parsed.map((q) => q.fingerprint_sha256)).size !== parsed.length) {
      return { ok: false, message: "canonical fingerprints must not contain duplicates.", param: "canonical" };
    }
    canonical = parsed;
  }

  if (fingerprints.length + (canonical?.length ?? 0) < 1) {
    return {
      ok: false,
      message: "At least one 'fingerprints' or 'canonical' query is required.",
      param: null,
    };
  }

  return {
    ok: true,
    value: {
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints,
      ...(canonical ? { canonical } : {}),
    },
  };
}

/** Batched lookup of one identity-kind group, matching legacy rows into "rendered-prompt" queries. */
function findExposureRows(
  db: Database.Database,
  version: string,
  queryKind: TaskExposureQueryIdentityKind,
  fingerprints: string[]
): Map<string, ExposureDbRow[]> {
  const map = new Map<string, ExposureDbRow[]>();
  if (fingerprints.length === 0) return map;
  // A rendered-prompt query also matches pre-discriminator legacy rows (#4 AC7): they ARE
  // historical rendered-prompt-shaped evidence, just recorded before the discriminator existed.
  // A canonical-raw query matches ONLY canonical-raw rows — legacy rows never had that identity.
  const identityKinds: string[] = queryKind === "rendered-prompt"
    ? ["rendered-prompt", "legacy-inexact"]
    : ["canonical-raw"];
  const fpPlaceholders = fingerprints.map(() => "?").join(",");
  const kindPlaceholders = identityKinds.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT fingerprint_sha256, ts, lane, model_id, harness_id, identity_kind, external_surface
       FROM task_exposure_events
      WHERE fingerprint_version = ? AND identity_kind IN (${kindPlaceholders}) AND fingerprint_sha256 IN (${fpPlaceholders})
      ORDER BY ts, event_key`
  ).all(version, ...identityKinds, ...fingerprints) as ExposureDbRow[];
  for (const row of rows) {
    const list = map.get(row.fingerprint_sha256) ?? [];
    list.push(row);
    map.set(row.fingerprint_sha256, list);
  }
  return map;
}

function buildLookupResult(
  fingerprint: string,
  identityKind: TaskExposureQueryIdentityKind,
  found: ExposureDbRow[],
  unseenClaimSupported: boolean
): TaskExposureLookupResult {
  return {
    fingerprint_sha256: fingerprint,
    identity_kind: identityKind,
    seen: found.length > 0,
    first_seen_at: found[0]?.ts ?? null,
    last_seen_at: found.at(-1)?.ts ?? null,
    lanes: [...new Set(found.map((row) => row.lane))].sort(),
    model_ids: [...new Set(found.map((row) => row.model_id).filter((v): v is string => v !== null))].sort(),
    harness_ids: [...new Set(found.map((row) => row.harness_id).filter((v): v is string => v !== null))].sort(),
    unseen_claim_supported: unseenClaimSupported,
    includes_legacy_inexact: found.some((row) => row.identity_kind === "legacy-inexact"),
    external_surfaces: [...new Set(found.map((row) => row.external_surface).filter((v): v is string => v !== null))].sort(),
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

  // gille#10 AC2: a missing/stale external-producer heartbeat is a SEPARATE fail-closed gate from
  // captureHealthy above (a healthy local DB write path says nothing about whether a registered
  // Codex App/Codex CLI/Pi producer has gone silent and might be sitting on an unreported
  // exposure). Only REGISTERED surfaces count — one nobody has ever wired up cannot block
  // anything, since there is no expectation of coverage for it at all.
  const externalSurfaceHeartbeats = externalProducerSurfaceHeartbeats(db, nowIso);
  const externalHeartbeatsHealthy = externalSurfaceHeartbeats.every((s) => s.healthy);
  if (!externalHeartbeatsHealthy) {
    reasons.push("one or more registered external exposure producers have a missing or stale heartbeat");
  }
  const unseenClaimHealthy = captureHealthy && externalHeartbeatsHealthy;

  const canonicalIdentityCaptureStartedAt = metaGet(db, "canonical_identity_capture_started_at");

  const renderedFound = findExposureRows(db, request.fingerprint_version, "rendered-prompt", request.fingerprints);
  const renderedResults = request.fingerprints.map((fingerprint) =>
    buildLookupResult(fingerprint, "rendered-prompt", renderedFound.get(fingerprint) ?? [], unseenClaimHealthy)
  );

  const canonicalQueries = request.canonical ?? [];
  const canonicalFound = findExposureRows(
    db,
    request.fingerprint_version,
    "canonical-raw",
    canonicalQueries.map((q) => q.fingerprint_sha256)
  );
  const canonicalResults = canonicalQueries.map((query) => {
    // Fail-closed disclosure (#4 AC2/AC3, gille#10 AC2): a bare label (no verified exact_bytes)
    // NEVER supports a negative claim, regardless of how healthy live capture otherwise is; nor
    // does a healthy bare-label-verified query when a registered external producer has gone dark.
    const unseenClaimSupported = unseenClaimHealthy
      && query.exact_bytes !== undefined
      && canonicalIdentityCaptureStartedAt !== null;
    return buildLookupResult(
      query.fingerprint_sha256,
      "canonical-raw",
      canonicalFound.get(query.fingerprint_sha256) ?? [],
      unseenClaimSupported
    );
  });

  const currentEpochId = currentCoverageEpochId(db);
  const epochStats = db.prepare(
    `SELECT COUNT(*) AS restarts, COALESCE(SUM(gap_ms), 0) AS totalGapMs
       FROM task_exposure_coverage_epochs WHERE previous_epoch_id IS NOT NULL`
  ).get() as { restarts: number; totalGapMs: number };

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
      coverage_epoch_id: currentEpochId,
      restart_count: epochStats.restarts,
      total_restart_gap_ms: epochStats.totalGapMs,
      canonical_identity_capture_started_at: canonicalIdentityCaptureStartedAt,
      direct_loopback_traffic: DIRECT_LOOPBACK_TRAFFIC_DISCLOSURE,
      exact_match_semantics: EXACT_MATCH_SEMANTICS_DISCLOSURE,
      external_producer_heartbeats: externalSurfaceHeartbeats,
      external_producer_heartbeats_healthy: externalHeartbeatsHealthy,
    },
    results: [...renderedResults, ...canonicalResults],
  };
}
