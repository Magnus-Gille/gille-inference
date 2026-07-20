/**
 * routing-lifecycle.ts test suite (issue #7) — the reviewed GENERATE → VALIDATE → REVIEW →
 * DEPLOY/RELOAD → CANARY → ROLLBACK lifecycle around the existing routing-table primitives.
 *
 * PRODUCTION-ROUTING-MUTATION: this is the load-bearing safety seam, so coverage here is
 * deliberately exhaustive — every VALIDATE refusal class, the non-bypassable approval gate, the
 * atomic deploy/reload/canary/rollback sequence, and the #6 calibration-gate admissibility rule
 * (organic-judge evidence must not drive a route change unless the gate is GO+enabled).
 */
import { describe, it, expect } from "vitest";
import {
  buildDecisionArtifact,
  validateCandidate,
  approveArtifact,
  artifactContentHash,
  adoptRoutingTable,
  manualRollback,
  runCanary,
  buildCandidatePair,
  ApprovalRefusedError,
  ApprovalMismatchError,
  PolicyEpochStaleError,
  type RoutingDecisionArtifact,
  type AdoptDeps,
  type ReloadOutcome,
} from "../src/homeserver/routing-lifecycle.js";
import { generateRoutingTable, type RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import type { LedgerReportRow } from "../src/homeserver/ledger.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────

type RouteSpec = { model: string | null; verdict: string; attempts: number; passRate?: number; tokPerSec?: number | null };

function makeDoc(routing: Record<string, RouteSpec>, opts: { generatedAt?: string } = {}): RoutingTableDoc {
  return {
    _comment: "test fixture",
    _generator: "test",
    generatedAt: opts.generatedAt ?? "2026-07-20T00:00:00.000Z",
    sources: [],
    globalRule: "test",
    routing: Object.fromEntries(
      Object.entries(routing).map(([k, v]) => [
        k,
        { model: v.model, passRate: v.passRate ?? 1, tokPerSec: v.tokPerSec ?? null, verdict: v.verdict, attempts: v.attempts },
      ])
    ),
    escalateToFrontier: Object.entries(routing)
      .filter(([, v]) => v.model === null)
      .map(([k]) => k),
    avoidForShortTasks: [],
    modelProfiles: {},
  };
}

const NOW = "2026-07-20T12:00:00.000Z";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function baseArtifactInputs(overrides: Partial<Parameters<typeof buildDecisionArtifact>[0]> = {}) {
  const candidate = makeDoc({
    classify: { model: "mellum", verdict: "delegate-local", attempts: 10 },
    "reason-math": { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 10 },
  });
  return {
    candidate,
    deterministicCandidate: candidate,
    adopted: null,
    servableModelIds: ["mellum", "qwen3-coder-next-80b"],
    requiredTaskTypes: ["classify", "reason-math"],
    freshnessMaxAgeMs: ONE_DAY_MS,
    nowIso: NOW,
    calibrationGate: null,
    policyEpochHash: "epoch-1",
    expectedPolicyEpochHash: "epoch-1",
    ...overrides,
  };
}

// ── VALIDATE — each refusal class ───────────────────────────────────────────────

describe("buildDecisionArtifact — VALIDATE refusals", () => {
  it("refuses when a required taxonomy task type is missing (no silent omission)", () => {
    const artifact = buildDecisionArtifact(
      baseArtifactInputs({ requiredTaskTypes: ["classify", "reason-math", "code-review"] })
    );
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "taxonomy-incomplete" && i.taskType === "code-review")).toBe(true);
  });

  it("refuses a route naming a model outside the servable catalogue", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs({ servableModelIds: ["mellum"] })); // 80b missing
    expect(artifact.validation.ok).toBe(false);
    expect(
      artifact.validation.issues.some((i) => i.code === "model-unavailable" && i.taskType === "reason-math")
    ).toBe(true);
  });

  it("fails CLOSED when the serving catalogue is unavailable — never trusts a possibly-stale model id", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs({ servableModelIds: null }));
    expect(artifact.validation.ok).toBe(false);
    const modelIssues = artifact.validation.issues.filter((i) => i.code === "model-unavailable");
    expect(modelIssues.length).toBe(2); // both named-model routes refused
  });

  it("refuses a stale candidate (generatedAt older than the freshness bound)", () => {
    const candidate = makeDoc(
      { classify: { model: "mellum", verdict: "delegate-local", attempts: 10 } },
      { generatedAt: "2026-07-01T00:00:00.000Z" } // 19 days before NOW
    );
    const artifact = buildDecisionArtifact(
      baseArtifactInputs({ candidate, deterministicCandidate: candidate, requiredTaskTypes: ["classify"] })
    );
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "evidence-stale")).toBe(true);
  });

  it("refuses on a capability downgrade vs the adopted table (reuses diffRoutingTables' own classification)", () => {
    const adopted = { routing: { "reason-math": { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 20 } } };
    const candidate = makeDoc({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 10 },
      "reason-math": { model: null, verdict: "escalate-frontier", attempts: 0 },
    });
    const artifact = buildDecisionArtifact(
      baseArtifactInputs({ candidate, deterministicCandidate: candidate, adopted, requiredTaskTypes: ["classify", "reason-math"] })
    );
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "capability-downgrade" && i.taskType === "reason-math")).toBe(true);
  });

  it("refuses when the candidate was generated under a stale policy epoch", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs({ policyEpochHash: "epoch-1", expectedPolicyEpochHash: "epoch-2" }));
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "policy-epoch-mismatch")).toBe(true);
  });

  it("passes when every check clears: taxonomy complete, servable, fresh, no downgrade, current epoch, no organic dependence", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs());
    expect(artifact.validation.ok).toBe(true);
    expect(artifact.validation.issues).toEqual([]);
  });

  it("the artifact is a pure computation — never mutates its inputs", () => {
    const inputs = baseArtifactInputs();
    const beforeCandidate = JSON.stringify(inputs.candidate);
    buildDecisionArtifact(inputs);
    expect(JSON.stringify(inputs.candidate)).toBe(beforeCandidate);
  });

  it("humanDiff and machine diff are both present and consistent", () => {
    const adopted = { routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 5 } } };
    const artifact = buildDecisionArtifact(baseArtifactInputs({ adopted }));
    expect(artifact.humanDiff).toMatch(/semantic diff/);
    expect(artifact.diff.changes.length).toBeGreaterThan(0);
  });
});

