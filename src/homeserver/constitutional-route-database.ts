import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  ConstitutionalFencedLease,
  currentConstitutionalBootId,
  type ConstitutionalLeaseOptions,
} from "./constitutional-fenced-lease.js";

export interface RouteFence {
  epoch: number;
  token: string;
}

/** Immutable identity of a watchdog-created serving guard. */
export interface RouteGuardOwner {
  journalId: string;
  attemptId: string;
  bindingDigest: string;
  targetScopeDigest: string;
  watchdogIdentity: string;
}

/**
 * Immutable identity and absolute serving deadline for an in-flight candidate.
 * This is deliberately stored with the route value, rather than only in the
 * controller journal: the gateway must still fail closed if both controller
 * and recovery worker are unavailable.
 */
export interface CandidateRouteDeadline {
  journalId: string;
  attemptId: string;
  bindingDigest: string;
  targetScopeDigest: string;
  candidateDigest: string;
  notAfter: string;
}

export interface ConstitutionalRouteReadClock {
  wallNowMs?: () => number;
  monotonicNowNs?: () => bigint;
  bootId?: () => string;
}

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{2,120}$/;

export class ConstitutionalRouteBlockedError extends Error {
  constructor() {
    super("constitutional route is fail-closed blocked");
    this.name = "ConstitutionalRouteBlockedError";
  }
}

export class ConstitutionalRouteDatabase {
  constructor(private readonly path: string) {
    const db = open(this.path);
    db.close();
  }

  acquireWriterLease(options: ConstitutionalLeaseOptions = {}): ConstitutionalFencedLease {
    if (options.monotonicNowNs !== undefined || options.bootId !== undefined) {
      throw new Error("authoritative route leases require the host monotonic clock and boot ID");
    }
    return ConstitutionalFencedLease.acquire(this.path, options);
  }

  read(): string {
    const db = open(this.path);
    try {
      const row = db.prepare("SELECT value FROM constitutional_route WHERE id=1")
        .get() as { value: string } | undefined;
      if (!row) throw new Error("constitutional route database is not owner-initialized");
      return row.value;
    } finally {
      db.close();
    }
  }

  /**
   * The fence comparison and route mutation are one SQLite transaction at the
   * authoritative resource. An older epoch can never overwrite a newer one,
   * even if its client was SIGSTOPed after every client-side check.
   */
  compareAndSwap(
    expected: string,
    next: string,
    fence: RouteFence,
    candidateDeadline?: CandidateRouteDeadline,
  ): boolean {
    validateFence(fence);
    if (candidateDeadline !== undefined) validateCandidateDeadline(candidateDeadline, next);
    const db = open(this.path);
    try {
      return db.transaction(() => {
        const row = db.prepare("SELECT value FROM constitutional_route WHERE id=1")
          .get() as { value: string } | undefined;
        if (!row || row.value !== expected) return false;
        if (!routeLeaseCurrent(db, fence)) return false;
        const result = db.prepare(`
          UPDATE constitutional_route
          SET value=?, value_digest=?
          WHERE id=1 AND value=?
        `).run(next, sha(next), expected);
        if (result.changes !== 1) return false;
        if (candidateDeadline === undefined) {
          clearCandidateDeadline(db);
        } else {
          setCandidateDeadline(db, candidateDeadline);
        }
        return true;
      }).immediate();
    } finally {
      db.close();
    }
  }

  restoreExact(expectedCandidateDigest: string, baseline: string, fence: RouteFence): boolean {
    validateFence(fence);
    const db = open(this.path);
    try {
      return db.transaction(() => {
        const row = db.prepare("SELECT value_digest FROM constitutional_route WHERE id=1")
          .get() as { value_digest: string } | undefined;
        if (
          !row
          || row.value_digest !== expectedCandidateDigest
          || !routeLeaseCurrent(db, fence)
        ) return false;
        const result = db.prepare(`
          UPDATE constitutional_route
          SET value=?, value_digest=?
          WHERE id=1 AND value_digest=?
        `).run(baseline, sha(baseline), expectedCandidateDigest);
        if (result.changes !== 1) return false;
        clearCandidateDeadline(db);
        return true;
      }).immediate();
    } finally {
      db.close();
    }
  }

