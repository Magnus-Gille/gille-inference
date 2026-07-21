/**
 * Regression tests for ROUND 9 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the CLOSURE round: only 3 HIGH findings remained (12→8→5→3→6→3), all
 * residues of round 8's own partial-restore path, plus four cheap follow-ups.
 *
 *   1. A failed partial restore (write landed, reload/canary did not confirm) must NOT be
 *      reclassified as "superseded" on the next run — the attempted merged state is persisted and
 *      RETRIED (reload+canary of THAT exact state) until confirmed.
 *   2. The live-table read inside `performRevertAndFinalize` must propagate non-ENOENT errors
 *      (EACCES etc.) to the outer per-record handler, never silently fold them into `null` (which
 *      reads as "superseded").
 *   3. An unresolved revert must be visible on EVERY tick it remains so — the tick report, the
 *      AUTONOMY_NOTIFY_CMD payload, and a distinct CLI exit code.
 *   4. Follow-ups: lazy candidateSnapshotPath backfill; the ACTUALLY-breached axis subset persisted
 *      and used by recovery; structural validation before any partial write; a fresh
 *      "skipped-lock-busy" breach counts as unresolved too.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAutonomyTick,
  saveTierState,
  AUTONOMY_APPROVER_PREFIX,
  watchRunHasUnresolvedRevert,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
} from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  saveWatchdogState,
  loadQuarantineState,
  recordAdoptionForWatch,
  runAdoptionWatch,
  validatePartialRestoreRaw,
  type WatchdogRunnerDeps,
  type WatchRunReportItem,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock } from "../src/homeserver/mutation-lock.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import { tableContentHash } from "../src/homeserver/evidence-identity.js";
import { autonomyTickExitCode } from "../scripts/autonomy-tick-cli.js";

const NOW = "2026-07-22T00:00:00.000Z";

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
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r9-"));
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

// ── Finding 1 — the attempted-merge state is retried, never reclassified ─────────

describe("Finding 1 — a failed partial restore's attempted-merge state is retried, never reclassified as superseded", () => {
  it("Sol's exact reproduction: run1 write-ok/reload-failed stays reverting with a merge marker; run2 retries reload+canary of the SAME state and finalizes breach-with-partial-restore (reload count advances, never 'superseded')", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    const aCandidateRaw = tableJson({
      classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    // A later, unrelated adoption changed ONLY "extract" — the live table still carries A's own bad
    // "classify" value verbatim, which is exactly what makes the WHOLE-TABLE hash read "superseded".
    const liveAfterB = tableJson({
      classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      extract: { model: "newer-extract-model", verdict: "delegate-local", attempts: 30, passRate: 0.95 },
    });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: tableContentHash(aCandidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      candidateRaw: aCandidateRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    let reloadShouldFail = true;
    let reloadCallCount = 0;
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({
      initialTable: liveAfterB,
      reload: () => {
        reloadCallCount++;
        return reloadShouldFail ? { ok: false, error: "simulated reload failure" } : { ok: true };
      },
    });

    // Run 1: the partial restore WRITE succeeds (classify reset to snapshot) but reload fails.
    const report1 = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: breachingGuardMetrics(record.adoptedAt), nowIso: () => "2026-07-21T01:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );
    const item1 = report1.items[0]!;
    expect(item1.evaluation.verdict).toBe("breach");
    expect(item1.revert?.status).toBe("restored-reload-failed");

    const afterRun1 = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(afterRun1.status).toBe("reverting");
    expect(afterRun1.pendingMergeHash).toBeTruthy();
    expect(afterRun1.pendingMergeAxes).toEqual(["classify"]);

    const tableAfterRun1 = JSON.parse(fs.get(tablePath)!) as RoutingTableDoc;
    expect(tableAfterRun1.routing["classify"]?.model).toBe("mellum"); // the write DID land
    expect(tableAfterRun1.routing["extract"]?.model).toBe("newer-extract-model"); // untouched
    const reloadCallsAfterRun1 = reloadCallCount;

    // Run 2: reload now succeeds. THE BUG (pre-fix): whole-table classification sees the live table
    // matches neither candidateHash nor snapshotHash (only "classify" was ever reverted) and wrongly
    // resolves "superseded" with ZERO further reload attempt — Sol's own reproduction: "run2
    // superseded, reload count stayed 1".
    reloadShouldFail = false;
    const report2 = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: () => [], nowIso: () => "2026-07-21T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );
    const item2 = report2.items.find((i) => i.record.id === record.id)!;
    expect(item2.action).toBe("reverted-partial");
    expect(item2.revert?.status).toBe("restored");
    expect(reloadCallCount).toBeGreaterThan(reloadCallsAfterRun1); // reload WAS retried, never abandoned

    const afterRun2 = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(afterRun2.status).toBe("breach"); // finalized — NEVER "superseded"
    expect(afterRun2.pendingMergeHash).toBeUndefined(); // cleared on finalize

    const tableAfterRun2 = JSON.parse(fs.get(tablePath)!) as RoutingTableDoc;
    expect(tableAfterRun2.routing["classify"]?.model).toBe("mellum");
    expect(tableAfterRun2.routing["extract"]?.model).toBe("newer-extract-model"); // still intact
  });
});

// ── Finding 2 — a non-ENOENT read error must never resolve "superseded" ──────────

describe("Finding 2 — the live-table read propagates non-ENOENT errors instead of silently resolving 'superseded'", () => {
  it("an EACCES reading the live table fails the record retriable, never terminal 'superseded'", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: "h-candidate",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: priorRaw,
      readTable: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });

    const report = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: breachingGuardMetrics(record.adoptedAt), nowIso: () => "2026-07-21T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    const item = report.items[0]!;
    expect(item.action).toBe("would-revert");
    expect(item.revert?.status).toBe("unknown");
    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.status).toBe("reverting"); // retriable — NEVER "superseded"
    expect(after.revertAttempts).toBe(1);
    expect(after.lastRevertError).toMatch(/EACCES/);
  });
});

// ── Finding 3 — an unresolved revert is visible on EVERY tick ────────────────────

describe("Finding 3 — an unresolved revert is surfaced on EVERY tick (report + notify payload) with a distinct CLI exit code", () => {
  it("runAutonomyTick's report includes unresolvedReverts with attempt count/last error, notify fires with no other trigger, and the CLI exit-code helper returns a distinct nonzero code", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
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
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = {
      ...wstate.records[idx]!,
      status: "reverting",
      revertingToken: staleClaimToken(dataDir), // stale — recovery will re-attempt this tick
      revertingAt: "2026-07-20T00:30:00.000Z",
      revertAttempts: 3,
      lastRevertAttemptAt: "2026-07-20T01:00:00.000Z",
      lastRevertError: "simulated prior failure",
    };
    saveWatchdogState(dataDir, wstate);

    saveTierState(dataDir, { schemaVersion: 1, tier: 1, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: NOW });

    // Reload STILL fails this tick — recovery attempts but does not confirm, so the record stays
    // "reverting" (an honest "still stuck after this tick's own retry", not a stale leftover value).
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw, reload: () => ({ ok: false, error: "still broken" }) });
    const noopDoc = makeDoc({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
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

    let notifiedPayload: string | undefined;
    const deps = baseDeps({ dataDir, review, adoptDeps });
    deps.notify = (json: string) => {
      notifiedPayload = json;
    };

    const report = await runAutonomyTick(deps);

    expect(report.unresolvedReverts).toHaveLength(1);
    expect(report.unresolvedReverts[0]?.recordId).toBe(record.id);
    expect(report.unresolvedReverts[0]?.revertAttempts).toBeGreaterThan(0);
    expect(report.unresolvedReverts[0]?.lastRevertError).toBeTruthy();

    // notify fires even though nothing ELSE happened this tick (no fresh adopt/tier-change; the
    // demotion-ack side effect of a still-unresolved record's own "breach" evaluation verdict may
    // also fire, but the KEY property under test is that unresolvedReverts alone is sufficient).
    expect(notifiedPayload).toBeTruthy();
    const parsedPayload = JSON.parse(notifiedPayload!) as { unresolvedReverts: unknown[] };
    expect(parsedPayload.unresolvedReverts).toHaveLength(1);

    expect(autonomyTickExitCode(report)).toBe(3);
    expect(autonomyTickExitCode({ unresolvedReverts: [] })).toBe(0);
  });
});

// ── Follow-up (a) — lazy candidateSnapshotPath backfill ───────────────────────────

describe("Follow-up (a) — a legacy record's missing candidateSnapshotPath is backfilled lazily, while it is still safe", () => {
  it("backfills candidateSnapshotPath when the live table still matches candidateHash at first access under the lease", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const candidateRaw = tableJson({ classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    // A LEGACY record — created WITHOUT candidateRaw (pre-round-8 shape).
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: tableContentHash(candidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    expect(loadWatchdogState(dataDir).records[0]?.candidateSnapshotPath).toBeUndefined();

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: candidateRaw }); // live still matches candidateHash

    await runAdoptionWatch(
      { dataDir, queryGuardMetrics: breachingGuardMetrics(record.adoptedAt), nowIso: () => "2026-07-21T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.candidateSnapshotPath).toBeTruthy();
    expect(readFileSync(after.candidateSnapshotPath!, "utf8")).toBe(candidateRaw);
  });
});

// ── Follow-up (b) — the actually-breached axis subset, never broadened ───────────

describe("Follow-up (b) — the ACTUALLY-breached axis subset is persisted and used by recovery, never broadened to every changedTaskType", () => {
  it("a mixed-axis record where only ONE of two changed axes breaches persists just that axis, and recovery never quarantines/restores the other", async () => {
    const dataDir = tmp();
    const candidateRaw = tableJson({
      classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    const priorRaw = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    // A record whose OWN adoption touched BOTH axes (e.g. a manual multi-axis adopt).
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: tableContentHash(candidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify", "extract"],
      priorRaw,
      candidateRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // Reload always fails — the record never finalizes, so it goes through RECOVERY on the 2nd run.
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: candidateRaw, reload: () => ({ ok: false, error: "stuck" }) });
    const mixedGuardMetrics = (taskTypes: string[], _sinceIso: string, untilIso: string) =>
      taskTypes.map((t) => ({
        taskType: t,
        sampleSize: 20,
        errorRate: t === "classify" ? (untilIso === record.adoptedAt ? 0.05 : 0.9) : 0.05,
        escalationRate: 0.1,
        verifierFailRate: 0.05,
        retryRate: 0.1,
        latencyP50Ms: 1000,
      }));

    await runAdoptionWatch(
      { dataDir, queryGuardMetrics: mixedGuardMetrics, nowIso: () => "2026-07-21T01:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );
    const afterRun1 = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(afterRun1.status).toBe("reverting");
    expect(afterRun1.breachedTaskTypes).toEqual(["classify"]); // NOT ["classify", "extract"]

    // 2nd run — RECOVERY (the claim from run 1 is now stale).
    await runAdoptionWatch(
      { dataDir, queryGuardMetrics: () => [], nowIso: () => "2026-07-21T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    expect(loadQuarantineState(dataDir).byTaskType["extract"]).toBeUndefined(); // never touched, either run
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();
  });
});

// ── Follow-up (c) — structural validation before any partial write ──────────────

describe("Follow-up (c) — validatePartialRestoreRaw catches a merge that touched more than the intended axes", () => {
  const live = tableJson({
    classify: { model: "bad", verdict: "delegate-local", attempts: 1, passRate: 0.5 },
    extract: { model: "x", verdict: "delegate-local", attempts: 1, passRate: 0.9 },
  });

  it("throws when an axis NOT in the intended set differs between live and merged", () => {
    const badMerge = tableJson({
      classify: { model: "good", verdict: "delegate-local", attempts: 1, passRate: 0.9 },
      extract: { model: "SOMETHING-ELSE", verdict: "delegate-local", attempts: 1, passRate: 0.9 }, // unrelated axis changed too
    });
    expect(() => validatePartialRestoreRaw(live, badMerge, ["classify"])).toThrow(/unrelated axis 'extract'/);
  });

  it("does not throw for a correctly-scoped merge (only the intended axis differs)", () => {
    const correctMerge = tableJson({
      classify: { model: "good", verdict: "delegate-local", attempts: 1, passRate: 0.9 },
      extract: { model: "x", verdict: "delegate-local", attempts: 1, passRate: 0.9 }, // unchanged
    });
    expect(() => validatePartialRestoreRaw(live, correctMerge, ["classify"])).not.toThrow();
  });

  it("throws when the merged bytes do not parse as a routing table at all", () => {
    expect(() => validatePartialRestoreRaw(live, "{ not json", ["classify"])).toThrow();
    expect(() => validatePartialRestoreRaw(live, JSON.stringify({ notRouting: true }), ["classify"])).toThrow(/missing\/invalid 'routing'/);
  });
});

// ── Follow-up (d) — a fresh 'skipped-lock-busy' breach counts as unresolved ──────

describe("Follow-up (d) — a fresh 'skipped-lock-busy' breach counts as unresolved for same-cycle adoption suppression", () => {
  it("watchRunHasUnresolvedRevert returns true for a watch.items entry whose revert.status is 'skipped-lock-busy', with no durably-reverting record needed", () => {
    const lockBusyItem = {
      record: { id: "x" },
      evaluation: { verdict: "breach" },
      action: "would-revert",
      revert: { status: "skipped-lock-busy" },
      quarantined: [],
    } as unknown as WatchRunReportItem;

    expect(watchRunHasUnresolvedRevert({ items: [lockBusyItem] }, [])).toBe(true);
  });

  it("returns false when nothing is unresolved (no incomplete revert status, no durably-reverting record)", () => {
    const healthyItem = {
      record: { id: "y" },
      evaluation: { verdict: "healthy" },
      action: "none",
      revert: undefined,
      quarantined: [],
    } as unknown as WatchRunReportItem;
    expect(watchRunHasUnresolvedRevert({ items: [healthyItem] }, [])).toBe(false);
  });

  it("a fresh lock-busy breach genuinely arises from runAdoptionWatch under real lease contention, and is picked up by watchRunHasUnresolvedRevert", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: "h-busy",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: tableJson({ classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } }) });

    const externalHolder = acquireMutationLock(dataDir); // held throughout — watch's own revert-lock-acquire will be refused
    try {
      const report = await runAdoptionWatch(
        { dataDir, queryGuardMetrics: breachingGuardMetrics(record.adoptedAt), nowIso: () => "2026-07-21T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
        WATCHDOG_POLICY
      );
      const item = report.items.find((i) => i.record.id === record.id)!;
      expect(item.revert?.status).toBe("skipped-lock-busy");
      expect(watchRunHasUnresolvedRevert(report, loadWatchdogState(dataDir).records)).toBe(true);
    } finally {
      externalHolder.release();
    }
  });
});
