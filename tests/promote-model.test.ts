/**
 * promote-model.test.ts — pure-function tests for the auto-serve promoter, plus a consumer-
 * contract test proving weekly-model-scout.ts's own row-builder (toEntry) and promote-model.ts's
 * own gate-recomputation (partitionServableWinners) compose correctly end to end (#12).
 *
 * Before this file, partitionServableWinners — the ONE place that decides whether a scout winner
 * is safe to auto-serve — had no dedicated test at all; only its constituent pure gate functions
 * (misconfigFlags/reviewQualityFlags/evaluateScoutGate) were tested in isolation. A hand-rolled
 * fixture there could silently diverge from what weekly-model-scout.ts actually writes to the
 * registry — exactly the "green local fixtures vs. production evaluator" gap #12 calls out.
 */
import { describe, it, expect } from "vitest";
import {
  deriveModelKey,
  existingKeys,
  modelsIsLastTopLevel,
  buildConfigEntry,
  partitionServableWinners,
} from "../scripts/promote-model.js";
import { toEntry } from "../scripts/weekly-model-scout.js";
import type { ProbeRunSummary, TaskTypeScore } from "../src/homeserver/scout-types.js";

// ── deriveModelKey ──────────────────────────────────────────────────────────────────

describe("deriveModelKey", () => {
  it("derives a safe, unique lowercase-kebab key from an HF id", () => {
    expect(deriveModelKey("Qwen/Qwen3-Coder-Next-80B-Instruct", new Set())).toBe(
      "qwen3-coder-next-80b-instruct"
    );
  });

  it("de-duplicates against already-taken keys", () => {
    const taken = new Set(["foo-9b"]);
    expect(deriveModelKey("org/Foo-9B", taken)).toBe("foo-9b-2");
  });

  it("strips gaming/marketing tell tokens (#176) before deriving the key", () => {
    const key = deriveModelKey(
      "yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF",
      new Set()
    );
    expect(key).not.toContain("fable");
    expect(key).not.toContain("composer");
    expect(key).not.toContain("tau2");
    expect(key).not.toContain("3-5x");
  });
});

// ── existingKeys ────────────────────────────────────────────────────────────────────

describe("existingKeys", () => {
  it("extracts top-level 2-space-indented quoted keys under models:", () => {
    const cfg = 'models:\n  "foo-9b":\n    ttl: 1800\n  "bar-7b":\n    ttl: 1800\n';
    expect(existingKeys(cfg)).toEqual(new Set(["foo-9b", "bar-7b"]));
  });

  it("returns an empty set for a config with no model entries", () => {
    expect(existingKeys("models:\n").size).toBe(0);
  });
});

// ── modelsIsLastTopLevel ────────────────────────────────────────────────────────────

describe("modelsIsLastTopLevel", () => {
  it("is true when models: is the final top-level key", () => {
    expect(modelsIsLastTopLevel('groups:\n  x: 1\nmodels:\n  "a":\n')).toBe(true);
  });

  it("is false when another top-level key follows models:", () => {
    expect(modelsIsLastTopLevel('models:\n  "a":\naliases:\n  b: a\n')).toBe(false);
  });

  it("is false when models: is absent", () => {
    expect(modelsIsLastTopLevel("groups:\n  x: 1\n")).toBe(false);
  });
});

// ── buildConfigEntry ────────────────────────────────────────────────────────────────

describe("buildConfigEntry", () => {
  it("renders a llama-swap model block with the given key/path/opts", () => {
    const block = buildConfigEntry("foo-9b", "/srv/models/foo/foo.gguf", {
      ctx: 32768,
      fa: "on",
      bin: "/opt/llama.cpp/build/bin/llama-server",
    });
    expect(block).toContain('"foo-9b":');
    expect(block).toContain("-m /srv/models/foo/foo.gguf");
    expect(block).toContain("-c 32768");
    expect(block).toContain("-fa on");
    expect(block).toContain("ttl: 1800");
  });
});

// ── partitionServableWinners ─────────────────────────────────────────────────────────

const CLEAN_SERVING_CONFIG = { ctx: 8192, repeats: 1, ngl: 99, flashAttn: "on" };

function baseWinner(overrides: Record<string, unknown> = {}) {
  return {
    id: "Qwen/Qwen3-Coder-Next-80B-Instruct",
    scoresByTaskType: { sql: 0.8, "code-review": 0.7, "reason-hard": 0.6, "code-implement": 0.8 },
    probeErrors: 0,
    probeTotalRuns: 20,
    probeEmptyOutputs: 0,
    probeTruncations: 0,
    codeReviewSeededBugs: 20,
    codeReviewTruePositives: 16,
    codeReviewReportedFindings: 18,
    codeReviewCleanControls: 6,
    codeReviewConfabulatedCleanControls: 1,
    evalServingConfig: CLEAN_SERVING_CONFIG,
    ...overrides,
  };
}

