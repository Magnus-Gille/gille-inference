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

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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
  compareAndSwap(expected: string, next: string, fence: RouteFence): boolean {
    validateFence(fence);
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
        return result.changes === 1;
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
        return result.changes === 1;
      }).immediate();
    } finally {
      db.close();
    }
  }

  block(fence: RouteFence): boolean {
    return this.setBlocked(true, fence);
  }

  clearBlock(fence: RouteFence): boolean {
    return this.setBlocked(false, fence);
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

  private setBlocked(blocked: boolean, fence: RouteFence): boolean {
    validateFence(fence);
    const db = open(this.path);
    try {
      return db.transaction(() => {
        if (!routeLeaseCurrent(db, fence)) return false;
        const result = db.prepare(`
          UPDATE constitutional_route_guard SET blocked=? WHERE id=1
        `).run(blocked ? 1 : 0);
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

export function readConstitutionalRouteDatabase(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = ON");
    const guard = db.prepare("SELECT blocked FROM constitutional_route_guard WHERE id=1")
      .get() as { blocked: number } | undefined;
    if (guard?.blocked === 1) throw new ConstitutionalRouteBlockedError();
    const row = db.prepare("SELECT value FROM constitutional_route WHERE id=1")
      .get() as { value: string } | undefined;
    if (!row) throw new Error("constitutional route database is not owner-initialized");
    return row.value;
  } finally {
    db.close();
  }
}

function validateFence(fence: RouteFence): void {
  if (!Number.isSafeInteger(fence.epoch) || fence.epoch < 1 || !/^[a-f0-9-]{36}$/.test(fence.token)) {
    throw new Error("invalid constitutional route fence");
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
      blocked INTEGER NOT NULL CHECK(blocked IN (0,1))
    ) STRICT;
    INSERT INTO constitutional_route_guard(id, blocked) VALUES(1, 0)
      ON CONFLICT(id) DO NOTHING;
  `);
  return db;
}
