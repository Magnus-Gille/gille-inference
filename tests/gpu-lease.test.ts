/**
 * Tests for the FIFO GPU lease (issue #88).
 *   - selectHolder()/queuePosition(): pure FIFO + staleness logic.
 *   - acquireGpuLease()/release(): cross-process ordering, stale reclaim, abort, idempotent release
 *     (exercised in-process against a temp lease directory with small timers).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readdir, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selectHolder,
  queuePosition,
  acquireGpuLease,
  gpuLeaseStatus,
  type Ticket,
} from "../src/homeserver/gpu-lease.js";

function tk(over: Partial<Ticket> = {}): Ticket {
  return {
    id: "id-" + (over.seq ?? 0),
    seq: 0,
    pid: 1,
    model: "mellum",
    purpose: "",
    etaMs: null,
    enqueuedAt: 0,
    heartbeatAt: 1000,
    host: "test",
    ...over,
  };
}

describe("selectHolder — pure FIFO + staleness", () => {
  it("empty queue → no holder", () => {
    const sel = selectHolder([], 1000, 30_000);
    expect(sel.holder).toBeNull();
    expect(sel.live).toEqual([]);
  });

  it("holder is the earliest live ticket (lowest seq); live sorted FIFO", () => {
    const a = tk({ id: "a", seq: 30, heartbeatAt: 1000 });
    const b = tk({ id: "b", seq: 10, heartbeatAt: 1000 });
    const c = tk({ id: "c", seq: 20, heartbeatAt: 1000 });
    const sel = selectHolder([a, b, c], 1000, 30_000);
    expect(sel.holder?.id).toBe("b");
    expect(sel.live.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("equal seq → tie broken deterministically by id", () => {
    const a = tk({ id: "zzz", seq: 5, heartbeatAt: 1000 });
    const b = tk({ id: "aaa", seq: 5, heartbeatAt: 1000 });
    expect(selectHolder([a, b], 1000, 30_000).holder?.id).toBe("aaa");
  });

  it("a stale earliest ticket is skipped and returned for reclamation", () => {
    const dead = tk({ id: "dead", seq: 1, heartbeatAt: 1000 });
    const live = tk({ id: "live", seq: 2, heartbeatAt: 100_000 });
    const sel = selectHolder([dead, live], 100_000, 30_000); // now-dead.hb = 99000 > 30000 → stale
    expect(sel.holder?.id).toBe("live");
    expect(sel.stale.map((t) => t.id)).toEqual(["dead"]);
  });

  it("queuePosition is 1-based among live tickets; 0 if absent", () => {
    const sel = selectHolder([tk({ id: "a", seq: 1 }), tk({ id: "b", seq: 2 })], 1000, 30_000);
    expect(queuePosition(sel, "a")).toBe(1);
    expect(queuePosition(sel, "b")).toBe(2);
    expect(queuePosition(sel, "missing")).toBe(0);
  });
});

describe("acquireGpuLease — FIFO ordering & lifecycle", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpu-lease-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("empty queue → acquires immediately; release removes the ticket", async () => {
    const lease = await acquireGpuLease({ model: "mellum", dir, pollMs: 5, heartbeatMs: 5 });
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    const status = await gpuLeaseStatus(dir);
    expect(status.holder?.id).toBe(lease.ticket.id);
    await lease.release();
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  // Generous timeout: these use real timers + FS, so under heavy parallel CI load the event loop
  // can stall for seconds. 20s still fails fast on a genuine liveness bug (an infinite wait).
  it("second job WAITS for the first, then proceeds in FIFO order", { timeout: 20_000 }, async () => {
    const a = await acquireGpuLease({ model: "mellum", dir, pollMs: 5, heartbeatMs: 5 });
    // Separate the enqueue milliseconds so arrival order is deterministic (at ms granularity two
    // same-instant enqueues fall to the id tiebreak — still mutually exclusive, but not the
    // arrival order this test asserts).
    await new Promise((r) => setTimeout(r, 5));

    let bAcquired = false;
    const bPromise = acquireGpuLease({ model: "qwen", dir, pollMs: 5, heartbeatMs: 5 }).then((lease) => {
      bAcquired = true;
      return lease;
    });

    // Give B several poll cycles — it must NOT acquire while A holds.
    await new Promise((r) => setTimeout(r, 40));
    expect(bAcquired).toBe(false);

    await a.release();
    const b = await bPromise;
    expect(bAcquired).toBe(true);
    expect((await gpuLeaseStatus(dir)).holder?.id).toBe(b.ticket.id);
    await b.release();
  });

  it("reclaims a stale ticket left by a dead session and proceeds", { timeout: 20_000 }, async () => {
    // Hand-write a ticket whose heartbeat is ancient → the new acquirer must reclaim it. The id
    // must be UUID-shaped (readTickets rejects malformed ids so they can't steer a delete path).
    await mkdir(dir, { recursive: true });
    const deadId = "00000000-0000-4000-8000-000000000001";
    const dead: Ticket = {
      id: deadId,
      seq: 1,
      pid: 99999,
      model: "gpt-oss-120b",
      purpose: "crashed",
      etaMs: null,
      enqueuedAt: 1,
      heartbeatAt: 1, // epoch-ish → always stale
      host: "ghost",
    };
    await writeFile(join(dir, `${deadId}.json`), JSON.stringify(dead));

    const lease = await acquireGpuLease({ model: "mellum", dir, pollMs: 5, heartbeatMs: 5, staleMs: 30_000 });
    expect(lease.ticket.id).not.toBe(deadId);
    const names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(names).not.toContain(`${deadId}.json`); // reclaimed
    expect(lease.ticket.id).toBe((await gpuLeaseStatus(dir)).holder?.id);
    await lease.release();
  });

  it("GUARANTEES mutual exclusion under concurrent contention (the mkdir lock)", { timeout: 30_000 }, async () => {
    // The crux of issue #88: N jobs racing for the GPU must NEVER both hold. Each acquirer, on
    // gaining the lease, asserts the shared holder-count is 0, bumps it, does a little async work,
    // then drops it and releases. If exclusion ever broke, `holders` would exceed 1.
    let holders = 0;
    let maxHolders = 0;
    let completed = 0;
    const worker = async () => {
      const lease = await acquireGpuLease({ model: "m", dir, pollMs: 3, heartbeatMs: 8 });
      holders++;
      maxHolders = Math.max(maxHolders, holders);
      await new Promise((r) => setTimeout(r, 6)); // hold briefly so overlaps would be observed
      holders--;
      completed++;
      await lease.release();
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    expect(completed).toBe(8);
    expect(maxHolders).toBe(1); // never two holders at once
  });

  it("clamps a too-small staleMs so a live holder is not misjudged stale (exclusion preserved)", { timeout: 20_000 }, async () => {
    // staleMs:1 (< heartbeat) would, unclamped, mark the holder's own fresh ticket stale and let a
    // second job in. The clamp (staleMs ≥ heartbeatMs*3, ≥3s floor) prevents that.
    const a = await acquireGpuLease({ model: "mellum", dir, pollMs: 5, heartbeatMs: 8, staleMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    let bAcquired = false;
    const bp = acquireGpuLease({ model: "qwen", dir, pollMs: 5, heartbeatMs: 8, staleMs: 1 }).then((l) => {
      bAcquired = true;
      return l;
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(bAcquired).toBe(false); // A still holds — its fresh ticket was not reclaimed
    await a.release();
    const b = await bp;
    await b.release();
  });

  it("release() is idempotent", async () => {
    const lease = await acquireGpuLease({ model: "mellum", dir, pollMs: 5, heartbeatMs: 5 });
    await lease.release();
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it("aborting while waiting rejects and removes the waiter's ticket (no orphan)", { timeout: 20_000 }, async () => {
    const a = await acquireGpuLease({ model: "mellum", dir, pollMs: 5, heartbeatMs: 5 });
    await new Promise((r) => setTimeout(r, 5)); // distinct enqueue ms → A is unambiguously ahead
    const ac = new AbortController();
    const waiter = acquireGpuLease({ model: "qwen", dir, pollMs: 5, heartbeatMs: 5, signal: ac.signal });

    await new Promise((r) => setTimeout(r, 20)); // let B enqueue + start waiting
    expect((await readdir(dir)).filter((f) => f.endsWith(".json"))).toHaveLength(2);

    ac.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    // B's ticket is cleaned up; only A's remains.
    const names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${a.ticket.id}.json`);
    await a.release();
  });

  it("release() lets no heartbeat write land after it resolves (no ghost .holder / ticket)", { timeout: 20_000 }, async () => {
    // Regression for the post-release write race: a heartbeat that already passed its top-of-loop
    // `released` check can still append a write to the serialize chain AFTER release() drained it,
    // re-creating `.holder/owner` and the ticket file. That ghost `.holder` then races the recursive
    // `rm` in teardown → intermittent ENOTEMPTY. With a 2 ms heartbeat a beat is almost always in
    // flight at release time; the loop makes the race deterministic enough to catch a regression.
    for (let i = 0; i < 40; i++) {
      const lease = await acquireGpuLease({ model: "mellum", dir, pollMs: 2, heartbeatMs: 2 });
      await new Promise((r) => setTimeout(r, 6)); // several heartbeats fire → holder writes .holder/owner
      await lease.release();
      await new Promise((r) => setTimeout(r, 10)); // wait well past the heartbeat interval
      const entries = await readdir(dir);
      expect(entries).not.toContain(".holder"); // no ghost lock re-created after release
      expect(entries.filter((f) => f.endsWith(".json"))).toHaveLength(0); // no ghost ticket
    }
  });
});
