/**
 * Pure core of the shadow lane (#234): eligibility + grading.
 *
 * The shadow lane exists to escape the evidence ABSORBING STATE (#199): once a task type is routed
 * frontier-only, no local attempt ever happens again, so no new evidence can ever accumulate and the
 * router can never learn that a local model became viable. The shadow lane runs the local candidate
 * on escalated leaves — but never returns its output to anyone and never lets it count as production
 * evidence (#156's inflation lesson: weak evidence that reaches a verdict is worse than no evidence).
 *
 * Everything here is pure (no I/O), so the policy is testable without a model or a DB.
 */
import { describe, it, expect } from "vitest";
import {
  shadowEligible,
  gradeShadowOutput,
  SHADOW_FRONTIER_VERIFIER,
  type ShadowLaneConfig,
} from "../src/homeserver/shadow-lane.js";

const CFG: ShadowLaneConfig = {
  mode: "on",
  model: "qwen3-coder-next-80b",
  taskTypes: [],
  maxTokens: 2048,
  timeoutMs: 120_000,
  agreementThreshold: 0.7,
};

const BASE = { config: CFG, taskType: "code-review", delegated: false, queueDepth: 0, running: 0 };

describe("shadowEligible — the lowest-priority admission policy", () => {
  it("is eligible on an escalated leaf when the box is idle", () => {
    expect(shadowEligible(BASE)).toEqual({ eligible: true, reason: expect.any(String) });
  });

  it("mode off (the default) → never eligible", () => {
    const r = shadowEligible({ ...BASE, config: { ...CFG, mode: "off" } });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("off");
  });

  it("the local model was already attempted → not eligible (real evidence already exists)", () => {
    const r = shadowEligible({ ...BASE, delegated: true });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("already attempted");
  });

  it("a NON-EMPTY delegate queue skips the shadow entirely — real traffic always wins", () => {
    const r = shadowEligible({ ...BASE, queueDepth: 1 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("queue");
  });

  it("a shadow evaluation already running → not eligible (max 1 concurrent)", () => {
    const r = shadowEligible({ ...BASE, running: 1 });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("1 concurrent");
  });

  it("an allow-list restricts which task types are shadowed", () => {
    const scoped: ShadowLaneConfig = { ...CFG, taskTypes: ["code-review", "code-edit"] };
    expect(shadowEligible({ ...BASE, config: scoped, taskType: "code-edit" }).eligible).toBe(true);
    const r = shadowEligible({ ...BASE, config: scoped, taskType: "summarize" });
    expect(r.eligible).toBe(false);
    expect(r.reason).toContain("summarize");
  });

  it("checks the queue BEFORE the allow-list is irrelevant — busy box always loses, whatever the type", () => {
    const scoped: ShadowLaneConfig = { ...CFG, taskTypes: ["code-review"] };
    expect(shadowEligible({ ...BASE, config: scoped, queueDepth: 2 }).eligible).toBe(false);
  });
});

describe("gradeShadowOutput — grade the shadow, never trust it", () => {
  it("a task verifier is authoritative when present (deterministic beats fuzzy)", async () => {
    const g = await gradeShadowOutput({
      output: "42",
      verifier: async () => ({ outcome: "pass", score: 1, notes: "matched" }),
      verifierName: "answerIs",
      frontierOutput: "something completely different",
      agreementThreshold: 0.7,
    });
    expect(g.outcome).toBe("pass");
    expect(g.score).toBe(1);
    expect(g.verifierName).toBe("answerIs");
  });

  it("records the frontier agreement as a NOTE even when a verifier decided the outcome", async () => {
    const g = await gradeShadowOutput({
      output: "the answer is 42",
      verifier: async () => ({ outcome: "fail", score: 0 }),
      verifierName: "answerIs",
      frontierOutput: "the answer is 42",
      agreementThreshold: 0.7,
    });
    expect(g.outcome).toBe("fail");
    expect(g.notes).toContain("agree=1.00");
  });

  it("no verifier + a frontier answer → graded on agreement with the frontier answer", async () => {
    const agree = await gradeShadowOutput({
      output: "The bug is an off-by-one in the loop bound.",
      frontierOutput: "The bug is an off-by-one in the loop bound.",
      agreementThreshold: 0.7,
    });
    expect(agree.outcome).toBe("pass");
    expect(agree.score).toBe(1);
    expect(agree.verifierName).toBe(SHADOW_FRONTIER_VERIFIER);

    const disagree = await gradeShadowOutput({
      output: "No issues found.",
      frontierOutput: "The bug is an off-by-one in the loop bound of parseRange().",
      agreementThreshold: 0.7,
    });
    expect(disagree.outcome).toBe("fail");
    expect(disagree.score).toBeLessThan(0.7);
  });

  it("no verifier and NO frontier answer → unverified (we refuse to invent a verdict)", async () => {
    const g = await gradeShadowOutput({ output: "some output", agreementThreshold: 0.7 });
    expect(g.outcome).toBe("unverified");
    expect(g.score).toBeNull();
    expect(g.verifierName).toBe("none");
  });
});
