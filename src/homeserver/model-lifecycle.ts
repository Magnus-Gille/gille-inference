/**
 * Content-blind model lifecycle observations.
 *
 * This module intentionally stops at a small SQLite event store and a pure
 * snapshot diff. It does not know how snapshots are polled, and it does not
 * classify a disappearance as a crash, restart, or any other cause.
 */

import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export const MODEL_LIFECYCLE_EVENTS = ["load", "ready", "unload", "disappeared"] as const;
export type ModelLifecycleEventName = (typeof MODEL_LIFECYCLE_EVENTS)[number];

/** The only cause this first observation path is allowed to persist. */
export const MODEL_LIFECYCLE_CAUSE = "snapshot" as const;
export type ModelLifecycleCause = typeof MODEL_LIFECYCLE_CAUSE;

export const MODEL_LIFECYCLE_TABLE = "model_lifecycle_events" as const;
export const MODEL_LIFECYCLE_COLUMNS = [
  "ts",
  "model",
  "event",
  "state",
  "ttl_seconds",
  "cause",
] as const;

/** The complete, already-sanitized backend observation accepted by reconciliation. */
export interface SanitizedModelSnapshotEntry {
  readonly model: string;
  readonly state: string;
  readonly ttlSeconds: number | null;
}

/** A pure transition result. The timestamp is supplied only by the persistence seam. */
export interface ModelLifecycleTransition {
  readonly model: string;
  readonly event: ModelLifecycleEventName;
  readonly state: string;
  readonly ttlSeconds: number | null;
  readonly cause: ModelLifecycleCause;
}

/** One persisted row. No field outside this interface is accepted at the store boundary. */
export interface ModelLifecycleEvent extends ModelLifecycleTransition {
  readonly ts: string;
}

interface ModelLifecycleRow {
  ts: string;
  model: string;
  event: ModelLifecycleEventName;
  state: string;
  ttl_seconds: number | null;
  cause: ModelLifecycleCause;
}