// ── #6 admissibility — organic-judge evidence must not drive a route change ─────

function ledgerRow(p: {
  taskType: string;
  modelId: string;
  attempts: number;
  passes: number;
  recommendation: LedgerReportRow["recommendation"];
}): LedgerReportRow {
  return {
    nodeId: "m5",
    taskType: p.taskType,
    modelId: p.modelId,
    verdict: p.recommendation === "delegate-local" ? "viable" : p.recommendation === "escalate-frontier" ? "not_viable" : "unknown",
    attempts: p.attempts,
    passes: p.passes,
    partials: 0,
    fails: p.attempts - p.passes,
    errors: 0,
    successRate: p.passes / p.attempts,
    frozen: true,
    mechanicalFormatAttempts: 0,
    recommendation: p.recommendation,
    avgLatencyMs: 100,
    avgTokPerSec: 50,
    unverifiedShare: 0,
    formatOnlyShare: 0,
  };
}

const GO_ENABLED_GATE: CalibrationGateDecision = {
  schemaVersion: 1,
  policyId: "policy-1",
  generatedAt: "2026-07-19T00:00:00.000Z",
  verdict: "GO",
  reasons: ["all thresholds cleared"],
  thresholds: { minStratumN: 1, minPrecisionLowerBound: 0, minRecallLowerBound: 0, maxDisagreementUpperBound: 1 },
  metrics: {} as CalibrationGateDecision["metrics"],
  enabling: { reviewerId: "magnus", reason: "reviewed", decisionRef: "grimnir#88", reviewedAt: "2026-07-19T00:00:00.000Z" },
};

const GO_NOT_ENABLED_GATE: CalibrationGateDecision = { ...GO_ENABLED_GATE, enabling: null };

