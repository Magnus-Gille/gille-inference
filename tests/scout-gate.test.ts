import { describe, it, expect } from "vitest";
import {
  evaluateScoutGate,
  plausibilityFlags,
  nameTellFlags,
  misconfigFlags,
  reviewQualityFlags,
  servingConfigFlags,
  sanitizeModelName,
  loadScoutGateConfig,
  DEFAULT_SCOUT_GATE_CONFIG,
} from "../src/homeserver/scout-gate.js";

// The actual model the Scout auto-promoted (issue #176).
const INCIDENT_ID = "yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF";
const INCIDENT_SCORES = { sql: 1.0, "code-review": 1.0, "reason-hard": 0.5, "code-implement": 0.9 };

describe("evaluateScoutGate — the #176 incident must not be auto-servable", () => {
  it("flags the benchmark-gamed model on BOTH plausibility and name", () => {
    const r = evaluateScoutGate({ id: INCIDENT_ID, scoresByTaskType: INCIDENT_SCORES });
    expect(r.autoServable).toBe(false);
    expect(r.flags.some((f) => f.includes("implausible-capability"))).toBe(true);
    expect(r.flags.some((f) => f.includes("name-gaming-tell"))).toBe(true);
  });

  it("passes a genuine, plainly-named model with realistic scores", () => {
    const r = evaluateScoutGate({
      id: "Qwen/Qwen3-Coder-Next-80B-Instruct",
      scoresByTaskType: { sql: 1.0, "code-review": 0.0, "reason-hard": 0.5, "code-implement": 0.8 },
    });
    expect(r.autoServable).toBe(true);
    expect(r.flags).toEqual([]);
  });

  it("does not flag a legit MoE model whose name contains NxM notation", () => {
    const r = evaluateScoutGate({
      id: "mistralai/Mixtral-8x7B-Instruct-v0.1",
      scoresByTaskType: { sql: 0.5, "code-review": 0.0 },
    });
    expect(r.autoServable).toBe(true);
  });
});

describe("plausibilityFlags — perfect on multiple hard task types is the gaming signal", () => {
  it("flags perfection on >= 2 hard types", () => {
    expect(plausibilityFlags({ sql: 1.0, "code-review": 1.0 }).length).toBe(1);
  });

  it("does NOT flag a single lucky hard-type pass", () => {
    expect(plausibilityFlags({ sql: 1.0, "code-review": 0.0, "reason-hard": 0.0 })).toEqual([]);
  });

  it("does NOT flag when hard types are below the suspicious threshold", () => {
    expect(plausibilityFlags({ sql: 0.9, "code-review": 0.9, "reason-hard": 0.9 })).toEqual([]);
  });

  it("flags all three hard types perfect", () => {
    const f = plausibilityFlags({ sql: 1.0, "code-review": 1.0, "reason-hard": 1.0 });
    expect(f.length).toBe(1);
    expect(f[0]).toContain("reason-hard=1");
  });

  it("ignores non-hard task types entirely (perfect summarize/extract is fine)", () => {
    expect(plausibilityFlags({ summarize: 1.0, extract: 1.0, classify: 1.0 })).toEqual([]);
  });
});

describe("nameTellFlags — benchmark/marketing tells in the model name", () => {
  it("catches the incident's tells (fable, composer2.5, 3.5x, tau2)", () => {
    const f = nameTellFlags(INCIDENT_ID);
    expect(f.length).toBe(1);
    const tells = f[0]!.toLowerCase();
    expect(tells).toContain("fable");
    expect(tells).toContain("composer"); // must match "composer2.5" despite the trailing digit
    expect(tells).toContain("3.5x");
    expect(tells).toContain("tau2");
  });

  it("catches named benchmarks", () => {
    expect(nameTellFlags("someorg/tiny-swebench-tuned").length).toBe(1);
    expect(nameTellFlags("someorg/model-gsm8k-distill").length).toBe(1);
  });

  it("does not flag clean, ordinary model names", () => {
    expect(nameTellFlags("Qwen/Qwen3-Coder-Next-80B-Instruct")).toEqual([]);
    expect(nameTellFlags("google/gemma-4-26B-it")).toEqual([]);
    expect(nameTellFlags("mistralai/Mixtral-8x7B-Instruct-v0.1")).toEqual([]); // MoE notation not a multiplier
  });
});