const initialized = new WeakSet<Database.Database>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} contains fields outside the content-blind lifecycle contract`);
  }
}

function assertSafeModel(model: unknown): asserts model is string {
  if (typeof model !== "string" || model.length === 0 || model.trim() !== model) {
    throw new TypeError("model must be a non-empty canonical model string");
  }
}

function assertSafeState(state: unknown): asserts state is string {
  if (typeof state !== "string" || state.length === 0 || state.trim() !== state) {
    throw new TypeError("state must be a non-empty observed state string");
  }
}

function assertSafeTtl(ttlSeconds: unknown): asserts ttlSeconds is number | null {
  if (
    ttlSeconds !== null &&
    (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds < 0)
  ) {
    throw new TypeError("ttlSeconds must be null or a finite non-negative number");
  }
}

function copySnapshotEntry(value: unknown): SanitizedModelSnapshotEntry {
  if (!isRecord(value)) {
    throw new TypeError("snapshot entries must be objects");
  }
  assertExactKeys(value, ["model", "state", "ttlSeconds"], "snapshot entry");
  assertSafeModel(value.model);
  assertSafeState(value.state);
  assertSafeTtl(value.ttlSeconds);
  return {
    model: value.model,
    state: value.state,
    ttlSeconds: value.ttlSeconds,
  };
}

function copySnapshot(snapshot: readonly SanitizedModelSnapshotEntry[]): SanitizedModelSnapshotEntry[] {
  if (!Array.isArray(snapshot)) {
    throw new TypeError("snapshot must be an array of sanitized model entries");
  }

  const copied = snapshot.map(copySnapshotEntry);
  const models = new Set<string>();
  for (const entry of copied) {
    if (models.has(entry.model)) {
      throw new TypeError(`snapshot contains duplicate canonical model ${entry.model}`);
    }
    models.add(entry.model);
  }
  return copied;
}

function eventForObservedState(state: string): ModelLifecycleEventName {
  if (state === "ready") return "ready";
  if (state === "unload" || state === "unloading" || state === "unloaded") return "unload";
  // Presence or a changed non-ready observation is recorded as load. The
  // observed state itself is copied verbatim, including "unknown"; this
  // event name is never a crash/restart diagnosis.
  return "load";
}

function sameSnapshotEntry(a: SanitizedModelSnapshotEntry, b: SanitizedModelSnapshotEntry): boolean {
  return a.model === b.model && a.state === b.state && a.ttlSeconds === b.ttlSeconds;
}

/**
 * Compare two sanitized snapshots without reading time, the database, or any
 * backend state. Exact unchanged observations produce no event.
 *
 * A current entry that was not previously present is a load/ready/unload
 * observation according to its observed state. A current entry that is absent
 * is `disappeared` with state/TTL unknown because no current state was observed.
 */
export function reconcileModelLifecycleSnapshots(
  priorSnapshot: readonly SanitizedModelSnapshotEntry[],
  currentSnapshot: readonly SanitizedModelSnapshotEntry[],
): ModelLifecycleTransition[] {
  const prior = copySnapshot(priorSnapshot);
  const current = copySnapshot(currentSnapshot);
  const priorByModel = new Map(prior.map((entry) => [entry.model, entry]));
  const currentByModel = new Map(current.map((entry) => [entry.model, entry]));
  const transitions: ModelLifecycleTransition[] = [];

  // Preserve the current snapshot's order for present entries. This keeps the
  // function deterministic without introducing a second ordering key.
  for (const entry of current) {
    const previous = priorByModel.get(entry.model);
    if (previous && sameSnapshotEntry(previous, entry)) continue;
    transitions.push({
      model: entry.model,
      event: eventForObservedState(entry.state),
      state: entry.state,
      ttlSeconds: entry.ttlSeconds,
      cause: MODEL_LIFECYCLE_CAUSE,
    });
  }

  // Absence is all that can be proven here. It is deliberately not promoted
  // to crash, restart, or another inferred cause.
  for (const previous of prior) {
    if (currentByModel.has(previous.model)) continue;
    transitions.push({
      model: previous.model,
      event: "disappeared",
      state: "unknown",
      ttlSeconds: null,
      cause: MODEL_LIFECYCLE_CAUSE,
    });
  }

  return transitions;
}

function validateEvent(value: unknown): ModelLifecycleEvent {
  if (!isRecord(value)) {
    throw new TypeError("lifecycle event must be an object");
  }
  assertExactKeys(value, ["ts", "model", "event", "state", "ttlSeconds", "cause"], "lifecycle event");
  if (typeof value.ts !== "string" || value.ts.length === 0) {
    throw new TypeError("ts must be a non-empty string");
  }
  assertSafeModel(value.model);
  assertSafeState(value.state);
  assertSafeTtl(value.ttlSeconds);
  if (
    typeof value.event !== "string" ||
    !(MODEL_LIFECYCLE_EVENTS as readonly string[]).includes(value.event)
  ) {
    throw new TypeError("event is outside the fixed lifecycle event set");
  }
  if (value.cause !== MODEL_LIFECYCLE_CAUSE) {
    throw new TypeError("cause is fixed to snapshot reconciliation");
  }
  return {
    ts: value.ts,
    model: value.model,
    event: value.event as ModelLifecycleEventName,
    state: value.state,
    ttlSeconds: value.ttlSeconds,
    cause: MODEL_LIFECYCLE_CAUSE,
  };
}

function schemaColumns(db: Database.Database): string[] {
  return (db.prepare(`PRAGMA table_info(${MODEL_LIFECYCLE_TABLE})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MODEL_LIFECYCLE_TABLE} (
      ts          TEXT NOT NULL,
      model       TEXT NOT NULL,
      event       TEXT NOT NULL CHECK (event IN ('load', 'ready', 'unload', 'disappeared')),
      state       TEXT NOT NULL,
      ttl_seconds REAL,
      cause       TEXT NOT NULL CHECK (cause = 'snapshot')
    );
  `);

  const columns = schemaColumns(db);
  if (columns.length !== MODEL_LIFECYCLE_COLUMNS.length ||
      columns.some((column, index) => column !== MODEL_LIFECYCLE_COLUMNS[index])) {
    throw new Error(`${MODEL_LIFECYCLE_TABLE} schema is not the closed six-column lifecycle schema`);
  }
  initialized.add(db);
}

/** Create the closed lifecycle table in the existing SQLite database. */
export function ensureModelLifecycleSchema(db: Database.Database = getDb()): void {
  ensureSchema(db);
}

/** Append exactly one validated, content-blind lifecycle row. */
export function appendModelLifecycleEvent(
  event: ModelLifecycleEvent,
  db: Database.Database = getDb(),
): void {
  const safeEvent = validateEvent(event);
  ensureSchema(db);
  db.prepare(
    `INSERT INTO ${MODEL_LIFECYCLE_TABLE}
      (ts, model, event, state, ttl_seconds, cause)
     VALUES (@ts, @model, @event, @state, @ttlSeconds, @cause)`,
  ).run({
    ts: safeEvent.ts,
    model: safeEvent.model,
    event: safeEvent.event,
    state: safeEvent.state,
    ttlSeconds: safeEvent.ttlSeconds,
    cause: MODEL_LIFECYCLE_CAUSE,
  });
}

/** Append a batch atomically; this remains a persistence seam, not polling integration. */
export function appendModelLifecycleEvents(
  events: readonly ModelLifecycleEvent[],
  db: Database.Database = getDb(),
): void {
  const safeEvents = events.map(validateEvent);
  ensureSchema(db);
  const insert = db.prepare(
    `INSERT INTO ${MODEL_LIFECYCLE_TABLE}
      (ts, model, event, state, ttl_seconds, cause)
     VALUES (@ts, @model, @event, @state, @ttlSeconds, @cause)`,
  );
  db.transaction(() => {
    for (const event of safeEvents) {
      insert.run({
        ts: event.ts,
        model: event.model,
        event: event.event,
        state: event.state,
        ttlSeconds: event.ttlSeconds,
        cause: MODEL_LIFECYCLE_CAUSE,
      });
    }
  })();
}

/** Read rows back through the same closed contract; useful for local verification and later integration. */
export function readModelLifecycleEvents(db: Database.Database = getDb()): ModelLifecycleEvent[] {
  ensureSchema(db);
  const rows = db
    .prepare(
      `SELECT ts, model, event, state, ttl_seconds, cause
       FROM ${MODEL_LIFECYCLE_TABLE}
       ORDER BY rowid ASC`,
    )
    .all() as ModelLifecycleRow[];
  return rows.map((row) => ({
    ts: row.ts,
    model: row.model,
    event: row.event,
    state: row.state,
    ttlSeconds: row.ttl_seconds,
    cause: row.cause,
  }));
}

/**
 * Return the current load/ready epoch for each requested model. A later unload or
 * disappearance clears the epoch, so request-log use from an older residency cannot
 * satisfy a new TTL observation. Invalid or absent timestamps remain unavailable.
 */
export function getCurrentModelLifecycleStartAtMsByModel(
  models: readonly string[],
  db: Database.Database = getDb(),
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  const uniqueModels = [...new Set(models)];
  for (const model of uniqueModels) result[model] = null;
  if (uniqueModels.length === 0) return result;

  ensureSchema(db);
  const placeholders = uniqueModels.map((_, index) => `@model${index}`).join(", ");
  const params = Object.fromEntries(uniqueModels.map((model, index) => [`model${index}`, model]));
  const rows = db
    .prepare(
      `SELECT model, event, ts
         FROM ${MODEL_LIFECYCLE_TABLE}
        WHERE model IN (${placeholders})
        ORDER BY rowid DESC`,
    )
    .all(params) as Array<{ model: string; event: string; ts: string }>;

  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.model)) continue;
    seen.add(row.model);
    if (row.event !== "load" && row.event !== "ready") continue;
    const timestamp = Date.parse(row.ts);
    result[row.model] = Number.isFinite(timestamp) ? timestamp : null;
  }
  return result;
}
