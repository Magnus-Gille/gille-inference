import { afterEach, describe, expect, it, vi } from "vitest";
import {
  admitHostMemory,
  decideHostMemoryAdmission,
  parseHostMemoryBudgets,
  parseHostMemoryMode,
  parseOomKillCount,
  readOomKillCount,
  readHostMemory,
  type HostMemoryAdmissionConfig,
  type HostMemorySnapshot,
} from "../src/homeserver/host-memory-admission.js";

const GIB = 1024 ** 3;

function gibMap(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries).map(([k, v]) => [k, Math.round(v * GIB)]));
}

/** `reclaimGib` is the declared lower bound on memory released by evicting a model. */
function cfg(
  budgetsGib: Record<string, number>,
  reserveGib = 12,
  reclaimGib: Record<string, number> = {},
): Pick<HostMemoryAdmissionConfig, "modelBudgetBytes" | "modelReclaimBytes" | "reserveBytes"> {
  return {
    modelBudgetBytes: gibMap(budgetsGib),
    modelReclaimBytes: gibMap(reclaimGib),
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

  it.each(["stopping", "stopped", "shutdown", "something-new"])(
    "the requested model in state %s does not bypass the check",
    (state) => {
      const running = [{ model: "big", state }];
      const noBudget = decideHostMemoryAdmission({ requestedModel: "big", running, memory: mem(100, 90), config: cfg({}) });
      expect([noBudget.outcome, noBudget.reason]).toEqual(["refuse", "budget_unknown"]);
      const noMemory = decideHostMemoryAdmission({ requestedModel: "big", running, memory: null, config: cfg({ big: 10 }) });
      expect([noMemory.outcome, noMemory.reason]).toEqual(["refuse", "host_memory_unknown"]);
      // Its own reclaim estimate is never credited to itself.
      const self = decideHostMemoryAdmission({
        requestedModel: "big", running, memory: mem(100, 20), config: cfg({ big: 60 }, 12, { big: 60 }),
      });
      expect([self.outcome, self.evictionCreditBytes]).toEqual(["refuse", 0]);
    },
  );

  it("present in the starting state is a start in progress", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "big", state: "starting" }],
      memory: null,
      config: cfg({}),
    });
    expect([d.outcome, d.reason]).toEqual(["not_needed", "start_in_progress"]);
  });

  it("fits only thanks to eviction credit of another ready model", () => {
    const config = cfg({ big: 48, other: 40 }, 12, { other: 40 });
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

  it("a resident model without a declared reclaim estimate gives no credit, even with a peak budget", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "mystery", state: "ready" }],
      memory: mem(100, 20),
      config: cfg({ big: 60, mystery: 50 }),
    });
    expect(d.evictionCreditBytes).toBe(0);
    expect(d.outcome).toBe("refuse");
  });

  it("another model in a non-ready state gives no credit", () => {
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "other", state: "stopping" }],
      memory: mem(100, 20),
      config: cfg({ big: 60, other: 40 }, 12, { other: 40 }),
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
      config: cfg({ big: 60, other: 40 }, 12, { other: 40 }),
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
      config: cfg({ big: 80, other: 90 }, 12, { other: 90 }),
    });
    expect(d.evictionCreditBytes).toBe(30 * GIB);
    expect(d.projectedAvailableBytes).toBe(100 * GIB);
  });

  it("a peak budget is not eviction credit: other tenants plus a small resident footprint refuse", () => {
    // 100 GiB host, 20 GiB available. The resident model's peak budget is 60 GiB but it actually
    // releases about 20 GiB; unrelated tenants hold the rest. Crediting the peak would approve a
    // 60 GiB start that cannot fit.
    const input = { requestedModel: "big", running: [{ model: "other", state: "ready" }], memory: mem(100, 20) };
    const d = decideHostMemoryAdmission({ ...input, config: cfg({ big: 60, other: 60 }, 12, { other: 20 }) });
    expect(d.evictionCreditBytes).toBe(20 * GIB);
    expect(d.projectedAvailableBytes).toBe(40 * GIB);
    expect([d.outcome, d.reason]).toEqual(["refuse", "insufficient_memory"]);
    const undeclared = decideHostMemoryAdmission({ ...input, config: cfg({ big: 60, other: 60 }) });
    expect(undeclared.evictionCreditBytes).toBe(0);
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

  it("the eviction credit cap does not hand free CMA memory back as capacity", () => {
    // 30 GiB is in use, so eviction can release at most 30 GiB. The 10 GiB of free CMA is neither
    // usable nor recoverable: 60 usable + 30 credit = 90, short of 80 + 12.
    const d = decideHostMemoryAdmission({
      requestedModel: "big",
      running: [{ model: "other", state: "ready" }],
      memory: { ...mem(100, 70), cmaFreeBytes: 10 * GIB },
      config: cfg({ big: 80, other: 90 }, 12, { other: 90 }),
    });
    expect(d.evictionCreditBytes).toBe(30 * GIB);
    expect(d.projectedAvailableBytes).toBe(90 * GIB);
    expect([d.outcome, d.reason]).toEqual(["refuse", "insufficient_memory"]);
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
    const config = cfg({ "model-a": 70, "model-b": 92 }, 12, { "model-a": 60 });
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
    const { budgets, reclaim, invalid } = parseHostMemoryBudgets("a=70, b=1.5,c=0,d=-3,e=abc,f,=5,g=Infinity");
    expect(budgets.get("a")).toBe(70 * GIB);
    expect(budgets.get("b")).toBe(Math.round(1.5 * GIB));
    expect([...budgets.keys()]).toEqual(["a", "b"]);
    expect(reclaim.size).toBe(0);
    expect(invalid).toEqual(["c", "d", "e", "f", "(empty)", "g"]);
  });
  it("parses an optional reclaim estimate and drops the whole entry when it is invalid", () => {
    const { budgets, reclaim, invalid } = parseHostMemoryBudgets("a=70:55.5,b=40,c=50:60,d=50:x,e=50:,f=50:0,g=50:50");
    expect([...budgets.keys()]).toEqual(["a", "b", "g"]);
    expect(reclaim.get("a")).toBe(Math.round(55.5 * GIB));
    expect(reclaim.has("b")).toBe(false);
    expect(reclaim.get("g")).toBe(50 * GIB);
    // A reclaim estimate above the peak, non-numeric, empty or zero invalidates the entry.
    expect(invalid).toEqual(["c", "d", "e", "f"]);
  });
  it("a model id listed twice is ambiguous: every entry for it is dropped, with its reclaim estimate", () => {
    const { budgets, reclaim, invalid } = parseHostMemoryBudgets("other=60:50,other=10,big=50,other=5:5");
    expect([...budgets.keys()]).toEqual(["big"]);
    expect(reclaim.size).toBe(0);
    expect(invalid).toEqual(["other", "other", "other"]);
  });
  it.each(["other=60:50,other=bad", "other=bad,other=60:50", "other=60:50,other", "other,other=60:50"])(
    "a malformed duplicate also makes the id ambiguous: %s",
    (raw) => {
      const { budgets, reclaim, invalid } = parseHostMemoryBudgets(raw);
      expect(budgets.size).toBe(0);
      expect(reclaim.size).toBe(0);
      expect(invalid).toEqual(["other", "other"]);
    },
  );
  it("validates the converted byte value, not the GiB text", () => {
    // 1e-100 GiB rounds to 0 bytes and 1e300 GiB overflows a safe integer.
    const { budgets, reclaim, invalid } = parseHostMemoryBudgets("tiny=1e-100,huge=1e300:1e300,big=60:1e300,ok=1");
    expect([...budgets.keys()]).toEqual(["ok"]);
    expect(reclaim.size).toBe(0);
    expect(invalid).toEqual(["tiny", "huge", "big"]);
    for (const v of budgets.values()) expect(Number.isSafeInteger(v) && v > 0).toBe(true);
  });
  it("unset or blank yields nothing", () => {
    expect(parseHostMemoryBudgets(undefined)).toEqual({ budgets: new Map(), reclaim: new Map(), invalid: [] });
    expect(parseHostMemoryBudgets("  ")).toEqual({ budgets: new Map(), reclaim: new Map(), invalid: [] });
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
      process.env["HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB"] = "m=10:8";
      process.env["HOMESERVER_HOST_MEMORY_RESERVE_GIB"] = "4";
      process.env["HOMESERVER_HOST_MEMORY_RETRY_AFTER_SECONDS"] = "7";
      const c = (await freshLoad()).hostMemoryAdmission;
      expect([c.mode, c.modelBudgetBytes.get("m"), c.reserveBytes, c.retryAfterSeconds]).toEqual(["enforce", 10 * GIB, 4 * GIB, 7]);
      expect(c.modelReclaimBytes.get("m")).toBe(8 * GIB);
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

describe("OOM kill counter", () => {
  it("parses the exact cumulative oom_kill counter", () => {
    expect(parseOomKillCount("nr_free_pages 42\noom_kill 17\n")).toBe(17);
    expect(parseOomKillCount("oom_kill 9007199254740991\n")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each([
    "",
    "oom_kill",
    "oom_kill -1",
    "oom_kill 1.5",
    "oom_kill 9007199254740992",
    "oom_kill 17 extra",
    "oom_kill 17\noom_kill broken\n",
    "oom_kill broken\noom_kill 17\n",
  ])("rejects malformed or unsafe counter %j", (text) => {
    expect(parseOomKillCount(text)).toBeNull();
  });

  it("reads the counter through the injected file reader", async () => {
    await expect(readOomKillCount(async (path) => {
      expect(path).toBe("/proc/vmstat");
      return "oom_kill 23\n";
    })).resolves.toBe(23);
    await expect(readOomKillCount(async () => { throw new Error("private vmstat error"); })).resolves.toBeNull();
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
    }, "big");
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

  it("logs only the caller's trusted label, never the raw requested model text", async () => {
    const logs: Record<string, unknown>[] = [];
    const secretShaped = "sk-live-0123456789abcdef-not-a-model";
    for (const label of [null, "unknown"]) {
      const r = await admitHostMemory(base("enforce"), secretShaped, {
        getRunning: async () => [],
        readMemory: async () => ({ ok: true, memory: mem(100, 90) }),
        log: (rec) => logs.push(rec),
      }, label);
      // The caller still sees its own input echoed in the refusal.
      expect(r).toMatchObject({ code: "memory_admission_unavailable", reason: "budget_unknown" });
      expect(r!.message).toContain(secretShaped);
    }
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l["model"])).toEqual(["unknown", "unknown"]);
    expect(JSON.stringify(logs)).not.toContain("sk-live");
  });

  it("a resident model in a non-start state is still checked and logged", async () => {
    const logs: Record<string, unknown>[] = [];
    const r = await admitHostMemory(base("enforce"), "big", {
      getRunning: async () => [{ model: "big", state: "stopping", ttlSeconds: null }],
      readMemory: async () => ({ ok: true, memory: mem(100, 10) }),
      log: (rec) => logs.push(rec),
    }, "big");
    expect(r).toMatchObject({ code: "insufficient_memory" });
    expect(logs).toHaveLength(1);
  });

  it("shadow never fails a request: throwing log sink, non-Error rejections", async () => {
    const r = await admitHostMemory(base("shadow"), "big", {
      getRunning: () => Promise.reject(undefined),
      readMemory: () => Promise.reject(null),
      log: () => { throw new Error("sink down"); },
    }, "big");
    expect(r).toBeNull();
    // A rejection value that cannot be converted to a string, and a getter that throws synchronously.
    const logs: Record<string, unknown>[] = [];
    const unprintable = await admitHostMemory(base("shadow"), "big", {
      getRunning: () => Promise.reject(Object.create(null)),
      readMemory: () => { throw Object.create(null); },
      log: (rec) => logs.push(rec),
    }, "big");
    expect(unprintable).toBeNull();
    expect(logs[0]).toMatchObject({ residencyError: "unprintable error value", memoryError: "unprintable error value" });
  });

  it("an expired residency observation is cancelled, and both observations share one deadline", async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const r = await admitHostMemory(base("enforce"), "big", {
      getRunning: (signal) => { seen = signal; return new Promise(() => {}); },
      readMemory: () => new Promise(() => {}),
      log: () => {},
      observationTimeoutMs: 60,
    }, "big");
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ code: "memory_admission_unavailable" });
    expect(seen?.aborted).toBe(true);
    // One shared budget: well under two full deadlines even with timer slack.
    expect(elapsed).toBeLessThan(110);
  });

  it("a completed observation is not aborted", async () => {
    let seen: AbortSignal | undefined;
    await admitHostMemory(base("shadow"), "big", {
      getRunning: async (signal) => { seen = signal; return []; },
      readMemory: async () => ({ ok: true, memory: mem(100, 90) }),
      log: () => {},
    }, "big");
    expect(seen?.aborted).toBe(false);
  });

  it("a throwing log sink does not turn an enforce allow into a failure", async () => {
    const r = await admitHostMemory(base("enforce"), "big", {
      getRunning: async () => [],
      readMemory: async () => ({ ok: true, memory: mem(100, 90) }),
      log: () => { throw new Error("sink down"); },
    }, "big");
    expect(r).toBeNull();
  });

  it("observations that never settle are bounded by the deadline", async () => {
    const never = <T>(): Promise<T> => new Promise<T>(() => {});
    const logs: Record<string, unknown>[] = [];
    const started = Date.now();
    const shadow = await admitHostMemory(base("shadow"), "big", {
      getRunning: () => never(),
      readMemory: () => never(),
      log: (rec) => logs.push(rec),
      observationTimeoutMs: 25,
    }, "big");
    expect(shadow).toBeNull();
    expect(logs[0]).toMatchObject({ residencyKnown: false, reason: "host_memory_unknown" });
    expect(String(logs[0]!["residencyError"])).toContain("timed out");
    expect(String(logs[0]!["memoryError"])).toContain("timed out");
    // Enforce fails closed on the same condition instead of hanging.
    const enforce = await admitHostMemory(base("enforce"), "big", {
      getRunning: () => never(),
      readMemory: () => never(),
      log: () => {},
      observationTimeoutMs: 25,
    }, "big");
    expect(enforce).toMatchObject({ code: "memory_admission_unavailable", reason: "host_memory_unknown" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
