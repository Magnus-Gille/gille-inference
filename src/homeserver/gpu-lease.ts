/**
 * gpu-lease.ts — a cooperative FIFO lease over the serial M5 GPU (issue #88).
 *
 * The box serves ONE model at a time (serial GPU via llama-swap). When two heavy owner jobs
 * target different models concurrently, every request cold-swaps the loaded model → thrash that
 * degrades BOTH jobs. The gateway's owner-preempts-guest admission doesn't help (both are owner
 * tier) and experiment scripts hit llama-swap :8091 directly, bypassing the gateway entirely.
 *
 * The fix is a lightweight, file-backed lease that heavy batch jobs voluntarily acquire before
 * running and release after — so jobs SEQUENCE instead of thrashing. The design separates the two
 * properties so each is enforced by the simplest mechanism that is actually correct:
 *
 *   - MUTUAL EXCLUSION is enforced by an OS-ATOMIC `mkdir` lock (`.holder/`). mkdir(2) atomically
 *     succeeds for exactly one caller and fails (EEXIST) for the rest — so even if two processes
 *     both *believe* they are next in line (a race the tickets alone cannot prevent: a ticket is
 *     briefly invisible during its atomic publish, and a just-refreshed ticket can be misjudged
 *     stale), only one wins the directory and runs. This is the load-bearing guarantee.
 *   - FAIRNESS / VISIBILITY is provided by per-waiter ticket files (one JSON per waiter). The
 *     lowest live ticket is the one allowed to *attempt* the mkdir, giving near-FIFO order and a
 *     queryable "who holds / who's waiting + ETA" view — WITHOUT being trusted for exclusion.
 *
 * Crash safety: the holder heartbeats both its ticket and the lock's owner marker; a ticket OR a
 * lock whose heartbeat goes stale is reclaimed by a waiter, so a dead session never holds the GPU
 * forever (the "self-expire" requirement). A live holder additionally watches the lock owner and
 * fires `onLeaseLost` if it is ever stolen (the pathological event-loop-stall case) so the caller
 * can abort its job rather than run concurrently with the new holder.
 *
 * v1 is EXCLUSIVE (one heavy job at a time). Same-model coalescing is a future optimization; the
 * gateway's maxInflight still governs interactive concurrency separately.
 *
 * The pure selection logic (`selectHolder`) is unit-tested in isolation; the file I/O is layered
 * on top of it.
 */
