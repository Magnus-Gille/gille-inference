/**
 * autonomy-controller.ts test suite (issue #49 — the Phase 4 capstone, subsuming issue #46's
 * standing-proposal behavior as this controller's Tier-0 mode).
 *
 * Mirrors adoption-watchdog.test.ts's own discipline: the adopt-path tests reuse REAL
 * `adoptRoutingTable`/`recordAdoptionForWatch`/`runAdoptionWatch` (never mocked) against an
 * in-memory `AdoptDeps` fs and a real temp `dataDir`, so "adopt invoked" / "watch window opened"
 * are proven via observable durable state rather than a spy on an internal function.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAutonomyTick,
  evaluateStatisticalSufficiency,
  computeRiskBudgetStatus,
  routeCooldownActive,
  buildAxisArtifactInputs,
  computeAutonomousRevertRate,
  loadTierState,
  saveTierState,
  loadStandingProposal,
  autonomyPaths,
  emptyTierState,
  DEFAULT_AUTONOMY_POLICY,
  AUTONOMY_APPROVER_PREFIX,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
  type AdoptedRawEntry,
  type TierState,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  saveQuarantineState,
  recordAdoptionForWatch,
  type GuardMetricSnapshot,
  type QuarantineState,
} from "../src/homeserver/adoption-watchdog.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import type { DiffableRoutingTable } from "../src/homeserver/routing-table-diff.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const NOW = "2026-07-21T00:00:00.000Z";

type RouteSpec = { model: string | null; verdict: string; attempts: number; passRate?: number; tokPerSec?: number | null };

function makeDoc(routing: Record<string, RouteSpec>, opts: { generatedAt?: string } = {}): RoutingTableDoc {
  return {
    _comment: "test fixture",
    _generator: "test",
    generatedAt: opts.generatedAt ?? NOW,
    sources: [],
    globalRule: "test",
    routing: Object.fromEntries(
      Object.entries(routing).map(([k, v]) => [
        k,
        {
          model: v.model,
          passRate: v.passRate ?? 1,
          tokPerSec: v.tokPerSec ?? null,
          verdict: v.verdict as "delegate-local" | "explore" | "escalate-frontier",
          attempts: v.attempts,
        },
      ])
    ),
    escalateToFrontier: Object.entries(routing)
      .filter(([, v]) => v.model === null)
      .map(([k]) => k),
    avoidForShortTasks: [],
    modelProfiles: {},
  };
}

const TEST_POLICY: AutonomyPolicyConfig = {
  marginDelta: 0.05,
  minSampleSize: 5,
  confidenceZ: 1.96,
  maxAdoptionsPerWindow: 3,
  riskBudgetWindowHours: 7 * 24,
  perRouteCooldownHours: 24,
  tier1UnlockCycles: 2,
  tier2RevertRateMax: 0.2,
  protectedRoutes: new Set<string>(),
};

/** A single "classify" axis: adopted mellum@0.5 (n=50) -> candidate qwen@0.9 (n=40), a
 *  model-change that clears statistical sufficiency by a wide margin and is verifier-backed
 *  (deterministicCandidate === candidate, so no organic dependence). */
function baseReview(overrides: Partial<AutonomyReviewInputs> = {}): AutonomyReviewInputs {
  const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
  const adopted: DiffableRoutingTable = {
    routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50 } },
  };
  const adoptedRaw: Record<string, AdoptedRawEntry | undefined> = {
    classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5, tokPerSec: null },
  };
  return {
    candidate,
    deterministicCandidate: candidate,
    adopted,
    adoptedRaw,
    servableModelIds: ["mellum", "qwen3-coder-next-80b"],
    requiredTaskTypes: ["classify"],
    freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
    calibrationGate: null,
    policyEpochHash: "epoch-1",
    expectedPolicyEpochHash: "epoch-1",
    ...overrides,
  };
}

