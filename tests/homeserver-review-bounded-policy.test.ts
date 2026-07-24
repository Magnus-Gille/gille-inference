/**
 * Issue #74 — the advisory-only guarantee.
 *
 * Local review-bounded output must NEVER become an automatic production merge/decision gate,
 * even after it clears every ordinary evidence threshold (samples, success rate, error rate,
 * latency) — it stays advisory until an operator explicitly promotes it via
 * `delegatePolicy.promotedAdvisoryTaskTypes`, which defaults to empty. This is deliberately a
 * SEPARATE guardrail from the normal certified-lane math in decideDelegatePolicy, so a lane
 * cannot cross into "allow" merely by accumulating passing rows.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DELEGATE_POLICY, DEFAULT_POLICY, type DelegatePolicyConfig } from "../src/homeserver/config.js";
import {
  decideDelegatePolicy,
  isAdvisoryOnlyTaskType,
  type DecideDelegatePolicyInput,
} from "../src/homeserver/delegate-policy.js";
import type { LaneEvidence } from "../src/homeserver/ledger.js";

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

describe("isAdvisoryOnlyTaskType (#74)", () => {
  it("review-bounded is advisory-only", () => {
    expect(isAdvisoryOnlyTaskType("review-bounded")).toBe(true);
  });

  it("code-review is not in this set (its own, separate frontier-only gate is unaffected)", () => {
    expect(isAdvisoryOnlyTaskType("code-review")).toBe(false);
  });

  it("an ordinary task type is not advisory-only", () => {
    expect(isAdvisoryOnlyTaskType("classify")).toBe(false);
  });
});

describe("decideDelegatePolicy — review-bounded stays advisory (shadow) even with perfect certified-lane evidence (#74)", () => {
  it("never returns allow for review-bounded when promotedAdvisoryTaskTypes is empty (the default)", () => {
    const decision = decideDelegatePolicy(input());
    expect(decision.action).toBe("shadow");
    expect(decision.reason).toMatch(/advisory-only/i);
    expect(decision.reason).toContain("review-bounded");
  });

  it("still reports the REAL blocking reason when the lane genuinely isn't certified yet (advisory check runs last)", () => {
    const decision = decideDelegatePolicy(
      input({ evidence: { ...certifiedEvidence("review-bounded"), attempts: 1 } })
    );
    expect(decision.action).toBe("shadow");
    expect(decision.reason).toMatch(/insufficient verified lane evidence/i);
  });

  it("an ordinary (non-advisory-only) task type with the same certified evidence DOES reach allow", () => {
    const decision = decideDelegatePolicy(
      input({ taskType: "classify", verifierName: "jsonValid", evidence: certifiedEvidence("classify") })
    );
    expect(decision.action).toBe("allow");
  });

  it("promoting review-bounded via config lets it reach allow with the same certified evidence", () => {
    const decision = decideDelegatePolicy(
      input({ delegatePolicy: cfg({ promotedAdvisoryTaskTypes: ["review-bounded"] }) })
    );
    expect(decision.action).toBe("allow");
  });

  it("promoting a DIFFERENT task type does not promote review-bounded", () => {
    const decision = decideDelegatePolicy(
      input({ delegatePolicy: cfg({ promotedAdvisoryTaskTypes: ["some-other-type"] }) })
    );
    expect(decision.action).toBe("shadow");
  });

  it("delegate-policy mode 'off' is unaffected (today's default — no gate runs at all)", () => {
    const decision = decideDelegatePolicy(input({ delegatePolicy: { ...DEFAULT_DELEGATE_POLICY, mode: "off" } }));
    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("delegate-policy off");
  });
});
