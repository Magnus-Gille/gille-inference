import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  decidePoisonClear,
  poisonClearOnDisconnect,
  requestPoisonClear,
  makePoisonClearState,
  resetPoisonClearState,
  type PoisonClearState,
} from "../src/homeserver/poison-clear.js";
import { resetMetrics, renderMetrics } from "../src/homeserver/metrics.js";

/**
 * Unit tests for the Qwen3-Next "?????" recurrent-degeneration resilience fix.
 *
 * State machine under test (see poison-clear.ts): on an abrupt disconnect of an ALLOW-LISTED
 * recurrent model the FIRST event fires an unload immediately; a concurrent burst is collapsed by
 * the in-flight guard; a disconnect INSIDE the cooldown window schedules ONE trailing unload at the
 * boundary (so a re-poison never sticks, but unloads stay capped at one per window); a FAILED unload
 * clears the cooldown so the next disconnect retries. Full-attention models (mellum) are never
 * allow-listed → never touched.
 *
 * See docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md.
 */

const RECURRENT = ["qwen3-coder-next-80b"];
const ID = "qwen3-coder-next-80b";
const COOLDOWN = 60_000;

/** Let a fire-and-forget unload microtask + its .then()/.finally() settle before asserting. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A controllable scheduler: captures (fn, ms) so a test can fire the "timer" deterministically. */
function captureScheduler() {
  const calls: Array<{ fn: () => void; ms: number }> = [];
  return { calls, schedule: (fn: () => void, ms: number) => calls.push({ fn, ms }) };
}

describe("decidePoisonClear (pure decision)", () => {
  it("skips a non-recurrent model (mellum is full-attention → immune)", () => {
    expect(decidePoisonClear("mellum", RECURRENT, COOLDOWN, 1000, makePoisonClearState())).toBe("skip");
  });

  it("skips a null/undefined/empty model", () => {
    const s = makePoisonClearState();
    expect(decidePoisonClear(null, RECURRENT, COOLDOWN, 1000, s)).toBe("skip");
    expect(decidePoisonClear(undefined, RECURRENT, COOLDOWN, 1000, s)).toBe("skip");
    expect(decidePoisonClear("", RECURRENT, COOLDOWN, 1000, s)).toBe("skip");
  });

  it("fires for an allow-listed recurrent model with no prior clear", () => {
    expect(decidePoisonClear(ID, RECURRENT, COOLDOWN, 1000, makePoisonClearState())).toBe("fire");
  });

  it("DEFERS (not skips) while an unload is already in flight — so the boundary backstop is scheduled", () => {
    const s = makePoisonClearState();
    s.inFlight.add(ID);
    // Even with no prior cooldown, an in-flight unload must not fire a concurrent one — but it must
    // still defer so a re-poison during a slow/failing unload schedules a trailing backstop.
    expect(decidePoisonClear(ID, RECURRENT, COOLDOWN, 1000, s)).toBe("defer");
  });

  it("defers inside the cooldown window, fires at/after the boundary", () => {
    const s = makePoisonClearState();
    s.lastClearAt.set(ID, 1000);
    expect(decidePoisonClear(ID, RECURRENT, COOLDOWN, 1001, s)).toBe("defer"); // just after a clear
    expect(decidePoisonClear(ID, RECURRENT, COOLDOWN, 1000 + COOLDOWN - 1, s)).toBe("defer"); // just before boundary
    expect(decidePoisonClear(ID, RECURRENT, COOLDOWN, 1000 + COOLDOWN, s)).toBe("fire"); // inclusive boundary
  });

  it("tracks cooldowns per model independently", () => {
    const two = [ID, "another-recurrent"];
    const s = makePoisonClearState();
    s.lastClearAt.set(ID, 1000);
    expect(decidePoisonClear(ID, two, COOLDOWN, 1001, s)).toBe("defer");
    expect(decidePoisonClear("another-recurrent", two, COOLDOWN, 1001, s)).toBe("fire");
  });
});

