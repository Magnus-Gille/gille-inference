/**
 * Pure helpers behind the `gpu` CLI command (issue #88): duration parsing + status rendering.
 * The lease mechanics themselves are covered in tests/gpu-lease.test.ts.
 */
import { describe, it, expect } from "vitest";
import { parseDurationMs, formatGpuStatus } from "../src/homeserver/cli.js";
import { selectHolder, type Ticket } from "../src/homeserver/gpu-lease.js";

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

  it("reports idle when there are no live leases", () => {
    expect(formatGpuStatus(selectHolder([], 1000, 30_000), 1000)).toMatch(/idle/i);
  });

  it("marks the holder HOLDING and others queued, in FIFO order, with ETA remaining", () => {
    const now = 1_000_000;
    const holder = tk({ id: "a", model: "qwen", seq: now - 120_000, enqueuedAt: now - 120_000, heartbeatAt: now, etaMs: 300_000, purpose: "cascade" });
    const waiter = tk({ id: "b", model: "gemma4", seq: now - 10_000, enqueuedAt: now - 10_000, heartbeatAt: now });
    const out = formatGpuStatus(selectHolder([waiter, holder], now, 30_000), now);
    expect(out).toContain("HOLDING");
    expect(out).toContain("queued#1");
    expect(out).toContain("qwen");
    expect(out).toContain("cascade");
    // holder started 120s ago, eta 300s → ~3m remaining
    expect(out).toMatch(/eta~3m/);
    // FIFO: holder (qwen) line appears before the waiter (gemma4) line
    expect(out.indexOf("qwen")).toBeLessThan(out.indexOf("gemma4"));
  });
});