describe("partitionServableWinners", () => {
  it("serves a clean winner with strong diagnostics, review evidence, and a recorded serving config", () => {
    const { servable, gated } = partitionServableWinners([baseWinner()]);
    expect(gated).toEqual([]);
    expect(servable).toHaveLength(1);
  });

  it("holds a winner with NO seeded-review ground truth — formatting alone must not earn trust (#12 core AC)", () => {
    const noReview = baseWinner({
      codeReviewSeededBugs: undefined,
      codeReviewTruePositives: undefined,
      codeReviewReportedFindings: undefined,
      codeReviewCleanControls: undefined,
      codeReviewConfabulatedCleanControls: undefined,
    });
    const { servable, gated } = partitionServableWinners([noReview]);
    expect(servable).toEqual([]);
    expect(gated).toHaveLength(1);
    expect(gated[0]!.flags.some((f) => f.includes("missing-review-ground-truth"))).toBe(true);
  });

  it("holds a winner that found ZERO seeded bugs despite passing everything else on format", () => {
    const zeroRecall = baseWinner({
      codeReviewTruePositives: 0,
      codeReviewReportedFindings: 0, // reported nothing, so precision/format checks alone can't rescue it
    });
    const { servable, gated } = partitionServableWinners([zeroRecall]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("low-review-recall"))).toBe(true);
  });

  it("holds a winner missing its exact eval serving configuration (#12 incompatible-serving-config gate)", () => {
    const noServingConfig = baseWinner({ evalServingConfig: undefined });
    const { servable, gated } = partitionServableWinners([noServingConfig]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("missing-serving-config"))).toBe(true);
  });

  it("holds a winner with an excessive probe error rate (#158)", () => {
    const errorProne = baseWinner({ probeErrors: 8, probeTotalRuns: 20 }); // 40%
    const { servable, gated } = partitionServableWinners([errorProne]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("high-error-rate"))).toBe(true);
  });

  it("holds the #176 benchmark-gamed incident shape even with clean diagnostics otherwise", () => {
    const gamed = baseWinner({
      id: "yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF",
      scoresByTaskType: { sql: 1.0, "code-review": 1.0, "reason-hard": 0.5 },
    });
    const { servable, gated } = partitionServableWinners([gamed]);
    expect(servable).toEqual([]);
    expect(
      gated[0]!.flags.some((f) => f.includes("implausible-capability") || f.includes("name-gaming-tell"))
    ).toBe(true);
  });

  // #12 (M5-assisted review, see PR description): a row could carry non-finite / out-of-range
  // recall/precision/confabulation numbers (from counts producing NaN via a zero denominator edge
  // case, or a hand-written/corrupted rate row bypassing the registry's isRegistryEntry guard).
  // These must be treated as untrustworthy, not silently compared with `<`/`>` (where NaN
  // comparisons are always false and could let a broken row slip through as "clean").
  it("holds a winner whose persisted review RATES are non-finite (NaN) rather than trusting a false comparison", () => {
    const nanRates = baseWinner({
      codeReviewSeededBugs: undefined,
      codeReviewTruePositives: undefined,
      codeReviewReportedFindings: undefined,
      codeReviewCleanControls: undefined,
      codeReviewConfabulatedCleanControls: undefined,
      codeReviewRecall: Number.NaN,
      codeReviewPrecision: 0.9,
      codeReviewCleanConfabulationRate: 0,
    });
    const { servable, gated } = partitionServableWinners([nanRates]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("invalid-review-ground-truth"))).toBe(true);
  });

  it("holds a winner whose persisted review rate is out of the valid [0,1] range", () => {
    const outOfRange = baseWinner({
      codeReviewSeededBugs: undefined,
      codeReviewTruePositives: undefined,
      codeReviewReportedFindings: undefined,
      codeReviewCleanControls: undefined,
      codeReviewConfabulatedCleanControls: undefined,
      codeReviewRecall: 0.9,
      codeReviewPrecision: 1.4, // out of range
      codeReviewCleanConfabulationRate: 0,
    });
    const { servable, gated } = partitionServableWinners([outOfRange]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("invalid-review-ground-truth"))).toBe(true);
  });

  it("recomputes fresh rather than trusting a stale persisted gateFlags: [] on a bad row", () => {
    // A row that (incorrectly, e.g. from an older writer version) persisted an empty gateFlags
    // despite having zero review evidence must still be held — never trust persisted flags alone.
    const staleClean = baseWinner({
      gateFlags: [],
      codeReviewSeededBugs: undefined,
      codeReviewTruePositives: undefined,
      codeReviewReportedFindings: undefined,
      codeReviewCleanControls: undefined,
      codeReviewConfabulatedCleanControls: undefined,
    });
    const { servable, gated } = partitionServableWinners([staleClean]);
    expect(servable).toEqual([]);
    expect(gated).toHaveLength(1);
  });
});

