import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import {
  DEFAULT_DELEGATE_POLICY,
  DEFAULT_POLICY,
  type DelegatePolicyConfig,
} from "../src/homeserver/config.js";
import {
  decideDelegatePolicy,
  evaluateDelegatePolicy,
  isLearningSource,
  type DelegatePolicyInput,
} from "../src/homeserver/delegate-policy.js";
import {
  getLaneEvidence,
  recordDelegation,
  type LaneEvidence,
  type Outcome,
  type ErrorClass,
} from "../src/homeserver/ledger.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-delegate-policy-test-"));
  initDb(join(dir, "test.db"));
});

const MODEL = "mellum";
let counter = 0;

function uniqueType(prefix = "classify"): string {
  return `${prefix}-${counter++}`;
}

function cfg(partial: Partial<DelegatePolicyConfig> = {}): DelegatePolicyConfig {
  return { ...DEFAULT_DELEGATE_POLICY, mode: "enforce", ...partial };
}

function evidence(partial: Partial<LaneEvidence> = {}): LaneEvidence {
  return {
    taskType: "classify",
    modelId: MODEL,
    verifier: "jsonValid",
    attempts: 10,
    passes: 10,
    partials: 0,
    fails: 0,
    errors: 0,
    successRate: 1,
    errorRate: 0,
    p50LatencyMs: 1000,
    p90LatencyMs: 1200,
    latestTs: "2026-07-08T00:00:00.000Z",
    sources: { gateway: 10 },
    ...partial,
  };
}

function input(partial: Partial<DelegatePolicyInput> = {}): DelegatePolicyInput {
  return {
    taskType: "classify",
    modelId: MODEL,
    verifierName: "jsonValid",
    hasVerifier: true,
    source: "gateway",
    explicitModelOverride: false,
    policy: DEFAULT_POLICY,
    delegatePolicy: cfg(),
    ...partial,
  };
}

function recordLane(
  taskType: string,
  opts: {
    verifier?: string | null;
    outcome?: Outcome;
    errorClass?: ErrorClass | null;
    latencyMs?: number | null;
    source?: string;
  } = {}
): void {
  recordDelegation({
    taskType,
    modelId: MODEL,
    prompt: "x",
    outcome: opts.outcome ?? "pass",
    errorClass: opts.errorClass ?? null,
    latencyMs: opts.latencyMs ?? 1000,
    verifier: opts.verifier ?? "jsonValid",
    source: opts.source ?? "gateway",
  });
}

