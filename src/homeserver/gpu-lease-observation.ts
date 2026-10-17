/** Read-only observation of the mkdir mutex, never selection/reclamation of queue tickets. */
import * as fs from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { join } from "node:path";

export interface GpuMutexObservation {
  source: "gpu-mkdir-mutex-v1";
  observedAt: string;
  state: "absent" | "occupied" | "unknown";
  held: boolean | null;
  owner: { id: string; pid: number; heartbeatAt: number } | null;
  ownerState: "fresh" | "stale" | "missing" | "invalid" | "future" | "unknown";
  reason: string;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const same = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino &&
  a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.size === b.size;
const directory = (s: Stats): boolean => s.isDirectory() && !s.isSymbolicLink();
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/**
 * Observes a trusted host-bound lease directory. A stable absence is a sample, not a reservation.
 * Any occupied mutex blocks admission, including stale/invalid/missing owner markers. Metadata
 * describes the lease's recorded owner, not OS process liveness. No host/model/purpose is returned.
 */
async function readGpuLeaseMutex(
  dir: string, opts: { now?: () => number; staleMs?: number } = {},
): Promise<GpuMutexObservation> {
  const now = (opts.now ?? Date.now)();
  const staleMs = opts.staleMs ?? 30_000;
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(staleMs) || staleMs <= 0) throw new Error("invalid mutex observation clock or stale bound");
  const base: GpuMutexObservation = {
    source: "gpu-mkdir-mutex-v1", observedAt: new Date(now).toISOString(), state: "unknown", held: null,
    owner: null, ownerState: "unknown", reason: "filesystem-unavailable",
  };
  const lockPath = join(dir, ".holder"), ownerPath = join(lockPath, "owner.json");
  try {
    const rootBefore = await fs.lstat(dir);
    if (!directory(rootBefore)) return { ...base, reason: "lease-root-not-directory" };
    let lockBefore: Stats;
    try { lockBefore = await fs.lstat(lockPath); }
    catch (error) {
      if (!missing(error)) throw error;
      // Require the known root to remain stable and the mutex still absent. Never create it.
      try { await fs.lstat(lockPath); return { ...base, reason: "mutex-changed" }; }
      catch (second) { if (!missing(second)) throw second; }
      if (!same(rootBefore, await fs.lstat(dir))) return { ...base, reason: "lease-root-changed" };
      return { ...base, state: "absent", held: false, reason: "mutex-absent" };
    }
    if (!directory(lockBefore)) return { ...base, reason: "mutex-not-directory" };
    let owner: GpuMutexObservation["owner"] = null;
    let ownerState: GpuMutexObservation["ownerState"] = "invalid";
    let markerBefore: Stats | null = null;
    let markerMissing = false;
    try {
      markerBefore = await fs.lstat(ownerPath);
      if (markerBefore.isFile() && !markerBefore.isSymbolicLink() && markerBefore.nlink === 1 && markerBefore.size <= 4096) {
        const handle = await fs.open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!same(markerBefore, await handle.stat())) return { ...base, reason: "owner-changed" };
          const bytes = Buffer.alloc(4097);
          const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
          if (!same(markerBefore, await handle.stat())) return { ...base, reason: "owner-changed" };
          if (bytesRead <= 4096 && bytesRead === markerBefore.size) {
            let raw: unknown;
            try { raw = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
            catch { raw = null; }
            const r = raw as Record<string, unknown> | null;
            if (r && typeof r.id === "string" && uuid.test(r.id) &&
                Number.isSafeInteger(r.pid) && (r.pid as number) > 0 &&
                Number.isSafeInteger(r.heartbeatAt) && (r.heartbeatAt as number) >= 0 &&
                typeof r.host === "string" && /^[a-zA-Z0-9_.-]{1,253}$/.test(r.host)) {
              owner = { id: r.id, pid: r.pid as number, heartbeatAt: r.heartbeatAt as number };
              ownerState = owner.heartbeatAt > now ? "future" : now - owner.heartbeatAt > staleMs ? "stale" : "fresh";
            }
          }
        } finally { await handle.close(); }
      }
    } catch (error) {
      if (!missing(error)) return { ...base, reason: "owner-unreadable" };
      if (markerBefore !== null) return { ...base, reason: "owner-changed" };
      markerMissing = true;
      ownerState = "missing";
    }
    // File replacement (heartbeats included), acquisition/reclaim/release, or root substitution
    // makes the mixed sample unknown. The next observation can retry without changing anything.
    if (!same(lockBefore, await fs.lstat(lockPath)) || !same(rootBefore, await fs.lstat(dir))) {
      return { ...base, reason: "mutex-changed" };
    }
    if (markerMissing) {
      try { await fs.lstat(ownerPath); return { ...base, reason: "owner-changed" }; }
      catch (error) { if (!missing(error)) throw error; }
    } else if (!markerBefore || !same(markerBefore, await fs.lstat(ownerPath))) {
      return { ...base, reason: "owner-changed" };
    }
    return { ...base, state: "occupied", held: true, owner, ownerState, reason: "mutex-present" };
  } catch {
    // Paths and raw OS/JSON error messages can contain private operator data.
    return base;
  }
}

/** Bound the caller's wait even if a filesystem operation stalls. Outstanding reads never mutate. */
export async function observeGpuLeaseMutex(
  dir: string, opts: { now?: () => number; staleMs?: number; timeoutMs?: number } = {},
): Promise<GpuMutexObservation> {
  const now = (opts.now ?? Date.now)();
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error("invalid mutex observation bounds");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readGpuLeaseMutex(dir, { ...opts, now: () => now }),
      new Promise<GpuMutexObservation>(resolve => {
        timer = setTimeout(() => resolve({ source: "gpu-mkdir-mutex-v1", observedAt: new Date(now).toISOString(),
          state: "unknown", held: null, owner: null, ownerState: "unknown", reason: "filesystem-timeout" }), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