/** A review with NO semantic changes at all (candidate === adopted) — the "healthy no-op cycle". */
function noopReview(): AutonomyReviewInputs {
  const candidate = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
  const adopted: DiffableRoutingTable = {
    routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50 } },
  };
  return {
    candidate,
    deterministicCandidate: candidate,
    adopted,
    adoptedRaw: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5, tokPerSec: null } },
    servableModelIds: ["mellum"],
    requiredTaskTypes: ["classify"],
    freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
    calibrationGate: null,
    policyEpochHash: "epoch-1",
    expectedPolicyEpochHash: "epoch-1",
  };
}

function fakeAdoptDeps(p: {
  initialTable: string;
  reload?: () => ReloadOutcome;
}): { deps: AdoptDeps; fs: Map<string, string>; tablePath: string } {
  const tablePath = "/virtual/m5-routing.json";
  const fs = new Map<string, string>([[tablePath, p.initialTable]]);
  const deps: AdoptDeps = {
    tablePath,
    readTable: (path) => {
      if (!fs.has(path)) throw new Error(`ENOENT: ${path}`);
      return fs.get(path)!;
    },
    writeTable: (path, data) => fs.set(path, data),
    reload: p.reload ?? (() => ({ ok: true })),
    servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b"],
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
  };
  return { deps, fs, tablePath };
}

const ADOPTED_TABLE_JSON = JSON.stringify({
  routing: { classify: { model: "mellum", passRate: 0.5, tokPerSec: null, verdict: "delegate-local", attempts: 50 } },
  escalateToFrontier: [],
});

