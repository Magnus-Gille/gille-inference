/**
 * mutation-lock.ts — an exclusive, file-based lock over the routing-table WRITE path
 * (gille-inference#49, Sol-xhigh review round 3 finding 2: "the tick and a manual
 * `routing-lifecycle-cli adopt` can interleave between hash-check and write").
 *
 * Both `autonomy-controller.ts`'s autonomous adopt attempt and `routing-lifecycle-cli.ts`'s human
 * `adopt` command acquire this SAME lock immediately before their own live-table hash recheck and
 * `adoptRoutingTable` call, so the two surfaces can never race a "check the table, then write it"
 * sequence against each other. This is a small, standalone module (not folded into
 * routing-lifecycle.ts) precisely so both call sites can import ONE shared primitive without either
 * depending on the other's module.
 *
 * The lock is a plain file created with O_EXCL ("wx" — fails if the file already exists), the same
 * atomic "create-if-absent" primitive the rest of this codebase's durable-state writers use for
 * atomic REPLACE (write-to-temp-then-rename); here it is used for atomic CREATE instead, which is
 * exactly the primitive an exclusive lock needs. A lock older than `staleAfterMs` is treated as an
 * abandoned holder (a crashed process that never released it) and is force-taken-over, so a single
 * stuck holder cannot wedge the routing-table mutation path forever.
 */
import { openSync, closeSync, unlinkSync, readFileSync, writeSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface MutationLockHandle {
  release: () => void;
}

export class MutationLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationLockBusyError";
  }
}

/** Generous for a single adopt call's write+reload+canary (seconds, not minutes, in practice) —
 *  tunable via `acquireMutationLock`'s own `staleAfterMs` option. */
export const DEFAULT_MUTATION_LOCK_STALE_AFTER_MS = 5 * 60 * 1000;

export function mutationLockPath(dataDir: string): string {
  return join(dataDir, "autonomy", ".mutation-lock");
}

function tryCreateLockFile(path: string, nowMs: number): boolean {
  try {
    const fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAtMs: nowMs }));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Acquires the exclusive routing-table mutation lock. Throws `MutationLockBusyError` if a
 * genuinely fresh lock is held by someone else; otherwise returns a handle whose `release()` MUST
 * be called (in a `finally` block) once the caller's own hash-recheck + `adoptRoutingTable` call
 * completes, success or failure alike.
 */
export function acquireMutationLock(
  dataDir: string,
  opts: { staleAfterMs?: number; nowMs?: number } = {}
): MutationLockHandle {
  const path = mutationLockPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_MUTATION_LOCK_STALE_AFTER_MS;
  const nowMs = opts.nowMs ?? Date.now();

  if (tryCreateLockFile(path, nowMs)) {
    return { release: () => releaseLock(path) };
  }

  // Someone else holds it — check staleness before refusing outright. Read the HOLDER'S OWN
  // written `acquiredAtMs` (not the filesystem's `mtime`) so staleness is computed entirely within
  // one consistent clock domain — `mtime` is always real OS wall-clock time, which would silently
  // disagree with an injected/fixture `nowMs` (tests) or drift from this process's own clock.
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    const held = JSON.parse(readFileSync(path, "utf8")) as { acquiredAtMs?: number };
    if (typeof held.acquiredAtMs === "number") ageMs = nowMs - held.acquiredAtMs;
  } catch {
    // Disappeared between our failed create and this read (the holder just released it), or the
    // content was unreadable/malformed — either way the retry below will simply succeed or fail
    // cleanly rather than trusting a bogus age.
  }

  if (ageMs <= staleAfterMs) {
    throw new MutationLockBusyError(
      `mutation-lock: ${path} is held (age ${Math.round(ageMs / 1000)}s, at or below the ${Math.round(
        staleAfterMs / 1000
      )}s stale threshold) — refusing to mutate the routing table concurrently.`
    );
  }

  // Stale — a prior holder crashed without releasing. Force takeover, logged via the thrown error
  // message on the (rare) chance a second racer loses this retry.
  try {
    unlinkSync(path);
  } catch {
    // Already gone — fine, the create below is authoritative either way.
  }
  if (!tryCreateLockFile(path, nowMs)) {
    throw new MutationLockBusyError(
      `mutation-lock: ${path} was stale but a concurrent process re-acquired it first — refusing to mutate.`
    );
  }
  return { release: () => releaseLock(path) };
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone (e.g. force-taken-over by a staleness reclaim elsewhere) — nothing to do.
  }
}