  /**
   * A durable commit makes the exact candidate non-expiring. This operation
   * is fenced and bound to the candidate's immutable identity, so an old
   * worker can neither promote a successor nor extend a different attempt.
   */
  clearCandidateDeadline(candidate: CandidateRouteDeadline, fence: RouteFence): boolean {
    validateFence(fence);
    const db = open(this.path);
    try {
      return db.transaction(() => {
        const route = db.prepare("SELECT value_digest FROM constitutional_route WHERE id=1")
          .get() as { value_digest: string } | undefined;
        const stored = db.prepare(`
          SELECT journal_id, attempt_id, binding_digest, target_scope_digest, candidate_digest, not_after
          FROM constitutional_route_candidate_deadline WHERE id=1
        `).get() as CandidateDeadlineRow | undefined;
        // Commit is durable before this deadline cleanup. A watchdog must be
        // able to replay the cleanup after a crash, including when the
        // controller already cleared the exact row successfully. The route
        // digest and current fence remain mandatory; a missing row is only an
        // idempotent success for that already-committed candidate.
        if (!route || route.value_digest !== candidate.candidateDigest || !routeLeaseCurrent(db, fence)) return false;
        if (stored !== undefined && !sameCandidateDeadline(stored, candidate)) return false;
        if (stored !== undefined) clearCandidateDeadline(db);
        return true;
      }).immediate();
    } finally {
      db.close();
    }
  }

  block(fence: RouteFence, owner?: RouteGuardOwner): boolean {
    if (owner !== undefined) validateGuardOwner(owner);
    return this.setBlocked(fence, owner);
  }

  /** Clears only the exact watchdog attempt which created this guard. */
  clearOwnedBlock(fence: RouteFence, owner: RouteGuardOwner): boolean {
    validateFence(fence);
    validateGuardOwner(owner);
    const db = open(this.path);
    try {
      return db.transaction(() => {
        if (!routeLeaseCurrent(db, fence)) return false;
        const result = db.prepare(`
          UPDATE constitutional_route_guard SET blocked=0
          WHERE id=1 AND blocked=1 AND owner_journal_id=? AND owner_attempt_id=?
            AND owner_binding_digest=? AND owner_target_scope_digest=? AND owner_watchdog_identity=?
        `).run(owner.journalId, owner.attemptId, owner.bindingDigest, owner.targetScopeDigest, owner.watchdogIdentity);
        return result.changes === 1;
      }).immediate();
    } finally { db.close(); }
  }

  isBlocked(): boolean {
    const db = open(this.path);
    try {
      const row = db.prepare("SELECT blocked FROM constitutional_route_guard WHERE id=1")
        .get() as { blocked: number } | undefined;
      return row?.blocked === 1;
    } finally {
      db.close();
    }
  }

  private setBlocked(fence: RouteFence, owner?: RouteGuardOwner): boolean {
    validateFence(fence);
    const db = open(this.path);
    try {
      return db.transaction(() => {
        if (!routeLeaseCurrent(db, fence)) return false;
        // Guard ownership is a capability boundary, not diagnostic metadata.
        // A watchdog can attach its identity only while atomically taking an
        // unblocked route. Once blocked, including by an operator or a
        // different watchdog attempt, the existing guard must remain intact.
        const result = db.prepare(`
          UPDATE constitutional_route_guard SET blocked=1, owner_journal_id=?, owner_attempt_id=?,
            owner_binding_digest=?, owner_target_scope_digest=?, owner_watchdog_identity=?,
            owner_fence_epoch=?, owner_fence_token=?
          WHERE id=1 AND blocked=0
        `).run(
          owner?.journalId ?? null, owner?.attemptId ?? null,
          owner?.bindingDigest ?? null, owner?.targetScopeDigest ?? null, owner?.watchdogIdentity ?? null,
          owner ? fence.epoch : null, owner ? fence.token : null,
        );
        return result.changes === 1;
      }).immediate();
    } finally {
      db.close();
    }
  }
}

