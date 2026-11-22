/**
 * Effective sampling is explicit and recorded (evals reproducibility).
 *
 * Before: runLmStudioInference silently rewrote temperature <= 0 to 0.6 and sent no seed, so a run
 * configured as "temperature 0" actually ran unseeded at 0.6 and no record said so. These tests pin:
 *   - the floor is still the default, but is reported (`temperatureFloorApplied`) and can be disabled;
 *   - an explicit seed is forwarded to LM Studio / Ollama / llama-server and recorded;
 *   - run-batch rows, probe results and ledger rows store what was SENT, not what was requested.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveEffectiveSampling,
  isValidSeed,
  offsetSeed,
  MAX_SEED,
  DEFAULT_LOCAL_TEMPERATURE_FLOOR,
  type EffectiveSampling,
} from "../src/runner/sampling.js";

const LMSTUDIO_DEFAULTS = {
  temperature: 0,
  topP: 0.95,
  topK: 20,
  temperatureFloor: DEFAULT_LOCAL_TEMPERATURE_FLOOR,
} as const;

describe("resolveEffectiveSampling", () => {
  it("applies the default floor to a requested 0 and says so", () => {
    expect(resolveEffectiveSampling({ temperature: 0 }, LMSTUDIO_DEFAULTS)).toEqual({
      requestedTemperature: 0,
      temperature: 0.6,
      temperatureFloorApplied: true,
      seed: null,
      topP: 0.95,
      topK: 20,
      minP: null,
    });
  });

  it("sends literal 0 when the floor is disabled", () => {
    const s = resolveEffectiveSampling({ temperature: 0, temperatureFloor: false }, LMSTUDIO_DEFAULTS);
    expect(s.temperature).toBe(0);
    expect(s.temperatureFloorApplied).toBe(false);
  });

  it("leaves a positive temperature alone and passes the seed through", () => {
    const s = resolveEffectiveSampling({ temperature: 1, seed: 42, minP: 0 }, LMSTUDIO_DEFAULTS);
    expect(s).toMatchObject({ requestedTemperature: 1, temperature: 1, temperatureFloorApplied: false, seed: 42, minP: 0 });
  });

  it("treats undefined spread fields as unset (resolveLocalSampling output)", () => {
    const s = resolveEffectiveSampling(
      { temperature: 0, topP: undefined, topK: undefined, minP: undefined },
      LMSTUDIO_DEFAULTS
    );
    expect(s).toMatchObject({ topP: 0.95, topK: 20, minP: null });
  });
});

describe("seed range", () => {
  it("excludes llama.cpp's random sentinel and wraps derived seeds", () => {
    expect(isValidSeed(MAX_SEED)).toBe(true);
    expect(isValidSeed(0xffffffff)).toBe(false);
    expect(isValidSeed(-1)).toBe(false);
    expect(offsetSeed(MAX_SEED, 1)).toBe(0);
    expect(offsetSeed(5, 2)).toBe(7);
  });
});

// ─── LM Studio client ─────────────────────────────────────────────────────────

function makeStream(text: string) {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
  })();
}

async function runLmStudio(opts: Record<string, unknown>, create = vi.fn().mockResolvedValue(makeStream("hi"))) {
  vi.doMock("openai", () => ({
    default: vi.fn().mockImplementation(function () {
      return { chat: { completions: { create } } };
    }),
  }));
  const { runLmStudioInference } = await import("../src/runner/lmstudio-client.js");
  const res = await runLmStudioInference("mellum", "p", opts);
  return { res, params: create.mock.calls[0]![0] as Record<string, unknown> };
}

describe("runLmStudioInference effective sampling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("still floors temperature 0 by default, but reports it on the result", async () => {
    const { res, params } = await runLmStudio({ temperature: 0 });
    expect(params["temperature"]).toBe(0.6);
    expect(params).not.toHaveProperty("seed");
    expect(res.sampling).toMatchObject({
      requestedTemperature: 0,
      temperature: 0.6,
      temperatureFloorApplied: true,
      seed: null,
    });
  });

  it("forwards an explicit seed and records it", async () => {
    const { res, params } = await runLmStudio({ temperature: 0, seed: 7 });
    expect(params["seed"]).toBe(7);
    expect(res.sampling?.seed).toBe(7);
  });

  it("sends literal 0 with temperatureFloor:false", async () => {
    const { res, params } = await runLmStudio({ temperature: 0, temperatureFloor: false, seed: 1 });
    expect(params["temperature"]).toBe(0);
    expect(res.sampling).toMatchObject({ temperature: 0, temperatureFloorApplied: false, seed: 1 });
  });

  it("records sampling on a failed call too", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const { res } = await runLmStudio({ temperature: 0, seed: 3 }, create);
    expect(res.ok).toBe(false);
    expect(res.sampling).toMatchObject({ temperature: 0.6, seed: 3 });
  });
});

// ─── run-batch rows ───────────────────────────────────────────────────────────

describe("runBatch records effective sampling per row", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function runLmStudioBatch(batchOpts: Record<string, unknown>) {
    const sampling: EffectiveSampling = {
      requestedTemperature: 0,
      temperature: 0.6,
      temperatureFloorApplied: true,
      seed: 1,
      topP: 0.95,
      topK: 20,
      minP: null,
    };
    const mockLm = vi.fn().mockResolvedValue({
      ok: true,
      response: "r",
      promptTokens: 1,
      completionTokens: 2,
      durationMs: 3,
      ttftMs: 1,
      tokensPerSecond: 1,
      provider: "local-ollama",
      sampling,
    });
    vi.doMock("../src/runner/openrouter-client.js", () => ({ runInference: vi.fn() }));
    vi.doMock("../src/runner/local-client.js", () => ({
      runLocalInference: vi.fn(),
      warmModel: vi.fn(),
      unloadModel: vi.fn(),
    }));
    vi.doMock("../src/runner/lmstudio-client.js", () => ({ runLmStudioInference: mockLm }));
    vi.doUnmock("../src/db.js");
    const { initDb } = await import("../src/db.js");
    const db = initDb(join(mkdtempSync(join(tmpdir(), "eff-sampling-")), "eval.db"));
    vi.doMock("../src/db.js", () => ({ getDb: () => db, initDb: () => db }));
    vi.resetModules();
    const { runBatch } = await import("../src/runner/run-batch.js");
    await runBatch({
      batchId: "b",
      modelIds: ["qwen/qwen3-14b"],
      taskIds: ["simple-001"],
      provider: "lmstudio",
      skipPreflight: true,
      ...batchOpts,
    });
    const row = db
      .prepare("SELECT requested_temperature, effective_temperature, seed, sampling_json FROM runs WHERE batch_id = 'b'")
      .get() as { requested_temperature: number; effective_temperature: number; seed: number; sampling_json: string };
    return { row, opts: mockLm.mock.calls[0]![2] as Record<string, unknown> };
  }

  it("sends seed 1 by default and stores requested vs effective temperature", async () => {
    const { row, opts } = await runLmStudioBatch({});
    expect(opts["seed"]).toBe(1);
    expect(row.requested_temperature).toBe(0);
    expect(row.effective_temperature).toBe(0.6);
    expect(row.seed).toBe(1);
    expect(JSON.parse(row.sampling_json)).toMatchObject({ temperatureFloorApplied: true });
  });

  it("sends no seed with seed:null and forwards temperatureFloor:false", async () => {
    const { opts } = await runLmStudioBatch({ seed: null, temperatureFloor: false });
    expect(opts).not.toHaveProperty("seed");
    expect(opts["temperatureFloor"]).toBe(false);
  });
});

// ─── probe runner ─────────────────────────────────────────────────────────────

describe("probe runner seeds and records sampling", () => {
  it("gives each repeat a distinct, reproducible seed and records it", async () => {
    const { runProbes } = await import("../src/homeserver/probe-runner.js");
    const seen: Array<number | undefined> = [];
    const summary = await runProbes({
      model: "vibethinker-3b",
      endpoint: "http://x/v1",
      probes: [{ id: "p", taskType: "t", prompt: "q", verifierName: "v", verifier: () => ({ outcome: "pass", score: 1 }) }],
      repeats: 2,
      seed: 10,
      chat: async (_m, probe) => {
        seen.push(probe.seed);
        return { output: "ok", latencyMs: 1, tokPerSec: null, promptTokens: null, completionTokens: null, reasoningChars: null };
      },
    });
    expect(seen).toEqual([10, 11]);
    expect(summary.results.map((r) => r.sampling)).toEqual([
      { temperature: 1, topP: 0.95, topK: 0, minP: 0, seed: 10 },
      { temperature: 1, topP: 0.95, topK: 0, minP: 0, seed: 11 },
    ]);
  });

  it("makeChatFn sends the seed in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { makeChatFn } = await import("../src/homeserver/probe-runner.js");
      await makeChatFn({ endpoint: "http://x/v1" })("mellum", {
        id: "p", taskType: "t", prompt: "q", verifierName: "v", seed: 5,
        verifier: () => ({ outcome: "pass", score: 1 }),
      });
      const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body).toMatchObject({ temperature: 0, seed: 5 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── ledger ───────────────────────────────────────────────────────────────────

describe("ledger stores effective sampling", () => {
  it("writes effective_sampling_json, and NULL when absent", async () => {
    vi.resetModules();
    vi.doUnmock("../src/db.js");
    const { initDb } = await import("../src/db.js");
    const db = initDb(join(mkdtempSync(join(tmpdir(), "eff-ledger-")), "t.db"));
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    const sampling: EffectiveSampling = {
      requestedTemperature: 0, temperature: 0.6, temperatureFloorApplied: true,
      seed: null, topP: 0.95, topK: 20, minP: null,
    };
    const withId = recordDelegation({ taskType: "t", modelId: "m", prompt: "x", outcome: "pass", effectiveSampling: sampling });
    const withoutId = recordDelegation({ taskType: "t", modelId: "m", prompt: "x", outcome: "pass" });
    const get = (id: string) =>
      (db.prepare("SELECT effective_sampling_json AS j FROM delegations WHERE id = ?").get(id) as { j: string | null }).j;
    expect(JSON.parse(get(withId)!)).toEqual(sampling);
    expect(get(withoutId)).toBeNull();
  });
});