const HOLD_GATE: CalibrationGateDecision = {
  ...GO_ENABLED_GATE,
  verdict: "HOLD",
  reasons: ["insufficient audited sample"],
  enabling: null,
};

describe("#6 admissibility — organic-judge-only route changes require a GO+enabled gate", () => {
  it("blocks a route change explained ONLY by organic-judge (llm-judge) evidence when no gate is consulted", () => {
    const organicOnly = [ledgerRow({ taskType: "code-review", modelId: "mellum", attempts: 10, passes: 10, recommendation: "delegate-local" })];
    const noOrganic: LedgerReportRow[] = []; // deterministic-only view sees nothing for this type
    const { candidate, deterministicCandidate } = buildCandidatePair({
      verdicts: organicOnly,
      deterministicVerdicts: noOrganic,
      registry: [],
      sources: [],
      generatedAt: NOW,
      policy: { minSamples: 1 },
      routableTaskTypes: ["code-review"],
    });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate,
      adopted: null,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["code-review"],
      freshnessMaxAgeMs: ONE_DAY_MS,
      nowIso: NOW,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "inadmissible-organic-evidence" && i.taskType === "code-review")).toBe(true);
    expect(artifact.lineage.find((l) => l.taskType === "code-review")?.organicJudgeDependent).toBe(true);
  });

  it("blocks the same organic-judge-only change under a HOLD gate", () => {
    const organicOnly = [ledgerRow({ taskType: "code-review", modelId: "mellum", attempts: 10, passes: 10, recommendation: "delegate-local" })];
    const { candidate, deterministicCandidate } = buildCandidatePair({
      verdicts: organicOnly,
      deterministicVerdicts: [],
      registry: [],
      sources: [],
      generatedAt: NOW,
      policy: { minSamples: 1 },
      routableTaskTypes: ["code-review"],
    });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate,
      adopted: null,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["code-review"],
      freshnessMaxAgeMs: ONE_DAY_MS,
      nowIso: NOW,
      calibrationGate: HOLD_GATE,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.calibrationGate?.verdict).toBe("HOLD");
  });

  it("blocks an organic-judge-only change under a GO gate that is NOT enabled (measured GO ≠ enabled)", () => {
    const organicOnly = [ledgerRow({ taskType: "code-review", modelId: "mellum", attempts: 10, passes: 10, recommendation: "delegate-local" })];
    const { candidate, deterministicCandidate } = buildCandidatePair({
      verdicts: organicOnly,
      deterministicVerdicts: [],
      registry: [],
      sources: [],
      generatedAt: NOW,
      policy: { minSamples: 1 },
      routableTaskTypes: ["code-review"],
    });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate,
      adopted: null,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["code-review"],
      freshnessMaxAgeMs: ONE_DAY_MS,
      nowIso: NOW,
      calibrationGate: GO_NOT_ENABLED_GATE,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    expect(artifact.validation.ok).toBe(false);
  });

  it("ALLOWS the organic-judge-only change once the gate is GO with a recorded enablement", () => {
    const organicOnly = [ledgerRow({ taskType: "code-review", modelId: "mellum", attempts: 10, passes: 10, recommendation: "delegate-local" })];
    const { candidate, deterministicCandidate } = buildCandidatePair({
      verdicts: organicOnly,
      deterministicVerdicts: [],
      registry: [],
      sources: [],
      generatedAt: NOW,
      policy: { minSamples: 1 },
      routableTaskTypes: ["code-review"],
    });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate,
      adopted: null,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["code-review"],
      freshnessMaxAgeMs: ONE_DAY_MS,
      nowIso: NOW,
      calibrationGate: GO_ENABLED_GATE,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    expect(artifact.validation.ok).toBe(true);
    expect(artifact.lineage.find((l) => l.taskType === "code-review")?.organicJudgeDependent).toBe(true);
  });

  it("ALLOWS a route change backed by deterministic/verifier evidence even under a HOLD gate", () => {
    // The deterministic (organic-judge-excluded) view sees the SAME viable evidence — the change
    // survives the exclusion, so it is never gated by the #6 rule.
    const deterministicBacked = [ledgerRow({ taskType: "reason-math", modelId: "qwen3-coder-next-80b", attempts: 10, passes: 10, recommendation: "delegate-local" })];
    const { candidate, deterministicCandidate } = buildCandidatePair({
      verdicts: deterministicBacked,
      deterministicVerdicts: deterministicBacked, // survives exclusion — real verifier evidence
      registry: [],
      sources: [],
      generatedAt: NOW,
      policy: { minSamples: 1 },
      routableTaskTypes: ["reason-math"],
    });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate,
      adopted: null,
      servableModelIds: ["qwen3-coder-next-80b"],
      requiredTaskTypes: ["reason-math"],
      freshnessMaxAgeMs: ONE_DAY_MS,
      nowIso: NOW,
      calibrationGate: HOLD_GATE,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    expect(artifact.validation.ok).toBe(true);
    expect(artifact.lineage.find((l) => l.taskType === "reason-math")?.organicJudgeDependent).toBe(false);
  });

  it("an UNCHANGED route (vs adopted) is never flagged organic-dependent, whatever its evidence mix", () => {
    const adopted = { routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 5 } } };
    const artifact = buildDecisionArtifact(baseArtifactInputs({ adopted, requiredTaskTypes: ["classify"], candidate: makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 10 } }), deterministicCandidate: makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 10 } }) }));
    expect(artifact.lineage.find((l) => l.taskType === "classify")?.organicJudgeDependent).toBe(false);
  });
});

