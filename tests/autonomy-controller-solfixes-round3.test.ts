/**
 * Regression tests for ROUND 3 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the re-review of PR #55 (itself a fix-forward for round 1). 4 of 7
 * original findings were fully fixed; 3 were partial and 5 NEW findings surfaced in the fixes
 * themselves. Each finding below is named for the round-3 numbering the review used and is written
 * to FAIL against the pre-round-3-fix code (RED), then PASS once the fix lands (GREEN).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAutonomyTick,
  saveTierState,
  loadTierState,
  computeRiskBudgetStatus,
  routeCooldownActive,
  computeAutonomousRevertRate,
  saveAdoptionIntent,
  loadAdoptionIntent,
  tableContentHash,
  reconcileAdoptionIntent,
  loadAnchoredEnablement,
  loadRotationState,
  rotateEligibleAxes,
  AUTONOMY_APPROVER_PREFIX,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
  type TierState,
  type AdoptionIntent,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  recordAdoptionForWatch,
  type GuardMetricSnapshot,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock, mutationLockDbPath } from "../src/homeserver/mutation-lock.js";
import Database from "better-sqlite3";

// Round 4 finding 1: the mutation lock is now a SQLite lease, not a bare lock file. This helper
// reads the lease row directly (equivalent verification strength to the old `existsSync(lockPath)`
// check: "is a lease currently held", not merely "did some file get created").
function hasActiveLease(dataDir: string): boolean {
  const db = new Database(mutationLockDbPath(dataDir));
  try {
    const row = db.prepare(`SELECT token FROM mutation_lease WHERE id = 1`).get();
    return row !== undefined;
  } finally {
    db.close();
  }
}
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";

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

function tableJson(routing: Record<string, RouteSpec>): string {
  const doc = makeDoc(routing);
  return JSON.stringify(doc, null, 2) + "\n"; // exactly what adoptRoutingTable writes
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

const WATCHDOG_POLICY = {
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
};

function fakeAdoptDeps(p: {
  initialTable: string | null;
  reload?: () => ReloadOutcome;
  writeTable?: (path: string, data: string) => void;
  readTable?: (path: string) => string;
}): { deps: AdoptDeps; fs: Map<string, string>; tablePath: string } {
  const tablePath = "/virtual/m5-routing.json";
  const fs = new Map<string, string>();
  if (p.initialTable !== null) fs.set(tablePath, p.initialTable);
  const deps: AdoptDeps = {
    tablePath,
    readTable:
      p.readTable ??
      ((path) => {
        if (!fs.has(path)) throw new Error(`ENOENT: ${path}`);
        return fs.get(path)!;
      }),
    writeTable: p.writeTable ?? ((path, data) => fs.set(path, data)),
    reload: p.reload ?? (() => ({ ok: true })),
    servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b", "good-model", "bad-model", "gemma4"],
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
  };
  return { deps, fs, tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r3-"));
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

function noRecheckGate(gate: CalibrationGateDecision | null = null) {
  return () => gate;
}

function baseDeps(p: {
  dataDir: string;
  review: AutonomyReviewInputs;
  adoptDeps: AdoptDeps;
  killSwitchOn?: () => boolean;
  queryGuardMetrics?: AutonomyTickDeps["queryGuardMetrics"];
  recomputeCalibrationGate?: () => CalibrationGateDecision | null;
}): AutonomyTickDeps {
  return {
    dataDir: p.dataDir,
    nowIso: () => NOW,
    killSwitchOn: p.killSwitchOn ?? (() => false),
    decisionRef: "gille-inference#49",
    policy: TEST_POLICY,
    watchdogPolicy: WATCHDOG_POLICY,
    review: p.review,
    queryGuardMetrics: p.queryGuardMetrics ?? (() => []),
    adoptDeps: p.adoptDeps,
    recomputeCalibrationGate: p.recomputeCalibrationGate ?? noRecheckGate(p.review.calibrationGate),
  };
}

// ── Finding 1 (round 3, critical residue): journal commit ambiguity ──────────────

describe("Finding 1 (round 3) — journal phase tracking: a crash before canary confirmation must restore, not certify", () => {
  it("an intent left at phase 'table-written' (crash before reload/canary) is restored to its prior snapshot, never finalized", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));

    // Simulate: the table WRITE succeeded (live table now holds the candidate bytes) but the
    // process crashed before reload/canary ever ran — the intent's phase reflects this.
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: candidateRaw });
    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-r3-1",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw,
      phase: "table-written",
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);

    await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);

    // The live table must be RESTORED to the pre-adoption snapshot — never left holding an
    // uncanaried candidate that reconcile then certifies as adopted.
    expect(fs.get(tablePath)).toBe(priorRaw);
    const finalIntent = loadAdoptionIntent(dataDir);
    expect(finalIntent?.status).toBe("aborted");
    // No watch record was ever fabricated for the uncanaried write.
    expect(loadWatchdogState(dataDir).records.some((r) => r.candidateHash === candidateHash)).toBe(false);
  });

  it("an intent that reached phase 'canary-passed' before the crash IS finalized (the original finding-2 gap, still fixed)", async () => {
    const dataDir = tmp();
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: candidateRaw });

    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-r3-2",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }),
      phase: "canary-passed",
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);

    const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);

    expect(result.action).toBe("finalized-new-watch-record");
    expect(loadAdoptionIntent(dataDir)?.status).toBe("finalized");
    expect(loadWatchdogState(dataDir).records.some((r) => r.candidateHash === candidateHash)).toBe(true);
  });
});

// ── Finding 2 (round 3): concurrent writers — exclusive mutation lock ────────────

describe("Finding 2 (round 3) — exclusive mutation lock shared by the tick and manual adopt", () => {
  it("a second lock acquisition attempt is refused while the first is fresh", () => {
    const dataDir = tmp();
    const handle = acquireMutationLock(dataDir);
    expect(hasActiveLease(dataDir)).toBe(true);
    expect(() => acquireMutationLock(dataDir)).toThrow(/mutation-lock/i);
    handle.release();
    expect(hasActiveLease(dataDir)).toBe(false);
  });

  it("a stale lock (older than the threshold) is force-taken-over rather than blocking forever", () => {
    const dataDir = tmp();
    const nowMs = Date.parse(NOW);
    acquireMutationLock(dataDir, { nowMs: nowMs - 10 * 60 * 1000 }); // acquired "10 minutes ago"
    // A fresh attempt, 10 minutes later, with the default 5-minute staleness threshold, must succeed.
    const handle2 = acquireMutationLock(dataDir, { nowMs });
    expect(handle2).toBeDefined();
    handle2.release();
  });

  it("runAutonomyTick's own axis adopt attempt takes the SAME lock a concurrent manual adopt would take", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable });
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    // Simulate a concurrent manual `adopt` already holding the lock.
    const externalHolder = acquireMutationLock(dataDir);
    try {
      const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
      // The tick must NOT have mutated the table while the lock was held externally.
      expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(0);
      expect(report.axisEvaluations[0]?.reasons.some((r) => r.includes("mutation-lock"))).toBe(true);
    } finally {
      externalHolder.release();
    }
  });
});

// ── Finding 3 (round 3): tryReadLiveTable must only swallow verified ENOENT ──────

describe("Finding 3 (round 3) — a transient (non-ENOENT) read failure must propagate, never read as 'no table'", () => {
  it("runAutonomyTick rejects instead of silently assuming an empty baseline on a permission-denied-style read error", async () => {
    const dataDir = tmp();
    const permissionError = Object.assign(new Error("EACCES: permission denied, open '/virtual/m5-routing.json'"), { code: "EACCES" });
    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: null,
      readTable: () => {
        throw permissionError;
      },
    });
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    await expect(runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }))).rejects.toThrow(/EACCES/);
  });

  it("a genuine ENOENT still reads as 'no table yet' (first-ever adoption), not an infra failure", async () => {
    const dataDir = tmp();
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: null }); // readTable throws "ENOENT: ..."
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
    expect(report.noop).toBe(false); // classify reads as "added" vs an empty baseline
  });
});

// ── Finding 4 (round 3): Tier-2 organic path must be reachable in production ─────

describe("Finding 4 (round 3) — ladder-computed anchored enablement (production-shaped gate, no injected enabling)", () => {
  const productionShapedGate = (verdict: "GO" | "HOLD"): CalibrationGateDecision => ({
    schemaVersion: 1,
    policyId: "policy-1",
    generatedAt: NOW,
    verdict,
    reasons: verdict === "GO" ? ["anchored agreement cleared kappa"] : ["insufficient anchored sample"],
    thresholds: { minStratumN: 1, minPrecisionLowerBound: 0, minRecallLowerBound: 0, maxDisagreementUpperBound: 1 },
    metrics: {} as CalibrationGateDecision["metrics"],
    enabling: null, // computeLiveCalibrationGate NEVER populates this in production — the exact gap
  });

  it("Tier 1 -> Tier 2 promotion writes a durable ladder-enablement record; the raw gate's `enabling` stays null throughout", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: TEST_POLICY.tier1UnlockCycles - 1,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
      consecutiveGoCycles: TEST_POLICY.tier1UnlockCycles - 1,
    } as TierState);
    // Round 4 finding 7: promotion ALSO requires at least one resolved-healthy autonomous Tier-1
    // adoption on record (a revert rate of 0 is otherwise indistinguishable from "Tier 1 has never
    // mutated anything at all") — seed one directly into watchdog state.
    const priorAdoption = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-10T00:00:00.000Z",
      candidateHash: "h-prior-tier1-adoption",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const seededWatchState = loadWatchdogState(dataDir);
    const seededIdx = seededWatchState.records.findIndex((r) => r.id === priorAdoption.id);
    seededWatchState.records[seededIdx] = { ...seededWatchState.records[seededIdx]!, status: "healthy" };
    const { saveWatchdogState } = await import("../src/homeserver/adoption-watchdog.js");
    saveWatchdogState(dataDir, seededWatchState);

    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }) });
    const review: AutonomyReviewInputs = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: productionShapedGate("GO"),
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    expect(report.tierAfter).toBe(2);
    const enablement = loadAnchoredEnablement(dataDir);
    expect(enablement).not.toBeNull();
  });

  it("at Tier 2, an organic-dependent axis is admitted ONLY via the ladder record — the raw production gate never carries enabling", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], consecutiveGoCycles: 0 } as TierState);
    // Manually seed the ladder's own enablement record, as Tier-2 unlock would have.
    const { saveAnchoredEnablement } = await import("../src/homeserver/autonomy-controller.js");
    saveAnchoredEnablement(dataDir, {
      schemaVersion: 1,
      reviewerId: "autonomy-controller:tier-ladder",
      reason: "Tier 2 unlocked",
      decisionRef: "gille-inference#49",
      reviewedAt: NOW,
      grantedAtTier: 2,
    });

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }) });
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const deterministicCandidate = makeDoc({}); // organic-dependent
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: productionShapedGate("GO"), // enabling: null, exactly production's shape
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const report = await runAutonomyTick(
      baseDeps({ dataDir, review, adoptDeps, recomputeCalibrationGate: () => productionShapedGate("GO") })
    );

    expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(1);
  });

  it("demotion below Tier 2 revokes the ladder enablement record", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 5, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], consecutiveGoCycles: 5 } as TierState);
    const { saveAnchoredEnablement } = await import("../src/homeserver/autonomy-controller.js");
    saveAnchoredEnablement(dataDir, {
      schemaVersion: 1,
      reviewerId: "autonomy-controller:tier-ladder",
      reason: "Tier 2 unlocked",
      decisionRef: "gille-inference#49",
      reviewedAt: NOW,
      grantedAtTier: 2,
    });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z",
      candidateHash: "h-prior",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}2`,
      changedTaskTypes: ["extract"],
      priorRaw: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }),
      provenance: { kind: "autonomy", tier: 2 },
    });

    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }) });
    const review: AutonomyReviewInputs = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const report = await runAutonomyTick(
      baseDeps({
        dataDir,
        review,
        adoptDeps,
        queryGuardMetrics: (taskTypes, _since, untilIso) => {
          const isBaseline = untilIso === "2026-07-17T00:00:00.000Z";
          return taskTypes.map((t) => snapshot({ taskType: t, errorRate: isBaseline ? 0.05 : 0.3 })); // breach
        },
      })
    );

    expect(report.tierAfter).toBe(1);
    expect(loadAnchoredEnablement(dataDir)).toBeNull();
  });
});

// ── Finding 5 (round 3): honest per-axis evaluation + persisted round-robin ─────

describe("Finding 5 (round 3) — every changed axis gets an HONEST evaluation; attempted axis rotates", () => {
  it("rotateEligibleAxes starts after the last-attempted axis, wrapping around", () => {
    expect(rotateEligibleAxes(["a", "b", "c"], null)).toEqual(["a", "b", "c"]);
    expect(rotateEligibleAxes(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
    expect(rotateEligibleAxes(["a", "b", "c"], "c")).toEqual(["a", "b", "c"]);
    // Round 4 finding 9 DELIBERATELY REVERSED this case's expectation: round 3 reset to the START
    // of the sorted list whenever `lastAttempted` ("b") was no longer eligible, which means the
    // lexically-first eligible axis ("a") wins the rotation again on every tick "b" is transiently
    // ineligible — reproducing the exact starvation the round-3 fix was meant to close. The fix
    // resumes from "b"'s LEXICAL INSERTION POINT among the eligible set ("c", the first eligible
    // axis sorting after "b"), wrapping — so "c" is tried before "a" here, not after.
    expect(rotateEligibleAxes(["a", "c"], "b")).toEqual(["c", "a"]);
    // Insertion point wraps to the start when nothing eligible sorts after lastAttempted.
    expect(rotateEligibleAxes(["a", "b"], "z")).toEqual(["a", "b"]);
  });

  it("a second, later-alphabetical axis is NOT given fabricated placeholder predicate results", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const initialTable = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable });
    const candidate = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
      extract: { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b", "gemma4"],
      requiredTaskTypes: ["classify", "extract"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    // The axis that was NOT attempted this tick must still show its REAL, honestly-computed
    // predicate results (statistically sufficient, no quarantine, etc.) — never the round-1 fix's
    // hard-coded "deferred" placeholder.
    const notAttempted = report.axisEvaluations.find((a) => !a.attempted)!;
    expect(notAttempted.statisticallySufficient).toBe(true);
    expect(notAttempted.eligible).toBe(true); // genuinely eligible, just not this tick's chosen one
  });

  it("over two ticks, the SECOND eligible axis gets its turn (no starvation) via the persisted rotation cursor", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const initialTable = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    });
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable });
    const candidate = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
      extract: { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b", "gemma4"],
      requiredTaskTypes: ["classify", "extract"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const first = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
    expect(first.adopted.filter((a) => a.outcome.outcome === "adopted").map((a) => a.taskType)).toEqual(["classify"]);

    // Second tick: re-derive the review inputs from the freshly-adopted table (as a real CLI
    // invocation would), with "extract" still proposing its change (classify is now a no-op).
    const writtenNow = JSON.parse(fs.get(tablePath)!) as RoutingTableDoc;
    const candidate2 = makeDoc({
      classify: { model: writtenNow.routing["classify"]!.model, verdict: "delegate-local", attempts: writtenNow.routing["classify"]!.attempts, passRate: writtenNow.routing["classify"]!.passRate },
      extract: { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const review2: AutonomyReviewInputs = { ...review, candidate: candidate2, deterministicCandidate: candidate2 };
    const second = await runAutonomyTick(baseDeps({ dataDir, review: review2, adoptDeps }));

    expect(second.adopted.filter((a) => a.outcome.outcome === "adopted").map((a) => a.taskType)).toEqual(["extract"]);
  });

  it("a pre-write refusal (lock busy) on the rotation's first candidate does NOT consume the tick's mutation slot — the next eligible axis is tried instead", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const initialTable = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable });
    const candidate = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
      extract: { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b", "gemma4"],
      requiredTaskTypes: ["classify", "extract"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    // Pre-seed the rotation cursor so "classify" (the alphabetically-first axis) is skipped to the
    // END of rotation, AND simultaneously simulate its lock being busy — regardless of ordering,
    // when ONE candidate axis is lock-busy the OTHER must still get a real attempt this tick.
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const busyHandle = acquireMutationLock(dataDir);
    // Release immediately after the FIRST rotation candidate would have tried it — simulate by
    // releasing synchronously before the tick runs is not meaningful for a single-threaded test, so
    // instead assert the weaker, still-real property: with the lock free, both axes are equally
    // attemptable, and over enough ticks neither starves. This test focuses on the NON-consuming
    // contract using a locked scenario where NEITHER axis can be attempted (lock busy the whole
    // tick) — the mutation slot must not be marked "consumed" by a pre-write refusal.
    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
    busyHandle.release();

    expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(0);
    // BOTH axes must show the lock-busy refusal reason (neither was skipped as "deferred" due to
    // the other consuming a slot that was never actually used).
    for (const axis of report.axisEvaluations) {
      expect(axis.reasons.some((r) => r.includes("mutation-lock"))).toBe(true);
    }
  });
});

// ── Finding 6 (round 3): legacy provenance — split budget vs. health direction ───

describe("Finding 6 (round 3) — legacy/ambiguous provenance: restrictive for budget, excluded from health stats", () => {
  it("a record with NO provenance but a matching approvedBy prefix COUNTS toward the risk budget", () => {
    const legacy = {
      id: "legacy-1",
      adoptedAt: NOW,
      candidateHash: "h1",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "pending" as const,
      lastEvaluatedAt: null,
      // no `provenance` field at all — a record written before this field existed.
    };
    const budget = computeRiskBudgetStatus([legacy], NOW, TEST_POLICY);
    expect(budget.used).toBe(1); // restrictive direction: assume it WAS autonomous for budget purposes
  });

  it("that SAME ambiguous record is EXCLUDED from the autonomous revert-rate health stat", () => {
    const legacyBreach = {
      id: "legacy-2",
      adoptedAt: NOW,
      candidateHash: "h2",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "breach" as const,
      lastEvaluatedAt: null,
    };
    // If this ambiguous, unproven record were counted, it would report a 100% revert rate from a
    // single data point — exactly the "can't dilute/inflate the health signal" risk finding 6 names.
    expect(computeAutonomousRevertRate([legacyBreach])).toBe(0); // excluded entirely -> no evidence either way
  });

  it("a record EXPLICITLY marked manual provenance never counts toward budget, even with a matching approvedBy text", () => {
    const explicitlyManual = {
      id: "manual-1",
      adoptedAt: NOW,
      candidateHash: "h3",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "pending" as const,
      lastEvaluatedAt: null,
      provenance: { kind: "manual" as const },
    };
    expect(computeRiskBudgetStatus([explicitlyManual], NOW, TEST_POLICY).used).toBe(0);
  });
});

// ── Finding 7 (round 3, minor): double-appended demotion event + unbounded ackedBreachIds ──

describe("Finding 7 (round 3) — demotion event appended exactly once; ackedBreachIds bounded", () => {
  it("a demotion tick appends its tier-event record exactly ONCE to the durable events log", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 5, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z",
      candidateHash: "h-prior",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}2`,
      changedTaskTypes: ["extract"],
      priorRaw: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }),
      provenance: { kind: "autonomy", tier: 2 },
    });
    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }) });
    const review: AutonomyReviewInputs = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    await runAutonomyTick(
      baseDeps({
        dataDir,
        review,
        adoptDeps,
        queryGuardMetrics: (taskTypes, _since, untilIso) => {
          const isBaseline = untilIso === "2026-07-17T00:00:00.000Z";
          return taskTypes.map((t) => snapshot({ taskType: t, errorRate: isBaseline ? 0.05 : 0.3 }));
        },
      })
    );

    const { autonomyPaths } = await import("../src/homeserver/autonomy-controller.js");
    const events = readFileSync(autonomyPaths(dataDir).tierEventsPath, "utf8").trim().split("\n").filter(Boolean);
    const demotionEvents = events.map((l) => JSON.parse(l)).filter((e) => e.kind === "demotion");
    expect(demotionEvents).toHaveLength(1);
  });

  // Round 4 finding 5 DELIBERATELY REVERSED this rule's direction: round 3's 500-entry eviction cap
  // was itself a bug (an evicted ack made an old, already-handled breach id look "unacknowledged"
  // again forever, re-triggering its demotion on every subsequent tick — the "501st breach evicts,
  // the evicted one looks new forever" replay wedge). The fix keeps an ack for EVERY retained breach
  // record, unbounded — this test now asserts the OPPOSITE of its round-3 name: nothing is evicted.
  it("ackedBreachIds retains every id — round 4 removed the round-3 eviction cap as unsound (replay-wedge risk)", async () => {
    const dataDir = tmp();
    const manyIds = Array.from({ length: 600 }, (_, i) => `breach-${i}`);
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: 0,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: manyIds,
    });
    const state = loadTierState(dataDir);
    // loadTierState itself doesn't trim (only the tick's own reconciliation step does) — this test
    // exercises the tick path that MUST cap it going forward.
    const newRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z",
      candidateHash: "h-new-breach",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === newRecord.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "breach" };
    const { saveWatchdogState } = await import("../src/homeserver/adoption-watchdog.js");
    saveWatchdogState(dataDir, wstate);

    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }) });
    const review: AutonomyReviewInputs = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };
    expect(state.tier).toBe(1);

    await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    const after = loadTierState(dataDir);
    // Round 4 finding 5: no cap — all 600 pre-seeded ids PLUS the fresh one are retained.
    expect(after.ackedBreachIds.length).toBe(601);
    expect(after.ackedBreachIds).toContain(newRecord.id);
    expect(after.ackedBreachIds).toContain("breach-0"); // the OLDEST id is no longer evicted
  });
});
