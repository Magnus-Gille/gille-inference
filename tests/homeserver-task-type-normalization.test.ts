/**
 * Issue #80 — the advisory-only guardrail must normalize its OWN input.
 *
 * #74 added `isAdvisoryOnlyTaskType` as the independent last line of defense that keeps
 * `review-bounded` local output advisory until an operator promotes it. It matched the task type
 * exactly, while `code-loop.ts` passed a caller-supplied `task_type` through untrimmed — so
 * `"review-bounded "` skipped the guardrail. That was fail-safe in practice (an unrecognized type
 * has no certified evidence rows, so the ordinary gates deny it anyway), but a guardrail whose job
 * is to be independent must not depend on another gate catching the same input.
 *
 * Normalization is trim + case-fold: every task-type id in taxonomy.ts is a lowercase kebab
 * literal, so folding can only ever map a variant ONTO a canonical id — it can never invent a new
 * one, and for this guardrail it can only ever catch MORE input as advisory-only, never less.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATE_POLICY, DEFAULT_POLICY, type DelegatePolicyConfig } from "../src/homeserver/config.js";
import {
  decideDelegatePolicy,
  isAdvisoryOnlyTaskType,
  type DecideDelegatePolicyInput,
} from "../src/homeserver/delegate-policy.js";
import {
  isPromotedAdvisoryTaskType,
  normalizeTaskType,
} from "../src/homeserver/task-type-identity.js";
import { reviewLaneCapability } from "../src/homeserver/review-bounded.js";
import { resolveTaskType } from "../src/homeserver/orchestrator.js";
import type { LaneEvidence } from "../src/homeserver/ledger.js";

/** The exact variants #80 names: trailing space, leading space, and a case variant. */
const VARIANTS = ["review-bounded ", " review-bounded", "Review-Bounded", "  REVIEW-BOUNDED\t"];

function cfg(partial: Partial<DelegatePolicyConfig> = {}): DelegatePolicyConfig {
  return { ...DEFAULT_DELEGATE_POLICY, mode: "enforce", ...partial };
}

function certifiedEvidence(taskType: string): LaneEvidence {
  return {
    taskType,
    modelId: "qwen3-coder-next-80b",
    verifier: "reviewBoundedVerifier",
    attempts: 50,
    passes: 50,
    partials: 0,
    fails: 0,
    errors: 0,
    successRate: 1,
    errorRate: 0,
    p50LatencyMs: 800,
    p90LatencyMs: 1200,
    latestTs: "2026-07-24T00:00:00.000Z",
    sources: { gateway: 50 },
  };
}

function input(partial: Partial<DecideDelegatePolicyInput> = {}): DecideDelegatePolicyInput {
  return {
    taskType: "review-bounded",
    modelId: "qwen3-coder-next-80b",
    verifierName: "reviewBoundedVerifier",
    hasVerifier: true,
    source: "gateway",
    explicitModelOverride: false,
    policy: DEFAULT_POLICY,
    delegatePolicy: cfg(),
    evidence: certifiedEvidence("review-bounded"),
    ...partial,
  };
}

describe("normalizeTaskType (#80)", () => {
  it("trims surrounding whitespace and case-folds", () => {
    for (const variant of VARIANTS) expect(normalizeTaskType(variant)).toBe("review-bounded");
  });

  it("leaves an already-canonical id untouched", () => {
    expect(normalizeTaskType("review-bounded")).toBe("review-bounded");
    expect(normalizeTaskType("code-review")).toBe("code-review");
  });

  it("does not rewrite interior characters — an unknown bucket stays its own bucket", () => {
    expect(normalizeTaskType("ratatoskr triage")).toBe("ratatoskr triage");
    expect(normalizeTaskType("")).toBe("");
    expect(normalizeTaskType("   ")).toBe("");
  });
});

describe("isAdvisoryOnlyTaskType is robust to untrimmed / case-variant input (#80)", () => {
  it("catches every whitespace and case variant of review-bounded", () => {
    for (const variant of VARIANTS) {
      expect(isAdvisoryOnlyTaskType(variant), `variant ${JSON.stringify(variant)}`).toBe(true);
    }
  });

  it("still does not over-match a genuinely different task type", () => {
    expect(isAdvisoryOnlyTaskType(" code-review ")).toBe(false);
    expect(isAdvisoryOnlyTaskType("review-bounded-ish")).toBe(false);
    expect(isAdvisoryOnlyTaskType("")).toBe(false);
  });
});

