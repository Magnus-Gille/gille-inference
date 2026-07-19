import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { platform } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  CodeLoopJobStatus,
  CodeLoopRequest,
  CodeLoopResult,
  CodeLoopUsage,
} from "./code-loop-types.js";

/** Durable, content-minimal caller-idempotency record (#251). */
export interface DurableCodeLoopRun {
  schema_version: 1;
  client_run_id: string;
  request_fingerprint: string;
  work_id: string;
  status: CodeLoopJobStatus;
  usage: CodeLoopUsage;
  result: CodeLoopResult | null;
  started_at_ms: number;
  /** Per-process nonce: distinguishes pre-restart owners from starts racing the async sweep. */
  owner_instance_id?: string;
  /** OS process owner used to avoid orphaning a run owned by an overlapping live gateway. */
  owner_pid?: number;
}

export type ClaimCodeLoopRun =
  | { kind: "claimed"; record: DurableCodeLoopRun }
  | { kind: "existing"; record: DurableCodeLoopRun }
  | { kind: "conflict"; record: DurableCodeLoopRun };

const STATE_DIR = ".code-loop-state-v1";
const CLIENT_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROCESS_INSTANCE_ID = randomUUID();
const ACTIVE_RUN_DB = "active-run.sqlite";

interface ActiveRunOwner {
  schema_version: 1;
  owner_instance_id: string;
  owner_pid: number;
  owner_boot_id: string | null;
  owner_start_token: string | null;
  /** Equals owner_instance_id only when the same identity-aware writer stamped boot/start. */
  owner_identity_instance_id: string | null;
  work_id: string;
}

export interface DurableProcessIdentity {
  boot_id: string;
  start_token: string;
}

export interface DurableCodeLoopLease {
  work_id: string;
  release: () => void;
}

export interface DurableCodeLoopLeaseOptions {
  /** Caller has already proved this process has no live in-memory run; recover its failed release. */
  reclaimOwnInstance?: boolean;
  /** Deterministic fault seam for the bounded release retry regression. */
  beforeReleaseAttempt?: (attempt: number) => void;
  /** Deterministic seam for reboot/PID-reuse tests. Production reads boot + process start. */
  processIdentityOf?: (pid: number) => DurableProcessIdentity | null;
}

export function validateClientRunId(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !CLIENT_RUN_ID_RE.test(value)) {
    throw new Error("`client_run_id` must be 1-128 characters: letters, digits, `.`, `_`, `:`, or `-`.");
  }
  return value;
}

function stateDir(workroot: string): string {
  return join(workroot, STATE_DIR);
}

function clientKey(clientRunId: string): string {
  return createHash("sha256").update(clientRunId, "utf8").digest("hex");
}

function clientPath(workroot: string, clientRunId: string): string {
  return join(stateDir(workroot), `client-${clientKey(clientRunId)}.json`);
}

function workPath(workroot: string, workId: string): string {
  return join(stateDir(workroot), `work-${workId}.json`);
}

function activeRunDbPath(workroot: string): string {
  return join(stateDir(workroot), ACTIVE_RUN_DB);
}

/** fsync the directory entry after create/replace/delete; macOS may reject directory fsync. */
function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF") throw err;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function ensureStateDir(workroot: string): void {
  const created = mkdirSync(stateDir(workroot), { recursive: true, mode: 0o700 });
  if (created !== undefined) fsyncDirectory(workroot);
}

