/**
 * Regression tests for the Sol (xhigh) cross-model review findings on gille-inference#49's
 * autonomy controller (2 critical + 4 major + 1 minor, all independently reproduced adversarially
 * before this fix-forward PR). Each `describe` block below is named after its finding number and
 * is written to FAIL against the pre-fix `runAutonomyTick` (RED), then PASS once the fix lands
 * (GREEN) — see the PR body for the exact red/green transition recorded per finding.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
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
  AUTONOMY_APPROVER_PREFIX,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
  type AdoptedRawEntry,
  type TierState,
  type AdoptionIntent,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  recordAdoptionForWatch,
  type GuardMetricSnapshot,
  type AdoptionWatchRecord,
} from "../src/homeserver/adoption-watchdog.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import type { DiffableRoutingTable } from "../src/homeserver/routing-table-diff.js";
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
  return JSON.stringify({ routing: doc.routing, escalateToFrontier: doc.escalateToFrontier });
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
    servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b", "good-model", "bad-model", "gemma4"],
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
  };
  return { deps, fs, tablePath };
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

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-"));
}

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

function noRecheckGate(gate: CalibrationGateDecision | null = null) {
  return () => gate;
}

// ── Finding 1 (CRITICAL): stale snapshot across WATCH ─────────────────────────────

describe("Finding 1 (CRITICAL) — stale snapshot across WATCH", () => {
  it("does not restore a just-watchdog-reverted axis when adopting an unrelated axis in the same tick", async () => {
    const dataDir = tmp();
    // Tier 2 (not 1): this tick's "extract" breach ALSO demotes the tier by one level (existing,
    // correct behavior) — starting one tier higher means the demotion (2->1) does not itself
    // disqualify the "classify" adoption this test is isolating, which is verifier-backed and
    // only requires Tier >= 1.
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });

    // The live table currently holds "extract: bad-model" (as if a PRIOR tick autonomously
    // adopted it and it is now regressing) alongside "classify: mellum" (about to be legitimately
    // upgraded this tick).
    const initialTable = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "bad-model", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    });
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable });

    // A pending watch record for "extract" whose snapshot is the GOOD prior table — this is what
    // WATCH will revert TO once it detects the breach below.
    const goodSnapshotRaw = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "good-model", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-17T00:00:00.000Z", // well before NOW — window (1h) completes
      candidateHash: "h-prior-extract",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw: goodSnapshotRaw,
    });

    // The review candidate the CLI would have built from LEDGER evidence BEFORE watch ran: a
    // legitimate new proposal for "classify", and "extract" still recommending the SAME bad model
    // (ledger evidence hasn't changed this tick — only the ADOPTED TABLE is about to change, via
    // watch's revert).
    const candidate = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
      extract: { model: "bad-model", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    });
    const staleAdopted: DiffableRoutingTable = {
      routing: {
        classify: { model: "mellum", verdict: "delegate-local", attempts: 50 },
        extract: { model: "bad-model", verdict: "delegate-local", attempts: 50 },
      },
    };
    const staleAdoptedRaw: Record<string, AdoptedRawEntry | undefined> = {
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      extract: { model: "bad-model", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    };

    // Pre-fix code takes `adopted`/`adoptedRaw` straight from here (the STALE, pre-watch read);
    // post-fix code drops these two fields from `AutonomyReviewInputs` entirely and re-reads the
    // live table itself after WATCH — see the finding-1 fix. Left as plain extra properties (this
    // file is never `tsc`-checked; only `src/**` is, per tsconfig.json's `include`) so the SAME
    // test scenario runs unmodified across the red -> green transition.
    const review = {
      candidate,
      deterministicCandidate: candidate,
      adopted: staleAdopted,
      adoptedRaw: staleAdoptedRaw,
      servableModelIds: ["mellum", "qwen3-coder-next-80b", "good-model", "bad-model"],
      requiredTaskTypes: ["classify", "extract"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const deps: AutonomyTickDeps = {
      dataDir,
      nowIso: () => NOW,
      killSwitchOn: () => false,
      decisionRef: "gille-inference#49",
      policy: TEST_POLICY,
      watchdogPolicy: WATCHDOG_POLICY,
      review,
      queryGuardMetrics: (taskTypes, _since, untilIso) => {
        const isBaseline = untilIso === "2026-07-17T00:00:00.000Z";
        return taskTypes.map((t) => snapshot({ taskType: t, errorRate: t === "extract" && !isBaseline ? 0.3 : 0.05 }));
      },
      adoptDeps,
      recomputeCalibrationGate: noRecheckGate(),
    };

    await runAutonomyTick(deps);

    // WATCH must have reverted "extract" back to good-model — and the SEPARATE, unrelated
    // adoption of "classify" this same tick must not silently undo that revert.
    const finalTable = JSON.parse(fs.get(tablePath)!) as { routing: Record<string, { model: string | null }> };
    expect(finalTable.routing["extract"]?.model).toBe("good-model");
  });
});

// ── Finding 2 (CRITICAL): adopt commits before recordAdoptionForWatch ─────────────

describe("Finding 2 (CRITICAL) — crash between the table write and recordAdoptionForWatch", () => {
  it("recovers an orphaned adoption (live table matches, no watch record) on the next tick", async () => {
    const dataDir = tmp();

    // Simulate: a PRIOR (crashed) tick's `adoptRoutingTable` call succeeded (the live table
    // reflects the new candidate) but the process died before `recordAdoptionForWatch` ran.
    // `adoptRoutingTable` writes the FULL `RoutingTableDoc` (pretty-printed) — mirror that exactly
    // so `tableContentHash` genuinely matches `candidateHash`, the same invariant the round-trip
    // test above locks in.
    const candidateDoc = makeDoc({
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 },
    });
    const liveRaw = JSON.stringify(candidateDoc, null, 2) + "\n";
    const candidateHash = contentDigest(JSON.stringify(candidateDoc));
    // The intent journal is scaffolding this fix introduces — a crashed tick would have left
    // exactly this record `"pending"`.
    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-1",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash,
      decisionRef: "gille-inference#49",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      tier: 1,
      priorRaw: tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } }),
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: liveRaw });
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });

    // This tick's own review finds nothing further to change (ledger evidence still agrees with
    // what's already live) — isolating the reconciliation behavior from any new adoption logic.
    // (`adopted`/`adoptedRaw` reflect the SAME already-adopted content — pre-fix code reads these
    // straight from here; post-fix code re-reads the live table itself and these are ignored.)
    const review = {
      candidate: candidateDoc,
      deterministicCandidate: candidateDoc,
      adopted: { routing: { classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40 } } },
      adoptedRaw: { classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } },
      servableModelIds: ["qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const deps: AutonomyTickDeps = {
      dataDir,
      nowIso: () => NOW,
      killSwitchOn: () => false,
      decisionRef: "gille-inference#49",
      policy: TEST_POLICY,
      watchdogPolicy: WATCHDOG_POLICY,
      review,
      queryGuardMetrics: () => [],
      adoptDeps,
      recomputeCalibrationGate: noRecheckGate(),
    };

    await runAutonomyTick(deps);

    // The orphaned adoption must now be watched (parachute opened) and the intent finalized —
    // never left permanently invisible to the watchdog.
    const state = loadWatchdogState(dataDir);
    expect(state.records.some((r) => r.candidateHash === candidateHash)).toBe(true);
    expect(loadAdoptionIntent(dataDir)?.status).toBe("finalized");
  });

  it("reconcileAdoptionIntent itself: aborts when the live table does NOT match the intent (write never completed)", () => {
    const dataDir = tmp();
    const intent: AdoptionIntent = {
      schemaVersion: 1,
      id: "intent-2",
      createdAt: "2026-07-20T12:00:00.000Z",
      taskType: "classify",
      candidateHash: "sha256:doesnotmatch",
      decisionRef: "r",
      approvedBy: "x",
      tier: 1,
      priorRaw: null,
      status: "pending",
    };
    saveAdoptionIntent(dataDir, intent);
    const result = reconcileAdoptionIntent(dataDir, NOW, () => tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 1 } }));
    expect(result.action).toBe("aborted");
    expect(loadAdoptionIntent(dataDir)?.status).toBe("aborted");
  });
});

// ── Finding 3 (MAJOR): multi-axis same-tick overwrite ─────────────────────────────

describe("Finding 3 (MAJOR) — multi-axis same-tick overwrite", () => {
  it("adopts AT MOST ONE axis per tick — the other eligible axis is left untouched, not silently reverted", async () => {
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

    const review = {
      candidate,
      deterministicCandidate: candidate,
      adopted,
      adoptedRaw,
      servableModelIds: ["mellum", "qwen3-coder-next-80b", "gemma4"],
      requiredTaskTypes: ["classify", "extract"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const deps: AutonomyTickDeps = {
      dataDir,
      nowIso: () => NOW,
      killSwitchOn: () => false,
      decisionRef: "gille-inference#49",
      policy: TEST_POLICY,
      watchdogPolicy: WATCHDOG_POLICY,
      review,
      queryGuardMetrics: () => [],
      adoptDeps,
      recomputeCalibrationGate: noRecheckGate(),
    };

    const report = await runAutonomyTick(deps);

    // Exactly one axis is actually adopted this tick.
    const adoptedOutcomes = report.adopted.filter((a) => a.outcome.outcome === "adopted");
    expect(adoptedOutcomes).toHaveLength(1);

    // Whichever axis was NOT chosen must retain its ORIGINAL pre-tick value on disk — never
    // silently reverted by the chosen axis's own write.
    const finalTable = JSON.parse(fs.get(tablePath)!) as { routing: Record<string, { model: string | null }> };
    const chosen = adoptedOutcomes[0]!.taskType;
    const other = chosen === "classify" ? "extract" : "classify";
    expect(finalTable.routing[other]?.model).toBe("mellum"); // unchanged from the initial table
    expect(finalTable.routing[chosen]?.model).not.toBe("mellum"); // the chosen axis DID change
  });
});

// ── Finding 4 (MAJOR): failed adoption counts healthy and can promote ─────────────

describe("Finding 4 (MAJOR) — a failed adoption must not count as a healthy cycle or promote", () => {
  it("a reload failure marks the cycle unhealthy, resets the streak, and never promotes", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: TEST_POLICY.tier1UnlockCycles - 1, // one more healthy cycle would promote
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
    });

    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable,
      reload: () => ({ ok: false, error: "simulated reload failure" }),
    });

    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const review = {
      candidate,
      deterministicCandidate: candidate,
      adopted: { routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50 } } },
      adoptedRaw: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } },
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const deps: AutonomyTickDeps = {
      dataDir,
      nowIso: () => NOW,
      killSwitchOn: () => false,
      decisionRef: "gille-inference#49",
      policy: TEST_POLICY,
      watchdogPolicy: WATCHDOG_POLICY,
      review,
      queryGuardMetrics: () => [],
      adoptDeps,
      recomputeCalibrationGate: noRecheckGate(),
    };

    const report = await runAutonomyTick(deps);

    expect(report.healthyCycle).toBe(false);
    expect(report.tierAfter).toBe(report.tierBefore); // must NOT promote despite the high streak
    expect(loadTierState(dataDir).consecutiveHealthyCycles).toBe(0);
  });
});

// ── Finding 5 (MAJOR): crash loses a required demotion ────────────────────────────

describe("Finding 5 (MAJOR) — a resolved-but-unacknowledged breach must still demote on the next tick", () => {
  it("reconciles an already-'breach'-status watchdog record that was never acknowledged by the tier ladder", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 7, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });

    // Simulate: a PAST tick's WATCH pass already durably resolved this record to "breach" (and
    // saved watchdog state internally) but the process crashed before the tier demotion for it
    // was ever persisted. `runAdoptionWatch` never re-evaluates a non-"pending" record, so this
    // tick's OWN watch pass will find NOTHING to do for it.
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-10T00:00:00.000Z",
      candidateHash: "h-already-breached",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}2`,
      changedTaskTypes: ["extract"],
      priorRaw: null,
    });
    const state = loadWatchdogState(dataDir);
    const idx = state.records.findIndex((r) => r.id === record.id);
    state.records[idx] = { ...state.records[idx]!, status: "breach", lastEvaluatedAt: "2026-07-19T00:00:00.000Z" };
    // Write it back directly (bypassing runAdoptionWatch, which is exactly the point — this
    // record is ALREADY resolved, nothing will touch it again).
    const { saveWatchdogState } = await import("../src/homeserver/adoption-watchdog.js");
    saveWatchdogState(dataDir, state);

    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable });

    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const review = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      adopted: { routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50 } } },
      adoptedRaw: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } },
      servableModelIds: ["mellum"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const deps: AutonomyTickDeps = {
      dataDir,
      nowIso: () => NOW,
      killSwitchOn: () => false,
      decisionRef: "gille-inference#49",
      policy: TEST_POLICY,
      watchdogPolicy: WATCHDOG_POLICY,
      review,
      queryGuardMetrics: () => [], // nothing "pending" this tick — watch.items will be empty
      adoptDeps,
      recomputeCalibrationGate: noRecheckGate(),
    };

    const report = await runAutonomyTick(deps);

    expect(report.tierAfter).toBe(1); // demoted one level despite watch.items being empty this tick
    expect(loadTierState(dataDir).consecutiveHealthyCycles).toBe(0);
    expect(loadTierState(dataDir).ackedBreachIds).toContain(record.id);
  });
});

// ── Finding 6 (MAJOR): Tier-2 organic adoption uses a stale gate ─────────────────

describe("Finding 6 (MAJOR) — organic-dependent adoption must recheck the live gate at adopt time", () => {
  it("refuses an organic-dependent adoption when the LIVE gate has decayed to HOLD since review time", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [] });

    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable });

    // deterministicCandidate finds NOTHING for "classify" — the change is explained ONLY by
    // organic-judge evidence.
    const candidate = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 } });
    const deterministicCandidate = makeDoc({});

    const goEnabledGate: CalibrationGateDecision = {
      schemaVersion: 1,
      policyId: "policy-1",
      generatedAt: "2026-07-20T00:00:00.000Z",
      verdict: "GO",
      reasons: ["all thresholds cleared"],
      thresholds: { minStratumN: 1, minPrecisionLowerBound: 0, minRecallLowerBound: 0, maxDisagreementUpperBound: 1 },
      metrics: {} as CalibrationGateDecision["metrics"],
      enabling: { reviewerId: "magnus", reason: "reviewed", decisionRef: "grimnir#88", reviewedAt: "2026-07-20T00:00:00.000Z" },
    };
    const holdGateNow: CalibrationGateDecision = { ...goEnabledGate, verdict: "HOLD", reasons: ["anchored agreement decayed"], enabling: null };

    const review = {
      candidate,
      deterministicCandidate,
      adopted: { routing: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50 } } },
      adoptedRaw: { classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } },
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: goEnabledGate, // review-time snapshot: GO+enabled
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const deps: AutonomyTickDeps = {
      dataDir,
      nowIso: () => NOW,
      killSwitchOn: () => false,
      decisionRef: "gille-inference#49",
      policy: TEST_POLICY,
      watchdogPolicy: WATCHDOG_POLICY,
      review,
      queryGuardMetrics: () => [],
      adoptDeps,
      recomputeCalibrationGate: () => holdGateNow, // the gate decayed by adopt time
    };

    const report = await runAutonomyTick(deps);

    expect(report.adopted.filter((a) => a.outcome.outcome === "adopted")).toHaveLength(0);
  });
});

// ── Finding 7 (MINOR): approver-prefix spoofing ───────────────────────────────────

describe("Finding 7 (MINOR) — approver-prefix string is never accounting evidence", () => {
  it("a MANUAL record whose approvedBy happens to start with the autonomy prefix is NOT counted as autonomous", () => {
    const dataDir = tmp();
    // A human ran `routing-lifecycle-cli.ts adopt --approved-by "autonomy-controller:tier1"` —
    // nothing stops an operator from typing this exact string. `provenance` is correctly omitted
    // (this call site never sets it) since it is a genuinely manual adoption.
    const spoofed = recordAdoptionForWatch({
      dataDir,
      adoptedAt: NOW,
      candidateHash: "h-manual-spoofed",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw: null,
    });

    const budget = computeRiskBudgetStatus([spoofed], NOW, TEST_POLICY);
    expect(budget.used).toBe(0);

    const cooldown = routeCooldownActive([spoofed], "classify", NOW, TEST_POLICY);
    expect(cooldown.active).toBe(false);

    expect(computeAutonomousRevertRate([spoofed])).toBe(0);
  });

  it("a genuine autonomous record (structured provenance) IS counted, regardless of its approvedBy text", () => {
    const dataDir = tmp();
    const real = recordAdoptionForWatch({
      dataDir,
      adoptedAt: NOW,
      candidateHash: "h-real-autonomy",
      decisionRef: "r",
      approvedBy: "some free-text display string that does not match any prefix convention",
      changedTaskTypes: ["classify"],
      priorRaw: null,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const budget = computeRiskBudgetStatus([real], NOW, TEST_POLICY);
    expect(budget.used).toBe(1);
  });
});

// ── tableContentHash round-trip (load-bearing for findings 1 and 2) ───────────────

describe("tableContentHash — pretty-print/compact round-trip invariant", () => {
  it("matches contentDigest(JSON.stringify(candidate)) even after a pretty-printed disk round-trip", () => {
    const doc = makeDoc({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 12, passRate: 0.77 },
      extract: { model: null, verdict: "escalate-frontier", attempts: 0, passRate: 0 },
    });
    const directHash = contentDigest(JSON.stringify(doc));
    const writtenBytes = JSON.stringify(doc, null, 2) + "\n"; // exactly what adoptRoutingTable writes
    expect(tableContentHash(writtenBytes)).toBe(directHash);
  });

  it("returns the sentinel for a null table, never a fabricated hash", () => {
    expect(tableContentHash(null)).toBe("(none)");
  });
});