function baseTickDeps(p: {
  dataDir: string;
  review?: AutonomyReviewInputs;
  policy?: AutonomyPolicyConfig;
  killSwitchOn?: () => boolean;
  queryGuardMetrics?: AutonomyTickDeps["queryGuardMetrics"];
  adoptDepsFixture?: ReturnType<typeof fakeAdoptDeps>;
}): { deps: AutonomyTickDeps; fs: Map<string, string>; tablePath: string } {
  const adoptFixture = p.adoptDepsFixture ?? fakeAdoptDeps({ initialTable: ADOPTED_TABLE_JSON });
  const deps: AutonomyTickDeps = {
    dataDir: p.dataDir,
    nowIso: () => NOW,
    killSwitchOn: p.killSwitchOn ?? (() => false),
    decisionRef: "gille-inference#49",
    policy: p.policy ?? TEST_POLICY,
    watchdogPolicy: {
      windowHours: 1,
      windowTaskCap: 1000,
      metrics: {
        errorRate: { minSample: 5, absoluteFloor: 0.05, relativeBound: 0.5 },
        escalationRate: { minSample: 5, absoluteFloor: 0.1, relativeBound: 0.5 },
        verifierFailRate: { minSample: 5, absoluteFloor: 0.05, relativeBound: 0.5 },
        retryRate: { minSample: 5, absoluteFloor: 0.1, relativeBound: 0.5 },
        latencyP50Ms: { minSample: 5, absoluteFloor: 500, relativeBound: 0.5 },
      },
      cooldownHours: 24,
      requiredMarginDelta: 0.1,
    },
    review: p.review ?? baseReview(),
    queryGuardMetrics: p.queryGuardMetrics ?? (() => []),
    adoptDeps: adoptFixture.deps,
  };
  return { deps, fs: adoptFixture.fs, tablePath: adoptFixture.tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-controller-"));
}

function snapshot(overrides: Partial<GuardMetricSnapshot> & { taskType: string }): GuardMetricSnapshot {
  return {
    sampleSize: 20,
    errorRate: 0.05,
    escalationRate: 0.1,
    verifierFailRate: 0.05,
    retryRate: 0.1,
    latencyP50Ms: 1000,
    ...overrides,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────────

describe("evaluateStatisticalSufficiency", () => {
  it("is insufficient below the minimum sample size N, regardless of pass rate", () => {
    const r = evaluateStatisticalSufficiency({ challengerAttempts: 3, challengerPassRate: 1, incumbentPassRate: 0 }, TEST_POLICY);
    expect(r.sufficient).toBe(false);
    expect(r.ciLower).toBeNull();
  });

  it("is sufficient when the CI lower bound clears the incumbent by >= delta", () => {
    const r = evaluateStatisticalSufficiency({ challengerAttempts: 40, challengerPassRate: 0.9, incumbentPassRate: 0.5 }, TEST_POLICY);
    expect(r.sufficient).toBe(true);
    expect(r.ciLower).toBeGreaterThan(0.55);
  });

  it("is insufficient when the CI lower bound is close to the incumbent (thin margin)", () => {
    const r = evaluateStatisticalSufficiency({ challengerAttempts: 10, challengerPassRate: 0.55, incumbentPassRate: 0.5 }, TEST_POLICY);
    expect(r.sufficient).toBe(false);
  });

  it("treats a null incumbent (brand-new route) as baseline 0", () => {
    const r = evaluateStatisticalSufficiency({ challengerAttempts: 40, challengerPassRate: 0.9, incumbentPassRate: null }, TEST_POLICY);
    expect(r.sufficient).toBe(true);
  });
});

describe("computeRiskBudgetStatus / routeCooldownActive", () => {
  it("counts only autonomous adoptions within the trailing window", () => {
    const records = [
      { id: "1", adoptedAt: "2026-07-20T00:00:00.000Z", candidateHash: "h1", decisionRef: "r", approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`, changedTaskTypes: ["a"], snapshotPath: null, status: "pending" as const, lastEvaluatedAt: null },
      { id: "2", adoptedAt: "2026-07-20T00:00:00.000Z", candidateHash: "h2", decisionRef: "r", approvedBy: "magnus", changedTaskTypes: ["b"], snapshotPath: null, status: "pending" as const, lastEvaluatedAt: null },
      { id: "3", adoptedAt: "2020-01-01T00:00:00.000Z", candidateHash: "h3", decisionRef: "r", approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`, changedTaskTypes: ["c"], snapshotPath: null, status: "pending" as const, lastEvaluatedAt: null },
    ];
    const status = computeRiskBudgetStatus(records, NOW, TEST_POLICY);
    expect(status.used).toBe(1); // only record "1" is autonomous AND within the window
    expect(status.remaining).toBe(2);
  });

  it("route cooldown is active only for the specific taskType, until perRouteCooldownHours after its last autonomous adoption", () => {
    const records = [
      recordAdoptionForWatch({
        dataDir: tmp(),
        adoptedAt: "2026-07-20T12:00:00.000Z", // 12h before NOW
        candidateHash: "h1",
        decisionRef: "r",
        approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
        changedTaskTypes: ["classify"],
        priorRaw: null,
      }),
    ];
    expect(routeCooldownActive(records, "classify", NOW, TEST_POLICY).active).toBe(true); // 24h cooldown, only 12h elapsed
    expect(routeCooldownActive(records, "extract", NOW, TEST_POLICY).active).toBe(false); // different axis
  });
});

describe("computeAutonomousRevertRate", () => {
  it("is 0 with no autonomous adoptions (no evidence of failure, not a refusal)", () => {
    expect(computeAutonomousRevertRate([])).toBe(0);
  });
});

describe("buildAxisArtifactInputs — one-axis isolation", () => {
  it("reverts every OTHER changed axis to its adopted value so the diff sees it as unchanged", () => {
    const fullCandidate = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
      extract: { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const adopted: DiffableRoutingTable = {
      routing: {
        classify: { model: "mellum", verdict: "delegate-local", attempts: 50 },
        extract: { model: "mellum", verdict: "delegate-local", attempts: 50 },
      },
    };
    const adoptedRaw: Record<string, AdoptedRawEntry | undefined> = {
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    };
    const { axisCandidate, axisBaseline } = buildAxisArtifactInputs(fullCandidate, adopted, adoptedRaw, "classify", ["classify", "extract"]);
    expect(axisCandidate.routing["classify"]?.model).toBe("qwen3-coder-next-80b"); // the target axis is untouched
    expect(axisCandidate.routing["extract"]?.model).toBe("mellum"); // reverted
    expect(axisBaseline.routing?.["extract"]?.model).toBe("mellum");
    expect(axisBaseline.routing?.["extract"]?.attempts).toBe(50);
  });

  it("isolates a BRAND-NEW ('added') axis correctly — the other new axis reads as unchanged even though the real adopted table never had it", () => {
    const fullCandidate = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
      "brand-new-type": { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const adopted: DiffableRoutingTable = { routing: {} }; // neither type has ever been adopted
    const adoptedRaw: Record<string, AdoptedRawEntry | undefined> = {};
    const { axisCandidate, axisBaseline } = buildAxisArtifactInputs(
      fullCandidate,
      adopted,
      adoptedRaw,
      "classify",
      ["classify", "brand-new-type"]
    );
    // The stub value for the untouched "brand-new-type" axis must be IDENTICAL on both sides so
    // diffRoutingTables classifies it "unchanged" despite the real adopted table lacking the key.
    expect(axisCandidate.routing["brand-new-type"]?.model).toBeNull();
    expect(axisBaseline.routing?.["brand-new-type"]?.model).toBeNull();
    expect(axisBaseline.routing?.["brand-new-type"]?.verdict).toBe("escalate-frontier");
  });
});

// ── runAutonomyTick — Tier 0 (subsumes issue #46) ─────────────────────────────────

describe("runAutonomyTick — Tier 0: propose-only", () => {
  it("leaves a standing proposal and increments the healthy-cycle count, without adopting", async () => {
    const dataDir = tmp();
    const { deps } = baseTickDeps({ dataDir });

    const report = await runAutonomyTick(deps);

    expect(report.tierBefore).toBe(0);
    expect(report.tierAfter).toBe(0); // 1 healthy cycle < tier1UnlockCycles=2
    expect(report.healthyCycle).toBe(true);
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations).toHaveLength(1);
    // All PREDICATES pass, but Tier 0 itself never allows adoption — `eligible` correctly folds in
    // the tier rule, and the reason names exactly why.
    expect(report.axisEvaluations[0]?.eligible).toBe(false);
    expect(report.axisEvaluations[0]?.statisticallySufficient).toBe(true);
    expect(report.axisEvaluations[0]?.validationOk).toBe(true);
    expect(report.axisEvaluations[0]?.reasons).toContain("tier-0: propose-only (never auto-adopts)");
    expect(report.standingProposal?.hasProposal).toBe(true);

    const tierState = loadTierState(dataDir);
    expect(tierState.tier).toBe(0);
    expect(tierState.consecutiveHealthyCycles).toBe(1);
    expect(loadStandingProposal(dataDir)?.hasProposal).toBe(true);
  });
});

// ── runAutonomyTick — Tier 1 adoption ──────────────────────────────────────────────

describe("runAutonomyTick — Tier 1: auto-adopts a verifier-backed, all-predicates-pass axis", () => {
  it("adopts (real #7 adopt) and opens a #47 watch window", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null });
    const { deps, fs, tablePath } = baseTickDeps({ dataDir });

    const report = await runAutonomyTick(deps);

    expect(report.adopted).toHaveLength(1);
    expect(report.adopted[0]?.outcome.outcome).toBe("adopted");
    expect(report.adopted[0]?.watchRecord).toBeDefined();
    expect(report.standingProposal?.hasProposal).toBe(false); // fully resolved this tick

    // The live table now holds the new candidate's route — the REAL #7 adopt path ran.
    const written = JSON.parse(fs.get(tablePath)!);
    expect(written.routing.classify.model).toBe("qwen3-coder-next-80b");

    // The #47 watch window was opened for this exact adoption.
    const watchState = loadWatchdogState(dataDir);
    expect(watchState.records).toHaveLength(1);
    expect(watchState.records[0]?.status).toBe("pending");
    expect(watchState.records[0]?.approvedBy).toBe(`${AUTONOMY_APPROVER_PREFIX}1`);
    expect(watchState.records[0]?.changedTaskTypes).toEqual(["classify"]);
  });
});

// ── Individual predicate failures ─────────────────────────────────────────────────

describe("runAutonomyTick — each predicate failure individually blocks adoption with its specific reason", () => {
  async function tierOneTick(overrides: {
    dataDir: string;
    review?: AutonomyReviewInputs;
    policy?: AutonomyPolicyConfig;
  }) {
    saveTierState(overrides.dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null });
    const { deps } = baseTickDeps(overrides);
    return runAutonomyTick(deps);
  }

  it("statistical insufficiency (thin sample)", async () => {
    const dataDir = tmp();
    const review = baseReview({
      candidate: makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 2, passRate: 1 } }),
      deterministicCandidate: makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 2, passRate: 1 } }),
    });
    const report = await tierOneTick({ dataDir, review });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.startsWith("insufficient-statistical-evidence"))).toBe(true);
  });

  it("protected-route (hard-coded deny list)", async () => {
    const dataDir = tmp();
    const report = await tierOneTick({ dataDir, policy: { ...TEST_POLICY, protectedRoutes: new Set(["classify"]) } });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.protectedRoute).toBe(true);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.includes("protected-route: requires-owner"))).toBe(true);
  });

  it("risk-budget-exhausted (K already used this window)", async () => {
    const dataDir = tmp();
    for (const t of ["extract", "summarize", "rewrite"]) {
      recordAdoptionForWatch({
        dataDir,
        adoptedAt: "2026-07-20T12:00:00.000Z",
        candidateHash: `h-${t}`,
        decisionRef: "r",
        approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
        changedTaskTypes: [t],
        priorRaw: null,
      });
    }
    const report = await tierOneTick({ dataDir });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.riskBudgetAvailable).toBe(false);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.startsWith("risk-budget-exhausted"))).toBe(true);
  });

  it("quarantined-axis (blocked until cooldown + stronger margin)", async () => {
    const dataDir = tmp();
    const quarantine: QuarantineState = {
      schemaVersion: 1,
      byTaskType: {
        classify: {
          taskType: "classify",
          quarantinedAt: "2026-07-20T00:00:00.000Z",
          reason: "test breach",
          cooldownUntil: "2026-07-25T00:00:00.000Z", // in the future relative to NOW
          requiredMarginDelta: 0.1,
          baselinePassRateAtQuarantine: 0.5,
          clearedAt: null,
        },
      },
    };
    saveQuarantineState(dataDir, quarantine);
    const report = await tierOneTick({ dataDir });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.quarantined).toBe(true);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.startsWith("quarantined-axis"))).toBe(true);
  });

  it("route-cooldown-active (this exact axis was autonomously adopted too recently)", async () => {
    const dataDir = tmp();
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T12:00:00.000Z", // 12h before NOW; cooldown is 24h
      candidateHash: "h-prior",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw: null,
    });
    const report = await tierOneTick({ dataDir });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.cooldownActive).toBe(true);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.startsWith("route-cooldown-active"))).toBe(true);
  });

  it("validation failure (a capability downgrade) blocks with the validation reason", async () => {
    const dataDir = tmp();
    // adopted is delegate-local(mellum); candidate downgrades to escalate-frontier.
    const review = baseReview({
      candidate: makeDoc({ classify: { model: null, verdict: "escalate-frontier", attempts: 0, passRate: 0 } }),
      deterministicCandidate: makeDoc({ classify: { model: null, verdict: "escalate-frontier", attempts: 0, passRate: 0 } }),
    });
    const report = await tierOneTick({ dataDir, review });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.validationOk).toBe(false);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.startsWith("validation: capability-downgrade"))).toBe(true);
  });

  it("Tier 1 refuses an organic-judge-dependent axis (requires Tier 2)", async () => {
    const dataDir = tmp();
    // deterministic (organic-excluded) regeneration finds NOTHING for classify — the change is
    // explained only by organic-judge evidence.
    const review = baseReview({ deterministicCandidate: makeDoc({}) , requiredTaskTypes: ["classify"] });
    const report = await tierOneTick({ dataDir, review });
    expect(report.adopted).toHaveLength(0);
    expect(report.axisEvaluations[0]?.verifierBacked).toBe(false);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.includes("tier-1: organic-judge-dependent"))).toBe(true);
  });
});