function unlinkDurable(path: string): void {
  try {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function readRecord(path: string): DurableCodeLoopRun | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DurableCodeLoopRun;
    if (
      parsed.schema_version !== 1 ||
      typeof parsed.client_run_id !== "string" ||
      typeof parsed.request_fingerprint !== "string" ||
      typeof parsed.work_id !== "string" ||
      !["running", "completed", "cap-exceeded", "degenerate", "arm-error", "orphaned"].includes(parsed.status) ||
      typeof parsed.started_at_ms !== "number" ||
      parsed.usage === null ||
      typeof parsed.usage !== "object" ||
      typeof parsed.usage.turns !== "number" ||
      typeof parsed.usage.wall_ms !== "number" ||
      typeof parsed.usage.prompt_tokens !== "number" ||
      typeof parsed.usage.completion_tokens !== "number" ||
      (parsed.result !== null && typeof parsed.result !== "object")
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function durableCreate(path: string, value: DurableCodeLoopRun): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  let complete = false;
  try {
    writeSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    complete = true;
  } finally {
    closeSync(fd);
    if (!complete) {
      try { unlinkDurable(path); } catch { /* preserve the original write/fsync failure */ }
    }
  }
  fsyncDirectory(dirname(path));
  return true;
}

function atomicReplace(path: string, value: DurableCodeLoopRun): void {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    const fd = openSync(temp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
  } catch (err) {
    try { unlinkDurable(temp); } catch { /* preserve the original replace failure */ }
    throw err;
  }
}

/**
 * Canonical equality binding. It intentionally stores/returns only the digest; prompt and file
 * contents never enter the idempotency record or content-blind learning evidence.
 */
export function codeLoopRequestFingerprint(
  req: CodeLoopRequest
): string {
  const canonical = {
    schema_version: 1,
    instruction: req.instruction,
    files: req.files.map((f) => ({ path: f.path, content: f.content })),
    check_cmd: req.check_cmd ?? null,
    protected: req.protected === undefined ? null : [...req.protected],
    task_type: req.task_type ?? null,
    caps: req.caps === undefined
      ? null
      : {
          wall_s: req.caps.wall_s ?? null,
          turns: req.caps.turns ?? null,
          completion_tokens: req.caps.completion_tokens ?? null,
          edit_deadline_turn: req.caps.edit_deadline_turn ?? null,
        },
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex")}`;
}

/** Synchronous exclusive create is the concurrency linearization point. */
export function claimDurableCodeLoopRun(
  workroot: string,
  candidate: DurableCodeLoopRun
): ClaimCodeLoopRun {
  ensureStateDir(workroot);
  const claimed = { ...candidate, owner_instance_id: PROCESS_INSTANCE_ID, owner_pid: process.pid };
  const cpath = clientPath(workroot, claimed.client_run_id);
  if (durableCreate(cpath, claimed)) {
    // The caller-id record is authoritative and already fsync'd. The work-id copy makes status/
    // result recovery possible when only the server id is available.
    try {
      if (!durableCreate(workPath(workroot, claimed.work_id), claimed)) {
        throw new Error("work_id collision while creating durable idempotency index");
      }
    } catch (err) {
      // The request has not been accepted/executed yet. Roll back the caller claim rather than
      // leave a permanently-running ghost binding that no process can own.
      try { unlinkDurable(cpath); } catch { /* best-effort */ }
      throw err;
    }
    return { kind: "claimed", record: claimed };
  }
  const existing = readRecord(cpath);
  if (existing === null) throw new Error("Existing client_run_id binding is unreadable; refusing to duplicate work.");
  if (existing.client_run_id !== candidate.client_run_id) {
    throw new Error("client_run_id hash collision; refusing to duplicate work.");
  }
  if (existing.request_fingerprint !== candidate.request_fingerprint) {
    return { kind: "conflict", record: existing };
  }
  // Repair the secondary work-id index if the process died after the authoritative caller record
  // was fsync'd but before the index was created. This recovery path never starts new work.
  const wpath = workPath(workroot, existing.work_id);
  if (!existsSync(wpath)) durableCreate(wpath, existing);
  return { kind: "existing", record: existing };
}

export function persistDurableCodeLoopRun(workroot: string, record: DurableCodeLoopRun): void {
  ensureStateDir(workroot);
  const owned = {
    ...record,
    owner_instance_id: record.owner_instance_id ?? PROCESS_INSTANCE_ID,
    owner_pid: record.owner_pid ?? process.pid,
  };
  atomicReplace(clientPath(workroot, owned.client_run_id), owned);
  const wpath = workPath(workroot, owned.work_id);
  if (existsSync(wpath)) atomicReplace(wpath, owned);
  else durableCreate(wpath, owned);
}

export function readDurableCodeLoopRunByClient(
  workroot: string,
  clientRunId: string
): DurableCodeLoopRun | null {
  return readRecord(clientPath(workroot, clientRunId));
}

export function readDurableCodeLoopRunByWork(
  workroot: string,
  workId: string
): DurableCodeLoopRun | null {
  const indexed = readRecord(workPath(workroot, workId));
  if (indexed === null) return null;
  // The client record is authoritative. Consulting it prevents a crash between the two atomic
  // replacements from exposing stale status/result data through the work-id read path.
  const authoritative = readRecord(clientPath(workroot, indexed.client_run_id));
  return authoritative?.work_id === workId ? authoritative : null;
}

export function markDurableCodeLoopRunOrphaned(workroot: string, workId: string): void {
  const record = readDurableCodeLoopRunByWork(workroot, workId);
  if (record === null || record.status !== "running") return;
  persistDurableCodeLoopRun(workroot, { ...record, status: "orphaned", result: null });
}

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A PID alone is not an identity: it can be reused after exit or across a reboot. */
function defaultProcessIdentity(pid: number): DurableProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform() === "linux") {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return null;
      // The suffix starts at field 3 (state); Linux proc(5) starttime is field 22 → index 19.
      const startToken = stat.slice(closeParen + 2).trim().split(/\s+/)[19];
      return bootId !== "" && startToken ? { boot_id: bootId, start_token: startToken } : null;
    }
    // macOS test/development equivalent: kernel boot epoch + ps-reported process start instant.
    const bootId = execFileSync("/usr/sbin/sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).trim();
    const startToken = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return bootId !== "" && startToken !== "" ? { boot_id: bootId, start_token: startToken } : null;
  } catch {
    return null;
  }
}

function ownerLiveness(
  owner: ActiveRunOwner,
  isProcessAlive: (pid: number) => boolean,
  processIdentityOf: (pid: number) => DurableProcessIdentity | null
): "live" | "dead" | "unknown" {
  if (!isProcessAlive(owner.owner_pid)) return "dead";
  // A rolling legacy writer updates owner_instance_id/pid/work_id but cannot update the identity
  // columns. A mismatch therefore means the boot/start tuple belongs to an earlier owner and must
  // never be used to reclaim this live process.
  if (owner.owner_identity_instance_id !== owner.owner_instance_id) return "unknown";
  if (owner.owner_boot_id === null || owner.owner_start_token === null) return "unknown";
  const actual = processIdentityOf(owner.owner_pid);
  if (actual === null) return "unknown";
  return actual.boot_id === owner.owner_boot_id && actual.start_token === owner.owner_start_token ? "live" : "dead";
}

function openActiveRunDb(
  workroot: string,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive,
  processIdentityOf: (pid: number) => DurableProcessIdentity | null = defaultProcessIdentity
): Database.Database {
  ensureStateDir(workroot);
  const db = new Database(activeRunDbPath(workroot));
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_run_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_instance_id TEXT NOT NULL,
        owner_pid INTEGER NOT NULL,
        owner_boot_id TEXT,
        owner_start_token TEXT,
        owner_identity_instance_id TEXT,
        work_id TEXT NOT NULL
      )
    `);
    const columns = new Set((db.prepare("PRAGMA table_info(active_run_lease)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("owner_boot_id")) db.exec("ALTER TABLE active_run_lease ADD COLUMN owner_boot_id TEXT");
    if (!columns.has("owner_start_token")) db.exec("ALTER TABLE active_run_lease ADD COLUMN owner_start_token TEXT");
    if (!columns.has("owner_identity_instance_id")) {
      db.exec("ALTER TABLE active_run_lease ADD COLUMN owner_identity_instance_id TEXT");
    }
    // The steady-state read path must not acquire SQLite's global write lock. Enter migration only
    // for an owner whose identity is absent or was stamped by a different (legacy-overwritten)
    // owner. A live mismatched tuple remains unknown/busy; only matching evidence can be adopted.
    const migrationNeeded = db.prepare(`
      SELECT 1 FROM active_run_lease
      WHERE owner_identity_instance_id IS NULL OR owner_identity_instance_id != owner_instance_id
      LIMIT 1
    `).get() !== undefined;
    if (migrationNeeded) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const legacy = readActiveRunOwner(db);
        if (legacy !== null && legacy.owner_identity_instance_id !== legacy.owner_instance_id) {
          if (!isProcessAlive(legacy.owner_pid)) {
            db.prepare(`
              DELETE FROM active_run_lease
              WHERE singleton = 1 AND owner_instance_id = ? AND owner_pid = ? AND work_id = ?
                AND (owner_identity_instance_id IS NULL OR owner_identity_instance_id != owner_instance_id)
            `).run(legacy.owner_instance_id, legacy.owner_pid, legacy.work_id);
          } else {
            const identity = processIdentityOf(legacy.owner_pid);
            // The transaction pins the current owner fields while we sample its live process. It
            // is therefore safe to replace inherited stale columns and attest this exact owner;
            // a subsequent legacy UPDATE changes owner_instance_id and invalidates the marker.
            if (identity !== null) {
              db.prepare(`
                UPDATE active_run_lease
                SET owner_boot_id = ?, owner_start_token = ?, owner_identity_instance_id = owner_instance_id
                WHERE singleton = 1 AND owner_instance_id = ? AND owner_pid = ? AND work_id = ?
                  AND (owner_identity_instance_id IS NULL OR owner_identity_instance_id != owner_instance_id)
              `).run(
                identity.boot_id,
                identity.start_token,
                legacy.owner_instance_id,
                legacy.owner_pid,
                legacy.work_id
              );
            }
          }
        }
        db.exec("COMMIT");
      } catch (err) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw err;
      }
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function readActiveRunOwner(db: Database.Database): ActiveRunOwner | null {
  const row = db.prepare(`
    SELECT owner_instance_id, owner_pid, owner_boot_id, owner_start_token,
           owner_identity_instance_id, work_id
    FROM active_run_lease
    WHERE singleton = 1
  `).get() as Omit<ActiveRunOwner, "schema_version"> | undefined;
  return row === undefined ? null : { schema_version: 1, ...row };
}

/** True only when the cross-process lock names this work id and its OS process is still alive. */
export function isDurableCodeLoopWorkLive(
  workroot: string,
  workId: string,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive,
  processIdentityOf: (pid: number) => DurableProcessIdentity | null = defaultProcessIdentity
): boolean {
  let db: Database.Database | null = null;
  try {
    db = openActiveRunDb(workroot, isProcessAlive, processIdentityOf);
    const owner = readActiveRunOwner(db);
    return owner !== null && owner.work_id === workId && ownerLiveness(owner, isProcessAlive, processIdentityOf) !== "dead";
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Lock contention is not evidence that an owner is dead. Fail busy/live so recovery and the
    // periodic sweep never orphan or kill paid work merely because another gateway holds SQLite.
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
    throw err;
  } finally {
    db?.close();
  }
}

/**
 * Cross-process single-flight linearization point. BEGIN IMMEDIATE serializes the stale-owner
 * check and owner-token replacement, so no contender can delete/replace a newer live lease based
 * on an earlier observation. The row is a content-blind singleton; paid-run source stays in the
 * separately compacted JSON records.
 */
export function acquireDurableCodeLoopLease(
  workroot: string,
  workId: string,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive,
  options: DurableCodeLoopLeaseOptions = {}
): { kind: "acquired"; lease: DurableCodeLoopLease } | { kind: "busy"; work_id: string | null } {
  const processIdentityOf = options.processIdentityOf ?? defaultProcessIdentity;
  let db: Database.Database;
  try {
    db = openActiveRunDb(workroot, isProcessAlive, processIdentityOf);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return { kind: "busy", work_id: null };
    throw err;
  }
  const identity = processIdentityOf(process.pid);
  if (identity === null) {
    db.close();
    throw new Error("cannot establish boot/process-start identity for durable code_loop lease");
  }
  const ownerInstanceId = `${PROCESS_INSTANCE_ID}:${randomUUID()}`;
  const owner: ActiveRunOwner = {
    schema_version: 1,
    owner_instance_id: ownerInstanceId,
    owner_pid: process.pid,
    owner_boot_id: identity.boot_id,
    owner_start_token: identity.start_token,
    owner_identity_instance_id: ownerInstanceId,
    work_id: workId,
  };
  let acquired = false;
  let busyWorkId: string | null = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    const current = readActiveRunOwner(db);
    const reclaimOwnInstance = current !== null && options.reclaimOwnInstance === true &&
      current.owner_instance_id.startsWith(`${PROCESS_INSTANCE_ID}:`);
    if (current !== null && !reclaimOwnInstance && ownerLiveness(current, isProcessAlive, processIdentityOf) !== "dead") {
      busyWorkId = current.work_id;
    } else if (current === null) {
      db.prepare(`
        INSERT INTO active_run_lease
          (singleton, owner_instance_id, owner_pid, owner_boot_id, owner_start_token,
           owner_identity_instance_id, work_id)
        VALUES (1, ?, ?, ?, ?, ?, ?)
      `).run(owner.owner_instance_id, owner.owner_pid, owner.owner_boot_id, owner.owner_start_token,
        owner.owner_identity_instance_id, owner.work_id);
      acquired = true;
    } else {
      const changed = db.prepare(`
        UPDATE active_run_lease
        SET owner_instance_id = ?, owner_pid = ?, owner_boot_id = ?, owner_start_token = ?,
            owner_identity_instance_id = ?, work_id = ?
        WHERE singleton = 1
          AND owner_instance_id = ?
          AND owner_pid = ?
          AND work_id = ?
      `).run(
        owner.owner_instance_id,
        owner.owner_pid,
        owner.owner_boot_id,
        owner.owner_start_token,
        owner.owner_identity_instance_id,
        owner.work_id,
        current.owner_instance_id,
        current.owner_pid,
        current.work_id
      );
      if (changed.changes !== 1) throw new Error("active run lease changed inside serialized transaction");
      acquired = true;
    }
    db.exec("COMMIT");
  } catch (err) {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
    const code = (err as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      return { kind: "busy", work_id: null };
    }
    throw err;
  }

  if (!acquired) {
    db.close();
    return { kind: "busy", work_id: busyWorkId };
  }
  db.close();

  let released = false;
  return {
    kind: "acquired",
    lease: {
      work_id: workId,
      release: () => {
        if (released) return;
        let lastError: unknown = new Error("durable process lease release failed");
        for (let attempt = 1; attempt <= 3; attempt++) {
          let releaseDb: Database.Database | null = null;
          try {
            options.beforeReleaseAttempt?.(attempt);
            releaseDb = openActiveRunDb(workroot);
            releaseDb.prepare(`
              DELETE FROM active_run_lease
              WHERE singleton = 1 AND owner_instance_id = ? AND work_id = ?
            `).run(owner.owner_instance_id, owner.work_id);
            released = true;
            return;
          } catch (err) {
            lastError = err;
          } finally {
            releaseDb?.close();
          }
        }
        throw lastError;
      },
    },
  };
}

/** Pre-acceptance rollback: remove both indexes so the caller may retry the same id. */
export function removeDurableCodeLoopRun(
  workroot: string,
  clientRunId: string,
  workId: string
): void {
  const current = readDurableCodeLoopRunByClient(workroot, clientRunId);
  if (current === null || current.work_id !== workId) return;
  unlinkDurable(clientPath(workroot, clientRunId));
  unlinkDurable(workPath(workroot, workId));
}

/** Strip source-bearing terminal results when the matching sandbox reaches its retention TTL. */
export function compactDurableCodeLoopRunResult(workroot: string, workId: string): void {
  const current = readDurableCodeLoopRunByWork(workroot, workId);
  if (current === null || current.status === "running" || current.result === null) return;
  persistDurableCodeLoopRun(workroot, { ...current, result: null });
}

/** Periodic source-retention enforcement independent of agent-writable/missing sandbox metadata. */
export function compactExpiredDurableCodeLoopRuns(workroot: string, nowMs: number, retentionTtlMs: number): number {
  let names: string[];
  try {
    names = readdirSync(stateDir(workroot));
  } catch {
    return 0;
  }
  let compacted = 0;
  for (const name of names) {
    if (!name.startsWith("client-") || !name.endsWith(".json")) continue;
    const record = readRecord(join(stateDir(workroot), name));
    if (record === null || record.status === "running" || record.result === null ||
        nowMs - record.started_at_ms <= retentionTtlMs) continue;
    persistDurableCodeLoopRun(workroot, { ...record, result: null });
    compacted++;
  }
  return compacted;
}

/** Reconcile bindings created before a crash could create sandbox metadata. */
export function markUnownedDurableCodeLoopRunsOrphaned(
  workroot: string,
  activeWorkIds: ReadonlySet<string>,
  isProcessAlive: (pid: number) => boolean = defaultProcessAlive
): number {
  let names: string[];
  try {
    names = readdirSync(stateDir(workroot));
  } catch {
    return 0;
  }
  let changed = 0;
  for (const name of names) {
    if (!name.startsWith("client-") || !name.endsWith(".json")) continue;
    const record = readRecord(join(stateDir(workroot), name));
    if (
      record === null ||
      record.status !== "running" ||
      activeWorkIds.has(record.work_id) ||
      isDurableCodeLoopWorkLive(workroot, record.work_id, isProcessAlive)
    ) continue;
    persistDurableCodeLoopRun(workroot, { ...record, status: "orphaned", result: null });
    changed++;
  }
  return changed;
}

/** Test-only crash/restart seam: in-memory state resets, durable files remain. */
export function removeDurableCodeLoopRunForTests(workroot: string, clientRunId: string, workId: string): void {
  for (const path of [clientPath(workroot, clientRunId), workPath(workroot, workId)]) {
    try { unlinkDurable(path); } catch { /* absent */ }
  }
}
