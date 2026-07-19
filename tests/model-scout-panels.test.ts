/**
 * Tests for the Job-A publish + promote helpers (pure functions only — no network/fs).
 *   buildEvalsTablePanel / buildEvaluatedTimeseries  (scripts/post-model-scout-panels.ts)
 *   deriveModelKey / existingKeys / buildConfigEntry  (scripts/promote-model.ts)
 */
import { describe, it, expect } from "vitest";
import { buildEvalsTablePanel, buildEvaluatedTimeseries } from "../scripts/post-model-scout-panels.js";
import {
  deriveModelKey,
  existingKeys,
  buildConfigEntry,
  modelsIsLastTopLevel,
  partitionServableWinners,
} from "../scripts/promote-model.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";
import type { RegistryEntry } from "../src/homeserver/scout-types.js";

const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  id: "org/Model-A",
  quant: "Q4_K_M",
  sizeGB: 20,
  evaluatedAt: "2026-06-29T04:00:00.000Z",
  verdict: "interesting",
  passRate: 0.5,
  avgTokPerSec: 40,
  scoresByTaskType: {},
  served: false,
  ...over,
});

const strongReviewEvidence = {
  codeReviewSeededBugs: 34,
  codeReviewTruePositives: 28,
  codeReviewReportedFindings: 30,
  codeReviewCleanControls: 6,
  codeReviewConfabulatedCleanControls: 1,
  codeReviewRecall: 28 / 34,
  codeReviewPrecision: 28 / 30,
  codeReviewCleanConfabulationRate: 1 / 6,
};

describe("buildEvalsTablePanel", () => {
  it("emits a valid table panel with ids matching Heimdall's pattern", () => {
    const p = buildEvalsTablePanel([entry({})]);
    expect(p.kind).toBe("table");
    expect(p.service).toBe("m5-inference");
    expect(PANEL_ID_RE.test(p.service)).toBe(true);
    expect(PANEL_ID_RE.test(p.panel)).toBe(true);
  });

  it("keeps the LATEST entry per model, newest first", () => {
    const rows = buildEvalsTablePanel([
      entry({ id: "org/A", evaluatedAt: "2026-06-20T00:00:00.000Z", verdict: "skip" }),
      entry({ id: "org/A", evaluatedAt: "2026-06-29T00:00:00.000Z", verdict: "winner" }),
      entry({ id: "org/B", evaluatedAt: "2026-06-25T00:00:00.000Z" }),
    ]).rows;
    expect(rows.length).toBe(2); // A deduped to its latest
    expect(rows[0]!["model"]).toBe("org/A"); // 06-29 newest
    expect(rows[0]!["verdict"]).toBe("winner");
    expect(rows[1]!["model"]).toBe("org/B");
  });

  it("formats pass% as a percent and marks served", () => {
    const rows = buildEvalsTablePanel([entry({ passRate: 0.873, served: true })]).rows;
    expect(rows[0]!["pass%"]).toBe(87.3);
    expect(rows[0]!["served"]).toBe("✓");
  });

  it("reports review quality and misconfiguration diagnostics separately", () => {
    const row = buildEvalsTablePanel([entry({
      codeReviewRecall: 0.824,
      codeReviewPrecision: 0.933,
      codeReviewCleanConfabulationRate: 1 / 6,
      probeErrorRate: 0.05,
      probeEmptyOutputRate: 0.1,
      probeTruncationRate: 0.2,
      probeFinishReasons: { stop: 8, length: 2 },
    })]).rows[0]!;
    expect(row["review recall%"]).toBe(82.4);
    expect(row["review precision%"]).toBe(93.3);
    expect(row["clean confab%"]).toBe(16.7);
    expect(row["error%"]).toBe(5);
    expect(row["empty%"]).toBe(10);
    expect(row["trunc%"]).toBe(20);
    expect(row["finish reasons"]).toBe("length:2, stop:8");
  });

  it("honors the row limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => entry({ id: `org/M${i}`, evaluatedAt: `2026-06-${(i % 28) + 1}`.padEnd(10, "0") }));
    expect(buildEvalsTablePanel(many, 5).rows.length).toBe(5);
  });
});

describe("buildEvaluatedTimeseries", () => {
  it("counts DISTINCT models per day, ordered by date", () => {
    const p = buildEvaluatedTimeseries([
      entry({ id: "org/A", evaluatedAt: "2026-06-22T01:00:00Z" }),
      entry({ id: "org/B", evaluatedAt: "2026-06-22T02:00:00Z" }),
      entry({ id: "org/A", evaluatedAt: "2026-06-22T03:00:00Z" }), // dup id same day → not double-counted
      entry({ id: "org/C", evaluatedAt: "2026-06-29T01:00:00Z" }),
    ]);
    expect(p.points).toEqual([
      { t: "2026-06-22", y: 2 },
      { t: "2026-06-29", y: 1 },
    ]);
    expect(p.summary?.latest).toBe(1);
  });
});