import { mkdir, readdir, readFile, writeFile, unlink, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

/** One waiter's claim on the GPU. Persisted as a JSON file in the lease directory. */
export interface Ticket {
  /** Unique id (a UUID). */
  id: string;
  /** FIFO ordering key: enqueue time (ms since epoch). Lower = earlier in line. */
  seq: number;
  /** Owning process id (informational / debugging). */
  pid: number;
  /** Intended model — informational in v1 (the lease is exclusive regardless). */
  model: string;
  /** Free-text purpose for the "what's running" view. */
  purpose: string;
  /** Expected duration (ms), or null if unknown — drives the ETA display. */
  etaMs: number | null;
  /** When this ticket entered the queue. */
  enqueuedAt: number;
  /** Last heartbeat (ms). A ticket older than staleMs is considered dead and reclaimed. */
  heartbeatAt: number;
  /** Host that created the ticket (tailnet name) — multiple sessions may share the box. */
  host: string;
}

export interface HolderSelection {
  /** The earliest live ticket (the one allowed to attempt the mutex), or null if the queue is empty. */
  holder: Ticket | null;
  /** Live tickets sorted in FIFO order (holder first). */
  live: Ticket[];
  /** Tickets whose heartbeat has gone stale — safe to reclaim (delete). */
  stale: Ticket[];
}

/** A UUID-shaped id — enforced on read so a malformed ticket can never steer a file path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The mkdir mutex directory + its owner marker (relative to the lease dir). */
const LOCK_DIR = ".holder";
const LOCK_OWNER = "owner.json";

interface LockOwner {
  id: string;
  heartbeatAt: number;
  pid: number;
  host: string;
}

/**
 * Atomically (re)write a JSON file: write a unique temp file in the same directory, then rename it
 * over the target. rename(2) is atomic on POSIX, so a concurrent reader sees either the OLD or the
 * NEW complete content — never a truncated/partial file. (Temp files end in `.tmp` and are ignored
 * by the readers, which only read `*.json`.)
 */
async function atomicWriteJson(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = join(dir, `${name}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, join(dir, name));
}

/** Stable FIFO comparison: by seq, then id (so ties are deterministic across processes). */
function fifoCompare(a: Ticket, b: Ticket): number {
  return a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A ticket is valid only if its id is UUID-shaped and its timestamps are finite numbers. */
function isValidTicket(t: unknown): t is Ticket {
  if (t === null || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    UUID_RE.test(r["id"]) &&
    Number.isFinite(r["seq"]) &&
    Number.isFinite(r["heartbeatAt"]) &&
    Number.isFinite(r["enqueuedAt"])
  );
}

/**
 * Pure: given the current tickets, the wall clock, and the staleness window, decide who is at the
 * head of the line. A ticket is stale (its session presumed dead) when `now - heartbeatAt > staleMs`
 * — a missing/NaN heartbeat is treated as stale by construction (isValidTicket rejects it upstream).
 * Stale tickets are excluded from holder selection and returned for reclamation. The "holder" is
 * the earliest LIVE ticket in FIFO order — the one ALLOWED TO ATTEMPT the mutex (not itself the
 * exclusion guarantee; the mkdir lock is).
 */
export function selectHolder(tickets: Ticket[], now: number, staleMs: number): HolderSelection {
  const live: Ticket[] = [];
  const stale: Ticket[] = [];
  for (const t of tickets) {
    if (now - t.heartbeatAt > staleMs) stale.push(t);
    else live.push(t);
  }
  live.sort(fifoCompare);
  return { holder: live[0] ?? null, live, stale };
}

/** Position (1-based) of `id` in the live FIFO queue, or 0 if not present. */
export function queuePosition(sel: HolderSelection, id: string): number {
  const idx = sel.live.findIndex((t) => t.id === id);
  return idx < 0 ? 0 : idx + 1;
}

export interface AcquireOptions {
  model: string;
  purpose?: string;
  etaMs?: number | null;
  /** Lease directory (one per box). */
  dir: string;
  /** Heartbeat-staleness window (ms). A ticket/lock older than this is reclaimable. Default 30s.
   *  Clamped UP to heartbeatMs*3 (and a 3s floor): a window at/below the heartbeat interval would
   *  misjudge a live holder as dead and break exclusion. */
  staleMs?: number;
  /** How often to re-check whether we may proceed while waiting (ms). Default 1s. */
  pollMs?: number;
  /** How often to refresh our heartbeat (ms). Must be well under staleMs. Default 5s. */
  heartbeatMs?: number;
  /** Abort waiting (e.g. on SIGINT) — rejects with an AbortError after cleaning up our ticket. */
  signal?: AbortSignal;
  /** Called once per poll while still waiting, with our 1-based queue position and the head ticket. */
  onWait?: (position: number, holder: Ticket | null) => void;
  /** Fired if we HELD the lock but it was stolen (a stale-reclaim during an event-loop stall). The
   *  caller should abort its job immediately — the GPU now belongs to someone else. */
  onLeaseLost?: () => void;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export interface GpuLease {
  ticket: Ticket;
  /** Stop heartbeating, release the mutex, and remove our ticket so the next job proceeds. Idempotent. */
  release(): Promise<void>;
}

async function readTickets(dir: string): Promise<Ticket[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: Ticket[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const t = JSON.parse(raw) as unknown;
      // Reconcile the filename with the id so a malformed/mismatched ticket can't drive deletes.
      if (isValidTicket(t) && `${t.id}.json` === name) out.push(t);
    } catch {
      // Unparseable / mid-write / vanished — skip; the next poll will see a consistent state.
    }
  }
  return out;
}

/**
 * Delete stale ticket files (best-effort), but RE-READ each one first and only unlink if it is
 * STILL stale on the second read — so a holder that refreshed its heartbeat in the gap is never
 * deleted out from under itself (the split-brain Codex #2 guarded against). Paths are derived from
 * the validated UUID id (never a raw filename), so a delete can't escape the lease dir.
 */
async function reclaimStaleTickets(dir: string, stale: Ticket[], now: number, staleMs: number): Promise<void> {
  for (const t of stale) {
    const path = join(dir, `${t.id}.json`);
    try {
      const raw = await readFile(path, "utf8");
      const cur = JSON.parse(raw) as unknown;
      if (isValidTicket(cur) && now - cur.heartbeatAt > staleMs) await unlink(path);
    } catch {
      /* already gone / unreadable — nothing to reclaim */
    }
  }
}

/** Best-effort: remove `.tmp` files left by a crash between write and rename, older than staleMs. */
async function scavengeTemps(dir: string, now: number, staleMs: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".tmp")) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (now - st.mtimeMs > staleMs) await unlink(path);
    } catch {
      /* gone */
    }
  }
}

async function readLockOwner(dir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(join(dir, LOCK_DIR, LOCK_OWNER), "utf8");
    const o = JSON.parse(raw) as LockOwner;
    if (o && typeof o.id === "string" && Number.isFinite(o.heartbeatAt)) return o;
  } catch {
    /* missing / mid-write */
  }
  return null;
}

/** Tear down the lock directory (owner marker + dir). Best-effort; races resolve to ENOENT. */
async function removeLock(dir: string): Promise<void> {
  try {
    await unlink(join(dir, LOCK_DIR, LOCK_OWNER));
  } catch {
    /* already gone */
  }
  try {
    await rmdir(join(dir, LOCK_DIR));
  } catch {
    /* already gone / not empty (a concurrent writer) — next reclaim retries */
  }
}

/**
 * Reclaim the lock IFF it is unheld-stale. Two cases:
 *   - owner present  → reclaim only if its heartbeat is older than staleMs (a crashed holder).
 *   - owner absent   → could be a crashed holder OR a holder that just won the mkdir and hasn't
 *                      written its owner marker yet. Distinguish by the `.holder` dir's age: only
 *                      reclaim when the directory itself is older than staleMs, so a freshly-taken
 *                      lock (owner marker lands within heartbeatMs ≪ staleMs) is never stolen — the
 *                      TOCTOU a racing double-head would otherwise hit.
 * Returns true if it removed a stale lock (caller should retry the mkdir).
 */
async function reclaimStaleLock(dir: string, now: number, staleMs: number, lockGraceMs: number): Promise<boolean> {
  const owner = await readLockOwner(dir);
  if (owner !== null) {
    if (now - owner.heartbeatAt > staleMs) {
      await removeLock(dir);
      return true;
    }
    return false;
  }
  // No owner marker — either a holder that just won the mkdir (marker lands within heartbeatMs) or a
  // process that crashed between mkdir and its first owner write. Reclaim only once the lock dir is
  // older than lockGraceMs (≥ heartbeatMs*3): long enough to never steal a just-taken lock, short
  // enough to recover a genuine mid-acquire crash in seconds rather than the full staleMs window.
  try {
    const st = await stat(join(dir, LOCK_DIR));
    if (now - st.mtimeMs > lockGraceMs) {
      await removeLock(dir);
      return true;
    }
  } catch {
    /* lock dir vanished — nothing to reclaim */
  }
  return false;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read the current queue + head ticket for display (`gpu status`). */
export async function gpuLeaseStatus(dir: string, opts: { staleMs?: number; now?: () => number } = {}): Promise<HolderSelection> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? 30_000;
  return selectHolder(await readTickets(dir), now(), staleMs);
}

/**
 * Acquire the GPU lease, blocking (near-FIFO) until we hold the mkdir mutex. The returned lease
 * MUST be released (the CLI wrapper does this in a finally + on signals). While waiting AND holding
 * we heartbeat our ticket (and, while holding, the lock owner marker).
 */
export async function acquireGpuLease(opts: AcquireOptions): Promise<GpuLease> {
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? 5_000;
  // Guard the exclusion invariant: the staleness window must comfortably exceed the heartbeat, or a
  // live holder gets misjudged dead and reclaimed (Codex #4). Clamp up; never below a 3s floor.
  const staleMs = Math.max(opts.staleMs ?? 30_000, heartbeatMs * 3, 3_000);
  // Recovery window for a lock dir with no owner marker yet (just-taken vs crashed-mid-acquire).
  const lockGraceMs = Math.max(heartbeatMs * 3, 2_000);
  const pollMs = opts.pollMs ?? 1_000;
  const dir = opts.dir;

  await mkdir(dir, { recursive: true });

  const id = randomUUID();
  const seq = now();
  const ticket: Ticket = {
    id,
    seq,
    pid: process.pid,
    model: opts.model,
    purpose: opts.purpose ?? "",
    etaMs: opts.etaMs ?? null,
    enqueuedAt: seq,
    heartbeatAt: seq,
    host: hostname(),
  };
  const ticketName = `${id}.json`;

  // Enqueue. id is a uuid → the path is ours alone (no create-race); the write is atomic so a
  // concurrent reader never sees a half-written ticket.
  await atomicWriteJson(dir, ticketName, ticket);

  // Serialize FS writes for this lease so a release can never race an in-flight heartbeat into a
  // ghost ticket / ghost lock (Codex #3): every write awaits the previous one via this chain.
  let writeChain: Promise<void> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  let released = false;
  let holding = false;
  const writeOwner = () =>
    atomicWriteJson(join(dir, LOCK_DIR), LOCK_OWNER, {
      id,
      heartbeatAt: now(),
      pid: process.pid,
      host: hostname(),
    } satisfies LockOwner);

  const beat = async () => {
    if (released) return;
    ticket.heartbeatAt = now();
    try {
      // Re-check `released` INSIDE each serialized closure, not just at the top of beat(): a beat that
      // passed the top check can still append to writeChain AFTER cleanup() set `released` and drained
      // the chain, re-creating the ticket / `.holder/owner` after release() resolved (a ghost lock the
      // next teardown rm then races into ENOTEMPTY). cleanup() sets `released` before draining, so a
      // closure that runs at/after that point sees it and bails — making release() a true write fence.
      await serialize(() => (released ? Promise.resolve() : atomicWriteJson(dir, ticketName, ticket)));
      if (holding) {
        // Detect a stolen lease: if the owner marker is no longer us, we lost the GPU.
        const owner = await readLockOwner(dir);
        if (owner && owner.id !== id) {
          holding = false;
          opts.onLeaseLost?.();
          return;
        }
        await serialize(() => (released ? Promise.resolve() : writeOwner()));
      }
    } catch {
      /* transient FS error — next beat retries */
    }
  };
  const heartbeat = setInterval(() => void beat(), heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  const cleanup = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    // Drain any in-flight heartbeat write before removing files, so nothing re-creates them after.
    await writeChain.catch(() => undefined);
    if (holding) await removeLock(dir);
    try {
      await unlink(join(dir, ticketName));
    } catch {
      /* already gone */
    }
  };

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const t = now();
      const sel = selectHolder(await readTickets(dir), t, staleMs);
      if (sel.stale.length) await reclaimStaleTickets(dir, sel.stale, t, staleMs);
      await scavengeTemps(dir, t, staleMs);

      if (sel.holder?.id === id) {
        // We are at the head of the line — try to TAKE the mutex (atomic; only one winner).
        let won = false;
        try {
          await mkdir(join(dir, LOCK_DIR)); // NOT recursive → fails EEXIST if held
          won = true;
        } catch {
          // Someone holds it. If their lock is stale (crashed), reclaim and retry next poll.
          await reclaimStaleLock(dir, now(), staleMs, lockGraceMs);
        }
        if (won) {
          // We own the directory the instant mkdir returns — mark held NOW so cleanup always tears
          // it down (even if the owner-marker write below fails, which must NOT orphan the lock).
          holding = true;
          await serialize(writeOwner).catch(() => undefined); // best-effort; the heartbeat backfills it
          return { ticket, release: cleanup };
        }
      }
      opts.onWait?.(queuePosition(sel, id), sel.holder);
      await sleep(pollMs, opts.signal);
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
}
