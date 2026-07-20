/**
 * Durable, append-only gille-owned LearningTaskContract v1 accounting — SQLite store (issue #3).
 *
 * Backing store: `better-sqlite3`, the same idiom as `learning-task-admission-store.ts` and
 * `experiment-import-store.ts`: a WeakSet-guarded idempotent schema init, a content-addressed
 * primary key, and `db.transaction(...).immediate()` to acquire SQLite's write lock BEFORE the
 * natural-key collision check runs — so two concurrent writers (same process or, because SQLite's
 * write lock is a real OS file lock, different processes) cannot interleave a duplicate insert or
 * lose an update.
 *
 * Architectural note (design decision, not a shortcut): hugin#232's `learning-registry-store.ts`
 * runs against Munin, which has no multi-key transaction — so it persists an event, THEN folds it
 * into a separate high-water document in a second write, and therefore needs a reverse
 * "find-orphans" cross-check (an event durably written but never folded in) before it will certify
 * a partition "complete". SQLite gives real ACID transactions across multiple statements: this
 * store inserts the event row AND bumps its partition's high-water row in ONE `.immediate()`
 * transaction, so that orphan class cannot occur by construction. Partition proofs here still
 * recompute the chain digest from the actual event rows rather than trusting the high-water row's
 * own stored digest (same "never trust the doc, recompute it" discipline hugin#232 uses) — that
 * guards against a hand-edited/corrupted row, not against a two-phase-write race, because there
 * isn't one.
 */

import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { getLearningTaskAdmissionByAttempt } from "./learning-task-admission-store.js";
import {
  GILLE_ACCOUNTING_COUNTER_OWNER,
  GILLE_ACCOUNTING_SCHEMA_VERSION,
  GilleAccountingError,
  admissionEventSchema,
  basisProofFor,
  buildMembership,
  canonicalEqual,
  correctionEventSchema,
  deriveEventId,
  directAttemptEventSchema,
  directExposureEventSchema,
  EMPTY_CHAIN_DIGEST,
  erasureAdjustmentEventSchema,
  exclusionEventSchema,
  gilleAccountingEventSchema,
  gilleBasisProofSchema,
  gilleEventKey,
  gilleNaturalKeySchema,
  gillePartitionProofSchema,
  isEligibleForCertification,
  isExactUtcTimestamp,
  jcsDigestHex,
  nextChainDigest,
  occurrencePeriodUtcFromInstant,
  outcomeEventSchema,
  assertCertifiable,
  type AdmissionEvent,
  type CorrectionEvent,
  type DirectAttemptEvent,
  type DirectExposureEvent,
  type ErasureAdjustmentEvent,
  type ExclusionEvent,
  type GilleAccountingEvent,
  type GilleAccountingRecordKind,
  type GilleBasisProof,
  type GilleEvidenceRef,
  type GilleExclusionReason,
  type GilleNaturalKey,
  type GillePartitionProof,
  type HuginAttemptRef,
  type OutcomeEvent,
} from "./gille-accounting.js";

export * from "./gille-accounting.js";

export class GilleNaturalKeyConflictError extends Error {
  constructor(
    public readonly eventId: string,
    public readonly recordKind: GilleAccountingRecordKind,
  ) {
    super(
      `gille accounting natural key collision at ${recordKind}/${eventId}: a different payload ` +
      `already occupies this event id. File a correction instead of retrying the write.`,
    );
    this.name = "GilleNaturalKeyConflictError";
  }
}

export interface AppendResult<E extends GilleAccountingEvent = GilleAccountingEvent> {
  status: "created" | "exact-existing";
  event: E;
}

interface EventRow {
  event_id: string;
  record_kind: string;
  natural_key_digest: string;
  counter: string;
  counter_owner: string;
  occurrence_period_utc: string;
  issued_at: string;
  occurred_at: string;
  recorded_at: string;
  payload_json: string;
}

interface PartitionRow {
  counter: string;
  occurrence_period_utc: string;
  high_water_seq: number;
  chain_digest: string;
  updated_at: string;
}