describe("decideDelegatePolicy — a task-type variant cannot reach allow (#80)", () => {
  it("every variant stays shadow with the default (empty) promotedAdvisoryTaskTypes", () => {
    for (const variant of VARIANTS) {
      const decision = decideDelegatePolicy(
        input({ taskType: variant, evidence: certifiedEvidence(variant) })
      );
      expect(decision.action, `variant ${JSON.stringify(variant)}`).toBe("shadow");
      expect(decision.reason).toMatch(/advisory-only/i);
    }
  });

  it("an operator promotion written with stray whitespace/case still promotes the canonical lane", () => {
    const decision = decideDelegatePolicy(
      input({ delegatePolicy: cfg({ promotedAdvisoryTaskTypes: [" Review-Bounded "] }) })
    );
    expect(decision.action).toBe("allow");
  });

  it("a promoted canonical lane also covers a caller's variant spelling of the same lane", () => {
    const decision = decideDelegatePolicy(
      input({
        taskType: "review-bounded ",
        evidence: certifiedEvidence("review-bounded "),
        delegatePolicy: cfg({ promotedAdvisoryTaskTypes: ["review-bounded"] }),
      })
    );
    expect(decision.action).toBe("allow");
  });

  it("promoting a different task type still does not promote a review-bounded variant", () => {
    const decision = decideDelegatePolicy(
      input({
        taskType: "Review-Bounded",
        evidence: certifiedEvidence("Review-Bounded"),
        delegatePolicy: cfg({ promotedAdvisoryTaskTypes: ["some-other-type"] }),
      })
    );
    expect(decision.action).toBe("shadow");
  });
});

describe("isPromotedAdvisoryTaskType — one shared promotion test (#80)", () => {
  it("matches across whitespace/case on both sides", () => {
    expect(isPromotedAdvisoryTaskType("review-bounded ", [" REVIEW-BOUNDED"])).toBe(true);
    expect(isPromotedAdvisoryTaskType("Review-Bounded", ["review-bounded"])).toBe(true);
  });

  it("is empty-by-default safe", () => {
    expect(isPromotedAdvisoryTaskType("review-bounded", [])).toBe(false);
    expect(isPromotedAdvisoryTaskType("review-bounded", ["code-review"])).toBe(false);
  });
});

describe("reviewLaneCapability preflight agrees with the policy guardrail (#80)", () => {
  it("resolves a variant to the canonical local-advisory lane and echoes the canonical id", () => {
    for (const variant of VARIANTS) {
      const cap = reviewLaneCapability(variant, []);
      expect(cap.taskType, `variant ${JSON.stringify(variant)}`).toBe("review-bounded");
      expect(cap.eligible).toBe("local-advisory");
      expect(cap.advisoryOnly).toBe(true);
      expect(cap.promoted).toBe(false);
    }
  });

  it("reports promoted:true when the operator promotion is spelled as a variant", () => {
    const cap = reviewLaneCapability("review-bounded", [" Review-Bounded "]);
    expect(cap.promoted).toBe(true);
    expect(cap.advisoryOnly).toBe(false);
  });

  it("a code-review variant stays frontier-only", () => {
    const cap = reviewLaneCapability(" Code-Review ", []);
    expect(cap.taskType).toBe("code-review");
    expect(cap.eligible).toBe("frontier-only");
  });

  it("an unrecognized task type is still echoed as given (canonicalized) and stays frontier-only", () => {
    const cap = reviewLaneCapability(" some-other-type ", []);
    expect(cap.taskType).toBe("some-other-type");
    expect(cap.eligible).toBe("frontier-only");
  });
});

describe("resolveTaskType — the one canonical ingress resolution (#80)", () => {
  it("trims an explicit caller-supplied task type", () => {
    expect(resolveTaskType({ taskType: " review-bounded ", prompt: "anything" })).toBe("review-bounded");
  });

  it("preserves an explicit caller bucket verbatim otherwise (#155 policy is unchanged)", () => {
    expect(resolveTaskType({ taskType: "Triage", prompt: "anything" })).toBe("Triage");
  });

  it("falls back to the classifier when the field is absent or whitespace-only", () => {
    expect(resolveTaskType({ taskType: "   ", prompt: "summarize this document" })).toBe(
      resolveTaskType({ prompt: "summarize this document" })
    );
  });
});
