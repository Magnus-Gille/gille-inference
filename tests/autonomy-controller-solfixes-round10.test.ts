/**
 * Regression tests for ROUND 10 (FINAL) of the Sol (xhigh) cross-model review on
 * gille-inference#49's autonomy controller. Exactly 2 HIGH findings, both marker-ordering bugs in
 * round 9's own `pendingMergeHash` mechanism, plus 2 follow-ups.
 *
 *   1. The pending-merge marker was persisted AFTER `manualRollback` performed the partial
 *      write+reload — a crash after the write but during reload left NO marker, so recovery
 *      classified the merged (already-restored) table as "superseded" and finalized WITHOUT ever
 *      confirming the reload actually happened.
 *   2. Recovery read the snapshot/live table BEFORE checking the marker, and any transient
 *      read/parse error cleared the marker (`pendingMerge: null`) via the generic catch — wiping a
 *      genuinely still-valid "this is my own in-flight attempted merge" marker on nothing more than
 *      a momentary I/O blip.
 *   3+4. Follow-ups: a same-cycle "skipped-lock-busy" breach now also appears in
 *      `unresolvedReverts`/the exit-3 CLI scope, not just the adopt-suppression signal; the two
 *      regression tests above are themselves the mandatory follow-up deliverables Sol asked for.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAutonomyTick,
  saveTierState,
  AUTONOMY_APPROVER_PREFIX,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  saveWatchdogState,
  recordAdoptionForWatch,
  runAdoptionWatch,
  type WatchdogRunnerDeps,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock } from "../src/homeserver/mutation-lock.js";
import { autonomyTickExitCode } from "../scripts/autonomy-tick-cli.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import { tableContentHash } from "../src/homeserver/evidence-identity.js";

const NOW = "2026-07-23T00:00:00.000Z";

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
  servableModelIdsAfterReload?: () => string[] | null;
}): { deps: AdoptDeps; fs: Map<string, string>; tablePath: string } {
  const tablePath = "/virtual/m5-routing.json";
  const fs = new Map<string, string>();
  if (p.initialTable !== null) fs.set(tablePath, p.initialTable);
  const deps: AdoptDeps = {
    tablePath,
    readTable: p.readTable ?? ((path) => { if (!fs.has(path)) throw new Error(`ENOENT: ${path}`); return fs.get(path)!; }),
    writeTable: p.writeTable ?? ((path, data) => fs.set(path, data)),
    reload: p.reload ?? (() => ({ ok: true })),
    servableModelIdsAfterReload: p.servableModelIdsAfterReload ?? (() => ["mellum", "qwen3-coder-next-80b", "gemma4", "good-model", "bad-model", "bad-classify-model"]),
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
    deleteTable: p.deleteTable ?? ((path) => fs.delete(path)),
  };
  return { deps, fs, tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r10-"));
}

function noRecheckGate() {
  return () => null;
}

function baseDeps(p: { dataDir: string; review: AutonomyReviewInputs; adoptDeps: AdoptDeps; queryGuardMetrics?: AutonomyTickDeps["queryGuardMetrics"] }): AutonomyTickDeps {
  return {
    dataDir: p.dataDir,
    nowIso: () => NOW,
    killSwitchOn: () => false,
    decisionRef: "gille-inference#49",
    policy: TEST_POLICY,
    watchdogPolicy: WATCHDOG_POLICY,
    review: p.review,
    queryGuardMetrics: p.queryGuardMetrics ?? (() => []),
    adoptDeps: p.adoptDeps,
    recomputeCalibrationGate: noRecheckGate(),
  };
}

function breachingGuardMetrics(adoptedAt: string) {
  return (taskTypes: string[], _sinceIso: string, untilIso: string) =>
    taskTypes.map((t) => ({
      taskType: t,
      sampleSize: 20,
      errorRate: untilIso === adoptedAt ? 0.05 : 0.9,
      escalationRate: 0.1,
      verifierFailRate: 0.05,
      retryRate: 0.1,
      latencyP50Ms: 1000,
    }));
}

function staleClaimToken(dataDir: string): number {
  const holder = acquireMutationLock(dataDir);
  const token = holder.token;
  holder.release();
  return token;
}

// ── Finding 1 — the marker is persisted BEFORE the write+reload, not after ───────

describe("Finding 1 — the pending-merge marker is persisted BEFORE manualRollback's write+reload", () => {
  it("a crash 'captured' mid-reload already shows the marker persisted, and a normal completion confirms reload+canary — never resolves 'superseded' (Sol's exact concern)", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    const aCandidateRaw = tableJson({
      classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    // A later, unrelated adoption changed ONLY "extract" — the live table still carries this
    // record's OWN bad "classify" value verbatim, which is exactly what makes the whole-table hash
    // read "superseded" (round 8's own per-axis refinement then kicks in).
    const liveAfterB = tableJson({
      classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      extract: { model: "newer-extract-model", verdict: "delegate-local", attempts: 30, passRate: 0.95 },
    });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-22T00:00:00.000Z",
      candidateHash: tableContentHash(aCandidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      candidateRaw: aCandidateRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // Captures whether the marker is ALREADY on the durable record at the exact moment `reload` is
    // invoked — i.e. DURING manualRollback's write-then-reload sequence, before this JS call even
    // knows the outcome. Under the pre-round-10 code, the marker is only ever written AFTERWARD, in
    // the (not-yet-reached, since this reload succeeds) failure branch — so this would read
    // undefined/null there. Under round 10's fix, `markPendingMergeAttempt` already ran before
    // `manualRollback` was even called.
    let markerHashDuringReload: string | null | undefined = "UNSET" as unknown as string;
    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: liveAfterB,
      reload: () => {
        const persisted = loadWatchdogState(dataDir).records.find((r) => r.id === record.id);
        markerHashDuringReload = persisted?.pendingMergeHash ?? null;
        return { ok: true };
      },
    });

    const report = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: breachingGuardMetrics(record.adoptedAt), nowIso: () => "2026-07-22T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    expect(markerHashDuringReload).toBeTruthy();

    const item = report.items[0]!;
    expect(item.action).toBe("reverted-partial");
    expect(item.revert?.status).toBe("restored"); // confirmed — NEVER "superseded"

    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.status).toBe("breach"); // finalized, not superseded
    expect(after.pendingMergeHash).toBeUndefined(); // cleared on confirmed finalize
  });

  it("a marker-but-never-wrote state (a pre-write crash) is safe: recovery finds a marker whose hash matches neither the merge nor the current live table, clears it, and reclassifies fresh", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const candidateRaw = tableJson({ classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-22T00:00:00.000Z",
      candidateHash: tableContentHash(candidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      candidateRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // Simulate "the marker was persisted (item 1's fix), then the process crashed BEFORE the write
    // ever ran" — the live table still shows the ORIGINAL (pre-write) candidate content, which does
    // NOT match the marker's (intended, never-achieved) hash.
    const bogusIntendedMergeRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = {
      ...wstate.records[idx]!,
      status: "reverting",
      revertingToken: staleClaimToken(dataDir),
      revertingAt: "2026-07-22T00:30:00.000Z",
      pendingMergeHash: tableContentHash(bogusIntendedMergeRaw),
      pendingMergeAxes: ["classify"],
    };
    saveWatchdogState(dataDir, wstate);

    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: candidateRaw }); // unchanged since "before the crash"

    const report = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: () => [], nowIso: () => "2026-07-22T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    // The hash-mismatch path correctly reclassifies fresh: live still matches THIS record's own
    // candidateHash (nothing was ever superseded — the crash happened before anything wrote), so it
    // takes the ordinary whole-table "matches-candidate" revert path and confirms normally.
    const item = report.items.find((i) => i.record.id === record.id)!;
    expect(item.action).toBe("reverted");
    expect(item.revert?.status).toBe("restored");
    expect(fs.get(tablePath)).toBe(priorRaw);

    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.status).toBe("breach");
    expect(after.pendingMergeHash).toBeUndefined(); // cleared, never retried against a merge that never happened
  });
});

// ── Finding 2 — a transient read error PRESERVES the marker, never clears it ─────

describe("Finding 2 — a transient read/parse error preserves an existing pending-merge marker instead of clearing it", () => {
  it("a live-table read failure while a marker exists leaves the marker EXACTLY as it was, failure-marks the attempt, and never finalizes", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-22T00:00:00.000Z",
      candidateHash: "h-candidate",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // A PRIOR incomplete partial-restore attempt already left a pending-merge marker on this record.
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = {
      ...wstate.records[idx]!,
      status: "reverting",
      revertingToken: staleClaimToken(dataDir),
      revertingAt: "2026-07-22T00:30:00.000Z",
      pendingMergeHash: "sha256:some-prior-attempted-merge",
      pendingMergeAxes: ["classify"],
      revertAttempts: 1,
      lastRevertAttemptAt: "2026-07-22T00:35:00.000Z",
      lastRevertError: "prior attempt did not confirm",
    };
    saveWatchdogState(dataDir, wstate);

    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: priorRaw,
      readTable: () => {
        throw Object.assign(new Error("EIO: transient disk error"), { code: "EIO" });
      },
    });

    const report = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: () => [], nowIso: () => "2026-07-22T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    const item = report.items.find((i) => i.record.id === record.id)!;
    expect(item.action).toBe("would-revert");
    expect(report.warnings.some((w) => w.includes(record.id))).toBe(true);

    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.status).toBe("reverting"); // never terminal
    // The marker survives EXACTLY as it was — a transient read blip must never wipe it.
    expect(after.pendingMergeHash).toBe("sha256:some-prior-attempted-merge");
    expect(after.pendingMergeAxes).toEqual(["classify"]);
    expect(after.revertAttempts).toBeGreaterThan(1); // the attempt IS failure-marked (retriable)
  });
});

// ── Follow-up — a fresh 'skipped-lock-busy' breach is visible in unresolvedReverts too ──

describe("Follow-up — a fresh 'skipped-lock-busy' breach appears in unresolvedReverts (not just the adopt-suppression signal)", () => {
  it("a lock-busy breach this tick is included in report.unresolvedReverts, even though the record itself never left 'pending'", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-22T00:00:00.000Z",
      candidateHash: "h-busy",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 5, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: null });

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } }) });
    const noopDoc = makeDoc({ classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const review: AutonomyReviewInputs = {
      candidate: noopDoc,
      deterministicCandidate: noopDoc,
      servableModelIds: ["bad-model"],
      requiredTaskTypes: ["classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    };

    const externalHolder = acquireMutationLock(dataDir); // held throughout — watch's own revert-lock-acquire will be refused
    try {
      const report = await runAutonomyTick(
        baseDeps({ dataDir, review, adoptDeps, queryGuardMetrics: breachingGuardMetrics(record.adoptedAt) })
      );

      const entry = report.unresolvedReverts.find((r) => r.recordId === record.id);
      expect(entry).toBeDefined();
      expect(entry?.lastRevertError).toBeTruthy();
      // #57 item 3: the widened round-10 scope, asserted DIRECTLY against the CLI's exit-code
      // contract — a fresh skipped-lock-busy breach alone (record still "pending") must produce
      // exit 3, not just an unresolvedReverts entry something else has to interpret.
      expect(autonomyTickExitCode(report)).toBe(3);
      // The record itself never left "pending" — proving this entry comes from the FRESH
      // watch.items scan (skipped-lock-busy), not the durable "reverting"-status scan.
      expect(loadWatchdogState(dataDir).records.find((r) => r.id === record.id)?.status).toBe("pending");
    } finally {
      externalHolder.release();
    }
  });
});
