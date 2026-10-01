import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitHostMemory,
  decideHostMemoryAdmission,
  parseHostMemoryBudgets,
  parseHostMemoryMode,
  readHostMemory,
  type HostMemoryAdmissionConfig,
  type HostMemorySnapshot,
} from "../src/homeserver/host-memory-admission.js";

const GIB = 1024 ** 3;

function cfg(budgetsGib: Record<string, number>, reserveGib = 12): Pick<HostMemoryAdmissionConfig, "modelBudgetBytes" | "reserveBytes"> {
  return {
    modelBudgetBytes: new Map(Object.entries(budgetsGib).map(([k, v]) => [k, Math.round(v * GIB)])),
    reserveBytes: Math.round(reserveGib * GIB),
  };
}

function mem(totalGib: number, availableGib: number): HostMemorySnapshot {
  return {
    memTotalBytes: Math.round(totalGib * GIB),
    memAvailableBytes: Math.round(availableGib * GIB),
    cmaFreeBytes: null,
    gttUsedBytes: null,
    gttTotalBytes: null,
  };
}

describe("decideHostMemoryAdmission", () => {
  it("already resident (ready) needs no start", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "big", state: "ready" }],
      memory: null,
      config: cfg({}),
    });
    expect([d.outcome, d.reason]).toEqual(["not_needed", "already_resident"]);
  });

  it("present in a non-ready state is a start in progress", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "big", state: "starting" }],
      memory: null,
      config: cfg({}),
    });
    expect([d.outcome, d.reason]).toEqual(["not_needed", "start_in_progress"]);
  });

  it("fits only thanks to eviction credit of another ready model", () => {
    const config = cfg({ big: 48, other: 40 });
    const input = { requestedModel: "big", memory: mem(100, 20), config };
    const without = decideHostMemoryAdmission({ ...input, running: [] });
    expect(without.reason).toBe("insufficient_memory");
    const withCredit = decideHostMemoryAdmission({ ...input, running: [{ model: "other", state: "ready" }] });
    expect([withCredit.outcome, withCredit.reason]).toEqual(["allow", "fits"]);
    expect(withCredit.evictionCreditBytes).toBe(40 * GIB);
    expect(withCredit.projectedAvailableBytes).toBe(60 * GIB);
    expect(withCredit.requiredBytes).toBe(60 * GIB);
  });

  it("refuses an over-budget request", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [],
      memory: mem(100, 50),
      config: cfg({ big: 60 }),
    });
    expect([d.outcome, d.reason]).toEqual(["refuse", "insufficient_memory"]);
  });

  it("a resident model without a declared budget gives no credit", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "mystery", state: "ready" }],
      memory: mem(100, 20),
      config: cfg({ big: 60 }),
    });
    expect(d.evictionCreditBytes).toBe(0);
    expect(d.outcome).toBe("refuse");
  });

  it("another model in a non-ready state gives no credit", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "other", state: "stopping" }],
      memory: mem(100, 20),
      config: cfg({ big: 60, other: 40 }),
    });
    expect(d.evictionCreditBytes).toBe(0);
    expect(d.outcome).toBe("refuse");
  });

  it("reserve boundary: exactly equal passes, one byte short refuses", () => {
    const config = cfg({ big: 60 }, 12);
    const exact: HostMemorySnapshot = { ...mem(200, 0), memAvailableBytes: 72 * GIB };
    expect(decideHostMemoryAdmission({ requestedModel: "big", running: [], memory: exact, config }).outcome).toBe("allow");
    const short = { ...exact, memAvailableBytes: 72 * GIB - 1 };
    expect(decideHostMemoryAdmission({ requestedModel: "big", running: [], memory: short, config }).outcome).toBe("refuse");
  });

  it("budget unknown refuses", () => {
    const d = decideHostMemoryAdmission({ requestedModel: "big", running: [], memory: mem(100, 90), config: cfg({}) });
    expect([d.outcome, d.reason]).toEqual(["refuse", "budget_unknown"]);
  });

  it("host memory unknown refuses", () => {
    const d = decideHostMemoryAdmission({ requestedModel: "big", running: [], memory: null, config: cfg({ big: 10 }) });
    expect([d.outcome, d.reason]).toEqual(["refuse", "host_memory_unknown"]);
  });

  it("residency unknown gives no credit", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: null,
      memory: mem(100, 20),
      config: cfg({ big: 60, other: 40 }),
    });
    expect(d.residencyKnown).toBe(false);
    expect(d.evictionCreditBytes).toBe(0);
    expect(d.outcome).toBe("refuse");
  });

  it("caps credit at used memory", () => {
    // Declared 90 GiB resident, but only 30 GiB of the host is actually in use.
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "other", state: "ready" }],
      memory: mem(100, 70),
      config: cfg({ big: 80, other: 90 }),
    });
    expect(d.evictionCreditBytes).toBe(30 * GIB);
    expect(d.projectedAvailableBytes).toBe(100 * GIB);
  });

  it("fits on raw MemAvailable but is refused once free CMA is subtracted", () => {
    const base = { requestedModel: "big", running: [], config: cfg({ big: 60 }) };
    const raw = mem(120, 75);
    expect(decideHostMemoryAdmission({ ...base, memory: raw }).outcome).toBe("allow");
    const d = decideHostMemoryAdmission({ ...base, memory: { ...raw, cmaFreeBytes: 13 * GIB } });
    expect([d.outcome, d.reason]).toEqual(["refuse", "insufficient_memory"]);
    expect(d.memAvailableBytes).toBe(75 * GIB);
    expect(d.cmaFreeBytes).toBe(13 * GIB);
    expect(d.usableAvailableBytes).toBe(62 * GIB);
    expect(d.projectedAvailableBytes).toBe(62 * GIB);
  });

  it("CmaFree absent behaves as before; CMA larger than MemAvailable floors usable at 0", () => {
    const base = { requestedModel: "big", running: [], config: cfg({ big: 60 }) };
    const d = decideHostMemoryAdmission({ ...base, memory: mem(120, 75) });
    expect([d.cmaFreeBytes, d.usableAvailableBytes]).toEqual([null, 75 * GIB]);
    const floored = decideHostMemoryAdmission({ ...base, memory: { ...mem(120, 5), cmaFreeBytes: 9 * GIB } });
    expect(floored.usableAvailableBytes).toBe(0);
  });

  it("eviction credit cap uses usable (CMA-adjusted) available memory", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "other", state: "ready" }],
      memory: { ...mem(100, 70), cmaFreeBytes: 10 * GIB },
      config: cfg({ big: 80, other: 90 }),
    });
    expect(d.evictionCreditBytes).toBe(40 * GIB); // 100 total - 60 usable
    expect(d.projectedAvailableBytes).toBe(100 * GIB);
  });

  it("carries GTT as evidence without affecting the decision", () => {
    const base = { requestedModel: "big", running: [], config: cfg({ big: 60 }) };
    const a = decideHostMemoryAdmission({ ...base, memory: { ...mem(100, 80), gttUsedBytes: 1, gttTotalBytes: 2 } });
    const b = decideHostMemoryAdmission({ ...base, memory: mem(100, 80) });
    expect(a.outcome).toBe(b.outcome);
    expect([a.gttUsedBytes, a.gttTotalBytes]).toEqual([1, 2]);
  });

  // ILLUSTRATIVE numbers only: NOT measured on the host, chosen to show the incident shape.
  describe("incident shape (illustrative, not measured)", () => {
    const config = cfg({ "model-a": 70, "model-b": 92 }, 12);
    const running = [{ model: "model-a", state: "ready" }];
    it("refused when other tenants hold memory (MemAvailable 30 GiB)", () => {
      const d = decideHostMemoryAdmission({ requestedModel: "model-b", running, memory: mem(122.7, 30), config });
      expect([d.outcome, d.reason]).toEqual(["refuse", "insufficient_memory"]);
    });
    it("allowed with MemAvailable 50 GiB", () => {
      const d = decideHostMemoryAdmission({ requestedModel: "model-b", running, memory: mem(122.7, 50), config });
      expect([d.outcome, d.reason]).toEqual(["allow", "fits"]);
    });
  });
});