// ── Consumer-contract: weekly-model-scout's toEntry() feeds directly into promote-model's ─────
// partitionServableWinners() — proving the two modules' REAL code compose, not a hand-authored
// stand-in fixture that could silently diverge from what the scout actually writes (#12).

function taskTypeScore(taskType: string, passRate: number): TaskTypeScore {
  return {
    taskType,
    attempts: 5,
    passes: Math.round(passRate * 5),
    partials: 0,
    fails: 5 - Math.round(passRate * 5),
    errors: 0,
    passRate,
  };
}

function cleanSummary(overrides: Partial<ProbeRunSummary> = {}): ProbeRunSummary {
  return {
    model: "Qwen/Qwen3-Coder-Next-80B-Instruct",
    endpoint: "http://127.0.0.1:9099/v1",
    totalRuns: 20,
    pass: 16,
    partial: 2,
    fail: 2,
    error: 0,
    passRate: 0.8,
    avgTokPerSec: 40,
    emptyOutputs: 0,
    truncations: 0,
    finishReasons: { stop: 20 },
    byTaskType: [
      taskTypeScore("sql", 0.8),
      taskTypeScore("code-review", 0.7),
      taskTypeScore("reason-hard", 0.6),
    ],
    reviewMetrics: {
      seededBugs: 20,
      truePositives: 16,
      reportedFindings: 18,
      cleanControls: 6,
      confabulatedCleanControls: 1,
      recall: 16 / 20,
      precision: 16 / 18,
      cleanConfabulationRate: 1 / 6,
    },
    results: [],
    ...overrides,
  };
}

const CLEAN_CANDIDATE = {
  id: "Qwen/Qwen3-Coder-Next-80B-Instruct",
  slug: "qwen3-coder-next-80b-instruct",
  trendingScore: 12,
  downloads: 1000,
  likes: 10,
  quant: "Q4_K_M",
  sizeGB: 45,
  parts: ["Qwen3-Coder-Next-80B-Instruct-Q4_K_M.gguf"],
  localNames: ["qwen3-coder-next-80b-instruct-Q4_K_M.gguf"],
  sharded: false,
};

describe("consumer contract: weekly-model-scout.toEntry() -> promote-model.partitionServableWinners()", () => {
  it("a real, strong toEntry() row is servable through the real recomputation path", () => {
    const entry = toEntry(CLEAN_CANDIDATE, "winner", cleanSummary());
    expect(entry.gateFlags ?? []).toEqual([]); // the scout's own gate already agrees at write time
    expect(entry.probeBatteryVersion).toBeTruthy();
    expect(entry.corpusFingerprint).toBeTruthy();
    expect(entry.evalServingConfig).toBeTruthy();

    const { servable, gated } = partitionServableWinners([entry]);
    expect(gated).toEqual([]);
    expect(servable).toHaveLength(1);
  });

  it("a real toEntry() row with NO review lane executed (reviewRuns=0) is held, not auto-served", () => {
    // summarize() omits `reviewMetrics` entirely when no probe reported review metrics — this
    // reproduces that real shape rather than hand-omitting the field in a fixture.
    const { reviewMetrics: _drop, ...noReviewSummary } = cleanSummary();
    const entry = toEntry(CLEAN_CANDIDATE, "winner", noReviewSummary as ProbeRunSummary);
    expect(entry.codeReviewSeededBugs).toBeUndefined();

    const { servable, gated } = partitionServableWinners([entry]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("missing-review-ground-truth"))).toBe(true);
  });

  it("a real toEntry() row that found zero seeded bugs is held even though the format/error/output lanes are clean", () => {
    const zeroRecallSummary = cleanSummary({
      reviewMetrics: {
        seededBugs: 20,
        truePositives: 0,
        reportedFindings: 0,
        cleanControls: 6,
        confabulatedCleanControls: 0,
        recall: 0,
        precision: 0,
        cleanConfabulationRate: 0,
      },
    });
    const entry = toEntry(CLEAN_CANDIDATE, "winner", zeroRecallSummary);
    expect(entry.codeReviewRecall).toBe(0);

    const { servable, gated } = partitionServableWinners([entry]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("low-review-recall"))).toBe(true);
  });

  it("a real toEntry() row with an excessive error rate is held via the SAME misconfigFlags path the scout used", () => {
    const errorSummary = cleanSummary({ error: 8, totalRuns: 20, pass: 8, partial: 2, fail: 2 });
    const entry = toEntry(CLEAN_CANDIDATE, "winner", errorSummary);
    // the scout itself already flagged this at write time
    expect(entry.gateFlags?.some((f) => f.includes("high-error-rate"))).toBe(true);

    const { servable, gated } = partitionServableWinners([entry]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("high-error-rate"))).toBe(true);
  });
});