const initialized = new WeakSet<Database.Database>();

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS gille_accounting_events (
      event_id               TEXT PRIMARY KEY,
      record_kind            TEXT NOT NULL,
      natural_key_digest     TEXT NOT NULL UNIQUE,
      counter                TEXT NOT NULL,
      counter_owner          TEXT NOT NULL,
      occurrence_period_utc  TEXT NOT NULL,
      issued_at              TEXT NOT NULL,
      occurred_at            TEXT NOT NULL,
      recorded_at            TEXT NOT NULL,
      payload_json           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gille_accounting_partition
      ON gille_accounting_events(counter, occurrence_period_utc, event_id);
    CREATE INDEX IF NOT EXISTS idx_gille_accounting_record_kind
      ON gille_accounting_events(record_kind);

    CREATE TABLE IF NOT EXISTS gille_accounting_partitions (
      counter                TEXT NOT NULL,
      occurrence_period_utc  TEXT NOT NULL,
      high_water_seq         INTEGER NOT NULL,
      chain_digest           TEXT NOT NULL,
      updated_at             TEXT NOT NULL,
      PRIMARY KEY (counter, occurrence_period_utc)
    );
  `);
  initialized.add(db);
}

/** Eagerly create the schema (idempotent) — mirrors ledger.ts's ensureLedgerSchema. */
export function ensureGilleAccountingSchema(db: Database.Database = getDb()): void {
  ensureSchema(db);
}

function rowToEvent(row: EventRow): GilleAccountingEvent {
  // `stored` is `{ naturalKey, fields }` as written by `eventToRow` below — NOT the schema's own
  // `payload` field (that lives inside `stored.fields.payload` for kinds that have one).
  const stored = JSON.parse(row.payload_json) as { naturalKey: unknown; fields: Record<string, unknown> };
  return gilleAccountingEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: row.event_id,
    recordKind: row.record_kind,
    membership: {
      naturalKey: stored.naturalKey,
      occurrencePeriodUtc: row.occurrence_period_utc,
      counter: row.counter,
      counterOwner: row.counter_owner,
      issuedAt: row.issued_at,
    },
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    ...stored.fields,
  });
}

function eventToRow(event: GilleAccountingEvent): EventRow {
  const { naturalKey: _naturalKey, ...restMembership } = event.membership;
  void restMembership;
  // Store everything the row itself does not already carry as columns (requestId/evidenceId/
  // subjectId/payload) plus the natural key, so `rowToEvent` can losslessly reconstruct the exact
  // discriminated-union shape zod expects.
  const { schemaVersion: _schemaVersion, eventId: _eventId, recordKind: _recordKind,
    membership: _membership, occurredAt: _occurredAt, recordedAt: _recordedAt,
    ...fields } = event as unknown as Record<string, unknown>;
  return {
    event_id: event.eventId,
    record_kind: event.recordKind,
    natural_key_digest: jcsDigestHex(event.membership.naturalKey),
    counter: event.membership.counter,
    counter_owner: event.membership.counterOwner,
    occurrence_period_utc: event.membership.occurrencePeriodUtc,
    issued_at: event.membership.issuedAt,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    payload_json: JSON.stringify({ naturalKey: event.membership.naturalKey, fields }),
  };
}

function withoutRecordedAt(event: GilleAccountingEvent): Record<string, unknown> {
  const { recordedAt: _recordedAt, ...rest } = event as unknown as Record<string, unknown>;
  return rest;
}

/**
 * Core append primitive. Runs the natural-key collision check, the event insert, AND the
 * partition high-water bump inside one `IMMEDIATE` transaction:
 *  - `.immediate()` acquires SQLite's writer lock before the collision SELECT runs, so a second
 *    connection attempting the same natural key blocks (or gets SQLITE_BUSY, per its own
 *    busy_timeout) until this transaction commits or rolls back — no lost update, no duplicate row.
 *  - An identical replay (same natural key, same canonical content apart from `recordedAt`) is
 *    reported `exact-existing` and returns the ALREADY-PERSISTED winner, never the caller's
 *    locally-built candidate — so a later read is never inconsistent with what this call reported.
 *  - A genuinely different payload at the same natural key is refused
 *    (`GilleNaturalKeyConflictError`), never silently overwritten.
 */
function appendGilleAccountingEvent<E extends GilleAccountingEvent>(
  db: Database.Database,
  event: E,
): AppendResult<E> {
  ensureSchema(db);
  const validated = gilleAccountingEventSchema.parse(event) as E;
  const digest = jcsDigestHex(validated.membership.naturalKey);
  const eventDigest = jcsDigestHex(validated);

  const run = db.transaction((): AppendResult<E> => {
    const existingRow = db.prepare(
      `SELECT event_id, record_kind, natural_key_digest, counter, counter_owner,
              occurrence_period_utc, issued_at, occurred_at, recorded_at, payload_json
         FROM gille_accounting_events WHERE natural_key_digest = ?`
    ).get(digest) as EventRow | undefined;

    if (existingRow !== undefined) {
      const existingEvent = rowToEvent(existingRow) as E;
      if (!canonicalEqual(withoutRecordedAt(existingEvent), withoutRecordedAt(validated))) {
        throw new GilleNaturalKeyConflictError(existingRow.event_id, existingRow.record_kind as GilleAccountingRecordKind);
      }
      return { status: "exact-existing", event: existingEvent };
    }

    const row = eventToRow(validated);
    db.prepare(`
      INSERT INTO gille_accounting_events
        (event_id, record_kind, natural_key_digest, counter, counter_owner,
         occurrence_period_utc, issued_at, occurred_at, recorded_at, payload_json)
      VALUES
        (@event_id, @record_kind, @natural_key_digest, @counter, @counter_owner,
         @occurrence_period_utc, @issued_at, @occurred_at, @recorded_at, @payload_json)
    `).run(row);

    const partitionRow = db.prepare(
      `SELECT counter, occurrence_period_utc, high_water_seq, chain_digest, updated_at
         FROM gille_accounting_partitions WHERE counter = ? AND occurrence_period_utc = ?`
    ).get(validated.membership.counter, validated.membership.occurrencePeriodUtc) as PartitionRow | undefined;
    const nextSeq = (partitionRow?.high_water_seq ?? 0) + 1;
    const nextDigest = nextChainDigest(partitionRow?.chain_digest ?? EMPTY_CHAIN_DIGEST, eventDigest);
    db.prepare(`
      INSERT INTO gille_accounting_partitions (counter, occurrence_period_utc, high_water_seq, chain_digest, updated_at)
      VALUES (@counter, @period, @seq, @digest, @now)
      ON CONFLICT(counter, occurrence_period_utc) DO UPDATE SET
        high_water_seq = @seq, chain_digest = @digest, updated_at = @now
    `).run({
      counter: validated.membership.counter,
      period: validated.membership.occurrencePeriodUtc,
      seq: nextSeq,
      digest: nextDigest,
      now: validated.recordedAt,
    });

    return { status: "created", event: validated };
  });
  return run.immediate();
}

// ─── typed capture-time writers ─────────────────────────────────────────────────

export function recordDirectAttempt(
  db: Database.Database,
  input: { requestId: string; lane: string; fingerprintSha256: string; occurredAt: string; recordedAt?: string },
): AppendResult<DirectAttemptEvent> {
  const naturalKey: GilleNaturalKey = { recordKind: "direct-attempt", requestId: input.requestId };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = directAttemptEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "direct-attempt",
    requestId: input.requestId,
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: { lane: input.lane, fingerprintSha256: input.fingerprintSha256 },
  });
  return appendGilleAccountingEvent(db, event);
}

/**
 * Direct-exposure denominator decision. `joined`/`huginAttemptRef` reflect the CALLER's claim only
 * — this writer stores exactly what is asserted. The claim is independently verified, and the
 * Hugin-owned join counter is only ever admitted into a basis proof, at `issueGilleBasisProof`
 * time (never here) — see that function's doc comment for why verification is deferred to
 * proof-issuance rather than done at write time.
 */
export function recordDirectExposureObserved(
  db: Database.Database,
  input: {
    eventKey: string;
    fingerprintSha256: string;
    lane: string;
    joined?: boolean;
    huginAttemptRef?: HuginAttemptRef;
    occurredAt: string;
    recordedAt?: string;
  },
): AppendResult<DirectExposureEvent> {
  const naturalKey: GilleNaturalKey = { recordKind: "direct-exposure", exposureKind: "observed", eventKey: input.eventKey };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = directExposureEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "direct-exposure",
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: {
      exposureKind: "observed",
      fingerprintSha256: input.fingerprintSha256,
      lane: input.lane,
      joined: input.joined ?? false,
      ...(input.huginAttemptRef ? { huginAttemptRef: input.huginAttemptRef } : {}),
    },
  });
  return appendGilleAccountingEvent(db, event);
}

/**
 * Negative-exposure decision (issue #3 AC "negative exposure evidence identifies and validates the
 * exact authoritative attempt"). When `huginAttemptRef` is supplied (Hugin is the requester), it
 * MUST already resolve to a durably admitted Hugin request (learning-task-admission-store.ts) —
 * verified here, at write time, because unlike the observed-exposure join counter (deferred to
 * proof-issuance) a negative claim is itself the evidentiary payload: an unverifiable "unseen"
 * claim citing a fabricated attempt must never be persisted as if it were trustworthy.
 */
export function recordNegativeExposureDecision(
  db: Database.Database,
  input: {
    lookupId: string;
    queriedFingerprintSha256: string;
    lane: string;
    huginAttemptRef?: HuginAttemptRef;
    occurredAt: string;
    recordedAt?: string;
  },
): AppendResult<DirectExposureEvent> {
  if (input.huginAttemptRef) {
    const verified = verifyHuginAttemptReference(db, input.huginAttemptRef);
    if (!verified.verified) {
      throw new GilleAccountingError(
        `negative-exposure decision cites an unverifiable Hugin attempt reference: ${verified.reason}`,
      );
    }
  }
  const naturalKey: GilleNaturalKey = { recordKind: "direct-exposure", exposureKind: "negative-coverage", lookupId: input.lookupId };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = directExposureEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "direct-exposure",
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: {
      exposureKind: "negative-coverage",
      fingerprintSha256: input.queriedFingerprintSha256,
      lane: input.lane,
      joined: input.huginAttemptRef !== undefined,
      ...(input.huginAttemptRef ? { huginAttemptRef: input.huginAttemptRef } : {}),
    },
  });
  return appendGilleAccountingEvent(db, event);
}

export function recordAdmissionDecision(
  db: Database.Database,
  input: {
    evidenceId: string;
    admitted: boolean;
    admissionBasis: "full-pass" | "policy-qualified-partial" | "none";
    occurredAt: string;
    recordedAt?: string;
  },
): AppendResult<AdmissionEvent> {
  const naturalKey: GilleNaturalKey = { recordKind: "admission", evidenceId: input.evidenceId };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = admissionEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "admission",
    evidenceId: input.evidenceId,
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: { admitted: input.admitted, admissionBasis: input.admissionBasis },
  });
  return appendGilleAccountingEvent(db, event);
}

export function recordOutcome(
  db: Database.Database,
  input: {
    requestId: string;
    outcome: OutcomeEvent["payload"]["outcome"];
    failureMode?: string | null;
    occurredAt: string;
    recordedAt?: string;
  },
): AppendResult<OutcomeEvent> {
  const naturalKey: GilleNaturalKey = { recordKind: "outcome", requestId: input.requestId };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = outcomeEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "outcome",
    requestId: input.requestId,
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: { outcome: input.outcome, failureMode: input.failureMode ?? null },
  });
  return appendGilleAccountingEvent(db, event);
}

export function recordExclusion(
  db: Database.Database,
  input: {
    subjectId: string;
    exclusionReason: GilleExclusionReason;
    note?: string;
    occurredAt: string;
    recordedAt?: string;
  },
): AppendResult<ExclusionEvent> {
  const naturalKey: GilleNaturalKey = { recordKind: "exclusion", subjectId: input.subjectId, exclusionReason: input.exclusionReason };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = exclusionEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "exclusion",
    subjectId: input.subjectId,
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: { exclusionReason: input.exclusionReason, ...(input.note ? { note: input.note } : {}) },
  });
  return appendGilleAccountingEvent(db, event);
}

// ─── correction chain ────────────────────────────────────────────────────────────

export function getGilleAccountingEvent(db: Database.Database, eventId: string): GilleAccountingEvent | null {
  ensureSchema(db);
  const row = db.prepare(
    `SELECT event_id, record_kind, natural_key_digest, counter, counter_owner,
            occurrence_period_utc, issued_at, occurred_at, recorded_at, payload_json
       FROM gille_accounting_events WHERE event_id = ?`
  ).get(gilleEventKey(eventId)) as EventRow | undefined;
  return row === undefined ? null : rowToEvent(row);
}

/**
 * Chain a new, distinctly-keyed correction onto an existing event (issue #3 AC "immutable
 * correction chains"). The predecessor is read but never mutated: this INSERTS a brand-new event
 * row with its own eventId/membership/occurrence period, and never issues an UPDATE against the
 * predecessor's row. At most one correction can exist per predecessor (its natural key is
 * `{correction, predecessorEventId}`); a second, DIFFERENT correction targeting the same
 * predecessor is a natural-key collision (`GilleNaturalKeyConflictError`), not a silent fork — to
 * correct a correction, target the correction's own event id instead.
 */
export function writeCorrection(
  db: Database.Database,
  input: { predecessorEventId: string; reason: string; evidenceRef?: GilleEvidenceRef; occurredAt: string; recordedAt?: string },
): AppendResult<CorrectionEvent> {
  const predecessor = getGilleAccountingEvent(db, input.predecessorEventId);
  if (!predecessor) {
    throw new GilleAccountingError(`cannot correct unknown predecessor event ${input.predecessorEventId}`);
  }
  if (Date.parse(input.occurredAt) <= Date.parse(predecessor.occurredAt)) {
    throw new GilleAccountingError("a correction must strictly time-advance past its predecessor's occurredAt");
  }
  const naturalKey: GilleNaturalKey = { recordKind: "correction", predecessorEventId: input.predecessorEventId };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = correctionEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "correction",
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: {
      predecessorEventId: input.predecessorEventId,
      correctedNaturalKey: predecessor.membership.naturalKey,
      reason: input.reason,
      ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
    },
  });
  return appendGilleAccountingEvent(db, event);
}

/** Walk the correction chain starting at `rootEventId` and return the id of its unique
 *  unsuperseded leaf. Each hop is a direct content-derived key lookup — mirrors hugin#232's
 *  `findEffectiveLeaf` exactly (same algorithm; corrections cannot fork, so there is no ambiguity
 *  to race on). */
export function findEffectiveLeaf(db: Database.Database, rootEventId: string, maxHops = 64): string {
  let current = rootEventId;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const correctionKey = gilleNaturalKeySchema.parse({ recordKind: "correction", predecessorEventId: current });
    const correctionEventId = deriveEventId(correctionKey);
    const existing = getGilleAccountingEvent(db, correctionEventId);
    if (!existing) return current;
    current = correctionEventId;
  }
  throw new GilleAccountingError(`correction chain for ${rootEventId} exceeded ${maxHops} hops — possible cycle`);
}

// ─── Hugin attempt reference verification ────────────────────────────────────────

export type HuginAttemptVerification =
  | { verified: true; admissionRecordId: string }
  | { verified: false; reason: string };

/**
 * Verify (never fabricate) that a claimed Hugin attempt reference is authoritative: it must
 * resolve to a row this gateway itself durably admitted (issue #2's full stamp/echo/principal-
 * binding pipeline), whose echoed request genuinely carries a Hugin-origin source. A caller
 * supplying an arbitrary (taskInstanceId, attemptId) pair that was never actually admitted gets
 * `verified: false` — there is no path by which a body-only claim becomes "verified" here.
 */
export function verifyHuginAttemptReference(
  db: Database.Database,
  ref: HuginAttemptRef,
): HuginAttemptVerification {
  const admission = getLearningTaskAdmissionByAttempt(ref.taskInstanceId, ref.attemptId, db);
  if (!admission) {
    return { verified: false, reason: "no authenticated Hugin admission exists for this task/attempt reference" };
  }
  if (admission.gatewayEcho.echoed_request.source.component !== "hugin") {
    return { verified: false, reason: "admitted stamp does not carry a Hugin-origin source" };
  }
  if (admission.gatewayEcho.echoed_request.task_instance_id !== ref.taskInstanceId
    || admission.gatewayEcho.echoed_request.attempt_id !== ref.attemptId) {
    return { verified: false, reason: "admitted stamp does not bind the exact claimed task/attempt identity" };
  }
  return { verified: true, admissionRecordId: admission.admissionRecordId };
}

// ─── basis proof issuance / verification (issue #3 AC3, AC "Hugin-basis preservation") ───────────

/**
 * Issue the authoritative denominator-basis proof for a stored event. This is the ONLY basis-proof
 * constructor in this module: `basis`/`counterSet` are derived purely from the stored event
 * (`basisProofFor`, gille-accounting.ts) — never from a caller-supplied override. For a JOINED
 * direct-exposure record, the Hugin-owned "join" counter is only included after this function
 * independently re-verifies the event's own `huginAttemptRef` against the live admission store
 * (`verifyHuginAttemptReference`) at issuance time — deliberately NOT cached from write time, so a
 * Hugin admission that is later found to be invalid/rotated cannot keep certifying old exposure
 * rows. Verification failing for a joined record means this function refuses to issue ANY proof
 * (fail closed) rather than silently dropping the Hugin counter — a joined-exposure record whose
 * Hugin basis cannot be verified has no admissible basis at all yet, matching the contract's
 * "missing or extra receipts fail" rule.
 */
export function issueGilleBasisProof(db: Database.Database, recordId: string): GilleBasisProof {
  const event = getGilleAccountingEvent(db, recordId);
  if (!event) throw new GilleAccountingError(`cannot issue a basis proof for unknown event ${recordId}`);
  if (event.recordKind === "direct-exposure" && event.payload.joined) {
    if (!event.payload.huginAttemptRef) {
      throw new GilleAccountingError(
        `joined exposure ${recordId} carries no Hugin attempt reference; its basis cannot be issued`,
      );
    }
    const verification = verifyHuginAttemptReference(db, event.payload.huginAttemptRef);
    if (!verification.verified) {
      throw new GilleAccountingError(
        `joined exposure ${recordId} basis cannot be issued: ${verification.reason} — ` +
        `gille never fabricates or substitutes a Hugin-owned receipt for an unverifiable one`,
      );
    }
  }
  return basisProofFor(event);
}

export type BasisProofVerification = { valid: true } | { valid: false; reason: string };

/**
 * Verify a presented basis proof before any erasure is allowed to proceed (issue #3 AC3). This
 * RE-DERIVES the authoritative proof from the store's own current state (`issueGilleBasisProof`)
 * and compares — a caller-supplied proof is trusted only insofar as it matches what the store
 * itself would issue right now. Checks, in order: the referenced record exists and its
 * (re-derived) basis is issuable at all (catches a forged/unverifiable Hugin join basis); every
 * field matches the re-derived proof exactly (catches a forged/mutated basis, counter set, kind,
 * id, producer, or issuer); and the issuance clock is no later than the erasure request's own
 * timestamp (catches a late or impossible issue clock).
 */
export function verifyGilleBasisProofForErasure(
  db: Database.Database,
  proof: GilleBasisProof,
  erasureRequestedAt: string,
): BasisProofVerification {
  const parsed = gilleBasisProofSchema.safeParse(proof);
  if (!parsed.success) return { valid: false, reason: "basis proof does not conform to the required shape" };
  if (!isExactUtcTimestamp(erasureRequestedAt)) {
    return { valid: false, reason: "erasure request timestamp is not a valid RFC 3339 UTC instant" };
  }
  let authoritative: GilleBasisProof;
  try {
    authoritative = issueGilleBasisProof(db, parsed.data.recordId);
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : "basis proof cannot be re-derived" };
  }
  if (!canonicalEqual(authoritative, parsed.data)) {
    return { valid: false, reason: "basis proof does not match the record the store itself would issue — forged or stale" };
  }
  if (!isExactUtcTimestamp(parsed.data.issuedAt)) {
    return { valid: false, reason: "basis proof issue clock is not a valid RFC 3339 UTC instant" };
  }
  if (Date.parse(parsed.data.issuedAt) > Date.parse(erasureRequestedAt)) {
    return { valid: false, reason: "basis proof issue clock is later than the erasure request — impossible/late clock" };
  }
  return { valid: true };
}

/**
 * Record a privacy-safe counter adjustment for a target event's erasure or exclusion. This never
 * deletes, mutates, or moves the target's own natural key / occurrence period / counter / owner —
 * so the target's original denominator membership is preserved exactly (issue #3 AC "a July record
 * cannot be erased or corrected into August membership"). This module never stored prompt/response
 * bytes in the first place, so there is no content to resurrect; the adjustment exists purely so a
 * reader can honor the erasure when it later dereferences the target's evidence refs.
 *
 * Fails closed before writing anything: the authoritative basis proof is issued and verified
 * against `erasureRequestedAt` FIRST; a missing, forged, unverifiable-Hugin-basis, or late-clock
 * proof throws and no adjustment event is ever persisted.
 */
export function writeErasureAdjustment(
  db: Database.Database,
  input: {
    targetEventId: string;
    adjustmentReason: "erasure" | "exclusion";
    erasureRequestedAt: string;
    note?: string;
    occurredAt: string;
    recordedAt?: string;
  },
): AppendResult<ErasureAdjustmentEvent> {
  const target = getGilleAccountingEvent(db, input.targetEventId);
  if (!target) throw new GilleAccountingError(`cannot adjust unknown target event ${input.targetEventId}`);

  const basisProof = issueGilleBasisProof(db, input.targetEventId);
  const verification = verifyGilleBasisProofForErasure(db, basisProof, input.erasureRequestedAt);
  if (!verification.valid) {
    throw new GilleAccountingError(`erasure refused for ${input.targetEventId}: ${verification.reason}`);
  }

  const naturalKey: GilleNaturalKey = { recordKind: "erasure-adjustment", targetEventId: input.targetEventId };
  const recordedAt = input.recordedAt ?? input.occurredAt;
  const event = erasureAdjustmentEventSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION,
    eventId: deriveEventId(naturalKey),
    recordKind: "erasure-adjustment",
    membership: buildMembership({ naturalKey, issuedAt: input.occurredAt }),
    occurredAt: input.occurredAt,
    recordedAt,
    payload: {
      targetEventId: input.targetEventId,
      targetNaturalKey: target.membership.naturalKey,
      adjustmentReason: input.adjustmentReason,
      basisProof,
      ...(input.note ? { note: input.note } : {}),
    },
  });
  return appendGilleAccountingEvent(db, event);
}

// ─── partition / high-water proof primitives (issue #3 AC "full-period closes") ──────────────────

function recomputePartition(
  db: Database.Database,
  counter: GilleAccountingRecordKind,
  occurrencePeriodUtc: string,
): { eventIds: string[]; chainDigest: string; maxRecordedAt: string | null } {
  const rows = db.prepare(
    `SELECT event_id, record_kind, natural_key_digest, counter, counter_owner,
            occurrence_period_utc, issued_at, occurred_at, recorded_at, payload_json
       FROM gille_accounting_events
      WHERE counter = ? AND occurrence_period_utc = ?
      ORDER BY event_id`
  ).all(counter, occurrencePeriodUtc) as EventRow[];
  let chain = EMPTY_CHAIN_DIGEST;
  const eventIds: string[] = [];
  let maxRecordedAt: string | null = null;
  for (const row of rows) {
    const event = rowToEvent(row);
    chain = nextChainDigest(chain, jcsDigestHex(event));
    eventIds.push(row.event_id);
    // Compared as ISO-8601 UTC instants (Date.parse), not lexicographically — the schema pins
    // fixed sub-second digit widths so string/instant order agree here, but this stays explicit
    // per the repo-wide "parse and compare numeric/instant identifiers numerically" convention.
    if (maxRecordedAt === null || Date.parse(row.recorded_at) > Date.parse(maxRecordedAt)) {
      maxRecordedAt = row.recorded_at;
    }
  }
  return { eventIds, chainDigest: chain, maxRecordedAt };
}

/**
 * Issue an authoritative statement that partition (counter, period) is complete up to the store's
 * own recorded high-water mark — or, when no events ever occurred, an authenticated confirmation
 * of a legitimate zero-event partition. Always recomputes from the live `gille_accounting_events`
 * rows (never trusts `gille_accounting_partitions`' own stored digest/seq as ground truth — only
 * as a fast cross-check); any inconsistency is reported `partial` and is never eligible for
 * certification (issue #3 AC "partial or unverifiable partitions cannot certify an aggregate").
 *
 * `issuedAt` is also bounded below by the latest `recordedAt` among the events it covers (M5
 * dogfood review, issue #3): without this check a caller could mint a proof labeled e.g.
 * "issued 2020-01-01" that nonetheless certifies events durably recorded in 2026 — internally
 * self-consistent (the digest/count still matches live state) but a misleading document, since a
 * proof cannot honestly attest to data that did not exist yet at its own issuance clock. Mirrors
 * the same discipline `verifyGilleBasisProofForErasure` already applies to basis-proof clocks.
 */
export function issueGillePartitionProof(
  db: Database.Database,
  counter: GilleAccountingRecordKind,
  occurrencePeriodUtc: string,
  issuedAt: string,
): GillePartitionProof {
  ensureSchema(db);
  if (!isExactUtcTimestamp(issuedAt)) {
    throw new GilleAccountingError(`partition proof issuedAt is not a valid RFC 3339 UTC instant: ${issuedAt}`);
  }
  const { eventIds, chainDigest, maxRecordedAt } = recomputePartition(db, counter, occurrencePeriodUtc);
  const partitionRow = db.prepare(
    `SELECT counter, occurrence_period_utc, high_water_seq, chain_digest, updated_at
       FROM gille_accounting_partitions WHERE counter = ? AND occurrence_period_utc = ?`
  ).get(counter, occurrencePeriodUtc) as PartitionRow | undefined;

  if (eventIds.length === 0) {
    if (partitionRow !== undefined) {
      return gillePartitionProofSchema.parse({
        schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION, counter, counterOwner: GILLE_ACCOUNTING_COUNTER_OWNER,
        occurrencePeriodUtc, status: "partial", highWaterSeq: 0, eventIds: [], chainDigest: EMPTY_CHAIN_DIGEST,
        issuedAt, partialReason: "partition high-water record exists but no events are present — inconsistent state",
      });
    }
    return gillePartitionProofSchema.parse({
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION, counter, counterOwner: GILLE_ACCOUNTING_COUNTER_OWNER,
      occurrencePeriodUtc, status: "empty-confirmed", highWaterSeq: 0, eventIds: [], chainDigest: EMPTY_CHAIN_DIGEST, issuedAt,
    });
  }
  if (partitionRow === undefined
    || partitionRow.high_water_seq !== eventIds.length
    || partitionRow.chain_digest !== chainDigest) {
    return gillePartitionProofSchema.parse({
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION, counter, counterOwner: GILLE_ACCOUNTING_COUNTER_OWNER,
      occurrencePeriodUtc, status: "partial", highWaterSeq: eventIds.length, eventIds, chainDigest,
      issuedAt, partialReason: "recomputed event chain does not match the stored high-water record",
    });
  }
  if (maxRecordedAt !== null && Date.parse(issuedAt) < Date.parse(maxRecordedAt)) {
    return gillePartitionProofSchema.parse({
      schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION, counter, counterOwner: GILLE_ACCOUNTING_COUNTER_OWNER,
      occurrencePeriodUtc, status: "partial", highWaterSeq: eventIds.length, eventIds, chainDigest,
      issuedAt, partialReason: "issuedAt predates the most recently recorded event in this partition — impossible issue clock",
    });
  }
  return gillePartitionProofSchema.parse({
    schemaVersion: GILLE_ACCOUNTING_SCHEMA_VERSION, counter, counterOwner: GILLE_ACCOUNTING_COUNTER_OWNER,
    occurrencePeriodUtc, status: "complete", highWaterSeq: eventIds.length, eventIds, chainDigest, issuedAt,
  });
}

/**
 * Re-derive validity from the store's own current state — never from the proof body alone. A
 * hand-crafted ("forged") proof, or one built from a caller-supplied event list / a bare
 * "full-period" label instead of a genuinely issued proof, fails because its `eventIds`/
 * `chainDigest` will not match what a fresh `issueGillePartitionProof` recomputes. A proof that is
 * no longer current (the partition has advanced past it) fails when `requireCurrent` is set —
 * the default — because a full-period close must use the authoritative CURRENT high-water mark,
 * not a stale earlier one.
 */
export function verifyGillePartitionProof(
  db: Database.Database,
  proof: GillePartitionProof,
  options: { requireCurrent?: boolean } = {},
): { valid: boolean; reason?: string } {
  const requireCurrent = options.requireCurrent ?? true;
  const parsed = gillePartitionProofSchema.safeParse(proof);
  if (!parsed.success) return { valid: false, reason: "proof does not conform to the required shape" };
  if (!isEligibleForCertification(parsed.data)) return { valid: false, reason: "a partial proof is never certifiable" };

  const fresh = issueGillePartitionProof(db, parsed.data.counter, parsed.data.occurrencePeriodUtc, parsed.data.issuedAt);
  if (requireCurrent) {
    if (fresh.status !== parsed.data.status
      || fresh.highWaterSeq !== parsed.data.highWaterSeq
      || fresh.chainDigest !== parsed.data.chainDigest
      || fresh.eventIds.length !== parsed.data.eventIds.length
      || !fresh.eventIds.every((id, i) => id === parsed.data.eventIds[i])) {
      return { valid: false, reason: "proof does not match the partition's current, freshly recomputed state — stale or forged" };
    }
  }
  return { valid: true };
}

export type FullPeriodClose =
  | { status: "certified"; proof: GillePartitionProof; closedAt: string }
  | { status: "partial-dataset-deferred"; proof: GillePartitionProof; closedAt: string };

/**
 * Certify a full-period close. Deliberately takes NO event list, digest, or "full period" label
 * from the caller — the only inputs are the counter/period identity and the close clock. The
 * partition proof is always freshly issued from the store's own current state
 * (`issueGillePartitionProof`); a caller cannot substitute a plausible-looking event list or a bare
 * assertion for it (issue #3 AC "a caller-supplied event list or a caller-supplied 'full-period'
 * label must NOT be sufficient to certify a close"). An ineligible (partial) proof is never
 * silently certified — it is reported `partial-dataset-deferred`, the exact vocabulary the
 * grimnir contract uses for "accepted only as explicitly unverified, never silently certified".
 */
export function closeFullPeriod(
  db: Database.Database,
  counter: GilleAccountingRecordKind,
  occurrencePeriodUtc: string,
  closedAt: string,
): FullPeriodClose {
  const proof = issueGillePartitionProof(db, counter, occurrencePeriodUtc, closedAt);
  return {
    status: isEligibleForCertification(proof) ? "certified" : "partial-dataset-deferred",
    proof,
    closedAt,
  };
}

/**
 * Fail-closed consumer entry point for a downstream report/close: accepts only a proof that is
 * BOTH structurally eligible for certification AND independently re-verifiable against the
 * store's own live state right now. Throws `PartialSnapshotNotCertifiableError` otherwise — this
 * is the function a caller who received a `GillePartitionProof` from elsewhere (e.g. over a wire
 * boundary) should call before trusting it, so a forged or stale "complete" proof can never slip
 * through on structure alone.
 */
export function acceptPartitionProofForClose(db: Database.Database, proof: GillePartitionProof): void {
  assertCertifiable(proof);
  const verification = verifyGillePartitionProof(db, proof);
  if (!verification.valid) {
    throw new GilleAccountingError(`partition proof rejected: ${verification.reason ?? "unknown reason"}`);
  }
}

export { occurrencePeriodUtcFromInstant };
