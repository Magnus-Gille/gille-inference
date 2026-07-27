import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const DEFAULT_CONSTITUTIONAL_LEASE_MS = 45_000;

export class ConstitutionalLeaseBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstitutionalLeaseBusyError";
  }
}

export class ConstitutionalLeaseStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstitutionalLeaseStaleError";
  }
}

interface LeaseRow {
  epoch: number;
  token: string;
  expires_monotonic_ns: string;
  holder_pid: number;
  boot_id: string;
}

interface SequenceRow {
  next_epoch: number;
}

export interface ConstitutionalLeaseOptions {
  durationMs?: number;
  monotonicNowNs?: () => bigint;
  bootId?: string;
}

/**
 * Expiring lease plus authoritative fenced resources.
 *
 * Caller code never runs while the lease database is locked. Journal/state
 * mutations use writeResource/removeResource: the epoch/token comparison and
 * SQL mutation occur in one IMMEDIATE transaction at the resource. A stopped
 * client may resume, but an advanced epoch makes its resource mutation affect
 * nothing.
 */
export class ConstitutionalFencedLease {
  readonly epoch: number;
  readonly token: string;
  private readonly durationNs: bigint;
  private readonly nowNs: () => bigint;
  private readonly bootId: string;
  private released = false;

  private constructor(
    private readonly path: string,
    epoch: number,
    token: string,
    options: ConstitutionalLeaseOptions,
  ) {
    this.epoch = epoch;
    this.token = token;
    this.durationNs = BigInt(options.durationMs ?? DEFAULT_CONSTITUTIONAL_LEASE_MS) * 1_000_000n;
    this.nowNs = options.monotonicNowNs ?? process.hrtime.bigint;
    this.bootId = options.bootId ?? currentConstitutionalBootId();
  }

  static acquire(path: string, options: ConstitutionalLeaseOptions = {}): ConstitutionalFencedLease {
    const durationMs = options.durationMs ?? DEFAULT_CONSTITUTIONAL_LEASE_MS;
    if (!Number.isSafeInteger(durationMs) || durationMs < 10) {
      throw new Error("constitutional lease duration must be an integer of at least 10ms");
    }
    const nowNs = options.monotonicNowNs ?? process.hrtime.bigint;
    const now = nowNs();
    const durationNs = BigInt(durationMs) * 1_000_000n;
    const token = randomUUID();
    const bootId = options.bootId ?? currentConstitutionalBootId();
    const db = openLeaseDb(path);
    try {
      const result = db.transaction((): { epoch: number } | { busy: true; remainingNs: bigint } => {
        const existing = leaseRow(db);
        if (existing) {
          const expires = parseMonotonic(existing.expires_monotonic_ns);
          if (existing.boot_id === bootId && now < expires && processIsAlive(existing.holder_pid)) {
            return { busy: true, remainingNs: expires - now };
          }
        }
        const sequence = db.prepare(
          "SELECT next_epoch FROM constitutional_writer_lease_sequence WHERE id=1",
        ).get() as SequenceRow | undefined;
        const epoch = sequence?.next_epoch ?? 1;
        db.prepare(`
          INSERT INTO constitutional_writer_lease(id, epoch, token, expires_monotonic_ns, holder_pid, boot_id)
          VALUES(1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            epoch=excluded.epoch,
            token=excluded.token,
            expires_monotonic_ns=excluded.expires_monotonic_ns,
            holder_pid=excluded.holder_pid,
            boot_id=excluded.boot_id
        `).run(epoch, token, String(now + durationNs), process.pid, bootId);
        db.prepare(`
          INSERT INTO constitutional_writer_lease_sequence(id, next_epoch)
          VALUES(1, ?)
          ON CONFLICT(id) DO UPDATE SET next_epoch=excluded.next_epoch
        `).run(epoch + 1);
        return { epoch };
      }).immediate();
      if ("busy" in result) {
        throw new ConstitutionalLeaseBusyError(
          `constitutional route writer lease is current for another ${Number(result.remainingNs / 1_000_000n)}ms`,
        );
      }
      return new ConstitutionalFencedLease(path, result.epoch, token, options);
    } finally {
      db.close();
    }
  }

  /** Read-only admission preflight used before fencing a second resource. */
  static assertAcquirable(path: string, options: ConstitutionalLeaseOptions = {}): void {
    const nowNs = options.monotonicNowNs ?? process.hrtime.bigint;
    const now = nowNs();
    const bootId = options.bootId ?? currentConstitutionalBootId();
    const db = openLeaseDb(path);
    try {
      const existing = leaseRow(db);
      if (
        existing
        && existing.boot_id === bootId
        && now < parseMonotonic(existing.expires_monotonic_ns)
        && processIsAlive(existing.holder_pid)
      ) {
        throw new ConstitutionalLeaseBusyError(
          `constitutional route writer lease is current for another ${Number((parseMonotonic(existing.expires_monotonic_ns) - now) / 1_000_000n)}ms`,
        );
      }
    } finally {
      db.close();
    }
  }

