/**
 * Regression tests for ROUND 5 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the re-review after round 4's fixes. 8/12 items closed round-4's own
 * regression coverage; this file targets the remaining concentrated items: fencing enforced AT THE
 * RESOURCE (not only at acquire), reconcile's whole-sequence lease coverage, the watchdog's move to
 * SQLite to structurally close its lost-update race, Tier-2 revert-rate tenure scoping, and the
 * round-4 residue (unwired production deleteTable, nonterminal restore results). Each test targets
 * the exact defect the review reproduced against the pre-round-5-fix code.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  runAutonomyTick,
  saveTierState,
  loadTierState,
  saveAdoptionIntent,
  loadAdoptionIntent,
  reconcileAdoptionIntent,
  computeAutonomousRevertRate,
  autonomyPaths,
  AUTONOMY_APPROVER_PREFIX,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
  type AdoptionIntent,
  type TierState,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  saveWatchdogState,
  loadQuarantineState,
  recordAdoptionForWatch,
  watchdogPaths,
  type AdoptionWatchRecord,
} from "../src/homeserver/adoption-watchdog.js";
import {
  acquireMutationLock,
  mutationLockDbPath,
  assertLeaseCurrent,
  MutationLockStaleError,
} from "../src/homeserver/mutation-lock.js";
import { adoptRoutingTable, approveArtifact, buildDecisionArtifact } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";

const NOW = "2026-07-21T00:00:00.000Z";

type RouteSpec = { model: string | null; verdict: string; attempts: number; passRate?: number; tokPerSec?: number | null };

function makeDoc(routing: Record<string, RouteSpec>): RoutingTableDoc {
  return {
    _comment: "test fixture",
    _generator: "test",
    generatedAt: NOW,
    sources: [],
    globalRule: "test",
    routing: Object.fromEntries(
      Object.entries(routing).map(([k, v]) => [
        k,
        { model: v.model, passRate: v.passRate ?? 1, tokPerSec: v.tokPerSec ?? null, verdict: v.verdict as "delegate-local" | "explore" | "escalate-frontier", attempts: v.attempts },
      ])
    ),
    escalateToFrontier: Object.entries(routing).filter(([, v]) => v.model === null).map(([k]) => k),
    avoidForShortTasks: [],
    modelProfiles: {},
  };
}

function tableJson(routing: Record<string, RouteSpec>): string {
  return JSON.stringify(makeDoc(routing), null, 2) + "\n";
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
  deleteTable?: (path: string) => void;
}): { deps: AdoptDeps; fs: Map<string, string>; tablePath: string } {
  const tablePath = "/virtual/m5-routing.json";
  const fs = new Map<string, string>();
  if (p.initialTable !== null) fs.set(tablePath, p.initialTable);
  const deps: AdoptDeps = {
    tablePath,
    readTable: p.readTable ?? ((path) => { if (!fs.has(path)) throw new Error(`ENOENT: ${path}`); return fs.get(path)!; }),
    writeTable: p.writeTable ?? ((path, data) => fs.set(path, data)),
    reload: p.reload ?? (() => ({ ok: true })),
    servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b", "good-model", "bad-model", "gemma4"],
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
    deleteTable: p.deleteTable ?? ((path) => fs.delete(path)),
  };
  return { deps, fs, tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r5-"));
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

function leaseRow(dataDir: string): { token: number } | undefined {
  const db = new Database(mutationLockDbPath(dataDir));
  try {
    return db.prepare(`SELECT token FROM mutation_lease WHERE id = 1`).get() as { token: number } | undefined;
  } finally {
    db.close();
  }
}

// ── Finding 1 — fencing enforced AT THE RESOURCE ──────────────────────────────────

describe("Finding 1 — fencing checked at the resource, not only at acquire", () => {
  it("assertLeaseCurrent throws MutationLockStaleError once the token has been superseded", () => {
    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    expect(() => assertLeaseCurrent(dataDir, holder.token)).not.toThrow();
    // Simulate a reclaim: force the lease stale, then let a new holder take over.
    const db = new Database(mutationLockDbPath(dataDir));
    db.prepare(`UPDATE mutation_lease SET acquired_at_ms = 0 WHERE id = 1`).run();
    db.close();
    const reclaimer = acquireMutationLock(dataDir);
    expect(() => assertLeaseCurrent(dataDir, holder.token)).toThrow(MutationLockStaleError);
    expect(() => assertLeaseCurrent(dataDir, reclaimer.token)).not.toThrow();
    reclaimer.release();
  });

  it("adoptRoutingTable refuses the write (via MutationLockStaleError) when its leaseContext token has been superseded — nothing is written", async () => {
    const adopted = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: adopted });
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate: candidate,
      adopted: { routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50 } } },
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      nowIso: NOW,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    const approval = approveArtifact(artifact, { approvedBy: "magnus", reason: "test", decisionRef: "r", approvedAt: NOW });

    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    // Reclaim it out from under `holder` — simulates the lease going stale mid-operation.
    const db = new Database(mutationLockDbPath(dataDir));
    db.prepare(`UPDATE mutation_lease SET acquired_at_ms = 0 WHERE id = 1`).run();
    db.close();
    const reclaimer = acquireMutationLock(dataDir);

    // Round 6 finding 1: leaseContext now lives on `deps` itself (so EVERY filesystem mutation
    // routed through these deps is fenced, not just the one call that used to accept an opt).
    const leasedDeps = { ...adoptDeps, leaseContext: { dataDir, token: holder.token } };
    await expect(adoptRoutingTable(artifact, approval, leasedDeps, { verifiedPriorRaw: adopted })).rejects.toThrow(
      MutationLockStaleError
    );
    expect(fs.get(tablePath)).toBe(adopted); // NOTHING was written
    reclaimer.release();
  });

  it("recordAdoptionForWatch refuses (MutationLockStaleError) and inserts NOTHING when its leaseToken has been superseded", () => {
    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    const db = new Database(mutationLockDbPath(dataDir));
    db.prepare(`UPDATE mutation_lease SET acquired_at_ms = 0 WHERE id = 1`).run();
    db.close();
    const reclaimer = acquireMutationLock(dataDir);

    expect(() =>
      recordAdoptionForWatch({
        dataDir,
        adoptedAt: NOW,
        candidateHash: "h1",
        decisionRef: "r",
        approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
        changedTaskTypes: ["classify"],
        priorRaw: null,
        provenance: { kind: "autonomy", tier: 1 },
        leaseToken: holder.token,
      })
    ).toThrow(MutationLockStaleError);
    expect(loadWatchdogState(dataDir).records).toHaveLength(0);
    reclaimer.release();
  });

  it("a full tick handles a lease going stale mid-attempt cleanly: no crash, table unchanged, axis marked ineligible (never counted as an attempted mutation)", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: null });
    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    let writeCalls = 0;
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({
      initialTable,
      writeTable: (path, data) => {
        writeCalls++;
        fs.set(path, data);
      },
      // The FIRST readTable call happens under the controller's own lock, right before it calls
      // adoptRoutingTable — reclaim the lease at exactly that point to simulate "went stale
      // mid-operation" (the fencing check inside adoptRoutingTable fires immediately after).
      readTable: (path) => {
        const db = new Database(mutationLockDbPath(dataDir));
        const row = db.prepare(`SELECT token FROM mutation_lease WHERE id = 1`).get() as { token: number } | undefined;
        if (row) {
          db.prepare(`UPDATE mutation_lease SET acquired_at_ms = 0 WHERE id = 1`).run();
          db.close();
          const reclaimer = acquireMutationLock(dataDir);
          reclaimer.release(); // immediately free it again so nothing else in this test deadlocks
        } else {
          db.close();
        }
        if (!fs.has(path)) throw new Error(`ENOENT: ${path}`);
        return fs.get(path)!;
      },
    });
    const before = fs.get(tablePath);
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

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    expect(writeCalls).toBe(0); // the write NEVER happened — the fencing check refused it first
    expect(fs.get(tablePath)).toBe(before);
    expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(0);
    expect(report.axisEvaluations[0]?.reasons.some((r) => r.includes("mutation-lease-went-stale-mid-operation"))).toBe(true);
  });
});

// ── Finding 2 — reconcile holds the lease through the ENTIRE sequence ─────────────

describe("Finding 2 — reconcile's canary-passed finalize branch is ALSO lease-protected, not just the restore branch", () => {
  it("the canary-passed branch defers (never proceeds) when the lease is held externally", async () => {
    const dataDir = tmp();
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: candidateRaw });

    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-r5-2a",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw: null,
      phase: "canary-passed",
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);

    const externalHolder = acquireMutationLock(dataDir);
    try {
      const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);
      expect(result.action).toBe("restore-deferred-lock-busy");
      expect(loadWatchdogState(dataDir).records).toHaveLength(0); // no watch record fabricated
      expect(loadAdoptionIntent(dataDir)?.status).toBe("pending"); // untouched
    } finally {
      externalHolder.release();
    }
  });
});

// ── Finding 3 — watchdog state moved to SQLite: the lost-update race is structurally closed ──

describe("Finding 3 — a scoped recordAdoptionForWatch insert can never be clobbered by an independent whole-state save", () => {
  it("reproduces the round-4 interleaving: call A's stale in-memory saveWatchdogState never erases call B's independently-inserted record", () => {
    const dataDir = tmp();
    // Call A "loads" state at t0 (empty).
    const aView = loadWatchdogState(dataDir);
    expect(aView.records).toHaveLength(0);

    // Call B (a concurrent recordAdoptionForWatch, e.g. a manual adopt) inserts its OWN record —
    // a SCOPED insert, independent of A's in-memory view.
    const bRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: NOW,
      candidateHash: "h-from-b",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // Call A now "finishes" and saves ITS OWN (stale, still-empty) in-memory view. Under the
    // round-4 file-based whole-state-overwrite design this would have WIPED OUT b's record. The
    // SQLite-backed `saveWatchdogState` is an upsert-only operation — it never deletes a row simply
    // because the caller's array does not mention it.
    saveWatchdogState(dataDir, aView);

    const after = loadWatchdogState(dataDir);
    expect(after.records.some((r) => r.id === bRecord.id)).toBe(true);
  });

  it("one-time migration: a legacy JSON state.json + quarantine.json are imported into SQLite on first access, never fabricated or lost", () => {
    const dataDir = tmp();
    const { root, statePath, quarantinePath } = watchdogPaths(dataDir);
    mkdirSync(root, { recursive: true });
    const legacyRecord: AdoptionWatchRecord = {
      id: "legacy-prod-record",
      adoptedAt: "2026-07-01T00:00:00.000Z",
      candidateHash: "h-legacy",
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "healthy",
      lastEvaluatedAt: "2026-07-02T00:00:00.000Z",
      provenance: { kind: "autonomy", tier: 1 },
    };
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, records: [legacyRecord] }, null, 2) + "\n", "utf8");
    writeFileSync(
      quarantinePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          byTaskType: {
            extract: {
              taskType: "extract",
              quarantinedAt: "2026-07-01T00:00:00.000Z",
              reason: "legacy",
              cooldownUntil: "2026-07-03T00:00:00.000Z",
              requiredMarginDelta: 0.1,
              baselinePassRateAtQuarantine: 0.5,
              clearedAt: null,
            },
          },
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    // First access triggers the one-time migration (production has exactly this ONE record).
    const migrated = loadWatchdogState(dataDir);
    expect(migrated.records).toHaveLength(1);
    expect(migrated.records[0]).toEqual(legacyRecord);
    const migratedQuarantine = loadQuarantineState(dataDir);
    expect(migratedQuarantine.byTaskType["extract"]?.reason).toBe("legacy");

    // A SECOND access must not duplicate or corrupt anything (idempotent, table now non-empty).
    const again = loadWatchdogState(dataDir);
    expect(again.records).toHaveLength(1);
  });
});

// ── Finding 4 — Tier-2 revert-rate scoped to the CURRENT Tier-1 tenure ────────────

describe("Finding 4 — revert-rate evidence is scoped to the current Tier-1 tenure and excludes unresolved records", () => {
  it("a healthy record from a PRIOR tenure (before a demotion) does not count toward the CURRENT tenure's rate", () => {
    const priorTenureRecord: AdoptionWatchRecord = {
      id: "prior-tenure",
      adoptedAt: "2026-01-01T00:00:00.000Z", // long before the current tenure started
      candidateHash: "h1",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "healthy",
      lastEvaluatedAt: null,
      provenance: { kind: "autonomy", tier: 1 },
    };
    const currentTenureBreach: AdoptionWatchRecord = {
      id: "current-tenure-breach",
      adoptedAt: "2026-07-15T00:00:00.000Z",
      candidateHash: "h2",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      snapshotPath: null,
      status: "breach",
      lastEvaluatedAt: null,
      provenance: { kind: "autonomy", tier: 1 },
    };
    const tenureStart = "2026-07-10T00:00:00.000Z"; // the current tenure began AFTER the old healthy record
    const rate = computeAutonomousRevertRate([priorTenureRecord, currentTenureBreach], tenureStart);
    // If the prior-tenure healthy record were still counted, the rate would be 1/2 = 0.5; scoped
    // correctly, the denominator is JUST the current-tenure breach: 1/1 = 1.0.
    expect(rate).toBe(1);
  });

  it("pending and inconclusive records are excluded from both the numerator and denominator", () => {
    const pending: AdoptionWatchRecord = {
      id: "p1",
      adoptedAt: NOW,
      candidateHash: "h1",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "pending",
      lastEvaluatedAt: null,
      provenance: { kind: "autonomy", tier: 1 },
    };
    const inconclusive: AdoptionWatchRecord = { ...pending, id: "p2", status: "inconclusive" };
    const breach: AdoptionWatchRecord = { ...pending, id: "p3", status: "breach" };
    // Denominator must be JUST the one RESOLVED (breach) record — 1/1 = 1.0, not diluted to 1/3 by
    // counting the two unresolved records in the denominator (a rate-dilution bug: unresolved
    // records were previously counted in the denominator with an implicit non-breach numerator
    // contribution, making a genuine 100% breach rate read as an artificially low ~33%).
    expect(computeAutonomousRevertRate([pending, inconclusive, breach], null)).toBe(1);
    // With only pending/inconclusive and no resolved records at all, this reads as "no evidence" (0).
    expect(computeAutonomousRevertRate([pending, inconclusive], null)).toBe(0);
  });

  it("a demotion back to Tier 1 resets tier1EnteredAt to a fresh tenure epoch", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 2,
      consecutiveHealthyCycles: 5,
      consecutiveGoCycles: 5,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
      tier1EnteredAt: "2020-01-01T00:00:00.000Z", // an old, stale tenure start
    } as TierState);
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: "h-breach",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 2 },
    });
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "breach" };
    saveWatchdogState(dataDir, wstate);

    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
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
    await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    const after = loadTierState(dataDir);
    expect(after.tier).toBe(1); // demoted 2 -> 1
    expect(after.tier1EnteredAt).toBe(NOW); // fresh tenure epoch, NOT the old 2020 value
  });
});

// ── Finding 6b — a nonterminal restore result is failure-marked, never dropped ────

describe("Finding 6b — a restore that neither fully succeeds nor is left silent gets failure-marked on the intent", () => {
  it("a restore-write failure records restoreAttempts/lastRestoreAttemptAt/lastRestoreError while staying pending", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: candidateRaw,
      writeTable: () => {
        throw new Error("simulated disk-full on restore write");
      },
    });

    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-r5-6b",
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

    const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);
    expect(result.action).toBe("restore-failed-will-retry");

    const after = loadAdoptionIntent(dataDir);
    expect(after?.status).toBe("pending"); // never dropped, never falsely terminal
    expect(after?.restoreAttempts).toBe(1);
    expect(after?.lastRestoreAttemptAt).toBe(NOW);
    expect(after?.lastRestoreError).toBeTruthy();
  });
});

// ── Follow-up — cycleOutcome exposed on the tick report ───────────────────────────

describe("Follow-up — AutonomyTickReport.cycleOutcome exposes the real three-way signal", () => {
  it("a NEUTRAL tick (lock-busy-exhausted rotation) reports cycleOutcome: 'neutral' even though healthyCycle (back-compat) is true", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 3, consecutiveGoCycles: 3, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: null });
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
    const externalHolder = acquireMutationLock(dataDir);
    try {
      const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
      expect(report.cycleOutcome).toBe("neutral");
      expect(report.healthyCycle).toBe(true); // back-compat: neutral still reads as "not unhealthy"
    } finally {
      externalHolder.release();
    }
  });

  it("a genuinely unhealthy tick reports cycleOutcome: 'unhealthy' and healthyCycle: false, in agreement", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 5, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: null });
    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable, reload: () => ({ ok: false, error: "simulated reload failure" }) });
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
    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
    expect(report.cycleOutcome).toBe("unhealthy");
    expect(report.healthyCycle).toBe(false);
  });
});