describe("delegate policy decisions", () => {
  it("is behavior-preserving when the policy is off", () => {
    const d = decideDelegatePolicy({
      ...input({ delegatePolicy: cfg({ mode: "off" }) }),
      evidence: evidence({ attempts: 0, successRate: 0 }),
    });
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("off");
  });

  it("denies broad task buckets even with attractive historical evidence", () => {
    const d = decideDelegatePolicy({
      ...input({ taskType: "other" }),
      evidence: evidence({ taskType: "other" }),
    });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("too broad");
  });

  it("shadows no-verifier lanes instead of certifying them for production", () => {
    const d = decideDelegatePolicy({
      ...input({ verifierName: "none", hasVerifier: false }),
      evidence: evidence({ verifier: null }),
    });
    expect(d.action).toBe("shadow");
    expect(d.reason).toContain("no verifier");
  });

  it("shadows anonymous custom verifier lanes instead of certifying them", () => {
    const d = decideDelegatePolicy({
      ...input({ verifierName: "custom", hasVerifier: true }),
      evidence: evidence({ verifier: "custom", attempts: 20, passes: 20, successRate: 1 }),
    });
    expect(d.action).toBe("shadow");
    expect(d.reason).toContain("no verifier");
  });

  it("denies judgment-quality lanes unless the verifier is trusted", () => {
    const d = decideDelegatePolicy({
      ...input({ taskType: "code-review", verifierName: "predicate" }),
      evidence: evidence({ taskType: "code-review", verifier: "predicate" }),
    });
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("trusted judgment verifier");
  });

  it("shadows lanes below the production sample floor", () => {
    const d = decideDelegatePolicy({
      ...input(),
      evidence: evidence({ attempts: 9, passes: 9, successRate: 1 }),
    });
    expect(d.action).toBe("shadow");
    expect(d.reason).toContain("9/10");
  });

  it("denies slow or noisy lanes even when pass rate is high", () => {
    expect(
      decideDelegatePolicy({
        ...input(),
        evidence: evidence({ attempts: 20, passes: 19, errors: 1, successRate: 0.95, errorRate: 0.05, p90LatencyMs: 30_001 }),
      }).action
    ).toBe("deny");
    expect(
      decideDelegatePolicy({
        ...input(),
        evidence: evidence({ attempts: 20, passes: 19, errors: 1, successRate: 0.95, errorRate: 0.051 }),
      }).action
    ).toBe("deny");
  });

  it("allows fast verifier-backed lanes with enough successful evidence", () => {
    const d = decideDelegatePolicy({
      ...input(),
      evidence: evidence({ attempts: 20, passes: 20, successRate: 1, p90LatencyMs: 900 }),
    });
    expect(d.action).toBe("allow");
    expect(d.reason).toContain("certified lane");
  });

  it("uses the lower threshold only for low-risk draft task types", () => {
    const draft = decideDelegatePolicy({
      ...input({ taskType: "rewrite" }),
      evidence: evidence({ taskType: "rewrite", attempts: 10, passes: 9, successRate: 0.9 }),
    });
    const normal = decideDelegatePolicy({
      ...input({ taskType: "classify" }),
      evidence: evidence({ taskType: "classify", attempts: 10, passes: 9, successRate: 0.9 }),
    });
    expect(draft.action).toBe("allow");
    expect(normal.action).toBe("deny");
  });

  it("lets learning/probe sources bypass the production gate", () => {
    expect(isLearningSource("probe")).toBe(true);
    expect(isLearningSource("harvest-backfill")).toBe(true);
    const d = decideDelegatePolicy({
      ...input({ source: "probe" }),
      evidence: evidence({ attempts: 0 }),
    });
    expect(d.action).toBe("allow");
    expect(d.productionSource).toBe(false);
  });
});

describe("delegate policy lane evidence", () => {
  it("aggregates one exact verifier lane and ignores unverified, infra, and other verifiers", () => {
    const t = uniqueType();
    for (let i = 0; i < 8; i++) recordLane(t, { verifier: "jsonValid", latencyMs: 1000 + i });
    recordLane(t, { verifier: "jsonValid", outcome: "partial", latencyMs: 2000 });
    recordLane(t, { verifier: "jsonValid", outcome: "fail", latencyMs: 3000 });
    recordLane(t, { verifier: "jsonValid", outcome: "error", errorClass: "infra", latencyMs: 4000 });
    recordLane(t, { verifier: "answerIs(OK)", latencyMs: 5000 });
    recordLane(t, { verifier: "jsonValid", outcome: "unverified", latencyMs: 6000 });

    const ev = getLaneEvidence(t, MODEL, "jsonValid", DEFAULT_POLICY);
    expect(ev.attempts).toBe(10);
    expect(ev.passes).toBe(8);
    expect(ev.partials).toBe(1);
    expect(ev.fails).toBe(1);
    expect(ev.errors).toBe(0);
    expect(ev.successRate).toBe(0.85);
    expect(ev.sources["gateway"]).toBe(10);
  });

  it("backs evaluateDelegatePolicy from real ledger rows", () => {
    const t = uniqueType();
    for (let i = 0; i < 10; i++) recordLane(t, { verifier: "jsonValid", latencyMs: 800 });

    const d = evaluateDelegatePolicy({
      ...input({ taskType: t }),
      verifierName: "jsonValid",
      delegatePolicy: cfg(),
    });
    expect(d.action).toBe("allow");
    expect(d.evidence.attempts).toBe(10);
  });
});