describe("parseHostMemoryBudgets", () => {
  it("parses valid entries including decimals and drops invalid ones by name", () => {
    const { budgets, invalid } = parseHostMemoryBudgets("a=70, b=1.5,c=0,d=-3,e=abc,f,=5,g=Infinity");
    expect(budgets.get("a")).toBe(70 * GIB);
    expect(budgets.get("b")).toBe(Math.round(1.5 * GIB));
    expect([...budgets.keys()]).toEqual(["a", "b"]);
    expect(invalid).toEqual(["c", "d", "e", "f", "(empty)", "g"]);
  });
  it("unset or blank yields nothing", () => {
    expect(parseHostMemoryBudgets(undefined)).toEqual({ budgets: new Map(), invalid: [] });
    expect(parseHostMemoryBudgets("  ")).toEqual({ budgets: new Map(), invalid: [] });
  });
});

describe("parseHostMemoryMode / config", () => {
  it("defaults to off for unset or invalid", () => {
    expect(parseHostMemoryMode(undefined)).toBe("off");
    expect(parseHostMemoryMode("on")).toBe("off");
    expect(parseHostMemoryMode("shadow")).toBe("shadow");
    expect(parseHostMemoryMode("enforce")).toBe("enforce");
  });
  describe("loadConfig", () => {
    const keys = [
      "HOMESERVER_HOST_MEMORY_ADMISSION",
      "HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB",
      "HOMESERVER_HOST_MEMORY_RESERVE_GIB",
      "HOMESERVER_HOST_MEMORY_RETRY_AFTER_SECONDS",
    ];
    afterEach(() => { for (const k of keys) delete process.env[k]; });
    // loadConfig() caches per module instance, so load a fresh module for each env.
    const freshLoad = async () => {
      vi.resetModules();
      return (await import("../src/homeserver/config.js")).loadConfig();
    };
    it("defaults: off, no budgets, 12 GiB reserve, 30 s", async () => {
      for (const k of keys) delete process.env[k];
      const c = (await freshLoad()).hostMemoryAdmission;
      expect(c.mode).toBe("off");
      expect(c.modelBudgetBytes.size).toBe(0);
      expect(c.reserveBytes).toBe(12 * GIB);
      expect(c.retryAfterSeconds).toBe(30);
    });
    it("reads the env vars", async () => {
      process.env["HOMESERVER_HOST_MEMORY_ADMISSION"] = "enforce";
      process.env["HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB"] = "m=10";
      process.env["HOMESERVER_HOST_MEMORY_RESERVE_GIB"] = "4";
      process.env["HOMESERVER_HOST_MEMORY_RETRY_AFTER_SECONDS"] = "7";
      const c = (await freshLoad()).hostMemoryAdmission;
      expect([c.mode, c.modelBudgetBytes.get("m"), c.reserveBytes, c.retryAfterSeconds]).toEqual(["enforce", 10 * GIB, 4 * GIB, 7]);
    });
  });
});

