/**
 * Natural-key registry for imported Hugin experiment-outcome observations (issue #8).
 *
 * ledger.importDelegations() already gives idempotent, content-hashed insertion of a single
 * evidence row (issue #151) — that primitive is reused directly for the actual `delegations`
 * write (see experiment-import.ts). What that primitive does NOT give us is a notion of "the
 * SAME real-world observation (this experiment's this arm's this sample) re-imported under a
 * DIFFERENT run" — a champion/challenger experiment can legitimately be re-run, corrected, or
 * resent, and the import contract (issue #8 AC + the learning-task-contract.md correction-lineage
 * rules it is scoped under) requires telling apart:
 *
 *   - an exact byte-identical resend of the same run's observation (idempotent no-op — handled by
 *     importDelegations already, but we still need our own pointer row to stay in sync);
 *   - a DIFFERENT run's observation of the SAME (experiment, arm, sample) "subject" that explicitly
 *     claims to correct a prior run (`supersedesRunId`) — a valid, admitted correction;
 *   - a stale/out-of-order observation of the same subject arriving after a newer one, with no
 *     correction claim — rejected `superseded`;
 *   - the SAME run resent with DIFFERENT content — rejected `conflicting` (a run's observation must
 *     not silently mutate; mirrors the contract's "different canonical JSON at one natural key fails
 *     unless the newer record explicitly targets the existing record").
 *
 * This module is the small, dedicated store that makes those dispositions queryable — same idiom
 * as evidence-identity-store.ts (a WeakSet-guarded idempotent schema init, content-addressed keys).
 *
 * It ALSO carries the linked-but-not-flattened product rating (AC: "product rating remains LINKED
 * but is never flattened into a mechanical capability pass"): a rating is stored here, joinable by
 * natural/subject key, and is NEVER written into delegations.outcome or any other mechanical-verdict
 * column — see ledger.ts's Outcome type, which has no "accepted"/"rejected" product-rating values.
 */

import type Database from "better-sqlite3";
import { getDb } from "../db.js";

export type ExperimentProductOutcome = "accepted" | "rejected" | "conflicted" | "unrated";

export interface ExperimentProductRating {
  ratingId: string;
  reviewerId: string;
  productOutcome: ExperimentProductOutcome;
  reasonDigest: string;
  ratedAt: string;
}

export interface ExperimentImportSubject {
  experimentId: string;
  armId: string;
  sampleId: string;
}

export interface ExperimentImportRecord extends ExperimentImportSubject {
  runId: string;
  contentHash: string;
  delegationId: string;
  recordedAt: string;
  policyEpoch: string;
  experimentStatus: string;
  importedAt: string;
  /** Non-null once a LATER run explicitly targeted this one as its correction predecessor. */
  supersededByRunId: string | null;
  rating: ExperimentProductRating | null;
}

interface RegistryRow {
  natural_key: string;
  subject_key: string;
  experiment_id: string;
  run_id: string;
  arm_id: string;
  sample_id: string;
  content_hash: string;
  delegation_id: string;
  recorded_at: string;
  policy_epoch: string;
  experiment_status: string;
  imported_at: string;
  superseded_by_run_id: string | null;
  rating_id: string | null;
  reviewer_id: string | null;
  product_outcome: string | null;
  reason_digest: string | null;
  rated_at: string | null;
}

