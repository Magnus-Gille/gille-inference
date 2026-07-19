/**
 * measure-swap-latency.test.ts — test-first (red→green) for scripts/measure-swap-latency.ts.
 *
 * NO real network calls. `discoverModels` is stubbed via globalThis.fetch (same pattern as
 * probe-runner.test.ts); the measurement loop (`measureOne`/`runMatrix`) is exercised via the
 * injected `MeasureDeps` seam with a fake clock and fake chat/getRunningModel implementations.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseArgs,
  applyExclude,
  flagContaminated,
  shapeSample,
  rotate,
  median,
  summarizeByModel,
  renderMarkdownTable,
  measureOne,
  runMatrix,
  discoverModels,
  DEFAULT_BASE,
  type SwapSample,
  type MeasureDeps,
  type RawSampleInput,
} from "../scripts/measure-swap-latency.js";

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("defaults: base=DEFAULT_BASE, models=null, exclude=[], repeats=1, timeoutS=300", () => {
    const args = parseArgs([]);
    expect(args.base).toBe(DEFAULT_BASE);
    expect(args.models).toBeNull();
    expect(args.exclude).toEqual([]);
    expect(args.repeats).toBe(1);
    expect(args.timeoutS).toBe(300);
  });

  it("parses --base and strips a trailing slash", () => {
    expect(parseArgs(["--base", "http://host:9999/"]).base).toBe("http://host:9999");
  });

  it("parses --models as a trimmed, non-empty comma list", () => {
    expect(parseArgs(["--models", "a, b ,c"]).models).toEqual(["a", "b", "c"]);
  });

  it("parses --exclude the same way", () => {
    expect(parseArgs(["--exclude", "x,y"]).exclude).toEqual(["x", "y"]);
  });

  it("parses --repeats as a positive integer", () => {
    expect(parseArgs(["--repeats", "3"]).repeats).toBe(3);
  });

  it("parses --timeout-s as a positive number", () => {
    expect(parseArgs(["--timeout-s", "45"]).timeoutS).toBe(45);
  });

  it("rejects a non-numeric --repeats", () => {
    expect(() => parseArgs(["--repeats", "abc"])).toThrow(/--repeats must be a positive integer/);
  });

  it("rejects a zero --repeats", () => {
    expect(() => parseArgs(["--repeats", "0"])).toThrow(/--repeats must be a positive integer/);
  });

  it("rejects a negative --repeats", () => {
    expect(() => parseArgs(["--repeats", "-2"])).toThrow(/--repeats must be a positive integer/);
  });

  it("rejects a fractional --repeats", () => {
    expect(() => parseArgs(["--repeats", "1.5"])).toThrow(/--repeats must be a positive integer/);
  });

  it("rejects a non-numeric --timeout-s", () => {
    expect(() => parseArgs(["--timeout-s", "soon"])).toThrow(/--timeout-s must be a positive number/);
  });

  it("rejects a zero or negative --timeout-s", () => {
    expect(() => parseArgs(["--timeout-s", "0"])).toThrow(/--timeout-s must be a positive number/);
    expect(() => parseArgs(["--timeout-s", "-5"])).toThrow(/--timeout-s must be a positive number/);
  });

  it("rejects a flag with a missing value", () => {
    expect(() => parseArgs(["--repeats"])).toThrow(/--repeats requires a value/);
  });

  it("rejects an unrecognized argument", () => {
    expect(() => parseArgs(["--bogus", "1"])).toThrow(/unrecognized argument: --bogus/);
  });
});

// ─── applyExclude ─────────────────────────────────────────────────────────────

describe("applyExclude", () => {
  it("removes excluded ids", () => {
    expect(applyExclude(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });
  it("is a no-op with an empty exclude list", () => {
    expect(applyExclude(["a", "b"], [])).toEqual(["a", "b"]);
  });
  it("can exclude everything, leaving an empty array", () => {
    expect(applyExclude(["a", "b"], ["a", "b"])).toEqual([]);
  });
});

// ─── flagContaminated ─────────────────────────────────────────────────────────

describe("flagContaminated", () => {
  it("is clean when the sampled model is resident afterward", () => {
    const r = flagContaminated("mellum", "mellum");
    expect(r.contaminated).toBe(false);
    expect(r.note).toBeNull();
  });
  it("flags contamination when a different model is resident afterward", () => {
    const r = flagContaminated("mellum", "qwen3-30b-instruct");
    expect(r.contaminated).toBe(true);
    expect(r.note).toContain("mellum");
    expect(r.note).toContain("qwen3-30b-instruct");
  });
  it("flags contamination when nothing is resident afterward", () => {
    const r = flagContaminated("mellum", null);
    expect(r.contaminated).toBe(true);
    expect(r.note).toContain("(none)");
  });
});

// ─── shapeSample ──────────────────────────────────────────────────────────────

describe("shapeSample", () => {
  function baseInput(overrides: Partial<RawSampleInput> = {}): RawSampleInput {
    return {
      model: "mellum",
      pass: 1,
      fromModel: "qwen3-30b-instruct",
      afterModel: "mellum",
      coldMs: 8000,
      warmMs: 400,
      error: null,
      timestamp: "2026-07-02T00:00:00.000Z",
      ...overrides,
    };
  }

  it("computes swapCostMs = cold - warm on a clean sample", () => {
    const s = shapeSample(baseInput());
    expect(s.swapCostMs).toBe(7600);
    expect(s.contaminated).toBe(false);
    expect(s.error).toBeNull();
  });

  it("swapCostMs is null when coldMs is null (errored before timing)", () => {
    const s = shapeSample(baseInput({ coldMs: null, warmMs: null, error: "timeout" }));
    expect(s.swapCostMs).toBeNull();
    expect(s.error).toBe("timeout");
  });

  it("swapCostMs is null when only warmMs is null (cold ok, warm errored)", () => {
    const s = shapeSample(baseInput({ warmMs: null, error: "HTTP 500" }));
    expect(s.swapCostMs).toBeNull();
  });

  it("propagates contamination from flagContaminated", () => {
    const s = shapeSample(baseInput({ afterModel: "gpt-oss-120b" }));
    expect(s.contaminated).toBe(true);
    expect(s.note).not.toBeNull();
  });

  it("carries model/pass/fromModel/timestamp through unchanged", () => {
    const s = shapeSample(baseInput());
    expect(s.model).toBe("mellum");
    expect(s.pass).toBe(1);
    expect(s.fromModel).toBe("qwen3-30b-instruct");
    expect(s.timestamp).toBe("2026-07-02T00:00:00.000Z");
  });
});

// ─── rotate ────────────────────────────────────────────────────────────────────

describe("rotate", () => {
  it("n=0 returns the original order", () => {
    expect(rotate(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
  });
  it("rotates left by n", () => {
    expect(rotate(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], 2)).toEqual(["c", "a", "b"]);
  });
  it("wraps around when n >= length", () => {
    expect(rotate(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
    expect(rotate(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
  });
  it("handles an empty array", () => {
    expect(rotate([], 5)).toEqual([]);
  });
  it("does not mutate the input", () => {
    const input = ["a", "b", "c"];
    rotate(input, 1);
    expect(input).toEqual(["a", "b", "c"]);
  });
});

// ─── median ────────────────────────────────────────────────────────────────────

describe("median", () => {
  it("returns null for an empty array", () => {
    expect(median([])).toBeNull();
  });
  it("returns the single value for a 1-element array", () => {
    expect(median([42])).toBe(42);
  });
  it("returns the middle value for an odd-length array (unsorted input)", () => {
    expect(median([5, 1, 3])).toBe(3);
  });
  it("averages the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

// ─── summarizeByModel ─────────────────────────────────────────────────────────

describe("summarizeByModel", () => {
  function sample(overrides: Partial<SwapSample> = {}): SwapSample {
    return {
      model: "mellum",
      pass: 1,
      fromModel: "qwen3-30b-instruct",
      coldMs: 8000,
      warmMs: 400,
      swapCostMs: 7600,
      contaminated: false,
      note: null,
      error: null,
      timestamp: "2026-07-02T00:00:00.000Z",
      ...overrides,
    };
  }

  it("groups by model and sorts alphabetically", () => {
    const out = summarizeByModel([sample({ model: "z-model" }), sample({ model: "a-model" })]);
    expect(out.map((o) => o.model)).toEqual(["a-model", "z-model"]);
  });

  it("computes n / nClean / nContaminated correctly", () => {
    const out = summarizeByModel([
      sample({ pass: 1 }),
      sample({ pass: 2, contaminated: true, note: "x" }),
      sample({ pass: 3 }),
    ]);
    const m = out.find((o) => o.model === "mellum")!;
    expect(m.n).toBe(3);
    expect(m.nContaminated).toBe(1);
    expect(m.nClean).toBe(2);
  });

  it("excludes contaminated samples from the median", () => {
    const out = summarizeByModel([
      sample({ coldMs: 8000, warmMs: 400, swapCostMs: 7600 }),
      sample({ coldMs: 99999, warmMs: 99999, swapCostMs: 99999, contaminated: true, note: "x" }),
    ]);
    const m = out[0]!;
    expect(m.medianColdMs).toBe(8000);
    expect(m.medianSwapCostMs).toBe(7600);
  });

  it("excludes errored samples from the median", () => {
    const out = summarizeByModel([
      sample({ coldMs: 8000, warmMs: 400, swapCostMs: 7600 }),
      sample({ coldMs: null, warmMs: null, swapCostMs: null, error: "timeout" }),
    ]);
    const m = out[0]!;
    expect(m.nClean).toBe(1);
    expect(m.medianColdMs).toBe(8000);
  });

  it("medians are null when every sample for a model is contaminated/errored", () => {
    const out = summarizeByModel([sample({ contaminated: true, note: "x" })]);
    const m = out[0]!;
    expect(m.medianColdMs).toBeNull();
    expect(m.medianWarmMs).toBeNull();
    expect(m.medianSwapCostMs).toBeNull();
  });

  it("computes the median across multiple clean samples", () => {
    const out = summarizeByModel([
      sample({ swapCostMs: 100 }),
      sample({ swapCostMs: 300 }),
      sample({ swapCostMs: 200 }),
    ]);
    expect(out[0]!.medianSwapCostMs).toBe(200);
  });
});

// ─── renderMarkdownTable ──────────────────────────────────────────────────────

describe("renderMarkdownTable", () => {
  it("renders a per-sample row and a per-model summary row", () => {
    const samples: SwapSample[] = [
      {
        model: "mellum",
        pass: 1,
        fromModel: "qwen3-30b-instruct",
        coldMs: 8000,
        warmMs: 400,
        swapCostMs: 7600,
        contaminated: false,
        note: null,
        error: null,
        timestamp: "t",
      },
    ];
    const summaries = summarizeByModel(samples);
    const table = renderMarkdownTable(samples, summaries);
    expect(table).toContain("| mellum | qwen3-30b-instruct | 8000 | 400 | 7600 | no |");
    expect(table).toContain("| mellum | 1 | 1 | 0 | 8000 | 400 | 7600 |");
  });

  it("renders 'yes' for contaminated rows and (none) for a null fromModel", () => {
    const samples: SwapSample[] = [
      {
        model: "mellum",
        pass: 1,
        fromModel: null,
        coldMs: null,
        warmMs: null,
        swapCostMs: null,
        contaminated: true,
        note: "x",
        error: null,
        timestamp: "t",
      },
    ];
    const table = renderMarkdownTable(samples, summarizeByModel(samples));
    expect(table).toContain("| mellum | (none) | — | — | — | yes |");
  });
});

// ─── measureOne (injected deps — fake clock, fake chat/getRunningModel) ──────

describe("measureOne", () => {
  function fakeDeps(overrides: Partial<MeasureDeps> = {}): MeasureDeps {
    let t = 0;
    return {
      chat: vi.fn().mockImplementation(async () => {
        t += 100; // each call "takes" 100ms on the fake clock
      }),
      getRunningModel: vi.fn().mockResolvedValue("mellum"),
      now: () => t,
      nowIso: () => "2026-07-02T00:00:00.000Z",
      ...overrides,
    };
  }

  it("calls chat exactly twice (cold then warm) for a clean sample", async () => {
    const deps = fakeDeps();
    await measureOne("mellum", 1, deps);
    expect(deps.chat).toHaveBeenCalledTimes(2);
    expect(deps.chat).toHaveBeenNthCalledWith(1, "mellum");
    expect(deps.chat).toHaveBeenNthCalledWith(2, "mellum");
  });

  it("checks getRunningModel exactly twice — before and after", async () => {
    const deps = fakeDeps();
    await measureOne("mellum", 1, deps);
    expect(deps.getRunningModel).toHaveBeenCalledTimes(2);
  });

  it("measures cold and warm durations from the injected clock", async () => {
    let t = 0;
    const durations = [8000, 400]; // cold call takes 8s, warm call takes 0.4s
    let call = 0;
    const deps = fakeDeps({
      chat: vi.fn().mockImplementation(async () => {
        t += durations[call]!;
        call++;
      }),
      now: () => t,
    });
    const s = await measureOne("mellum", 1, deps);
    expect(s.coldMs).toBe(8000);
    expect(s.warmMs).toBe(400);
    expect(s.swapCostMs).toBe(7600);
  });

  it("records fromModel from the first getRunningModel call", async () => {
    const calls = ["qwen3-30b-instruct", "mellum"];
    let i = 0;
    const deps = fakeDeps({ getRunningModel: vi.fn().mockImplementation(async () => calls[i++]) });
    const s = await measureOne("mellum", 1, deps);
    expect(s.fromModel).toBe("qwen3-30b-instruct");
  });

  it("flags contamination when the after-check sees a different model", async () => {
    const calls = ["qwen3-30b-instruct", "gpt-oss-120b"];
    let i = 0;
    const deps = fakeDeps({ getRunningModel: vi.fn().mockImplementation(async () => calls[i++]) });
    const s = await measureOne("mellum", 1, deps);
    expect(s.contaminated).toBe(true);
  });

  it("skips the warm call and records the error when the cold call throws", async () => {
    const chat = vi.fn().mockRejectedValue(new Error("HTTP 500: boom"));
    const deps = fakeDeps({ chat });
    const s = await measureOne("mellum", 1, deps);
    expect(chat).toHaveBeenCalledTimes(1); // never attempted the warm call
    expect(s.error).toContain("HTTP 500");
    expect(s.coldMs).toBeNull();
    expect(s.warmMs).toBeNull();
    expect(s.swapCostMs).toBeNull();
  });

  it("records the error when only the warm call throws (cold succeeded)", async () => {
    let calls = 0;
    const chat = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 2) throw new Error("timeout");
    });
    const deps = fakeDeps({ chat });
    const s = await measureOne("mellum", 1, deps);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(s.coldMs).not.toBeNull();
    expect(s.warmMs).toBeNull();
    expect(s.error).toBe("timeout");
  });

  it("stamps the sample with the given pass and the injected nowIso", async () => {
    const deps = fakeDeps();
    const s = await measureOne("mellum", 3, deps);
    expect(s.pass).toBe(3);
    expect(s.timestamp).toBe("2026-07-02T00:00:00.000Z");
  });

  it("does not throw when the initial getRunningModel() call rejects (e.g. /running timeout) — treats it as unknown and still measures", async () => {
    const deps = fakeDeps({
      getRunningModel: vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue("mellum"),
    });
    const s = await measureOne("mellum", 1, deps);
    expect(s.fromModel).toBeNull();
    expect(s.coldMs).not.toBeNull(); // the chat calls still ran despite the monitoring failure
    expect(s.warmMs).not.toBeNull();
  });

  it("does not throw when the after-check getRunningModel() call rejects — treats it as unknown (null) and flags contaminated, not a crash", async () => {
    const deps = fakeDeps({
      getRunningModel: vi.fn().mockResolvedValueOnce("mellum").mockRejectedValueOnce(new Error("ECONNRESET")),
    });
    const s = await measureOne("mellum", 1, deps);
    expect(s.error).toBeNull(); // the chat calls themselves succeeded
    expect(s.contaminated).toBe(true); // can't confirm residency → safe default excludes it from medians
    expect(s.note).toContain("(none)");
  });
});

// ─── runMatrix (the injected-chatFn measurement loop) ────────────────────────

describe("runMatrix", () => {
  function fakeDeps(): MeasureDeps {
    let t = 0;
    return {
      chat: vi.fn().mockImplementation(async () => {
        t += 10;
      }),
      getRunningModel: vi.fn().mockResolvedValue("whatever"),
      now: () => t,
      nowIso: () => "ts",
    };
  }

  it("produces models.length × repeats samples", async () => {
    const deps = fakeDeps();
    const samples = await runMatrix({ models: ["a", "b", "c"], repeats: 2, deps });
    expect(samples).toHaveLength(6);
  });

  it("pass 1 uses the given order; pass 2 uses the order rotated by one", async () => {
    const deps = fakeDeps();
    const samples = await runMatrix({ models: ["a", "b", "c"], repeats: 2, deps });
    const pass1 = samples.filter((s) => s.pass === 1).map((s) => s.model);
    const pass2 = samples.filter((s) => s.pass === 2).map((s) => s.model);
    expect(pass1).toEqual(["a", "b", "c"]);
    expect(pass2).toEqual(["b", "c", "a"]);
  });

  it("runs strictly sequentially — chat call N+1 does not start until call N resolves", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const deps: MeasureDeps = {
      chat: vi.fn().mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      }),
      getRunningModel: vi.fn().mockResolvedValue("m"),
      now: () => Date.now(),
      nowIso: () => "ts",
    };
    await runMatrix({ models: ["a", "b"], repeats: 2, deps });
    expect(maxInFlight).toBe(1);
  });

  it("invokes onSample once per measured sample, in order", async () => {
    const deps = fakeDeps();
    const seen: string[] = [];
    await runMatrix({
      models: ["a", "b"],
      repeats: 1,
      deps,
      onSample: (s) => seen.push(s.model),
    });
    expect(seen).toEqual(["a", "b"]);
  });

  it("with repeats=1 (default), only the given order is used — no rotation happens", async () => {
    const deps = fakeDeps();
    const samples = await runMatrix({ models: ["x", "y", "z"], repeats: 1, deps });
    expect(samples.map((s) => s.model)).toEqual(["x", "y", "z"]);
  });
});

// ─── discoverModels (network seam — stubbed fetch, no real network) ─────────

describe("discoverModels", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns model ids from GET /v1/models", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: "mellum" }, { id: "gemma4" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const ids = await discoverModels("http://127.0.0.1:8091");
    expect(ids).toEqual(["mellum", "gemma4"]);
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8091/v1/models", expect.anything());
  });

  it("returns an empty array when data is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    );
    expect(await discoverModels("http://h")).toEqual([]);
  });

  it("throws on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) })
    );
    await expect(discoverModels("http://h")).rejects.toThrow(/HTTP 503/);
  });
});
