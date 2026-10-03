import { describe, expect, it, vi } from "vitest";
import { createModelStartAdmission, HostMemoryAdmissionError } from "../src/homeserver/host-memory-admission.js";

const GIB = 2 ** 30;
function fixture(mode: "off" | "shadow" | "enforce") {
  const log = vi.fn();
  const getRunning = vi.fn(async () => []);
  const readMemory = vi.fn(async () => ({ ok: true as const, memory: {
    memTotalBytes: 100 * GIB, memAvailableBytes: 10 * GIB,
    cmaFreeBytes: null, gttUsedBytes: null, gttTotalBytes: null,
  } }));
  const label = vi.fn(() => "known-model");
  const guard = createModelStartAdmission({ mode, modelBudgetBytes: new Map([["big", 60 * GIB]]),
    modelReclaimBytes: new Map(), reserveBytes: 12 * GIB, retryAfterSeconds: 9 },
    { getRunning, readMemory, log }, label);
  return { guard, log, getRunning, readMemory, label };
}

describe("model-start admission boundary", () => {
  it("enforce raises a typed refusal before the caller's backend side effect", async () => {
    const f = fixture("enforce"); const backend = vi.fn();
    await expect((async () => { await f.guard("big"); backend(); })()).rejects.toMatchObject({
      rejection: { code: "insufficient_memory", retryAfterSeconds: 9 },
    });
    await expect(f.guard("big")).rejects.toBeInstanceOf(HostMemoryAdmissionError);
    expect(backend).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ model: "known-model", enforced: true }));
  });
  it("shadow observes the same refusal but permits the backend", async () => {
    const f = fixture("shadow"); await f.guard("big");
    expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ outcome: "refuse", enforced: false }));
  });
  it("off performs no observations or label lookup", async () => {
    const f = fixture("off"); await f.guard("big");
    expect(f.getRunning).not.toHaveBeenCalled(); expect(f.readMemory).not.toHaveBeenCalled();
    expect(f.log).not.toHaveBeenCalled(); expect(f.label).not.toHaveBeenCalled();
  });
});