describe("sanitizeModelName — served id never advertises a benchmark", () => {
  it("strips gaming tells from the incident name", () => {
    const s = sanitizeModelName("gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF").toLowerCase();
    expect(s).not.toContain("fable");
    expect(s).not.toContain("composer");
    expect(s).not.toContain("tau2");
    expect(s).not.toContain("3.5x");
    expect(s).toContain("gemma"); // keeps the real base
  });

  it("leaves a clean name essentially unchanged", () => {
    expect(sanitizeModelName("Qwen3-Coder-Next-80B-Instruct")).toContain("Qwen3-Coder-Next-80B-Instruct".split("-")[0]!);
  });

  it("returns empty when the name is all tells (caller maps empty → neutral key, never the raw tells)", () => {
    expect(sanitizeModelName("tau2-composer")).toBe("");
  });
});

describe("misconfigFlags — high probe error rate blocks auto-serve (#158)", () => {
  it("flags a candidate whose error rate meets the threshold (default 0.2)", () => {
    const f = misconfigFlags({ error: 5, totalRuns: 20 }); // 25%
    expect(f.length).toBe(1);
    expect(f[0]).toMatch(/high-error-rate/);
  });

  it("does not flag a low error rate", () => {
    expect(misconfigFlags({ error: 1, totalRuns: 20 })).toEqual([]); // 5% < 20%
  });

  it("does not flag zero runs (no division by zero, no spurious flag)", () => {
    expect(misconfigFlags({ error: 0, totalRuns: 0 })).toEqual([]);
  });

  it("respects a custom threshold", () => {
    const cfg = { ...DEFAULT_SCOUT_GATE_CONFIG, maxErrorRate: 0.5 };
    expect(misconfigFlags({ error: 5, totalRuns: 20 }, cfg)).toEqual([]); // 25% < 50%
    expect(misconfigFlags({ error: 12, totalRuns: 20 }, cfg).length).toBe(1); // 60% ≥ 50%
  });

  it("flags empty-output and length-truncation rates independently", () => {
    const f = misconfigFlags({ error: 0, totalRuns: 20, emptyOutputs: 4, truncations: 5 });
    expect(f).toHaveLength(2);
    expect(f[0]).toMatch(/high-empty-output-rate/);
    expect(f[1]).toMatch(/high-truncation-rate/);
  });

  it("does not flag low empty/truncation rates", () => {
    expect(misconfigFlags({ error: 0, totalRuns: 20, emptyOutputs: 1, truncations: 2 })).toEqual([]);
  });
});

describe("reviewQualityFlags — weak review evidence blocks auto-serve (#158)", () => {
  it("keeps the three ground-truth dimensions independent", () => {
    const flags = reviewQualityFlags({ recall: 0, precision: 0.4, cleanConfabulationRate: 0.5 });
    expect(flags.some((f) => f.includes("low-review-recall"))).toBe(true);
    expect(flags.some((f) => f.includes("low-review-precision"))).toBe(true);
    expect(flags.some((f) => f.includes("high-review-clean-confabulation"))).toBe(true);
  });

  it("accepts the strong local-review evidence band from the motivating sweep", () => {
    expect(reviewQualityFlags({ recall: 0.824, precision: 0.933, cleanConfabulationRate: 1 / 6 })).toEqual([]);
  });
});

