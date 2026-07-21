/**
 * Regression tests for ROUND 8 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the re-review after round 7 confirmed round 6's closure was real and no new
 * migration/fencing defects were found. Round 8 closes 6 HIGH findings (five are surgical
 * completions of round 7's own mechanisms; one — per-axis supersession — reuses the controller's
 * existing axis-isolation approach) plus three cheap follow-ups.
 *
 *   1. Whole-table supersession stranding a bad AXIS: a later, UNRELATED-axis adoption must not
 *      strand this record's own still-live bad axis served forever — refine per axis.
 *   2. An intent must never be terminalized ("aborted") off an unconfirmed internal rollback.
 *   3. Stuck-"reverting" recovery must honor the kill switch — evaluate/record only, no mutation.
 *   4. An unresolved watchdog revert must suppress the WHOLE adopt phase and mark the cycle
 *      unhealthy, exactly like reconcile's own nonterminal outcomes.
 *   5. The classifier needs a safe error state — a read error/malformed JSON must fail-mark THAT
 *      record only, never crash the whole run, never "superseded".
 *   6. "superseded" joins durable breach accounting (revert-rate + demotion-ack).
 *   7. Follow-ups: the autonomous adopt path's reload actually threads its AbortSignal; a
 *      first-ever/no-snapshot breach genuinely deletes+reloads (covered in
 *      tests/adoption-watchdog.test.ts's updated fixture); the `watch` CLI treats
 *      "restored-reload-failed" as attention-worthy too.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runAutonomyTick,
  saveTierState,
  loadTierState,
  loadAdoptionIntent,
  instrumentAdoptDepsForIntent,
  computeAutonomousRevertRate,
  type AutonomyPolicyConfig,
  type AutonomyTickDeps,
  type AutonomyReviewInputs,
  AUTONOMY_APPROVER_PREFIX,
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
import { acquireMutationLock } from "../src/homeserver/mutation-lock.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import { tableContentHash } from "../src/homeserver/evidence-identity.js";
import { revertNeedsOperatorAttention } from "../scripts/routing-lifecycle-cli.js";
import type { CalibrationGateDecision } from "../src/homeserver/calibration-gate.js";

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
    servableModelIdsAfterReload: p.servableModelIdsAfterReload ?? (() => ["mellum", "qwen3-coder-next-80b", "gemma4", "good-model", "bad-model"]),
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
    deleteTable: p.deleteTable ?? ((path) => fs.delete(path)),
  };
  return { deps, fs, tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r8-"));
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

// ── Finding 1 — whole-table supersession refined PER AXIS ─────────────────────────

describe("Finding 1 — a superseded whole table is refined per axis: a later UNRELATED-axis adoption must not strand this record's own still-live bad axis", () => {
  it("Sol's exact scenario: A adopts bad X, B later adopts Y (unrelated) ⇒ X is restored to snapshot, Y is left intact", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    const aCandidateRaw = tableJson({
      classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 }, // "X" — the bad axis
      extract: { model: "good-extract", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    // B's later, unrelated adopt: changes ONLY "extract" ("Y"), leaves "classify" ("X") untouched —
    // the live table right now still carries A's own bad "classify" value verbatim.
    const liveAfterB = tableJson({
      classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      extract: { model: "newer-extract-model", verdict: "delegate-local", attempts: 30, passRate: 0.95 }, // "Y"
    });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: tableContentHash(aCandidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"], // A's OWN record only ever touched "classify"
      priorRaw,
      candidateRaw: aCandidateRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: liveAfterB });

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: breachingGuardMetrics(record.adoptedAt),
        nowIso: () => "2026-07-21T02:00:00.000Z",
        killSwitchOn: () => false,
        adoptDeps,
      },
      WATCHDOG_POLICY
    );

    const item = report.items[0]!;
    expect(item.evaluation.verdict).toBe("breach");
    expect(item.action).toBe("reverted-partial");
    expect(item.revert?.status).toBe("restored");

    const finalTable = JSON.parse(fs.get(tablePath)!) as RoutingTableDoc;
    expect(finalTable.routing["classify"]?.model).toBe("mellum"); // X restored to snapshot
    expect(finalTable.routing["extract"]?.model).toBe("newer-extract-model"); // Y left INTACT

    expect(loadWatchdogState(dataDir).records[0]?.status).toBe("breach");
    // Quarantine still applies to the full breaching set (just "classify" here).
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();
  });

  it("every one of this record's own axes was ALSO independently re-routed since ⇒ genuinely superseded on all of them, zero mutation", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const aCandidateRaw = tableJson({ classify: { model: "bad-classify-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    // Someone else re-routed "classify" itself to a THIRD value — neither A's candidate nor the
    // original snapshot.
    const liveNow = tableJson({ classify: { model: "third-party-model", verdict: "delegate-local", attempts: 20, passRate: 0.95 } });

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

    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: liveNow });

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: breachingGuardMetrics(record.adoptedAt),
        nowIso: () => "2026-07-21T02:00:00.000Z",
        killSwitchOn: () => false,
        adoptDeps,
      },
      WATCHDOG_POLICY
    );

    const item = report.items[0]!;
    expect(item.action).toBe("superseded");
    expect(fs.get(tablePath)).toBe(liveNow); // untouched
    expect(loadWatchdogState(dataDir).records[0]?.status).toBe("superseded");
  });
});

// ── Finding 2 — an intent is never terminalized off an unconfirmed internal rollback ──────────

describe("Finding 2 — a non-adopted outcome only aborts the intent when the internal rollback CONFIRMED (restoreWriteOk && reloadOk)", () => {
  it("a reload failure (both the candidate reload AND the internal rollback's own reload fail) leaves the intent 'pending' + failure-marked, never 'aborted'", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: TEST_POLICY.tier1UnlockCycles - 1,
      consecutiveGoCycles: 0,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
      tier1EnteredAt: null,
    });

    const initialTable = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 } });
    // Reload ALWAYS fails — this fails the candidate reload (triggering adoptRoutingTable's own
    // internal rollback) AND the rollback's OWN reload step, so restoreWriteOk ends up true but
    // reloadOk false: exactly "attempted an internal rollback that did not fully confirm".
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

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    expect(report.healthyCycle).toBe(false);
    const intent = loadAdoptionIntent(dataDir);
    expect(intent).not.toBeNull();
    // NEVER "aborted" — the internal rollback did not confirm (reloadOk: false).
    expect(intent?.status).toBe("pending");
    expect(intent?.restoreAttempts).toBe(1);
    expect(intent?.lastRestoreError).toBeTruthy();
  });
});

// ── Finding 3 — stuck-'reverting' recovery honors the kill switch ─────────────────

describe("Finding 3 — a stuck 'reverting' row under AUTONOMY_KILL_SWITCH=on is evaluated + recorded only, never reclaimed/mutated", () => {
  it("no reclaim, no table write, no quarantine — the record stays 'reverting' untouched, and resumes once the switch clears", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: "h-stuck",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const staleToken = staleClaimToken(dataDir);
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "reverting", revertingToken: staleToken, revertingAt: "2026-07-21T00:30:00.000Z" };
    saveWatchdogState(dataDir, wstate);

    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: priorRaw });
    const before = fs.get(tablePath);

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: () => [],
        nowIso: () => "2026-07-21T02:00:00.000Z",
        killSwitchOn: () => true,
        adoptDeps,
      },
      WATCHDOG_POLICY
    );

    const item = report.items.find((i) => i.record.id === record.id);
    expect(item?.action).toBe("would-revert");
    expect(fs.get(tablePath)).toBe(before); // untouched
    const finalState = loadWatchdogState(dataDir).records.find((r) => r.id === record.id);
    expect(finalState?.status).toBe("reverting"); // still exactly as it was
    expect(finalState?.revertAttempts ?? 0).toBe(0); // no failure-mark write either — zero mutation
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeUndefined();
  });
});

// ── Finding 4 — an unresolved watchdog revert suppresses the whole adopt phase ────

describe("Finding 4 — an unresolved watchdog revert (durably 'reverting') suppresses the adopt phase and marks the cycle unhealthy", () => {
  it("a genuinely in-flight 'reverting' record blocks an otherwise-eligible, UNRELATED axis from adopting this same tick", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({
      extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
    });
    const stuckRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: "h-inflight",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    // A GENUINELY current claim (the lease is still held) — watch's own loop will skip it entirely
    // (never even surfaced in watch.items this tick), so the ONLY way to catch this is the durable
    // watchdog-state scan `anyUnresolvedRevert` performs directly.
    const genuinelyActiveHolder = acquireMutationLock(dataDir);
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === stuckRecord.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "reverting", revertingToken: genuinelyActiveHolder.token, revertingAt: "2026-07-21T00:30:00.000Z" };
    saveWatchdogState(dataDir, wstate);

    saveTierState(dataDir, {
      schemaVersion: 1,
      tier: 1,
      consecutiveHealthyCycles: 5,
      consecutiveGoCycles: 0,
      lastCycleAt: null,
      lastEvent: null,
      ackedBreachIds: [],
      tier1EnteredAt: null,
    });

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw });
    const candidate = makeDoc({
      extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.9 }, // a genuinely eligible, UNRELATED axis
    });
    const review = {
      candidate,
      deterministicCandidate: candidate,
      adopted: {
        routing: {
          extract: { model: "mellum", verdict: "delegate-local", attempts: 50 },
          classify: { model: "mellum", verdict: "delegate-local", attempts: 50 },
        },
      },
      adoptedRaw: {
        extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
        classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.5 },
      },
      servableModelIds: ["mellum", "qwen3-coder-next-80b"],
      requiredTaskTypes: ["extract", "classify"],
      freshnessMaxAgeMs: 24 * 60 * 60 * 1000,
      calibrationGate: null,
      policyEpochHash: "epoch-1",
      expectedPolicyEpochHash: "epoch-1",
    } as AutonomyReviewInputs;

    const report = await runAutonomyTick(
      baseDeps({
        dataDir,
        review,
        adoptDeps,
        queryGuardMetrics: (taskTypes, _since, untilIso) =>
          taskTypes.map((t) => ({ taskType: t, sampleSize: 20, errorRate: 0.05, escalationRate: 0.1, verifierFailRate: 0.05, retryRate: 0.1, latencyP50Ms: 1000 })),
      })
    );

    expect(report.adopted).toHaveLength(0); // "classify" was genuinely eligible but MUST NOT be attempted
    expect(report.cycleOutcome).toBe("unhealthy");
    expect(report.healthyCycle).toBe(false);
    genuinelyActiveHolder.release();
  });
});

// ── Finding 5 — the classifier fails safe on a read/parse error ───────────────────

describe("Finding 5 — a read error or malformed JSON fail-marks THAT record only, never crashes the run, never resolves 'superseded'", () => {
  it("a corrupt snapshot file leaves the record 'reverting' (retriable) and does not stop the SAME run from resolving a healthy other record", async () => {
    const dataDir = tmp();
    const badRaw = tableJson({ classify: { model: "regressed-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const goodPriorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });

    const brokenRecord = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      // Deliberately NOT `tableContentHash(badRaw)` — a non-matching candidateHash forces
      // `classifyLiveTable` past its "matches-candidate" shortcut and into the
      // `tableContentHash(snapshotRaw)` comparison, which is exactly where the corrupted snapshot
      // file (below) throws. (With a matching candidateHash, classification would short-circuit
      // on the FIRST comparison and never even touch the corrupted snapshot — not what this test
      // is exercising.)
      candidateHash: "sha256:does-not-match-live-content",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw: goodPriorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    // Corrupt the persisted snapshot file AFTER recording it — simulates disk corruption / a
    // truncated write, independent of anything this test controls through the AdoptDeps fakes.
    const brokenSnapshotPath = loadWatchdogState(dataDir).records.find((r) => r.id === brokenRecord.id)!.snapshotPath!;
    writeFileSync(brokenSnapshotPath, "{ this is not valid json", "utf8");

    // A SECOND, perfectly healthy record in the SAME run — proves the corrupt one doesn't starve it.
    const healthyPriorRaw = tableJson({ extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-21T00:00:00.000Z",
      candidateHash: "h-healthy",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw: healthyPriorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: badRaw });

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: (taskTypes, _since, untilIso) =>
          taskTypes.map((t) => ({
            taskType: t,
            sampleSize: 20,
            errorRate: t === "classify" ? (untilIso === brokenRecord.adoptedAt ? 0.05 : 0.9) : 0.05,
            escalationRate: 0.1,
            verifierFailRate: 0.05,
            retryRate: 0.1,
            latencyP50Ms: 1000,
          })),
        nowIso: () => "2026-07-21T02:00:00.000Z",
        killSwitchOn: () => false,
        adoptDeps,
      },
      WATCHDOG_POLICY
    );

    // Never threw — the run completed and produced items for BOTH records.
    expect(report.items).toHaveLength(2);
    const brokenItem = report.items.find((i) => i.record.id === brokenRecord.id)!;
    expect(brokenItem.action).toBe("would-revert");
    expect(brokenItem.revert?.status).toBe("unknown"); // a classification error, not evidence of anything
    const brokenAfter = loadWatchdogState(dataDir).records.find((r) => r.id === brokenRecord.id);
    expect(brokenAfter?.status).toBe("reverting"); // retriable — NEVER "superseded", never terminal
    expect(brokenAfter?.revertAttempts).toBe(1);
    expect(brokenAfter?.lastRevertError).toBeTruthy();

    // The healthy record in the SAME run resolved normally — proves the corrupt one did not starve it.
    const healthyItem = report.items.find((i) => i.record.candidateHash === "h-healthy")!;
    expect(healthyItem.evaluation.verdict).toBe("healthy");
  });
});

// ── Finding 6 — "superseded" joins durable breach accounting ──────────────────────

describe('Finding 6 — "superseded" counts as a breach-equivalent in revert-rate accounting and demotion-ack', () => {
  it("computeAutonomousRevertRate counts a 'superseded' record in BOTH the denominator and the numerator", () => {
    const base = {
      id: "x",
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: "h",
      decisionRef: "r",
      approvedBy: "x",
      changedTaskTypes: ["classify"],
      snapshotPath: null,
      lastEvaluatedAt: null,
      provenance: { kind: "autonomy" as const, tier: 1 as const },
    };
    const records: AdoptionWatchRecord[] = [
      { ...base, id: "healthy-1", status: "healthy" },
      { ...base, id: "superseded-1", status: "superseded" },
    ];
    // 1 breach-equivalent ("superseded") out of 2 resolved records.
    expect(computeAutonomousRevertRate(records)).toBeCloseTo(0.5, 10);
  });

  it("a durably-'superseded' record that was never acknowledged still triggers a demotion on the next tick", async () => {
    const dataDir = tmp();
    saveTierState(dataDir, { schemaVersion: 1, tier: 2, consecutiveHealthyCycles: 7, consecutiveGoCycles: 0, lastCycleAt: null, lastEvent: null, ackedBreachIds: [], tier1EnteredAt: NOW });

    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: "h-superseded-prior",
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "superseded" }; // resolved by a PAST tick, never acked
    saveWatchdogState(dataDir, wstate);

    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: priorRaw });
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

    const report = await runAutonomyTick(baseDeps({ dataDir, review, adoptDeps }));

    expect(report.tierAfter).toBe(1); // demoted from 2 -> 1
    expect(loadTierState(dataDir).ackedBreachIds).toContain(record.id);
  });
});

// ── Follow-up (a) — the autonomous adopt path's reload actually threads its AbortSignal ────

describe("Follow-up (a) — instrumentAdoptDepsForIntent threads the caller's AbortSignal through to base.reload", () => {
  it("the wrapped reload forwards the EXACT signal it was called with, never dropping it", async () => {
    let observedSignal: AbortSignal | undefined;
    const base: AdoptDeps = {
      tablePath: "/virtual/t.json",
      readTable: () => "{}",
      writeTable: () => {},
      reload: (signal) => {
        observedSignal = signal;
        return { ok: true };
      },
      servableModelIdsAfterReload: () => [],
      nowIso: () => NOW,
      currentPolicyEpochHash: "epoch-1",
    };
    const dataDir = tmp();
    const instrumented = instrumentAdoptDepsForIntent(base, dataDir, "intent-x");
    const controller = new AbortController();
    await instrumented.reload!(controller.signal);
    expect(observedSignal).toBe(controller.signal);
  });
});

// ── Follow-up (c) — the watch CLI treats "restored-reload-failed" as attention-worthy too ─────

describe('Follow-up (c) — revertNeedsOperatorAttention treats "restored-reload-failed" as attention-worthy', () => {
  it("returns true for restored-reload-failed (the pre-round-8 gap), unknown, restored-unconfirmed, and superseded", () => {
    expect(revertNeedsOperatorAttention("restored-reload-failed")).toBe(true);
    expect(revertNeedsOperatorAttention("unknown")).toBe(true);
    expect(revertNeedsOperatorAttention("restored-unconfirmed")).toBe(true);
    expect(revertNeedsOperatorAttention("superseded")).toBe(true);
  });

  it("returns false for a confirmed restore and for the no-mutation-needed statuses", () => {
    expect(revertNeedsOperatorAttention("restored")).toBe(false);
    expect(revertNeedsOperatorAttention("skipped-lock-busy")).toBe(false);
    expect(revertNeedsOperatorAttention("skipped-no-snapshot")).toBe(false);
    expect(revertNeedsOperatorAttention(undefined)).toBe(false);
  });
});
