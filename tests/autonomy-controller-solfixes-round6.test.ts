/**
 * Regression tests for ROUND 6 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the re-review after round 5's fixes (finding count: 12 -> 8 -> 5). This
 * round closes the remaining concentrated items: fencing that was still check-THEN-write (not
 * atomic), the watchdog acting before claiming a revert, a discarded reconcile result that could
 * let the tick overwrite a pending journal, reconcile reading the intent before acquiring the
 * lease, and a migration that failed open. Each test targets the exact defect the review
 * reproduced against the pre-round-6-fix code.
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
  runAdoptionWatch,
  watchdogPaths,
  type AdoptionWatchRecord,
  type WatchdogRunnerDeps,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock, mutationLockDbPath, fencedWrite, MutationLockStaleError } from "../src/homeserver/mutation-lock.js";
import { manualRollback, deleteTableAndReload, adoptRoutingTable, approveArtifact, buildDecisionArtifact } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";
import { contentDigest, tableContentHash } from "../src/homeserver/evidence-identity.js";

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
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r6-"));
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

function staleTheLease(dataDir: string): void {
  const db = new Database(mutationLockDbPath(dataDir));
  db.prepare(`UPDATE mutation_lease SET acquired_at_ms = 0 WHERE id = 1`).run();
  db.close();
}

// ── Finding 1 — fencedWrite closes the check-then-write gap ──────────────────────

describe("Finding 1 — fencedWrite: the token check and the write commit inside ONE SQLite transaction", () => {
  it("fencedWrite refuses (throws, writes nothing) when the token is stale — the check and write cannot be split by a reclaim in between", () => {
    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    staleTheLease(dataDir);
    const reclaimer = acquireMutationLock(dataDir);

    let sideEffect = 0;
    expect(() => fencedWrite(dataDir, holder.token, () => { sideEffect++; })).toThrow(MutationLockStaleError);
    expect(sideEffect).toBe(0); // fn() never ran — the check-and-write is one atomic unit
    reclaimer.release();
  });

  it("fencedWrite runs fn() and returns its result when the token is current", () => {
    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    const result = fencedWrite(dataDir, holder.token, () => "ok");
    expect(result).toBe("ok");
    holder.release();
  });

  it("a stale holder's manualRollback is REFUSED (never writes), and the RollbackRecord honestly reports an UNRESOLVED state, not an ordinary failure", async () => {
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } }) });
    const before = fs.get(tablePath);

    const dataDir = tmp();
    const holder = acquireMutationLock(dataDir);
    staleTheLease(dataDir);
    const reclaimer = acquireMutationLock(dataDir);

    const fencedDeps: AdoptDeps = { ...adoptDeps, leaseContext: { dataDir, token: holder.token } };
    const rollback = await manualRollback({ deps: fencedDeps, snapshotRaw: priorRaw, reason: "test" });

    expect(rollback.restoreWriteOk).toBe(false);
    expect(rollback.staleLeaseRefused).toBe(true);
    expect(rollback.reason).toMatch(/stale holder must never roll back/i);
    expect(fs.get(tablePath)).toBe(before); // NOTHING was written — table is exactly as it was
    reclaimer.release();
  });

  it("adoptRoutingTable's candidate write is refused atomically via deps.leaseContext (never a separate check-then-write)", async () => {
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
    staleTheLease(dataDir);
    const reclaimer = acquireMutationLock(dataDir);

    const leasedDeps: AdoptDeps = { ...adoptDeps, leaseContext: { dataDir, token: holder.token } };
    await expect(adoptRoutingTable(artifact, approval, leasedDeps, { verifiedPriorRaw: adopted })).rejects.toThrow(MutationLockStaleError);
    expect(fs.get(tablePath)).toBe(adopted);
    reclaimer.release();
  });
});

// ── Finding 2 — watchdog CAS pending -> reverting BEFORE acting ───────────────────

describe("Finding 2 — the watchdog claims (CAS) a record for reverting BEFORE performing the external rollback", () => {
  it("the record is CAS-claimed to 'reverting' BEFORE the external rollback write is even attempted — claim precedes action, not the reverse", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const badRaw = tableJson({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    let statusAtWriteTime: string | undefined;
    let record: AdoptionWatchRecord;
    const { deps: adoptDeps, fs: fsMap } = fakeAdoptDeps({
      initialTable: badRaw,
      writeTable: (path, data) => {
        // Read the record's OWN durable status at the exact moment the external write is attempted
        // — this is the direct test of "claim before act": under the pre-round-6 code, the write
        // happened FIRST and the record was only ever resolved (to "breach") AFTER, so this read
        // would see "pending" here; under the fix, the CAS claim (pending -> reverting) already
        // landed, in its own prior transaction, before this callback ever runs.
        statusAtWriteTime = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)?.status;
        fsMap.set(path, data);
      },
    });
    record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      // Round 7 finding 1: `candidateHash` must be the REAL content hash of the live table
      // (`badRaw`) — `classifyLiveTable` now compares it against the live table before any revert
      // is attempted, and a placeholder string here would misclassify this record as "superseded"
      // (matches neither candidate nor snapshot), short-circuiting the very claim-before-act
      // behavior this test exists to prove.
      candidateHash: tableContentHash(badRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: (taskTypes, _since, untilIso) =>
        taskTypes.map((t) => ({
          taskType: t,
          sampleSize: 20,
          errorRate: untilIso === record.adoptedAt ? 0.05 : 0.9,
          escalationRate: 0.1,
          verifierFailRate: 0.05,
          retryRate: 0.1,
          latencyP50Ms: 1000,
        })),
      nowIso: () => "2026-07-20T01:00:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };

    await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);

    expect(statusAtWriteTime).toBe("reverting");
  });

  it("recovery: a stuck 'reverting' row whose claiming lease is no longer current is re-examined — already-reverted content resolves directly to 'breach' without repeating the external action", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw }); // the live table ALREADY matches the snapshot
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: "h-stuck",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // Simulate a crashed claim: a PAST lease token (never renewed, long gone) claimed this record
    // for reverting and then died before finalizing.
    const staleClaimHolder = acquireMutationLock(dataDir);
    const staleToken = staleClaimHolder.token;
    staleClaimHolder.release(); // the lease itself is gone — token staleToken is no longer current
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "reverting", revertingToken: staleToken, revertingAt: "2026-07-20T00:30:00.000Z" };
    saveWatchdogState(dataDir, wstate);

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: () => [],
      nowIso: () => "2026-07-20T02:00:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };
    const report = await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);

    const recovered = report.items.find((i) => i.record.id === record.id);
    expect(recovered?.action).toBe("reverted");
    expect(recovered?.revert?.status).toBe("restored");
    const finalState = loadWatchdogState(dataDir).records.find((r) => r.id === record.id);
    expect(finalState?.status).toBe("breach");
    expect(finalState?.revertingToken).toBeUndefined();
    // Quarantine was written only on this (successful) recovery finalize.
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();
  });

  it("a 'reverting' row whose claiming lease IS still current is left alone (not raced) by a concurrent watch run", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: "h-inflight",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const genuinelyActiveHolder = acquireMutationLock(dataDir); // still held — a real in-flight revert
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "reverting", revertingToken: genuinelyActiveHolder.token, revertingAt: "2026-07-20T00:30:00.000Z" };
    saveWatchdogState(dataDir, wstate);

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: () => [],
      nowIso: () => "2026-07-20T00:31:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };
    const report = await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);

    expect(report.items.find((i) => i.record.id === record.id)).toBeUndefined(); // untouched this run
    expect(loadWatchdogState(dataDir).records.find((r) => r.id === record.id)?.status).toBe("reverting");
    genuinelyActiveHolder.release();
  });
});

// ── Finding 3 — the tick honors reconcile's result; the journal is single-slot ────

describe("Finding 3 — a nonterminal reconcile outcome suppresses the whole adopt phase; the journal refuses a competing intent", () => {
  it("saveAdoptionIntent REFUSES to overwrite a different PENDING intent (single-slot journal)", () => {
    const dataDir = tmp();
    const first: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-a",
      createdAt: NOW,
      taskType: "classify",
      candidateHash: "h1",
      decisionRef: "r",
      approvedBy: "x",
      tier: 1,
      priorRaw: null,
      phase: "planned",
      status: "pending",
    };
    saveAdoptionIntent(dataDir, first);
    const second: AdoptionIntent = { ...first, id: "intent-b", candidateHash: "h2" };
    expect(() => saveAdoptionIntent(dataDir, second)).toThrow(/single-slot/i);
    // Updating the SAME intent (identical id) is always allowed.
    expect(() => saveAdoptionIntent(dataDir, { ...first, phase: "table-written" })).not.toThrow();
  });

  it("a 'restore-failed-will-retry' reconcile outcome makes the tick skip the adopt phase entirely and reports cycleOutcome: 'unhealthy'", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: JSON.stringify(candidateDoc, null, 2) + "\n",
      writeTable: () => {
        throw new Error("simulated disk-full on restore write");
      },
    });
    saveAdoptionIntent(dataDir, {
      schemaVersion: 1,
      id: "intent-stuck",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw,
      phase: "table-written",
      status: "pending",
    });
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 5, consecutiveGoCycles: 5, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: null });

    const candidate = makeDoc({ classify: { model: "gemma4", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const review: AutonomyReviewInputs = {
      candidate,
      deterministicCandidate: candidate,
      servableModelIds: ["mellum", "qwen3-coder-next-80b", "gemma4"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };
    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    expect(report.adopted).toHaveLength(0); // no adopt attempt this tick at all
    expect(report.cycleOutcome).toBe("unhealthy");
    expect(loadAdoptionIntent(dataDir)?.status).toBe("pending"); // still the SAME unresolved intent
  });
});

// ── Finding 4 — reconcile acquires the lease BEFORE loading the intent ────────────

describe("Finding 4 — reconcile acquires the lease first, then loads (and revalidates) the intent", () => {
  it("with NO pending intent at all, reconcile STILL reports lock-busy (not 'none') when the lease is held externally — proving it contends for the lease before even checking for an intent", async () => {
    const dataDir = tmp();
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: null });
    expect(loadAdoptionIntent(dataDir)).toBeNull(); // genuinely nothing to reconcile

    const externalHolder = acquireMutationLock(dataDir);
    try {
      const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);
      expect(result.action).toBe("restore-deferred-lock-busy");
    } finally {
      externalHolder.release();
    }
  });

  it("with no pending intent and the lease free, reconcile reports 'none' (the ordinary, overwhelmingly common case)", async () => {
    const dataDir = tmp();
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: null });
    const result = await reconcileAdoptionIntent(dataDir, NOW, adoptDeps);
    expect(result.action).toBe("none");
  });
});

// ── Finding 5 — migration fails CLOSED, not open ──────────────────────────────────

describe("Finding 5 — legacy JSON migration fails closed on invalid data, and re-tries (never silently marks done) until it succeeds", () => {
  it("a legacy state.json with a record failing schema validation THROWS — never silently skipped, never partially imported", () => {
    const dataDir = tmp();
    const { root, statePath } = watchdogPaths(dataDir);
    mkdirSync(root, { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            id: "bad-record",
            adoptedAt: "2026-07-01T00:00:00.000Z",
            candidateHash: "h1",
            decisionRef: "r",
            approvedBy: "x",
            changedTaskTypes: ["classify"],
            snapshotPath: null,
            status: "not-a-real-status", // fails the schema
            lastEvaluatedAt: null,
          },
        ],
      }),
      "utf8"
    );

    expect(() => loadWatchdogState(dataDir)).toThrow(/failed to migrate/i);
    // Retried (not silently marked done) — a SECOND call throws again, identically, since the
    // marker was never written.
    expect(() => loadWatchdogState(dataDir)).toThrow(/failed to migrate/i);
  });

  it("once the legacy file is fixed, the NEXT access migrates successfully (the marker gates retry, not table-emptiness)", () => {
    const dataDir = tmp();
    const { root, statePath } = watchdogPaths(dataDir);
    mkdirSync(root, { recursive: true });
    const goodRecord = {
      id: "good-record",
      adoptedAt: "2026-07-01T00:00:00.000Z",
      candidateHash: "h1",
      decisionRef: "r",
      approvedBy: "x",
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      status: "healthy",
      lastEvaluatedAt: null,
    };
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, records: [{ ...goodRecord, status: "bad-status" }] }), "utf8");
    expect(() => loadWatchdogState(dataDir)).toThrow();

    // Fix the file — the marker was never written, so the NEXT access retries from scratch.
    writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, records: [goodRecord] }), "utf8");
    const migrated = loadWatchdogState(dataDir);
    expect(migrated.records).toHaveLength(1);
    expect(migrated.records[0]?.id).toBe("good-record");
  });
});

// ── Follow-ups ─────────────────────────────────────────────────────────────────────

describe("Follow-up — legacy tier1EnteredAt:null at Tier 1+ is conservatively backfilled to NOW", () => {
  it("an old healthy Tier-1 record adopted BEFORE the backfilled epoch does not count as current-tenure evidence", async () => {
    const dataDir = tmp();
    // A genuinely LEGACY state file: no tier1EnteredAt at all, already at Tier 1.
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: TEST_POLICY.tier1UnlockCycles - 1,
      consecutiveGoCycles: TEST_POLICY.tier1UnlockCycles - 1,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
    } as unknown as TierState); // deliberately missing tier1EnteredAt — a genuinely legacy shape
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw });
    const oldHealthyRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2020-01-01T00:00:00.000Z", // long before "now" — pre-migration evidence
      candidateHash: "h-old",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === oldHealthyRecord.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "healthy" };
    saveWatchdogState(dataDir, wstate);

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
    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
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

    // Without the conservative backfill, the pre-existing OLD healthy record would count and this
    // would promote to Tier 2. With it, the tenure "starts now", so the old record does not count,
    // and promotion is correctly blocked.
    expect(report.tierAfter).toBe(1);
    expect(loadTierState(dataDir).tier1EnteredAt).toBe(NOW);
  });
});

describe("Follow-up — deleteTableAndReload treats a verified ENOENT as idempotent success, not a failure", () => {
  it("deleting an already-absent table reports restoreWriteOk: true", async () => {
    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: null,
      deleteTable: () => {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });
    const record = await deleteTableAndReload({ deps: adoptDeps, reason: "test" });
    expect(record.restoreWriteOk).toBe(true);
  });
});

describe("Follow-up — bulk save helpers never delete rows absent from their argument (upsert-only)", () => {
  it("saveWatchdogState with fewer records than exist leaves the OTHER records untouched", () => {
    const dataDir = tmp();
    const a = recordAdoptionForWatch({
      dataDir,
      adoptedAt: NOW,
      candidateHash: "ha",
      decisionRef: "r",
      approvedBy: "x",
      changedTaskTypes: ["classify"],
      priorRaw: null,
    });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: NOW,
      candidateHash: "hb",
      decisionRef: "r",
      approvedBy: "x",
      changedTaskTypes: ["extract"],
      priorRaw: null,
    });
    expect(loadWatchdogState(dataDir).records).toHaveLength(2);

    // Save a state containing ONLY `a` (mutated) — `b` is not mentioned at all.
    saveWatchdogState(dataDir, { schemaVersion: 1, records: [{ ...a, status: "healthy" }] });

    const after = loadWatchdogState(dataDir);
    expect(after.records).toHaveLength(2); // NOT deleted down to 1
    expect(after.records.find((r) => r.id === a.id)?.status).toBe("healthy");
  });
});
