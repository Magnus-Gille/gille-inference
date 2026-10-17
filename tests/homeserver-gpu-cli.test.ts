/**
 * Pure helpers behind the `gpu` CLI command (issue #88): duration parsing + status rendering.
 * The lease mechanics themselves are covered in tests/gpu-lease.test.ts.
 */
import { describe, it, expect } from "vitest";
import { parseDurationMs, formatGpuStatus } from "../src/homeserver/cli.js";
import { selectHolder, type Ticket } from "../src/homeserver/gpu-lease.js";
import type { GpuMutexObservation } from "../src/homeserver/gpu-lease-observation.js";

describe("parseDurationMs", () => {
  it("parses s/m/h units", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("10m")).toBe(600_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
  });
  it("treats a bare number as seconds and accepts decimals", () => {
    expect(parseDurationMs("45")).toBe(45_000);
    expect(parseDurationMs("1.5m")).toBe(90_000);
  });
  it("returns null for missing/garbage input", () => {
    expect(parseDurationMs(undefined)).toBeNull();
    expect(parseDurationMs("soon")).toBeNull();
    expect(parseDurationMs("10x")).toBeNull();
  });
});

describe("formatGpuStatus", () => {
  const tk = (over: Partial<Ticket>): Ticket => ({
    id: "i", seq: 0, pid: 7, model: "mellum", purpose: "", etaMs: null,
    enqueuedAt: 0, heartbeatAt: 0, host: "m5", ...over,
  });
  const mutex = (over: Partial<GpuMutexObservation>): GpuMutexObservation => ({
    source: "gpu-mkdir-mutex-v1",
    observedAt: new Date(1000).toISOString(),
    state: "unknown",
    held: null,
    owner: null,
    ownerState: "unknown",
    reason: "test",
    ...over,
  });

  it("does not claim idle for an empty queue when the mutex is unknown", () => {
    const out = formatGpuStatus(selectHolder([], 1000, 30_000), 1000, mutex({ state: "unknown" }));
    expect(out).toMatch(/UNKNOWN/);
    expect(out).not.toMatch(/idle/i);
  });

  it("reports an orphan occupied mutex even when the queue is empty", () => {
    const out = formatGpuStatus(
      selectHolder([], 1000, 30_000),
      1000,
      mutex({
        state: "occupied",
        held: true,
        owner: { id: "11111111-1111-1111-1111-111111111111", pid: 42, heartbeatAt: 1000 },
        ownerState: "fresh",
      }),
    );
    expect(out).toContain("GPU mutex: occupied");
    expect(out).toContain("11111111-1111-1111-1111-111111111111");
    expect(out).toContain("pid=42");
    expect(out).toContain("state=fresh");
    expect(out).not.toMatch(/idle/i);
  });

  it("does not call the FIFO head HOLDING when the recorded owner differs", () => {
    const now = 1_000_000;
    const head = tk({ id: "a", model: "head", seq: now - 120_000, enqueuedAt: now - 120_000, heartbeatAt: now });
    const out = formatGpuStatus(selectHolder([head], now, 30_000), now, mutex({
      state: "occupied",
      held: true,
      owner: { id: "22222222-2222-2222-2222-222222222222", pid: 9, heartbeatAt: now },
      ownerState: "fresh",
    }));
    expect(out).toContain("queued#1");
    expect(out).not.toContain("HOLDING");
  });

  it("marks a matching recorded owner owner* and explains separate samples", () => {
    const now = 1_000_000;
    const ownerId = "33333333-3333-3333-3333-333333333333";
    const owner = tk({ id: ownerId, model: "qwen", seq: now - 120_000, enqueuedAt: now - 120_000, heartbeatAt: now });
    const out = formatGpuStatus(selectHolder([owner], now, 30_000), now, mutex({
      state: "occupied",
      held: true,
      owner: { id: ownerId, pid: 12, heartbeatAt: now },
      ownerState: "fresh",
    }));
    expect(out).toContain("owner*");
    expect(out).toMatch(/ticket.*mutex.*separately sampled/i);
  });

  it("keeps stale and missing owner markers occupied", () => {
    const stale = formatGpuStatus(selectHolder([], 1000, 30_000), 1000, mutex({
      state: "occupied", held: true, owner: { id: "44444444-4444-4444-4444-444444444444", pid: 2, heartbeatAt: 0 }, ownerState: "stale",
    }));
    const missing = formatGpuStatus(selectHolder([], 1000, 30_000), 1000, mutex({
      state: "occupied", held: true, owner: null, ownerState: "missing",
    }));
    expect(stale).toMatch(/GPU mutex: occupied/);
    expect(stale).toMatch(/state=stale/);
    expect(missing).toMatch(/GPU mutex: occupied/);
    expect(missing).toMatch(/state=missing/);
    expect(stale).not.toMatch(/idle/i);
    expect(missing).not.toMatch(/idle/i);
  });

  it("does not claim idle when the mutex is absent", () => {
    const out = formatGpuStatus(selectHolder([], 1000, 30_000), 1000, mutex({ state: "absent", held: false, reason: "mutex-absent" }));
    expect(out).toMatch(/no mutex observed/i);
    expect(out).not.toMatch(/idle/i);
  });

  it("keeps FIFO order and ETA remaining for queued tickets", () => {
    const now = 1_000_000;
    const holder = tk({ id: "a", model: "qwen", seq: now - 120_000, enqueuedAt: now - 120_000, heartbeatAt: now, etaMs: 300_000, purpose: "cascade" });
    const waiter = tk({ id: "b", model: "gemma4", seq: now - 10_000, enqueuedAt: now - 10_000, heartbeatAt: now });
    const out = formatGpuStatus(selectHolder([waiter, holder], now, 30_000), now, mutex({ state: "absent", held: false }));
    expect(out).toContain("queued#1");
    expect(out).toContain("queued#2");
    expect(out).toContain("qwen");
    expect(out).toContain("cascade");
    // holder started 120s ago, eta 300s → ~3m remaining
    expect(out).toMatch(/eta~3m/);
    // FIFO: holder (qwen) line appears before the waiter (gemma4) line
    expect(out.indexOf("qwen")).toBeLessThan(out.indexOf("gemma4"));
  });
});