describe("promote-model pure helpers", () => {
  it("deriveModelKey slugifies and de-collides", () => {
    const taken = new Set<string>(["mellum"]);
    expect(deriveModelKey("zai-org/GLM-5.2", taken)).toBe("glm-5-2");
    const k1 = deriveModelKey("x/Mellum", taken); // base 'mellum' is taken
    expect(k1).toBe("mellum-2");
  });

  it("deriveModelKey strips gaming tells so the served id never advertises a benchmark (#176)", () => {
    const key = deriveModelKey("yuxinlu1/gemma-4-12B-agentic-fable5-composer2.5-v2-3.5x-tau2-GGUF", new Set());
    expect(key).not.toMatch(/fable|composer|tau2/); // gaming/benchmark tells stripped
    expect(key).not.toMatch(/3-5x/); // the "3.5x" multiplier claim
    expect(key).toContain("gemma-4-12b");
  });

  it("deriveModelKey yields the neutral 'model' key for an all-tell name (#176)", () => {
    expect(deriveModelKey("org/tau2-composer", new Set())).toBe("model");
  });

  it("partitionServableWinners holds gate-flagged winners back from auto-serve (#176)", () => {
    const clean = { id: "org/clean", scoresByTaskType: { sql: 0.5 }, gateFlags: undefined, ...strongReviewEvidence };
    const flagged = { id: "org/gamed", scoresByTaskType: { sql: 0.5 }, gateFlags: ["implausible-capability: x"] };
    const { servable, gated } = partitionServableWinners([clean, flagged]);
    expect(servable).toEqual([clean]);
    expect(gated.map((g) => g.entry)).toEqual([flagged]);
    expect(gated[0]!.flags).toContain("implausible-capability: x");
  });

  it("partitionServableWinners RECOMPUTES the gate — an incident-shaped winner with NO persisted gateFlags is still held back (#176)", () => {
    // legacy / other-writer row: winner-shaped, gamed scores + name, gateFlags never precomputed
    const legacy = { id: "org/gemma-4-12B-tau2-3.5x", scoresByTaskType: { sql: 1.0, "code-review": 1.0 } };
    const { servable, gated } = partitionServableWinners([legacy]);
    expect(servable).toEqual([]);
    expect(gated).toHaveLength(1);
    expect(gated[0]!.flags.length).toBeGreaterThan(0);
  });

  it("partitionServableWinners RECOMPUTES the misconfig gate from persisted probe error counts (#158)", () => {
    // A writer/legacy row may have durable probe counts but no precomputed gateFlags. It must still
    // be held back at promote time, matching #176's recompute backstop for plausibility/name gates.
    const misconfigured = {
      id: "org/plain-model",
      scoresByTaskType: { sql: 0.5 },
      probeErrors: 5,
      probeTotalRuns: 20,
    };
    const { servable, gated } = partitionServableWinners([misconfigured]);
    expect(servable).toEqual([]);
    expect(gated).toHaveLength(1);
    expect(gated[0]!.flags.some((f) => f.includes("high-error-rate"))).toBe(true);
  });

  it("recomputes empty-output and truncation gates from durable diagnostics (#158)", () => {
    const starved = {
      id: "org/plain-model",
      scoresByTaskType: { sql: 0.5 },
      probeErrors: 0,
      probeTotalRuns: 20,
      probeEmptyOutputs: 5,
      probeTruncations: 4,
    };
    const { servable, gated } = partitionServableWinners([starved]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("high-empty-output-rate"))).toBe(true);
    expect(gated[0]!.flags.some((f) => f.includes("high-truncation-rate"))).toBe(true);
  });

  it("partitionServableWinners tolerates a malformed persisted gateFlags without throwing (#176)", () => {
    const bad = { id: "org/clean", scoresByTaskType: { sql: 0.5 }, gateFlags: "oops" as unknown as string[], ...strongReviewEvidence };
    expect(() => partitionServableWinners([bad])).not.toThrow();
    expect(partitionServableWinners([bad]).servable).toHaveLength(1); // non-array ignored, fresh eval clean
  });

  it("holds legacy winners with no #158 review evidence for manual review", () => {
    const legacy = { id: "org/legacy", scoresByTaskType: { sql: 0.5 } };
    const { servable, gated } = partitionServableWinners([legacy]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("missing-review-ground-truth"))).toBe(true);
  });

  it("recomputes review-quality gates from durable sufficient statistics", () => {
    const silentReviewer = {
      id: "org/silent-reviewer",
      scoresByTaskType: { sql: 0.5 },
      codeReviewSeededBugs: 34,
      codeReviewTruePositives: 0,
      codeReviewReportedFindings: 0,
      codeReviewCleanControls: 6,
      codeReviewConfabulatedCleanControls: 0,
    };
    const { servable, gated } = partitionServableWinners([silentReviewer]);
    expect(servable).toEqual([]);
    expect(gated[0]!.flags.some((f) => f.includes("low-review-recall"))).toBe(true);
    expect(gated[0]!.flags.some((f) => f.includes("low-review-precision"))).toBe(true);
  });

  it("existingKeys parses the config model map", () => {
    const cfg = `models:\n  "qwen35-a3b":\n    cmd: |\n      x\n    ttl: 1800\n  "mellum":\n    cmd: |\n      y\n    ttl: 1800\n`;
    expect(existingKeys(cfg)).toEqual(new Set(["qwen35-a3b", "mellum"]));
  });

  it("modelsIsLastTopLevel guards EOF-append safety", () => {
    const safe = `healthCheckTimeout: 300\nlogLevel: info\nmodels:\n  "a":\n    cmd: |\n      x\n    ttl: 1800\n`;
    expect(modelsIsLastTopLevel(safe)).toBe(true);
    const unsafe = safe + `aliases:\n  "b": "a"\n`; // a top-level key AFTER models:
    expect(modelsIsLastTopLevel(unsafe)).toBe(false);
    expect(modelsIsLastTopLevel("logLevel: info\n")).toBe(false); // no models: at all
  });

  it("buildConfigEntry matches the house format", () => {
    const block = buildConfigEntry("foo-9b", "/srv/models/foo.gguf", { ctx: 32768, fa: "on", bin: "/bin/llama-server" });
    expect(block).toContain(`  "foo-9b":`);
    expect(block).toContain("-m /srv/models/foo.gguf");
    expect(block).toContain("-ngl 99 -ub 512 -c 32768 --jinja -fa on");
    expect(block).toContain("ttl: 1800");
    // parseable back by existingKeys
    expect(existingKeys(block).has("foo-9b")).toBe(true);
  });
});
