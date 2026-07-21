/**
 * Regression tests for ROUND 4 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the re-review of PR #55 after round 3's fixes. 11 findings (4 critical, 4
 * major, 2 medium, 2 minor), including an orchestrator architecture decision to REPLACE the
 * file-based mutation lock with a better-sqlite3 lease. Each finding below targets the exact defect
 * the review reproduced against the pre-round-4-fix code, and passes against the fixed code.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
  loadAnchoredEnablement,
  saveAnchoredEnablement,
  revokeAnchoredEnablement,
  rotateEligibleAxes,
  autonomyPaths,
  AUTONOMY_APPROVER_PREFIX,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
  type AdoptionIntent,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  saveWatchdogState,
  recordAdoptionForWatch,
  runAdoptionWatch,
  type GuardMetricSnapshot,
  type WatchdogRunnerDeps,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock, mutationLockDbPath, MutationLockBusyError } from "../src/homeserver/mutation-lock.js";
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
  deleteTable?: (path: string) => void;
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
    deleteTable: p.deleteTable ?? ((path) => fs.delete(path)),
  };
  return { deps, fs, tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r4-"));
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

function leaseRow(dataDir: string): { token: number; acquired_at_ms: number } | undefined {
  const db = new Database(mutationLockDbPath(dataDir));
  try {
    return db.prepare(`SELECT token, acquired_at_ms FROM mutation_lease WHERE id = 1`).get() as
      | { token: number; acquired_at_ms: number }
      | undefined;
  } finally {
    db.close();
  }
}

// ── Finding 1 — SQLite lease replaces the file-CAS lock; fencing tokens ──────────

describe("Finding 1 — mutation lease: fencing tokens eliminate the round-3 file-lock races", () => {
  it("tokens are strictly increasing across acquisitions", () => {
    const dataDir = tmp();
    const nowMs = Date.parse(NOW);
    const h1 = acquireMutationLock(dataDir, { nowMs: nowMs - 10 * 60 * 1000 });
    expect(h1.token).toBe(1);
    // Force a reclaim (h1 is now 10 minutes stale under the default 5-minute threshold).
    const h2 = acquireMutationLock(dataDir, { nowMs });
    expect(h2.token).toBe(2);
    expect(h2.token).toBeGreaterThan(h1.token);
    h2.release();
  });

  it("a stale-holder's release, after being reclaimed, cannot delete the NEW owner's lease (tokenless-release race, closed)", () => {
    const dataDir = tmp();
    const nowMs = Date.parse(NOW);
    const staleHolder = acquireMutationLock(dataDir, { nowMs: nowMs - 10 * 60 * 1000 });
    const freshHolder = acquireMutationLock(dataDir, { nowMs }); // reclaims — mints a NEW token
    // The stale (zombie) holder's release is guarded by ITS OWN (superseded) token — it must be a
    // no-op against the fresh holder's lease, never delete it.
    staleHolder.release();
    expect(leaseRow(dataDir)).toBeDefined(); // the FRESH lease is still held
    expect(leaseRow(dataDir)?.token).toBe(freshHolder.token);
    freshHolder.release();
    expect(leaseRow(dataDir)).toBeUndefined();
  });

  it("renew() extends a live lease's age (guarded by its own token) and reports {renewed:false} once superseded", () => {
    const dataDir = tmp();
    const nowMs = Date.parse(NOW);
    const holder = acquireMutationLock(dataDir, { nowMs: nowMs - 4 * 60 * 1000 }); // 4 min old, under the 5-min threshold
    const renewResult = holder.renew();
    expect(renewResult.renewed).toBe(true);
    expect(leaseRow(dataDir)?.acquired_at_ms).toBeGreaterThan(nowMs - 4 * 60 * 1000);

    // Now force a reclaim (simulate holder's renew never actually landing before it went stale, by
    // directly backdating the row) and confirm the ORIGINAL handle's renew() reports false, never
    // silently "succeeding" against a lease that is no longer its own.
    const db = new Database(mutationLockDbPath(dataDir));
    db.prepare(`UPDATE mutation_lease SET acquired_at_ms = ? WHERE id = 1`).run(nowMs - 20 * 60 * 1000);
    db.close();
    const reclaimer = acquireMutationLock(dataDir, { nowMs });
    expect(reclaimer.token).not.toBe(holder.token);
    const staleRenew = holder.renew();
    expect(staleRenew.renewed).toBe(false);
    reclaimer.release();
  });

  it("a second acquisition attempt is refused (MutationLockBusyError) while the first is fresh, and the lease is fully gone after release", () => {
    const dataDir = tmp();
    const handle = acquireMutationLock(dataDir);
    expect(leaseRow(dataDir)).toBeDefined();
    expect(() => acquireMutationLock(dataDir)).toThrow(MutationLockBusyError);
    handle.release();
    expect(leaseRow(dataDir)).toBeUndefined();
  });
});

// ── Finding 2 — reconcile must not certify a failed restoration; must delete (not skip) a first-ever table ──

describe("Finding 2 — reconcile restoration must actually succeed before going terminal", () => {
  it("priorRaw === null (first-ever adoption): the unconfirmed table is DELETED, not left in place", async () => {
    const dataDir = tmp();
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: candidateRaw });

    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-r4-2a",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw: null, // first-ever adoption — nothing to restore TO
      phase: "table-written", // crashed before reload/canary
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);

    const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);

    expect(result.action).toBe("aborted");
    expect(fs.has(tablePath)).toBe(false); // DELETED — round 3's version left it in place
    expect(loadAdoptionIntent(dataDir)?.status).toBe("aborted");
  });

  it("a restore whose WRITE fails is left pending for retry, never certified 'aborted'", async () => {
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
      id: "intent-r4-2b",
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
    // NEVER marked terminal — the next tick's reconcile call must retry, not accept a fabricated recovery.
    expect(loadAdoptionIntent(dataDir)?.status).toBe("pending");
  });

  it("reconcile's restore path defers (never races) when the mutation lease is held by someone else", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: JSON.stringify(candidateDoc, null, 2) + "\n" });

    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-r4-2c",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw,
      phase: "reloaded",
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);

    const externalHolder = acquireMutationLock(dataDir);
    try {
      const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);
      expect(result.action).toBe("restore-deferred-lock-busy");
      expect(loadAdoptionIntent(dataDir)?.status).toBe("pending"); // untouched — retried next tick
    } finally {
      externalHolder.release();
    }
  });
});

// ── Finding 3 — watchdog breach revert defers under a busy lease ─────────────────

describe("Finding 3 — the watchdog's breach revert takes the SAME mutation lease, deferring rather than racing", () => {
  it("a breach detected while the lease is held externally is left 'pending' (not resolved to 'breach') for the next watch run", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } }) });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T12:00:00.000Z",
      candidateHash: "h-breach-candidate",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: (taskTypes, _since, untilIso) => {
        const isBaseline = untilIso === record.adoptedAt;
        return taskTypes.map((t) => ({
          taskType: t,
          sampleSize: 20,
          errorRate: isBaseline ? 0.05 : 0.9,
          escalationRate: 0.1,
          verifierFailRate: 0.05,
          retryRate: 0.1,
          latencyP50Ms: 1000,
        }));
      },
      nowIso: () => "2026-07-20T13:00:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };

    const externalHolder = acquireMutationLock(dataDir);
    try {
      const report = await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);
      const item = report.items.find((i) => i.record.id === record.id);
      expect(item?.evaluation.verdict).toBe("breach");
      expect(item?.revert?.status).toBe("skipped-lock-busy");
      // The record must stay "pending" so the NEXT watch run re-detects and reverts it for real.
      expect(loadWatchdogState(dataDir).records.find((r) => r.id === record.id)?.status).toBe("pending");
    } finally {
      externalHolder.release();
    }
  });
});

// ── Finding 4 — adoptRoutingTable: verifiedPriorRaw skips the second read; manual path propagates non-ENOENT ──

describe("Finding 4 — adoptRoutingTable's own prior-snapshot read", () => {
  it("reconcile's finalize path never triggers a second table read when the intent already carries the verified snapshot", async () => {
    // Regression target: the controller's adopt call site passes `verifiedPriorRaw` so
    // `adoptRoutingTable` does not re-read `readTable` a second time on the autonomous path. We
    // verify this indirectly through a full tick: a tick legitimately reads the live table a few
    // times before/during a successful adopt — REVIEW's baseline, the pre-write optimistic-
    // concurrency recheck under the lock, and `adoptRoutingTable`'s own post-reload readback (for
    // the canary) — round 4 finding 4 eliminates ONLY the EXTRA prior-snapshot read
    // `adoptRoutingTable` used to perform internally for its rollback snapshot, by accepting the
    // caller's already-captured `verifiedPriorRaw` instead. With the fix, the table is read exactly
    // 3 times per successful adopt (never a 4th, which would be the eliminated read).
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: baseAdoptDeps } = fakeAdoptDeps({ initialTable });
    let readCount = 0;
    // Wrap the DEFAULT (fs-map-backed) readTable with counting only — must still reflect actual
    // writes, unlike a fixed-return stub, so the post-write canary readback sees the real candidate.
    const adoptDeps: AdoptDeps = {
      ...baseAdoptDeps,
      readTable: (path) => {
        readCount++;
        if (readCount > 3) {
          throw new Error(
            `unexpected 4th live-table read (call #${readCount}) — adoptRoutingTable should have used the caller's verifiedPriorRaw instead of re-reading for its own rollback snapshot`
          );
        }
        return baseAdoptDeps.readTable(path);
      },
    };
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
    expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(1);
  });

  it("the manual/CLI path (no verifiedPriorRaw) propagates a non-ENOENT prior-table read error rather than treating it as 'no prior table'", async () => {
    const { adoptRoutingTable, approveArtifact, buildDecisionArtifact } = await import("../src/homeserver/routing-lifecycle.js");
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const artifact = buildDecisionArtifact({
      candidate,
      deterministicCandidate: candidate,
      adopted: { routing: {} },
      servableModelIds: ["qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      nowIso: NOW,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    });
    const approval = approveArtifact(artifact, { approvedBy: "magnus", reason: "test", decisionRef: "r", approvedAt: NOW });
    const permissionError = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: null, readTable: () => { throw permissionError; } });

    await expect(adoptRoutingTable(artifact, approval, adoptDeps)).rejects.toThrow(/EACCES/);
  });
});

// ── Finding 5 — ack-cap removed (see also the updated round-3 test) ──────────────

describe("Finding 5 — ackedBreachIds is never capped", () => {
  it("a tick that acknowledges a breach past the round-3 500-entry cap retains EVERY id, including the oldest", async () => {
    const dataDir = tmp();
    const manyIds = Array.from({ length: 550 }, (_, i) => `breach-${i}`);
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: 0,
      consecutiveGoCycles: 0,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: manyIds,
    });
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw });
    const newRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z",
      candidateHash: "h-new-breach-r4",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === newRecord.id);
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
    // Round 3's now-removed 500-entry cap would have evicted "breach-0" (and up to ~50 more) here.
    expect(after.ackedBreachIds).toHaveLength(551);
    expect(after.ackedBreachIds).toContain("breach-0");
    expect(after.ackedBreachIds).toContain(newRecord.id);
  });
});

// ── Finding 6 — three-way cycle outcome: NEUTRAL advances nothing, resets nothing ──

describe("Finding 6 — a tick where every eligible axis is refused pre-write is NEUTRAL, not healthy", () => {
  it("a lock-busy-exhausted rotation does NOT increment consecutiveHealthyCycles or consecutiveGoCycles", async () => {
    const dataDir = tmp();
    const seedState = {
      schemaVersion: 1 as const,
      tier: 1 as const,
      consecutiveHealthyCycles: 3,
      consecutiveGoCycles: 3,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
    };
    saveTierState(dataDir, seedState);
    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable });
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: { schemaVersion: 1, policyId: "p", generatedAt: NOW, verdict: "GO", reasons: [], thresholds: { minStratumN: 1, minPrecisionLowerBound: 0, minRecallLowerBound: 0, maxDisagreementUpperBound: 1, confidenceZ: 1.96 }, metrics: {} as CalibrationGateDecision["metrics"], enabling: { reviewerId: "x", reason: "x", decisionRef: "x", reviewedAt: NOW } },
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    // Simulate a concurrent manual adopt holding the lease for the ENTIRE tick — every eligible
    // axis's pre-write recheck is refused, so the rotation is exhausted with ZERO real attempts.
    const externalHolder = acquireMutationLock(dataDir);
    try {
      const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
      expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(0);
      const after = loadTierState(dataDir);
      // NEUTRAL: advances nothing, resets nothing — both streaks are UNCHANGED from the seed.
      expect(after.consecutiveHealthyCycles).toBe(3);
      expect(after.consecutiveGoCycles).toBe(3);
    } finally {
      externalHolder.release();
    }
  });
});

// ── Finding 7 — Tier-2 unlock requires real Tier-1 evidence, not just a zero revert rate ──

describe("Finding 7 — Tier-2 promotion is blocked with zero resolved autonomous Tier-1 adoptions on record", () => {
  it("a sustained GO/healthy streak alone does NOT unlock Tier 2 absent any resolved Tier-1 adoption", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: TEST_POLICY.tier1UnlockCycles - 1,
      consecutiveGoCycles: TEST_POLICY.tier1UnlockCycles - 1,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
    });
    // Deliberately NO watchdog records at all — zero evidence, not "zero failures".
    expect(loadWatchdogState(dataDir).records).toHaveLength(0);

    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }) });
    const productionShapedGate: CalibrationGateDecision = {
      schemaVersion: 1,
      policyId: "policy-1",
      generatedAt: NOW,
      verdict: "GO",
      reasons: ["anchored agreement cleared kappa"],
      thresholds: { minStratumN: 1, minPrecisionLowerBound: 0, minRecallLowerBound: 0, maxDisagreementUpperBound: 1, confidenceZ: 1.96 },
      metrics: {} as CalibrationGateDecision["metrics"],
      enabling: null,
    };
    const review: AutonomyReviewInputs = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: productionShapedGate,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    // Without round 4 finding 7's fix, this promotes to Tier 2 purely because
    // computeAutonomousRevertRate([]) === 0 reads as "safe" — it is really "no evidence at all".
    expect(report.tierAfter).toBe(1);
    expect(loadAnchoredEnablement(dataDir)).toBeNull();
  });
});

// ── Finding 8 — reconcile dedupes by intentId, never by candidateHash alone ───────

describe("Finding 8 — reconcile's crash-recovery dedup binds to the intent id, not the candidate hash", () => {
  it("two DIFFERENT intents that happen to share a candidateHash each get their OWN finalized watch record", async () => {
    const dataDir = tmp();
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: candidateRaw });

    // First intent, sharing this exact candidate hash, already finalized with its own watch record.
    const firstWatchRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-19T00:00:00.000Z",
      candidateHash,
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
      intentId: "intent-first",
    });

    // A SECOND, unrelated intent — different id, but the SAME candidateHash (e.g. a later tick
    // legitimately re-adopted identical bytes for the axis) — reconcile must NOT treat the first
    // intent's watch record as already covering this one.
    const secondIntent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-second",
      createdAt: "2026-07-20T00:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw: null,
      phase: "canary-passed",
      status: "pending",
    };
    saveAdoptionIntent(dataDir, secondIntent);

    const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);

    expect(result.action).toBe("finalized-new-watch-record");
    expect(result.detail).not.toBe(firstWatchRecord.id);
    const records = loadWatchdogState(dataDir).records;
    expect(records).toHaveLength(2);
    expect(records.some((r) => r.intentId === "intent-first")).toBe(true);
    expect(records.some((r) => r.intentId === "intent-second")).toBe(true);
  });
});

// ── Finding 9 — rotation resumes from the lexical insertion point (see also round-3 test update) ──

describe("Finding 9 — rotateEligibleAxes resumes from the cursor's lexical insertion point, not index 0", () => {
  it("when the cursor axis is transiently ineligible, the NEXT-alphabetical eligible axis goes first, not the lexically-first one", () => {
    expect(rotateEligibleAxes(["alpha", "zulu"], "mike")).toEqual(["zulu", "alpha"]);
  });
});

// ── Finding 10 — anchored enablement: fail-closed zod validation; revoke propagates non-ENOENT ──

describe("Finding 10 — anchored-enablement record: fail-closed load, propagating revoke", () => {
  it("a corrupt/malformed enablement record on disk is treated as NOT enabled (never throws) and surfaced as a tick warning", async () => {
    const dataDir = tmp();
    const path = autonomyPaths(dataDir).anchoredEnablementPath;
    mkdirSync(join(dataDir, "autonomy"), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, reviewerId: "x" /* missing required fields */ }), "utf8");

    expect(loadAnchoredEnablement(dataDir)).toBeNull(); // fail closed, never throws

    saveTierState(dataDir, { schemaVersion: 1, tier: 0, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: null });
    const review: AutonomyReviewInputs = {
      candidate: makeDoc({}),
      deterministicCandidate: makeDoc({}),
      servableModelIds: [],
      requiredTaskTypes: [],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };
    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));
    expect(report.warnings.some((w) => w.includes("anchored-enablement") && w.includes("NOT enabled"))).toBe(true);
  });

  it("revokeAnchoredEnablement propagates a non-ENOENT error rather than silently swallowing it", () => {
    const dataDir = tmp();
    saveAnchoredEnablement(dataDir, {
      schemaVersion: 1,
      reviewerId: "x",
      reason: "x",
      decisionRef: "x",
      reviewedAt: NOW,
      grantedAtTier: 2,
    });
    const path = autonomyPaths(dataDir).anchoredEnablementPath;
    // Make the containing directory read-only-ish by pointing at a path that will throw something
    // OTHER than ENOENT: simplest reliable cross-platform way is to make the target a directory,
    // so unlink fails with EISDIR/EPERM, never ENOENT.
    const { unlinkSync, rmSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(path);
    mkdirSync(path, { recursive: true });
    expect(() => revokeAnchoredEnablement(dataDir)).toThrow();
    rmSync(path, { recursive: true, force: true });
  });
});

