/**
 * Erasure/exclusion propagation for harvest-source data (issue #9, scope items 3 and 4).
 *
 * Deliberately thin. This module does NOT reimplement erasure-safe denominator membership, basis
 * proofs, or counter accounting — issue #3's `gille-accounting-store.ts` already owns that (see
 * `writeErasureAdjustment`, `verifyGilleBasisProofForErasure`, `denominatorBasisFor`). What this
 * module adds on top, scoped specifically to issue #9:
 *
 *   1. A durable, content-blind TOMBSTONE (`retention_erasures`) recording that a given harvest-
 *      store subject (identified only by an opaque ref — a request id, event key, or natural-key
 *      digest, never content) has been erased, so a caller elsewhere in the codebase can check
 *      `isErased(...)` before accepting a re-import or re-admission of the same subject (issue #9
 *      AC "erasure ... prevents re-import"). Writing this tombstone never rewrites or deletes any
 *      other row — it is a pure addition, same as issue #3's own append-only events (issue #9 AC "a
 *      task can be excluded from future harvesting without rewriting unrelated audit history").
 *   2. A CROSS-OWNER acknowledgement check for the case where the accounting event being erased is
 *      a JOINED exposure — its denominator basis includes a Hugin-owned "join" counter
 *      (`denominatorBasisFor`, gille-accounting.ts). One owner cannot fabricate or self-assert the
 *      other owner's acknowledgement that erasure is complete on Hugin's side too; this reuses the
 *      exact verification gille-accounting-store.ts already trusts for a joined exposure's basis
 *      proof (`verifyHuginAttemptReference`) — never a body-supplied `owner_component: "hugin"`
 *      claim (grimnir contract, "Erasure and expiry protocol").
 *   3. Content redaction for a specific subject's row in a registered content-bearing harvest
 *      store (retention-registry.ts), reusing the SAME column list retention-enforcement.ts uses
 *      for the windowed prune — an on-demand, single-subject version of the same operation.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  denominatorBasisFor,
  getGilleAccountingEvent,
  isExactUtcTimestamp,
  recordExclusion,
  verifyHuginAttemptReference,
  writeErasureAdjustment,
  type AppendResult,
  type ErasureAdjustmentEvent,
  type ExclusionEvent,
  type HuginAttemptRef,
} from "./gille-accounting-store.js";
import { HARVEST_STORE_REGISTRY, getHarvestStoreDescriptor } from "./retention-registry.js";

export class RetentionErasureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionErasureError";
  }
}

// ─── durable tombstone ────────────────────────────────────────────────────────────────────────

const initialized = new WeakSet<Database.Database>();

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_erasures (
      subject_key   TEXT PRIMARY KEY,
      store_id      TEXT NOT NULL,
      subject_ref   TEXT NOT NULL,
      reason        TEXT NOT NULL,
      requested_at  TEXT NOT NULL,
      recorded_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_retention_erasures_store ON retention_erasures(store_id);
  `);
  initialized.add(db);
}

/** Eagerly create the tombstone schema (idempotent). */
export function ensureRetentionErasureSchema(db: Database.Database): void {
  ensureSchema(db);
}

/** Deterministic key so the same (store, subject) can never produce two tombstone rows. */
export function retentionSubjectKey(storeId: string, subjectRef: string): string {
  return createHash("sha256").update(`${storeId}\0${subjectRef}`, "utf8").digest("hex");
}

interface TombstoneRow {
  subject_key: string;
  store_id: string;
  subject_ref: string;
  reason: string;
  requested_at: string;
  recorded_at: string;
}

export type ErasureTombstoneReason = "erasure" | "owner-opt-out";

export interface RecordErasureTombstoneInput {
  storeId: string;
  subjectRef: string;
  reason: ErasureTombstoneReason;
  requestedAt: string;
  recordedAt?: string;
}

export interface ErasureTombstone {
  storeId: string;
  subjectRef: string;
  reason: ErasureTombstoneReason;
  requestedAt: string;
  recordedAt: string;
}