  assertCurrentAndRenew(): void {
    const db = openLeaseDb(this.path);
    try {
      db.transaction(() => this.assertAndRenewInDb(db)).immediate();
    } finally {
      db.close();
    }
  }

  /** Current-state inspection without renewal, for abandoned session takeover. */
  isCurrent(): boolean {
    if (this.released) return false;
    const db = openLeaseDb(this.path);
    try {
      const row = leaseRow(db);
      return row !== undefined
        && row.epoch === this.epoch
        && row.token === this.token
        && row.boot_id === this.bootId
        && this.nowNs() < parseMonotonic(row.expires_monotonic_ns)
        && processIsAlive(row.holder_pid);
    } finally {
      db.close();
    }
  }

  /** Diagnostic/non-resource action only. Resource writes must use writeResource. */
  transition<T>(action: () => T): T {
    this.assertCurrentAndRenew();
    return action();
  }

  writeResource(name: string, value: string): void {
    const db = openLeaseDb(this.path);
    try {
      db.transaction(() => {
        this.assertAndRenewInDb(db);
        db.prepare(`
          INSERT INTO constitutional_resource(name, value, writer_epoch, writer_token)
          VALUES(?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
            value=excluded.value,
            writer_epoch=excluded.writer_epoch,
            writer_token=excluded.writer_token
        `).run(name, value, this.epoch, this.token);
      }).immediate();
    } finally {
      db.close();
    }
  }

  removeResource(name: string): void {
    const db = openLeaseDb(this.path);
    try {
      db.transaction(() => {
        this.assertAndRenewInDb(db);
        db.prepare("DELETE FROM constitutional_resource WHERE name=?").run(name);
      }).immediate();
    } finally {
      db.close();
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const db = openLeaseDb(this.path);
    try {
      db.transaction(() => {
        db.prepare(
          "DELETE FROM constitutional_writer_lease WHERE id=1 AND epoch=? AND token=? AND boot_id=?",
        ).run(this.epoch, this.token, this.bootId);
      }).immediate();
    } finally {
      db.close();
    }
  }

  private assertAndRenewInDb(db: Database.Database): void {
    if (this.released) throw new ConstitutionalLeaseStaleError("constitutional fenced lease was released");
    const now = this.nowNs();
    const row = leaseRow(db);
    if (
      !row
      || row.epoch !== this.epoch
      || row.token !== this.token
      || row.boot_id !== this.bootId
      || now >= parseMonotonic(row.expires_monotonic_ns)
    ) {
      throw new ConstitutionalLeaseStaleError(
        `constitutional fenced lease epoch ${this.epoch} is expired or superseded`,
      );
    }
    const result = db.prepare(`
      UPDATE constitutional_writer_lease
      SET expires_monotonic_ns=?, holder_pid=?
      WHERE id=1 AND epoch=? AND token=? AND boot_id=?
    `).run(String(now + this.durationNs), process.pid, this.epoch, this.token, this.bootId);
    if (result.changes !== 1) {
      throw new ConstitutionalLeaseStaleError(
        `constitutional fenced lease epoch ${this.epoch} changed during resource mutation`,
      );
    }
  }
}

export function readConstitutionalResource(path: string, name: string): string | undefined {
  const db = openLeaseDb(path);
  try {
    const row = db.prepare("SELECT value FROM constitutional_resource WHERE name=?")
      .get(name) as { value: string } | undefined;
    return row?.value;
  } finally {
    db.close();
  }
}

export function constitutionalResourceExists(path: string, name: string): boolean {
  return readConstitutionalResource(path, name) !== undefined;
}

function leaseRow(db: Database.Database): LeaseRow | undefined {
  return db.prepare(
    "SELECT epoch, token, expires_monotonic_ns, holder_pid, boot_id FROM constitutional_writer_lease WHERE id=1",
  ).get() as LeaseRow | undefined;
}

function parseMonotonic(value: string): bigint {
  return /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function currentConstitutionalBootId(): string {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (/^[a-f0-9-]{36}$/.test(value)) return value;
  } catch {
    // Non-Linux test hosts use a cross-process approximation of boot time.
  }
  return `boot-epoch-minute-${Math.floor((Date.now() - uptime() * 1000) / 60_000)}`;
}

function openLeaseDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o770 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 2000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS constitutional_writer_lease (
      id INTEGER PRIMARY KEY CHECK(id=1),
      epoch INTEGER NOT NULL,
      token TEXT NOT NULL,
      expires_monotonic_ns TEXT NOT NULL,
      holder_pid INTEGER NOT NULL,
      boot_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS constitutional_writer_lease_sequence (
      id INTEGER PRIMARY KEY CHECK(id=1),
      next_epoch INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS constitutional_resource (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      writer_epoch INTEGER NOT NULL,
      writer_token TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}