export function initializeConstitutionalRouteDatabase(path: string, value: string): void {
  const db = open(path);
  try {
    db.prepare(`
      INSERT INTO constitutional_route(id, value, value_digest)
      VALUES(1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(value, sha(value));
  } finally {
    db.close();
  }
}

export function readConstitutionalRouteDatabase(path: string, clock: ConstitutionalRouteReadClock = {}): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    return db.transaction(() => {
      // A serving decision is one coherent resource snapshot. Without this
      // transaction, a concurrent restore/block could interleave between the
      // guard, route, and deadline reads and serve a mixed generation.
      const guard = db.prepare("SELECT blocked FROM constitutional_route_guard WHERE id=1")
        .get() as { blocked: number } | undefined;
      if (guard?.blocked === 1) throw new ConstitutionalRouteBlockedError();
      const row = db.prepare("SELECT value FROM constitutional_route WHERE id=1")
        .get() as { value: string } | undefined;
      if (!row) throw new Error("constitutional route database is not owner-initialized");
      const deadline = db.prepare(`
        SELECT journal_id, attempt_id, binding_digest, target_scope_digest, candidate_digest, not_after,
               activated_wall_ms, activated_monotonic_ns, activated_boot_id
        FROM constitutional_route_candidate_deadline WHERE id=1
      `).get() as CandidateDeadlineRow | undefined;
      if (deadline !== undefined) {
        if (sha(row.value) !== deadline.candidate_digest || candidateExpired(deadline, clock)) {
          throw new ConstitutionalRouteBlockedError();
        }
      }
      return row.value;
    })();
  } finally {
    db.close();
  }
}

function validateFence(fence: RouteFence): void {
  if (!Number.isSafeInteger(fence.epoch) || fence.epoch < 1 || !/^[a-f0-9-]{36}$/.test(fence.token)) {
    throw new Error("invalid constitutional route fence");
  }
}

function validateGuardOwner(owner: RouteGuardOwner): void {
  if (!ID.test(owner.journalId) || !ID.test(owner.attemptId) || !ID.test(owner.watchdogIdentity)
    || !DIGEST.test(owner.bindingDigest) || !DIGEST.test(owner.targetScopeDigest)) {
    throw new Error("invalid constitutional route guard owner");
  }
}

function routeLeaseCurrent(db: Database.Database, fence: RouteFence): boolean {
  const row = db.prepare(`
    SELECT epoch, token, expires_monotonic_ns, boot_id
    FROM constitutional_writer_lease WHERE id=1
  `).get() as {
    epoch: number;
    token: string;
    expires_monotonic_ns: string;
    boot_id: string;
  } | undefined;
  return row !== undefined
    && row.epoch === fence.epoch
    && row.token === fence.token
    && row.boot_id === currentConstitutionalBootId()
    && /^\d+$/.test(row.expires_monotonic_ns)
    && process.hrtime.bigint() < BigInt(row.expires_monotonic_ns);
}

interface CandidateDeadlineRow {
  journal_id: string;
  attempt_id: string;
  binding_digest: string;
  target_scope_digest: string;
  candidate_digest: string;
  not_after: string;
  activated_wall_ms: number;
  activated_monotonic_ns: string;
  activated_boot_id: string;
}

function validateCandidateDeadline(value: CandidateRouteDeadline, candidate: string): void {
  if (!ID.test(value.journalId) || !ID.test(value.attemptId)
    || !DIGEST.test(value.bindingDigest) || !DIGEST.test(value.targetScopeDigest)
    || value.candidateDigest !== sha(candidate)) {
    throw new Error("invalid constitutional candidate deadline identity");
  }
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.notAfter)
    || !Number.isFinite(Date.parse(value.notAfter))
    || new Date(Date.parse(value.notAfter)).toISOString().replace(".000Z", "Z") !== value.notAfter) {
    throw new Error("invalid constitutional candidate deadline");
  }
}

function setCandidateDeadline(db: Database.Database, value: CandidateRouteDeadline): void {
  db.prepare(`
    INSERT INTO constitutional_route_candidate_deadline(
      id, journal_id, attempt_id, binding_digest, target_scope_digest, candidate_digest, not_after,
      activated_wall_ms, activated_monotonic_ns, activated_boot_id
    ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      journal_id=excluded.journal_id, attempt_id=excluded.attempt_id, binding_digest=excluded.binding_digest,
      target_scope_digest=excluded.target_scope_digest, candidate_digest=excluded.candidate_digest,
      not_after=excluded.not_after, activated_wall_ms=excluded.activated_wall_ms,
      activated_monotonic_ns=excluded.activated_monotonic_ns, activated_boot_id=excluded.activated_boot_id
  `).run(
    value.journalId, value.attemptId, value.bindingDigest, value.targetScopeDigest, value.candidateDigest,
    value.notAfter, Date.now(), process.hrtime.bigint().toString(), currentConstitutionalBootId(),
  );
}

function clearCandidateDeadline(db: Database.Database): void {
  db.prepare("DELETE FROM constitutional_route_candidate_deadline WHERE id=1").run();
}

function sameCandidateDeadline(row: CandidateDeadlineRow, value: CandidateRouteDeadline): boolean {
  return row.journal_id === value.journalId
    && row.attempt_id === value.attemptId
    && row.binding_digest === value.bindingDigest
    && row.target_scope_digest === value.targetScopeDigest
    && row.candidate_digest === value.candidateDigest
    && row.not_after === value.notAfter;
}

function candidateExpired(row: CandidateDeadlineRow, clock: ConstitutionalRouteReadClock): boolean {
  const wallNow = (clock.wallNowMs ?? Date.now)();
  if (!Number.isFinite(wallNow)) return true;
  let effectiveNow = wallNow;
  const bootId = (clock.bootId ?? currentConstitutionalBootId)();
  // After a reboot there is no trustworthy relationship between this boot's
  // monotonic clock and the activation anchor. A rolled-back RTC must never
  // buy a candidate more serving time, so fail closed until an exact commit or
  // exact recovery clears the durable candidate record.
  if (bootId !== row.activated_boot_id) return true;
  const monotonicNow = (clock.monotonicNowNs ?? process.hrtime.bigint)();
  if (monotonicNow < 0n || !/^\d+$/.test(row.activated_monotonic_ns)) return true;
  const activatedMonotonic = BigInt(row.activated_monotonic_ns);
  if (monotonicNow >= activatedMonotonic) {
    const elapsedMs = Number((monotonicNow - activatedMonotonic) / 1_000_000n);
    if (!Number.isSafeInteger(elapsedMs)) return true;
    effectiveNow = Math.max(effectiveNow, row.activated_wall_ms + elapsedMs);
  }
  return effectiveNow >= Date.parse(row.not_after);
}

function open(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o770 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS constitutional_route (
      id INTEGER PRIMARY KEY CHECK(id=1),
      value TEXT NOT NULL,
      value_digest TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS constitutional_route_guard (
      id INTEGER PRIMARY KEY CHECK(id=1),
      blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
      owner_journal_id TEXT, owner_attempt_id TEXT, owner_binding_digest TEXT,
      owner_target_scope_digest TEXT, owner_watchdog_identity TEXT,
      owner_fence_epoch INTEGER, owner_fence_token TEXT
    ) STRICT;
    INSERT INTO constitutional_route_guard(id, blocked) VALUES(1, 0)
      ON CONFLICT(id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS constitutional_route_candidate_deadline (
      id INTEGER PRIMARY KEY CHECK(id=1),
      journal_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      binding_digest TEXT NOT NULL,
      target_scope_digest TEXT NOT NULL,
      candidate_digest TEXT NOT NULL,
      not_after TEXT NOT NULL,
      activated_wall_ms INTEGER NOT NULL,
      activated_monotonic_ns TEXT NOT NULL,
      activated_boot_id TEXT NOT NULL
    ) STRICT;
  `);
  // Existing databases predate the guard ownership columns. SQLite has no
  // ADD COLUMN IF NOT EXISTS, so tolerate the duplicate-column migration.
  for (const column of [
    "owner_journal_id TEXT", "owner_attempt_id TEXT", "owner_binding_digest TEXT",
    "owner_target_scope_digest TEXT", "owner_watchdog_identity TEXT",
    "owner_fence_epoch INTEGER", "owner_fence_token TEXT",
  ]) {
    try { db.exec(`ALTER TABLE constitutional_route_guard ADD COLUMN ${column}`); } catch { /* already present */ }
  }
  return db;
}
