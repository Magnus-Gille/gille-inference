/**
 * mutation-lock.ts — an exclusive LEASE over the routing-table WRITE path (gille-inference#49,
 * Sol-xhigh review round 4 finding 1: "STOP patching the file-CAS primitive — replace it").
 *
 * Round 3 shipped a file-based lock (O_EXCL create + a staleness-age reclaim). Round 4's review
 * reproduced THREE critical races in that mechanism: a double stale-reclaim (two callers both see
 * the lock as stale and both force-take-over), an empty/torn-write file read as "infinitely old"
 * (a corrupt-looking file always looked reclaimable), and a tokenless release that could delete a
 * NEWER owner's lock (a delayed/zombie holder's `release()` had no way to tell "is this still MY
 * lease"). All three are races over a bare file with no atomic compare-and-swap — patching them
 * individually just moves the race elsewhere.
 *
 * This module REPLACES that mechanism with a `better-sqlite3` LEASE: a one-row table in a small,
 * dedicated database under `<dataDir>/autonomy/mutation-lock.db`, mirroring the EXACT ACID idiom
 * `gille-accounting-store.ts` already uses elsewhere in this codebase — `db.transaction(...)
 * .immediate()` acquires SQLite's own writer lock BEFORE the transaction body runs, so two
 * concurrent callers (same process or, because SQLite's write lock is a real OS-level file lock,
 * different processes) can never both observe "the lease looks stale" and both reclaim it: whichever
 * transaction's `.immediate()` wins runs its ENTIRE read-check-reclaim sequence atomically before the
 * other's transaction can even begin. Every acquire (fresh or reclaimed) mints a strictly increasing
 * FENCING TOKEN (`mutation_lease_seq`); `release`/`renew` are themselves transactional
 * `UPDATE ... WHERE token = ?` / `DELETE ... WHERE token = ?` guarded by the caller's OWN token, so a
 * delayed release from a lease that has since been reclaimed affects ZERO rows — it can never touch
 * a newer owner's lease. The empty-file-read class of bug cannot occur at all: SQLite's own
 * transactional consistency guarantees a reader never observes a torn/partial row.
 *
 * The exported API shape is unchanged from round 3 (`acquireMutationLock`, `MutationLockBusyError`,
 * a handle with `release()`) plus a new `renew()` on the handle — call sites barely change.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MutationLockHandle {
  /** The fencing token this specific acquisition was granted — exposed for tests/diagnostics; call
   *  sites do not need to read it themselves. */
  readonly token: number;
  /** Extends the lease's `acquiredAtMs` to "now", guarded by this handle's own token (a no-op,
   *  reported via the return value, if this token has since been superseded by a reclaim — which
   *  should never happen to a caller that releases promptly, but is safe either way). */
  renew: () => { renewed: boolean };
  /** Releases the lease, guarded by this handle's own token — deleting a lease some OTHER, newer
   *  acquisition now holds is structurally impossible (the fencing token simply won't match). */
  release: () => void;
}

export class MutationLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationLockBusyError";
  }
}

/**
 * Round 5 finding 1: acquiring the lease at the START of an operation is only HALF of fencing — the
 * classic completion is verifying the token again AT THE RESOURCE, immediately before the protected
 * mutation actually commits. Without this, a holder whose lease goes stale MID-OPERATION (reclaimed
 * by someone else while this holder was still, say, mid-`adoptRoutingTable`) could still perform its
 * write — silently clobbering the new holder's legitimate work. `MutationLockStaleError` is thrown
 * by `assertLeaseCurrent`/`isLeaseCurrent`'s callers when that has happened; the caller MUST treat
 * this as "nothing was written by me — abort cleanly, no rollback needed, retry (if applicable) next
 * tick" rather than attempting any recovery of its own.
 */
export class MutationLockStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationLockStaleError";
  }
}

/** Generous for a single adopt call's write+reload+canary (seconds, not minutes, in practice) —
 *  tunable via `acquireMutationLock`'s own `staleAfterMs` option. */
export const DEFAULT_MUTATION_LOCK_STALE_AFTER_MS = 5 * 60 * 1000;

export function mutationLockDbPath(dataDir: string): string {
  return join(dataDir, "autonomy", "mutation-lock.db");
}

interface LeaseRow {
  token: number;
  acquired_at_ms: number;
  pid: number;
}

interface SeqRow {
  next_token: number;
}