describe("poisonClearOnDisconnect (fire / defer / skip)", () => {
  beforeEach(() => {
    resetPoisonClearState();
    resetMetrics();
  });

  it("does NOT unload a non-recurrent model and returns skip", async () => {
    const unload = vi.fn(async () => ({ ok: true, message: "ok" }));
    expect(poisonClearOnDisconnect("mellum", RECURRENT, COOLDOWN, { unload, log: () => {} })).toBe("skip");
    await flush();
    expect(unload).not.toHaveBeenCalled();
  });

  it("does NOT unload when the recurrent allow-list is empty (feature disabled)", async () => {
    const unload = vi.fn(async () => ({ ok: true, message: "ok" }));
    expect(poisonClearOnDisconnect(ID, [], COOLDOWN, { unload, log: () => {} })).toBe("skip");
    await flush();
    expect(unload).not.toHaveBeenCalled();
  });

  it("unloads exactly the served recurrent model id once and returns fire", async () => {
    const state = makePoisonClearState();
    const unload = vi.fn(async () => ({ ok: true, message: "ok" }));
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, { unload, state, now: () => 1000, log: () => {} })).toBe("fire");
    await flush();
    expect(unload).toHaveBeenCalledTimes(1);
    expect(unload).toHaveBeenCalledWith(ID);
    expect(state.inFlight.has(ID)).toBe(false); // cleared after the unload resolved
    expect(state.lastClearAt.get(ID)).toBe(1000); // cooldown timestamp recorded at fire time
  });

  it("collapses a synchronous burst to ONE immediate unload + a single scheduled backstop", async () => {
    const state = makePoisonClearState();
    // unload stays pending so the in-flight flag is held across all three calls.
    let release!: (v: { ok: boolean; message: string }) => void;
    const pending = new Promise<{ ok: boolean; message: string }>((r) => (release = r));
    const unload = vi.fn(() => pending);
    const sched = captureScheduler();
    const deps = { unload, state, now: () => 1000, schedule: sched.schedule, log: () => {} };

    // Decisions are synchronous: the first fire() sets inFlight synchronously, so the 2nd/3rd calls
    // DEFER (not fire a concurrent unload) — and schedule exactly one trailing backstop between them.
    const results = [
      poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps),
      poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps),
      poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps),
    ];
    expect(results).toEqual(["fire", "defer", "defer"]);
    expect(sched.calls).toHaveLength(1); // one trailing backstop, not three
    await flush(); // the (single) detached immediate unload runs on a microtask
    expect(unload).toHaveBeenCalledTimes(1); // only ONE concurrent unload despite the burst
    expect(state.inFlight.has(ID)).toBe(true); // still held — the unload promise is unresolved
    release({ ok: true, message: "ok" });
    await flush();
    expect(state.inFlight.has(ID)).toBe(false); // released once it resolved
  });

  it("schedules a backstop trailing for a re-poison that arrives WHILE the first unload is in flight", async () => {
    // Finding 1: an in-flight unload must not silently drop a concurrent re-poison — it must still
    // schedule the boundary backstop (otherwise a failing/slow unload could leave the window dirty).
    const state = makePoisonClearState();
    let release!: (v: { ok: boolean; message: string }) => void;
    const pending = new Promise<{ ok: boolean; message: string }>((r) => (release = r));
    const unload = vi.fn(() => pending);
    const sched = captureScheduler();
    const deps = { unload, state, now: () => 1000, schedule: sched.schedule, log: () => {} };

    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("fire");
    // unload #1 is still pending here (inFlight held) — a second disconnect must DEFER + schedule.
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("defer");
    expect(sched.calls).toHaveLength(1);
    release({ ok: true, message: "ok" });
    await flush();
  });

  it("collapses a disconnect + a watchdog trip for the SAME model to one unload per window (shared state)", async () => {
    // The degeneracy watchdog (Fix #2) calls requestPoisonClear with a different reason but the SAME
    // per-model state. A disconnect that fires, then a watchdog trip inside the window, must DEFER —
    // proving the two triggers share one cooldown and cannot double-fire / thrash the model.
    const state = makePoisonClearState();
    const unload = vi.fn(async () => ({ ok: true, message: "ok" }));
    const sched = captureScheduler();
    const deps = { unload, state, now: () => 1000, schedule: sched.schedule, log: () => {} };

    // 1) abrupt disconnect → fires immediately
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("fire");
    await flush();
    // 2) watchdog trip for the same model, same window → must defer (shared cooldown), schedule ≤1
    expect(requestPoisonClear(ID, RECURRENT, COOLDOWN, "degeneracy watchdog", deps)).toBe("defer");
    expect(sched.calls).toHaveLength(1);
    expect(unload).toHaveBeenCalledTimes(1); // the trip did NOT fire a second immediate unload
  });

  it("fires the trailing unload UNCONDITIONALLY at the boundary, even if an unload is still in flight", async () => {
    // Finding 2: the trailing must not be gated on !inFlight — that made the "ends clean" guarantee
    // depend on the first unload completing. A still-in-flight unload at the boundary must not block it.
    const state = makePoisonClearState();
    let release!: (v: { ok: boolean; message: string }) => void;
    const pending = new Promise<{ ok: boolean; message: string }>((r) => (release = r));
    const unload = vi.fn(() => pending); // never resolves until released → inFlight stays held
    const sched = captureScheduler();
    let clock = 1000;
    const deps = { unload, state, now: () => clock, schedule: sched.schedule, log: () => {} };

    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("fire"); // unload #1 pending
    clock = 5000;
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("defer");
    expect(sched.calls).toHaveLength(1);

    clock = 1000 + COOLDOWN; // the boundary fires while unload #1 is STILL in flight
    sched.calls[0]!.fn();
    await flush();
    expect(unload).toHaveBeenCalledTimes(2); // the trailing fired anyway (unconditional)
    release({ ok: true, message: "ok" });
    await flush();
  });

  it("records the BOUNDARY timestamp (not the jittered callback time) when the trailing fires", async () => {
    // Finding 3: if the timer is delayed by event-loop jitter, recording nowFn() would drift the next
    // window. The trailing records last + cooldownMs so the next window is measured from the boundary.
    const state = makePoisonClearState();
    const unload = vi.fn(async () => ({ ok: true, message: "ok" }));
    const sched = captureScheduler();
    let clock = 1000;
    const deps = { unload, state, now: () => clock, schedule: sched.schedule, log: () => {} };

    poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps); // fire @ 1000
    await flush();
    clock = 1000 + 10_000;
    poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps); // defer → trailing scheduled

    clock = 1000 + COOLDOWN + 500; // callback runs 500ms LATE (jitter)
    sched.calls[0]!.fn();
    await flush();
    expect(state.lastClearAt.get(ID)).toBe(1000 + COOLDOWN); // boundary, NOT 1000 + COOLDOWN + 500
  });

  it("defers a disconnect inside the cooldown and schedules ONE trailing unload at the boundary", async () => {
    const state = makePoisonClearState();
    const unload = vi.fn(async () => ({ ok: true, message: "ok" }));
    const sched = captureScheduler();
    let clock = 1000;
    const deps = { unload, state, now: () => clock, schedule: sched.schedule, log: () => {} };

    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("fire"); // immediate
    await flush();
    expect(unload).toHaveBeenCalledTimes(1);

    clock = 1000 + 10_000; // 10s into the 60s window
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("defer");
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("defer"); // does not double-schedule
    expect(sched.calls).toHaveLength(1);
    expect(sched.calls[0]!.ms).toBe(COOLDOWN - 10_000); // delay = time remaining in the window

    // Fire the "timer": the trailing unload runs, clearing any re-poison from the window.
    clock = 1000 + COOLDOWN;
    sched.calls[0]!.fn();
    await flush();
    expect(unload).toHaveBeenCalledTimes(2); // exactly one trailing unload — capped at one per window
    expect(state.scheduled.has(ID)).toBe(false);
  });

  it("retries on the next disconnect after a FAILED unload (does not suppress for the cooldown)", async () => {
    const state = makePoisonClearState();
    const unload = vi
      .fn<(id: string) => Promise<{ ok: boolean; message: string }>>()
      .mockResolvedValueOnce({ ok: false, message: "llama-swap 500" })
      .mockResolvedValueOnce({ ok: true, message: "ok" });
    let clock = 1000;
    const deps = { unload, state, now: () => clock, log: () => {} };

    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("fire");
    await flush(); // the failed unload resolves → lastClearAt cleared for retry
    expect(state.lastClearAt.has(ID)).toBe(false);

    clock += 1000; // well within the cooldown window — but the prior unload FAILED, so this retries
    expect(poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, deps)).toBe("fire");
    await flush();
    expect(unload).toHaveBeenCalledTimes(2);
  });

  it("does not throw when the unload rejects, and records a 'failed' metric + clears cooldown", async () => {
    const state = makePoisonClearState();
    const unload = vi.fn(async () => {
      throw new Error("llama-swap unreachable");
    });
    expect(() => poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, { unload, state, log: () => {} })).not.toThrow();
    await flush();
    expect(unload).toHaveBeenCalledTimes(1);
    expect(state.lastClearAt.has(ID)).toBe(false); // cleared so the next disconnect retries
    expect(renderMetrics()).toContain(`homeserver_poison_clear_total{model="${ID}",outcome="failed"}`);
  });

  it("records an 'ok' metric when the unload succeeds", async () => {
    poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, {
      unload: async () => ({ ok: true, message: "unloaded" }),
      state: makePoisonClearState(),
      log: () => {},
    });
    await flush();
    expect(renderMetrics()).toContain(`homeserver_poison_clear_total{model="${ID}",outcome="ok"}`);
  });

  it("records a 'failed' metric when the unload resolves ok:false", async () => {
    poisonClearOnDisconnect(ID, RECURRENT, COOLDOWN, {
      unload: async () => ({ ok: false, message: "HTTP 500" }),
      state: makePoisonClearState(),
      log: () => {},
    });
    await flush();
    expect(renderMetrics()).toContain(`homeserver_poison_clear_total{model="${ID}",outcome="failed"}`);
  });
});
