/**
 * Issue #91 — policy gates must not be dodgeable by task-type spelling.
 *
 * #155 deliberately makes `orchestrator.resolveTaskType` preserve an explicit caller-supplied task
 * type VERBATIM (apart from trimming) — a caller's domain knowledge (e.g. ratatoskr asserting
 * `taskType:"Triage"`) should not be flattened. But several policy comparisons still did an EXACT
 * string match against a lowercase-kebab literal: the judgment-verifier deny in
 * `decideDelegatePolicy`, `BROAD_TASK_TYPES`/`LOW_RISK_TASK_TYPES`, `taskTypeEmitsJson`, and the
 * routing-table lookup. `"Code-Review"` was therefore a DIFFERENT bucket from `"code-review"` for
 * every one of those gates — including the judgment-verifier deny, which is an AUTHORITY gate: with
 * enough evidence accumulated on that variant bucket, enforce-mode `decideDelegatePolicy` could
 * return `allow` where canonical `code-review` returns `deny`.
 *
 * The rule (decided on the orchestrator side, #155/#91 — this suite does not re-litigate it):
 * canonicalize a spelling ONLY when its normalized (trim + case-fold) form is a KNOWN taxonomy id.
 * That canonical identity is then used for routing, the judgment/broad/low-risk lookups, the JSON
 * response contract, and evidence-bucket reads. A spelling whose normalized form is NOT a known id
 * keeps its #155 ingress identity and still falls through to the unknown-lane policy unchanged.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { DEFAULT_DELEGATE_POLICY, DEFAULT_POLICY, type DelegatePolicyConfig } from "../src/homeserver/config.js";
import {
  decideDelegatePolicy,
  evaluateDelegatePolicy,
  requiredSuccessRateForTask,
  type DecideDelegatePolicyInput,
  type DelegatePolicyInput,
} from "../src/homeserver/delegate-policy.js";
import { recordDelegation, type LaneEvidence } from "../src/homeserver/ledger.js";
import { policyTaskTypeIdentity } from "../src/homeserver/task-type-identity.js";
import { isKnownTaskType, taskTypeEmitsJson } from "../src/homeserver/taxonomy.js";
import { routeViaTable } from "../src/homeserver/orchestrator.js";
import { loadRoutingTable } from "../src/homeserver/routing-table.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-policy-task-type-identity-test-"));
  initDb(join(dir, "test.db"));
});

const MODEL = "qwen3-coder-next-80b";

function cfg(partial: Partial<DelegatePolicyConfig> = {}): DelegatePolicyConfig {
  return { ...DEFAULT_DELEGATE_POLICY, mode: "enforce", ...partial };
}

function certifiedEvidence(taskType: string, partial: Partial<LaneEvidence> = {}): LaneEvidence {
  return {
    taskType,
    modelId: MODEL,
    verifier: "predicate",
    attempts: 50,
    passes: 50,
    partials: 0,
    fails: 0,
    errors: 0,
    successRate: 1,
    errorRate: 0,
    p50LatencyMs: 800,
    p90LatencyMs: 1200,
    latestTs: "2026-07-25T00:00:00.000Z",
    sources: { gateway: 50 },
    ...partial,
  };
}

function input(partial: Partial<DecideDelegatePolicyInput> = {}): DecideDelegatePolicyInput {
  return {
    taskType: "code-review",
    modelId: MODEL,
    verifierName: "predicate",
    hasVerifier: true,
    source: "gateway",
    explicitModelOverride: false,
    policy: DEFAULT_POLICY,
    delegatePolicy: cfg(),
    evidence: certifiedEvidence("code-review"),
    ...partial,
  };
}

describe("policyTaskTypeIdentity (#91)", () => {
  it("canonicalizes a spelling whose normalized form is a known taxonomy id", () => {
    expect(policyTaskTypeIdentity("Code-Review", isKnownTaskType)).toBe("code-review");
    expect(policyTaskTypeIdentity(" Triage ", isKnownTaskType)).toBe("triage");
    expect(policyTaskTypeIdentity("REWRITE", isKnownTaskType)).toBe("rewrite");
  });

  it("leaves an already-canonical id untouched", () => {
    expect(policyTaskTypeIdentity("code-review", isKnownTaskType)).toBe("code-review");
  });

  it("keeps #155 ingress identity (trimmed, otherwise verbatim) for a spelling that is not a known id", () => {
    expect(policyTaskTypeIdentity("Ratatoskr-Domain-Bucket", isKnownTaskType)).toBe("Ratatoskr-Domain-Bucket");
    expect(policyTaskTypeIdentity(" Ratatoskr-Domain-Bucket ", isKnownTaskType)).toBe("Ratatoskr-Domain-Bucket");
    // Case-folding alone does not make "code_review" (underscore) or "review" match "code-review".
    expect(policyTaskTypeIdentity("code_review", isKnownTaskType)).toBe("code_review");
    expect(policyTaskTypeIdentity("Review", isKnownTaskType)).toBe("Review");
  });
});

describe("decideDelegatePolicy — the judgment-verifier deny cannot be dodged by spelling (#91)", () => {
  it("THE ACCEPTANCE CASE: 'Code-Review' is denied exactly like 'code-review', even with perfect structurally-verified evidence on the variant bucket", () => {
    const canonical = decideDelegatePolicy(input());
    const variant = decideDelegatePolicy(
      input({ taskType: "Code-Review", evidence: certifiedEvidence("Code-Review") })
    );
    expect(canonical.action).toBe("deny");
    expect(canonical.reason).toContain("trusted judgment verifier");
    expect(variant.action).toBe("deny");
    expect(variant.reason).toContain("trusted judgment verifier");
  });

  it("a whitespace variant is denied the same way", () => {
    const d = decideDelegatePolicy(
      input({ taskType: " code-review ", evidence: certifiedEvidence(" code-review ") })
    );
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("trusted judgment verifier");
  });

  it("a trusted verifier still allows the canonical lane and its case variant identically", () => {
    const policy = { ...DEFAULT_POLICY, trustedVerifiersForJudgment: ["predicate"] };
    const canonical = decideDelegatePolicy(input({ policy }));
    const variant = decideDelegatePolicy(
      input({ taskType: "Code-Review", policy, evidence: certifiedEvidence("Code-Review") })
    );
    expect(canonical.action).toBe("allow");
    expect(variant.action).toBe("allow");
  });
});

describe("decideDelegatePolicy — BROAD_TASK_TYPES cannot be dodged by spelling (#91)", () => {
  it("denies a case variant of 'other' exactly like 'other'", () => {
    const d = decideDelegatePolicy(
      input({ taskType: "Other", verifierName: "predicate", evidence: certifiedEvidence("Other") })
    );
    expect(d.action).toBe("deny");
    expect(d.reason).toContain("too broad");
  });
});

describe("decideDelegatePolicy / requiredSuccessRateForTask — LOW_RISK_TASK_TYPES cannot be dodged by spelling (#91)", () => {
  it("a case variant of a low-risk type gets the lower success-rate threshold", () => {
    // 0.92 clears lowRiskSuccessRate (0.9) but not the default minSuccessRate (0.95).
    const d = decideDelegatePolicy(
      input({
        taskType: "Rewrite",
        verifierName: "predicate",
        policy: { ...DEFAULT_POLICY, trustedVerifiersForJudgment: ["predicate"] },
        evidence: certifiedEvidence("Rewrite", { attempts: 20, passes: 18, successRate: 0.92 }),
      })
    );
    expect(d.requiredSuccessRate).toBe(DEFAULT_DELEGATE_POLICY.lowRiskSuccessRate);
    expect(d.action).toBe("allow");
  });

  it("a genuinely unknown spelling keeps the default (non-low-risk) threshold", () => {
    expect(requiredSuccessRateForTask("code-review", cfg())).toBe(cfg().minSuccessRate);
  });
});

describe("taskTypeEmitsJson (#91)", () => {
  it("canonicalizes a case variant of a JSON-contract type", () => {
    expect(taskTypeEmitsJson("Triage")).toBe(true); // canonical "triage" has jsonOutput: true
    expect(taskTypeEmitsJson("triage")).toBe(true);
  });

  it("still reports false for a case variant of a prose type", () => {
    expect(taskTypeEmitsJson("Code-Review")).toBe(false);
  });

  it("a genuinely unknown spelling stays false, unchanged", () => {
    expect(taskTypeEmitsJson("Ratatoskr-Domain-Bucket")).toBe(false);
  });
});

describe("routeViaTable — the routing-table lookup cannot be dodged by spelling (#91)", () => {
  const GAP_TYPE = loadRoutingTable().escalateToFrontier[0]!;
  if (!GAP_TYPE) {
    throw new Error("docs/m5-routing.json has no escalateToFrontier types — update this test");
  }

  it("a case variant of a frontier-escalation gap type still escalates", () => {
    expect(routeViaTable(GAP_TYPE, { enabled: true })).toEqual({ kind: "escalate" });
    expect(routeViaTable(GAP_TYPE.toUpperCase(), { enabled: true })).toEqual({ kind: "escalate" });
  });

  it("a case variant of a locally-routed type routes to the same model", () => {
    expect(routeViaTable("code-implement", { enabled: true })).toEqual({ kind: "local", modelId: "mellum" });
    expect(routeViaTable("Code-Implement", { enabled: true })).toEqual({ kind: "local", modelId: "mellum" });
    expect(routeViaTable(" code-implement ", { enabled: true })).toEqual({ kind: "local", modelId: "mellum" });
  });

  it("a genuinely unknown spelling still falls through to UNKNOWN unchanged (fail-safe, #91 acceptance)", () => {
    expect(routeViaTable("Ratatoskr-Domain-Bucket", { enabled: true })).toEqual({ kind: "fallthrough" });
    expect(routeViaTable("ratatoskr-domain-bucket", { enabled: true })).toEqual({ kind: "fallthrough" });
  });
});

describe("evaluateDelegatePolicy — evidence keys merge onto the canonical bucket (#91)", () => {
  it("a case variant reads the SAME lane evidence as its canonical id, not an empty/separate bucket", () => {
    const taskType = `code-review-merge-${Date.now()}`; // not used as a literal taxonomy id below
    // Real regression: record rows under the CANONICAL taxonomy id "code-review" with a verifier
    // trusted for judgment quality, then evaluate under a case-variant spelling.
    const trustedPolicy = { ...DEFAULT_POLICY, trustedVerifiersForJudgment: ["predicate"] };
    for (let i = 0; i < 12; i++) {
      recordDelegation({
        taskType: "code-review",
        modelId: MODEL,
        prompt: `evidence-merge-fixture-${taskType}-${i}`,
        outcome: "pass",
        errorClass: null,
        latencyMs: 900,
        verifier: "predicate",
        source: "gateway",
      });
    }

    const canonicalInput: DelegatePolicyInput = {
      taskType: "code-review",
      modelId: MODEL,
      verifierName: "predicate",
      hasVerifier: true,
      source: "gateway",
      explicitModelOverride: false,
      policy: trustedPolicy,
      delegatePolicy: cfg(),
    };
    const variantInput: DelegatePolicyInput = { ...canonicalInput, taskType: "Code-Review" };

    const canonicalDecision = evaluateDelegatePolicy(canonicalInput);
    const variantDecision = evaluateDelegatePolicy(variantInput);

    expect(canonicalDecision.evidence.attempts).toBeGreaterThanOrEqual(12);
    // The variant must read the SAME (non-empty, matching) evidence bucket as the canonical id —
    // not its own empty/separate "Code-Review" bucket.
    expect(variantDecision.evidence.attempts).toBe(canonicalDecision.evidence.attempts);
    expect(variantDecision.evidence.successRate).toBe(canonicalDecision.evidence.successRate);
  });

  it("a genuinely unknown spelling still reads its own (real, unmerged) bucket", () => {
    const raw = `ratatoskr-domain-bucket-${Date.now()}`;
    recordDelegation({
      taskType: raw,
      modelId: MODEL,
      prompt: "evidence-unknown-fixture",
      outcome: "pass",
      errorClass: null,
      latencyMs: 900,
      verifier: "predicate",
      source: "gateway",
    });

    const decision = evaluateDelegatePolicy({
      taskType: raw,
      modelId: MODEL,
      verifierName: "predicate",
      hasVerifier: true,
      source: "gateway",
      explicitModelOverride: false,
      policy: DEFAULT_POLICY,
      delegatePolicy: cfg(),
    });
    expect(decision.evidence.taskType).toBe(raw);
    expect(decision.evidence.attempts).toBeGreaterThanOrEqual(1);
  });

  it("records a known-id spelling variant into the canonical lane, so its failures demote the lane the gate reads (#95)", () => {
    const promptPrefix = `known-variant-demotion-${Date.now()}`;
    const trustedPolicy = { ...DEFAULT_POLICY, trustedVerifiersForJudgment: ["predicate"] };
    const canonicalInput: DelegatePolicyInput = {
      taskType: "summarize",
      modelId: MODEL,
      verifierName: "predicate",
      hasVerifier: true,
      source: "gateway",
      explicitModelOverride: false,
      policy: trustedPolicy,
      delegatePolicy: cfg(),
    };

    // Establish an enforce-mode-certified canonical lane first.
    for (let i = 0; i < 10; i++) {
      recordDelegation({
        taskType: "summarize",
        modelId: MODEL,
        prompt: `${promptPrefix}-pass-${i}`,
        outcome: "pass",
        latencyMs: 900,
        verifier: "predicate",
        source: "gateway",
      });
    }
    expect(evaluateDelegatePolicy(canonicalInput).action).toBe("allow");

    // This is the former orphaned-evidence path: policy reads "summarize" while a caller
    // supplied "Summarize". These failures must land in the policy's canonical bucket.
    for (let i = 0; i < 3; i++) {
      recordDelegation({
        taskType: "Summarize",
        modelId: MODEL,
        prompt: `${promptPrefix}-variant-fail-${i}`,
        outcome: "fail",
        latencyMs: 900,
        verifier: "predicate",
        source: "gateway",
      });
    }

    const demoted = evaluateDelegatePolicy(canonicalInput);
    expect(demoted.evidence.taskType).toBe("summarize");
    expect(demoted.evidence.attempts).toBe(13);
    expect(demoted.evidence.fails).toBe(3);
    expect(demoted.action).toBe("deny");
  });

  it("keeps a genuine caller-domain bucket verbatim in the ledger (#95 migration guard)", () => {
    const taskType = `Ratatoskr-Domain-Bucket-${Date.now()}`;
    recordDelegation({ taskType, modelId: MODEL, prompt: "domain bucket", outcome: "pass" });

    const row = getDb()
      .prepare("SELECT task_type AS taskType FROM delegations WHERE prompt_excerpt = ?")
      .get("domain bucket") as { taskType: string };
    expect(row.taskType).toBe(taskType);
  });
});
