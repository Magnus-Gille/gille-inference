/**
 * Unit tests for the PURE disagreement-gate core (src/homeserver/disagreement-gate.ts):
 *   - gateDecision(): answer-level disagreement vs a threshold (numeric-aware, ordinal-safe).
 *   - gateEligible(): the policy for WHEN to spend the second local call (unverified-only,
 *     distinct secondary model, mode gating).
 *
 * The answer-comparison primitives (extractAnswer / disagreementScore / jaccard) keep their
 * original coverage in tests/cascade-gate-experiment.test.ts, which now re-imports them from
 * here via the experiment script's re-export.
 */
import { describe, it, expect } from "vitest";
import {
  gateDecision,
  gateEligible,
  disagreementScore,
  type GateConfig,
} from "../src/homeserver/disagreement-gate.js";

describe("gateDecision — threshold on answer-level disagreement", () => {
  it("identical answers → score 0, no disagreement", () => {
    const d = gateDecision("ANSWER: 42", "ANSWER: 42", 0.3);
    expect(d.score).toBe(0);
    expect(d.disagree).toBe(false);
  });

  it("numeric-equal but differently formatted → agree (no phantom disagreement)", () => {
    const d = gateDecision("ANSWER: 66", "the result is ANSWER: 66.0", 0.3);
    expect(d.score).toBe(0);
    expect(d.disagree).toBe(false);
  });

  it("clearly different numeric answers → score 1, disagree", () => {
    const d = gateDecision("ANSWER: 7", "ANSWER: 9", 0.3);
    expect(d.score).toBe(1);
    expect(d.disagree).toBe(true);
  });

  it("ordinals are compared as text, not coerced ('1st' vs '2nd' must disagree)", () => {
    const d = gateDecision("ANSWER: 1st", "ANSWER: 2nd", 0.3);
    expect(d.disagree).toBe(true);
  });

  it("disagreement is computed on the ANSWER, not the chain-of-thought", () => {
    // Same answer, wildly different reasoning text → should still agree.
    const a = "First I factor, then I divide, carefully. ANSWER: yes";
    const b = "Different approach entirely, brute force enumeration. ANSWER: yes";
    expect(gateDecision(a, b, 0.3).disagree).toBe(false);
  });

  it("threshold is clamped to [0,1] and applied with ≥", () => {
    // score exactly at threshold → disagree (≥, not >)
    const score = disagreementScore("a b c d", "a b"); // partial overlap, 0<score<1
    expect(gateDecision("a b c d", "a b", score).disagree).toBe(true);
    // a negative threshold is clamped to 0, so any positive score disagrees
    expect(gateDecision("ANSWER: 7", "ANSWER: 9", -5).disagree).toBe(true);
    // a threshold above 1 is clamped to 1, so even full disagreement (1) still fires
    expect(gateDecision("ANSWER: 7", "ANSWER: 9", 99).disagree).toBe(true);
  });

  it("EXACT agreement (score 0) never escalates — even at threshold 0 or negative (Codex #2)", () => {
    // A mis-set threshold must not turn every identical-answer delegation into an escalation.
    expect(gateDecision("ANSWER: 42", "ANSWER: 42", 0).disagree).toBe(false);
    expect(gateDecision("ANSWER: 42", "ANSWER: 42", -1).disagree).toBe(false);
    // ...but at threshold 0 any genuine disagreement still fires.
    expect(gateDecision("ANSWER: 7", "ANSWER: 9", 0).disagree).toBe(true);
  });

  it("list-like numeric answers fail closed to text comparison ('1 2' ≠ '12') (Codex #4)", () => {
    // "1 2" must NOT be coerced to 12 (which would falsely agree with "12").
    expect(gateDecision("ANSWER: 1 2", "ANSWER: 12", 0.3).disagree).toBe(true);
    // genuine thousands separators / decoration still compare numerically
    expect(gateDecision("ANSWER: $1,234.5", "ANSWER: 1234.50", 0.3).disagree).toBe(false);
  });
});

describe("gateEligible — when to spend the second local call", () => {
  const cfg = (over: Partial<GateConfig> = {}): GateConfig => ({
    mode: "on",
    secondaryModel: "qwen3-coder-next-80b",
    threshold: 0.3,
    ...over,
  });

  it("mode off → never eligible (behaviour-preserving default)", () => {
    const e = gateEligible({ config: cfg({ mode: "off" }), outcome: "unverified", primaryModelId: "mellum" });
    expect(e.eligible).toBe(false);
  });

  it("unverified + distinct secondary + mode on → eligible", () => {
    const e = gateEligible({ config: cfg(), outcome: "unverified", primaryModelId: "mellum" });
    expect(e.eligible).toBe(true);
  });

  it("shadow mode is eligible (runs the gate, records, but does not change routing)", () => {
    const e = gateEligible({ config: cfg({ mode: "shadow" }), outcome: "unverified", primaryModelId: "mellum" });
    expect(e.eligible).toBe(true);
  });

  it("a present verifier verdict (pass/fail/partial) → NOT eligible (trust the verifier)", () => {
    for (const outcome of ["pass", "fail", "partial", "error"] as const) {
      expect(
        gateEligible({ config: cfg(), outcome, primaryModelId: "mellum" }).eligible
      ).toBe(false);
    }
  });

  it("secondary == primary → NOT eligible (a model cannot disagree with itself)", () => {
    const e = gateEligible({ config: cfg({ secondaryModel: "mellum" }), outcome: "unverified", primaryModelId: "mellum" });
    expect(e.eligible).toBe(false);
  });

  it("empty/whitespace secondary model → NOT eligible", () => {
    expect(gateEligible({ config: cfg({ secondaryModel: "" }), outcome: "unverified", primaryModelId: "mellum" }).eligible).toBe(false);
    expect(gateEligible({ config: cfg({ secondaryModel: "   " }), outcome: "unverified", primaryModelId: "mellum" }).eligible).toBe(false);
  });
});