// ── Kill switch ────────────────────────────────────────────────────────────────────

describe("runAutonomyTick — kill switch", () => {
  it("evaluates and records everything but never adopts or promotes; demotion still applies", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 5, lastCycleAt: null, lastEvent: null });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z", // well before NOW, window (1h) completes immediately
      candidateHash: "h-prior",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}2`,
      changedTaskTypes: ["extract"],
      priorRaw: ADOPTED_TABLE_JSON,
    });

    const { deps } = baseTickDeps({
      dataDir,
      killSwitchOn: () => true,
      queryGuardMetrics: (taskTypes, _since, untilIso) => {
        const isBaseline = untilIso === "2026-07-17T00:00:00.000Z";
        return taskTypes.map((t) => snapshot({ taskType: t, errorRate: isBaseline ? 0.05 : 0.3 })); // breach on "extract"
      },
    });

    const report = await runAutonomyTick(deps);

    expect(report.killSwitchActive).toBe(true);
    expect(report.watch.items[0]?.evaluation.verdict).toBe("breach");
    expect(report.watch.items[0]?.action).toBe("would-revert"); // #47's own kill-switch semantics: detected, not acted on

    // Demotion still applies despite the kill switch.
    expect(report.tierBefore).toBe(2);
    expect(report.tierAfter).toBe(1);
    expect(report.tierEvent?.kind).toBe("demotion");

    // The "classify" axis would otherwise be fully eligible (Tier 1 allows verifier-backed changes)
    // — proving predicates were evaluated — but nothing was actually adopted.
    expect(report.axisEvaluations[0]?.eligible).toBe(true);
    expect(report.adopted).toHaveLength(0);

    // No promotion occurred even though consecutiveHealthyCycles was reset by the demotion, not by
    // reaching a promotion threshold.
    const tierState = loadTierState(dataDir);
    expect(tierState.tier).toBe(1);
    expect(tierState.consecutiveHealthyCycles).toBe(0);
  });
});

// ── Breach-revert demotion ─────────────────────────────────────────────────────────

describe("runAutonomyTick — a watchdog breach-revert demotes the tier and resets progress", () => {
  it("demotes one level and resets consecutiveHealthyCycles to 0", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 7, lastCycleAt: null, lastEvent: null });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z",
      candidateHash: "h-prior",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}2`,
      changedTaskTypes: ["extract"],
      priorRaw: ADOPTED_TABLE_JSON,
    });

    const { deps } = baseTickDeps({
      dataDir,
      review: noopReview(), // isolate the demotion behavior from any adoption logic
      queryGuardMetrics: (taskTypes, _since, untilIso) => {
        const isBaseline = untilIso === "2026-07-17T00:00:00.000Z";
        return taskTypes.map((t) => snapshot({ taskType: t, errorRate: isBaseline ? 0.05 : 0.3 }));
      },
    });

    const report = await runAutonomyTick(deps);

    expect(report.watch.items[0]?.action).toBe("reverted");
    expect(report.tierBefore).toBe(2);
    expect(report.tierAfter).toBe(1);
    expect(report.tierEvent?.kind).toBe("demotion");
    expect(report.tierEvent?.fromTier).toBe(2);
    expect(report.tierEvent?.toTier).toBe(1);

    const tierState = loadTierState(dataDir);
    expect(tierState.tier).toBe(1);
    expect(tierState.consecutiveHealthyCycles).toBe(0);
  });
});