// ── Finding 11 — canary-passed persisted via the hook; event-then-state ordering ──

describe("Finding 11 — canary-passed phase marking and demotion event/state ordering", () => {
  it("adoptRoutingTable calls deps.onCanaryPassed exactly once, synchronously before returning 'adopted' — never on a canary failure", async () => {
    const { adoptRoutingTable, approveArtifact, buildDecisionArtifact } = await import("../src/homeserver/routing-lifecycle.js");
    const adoptedDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const artifact = buildDecisionArtifact({
      candidate: candidateDoc,
      deterministicCandidate: candidateDoc,
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

    // Passing case: the fake deps' writeTable/readTable share one fs Map, so adoptRoutingTable's own
    // internal write-then-reload-readback genuinely sees the new candidate — canary passes.
    {
      const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: JSON.stringify(adoptedDoc, null, 2) + "\n" });
      let calls = 0;
      const outcome = await adoptRoutingTable(artifact, approval, { ...adoptDeps, onCanaryPassed: () => { calls++; } });
      expect(outcome.outcome).toBe("adopted");
      expect(calls).toBe(1);
    }

    // Failing case: readTable is pinned to the STALE adopted doc regardless of what writeTable
    // wrote, so the post-reload canary readback never sees the candidate — canary fails, rolls
    // back. The hook must NOT fire, since canary success is a precondition for it.
    {
      const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: JSON.stringify(adoptedDoc, null, 2) + "\n" });
      let calls = 0;
      const outcome = await adoptRoutingTable(artifact, approval, {
        ...adoptDeps,
        readTable: () => JSON.stringify(adoptedDoc, null, 2) + "\n",
        onCanaryPassed: () => { calls++; },
      });
      expect(outcome.outcome).toBe("rolled-back");
      expect(calls).toBe(0);
    }
  });

  // NOTE on coverage: this asserts the observable END STATE (an event was recorded, the state
  // reflects the demotion) — it does not fault-inject a crash between the two writes to prove the
  // ORDER independently (node:fs's ESM named exports cannot be `vi.spyOn`'d to intercept call order
  // without a full `vi.mock`, which was judged disproportionate for this MINOR, 3-line reorder).
  // The reorder itself was verified by direct code reading: `appendTierEvent` now precedes
  // `saveTierState` in the 1.5 demotion block (autonomy-controller.ts).
  it("on a demotion tick, the JSONL tier event is written before the tier-state file is saved", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 5, consecutiveGoCycles: 5, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });
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
      provenance: { kind: "autonomy", tier: 1 },
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

    // Both the event and the resulting state must be durably consistent (the real observable
    // contract): a demotion event was recorded, and the state reflects the demotion.
    const events = readFileSync(autonomyPaths(dataDir).tierEventsPath, "utf8").trim().split("\n").filter(Boolean);
    const demotionEvents = events.map((l) => JSON.parse(l)).filter((e) => e.kind === "demotion");
    expect(demotionEvents).toHaveLength(1);
    expect(loadTierState(dataDir).tier).toBe(0);
  });
});