const initialized = new WeakSet<Database.Database>();

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiment_import_records (
      natural_key          TEXT PRIMARY KEY,
      subject_key          TEXT NOT NULL,
      experiment_id        TEXT NOT NULL,
      run_id                TEXT NOT NULL,
      arm_id                TEXT NOT NULL,
      sample_id             TEXT NOT NULL,
      content_hash          TEXT NOT NULL,
      delegation_id         TEXT NOT NULL,
      recorded_at            TEXT NOT NULL,
      policy_epoch           TEXT NOT NULL,
      experiment_status      TEXT NOT NULL,
      imported_at            TEXT NOT NULL,
      superseded_by_run_id   TEXT,
      rating_id              TEXT,
      reviewer_id            TEXT,
      product_outcome        TEXT,
      reason_digest           TEXT,
      rated_at                TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_exp_import_subject ON experiment_import_records(subject_key);
  `);
  initialized.add(db);
}

/** Eagerly create the schema (idempotent) — mirrors ledger.ts's ensureLedgerSchema. */
export function ensureExperimentImportSchema(): void {
  ensureSchema(getDb());
}

export function subjectKeyOf(s: ExperimentImportSubject): string {
  return `${s.experimentId}|${s.armId}|${s.sampleId}`;
}

export function naturalKeyOf(s: ExperimentImportSubject & { runId: string }): string {
  return `${s.experimentId}|${s.runId}|${s.armId}|${s.sampleId}`;
}

function fromRow(row: RegistryRow): ExperimentImportRecord {
  return {
    experimentId: row.experiment_id,
    runId: row.run_id,
    armId: row.arm_id,
    sampleId: row.sample_id,
    contentHash: row.content_hash,
    delegationId: row.delegation_id,
    recordedAt: row.recorded_at,
    policyEpoch: row.policy_epoch,
    experimentStatus: row.experiment_status,
    importedAt: row.imported_at,
    supersededByRunId: row.superseded_by_run_id,
    rating:
      row.rating_id !== null &&
      row.reviewer_id !== null &&
      row.product_outcome !== null &&
      row.reason_digest !== null &&
      row.rated_at !== null
        ? {
            ratingId: row.rating_id,
            reviewerId: row.reviewer_id,
            productOutcome: row.product_outcome as ExperimentProductOutcome,
            reasonDigest: row.reason_digest,
            ratedAt: row.rated_at,
          }
        : null,
  };
}

/** Exact (experiment, run, arm, sample) lookup — the idempotency/conflict-detection key. */
export function getExperimentImportRecord(
  key: ExperimentImportSubject & { runId: string },
  db: Database.Database = getDb()
): ExperimentImportRecord | null {
  ensureSchema(db);
  const row = db
    .prepare(`SELECT * FROM experiment_import_records WHERE natural_key = ?`)
    .get(naturalKeyOf(key)) as RegistryRow | undefined;
  return row ? fromRow(row) : null;
}

/**
 * The single currently-active (never superseded) record for a subject, if any — the reference
 * point for correction/supersession/staleness decisions. `active` deliberately excludes any row
 * with `superseded_by_run_id` set; if more than one non-superseded row somehow exists (should not
 * happen under this module's own write discipline) the most recently recorded one wins, so a
 * lookup never throws on unexpected state.
 */
export function getActiveExperimentSubjectRecord(
  subject: ExperimentImportSubject,
  db: Database.Database = getDb()
): ExperimentImportRecord | null {
  ensureSchema(db);
  const row = db
    .prepare(
      `SELECT * FROM experiment_import_records
       WHERE subject_key = ? AND superseded_by_run_id IS NULL
       ORDER BY recorded_at DESC LIMIT 1`
    )
    .get(subjectKeyOf(subject)) as RegistryRow | undefined;
  return row ? fromRow(row) : null;
}

/** Full history (every run, including superseded ones) for a subject — audit trail, newest first. */
export function getExperimentSubjectHistory(
  subject: ExperimentImportSubject,
  db: Database.Database = getDb()
): ExperimentImportRecord[] {
  ensureSchema(db);
  const rows = db
    .prepare(`SELECT * FROM experiment_import_records WHERE subject_key = ? ORDER BY recorded_at DESC`)
    .all(subjectKeyOf(subject)) as RegistryRow[];
  return rows.map(fromRow);
}

export interface InsertExperimentImportRecordInput {
  experimentId: string;
  runId: string;
  armId: string;
  sampleId: string;
  contentHash: string;
  delegationId: string;
  recordedAt: string;
  policyEpoch: string;
  experimentStatus: string;
  importedAt: string;
  rating: ExperimentProductRating | null;
}

/** Insert a brand-new natural-key row (the natural key MUST NOT already exist — callers check
 *  getExperimentImportRecord() first; this throws on a primary-key collision rather than silently
 *  overwriting, which would defeat the conflict-detection this store exists to provide). */
export function insertExperimentImportRecord(
  input: InsertExperimentImportRecordInput,
  db: Database.Database = getDb()
): void {
  ensureSchema(db);
  db.prepare(
    `INSERT INTO experiment_import_records
       (natural_key, subject_key, experiment_id, run_id, arm_id, sample_id, content_hash,
        delegation_id, recorded_at, policy_epoch, experiment_status, imported_at,
        superseded_by_run_id, rating_id, reviewer_id, product_outcome, reason_digest, rated_at)
     VALUES
       (@naturalKey, @subjectKey, @experimentId, @runId, @armId, @sampleId, @contentHash,
        @delegationId, @recordedAt, @policyEpoch, @experimentStatus, @importedAt,
        NULL, @ratingId, @reviewerId, @productOutcome, @reasonDigest, @ratedAt)`
  ).run({
    naturalKey: naturalKeyOf(input),
    subjectKey: subjectKeyOf(input),
    experimentId: input.experimentId,
    runId: input.runId,
    armId: input.armId,
    sampleId: input.sampleId,
    contentHash: input.contentHash,
    delegationId: input.delegationId,
    recordedAt: input.recordedAt,
    policyEpoch: input.policyEpoch,
    experimentStatus: input.experimentStatus,
    importedAt: input.importedAt,
    ratingId: input.rating?.ratingId ?? null,
    reviewerId: input.rating?.reviewerId ?? null,
    productOutcome: input.rating?.productOutcome ?? null,
    reasonDigest: input.rating?.reasonDigest ?? null,
    ratedAt: input.rating?.ratedAt ?? null,
  });
}

/** Mark one run's natural-key row as superseded by a later correcting run. Idempotent — setting it
 *  to the same value twice is a no-op change count of 0 on the second call, never an error. */
export function markExperimentImportRecordSuperseded(
  key: ExperimentImportSubject & { runId: string },
  supersededByRunId: string,
  db: Database.Database = getDb()
): void {
  ensureSchema(db);
  db.prepare(
    `UPDATE experiment_import_records SET superseded_by_run_id = @by
     WHERE natural_key = @key AND (superseded_by_run_id IS NULL OR superseded_by_run_id != @by)`
  ).run({ key: naturalKeyOf(key), by: supersededByRunId });
}