// ── Tier unlock ──────────────────────────────────────────────────────────────────

describe("runAutonomyTick — tier unlock at C1 healthy cycles", () => {
  it("promotes Tier 0 -> Tier 1 once consecutiveHealthyCycles reaches tier1UnlockCycles", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 0, consecutiveHealthyCycles: TEST_POLICY.tier1UnlockCycles - 1, lastCycleAt: null, lastEvent: null });
    const { deps } = baseTickDeps({ dataDir, review: noopReview() });

    const report = await runAutonomyTick(deps);

    expect(report.tierBefore).toBe(0);
    expect(report.tierAfter).toBe(1);
    expect(report.tierEvent?.kind).toBe("promotion");
    expect(report.tierEvent?.fromTier).toBe(0);
    expect(report.tierEvent?.toTier).toBe(1);

    const tierState = loadTierState(dataDir);
    expect(tierState.tier).toBe(1);
    expect(tierState.consecutiveHealthyCycles).toBe(0); // reset after promotion
  });
});

// ── Idempotent re-tick ─────────────────────────────────────────────────────────────

describe("runAutonomyTick — idempotent re-tick", () => {
  it("a second tick against the freshly-adopted table produces no duplicate proposal or adoption", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null });
    const { deps, fs, tablePath } = baseTickDeps({ dataDir });

    const first = await runAutonomyTick(deps);
    expect(first.adopted).toHaveLength(1);
    expect(loadWatchdogState(dataDir).records).toHaveLength(1);

    // Simulate a fresh CLI re-read: the live table now reflects the just-adopted route.
    const writtenRaw = fs.get(tablePath)!;
    const written = JSON.parse(writtenRaw) as { routing: Record<string, { model: string | null; verdict: string; attempts: number; passRate?: number; tokPerSec?: number | null }> };
    const freshAdopted: DiffableRoutingTable = { routing: written.routing };
    const freshAdoptedRaw: Record<string, AdoptedRawEntry | undefined> = Object.fromEntries(
      Object.entries(written.routing).map(([k, v]) => [k, v])
    );

    const { deps: deps2 } = baseTickDeps({
      dataDir,
      review: baseReview({ adopted: freshAdopted, adoptedRaw: freshAdoptedRaw }), // same candidate proposal, now already-adopted
      adoptDepsFixture: { deps: deps.adoptDeps, fs, tablePath },
    });

    const second = await runAutonomyTick(deps2);

    expect(second.noop).toBe(true); // nothing left to change
    expect(second.adopted).toHaveLength(0);
    expect(second.standingProposal?.hasProposal).toBe(false);
    expect(loadWatchdogState(dataDir).records).toHaveLength(1); // no duplicate watch record
  });
});