/**
 * Idempotently record a content-blind tombstone. A second call for the SAME (storeId, subjectRef)
 * is a no-op returning `"already-erased"` — it never overwrites the original `requestedAt`/`reason`,
 * so the tombstone's own history cannot be quietly backdated.
 */
export function recordErasureTombstone(
  db: Database.Database,
  input: RecordErasureTombstoneInput,
): { status: "created" | "already-erased"; tombstone: ErasureTombstone } {
  ensureSchema(db);
  if (!isExactUtcTimestamp(input.requestedAt)) {
    throw new RetentionErasureError(`requestedAt is not a valid RFC 3339 UTC instant: ${input.requestedAt}`);
  }
  const recordedAt = input.recordedAt ?? input.requestedAt;
  const key = retentionSubjectKey(input.storeId, input.subjectRef);

  const existing = db
    .prepare(
      `SELECT subject_key, store_id, subject_ref, reason, requested_at, recorded_at
         FROM retention_erasures WHERE subject_key = ?`,
    )
    .get(key) as TombstoneRow | undefined;
  if (existing) {
    return {
      status: "already-erased",
      tombstone: {
        storeId: existing.store_id,
        subjectRef: existing.subject_ref,
        reason: existing.reason as ErasureTombstoneReason,
        requestedAt: existing.requested_at,
        recordedAt: existing.recorded_at,
      },
    };
  }

  db.prepare(
    `INSERT INTO retention_erasures (subject_key, store_id, subject_ref, reason, requested_at, recorded_at)
     VALUES (@key, @storeId, @subjectRef, @reason, @requestedAt, @recordedAt)`,
  ).run({ key, storeId: input.storeId, subjectRef: input.subjectRef, reason: input.reason, requestedAt: input.requestedAt, recordedAt });

  return {
    status: "created",
    tombstone: { storeId: input.storeId, subjectRef: input.subjectRef, reason: input.reason, requestedAt: input.requestedAt, recordedAt },
  };
}

/** Consult BEFORE accepting a re-import/re-admission of the same subject (issue #9 AC). */
export function isErased(db: Database.Database, storeId: string, subjectRef: string): boolean {
  ensureSchema(db);
  const key = retentionSubjectKey(storeId, subjectRef);
  const row = db.prepare(`SELECT 1 AS present FROM retention_erasures WHERE subject_key = ?`).get(key) as
    | { present: 1 }
    | undefined;
  return row !== undefined;
}

// ─── cross-owner acknowledgement ─────────────────────────────────────────────────────────────

/**
 * An acknowledgement claim that Hugin has completed its own side of erasure for a specific
 * (taskInstanceId, attemptId). This type carries only the CLAIM — `verifyCrossOwnerAcknowledgement`
 * independently re-verifies it against `learning_task_admissions` (the same durably-admitted store
 * `verifyHuginAttemptReference`, issue #3, already trusts) before it is ever treated as authentic.
 * A caller-fabricated ack — any pair never actually admitted — is rejected, never trusted on its
 * own say-so (grimnir contract: "saying owner_component: hugin in a gille body is not evidence").
 */
export const crossOwnerAcknowledgementSchema = z.object({
  owner: z.literal("hugin"),
  taskInstanceId: z.string().min(1),
  attemptId: z.string().min(1),
  acknowledgedAt: z.string(),
}).strict();
export type CrossOwnerAcknowledgement = z.infer<typeof crossOwnerAcknowledgementSchema>;

export type CrossOwnerAckVerification = { verified: true } | { verified: false; reason: string };