// ── Approval — the non-bypassable gate ───────────────────────────────────────────

describe("approveArtifact / artifactContentHash — non-bypassable approval", () => {
  it("refuses to approve an artifact that failed validation", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs({ servableModelIds: null }));
    expect(artifact.validation.ok).toBe(false);
    expect(() =>
      approveArtifact(artifact, { approvedBy: "magnus", reason: "test", decisionRef: "grimnir#7", approvedAt: NOW })
    ).toThrow(ApprovalRefusedError);
  });

  it("refuses an approval missing approvedBy/reason/decisionRef", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs());
    expect(() => approveArtifact(artifact, { approvedBy: "", reason: "x", decisionRef: "y", approvedAt: NOW })).toThrow();
    expect(() => approveArtifact(artifact, { approvedBy: "x", reason: "  ", decisionRef: "y", approvedAt: NOW })).toThrow();
  });

  it("a clean artifact can be approved, and the token binds to this exact artifact's content hash", () => {
    const artifact = buildDecisionArtifact(baseArtifactInputs());
    const approval = approveArtifact(artifact, { approvedBy: "magnus", reason: "looks good", decisionRef: "grimnir#7", approvedAt: NOW });
    expect(approval.artifactHash).toBe(artifactContentHash(artifact));
  });

  it("a token issued for a DIFFERENT artifact is rejected at adopt time", async () => {
    const artifactA = buildDecisionArtifact(baseArtifactInputs());
    const artifactB = buildDecisionArtifact(
      baseArtifactInputs({ candidate: makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 99 } }), deterministicCandidate: makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 99 } }), requiredTaskTypes: ["classify"] })
    );
    const approvalForB = approveArtifact(artifactB, { approvedBy: "magnus", reason: "for B", decisionRef: "grimnir#7", approvedAt: NOW });
    const deps = fakeDeps();
    await expect(adoptRoutingTable(artifactA, approvalForB, deps.deps)).rejects.toThrow(ApprovalMismatchError);
    expect(deps.fs.size).toBe(0); // never wrote anything
  });
});

// ── Deploy / reload / canary / rollback ──────────────────────────────────────────