// ── Dry run ──────────────────────────────────────────────────────────────────────

describe("runAutonomyTick — dry run", () => {
  it("performs a full evaluation but mutates ZERO durable state or the live table", async () => {
    const dataDir = tmp();
    const seededTierState: TierState = { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 3, lastCycleAt: null, lastEvent: null };
    saveTierState(dataDir, seededTierState);
    const tierStateBefore = readFileSync(autonomyPaths(dataDir).tierStatePath, "utf8");
    const { deps, fs, tablePath } = baseTickDeps({ dataDir });
    const tableBefore = fs.get(tablePath);

    const report = await runAutonomyTick(deps, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.axisEvaluations[0]?.eligible).toBe(true); // full evaluation still happened
    expect(report.adopted).toHaveLength(0); // but zero mutation

    expect(fs.get(tablePath)).toBe(tableBefore); // live table untouched
    expect(readFileSync(autonomyPaths(dataDir).tierStatePath, "utf8")).toBe(tierStateBefore); // tier state untouched
    expect(existsSync(autonomyPaths(dataDir).standingProposalPath)).toBe(false); // no proposal written
    expect(loadWatchdogState(dataDir).records).toHaveLength(0); // no watch record opened
  });
});

describe("emptyTierState / DEFAULT_AUTONOMY_POLICY sanity", () => {
  it("starts at Tier 0 with zero healthy cycles", () => {
    expect(emptyTierState()).toEqual({ schemaVersion: 1, tier: 0, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null });
  });

  it("matches the design doc's proposed defaults (grimnir docs/autonomous-improvement-design.md §6)", () => {
    expect(DEFAULT_AUTONOMY_POLICY.marginDelta).toBe(0.05);
    expect(DEFAULT_AUTONOMY_POLICY.maxAdoptionsPerWindow).toBe(3);
    expect(DEFAULT_AUTONOMY_POLICY.tier1UnlockCycles).toBe(10);
    expect(DEFAULT_AUTONOMY_POLICY.tier2RevertRateMax).toBe(0.2);
  });
});