describe("readHostMemory", () => {
  const meminfo = "MemTotal:       1048576 kB\nMemFree: 1 kB\nMemAvailable:    524288 kB\nCmaFree:          1024 kB\n";
  const files = (m: Record<string, string>) => async (p: string): Promise<string> => {
    const v = m[p];
    if (v === undefined) throw new Error(`ENOENT: ${p}`);
    return v;
  };

  it("reads meminfo and the first readable GTT pair", async () => {
    const r = await readHostMemory(files({
      "/proc/meminfo": meminfo,
      "/sys/class/drm/card1/device/mem_info_gtt_used": "1234\n",
      "/sys/class/drm/card1/device/mem_info_gtt_total": "5678\n",
    }));
    expect(r).toEqual({
      ok: true,
      memory: { memTotalBytes: 1024 ** 3, memAvailableBytes: 512 * 1024 ** 2, cmaFreeBytes: 1024 * 1024, gttUsedBytes: 1234, gttTotalBytes: 5678 },
    });
  });

  it("absent CmaFree line gives null", async () => {
    const r = await readHostMemory(files({ "/proc/meminfo": "MemTotal: 1048576 kB\nMemAvailable: 524288 kB\n" }));
    expect(r.ok && r.memory.cmaFreeBytes).toBe(null);
  });

  it("missing GTT files give null GTT fields but a valid snapshot", async () => {
    const r = await readHostMemory(files({ "/proc/meminfo": meminfo }));
    expect(r.ok).toBe(true);
    if (r.ok) expect([r.memory.gttUsedBytes, r.memory.gttTotalBytes]).toEqual([null, null]);
  });

  it("unreadable meminfo is an explicit failure carrying the cause", async () => {
    const r = await readHostMemory(files({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ENOENT: /proc/meminfo");
  });

  it("unparseable meminfo is an explicit failure", async () => {
    const r = await readHostMemory(files({ "/proc/meminfo": "garbage" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/MemTotal/);
  });
});

describe("admitHostMemory orchestration", () => {
  const base = (mode: HostMemoryAdmissionConfig["mode"]): HostMemoryAdmissionConfig => ({
    mode,
    ...cfg({ big: 60 }),
    retryAfterSeconds: 30,
  });

  it("off performs no I/O", async () => {
    let calls = 0;
    const r = await admitHostMemory(base("off"), "big", {
      getRunning: async () => { calls++; return []; },
      readMemory: async () => { calls++; return { ok: false, error: "x" }; },
      log: () => { calls++; },
    });
    expect(r).toBeNull();
    expect(calls).toBe(0);
  });

  it("shadow logs one content-free record and never rejects", async () => {
    const logs: Record<string, unknown>[] = [];
    const r = await admitHostMemory(base("shadow"), "big", {
      getRunning: async () => [],
      readMemory: async () => ({ ok: true, memory: mem(100, 10) }),
      log: (rec) => logs.push(rec),
    });
    expect(r).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: "host_memory_admission", mode: "shadow", model: "big", outcome: "refuse", reason: "insufficient_memory", enforced: false });
  });

  it("enforce rejects with the right code, without byte numbers in the message", async () => {
    const r = await admitHostMemory(base("enforce"), "big", {
      getRunning: async () => [],
      readMemory: async () => ({ ok: true, memory: mem(100, 10) }),
      log: () => {},
    });
    expect(r).toMatchObject({ code: "insufficient_memory", retryAfterSeconds: 30 });
    expect(r!.message).toContain("big");
    expect(r!.message).not.toMatch(/\d{6,}/);
  });

  it("residency failure and memory failure are recorded, not swallowed", async () => {
    const logs: Record<string, unknown>[] = [];
    const r = await admitHostMemory(base("enforce"), "big", {
      getRunning: async () => { throw new Error("running down"); },
      readMemory: async () => ({ ok: false, error: "meminfo gone" }),
      log: (rec) => logs.push(rec),
    });
    expect(r).toMatchObject({ code: "memory_admission_unavailable", retryAfterSeconds: null, reason: "host_memory_unknown" });
    expect(logs[0]).toMatchObject({ residencyError: "running down", memoryError: "meminfo gone", residencyKnown: false });
  });
});