function fakeDeps(overrides: { reload?: () => ReloadOutcome | Promise<ReloadOutcome>; servableModelIdsAfterReload?: () => string[] | null; currentPolicyEpochHash?: string; priorTable?: RoutingTableDoc } = {}) {
  const fs = new Map<string, string>();
  const tablePath = "/virtual/m5-routing.json";
  if (overrides.priorTable) fs.set(tablePath, JSON.stringify(overrides.priorTable, null, 2) + "\n");
  const deps: AdoptDeps = {
    tablePath,
    readTable: (p) => {
      if (!fs.has(p)) throw new Error(`ENOENT: ${p}`);
      return fs.get(p)!;
    },
    writeTable: (p, d) => {
      fs.set(p, d);
    },
    reload: overrides.reload ?? (() => ({ ok: true })),
    servableModelIdsAfterReload: overrides.servableModelIdsAfterReload ?? (() => ["mellum", "qwen3-coder-next-80b"]),
    nowIso: () => "2026-07-20T13:00:00.000Z",
    currentPolicyEpochHash: overrides.currentPolicyEpochHash ?? "epoch-1",
  };
  return { deps, fs, tablePath };
}

function approvedArtifact(overrides: Partial<Parameters<typeof buildDecisionArtifact>[0]> = {}): { artifact: RoutingDecisionArtifact; approval: ReturnType<typeof approveArtifact> } {
  const artifact = buildDecisionArtifact(baseArtifactInputs(overrides));
  const approval = approveArtifact(artifact, { approvedBy: "magnus", reason: "test adoption", decisionRef: "grimnir#7", approvedAt: NOW });
  return { artifact, approval };
}

