/**
 * Content-addressed store for evidence-identity bundles (issue #5).
 *
 * A `delegations` row (ledger.ts) keeps only a hash — `evidence_identity_hash`. This is the
 * minimal reference store an operator needs to go the other way: hash -> the exact bundle that
 * produced it (model artifact/build/quantization, configuration epoch, logical task, rendered
 * prompt, harness, taxonomy version, verifier/rubric, sampling, tool policy, lane), i.e.
 * reconstructability (AC2 of #5). Same SQLite idiom as learning-task-admission-store.ts: a small,
 * dedicated table with a WeakSet-guarded idempotent schema init and a content-addressed primary
 * key, so writing the same bundle twice is a cheap idempotent upsert rather than a duplicate row.
 */

import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { evidenceIdentityHash, type EvidenceIdentityBundle } from "./evidence-identity.js";

interface SnapshotRow {
  identity_hash: string;
  bundle_json: string;
  first_seen_at: string;
  last_seen_at: string;
  observation_count: number;
}

export interface EvidenceIdentitySnapshot {
  identityHash: string;
  bundle: EvidenceIdentityBundle;
  /** First time this exact bundle (by content hash) was observed. */
  firstSeenAt: string;
  /** Most recent time this exact bundle was observed — bumped on every upsert. */
  lastSeenAt: string;
  /** How many delegations rows have referenced this identity (best-effort — see upsert note). */
  observationCount: number;
}

const initialized = new WeakSet<Database.Database>();

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_identity_snapshots (
      identity_hash      TEXT PRIMARY KEY,
      bundle_json         TEXT NOT NULL,
      first_seen_at       TEXT NOT NULL,
      last_seen_at        TEXT NOT NULL,
      observation_count   INTEGER NOT NULL DEFAULT 1
    );
  `);
  initialized.add(db);
}

/** Eagerly create the snapshot schema (idempotent) — mirrors ledger.ts's ensureLedgerSchema. */
export function ensureEvidenceIdentitySnapshotSchema(): void {
  ensureSchema(getDb());
}

/**
 * Idempotently upsert one bundle snapshot. The primary key IS the bundle's own content hash, so a
 * byte-identical bundle observed again bumps `last_seen_at`/`observation_count` in place; a bundle
 * that differs in any field always lands at a different key — it can never overwrite another
 * identity's reconstruction record. Returns the hash (== evidenceIdentityHash(bundle)) for the
 * caller to store as the ledger row's `evidence_identity_hash`.
 *
 * `last_seen_at` update is MAX(existing, incoming), not a blind overwrite (M5 dogfood review,
 * issue #5): under WAL, two concurrent writers on different processes can commit their single-
 * statement upserts in an order that does not match their `nowIso` wall-clock order (writer B's
 * earlier-timestamped call can commit after writer A's later-timestamped one). A blind overwrite
 * would let `last_seen_at` regress; MAX keeps it monotonic regardless of commit order.
 * `bundle_json` itself is NEVER updated on conflict — content-addressing means the row for a given
 * hash is immutable by construction, so a snapshot cannot be mutated into a placeholder after the
 * fact.
 */
export function upsertEvidenceIdentitySnapshot(
  bundle: EvidenceIdentityBundle,
  nowIso: string,
  db: Database.Database = getDb()
): string {
  ensureSchema(db);
  const hash = evidenceIdentityHash(bundle);
  db.prepare(
    `INSERT INTO evidence_identity_snapshots (identity_hash, bundle_json, first_seen_at, last_seen_at, observation_count)
     VALUES (@hash, @bundleJson, @now, @now, 1)
     ON CONFLICT(identity_hash) DO UPDATE SET
       last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
       observation_count = observation_count + 1`
  ).run({ hash, bundleJson: JSON.stringify(bundle), now: nowIso });
  return hash;
}

/** Resolve a hash back to the exact bundle that produced it, or null if never observed. */
export function getEvidenceIdentitySnapshot(
  identityHash: string,
  db: Database.Database = getDb()
): EvidenceIdentitySnapshot | null {
  ensureSchema(db);
  const row = db
    .prepare(
      `SELECT identity_hash, bundle_json, first_seen_at, last_seen_at, observation_count
       FROM evidence_identity_snapshots WHERE identity_hash = ?`
    )
    .get(identityHash) as SnapshotRow | undefined;
  if (!row) return null;
  return {
    identityHash: row.identity_hash,
    bundle: JSON.parse(row.bundle_json) as EvidenceIdentityBundle,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    observationCount: row.observation_count,
  };
}
