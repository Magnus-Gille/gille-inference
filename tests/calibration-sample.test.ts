/**
 * Stratified sample spec tests (issue #6). Pure — no DB — operates directly on the content-blind
 * `CalibrationSampleRow` shape ledger.ts's listCalibrationSampleRows() produces.
 */
import { describe, it, expect } from "vitest";
import type { CalibrationSampleRow } from "../src/homeserver/ledger.js";
import {
  promptSizeBucketOf,
  uncertaintyBandOf,
  predictedVerdictOf,
  verifierClassOf,
  stratumKeyOf,
  stratumKeyString,
  buildStratifiedSampleSpec,
  seededRand,
} from "../src/homeserver/calibration-sample.js";

let counter = 0;
function row(overrides: Partial<CalibrationSampleRow> = {}): CalibrationSampleRow {
  counter++;
  return {
    id: `row-${counter}`,
    ts: "2026-07-15T00:00:00.000Z",
    nodeId: "m5",
    taskType: "qa-factual",
    modelId: "gpt-oss-120b",
    outcome: "pass",
    verifier: "llm-judge:gpt-oss-120b",
    verifierKind: "truth-oriented",
    promptTokens: 500,
    source: "harvest",
    lane: "mcp-ask",
    evidenceIdentityHash: null,
    judgePolicy: "ctx-tools-parts-v1|ctx=24000",
    shadow: false,
    score: 0.9,
    ...overrides,
  };
}

describe("promptSizeBucketOf", () => {
  it.each([
    [null, "unknown"],
    [undefined, "unknown"],
    [-5, "unknown"],
    [0, "xs"],
    [199, "xs"],
    [200, "xs"],
    [201, "s"],
    [1000, "s"],
    [1001, "m"],
    [4000, "m"],
    [4001, "l"],
    [16000, "l"],
    [16001, "xl"],
    [1_000_000, "xl"],
  ] as const)("%s → %s", (input, expected) => {
    expect(promptSizeBucketOf(input as number | null)).toBe(expected);
  });
});

describe("uncertaintyBandOf", () => {
  it("confident-pass for a high score", () => {
    expect(uncertaintyBandOf({ outcome: "pass", score: 0.95 })).toBe("confident-pass");
  });
  it("confident-fail for a low score", () => {
    expect(uncertaintyBandOf({ outcome: "fail", score: 0.05 })).toBe("confident-fail");
  });
  it("uncertain near the pass boundary (0.7 ± 0.05)", () => {
    expect(uncertaintyBandOf({ outcome: "pass", score: 0.68 })).toBe("uncertain");
    expect(uncertaintyBandOf({ outcome: "pass", score: 0.72 })).toBe("uncertain");
  });
  it("uncertain near the fail boundary (0.3 ± 0.05)", () => {
    expect(uncertaintyBandOf({ outcome: "fail", score: 0.28 })).toBe("uncertain");
  });
  it("a partial verdict is ALWAYS uncertain, even mid-band", () => {
    expect(uncertaintyBandOf({ outcome: "partial", score: 0.5 })).toBe("uncertain");
  });
  it("falls back to outcome when score is null (non-judge evidence)", () => {
    expect(uncertaintyBandOf({ outcome: "pass", score: null })).toBe("confident-pass");
    expect(uncertaintyBandOf({ outcome: "fail", score: null })).toBe("confident-fail");
    expect(uncertaintyBandOf({ outcome: "error", score: null })).toBe("confident-fail");
    expect(uncertaintyBandOf({ outcome: "unverified", score: null })).toBe("uncertain");
  });
});

describe("predictedVerdictOf", () => {
  it("uses the outcome directly for a real (non-shadow) harvest row", () => {
    expect(predictedVerdictOf({ outcome: "pass", score: 0.95, source: "harvest" })).toBe("pass");
    expect(predictedVerdictOf({ outcome: "fail", score: 0.1, source: "harvest" })).toBe("fail");
  });

  it("recovers the intended verdict from SCORE for an unverified harvest-shadow row (content-blind — never reads notes)", () => {
    expect(predictedVerdictOf({ outcome: "unverified", score: 0.85, source: "harvest-shadow" })).toBe("pass");
    expect(predictedVerdictOf({ outcome: "unverified", score: 0.5, source: "harvest-shadow" })).toBe("partial");
    expect(predictedVerdictOf({ outcome: "unverified", score: 0.1, source: "harvest-shadow" })).toBe("fail");
  });

  it("returns null when neither outcome nor score yields a verdict", () => {
    expect(predictedVerdictOf({ outcome: "unverified", score: null, source: "probe" })).toBeNull();
    expect(predictedVerdictOf({ outcome: "error", score: null, source: "probe" })).toBeNull();
  });
});

describe("verifierClassOf", () => {
  it("classifies real and shadow judge verifiers as llm-judge", () => {
    expect(verifierClassOf("llm-judge:gpt-oss-120b")).toBe("llm-judge");
    expect(verifierClassOf("harvest-shadow:llm-judge:gpt-oss-120b")).toBe("llm-judge");
  });
  it("groups every mechanical-format verifier under one literal class", () => {
    expect(verifierClassOf("nonEmpty")).toBe("mechanical-format");
    expect(verifierClassOf("containsAll")).toBe("mechanical-format");
    expect(verifierClassOf("answerIs(foo)")).toBe("mechanical-format");
  });
  it("classifies an explicitly allowlisted truth-oriented verifier by base name", () => {
    expect(verifierClassOf("tsGate")).toBe("truth-oriented:tsGate");
    expect(verifierClassOf("sqlExec")).toBe("truth-oriented:sqlExec");
  });
  it("an UNKNOWN/unrecognised verifier name is 'unclassified', not silently trusted", () => {
    expect(verifierClassOf("predicate")).toBe("unclassified:predicate");
    expect(verifierClassOf("some-future-verifier")).toBe("unclassified:some-future-verifier");
  });
  it("null/empty/'none' verifier is ungraded", () => {
    expect(verifierClassOf(null)).toBe("ungraded");
    expect(verifierClassOf(undefined)).toBe("ungraded");
    expect(verifierClassOf("")).toBe("ungraded");
    expect(verifierClassOf("none")).toBe("ungraded");
  });
});