export function verifyCrossOwnerAcknowledgement(
  db: Database.Database,
  ack: CrossOwnerAcknowledgement,
): CrossOwnerAckVerification {
  const parsed = crossOwnerAcknowledgementSchema.safeParse(ack);
  if (!parsed.success) return { verified: false, reason: "malformed cross-owner acknowledgement" };
  if (!isExactUtcTimestamp(parsed.data.acknowledgedAt)) {
    return { verified: false, reason: "acknowledgedAt is not a valid RFC 3339 UTC instant" };
  }
  const ref: HuginAttemptRef = { taskInstanceId: parsed.data.taskInstanceId, attemptId: parsed.data.attemptId };
  const verification = verifyHuginAttemptReference(db, ref);
  if (!verification.verified) {
    return { verified: false, reason: `cross-owner acknowledgement is not authentic: ${verification.reason}` };
  }
  return { verified: true };
}

// ─── content redaction for a single subject row ──────────────────────────────────────────────

/** On-demand redaction of one row's content columns (registry-driven — see retention-registry.ts's
 *  `contentColumns`). A store with no content columns (already content-blind) is a documented no-op. */
export function redactStoreSubjectContent(
  db: Database.Database,
  storeId: string,
  primaryKeyValue: string,
): { redacted: boolean; columns: string[] } {
  const descriptor = getHarvestStoreDescriptor(storeId);
  if (!descriptor || descriptor.mechanism !== "sqlite" || !descriptor.table || !descriptor.primaryKeyColumn) {
    return { redacted: false, columns: [] };
  }
  if (descriptor.contentColumns.length === 0) return { redacted: false, columns: [] };
  // redactedContentValue is null for a nullable column, "" for a NOT NULL one (retention-registry.ts).
  const setClause = descriptor.contentColumns.map((c) => `${c} = @redactedValue`).join(", ");
  db.prepare(`UPDATE ${descriptor.table} SET ${setClause} WHERE ${descriptor.primaryKeyColumn} = @pk`)
    .run({ pk: primaryKeyValue, redactedValue: descriptor.redactedContentValue });
  return { redacted: true, columns: [...descriptor.contentColumns] };
}

// ─── full erasure propagation (through issue #3's accounting) ───────────────────────────────

export interface ContentRedactionRequest {
  storeId: string;
  primaryKeyValue: string;
}

export interface PropagateErasureInput {
  /** The gille-accounting event id (issue #3) this erasure targets. */
  targetEventId: string;
  /** Which harvest store originated the erasure request — recorded on the tombstone. */
  storeId: string;
  /** Opaque, content-blind reference identifying the subject within that store. */
  subjectRef: string;
  erasureRequestedAt: string;
  occurredAt: string;
  note?: string;
  /** Required when the target event's denominator basis includes a Hugin-owned counter. */
  crossOwnerAck?: CrossOwnerAcknowledgement;
  /** Optional: also redact a specific row's content columns as part of this same erasure. */
  contentRedaction?: ContentRedactionRequest;
}

export type PropagateErasureResult =
  | {
      status: "erased";
      adjustment: ErasureAdjustmentEvent;
      tombstone: "created" | "already-erased";
      contentRedacted: boolean;
      /** Non-null iff `contentRedaction` was requested but failed. The erasure ITSELF (the
       *  counter adjustment + tombstone, above) already succeeded and is durable by this point —
       *  content redaction is a best-effort convenience on top, never allowed to turn an
       *  already-completed erasure into an uncaught exception (M5 dogfood review, issue #9). A
       *  caller who sees this set should retry `redactStoreSubjectContent` directly; retrying
       *  `propagateErasure` itself is also safe (both prior writes are natural-key idempotent). */
      contentRedactionError: string | null;
    }
  | { status: "refused"; reason: string };

/**
 * Erase a harvest-source subject: verifies any required cross-owner acknowledgement FIRST, then
 * routes the counter adjustment through issue #3's `writeErasureAdjustment` (which itself re-derives
 * and re-verifies the basis proof before writing anything — see that function's own doc comment),
 * then records the content-blind tombstone and (optionally) redacts the subject's content columns.
 * Fails closed at every step: any refusal leaves the accounting store, the tombstone table, and the
 * content columns completely untouched.
 */