describe("adoptRoutingTable — the ONLY mutating function", () => {
  it("adoption without an approval argument is not callable — the function requires one (compile-time), and a mismatched token is rejected (runtime)", async () => {
    // Runtime half proven in the approval describe block above; this asserts the same guard fires
    // even for a token that is well-formed but simply stale (re-approved after the artifact content
    // would have changed) by mutating the approval's artifactHash directly.
    const { artifact, approval } = approvedArtifact();
    const tampered = { ...approval, artifactHash: "sha256:" + "0".repeat(64) };
    const deps = fakeDeps();
    await expect(adoptRoutingTable(artifact, tampered, deps.deps)).rejects.toThrow(ApprovalMismatchError);
  });

  it("a successful adopt snapshots the prior table, writes the candidate, reloads, and records identity+lineage", async () => {
    const priorTable = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 } });
    const { artifact, approval } = approvedArtifact();
    const deps = fakeDeps({ priorTable });
    const before = deps.fs.get(deps.tablePath)!;

    const result = await adoptRoutingTable(artifact, approval, deps.deps);

    expect(result.outcome).toBe("adopted");
    if (result.outcome !== "adopted") throw new Error("unreachable");
    expect(result.record.candidateHash).toBe(artifact.candidateHash);
    expect(result.record.approvedBy).toBe("magnus");
    expect(result.record.lineage.length).toBeGreaterThan(0);
    // The live file now holds the candidate, not the prior snapshot.
    expect(deps.fs.get(deps.tablePath)).not.toBe(before);
    expect(JSON.parse(deps.fs.get(deps.tablePath)!).routing["reason-math"]).toBeDefined();
  });

  it("refuses to adopt when the routing policy epoch changed since review (PolicyEpochStaleError)", async () => {
    const { artifact, approval } = approvedArtifact();
    const deps = fakeDeps({ currentPolicyEpochHash: "epoch-2" }); // artifact was built with epoch-1
    await expect(adoptRoutingTable(artifact, approval, deps.deps)).rejects.toThrow(PolicyEpochStaleError);
    expect(deps.fs.size).toBe(0); // refused BEFORE any write
  });

  it("a failed reload triggers automatic rollback to the EXACT prior bytes and records the event", async () => {
    const priorTable = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 } });
    const { artifact, approval } = approvedArtifact();
    const deps = fakeDeps({ priorTable, reload: () => ({ ok: false, error: "gateway unreachable" }) });
    const priorBytes = deps.fs.get(deps.tablePath)!;

    const result = await adoptRoutingTable(artifact, approval, deps.deps);

    expect(result.outcome).toBe("reload-failed");
    if (result.outcome !== "reload-failed") throw new Error("unreachable");
    expect(result.rollback.reason).toMatch(/reload failed/);
    expect(result.rollback.reason).toMatch(/gateway unreachable/);
    // EXACT prior bytes restored, not a re-serialized approximation.
    expect(deps.fs.get(deps.tablePath)).toBe(priorBytes);
  });

  it("a failed canary (route resolves to the WRONG target after reload) rolls back to the exact prior table", async () => {
    const priorTable = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 } });
    const { artifact, approval } = approvedArtifact();
    const priorBytes = JSON.stringify(priorTable, null, 2) + "\n";
    const fs = new Map<string, string>([["/virtual/m5-routing.json", priorBytes]]);
    // reload "succeeds" per the gateway, but the on-disk file it re-parses is WRONG (simulates a
    // write/reload race or truncation) — the canary must catch this even though reload reported ok.
    const deps: AdoptDeps = {
      tablePath: "/virtual/m5-routing.json",
      readTable: (p) => fs.get(p) ?? (() => { throw new Error("ENOENT"); })(),
      writeTable: (p, d) => {
        // Every write after the first (the candidate write) is corrupted to a stale reason-math route.
        if (fs.size > 0 && d !== priorBytes) {
          fs.set(p, JSON.stringify(makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 }, "reason-math": { model: "mellum", verdict: "delegate-local", attempts: 1 } })));
        } else {
          fs.set(p, d);
        }
      },
      reload: () => ({ ok: true }),
      servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b"],
      nowIso: () => "2026-07-20T13:00:00.000Z",
      currentPolicyEpochHash: "epoch-1",
    };

    const result = await adoptRoutingTable(artifact, approval, deps);

    expect(result.outcome).toBe("rolled-back");
    if (result.outcome !== "rolled-back") throw new Error("unreachable");
    expect(result.canary.ok).toBe(false);
    expect(result.rollback.reason).toMatch(/canary failed/);
    expect(fs.get("/virtual/m5-routing.json")).toBe(priorBytes); // exact restoration
  });

  it("a canary failure from an unavailable model (became unservable between validate and deploy) also rolls back", async () => {
    const { artifact, approval } = approvedArtifact();
    const deps = fakeDeps({ servableModelIdsAfterReload: () => ["mellum"] }); // 80b vanished post-reload
    const result = await adoptRoutingTable(artifact, approval, deps.deps);
    expect(result.outcome).toBe("rolled-back");
  });

  it("first-ever adoption (no prior table on disk) adopts cleanly, and a subsequent failure rolls back to '(none)' gracefully", async () => {
    const { artifact, approval } = approvedArtifact();
    const deps = fakeDeps(); // no priorTable seeded
    const result = await adoptRoutingTable(artifact, approval, deps.deps);
    expect(result.outcome).toBe("adopted");

    // Now simulate a first-ever adoption that fails reload — rollback must not throw even with no prior bytes.
    const deps2 = fakeDeps({ reload: () => ({ ok: false, error: "boom" }) });
    const result2 = await adoptRoutingTable(artifact, approval, deps2.deps);
    expect(result2.outcome).toBe("reload-failed");
    if (result2.outcome !== "reload-failed") throw new Error("unreachable");
    expect(result2.rollback.restoredHash).toMatch(/none/);
  });

  it("a candidate WRITE that throws (e.g. disk full) never crashes — routes through rollback with a structured record (M5 dogfood finding)", async () => {
    const priorTable = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 } });
    const { artifact, approval } = approvedArtifact();
    const priorBytes = JSON.stringify(priorTable, null, 2) + "\n";
    let reloadCalls = 0;
    const deps: AdoptDeps = {
      tablePath: "/virtual/m5-routing.json",
      readTable: (p) => (p === "/virtual/m5-routing.json" ? priorBytes : (() => { throw new Error("ENOENT"); })()),
      writeTable: () => {
        throw new Error("ENOSPC: no space left on device");
      },
      reload: () => {
        reloadCalls++;
        return { ok: true };
      },
      servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b"],
      nowIso: () => "2026-07-20T13:00:00.000Z",
      currentPolicyEpochHash: "epoch-1",
    };

    const result = await adoptRoutingTable(artifact, approval, deps);

    expect(result.outcome).toBe("write-failed");
    if (result.outcome !== "write-failed") throw new Error("unreachable");
    expect(result.rollback.reason).toMatch(/candidate write failed/);
    expect(result.rollback.reason).toMatch(/ENOSPC/);
    // The write always throws in this fixture (including the rollback's OWN restore attempt), so
    // the rollback restore write also fails — and that must be reported structurally, not thrown.
    expect(result.rollback.restoreWriteOk).toBe(false);
    expect(result.rollback.restoreWriteError).toMatch(/ENOSPC/);
    expect(reloadCalls).toBe(1); // reload is still attempted best-effort even after a failed restore write
  });

  it("a rollback whose restore WRITE succeeds reports restoreWriteOk: true (the common case)", async () => {
    const priorTable = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 } });
    const { artifact, approval } = approvedArtifact();
    const deps = fakeDeps({ priorTable, reload: () => ({ ok: false, error: "gateway unreachable" }) });

    const result = await adoptRoutingTable(artifact, approval, deps.deps);

    expect(result.outcome).toBe("reload-failed");
    if (result.outcome !== "reload-failed") throw new Error("unreachable");
    expect(result.rollback.restoreWriteOk).toBe(true);
    expect(result.rollback.restoreWriteError).toBeUndefined();
  });

  it("a rollback restore-write failure during a CANARY-triggered rollback surfaces in the record too, never as an uncaught rejection", async () => {
    const priorTable = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 3 } });
    const priorBytes = JSON.stringify(priorTable, null, 2) + "\n";
    const { artifact, approval } = approvedArtifact();
    let writeCount = 0;
    const deps: AdoptDeps = {
      tablePath: "/virtual/m5-routing.json",
      readTable: (p) => (p === "/virtual/m5-routing.json" ? priorBytes : (() => { throw new Error("ENOENT"); })()),
      writeTable: () => {
        writeCount++;
        if (writeCount === 1) return; // the candidate write itself succeeds
        throw new Error("EIO: rollback restore write failed"); // but the rollback's restore write fails
      },
      reload: () => ({ ok: true }),
      servableModelIdsAfterReload: () => ["mellum"], // 80b unavailable — forces a canary failure below
      nowIso: () => "2026-07-20T13:00:00.000Z",
      currentPolicyEpochHash: "epoch-1",
    };

    const result = await adoptRoutingTable(artifact, approval, deps);

    expect(result.outcome).toBe("rolled-back");
    if (result.outcome !== "rolled-back") throw new Error("unreachable");
    expect(result.rollback.restoreWriteOk).toBe(false);
    expect(result.rollback.reason).toMatch(/UNKNOWN state, manual recovery required/);
  });
});