describe("stratumKeyOf / stratumKeyString", () => {
  it("is a deterministic function of the row's content-blind fields", () => {
    const r = row();
    expect(stratumKeyString(stratumKeyOf(r))).toBe(stratumKeyString(stratumKeyOf({ ...r, id: "different-id" })));
  });
  it("differs when any of the six AC-scoped dimensions differs (lane is NOT one of them — it is a separate metrics rollup, see calibration-metrics.ts's byLane)", () => {
    const base = stratumKeyString(stratumKeyOf(row({ taskType: "qa-factual" })));
    const diffType = stratumKeyString(stratumKeyOf(row({ taskType: "classify" })));
    const diffModel = stratumKeyString(stratumKeyOf(row({ modelId: "mellum" })));
    const diffSize = stratumKeyString(stratumKeyOf(row({ promptTokens: 20_000 })));
    const diffVerifierClass = stratumKeyString(stratumKeyOf(row({ verifier: "nonEmpty" })));
    const diffSurface = stratumKeyString(stratumKeyOf(row({ source: "probe" })));
    const diffUncertainty = stratumKeyString(stratumKeyOf(row({ outcome: "partial", score: 0.5 })));
    expect(diffType).not.toBe(base);
    expect(diffModel).not.toBe(base);
    expect(diffSize).not.toBe(base);
    expect(diffVerifierClass).not.toBe(base);
    expect(diffSurface).not.toBe(base);
    expect(diffUncertainty).not.toBe(base);
    // Lane is deliberately absent from the stratum key.
    const diffLane = stratumKeyString(stratumKeyOf(row({ lane: "chat" })));
    expect(diffLane).toBe(base);
  });
});

describe("buildStratifiedSampleSpec", () => {
  it("groups rows into strata and targets min(population, targetPerStratum) per stratum", () => {
    const rows = [
      ...Array.from({ length: 5 }, () => row({ taskType: "qa-factual" })),
      ...Array.from({ length: 100 }, () => row({ taskType: "classify" })),
    ];
    const spec = buildStratifiedSampleSpec(rows, { targetPerStratum: 40, rand: seededRand(1) });
    expect(spec.totalPopulation).toBe(105);
    const qaStratum = spec.strata.find((s) => s.key.taskType === "qa-factual")!;
    const classifyStratum = spec.strata.find((s) => s.key.taskType === "classify")!;
    expect(qaStratum.populationSize).toBe(5);
    expect(qaStratum.targetSize).toBe(5);
    expect(qaStratum.underPopulated).toBe(true);
    expect(classifyStratum.populationSize).toBe(100);
    expect(classifyStratum.targetSize).toBe(40);
    expect(classifyStratum.underPopulated).toBe(false);
    expect(spec.totalSelected).toBe(5 + 40);
    expect(spec.selectedRowIds).toHaveLength(spec.totalSelected);
  });

  it("selected ids are a subset of the input rows' ids, with no duplicates (sampling without replacement)", () => {
    const rows = Array.from({ length: 60 }, () => row());
    const spec = buildStratifiedSampleSpec(rows, { targetPerStratum: 20, rand: seededRand(7) });
    const inputIds = new Set(rows.map((r) => r.id));
    expect(new Set(spec.selectedRowIds).size).toBe(spec.selectedRowIds.length);
    for (const id of spec.selectedRowIds) expect(inputIds.has(id)).toBe(true);
  });

  it("is DETERMINISTIC for a fixed (rows, seed) pair — reproducibility (AC)", () => {
    const rows = Array.from({ length: 60 }, () => row());
    const a = buildStratifiedSampleSpec(rows, { targetPerStratum: 20, rand: seededRand(42) });
    const b = buildStratifiedSampleSpec(rows, { targetPerStratum: 20, rand: seededRand(42) });
    expect(a.selectedRowIds).toEqual(b.selectedRowIds);
  });

  it("a different seed can select a different sample from an over-populated stratum", () => {
    const rows = Array.from({ length: 60 }, () => row());
    const a = buildStratifiedSampleSpec(rows, { targetPerStratum: 10, rand: seededRand(1) });
    const b = buildStratifiedSampleSpec(rows, { targetPerStratum: 10, rand: seededRand(2) });
    expect(a.selectedRowIds).not.toEqual(b.selectedRowIds);
  });

  it("handles an empty population honestly (zero strata, zero selected — never fabricated)", () => {
    const spec = buildStratifiedSampleSpec([], { targetPerStratum: 40 });
    expect(spec.totalPopulation).toBe(0);
    expect(spec.totalSelected).toBe(0);
    expect(spec.strata).toEqual([]);
  });

  it("content-blindness: the sample spec's own type carries only row ids, never prompt content", () => {
    const rows = [row()];
    const spec = buildStratifiedSampleSpec(rows, { targetPerStratum: 40 });
    const serialized = JSON.stringify(spec);
    // The spec type has no field capable of holding raw task text or an excerpt/notes field — only
    // ids and structured, closed-vocabulary bucket labels (e.g. "promptSizeBucket": "xs").
    expect(serialized).not.toContain("promptExcerpt");
    expect(serialized).not.toContain("notes");
    expect(spec.selectedRowIds).toEqual([rows[0]!.id]);
  });
});