export function propagateErasure(db: Database.Database, input: PropagateErasureInput): PropagateErasureResult {
  ensureSchema(db);

  let target: ReturnType<typeof getGilleAccountingEvent>;
  try {
    target = getGilleAccountingEvent(db, input.targetEventId);
  } catch (err) {
    // A malformed (not merely unknown) event id throws inside getGilleAccountingEvent — fail
    // closed as a refusal here too, never an uncaught exception out of this entry point.
    return { status: "refused", reason: err instanceof Error ? err.message : `malformed target event id: ${input.targetEventId}` };
  }
  if (!target) {
    return { status: "refused", reason: `unknown target accounting event: ${input.targetEventId}` };
  }

  const { counterSet } = denominatorBasisFor(target);
  const requiresHuginAck = counterSet.some((c) => c.owner === "hugin");
  if (requiresHuginAck) {
    if (!input.crossOwnerAck) {
      return {
        status: "refused",
        reason:
          `target event ${input.targetEventId}'s denominator basis includes a Hugin-owned counter ` +
          "— erasure requires an authenticated Hugin cross-owner acknowledgement",
      };
    }
    const ackVerification = verifyCrossOwnerAcknowledgement(db, input.crossOwnerAck);
    if (!ackVerification.verified) {
      return { status: "refused", reason: ackVerification.reason };
    }
  }

  let adjustment: ErasureAdjustmentEvent;
  try {
    const result = writeErasureAdjustment(db, {
      targetEventId: input.targetEventId,
      adjustmentReason: "erasure",
      erasureRequestedAt: input.erasureRequestedAt,
      occurredAt: input.occurredAt,
      ...(input.note ? { note: input.note } : {}),
    });
    adjustment = result.event;
  } catch (err) {
    return { status: "refused", reason: err instanceof Error ? err.message : "erasure adjustment failed" };
  }

  const { status: tombstoneStatus } = recordErasureTombstone(db, {
    storeId: input.storeId,
    subjectRef: input.subjectRef,
    reason: "erasure",
    requestedAt: input.erasureRequestedAt,
  });

  let contentRedacted = false;
  let contentRedactionError: string | null = null;
  if (input.contentRedaction) {
    // The counter adjustment and tombstone above are ALREADY durably committed at this point — a
    // failure here (e.g. a locked db, an unexpected column type) must never surface as an uncaught
    // exception that hides that the erasure itself already succeeded (M5 dogfood review, issue #9).
    try {
      const redaction = redactStoreSubjectContent(db, input.contentRedaction.storeId, input.contentRedaction.primaryKeyValue);
      contentRedacted = redaction.redacted;
    } catch (err) {
      contentRedactionError = err instanceof Error ? err.message : "content redaction failed";
    }
  }

  return { status: "erased", adjustment, tombstone: tombstoneStatus, contentRedacted, contentRedactionError };
}

// ─── future-harvesting exclusion (consumes #3's existing exclusion counter) ──────────────────

/**
 * Exclude a subject from FUTURE harvesting. Deliberately a thin forward to issue #3's own
 * `recordExclusion` — there is no separate exclusion table here, so this can never diverge from the
 * six-counter accounting surface every other reader already consults. `recordExclusion` is itself
 * append-only (a new natural-keyed event), so calling this NEVER rewrites the subject's own prior
 * direct-attempt/direct-exposure/admission/outcome rows (issue #9 AC).
 */
export function excludeSubjectFromHarvesting(
  db: Database.Database,
  input: {
    subjectId: string;
    reason: "retention-owner-opt-out" | "retention-erasure-requested";
    note?: string;
    occurredAt: string;
  },
): AppendResult<ExclusionEvent> {
  return recordExclusion(db, {
    subjectId: input.subjectId,
    exclusionReason: input.reason,
    occurredAt: input.occurredAt,
    ...(input.note ? { note: input.note } : {}),
  });
}

export { HARVEST_STORE_REGISTRY };