describe("runCanary", () => {
  it("passes when the reloaded table resolves every changed route as intended and the model is servable", () => {
    const candidate = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 10 } });
    const outcome = runCanary({
      changedTaskTypes: ["classify"],
      reloadedTable: { routing: candidate.routing, escalateToFrontier: [] },
      candidate,
      servableModelIds: ["mellum"],
    });
    expect(outcome.ok).toBe(true);
  });

  it("fails when the reloaded table diverges from the candidate for a changed route", () => {
    const candidate = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 10 } });
    const outcome = runCanary({
      changedTaskTypes: ["classify"],
      reloadedTable: { routing: { classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local" } }, escalateToFrontier: [] },
      candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.checks[0]?.ok).toBe(false);
  });

  it("fails closed when the servable catalogue is unavailable for a changed route naming a real model", () => {
    const candidate = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 10 } });
    const outcome = runCanary({
      changedTaskTypes: ["classify"],
      reloadedTable: { routing: candidate.routing, escalateToFrontier: [] },
      candidate,
      servableModelIds: null,
    });
    expect(outcome.ok).toBe(false);
  });
});

describe("manualRollback — the documented manual command", () => {
  it("restores an arbitrary snapshot and reports reload status", async () => {
    const snapshot = JSON.stringify(makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 1 } }));
    const deps = fakeDeps();
    const record = await manualRollback({ deps: deps.deps, snapshotRaw: snapshot, reason: "operator-invoked recovery" });
    expect(record.reloadOk).toBe(true);
    expect(deps.fs.get(deps.tablePath)).toBe(snapshot);
    expect(record.reason).toBe("operator-invoked recovery");
  });
});
