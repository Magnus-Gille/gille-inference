import { describe, expect, it, vi } from "vitest";
import {
  MODEL_LIFECYCLE_OBSERVER_INTERVAL_MS,
  startModelLifecycleObserver,
  type ModelLifecycleObserverDependencies,
} from "../src/homeserver/model-lifecycle-observer.js";
import { RunningSnapshotUnavailableError } from "../src/homeserver/model-admin.js";
import type { ModelLifecycleEvent, SanitizedModelSnapshotEntry } from "../src/homeserver/model-lifecycle.js";

function snapshot(state: string, ttlSeconds: number | null): SanitizedModelSnapshotEntry[] {
  return [{ model: "qwen-main", state, ttlSeconds }];
}

async function flushObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function dependencies(
  snapshots: Array<SanitizedModelSnapshotEntry[]>,
  appended: ModelLifecycleEvent[],
  timer: { callback: () => void; unref: ReturnType<typeof vi.fn> },
  clearInterval: ReturnType<typeof vi.fn>,
): ModelLifecycleObserverDependencies {
  return {
    getRunningSnapshot: vi.fn(async () => snapshots.shift() ?? []),
    appendModelLifecycleEvents: vi.fn((events) => appended.push(...events)),
    now: () => Date.parse("2026-08-10T12:00:00.000Z"),
    setInterval: (callback, delayMs) => {
      expect(delayMs).toBe(MODEL_LIFECYCLE_OBSERVER_INTERVAL_MS);
      timer.callback = callback;
      return {
        unref: timer.unref,
      } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval,
    reportError: vi.fn(),
  };
}

describe("model lifecycle observer", () => {
  it("observes startup and transitions, unrefs its timer, and clears it on stop", async () => {
    const appended: ModelLifecycleEvent[] = [];
    const timer = { callback: () => undefined, unref: vi.fn() };
    const clearInterval = vi.fn();
    const handle = startModelLifecycleObserver(
      dependencies(
        [snapshot("loading", 60), snapshot("ready", 30)],
        appended,
        timer,
        clearInterval,
      ),
    );

    await flushObserver();
    expect(appended).toEqual([
      {
        ts: "2026-08-10T12:00:00.000Z",
        model: "qwen-main",
        event: "load",
        state: "loading",
        ttlSeconds: 60,
        cause: "snapshot",
      },
    ]);
    expect(timer.unref).toHaveBeenCalledOnce();

    timer.callback();
    await flushObserver();
    expect(appended.at(-1)).toEqual({
      ts: "2026-08-10T12:00:00.000Z",
      model: "qwen-main",
      event: "ready",
      state: "ready",
      ttlSeconds: 30,
      cause: "snapshot",
    });

    handle.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
    handle.stop();
    expect(clearInterval).toHaveBeenCalledOnce();
  });

  it("contains snapshot and persistence failures without rejecting the timer callback", async () => {
    const reportError = vi.fn();
    const appendModelLifecycleEvents = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const timer = { callback: () => undefined, unref: vi.fn() };
    const clearInterval = vi.fn();
    const getRunningSnapshot = vi
      .fn<() => Promise<SanitizedModelSnapshotEntry[]>>()
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce(snapshot("ready", null));

    const handle = startModelLifecycleObserver({
      getRunningSnapshot,
      appendModelLifecycleEvents,
      now: Date.now,
      setInterval: (callback) => {
        timer.callback = callback;
        return { unref: timer.unref } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval,
      reportError,
    });

    await flushObserver();
    expect(reportError).toHaveBeenCalledOnce();
    timer.callback();
    await flushObserver();
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(() => handle.stop()).not.toThrow();
  });

  it("does not emit lifecycle events for an unavailable snapshot", async () => {
    const appended: ModelLifecycleEvent[] = [];
    const timer = { callback: () => undefined, unref: vi.fn() };
    const clearInterval = vi.fn();
    const getRunningSnapshot = vi
      .fn<() => Promise<SanitizedModelSnapshotEntry[]>>()
      .mockResolvedValueOnce(snapshot("ready", 60))
      .mockRejectedValueOnce(new RunningSnapshotUnavailableError("backend unavailable", 503));

    const handle = startModelLifecycleObserver({
      getRunningSnapshot,
      appendModelLifecycleEvents: (events) => appended.push(...events),
      now: () => Date.parse("2026-08-10T12:00:00.000Z"),
      setInterval: (callback) => {
        timer.callback = callback;
        return { unref: timer.unref } as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval,
      reportError: vi.fn(),
    });

    await flushObserver();
    expect(appended).toHaveLength(1);

    timer.callback();
    await flushObserver();
    expect(appended).toHaveLength(1);
    expect(appended[0]?.event).toBe("ready");
    handle.stop();
  });
});