/**
 * Round 5 finding 3: the watchdog's adoption records + quarantine state move into SQLite, sharing
 * THIS SAME db file (`mutationLockDbPath`) — so a fencing check and the protected write it guards
 * can commit inside ONE transaction on one connection, never two. Exported so
 * `adoption-watchdog.ts` can open its OWN connection to the identical file and call this to ensure
 * the lease tables exist there too (idempotent — `CREATE TABLE IF NOT EXISTS`), before adding its
 * own tables in the same `db.exec` call.
 */
export function ensureLeaseTables(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 2000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS mutation_lease (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      token          INTEGER NOT NULL,
      acquired_at_ms INTEGER NOT NULL,
      pid            INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mutation_lease_seq (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      next_token INTEGER NOT NULL
    );
  `);
}

function openLeaseDb(dataDir: string): Database.Database {
  const path = mutationLockDbPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureLeaseTables(db);
  return db;
}

/**
 * Round 5 finding 1 — the fencing check itself, usable two ways:
 *   - Standalone (`assertLeaseCurrent`, below) for a protected mutation that is NOT already sharing
 *     a SQLite transaction with the lease table (e.g. the adoption-intent journal, still a plain
 *     file) — opens its own connection, checks, closes.
 *   - Inline (`isLeaseCurrent`) for a caller (adoption-watchdog.ts's SQLite-backed state) that wants
 *     the token check and its own protected write to commit in the SAME transaction, on the SAME
 *     already-open connection to this db file — true same-transaction atomicity, not a check
 *     followed by a separate write with its own tiny race window.
 */
export function isLeaseCurrent(db: Database.Database, token: number): boolean {
  const row = db.prepare(`SELECT token FROM mutation_lease WHERE id = 1`).get() as { token: number } | undefined;
  return row !== undefined && row.token === token;
}

/**
 * Throws `MutationLockStaleError` unless `token` is still the CURRENT lease's token, checked
 * transactionally against the live db. Call immediately before a protected mutation actually
 * commits — this is the "fencing enforced at the resource" completion (round 5 finding 1), not a
 * substitute for holding the lease throughout the operation.
 *
 * Round 6 finding 1: this function ALONE is check-then-write, not check-AND-write — there is a
 * (tiny, but real) window between this function returning and the caller's OWN subsequent
 * filesystem write during which another holder could reclaim the lease. `fencedWrite` (below)
 * closes that window; this standalone assertion remains useful only for a caller with NO
 * synchronous write to fence (there is none left in this codebase after round 6 — kept exported for
 * diagnostics/tests and any future non-write protected action).
 */
export function assertLeaseCurrent(dataDir: string, token: number): void {
  const db = openLeaseDb(dataDir);
  try {
    const current = db.transaction((): boolean => isLeaseCurrent(db, token)).immediate();
    if (!current) {
      throw new MutationLockStaleError(
        `mutation-lock: fencing token ${token} is no longer the current lease (it was reclaimed by another holder) — refusing to commit a protected mutation with a stale token.`
      );
    }
  } finally {
    db.close();
  }
}

/**
 * Round 6 finding 1: the PROPER fencing completion. `assertLeaseCurrent` followed by a separate,
 * un-transactioned filesystem write is check-then-write — there is a window between the two in
 * which another caller's OWN `acquireMutationLock`/`fencedWrite`/`renewMutationLock`/
 * `releaseMutationLock` transaction could reclaim the lease and even complete its OWN write before
 * this caller's write ever happens. `fencedWrite` closes that window by running `fn` (the actual
 * filesystem mutation — MUST be synchronous; better-sqlite3 transactions cannot await) INSIDE the
 * SAME `db.transaction(...).immediate()` critical section as the token check: `.immediate()`
 * acquires SQLite's RESERVED writer lock on this db file before the callback runs, and every OTHER
 * lease operation on this SAME file (acquire/renew/release/another fencedWrite) also goes through
 * `.immediate()` — so a competing writer cannot even BEGIN its own transaction (let alone reclaim
 * the lease) until this one commits. The check and the write are therefore atomic with respect to
 * every other lease operation, not just "checked, then hopefully still true a moment later."
 *
 * Throws `MutationLockStaleError` (nothing written) if `token` is not the current lease at the
 * instant the transaction begins. Propagates whatever `fn` itself throws (e.g. a real disk error)
 * after the transaction implicitly rolls back the SQLite side (the lease row itself is unaffected
 * either way — this transaction never mutates it, only reads it to check).
 */
export function fencedWrite<T>(dataDir: string, token: number, fn: () => T): T {
  const db = openLeaseDb(dataDir);
  try {
    const run = db.transaction((): T => {
      if (!isLeaseCurrent(db, token)) {
        throw new MutationLockStaleError(
          `mutation-lock: fencing token ${token} is no longer the current lease (it was reclaimed by another holder) — refusing to commit a protected mutation with a stale token.`
        );
      }
      return fn();
    });
    return run.immediate();
  } finally {
    db.close();
  }
}

type AcquireResult = { ok: true; token: number } | { ok: false; ageMs: number };

/**
 * Acquires the exclusive routing-table mutation lease. Throws `MutationLockBusyError` if a
 * genuinely fresh lease is held by someone else; otherwise returns a handle whose `release()` MUST
 * be called (in a `finally` block) once the caller's own hash-recheck + `adoptRoutingTable` call +
 * paired watch-record commit completes, success or failure alike.
 */
export function acquireMutationLock(
  dataDir: string,
  opts: { staleAfterMs?: number; nowMs?: number } = {}
): MutationLockHandle {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_MUTATION_LOCK_STALE_AFTER_MS;
  const nowMs = opts.nowMs ?? Date.now();
  const db = openLeaseDb(dataDir);
  try {
    const acquire = db.transaction((): AcquireResult => {
      const existing = db.prepare(`SELECT token, acquired_at_ms, pid FROM mutation_lease WHERE id = 1`).get() as
        | LeaseRow
        | undefined;
      if (existing) {
        const ageMs = nowMs - existing.acquired_at_ms;
        if (ageMs <= staleAfterMs) {
          return { ok: false, ageMs };
        }
      }
      // Absent or stale — take over (insert-or-replace) with a FRESH, strictly higher token, minted
      // and consumed atomically in the SAME transaction as the reclaim itself.
      const seqRow = db.prepare(`SELECT next_token FROM mutation_lease_seq WHERE id = 1`).get() as SeqRow | undefined;
      const token = seqRow?.next_token ?? 1;
      db.prepare(
        `INSERT INTO mutation_lease (id, token, acquired_at_ms, pid) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET token = excluded.token, acquired_at_ms = excluded.acquired_at_ms, pid = excluded.pid`
      ).run(token, nowMs, process.pid);
      db.prepare(
        `INSERT INTO mutation_lease_seq (id, next_token) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET next_token = excluded.next_token`
      ).run(token + 1);
      return { ok: true, token };
    }).immediate();

    if (!acquire.ok) {
      throw new MutationLockBusyError(
        `mutation-lock: the routing-table mutation lease is held (age ${Math.round(acquire.ageMs / 1000)}s, at or below the ${Math.round(
          staleAfterMs / 1000
        )}s stale threshold) — refusing to mutate the routing table concurrently.`
      );
    }
    const token = acquire.token;
    return {
      token,
      renew: () => renewMutationLock(dataDir, token),
      release: () => releaseMutationLock(dataDir, token),
    };
  } finally {
    db.close();
  }
}

/** Extends a held lease's `acquired_at_ms` to "now", guarded by the SAME fencing token — a
 *  transactional `UPDATE ... WHERE token = ?`, so this can never touch a lease some OTHER,
 *  subsequently-reclaimed acquisition now holds. Returns `{renewed: false}` (never throws) if this
 *  token has since been superseded. Exported (round 6 finding 1) so a caller holding only
 *  `{dataDir, token}` (not the original `MutationLockHandle`) — e.g. `routing-lifecycle.ts`,
 *  re-asserting/renewing immediately after a potentially-slow gateway reload — can keep the lease
 *  fresh without needing the handle itself. */
export function renewMutationLock(dataDir: string, token: number, nowMs: number = Date.now()): { renewed: boolean } {
  const db = openLeaseDb(dataDir);
  try {
    return db.transaction((): { renewed: boolean } => {
      const result = db.prepare(`UPDATE mutation_lease SET acquired_at_ms = ? WHERE id = 1 AND token = ?`).run(nowMs, token);
      return { renewed: result.changes > 0 };
    }).immediate();
  } finally {
    db.close();
  }
}

/** Releases a held lease, guarded by the SAME fencing token — a transactional
 *  `DELETE ... WHERE token = ?`. A release call whose token no longer matches (because the lease
 *  was reclaimed as stale in the meantime) affects zero rows — it is structurally impossible for a
 *  delayed/zombie holder's release to delete a newer owner's lease. */
function releaseMutationLock(dataDir: string, token: number): void {
  const db = openLeaseDb(dataDir);
  try {
    db.transaction(() => {
      db.prepare(`DELETE FROM mutation_lease WHERE id = 1 AND token = ?`).run(token);
    }).immediate();
  } finally {
    db.close();
  }
}