describe("loadScoutGateConfig — env overrides", () => {
  it("uses defaults with no env", () => {
    const c = loadScoutGateConfig({});
    expect(c.hardTaskTypes).toEqual(DEFAULT_SCOUT_GATE_CONFIG.hardTaskTypes);
    expect(c.suspiciousScore).toBe(0.95);
    expect(c.minSuspiciousHardTypes).toBe(2);
    expect(c.maxErrorRate).toBe(0.2);
    expect(c.maxEmptyOutputRate).toBe(0.2);
    expect(c.maxTruncationRate).toBe(0.2);
    expect(c.minReviewRecall).toBe(0.5);
    expect(c.minReviewPrecision).toBe(0.75);
    expect(c.maxReviewCleanConfabulationRate).toBe(0.25);
  });

  it("validates the maxErrorRate env override (invalid → default)", () => {
    expect(loadScoutGateConfig({ SCOUT_MAX_ERROR_RATE: "0.3" }).maxErrorRate).toBe(0.3);
    expect(loadScoutGateConfig({ SCOUT_MAX_ERROR_RATE: "nope" }).maxErrorRate).toBe(0.2);
    expect(loadScoutGateConfig({ SCOUT_MAX_ERROR_RATE: "0" }).maxErrorRate).toBe(0.2); // must not disable-by-flooding
  });

  it("loads validated empty-output and truncation thresholds", () => {
    const c = loadScoutGateConfig({
      SCOUT_MAX_EMPTY_OUTPUT_RATE: "0.1",
      SCOUT_MAX_TRUNCATION_RATE: "0.3",
    });
    expect(c.maxEmptyOutputRate).toBe(0.1);
    expect(c.maxTruncationRate).toBe(0.3);
    expect(loadScoutGateConfig({ SCOUT_MAX_EMPTY_OUTPUT_RATE: "0" }).maxEmptyOutputRate).toBe(0.2);
  });

  it("loads validated review-quality thresholds", () => {
    const c = loadScoutGateConfig({
      SCOUT_MIN_REVIEW_RECALL: "0.6",
      SCOUT_MIN_REVIEW_PRECISION: "0.8",
      SCOUT_MAX_REVIEW_CLEAN_CONFABULATION_RATE: "0",
    });
    expect(c.minReviewRecall).toBe(0.6);
    expect(c.minReviewPrecision).toBe(0.8);
    expect(c.maxReviewCleanConfabulationRate).toBe(0);
    expect(loadScoutGateConfig({ SCOUT_MIN_REVIEW_RECALL: "0" }).minReviewRecall).toBe(0.5);
  });

  it("parses overrides", () => {
    const c = loadScoutGateConfig({
      SCOUT_HARD_TASK_TYPES: "sql, code-review",
      SCOUT_SUSPICIOUS_SCORE: "0.9",
      SCOUT_SUSPICIOUS_MIN_HARD_TYPES: "1",
    });
    expect(c.hardTaskTypes).toEqual(["sql", "code-review"]);
    expect(c.suspiciousScore).toBe(0.9);
    expect(c.minSuspiciousHardTypes).toBe(1);
  });

  it("falls back to defaults on invalid/out-of-range env — never silently disables or floods the gate", () => {
    // NaN threshold would never trip; minHardTypes=0 would flag everything — both must be rejected.
    const bad = loadScoutGateConfig({ SCOUT_SUSPICIOUS_SCORE: "not-a-number", SCOUT_SUSPICIOUS_MIN_HARD_TYPES: "0" });
    expect(bad.suspiciousScore).toBe(DEFAULT_SCOUT_GATE_CONFIG.suspiciousScore);
    expect(bad.minSuspiciousHardTypes).toBe(DEFAULT_SCOUT_GATE_CONFIG.minSuspiciousHardTypes);
    // out of (0,1] and beyond hardTaskTypes.length also fall back
    expect(loadScoutGateConfig({ SCOUT_SUSPICIOUS_SCORE: "1.5" }).suspiciousScore).toBe(DEFAULT_SCOUT_GATE_CONFIG.suspiciousScore);
    expect(loadScoutGateConfig({ SCOUT_SUSPICIOUS_SCORE: "0" }).suspiciousScore).toBe(DEFAULT_SCOUT_GATE_CONFIG.suspiciousScore);
    expect(loadScoutGateConfig({ SCOUT_SUSPICIOUS_MIN_HARD_TYPES: "5" }).minSuspiciousHardTypes).toBe(
      DEFAULT_SCOUT_GATE_CONFIG.minSuspiciousHardTypes
    );
  });
});

describe("servingConfigFlags — a row must record what serving config actually produced it (#12)", () => {
  it("flags a row with no evalServingConfig at all (legacy/hand-written row)", () => {
    const f = servingConfigFlags({});
    expect(f).toHaveLength(1);
    expect(f[0]).toMatch(/missing-serving-config/);
  });

  it("does not flag a row with a well-formed evalServingConfig", () => {
    expect(servingConfigFlags({ evalServingConfig: { ctx: 8192, repeats: 1, ngl: 99, flashAttn: "on" } })).toEqual(
      []
    );
    // ngl/flashAttn are optional extras — ctx+repeats is the load-bearing pair.
    expect(servingConfigFlags({ evalServingConfig: { ctx: 8192, repeats: 1 } })).toEqual([]);
  });

  it("flags a malformed evalServingConfig (non-finite/zero/negative ctx or repeats)", () => {
    expect(servingConfigFlags({ evalServingConfig: { ctx: 0, repeats: 1 } }).length).toBe(1);
    expect(servingConfigFlags({ evalServingConfig: { ctx: -8192, repeats: 1 } }).length).toBe(1);
    expect(servingConfigFlags({ evalServingConfig: { ctx: Number.NaN, repeats: 1 } }).length).toBe(1);
    expect(servingConfigFlags({ evalServingConfig: { ctx: 8192, repeats: 0 } }).length).toBe(1);
  });
});
