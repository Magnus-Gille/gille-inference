import { describe, it, expect } from "vitest";
import {
  jaccard,
  disagreementScore,
  extractAnswer,
  auroc,
  offloadCurve,
  minFrontierForAccuracy,
} from "../scripts/cascade-gate-experiment.js";
import { ordinalAns } from "../scripts/hard-probes.js";

describe("ordinalAns verifier (Codex #4 — accept 2/2nd/second, reject 1st/first)", () => {
  const v = ordinalAns(2, ["second"]);
  const pass = (s: string) => expect(v(`ANSWER: ${s}`).outcome).toBe("pass");
  const fail = (s: string) => expect(v(`ANSWER: ${s}`).outcome).toBe("fail");
  it("accepts equivalent forms of '2nd'", () => {
    pass("2");
    pass("2nd");
    pass("second");
    pass("second place");
  });
  it("rejects the wrong-but-tempting '1st'/'first'", () => {
    fail("1st");
    fail("first");
    fail("1");
  });
});

describe("extractAnswer / answer-level disagreement", () => {
  it("extracts the value after the last ANSWER: tag", () => {
    expect(extractAnswer("Let me think... step 1... step 2.\nANSWER: 66")).toBe("66");
    expect(extractAnswer("no tag here, just text")).toBe("no tag here, just text");
  });
  it("two models that AGREE on the answer score 0 despite different reasoning (the fix)", () => {
    const a = "First I compute 8*12=96 then subtract 5*6=30 so 66.\nANSWER: 66";
    const b = "The tank gains 96 and loses 30. Net is sixty-six.\nANSWER: 66";
    expect(disagreementScore(a, b)).toBe(0);
  });
  it("different answers disagree even with similar reasoning", () => {
    expect(disagreementScore("...\nANSWER: 66", "...\nANSWER: 70")).toBeGreaterThan(0);
  });
});

describe("jaccard / disagreement", () => {
  it("identical strings → 1, disjoint → 0", () => {
    expect(jaccard("alice bob carol", "alice bob carol")).toBe(1);
    expect(jaccard("alice bob", "xray yankee")).toBe(0);
  });
  it("partial overlap is between 0 and 1", () => {
    const j = jaccard("alice bob carol", "alice bob dave");
    expect(j).toBeGreaterThan(0);
    expect(j).toBeLessThan(1);
  });
  it("disagreementScore = 1 - jaccard", () => {
    expect(disagreementScore("alice bob carol", "alice bob carol")).toBe(0);
    expect(disagreementScore("alice bob", "xray yankee")).toBe(1);
  });
  it("normalisation ignores markdown/punctuation noise", () => {
    expect(jaccard("**Alice**, Bob.", "alice bob")).toBe(1);
  });
});

describe("auroc", () => {
  it("perfect separation (higher score = wrong) → 1.0", () => {
    expect(auroc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1])).toBe(1);
  });
  it("inverted → 0.0", () => {
    expect(auroc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
  });
  it("all-tied scores → 0.5 (no signal)", () => {
    expect(auroc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
  });
  it("returns NaN when a class is empty", () => {
    expect(Number.isNaN(auroc([0.1, 0.2], [0, 0]))).toBe(true);
  });
});

describe("offloadCurve / minFrontierForAccuracy", () => {
  const items = [
    { wrong: true, score: 0.9 }, // the one that must escalate
    { wrong: false, score: 0.1 },
    { wrong: false, score: 0.2 },
  ];
  it("a perfect gate reaches 100% accuracy at the oracle frontier rate (errorRate)", () => {
    const curve = offloadCurve(items);
    // escalate-nothing point: accuracy = local-correct = 2/3
    const escalateNothing = curve.find((p) => p.frontierRate === 0)!;
    expect(escalateNothing.accuracy).toBeCloseTo(2 / 3, 5);
    // best gate escalates only the wrong item → frontierRate 1/3, accuracy 1.0
    const f = minFrontierForAccuracy(curve, 1 - 1e-9);
    expect(f).toBeCloseTo(1 / 3, 5);
  });
  it("a useless (constant) gate must escalate everything for 100% accuracy", () => {
    const useless = items.map((it) => ({ wrong: it.wrong, score: 0.5 }));
    const curve = offloadCurve(useless);
    const f = minFrontierForAccuracy(curve, 1 - 1e-9);
    expect(f).toBeCloseTo(1, 5); // can't isolate the wrong one → escalate all
  });
  it("empty input → empty curve, null frontier", () => {
    expect(offloadCurve([])).toEqual([]);
    expect(minFrontierForAccuracy([], 1)).toBeNull();
  });
});
