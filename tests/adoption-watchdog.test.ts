/**
 * adoption-watchdog.ts test suite (issue #47) — the post-adoption regression watchdog: pure
 * WATCH WINDOW evaluation, the pure quarantine-admissibility gate, durable state persistence
 * (including a simulated restart), and the thin runner's breach/kill-switch/revert-failure paths.
 *
 * The runner tests reuse routing-lifecycle.ts's REAL `manualRollback`/`runCanary` primitives (never
 * mocked) against an in-memory `AdoptDeps` fs, exactly mirroring routing-lifecycle.test.ts's own
 * `fakeDeps` pattern — this is "auto-revert via the EXISTING #7 rollback machinery", not a
 * reimplementation.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateWatchWindow,
  evaluateQuarantineGate,
  emptyQuarantineState,
  recordAdoptionForWatch,
  loadWatchdogState,
  loadQuarantineState,
  watchdogPaths,
  runAdoptionWatch,
  DEFAULT_WATCHDOG_POLICY,
  type WatchdogPolicyConfig,
  type GuardMetricSnapshot,
  type QuarantineState,
  type WatchdogRunnerDeps,
} from "../src/homeserver/adoption-watchdog.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import { tableContentHash } from "../src/homeserver/evidence-identity.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const ADOPTED_AT = "2026-07-20T00:00:00.000Z";

const TEST_POLICY: WatchdogPolicyConfig = {
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

// ── evaluateWatchWindow ────────────────────────────────────────────────────────────

describe("evaluateWatchWindow — pure WATCH WINDOW verdict", () => {
  it("breaches the instant a guard metric regresses beyond its bound — even before the window naturally closes", () => {
    const evaluation = evaluateWatchWindow({
      adoptedAt: ADOPTED_AT,
      nowIso: "2026-07-20T00:10:00.000Z", // only 10 minutes — window (1h) is NOT yet complete
      changedTaskTypes: ["classify"],
      baseline: [snapshot({ taskType: "classify", errorRate: 0.05 })],
      current: [snapshot({ taskType: "classify", errorRate: 0.3 })], // +0.25 abs, 5x relative
      policy: TEST_POLICY,
    });
    expect(evaluation.verdict).toBe("breach");
    expect(evaluation.windowComplete).toBe(false);
    const ct = evaluation.perTaskType[0];
    expect(ct?.status).toBe("breach");
    if (ct?.status !== "breach") throw new Error("unreachable");
    expect(ct.breaches).toEqual([{ metric: "errorRate", baseline: 0.05, current: 0.3, delta: 0.25 }]);
  });

  it("does NOT breach on a relative swing that never crosses the absolute floor (tiny-n noise guard)", () => {
    // baseline 0.001 -> current 0.02: huge relative multiple, but only +0.019 absolute — below the
    // 0.05 floor. Must not breach.
    const evaluation = evaluateWatchWindow({
      adoptedAt: ADOPTED_AT,
      nowIso: "2026-07-20T00:10:00.000Z",
      changedTaskTypes: ["classify"],
      baseline: [snapshot({ taskType: "classify", errorRate: 0.001 })],
      current: [snapshot({ taskType: "classify", errorRate: 0.02 })],
      policy: TEST_POLICY,
    });
    expect(evaluation.perTaskType[0]?.status).not.toBe("breach");
  });

  it("insufficient post-adoption sample mid-window ⇒ pending (no verdict yet, never a breach, never a pass)", () => {
    const evaluation = evaluateWatchWindow({
      adoptedAt: ADOPTED_AT,
      nowIso: "2026-07-20T00:10:00.000Z", // window not complete
      changedTaskTypes: ["classify"],
      baseline: [snapshot({ taskType: "classify" })],
      current: [snapshot({ taskType: "classify", sampleSize: 2, errorRate: 0.9 })], // below minSample(5)
      policy: TEST_POLICY,
    });
    expect(evaluation.verdict).toBe("pending");
  });

  it("insufficient post-adoption sample AT window end ⇒ inconclusive (surfaces for review, never a breach/pass)", () => {
    const evaluation = evaluateWatchWindow({
      adoptedAt: ADOPTED_AT,
      nowIso: "2026-07-20T02:00:00.000Z", // 2h > windowHours(1) — window IS complete
      changedTaskTypes: ["classify"],
      baseline: [snapshot({ taskType: "classify" })],
      current: [snapshot({ taskType: "classify", sampleSize: 2, errorRate: 0.9 })],
      policy: TEST_POLICY,
    });
    expect(evaluation.verdict).toBe("inconclusive");
    expect(evaluation.windowComplete).toBe(true);
  });

  it("a healthy window (window complete, sufficient sample, no regression) ⇒ healthy", () => {
    const evaluation = evaluateWatchWindow({
      adoptedAt: ADOPTED_AT,
      nowIso: "2026-07-20T02:00:00.000Z",
      changedTaskTypes: ["classify"],
      baseline: [snapshot({ taskType: "classify" })],
      current: [snapshot({ taskType: "classify" })], // identical to baseline — no regression
      policy: TEST_POLICY,
    });
    expect(evaluation.verdict).toBe("healthy");
  });

  it("a task type with no pre-adoption baseline row never breaches and never blocks an otherwise-healthy verdict", () => {
    const evaluation = evaluateWatchWindow({
      adoptedAt: ADOPTED_AT,
      nowIso: "2026-07-20T02:00:00.000Z",
      changedTaskTypes: ["classify", "brand-new-type"],
      baseline: [snapshot({ taskType: "classify" })], // no baseline row for brand-new-type
      current: [snapshot({ taskType: "classify" }), snapshot({ taskType: "brand-new-type", errorRate: 0.9 })],
      policy: TEST_POLICY,
    });
    const newType = evaluation.perTaskType.find((t) => t.taskType === "brand-new-type");
    expect(newType?.status).toBe("no-baseline");
    expect(evaluation.verdict).toBe("healthy");
  });
});

// ── evaluateQuarantineGate ───────────────────────────────────────────────────────

describe("evaluateQuarantineGate — pure quarantine admissibility", () => {
  function quarantineWith(overrides: Partial<QuarantineState["byTaskType"][string]> = {}): QuarantineState {
    return {
      schemaVersion: 1,
      byTaskType: {
        classify: {
          taskType: "classify",
          quarantinedAt: "2026-07-20T00:00:00.000Z",
          reason: "test breach",
          cooldownUntil: "2026-07-21T00:00:00.000Z",
          requiredMarginDelta: 0.1,
          baselinePassRateAtQuarantine: 0.8,
          clearedAt: null,
          ...overrides,
        },
      },
    };
  }

  it("an axis with no quarantine record is never blocked", () => {
    const result = evaluateQuarantineGate({
      changedTaskTypes: ["classify"],
      quarantine: emptyQuarantineState(),
      nowIso: "2026-07-20T00:00:00.000Z",
      candidatePassRateByTaskType: {},
    });
    expect(result.blocked).toBe(false);
  });

  it("blocks while the cooldown has not yet elapsed, regardless of margin", () => {
    const result = evaluateQuarantineGate({
      changedTaskTypes: ["classify"],
      quarantine: quarantineWith(),
      nowIso: "2026-07-20T12:00:00.000Z", // before cooldownUntil
      candidatePassRateByTaskType: { classify: 0.99 }, // ample margin — still blocked
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedAxes[0]?.reason).toMatch(/cooldown not yet elapsed/);
  });

  it("blocks after cooldown elapses if the candidate's margin does not meet the stronger δ′", () => {
    const result = evaluateQuarantineGate({
      changedTaskTypes: ["classify"],
      quarantine: quarantineWith(),
      nowIso: "2026-07-22T00:00:00.000Z", // after cooldownUntil
      candidatePassRateByTaskType: { classify: 0.85 }, // margin 0.05 < required 0.1
    });
    expect(result.blocked).toBe(true);
    expect(result.blockedAxes[0]?.reason).toMatch(/stronger margin/);
  });

  it("clears once BOTH cooldown has elapsed AND the stronger margin δ′ is satisfied", () => {
    const result = evaluateQuarantineGate({
      changedTaskTypes: ["classify"],
      quarantine: quarantineWith(),
      nowIso: "2026-07-22T00:00:00.000Z",
      candidatePassRateByTaskType: { classify: 0.95 }, // margin 0.15 >= required 0.1
    });
    expect(result.blocked).toBe(false);
  });

  it("fails closed when the candidate's passRate is missing/unreadable", () => {
    const result = evaluateQuarantineGate({
      changedTaskTypes: ["classify"],
      quarantine: quarantineWith(),
      nowIso: "2026-07-22T00:00:00.000Z",
      candidatePassRateByTaskType: {}, // no entry at all
    });
    expect(result.blocked).toBe(true);
  });

  it("an explicitly cleared record never blocks", () => {
    const result = evaluateQuarantineGate({
      changedTaskTypes: ["classify"],
      quarantine: quarantineWith({ clearedAt: "2026-07-21T01:00:00.000Z" }),
      nowIso: "2026-07-20T12:00:00.000Z", // even before the recorded cooldownUntil
      candidatePassRateByTaskType: {},
      });
    expect(result.blocked).toBe(false);
  });
});

// ── Durable state — persistence + a simulated restart ─────────────────────────────

describe("durable watchdog state — survives a simulated restart", () => {
  it("recordAdoptionForWatch persists a snapshot + a pending record that a FRESH load reconstructs identically", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-state-"));
    const priorRaw = JSON.stringify({ routing: { classify: { model: "mellum", passRate: 0.9 } }, escalateToFrontier: [] });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: ADOPTED_AT,
      candidateHash: "sha256:candidate1",
      decisionRef: "grimnir#88",
      approvedBy: "magnus",
      changedTaskTypes: ["classify"],
      priorRaw,
    });

    expect(record.snapshotPath).not.toBeNull();
    expect(existsSync(record.snapshotPath!)).toBe(true);
    expect(readFileSync(record.snapshotPath!, "utf8")).toBe(priorRaw);

    // Simulate a process restart: this load call shares no in-memory reference with the write
    // above — it must reconstruct the record purely from what is on disk.
    const reloaded = loadWatchdogState(dataDir);
    expect(reloaded.records).toHaveLength(1);
    expect(reloaded.records[0]).toEqual(record);
  });

  it("a first-ever adoption (no prior table) records a null snapshotPath, not a crash", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-state-"));
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: ADOPTED_AT,
      candidateHash: "sha256:candidate1",
      decisionRef: "grimnir#88",
      approvedBy: "magnus",
      changedTaskTypes: ["classify"],
      priorRaw: null,
    });
    expect(record.snapshotPath).toBeNull();
    expect(loadWatchdogState(dataDir).records[0]?.snapshotPath).toBeNull();
  });

  it("an empty/absent state file loads as the empty state, never throws", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-state-"));
    expect(loadWatchdogState(dataDir)).toEqual({ schemaVersion: 1, records: [] });
    expect(loadQuarantineState(dataDir)).toEqual({ schemaVersion: 1, byTaskType: {} });
  });
});

// ── runAdoptionWatch — the thin runner ─────────────────────────────────────────────

function fakeAdoptDeps(p: {
  initialTable: string;
  writeTable?: (path: string, data: string) => void;
  reload?: () => ReloadOutcome;
  deleteTable?: (path: string) => void;
}): { deps: AdoptDeps; fs: Map<string, string>; tablePath: string } {
  const fs = new Map<string, string>([["/virtual/m5-routing.json", p.initialTable]]);
  const tablePath = "/virtual/m5-routing.json";
  const deps: AdoptDeps = {
    tablePath,
    readTable: (path) => {
      if (!fs.has(path)) throw new Error(`ENOENT: ${path}`);
      return fs.get(path)!;
    },
    writeTable: p.writeTable ?? ((path, data) => fs.set(path, data)),
    reload: p.reload ?? (() => ({ ok: true })),
    servableModelIdsAfterReload: () => ["mellum"],
    nowIso: () => "2026-07-20T02:00:00.000Z",
    currentPolicyEpochHash: "epoch-1",
    // Round 8 follow-up (b): a first-ever-adoption breach now genuinely deletes the bad table
    // (never just "skips" the revert) — default fake supports it, matching every other test file's
    // `fakeAdoptDeps` convention.
    deleteTable: p.deleteTable ?? ((path) => fs.delete(path)),
  };
  return { deps, fs, tablePath };
}

function makeQueryGuardMetrics(p: {
  adoptedAt: string;
  baseline: Record<string, Partial<GuardMetricSnapshot>>;
  current: Record<string, Partial<GuardMetricSnapshot>>;
}) {
  return (taskTypes: string[], _sinceIso: string, untilIso: string): GuardMetricSnapshot[] => {
    const isBaselineQuery = untilIso === p.adoptedAt;
    const source = isBaselineQuery ? p.baseline : p.current;
    return taskTypes.map((t) => snapshot({ taskType: t, ...(source[t] ?? {}) }));
  };
}

const GOOD_TABLE = JSON.stringify({
  routing: { classify: { model: "mellum", passRate: 0.9, tokPerSec: null, verdict: "delegate-local", attempts: 20 } },
  escalateToFrontier: [],
});
const BAD_CANDIDATE_TABLE = JSON.stringify({
  routing: { classify: { model: "gpt-oss-20b", passRate: 0.5, tokPerSec: null, verdict: "delegate-local", attempts: 5 } },
  escalateToFrontier: [],
});

function seedPendingRecord(dataDir: string) {
  return recordAdoptionForWatch({
    dataDir,
    adoptedAt: ADOPTED_AT,
    // Round 7 finding 1: `candidateHash` is now load-bearing — `classifyLiveTable` compares it
    // against the LIVE table's actual content hash to distinguish "still the candidate that
    // regressed" from "superseded by a newer adoption". Every breach-path test in this file seeds
    // `fakeAdoptDeps({ initialTable: BAD_CANDIDATE_TABLE })` as the live table, so this must be the
    // REAL hash of that exact content (a placeholder string here would misclassify every one of
    // those runs as "superseded" and silently skip the revert this suite exists to exercise).
    candidateHash: tableContentHash(BAD_CANDIDATE_TABLE),
    decisionRef: "grimnir#88",
    approvedBy: "magnus",
    changedTaskTypes: ["classify"],
    priorRaw: GOOD_TABLE,
  });
}

describe("runAdoptionWatch — breach detection triggers auto-revert + quarantine", () => {
  it("a regressed error rate breaches, invokes the #7 rollback machinery, and writes a quarantine record", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    seedPendingRecord(dataDir);
    const { deps, fs, tablePath } = fakeAdoptDeps({ initialTable: BAD_CANDIDATE_TABLE });

    const runnerDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: makeQueryGuardMetrics({
        adoptedAt: ADOPTED_AT,
        baseline: { classify: { errorRate: 0.05 } },
        current: { classify: { errorRate: 0.3 } }, // breaches errorRate
      }),
      nowIso: () => "2026-07-20T00:10:00.000Z",
      killSwitchOn: () => false,
      adoptDeps: deps,
    };

    const report = await runAdoptionWatch(runnerDeps, TEST_POLICY);

    expect(report.items).toHaveLength(1);
    const item = report.items[0]!;
    expect(item.evaluation.verdict).toBe("breach");
    expect(item.action).toBe("reverted");
    expect(item.revert?.status).toBe("restored");
    // The live table now holds the EXACT prior (good) bytes — the #7 rollback machinery ran for real.
    expect(fs.get(tablePath)).toBe(GOOD_TABLE);
    expect(item.quarantined).toEqual(["classify"]);

    const quarantine = loadQuarantineState(dataDir);
    expect(quarantine.byTaskType["classify"]).toBeDefined();
    expect(quarantine.byTaskType["classify"]?.requiredMarginDelta).toBe(TEST_POLICY.requiredMarginDelta);
    expect(quarantine.byTaskType["classify"]?.baselinePassRateAtQuarantine).toBe(0.9);

    const state = loadWatchdogState(dataDir);
    expect(state.records[0]?.status).toBe("breach");

    const events = readFileSync(watchdogPaths(dataDir).eventsPath, "utf8").trim().split("\n");
    expect(events).toHaveLength(1);
    const event = JSON.parse(events[0]!);
    expect(event.verdict).toBe("breach");
    expect(event.action).toBe("reverted");
  });

  it("insufficient sample ⇒ no verdict, no action, nothing mutated", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    seedPendingRecord(dataDir);
    const { deps, fs, tablePath } = fakeAdoptDeps({ initialTable: BAD_CANDIDATE_TABLE });
    const before = fs.get(tablePath);

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({
          adoptedAt: ADOPTED_AT,
          baseline: { classify: {} },
          current: { classify: { sampleSize: 2, errorRate: 0.9 } }, // below minSample
        }),
        nowIso: () => "2026-07-20T00:10:00.000Z", // window not complete either
        killSwitchOn: () => false,
        adoptDeps: deps,
      },
      TEST_POLICY
    );

    expect(report.items[0]?.evaluation.verdict).toBe("pending");
    expect(report.items[0]?.action).toBe("none");
    expect(fs.get(tablePath)).toBe(before); // untouched
    expect(loadWatchdogState(dataDir).records[0]?.status).toBe("pending");
    expect(loadQuarantineState(dataDir).byTaskType).toEqual({});
  });

  it("a healthy window is recorded healthy and takes no action", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    seedPendingRecord(dataDir);
    const { deps, fs, tablePath } = fakeAdoptDeps({ initialTable: GOOD_TABLE });
    const before = fs.get(tablePath);

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({ adoptedAt: ADOPTED_AT, baseline: {}, current: {} }), // identical
        nowIso: () => "2026-07-20T02:00:00.000Z", // window complete
        killSwitchOn: () => false,
        adoptDeps: deps,
      },
      TEST_POLICY
    );

    expect(report.items[0]?.evaluation.verdict).toBe("healthy");
    expect(report.items[0]?.action).toBe("none");
    expect(fs.get(tablePath)).toBe(before);
    expect(loadWatchdogState(dataDir).records[0]?.status).toBe("healthy");

    // A healthy record is resolved — a subsequent run must not re-evaluate it.
    const secondReport = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({ adoptedAt: ADOPTED_AT, baseline: {}, current: {} }),
        nowIso: () => "2026-07-21T00:00:00.000Z",
        killSwitchOn: () => false,
        adoptDeps: deps,
      },
      TEST_POLICY
    );
    expect(secondReport.items).toHaveLength(0);
  });

  it("AUTONOMY_KILL_SWITCH semantics: evaluates and records a breach, but performs NO revert and NO quarantine write", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    seedPendingRecord(dataDir);
    const { deps, fs, tablePath } = fakeAdoptDeps({ initialTable: BAD_CANDIDATE_TABLE });
    const before = fs.get(tablePath);

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({
          adoptedAt: ADOPTED_AT,
          baseline: { classify: { errorRate: 0.05 } },
          current: { classify: { errorRate: 0.3 } },
        }),
        nowIso: () => "2026-07-20T00:10:00.000Z",
        killSwitchOn: () => true,
        adoptDeps: deps,
      },
      TEST_POLICY
    );

    expect(report.killSwitchActive).toBe(true);
    const item = report.items[0]!;
    expect(item.evaluation.verdict).toBe("breach"); // still detected
    expect(item.action).toBe("would-revert"); // but not acted on
    expect(item.revert).toBeUndefined();
    expect(fs.get(tablePath)).toBe(before); // no mutation of the live table
    expect(loadQuarantineState(dataDir).byTaskType).toEqual({}); // no quarantine write

    // The record stays `pending` (not resolved) so a LATER run — once the switch clears — still acts.
    const state = loadWatchdogState(dataDir);
    expect(state.records[0]?.status).toBe("pending");
    expect(state.records[0]?.lastEvaluatedAt).toBe("2026-07-20T00:10:00.000Z");

    // The event log still recorded the detection, honestly labelled.
    const events = readFileSync(watchdogPaths(dataDir).eventsPath, "utf8").trim().split("\n");
    const event = JSON.parse(events[events.length - 1]!);
    expect(event.verdict).toBe("breach");
    expect(event.killSwitchActive).toBe(true);
    expect(event.action).toBe("would-revert");
  });

  it("dry-run reports what would happen without mutating ANY durable state", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    seedPendingRecord(dataDir);
    // Round 5 finding 3: state now lives in SQLite, not a JSON file — capture the STRUCTURED
    // snapshot (not raw file bytes) so the assertion below proves dry-run leaves it untouched,
    // rather than mis-testing a file that is no longer written at all.
    const stateBefore = loadWatchdogState(dataDir);
    const quarantineBefore = loadQuarantineState(dataDir);
    const { deps, fs, tablePath } = fakeAdoptDeps({ initialTable: BAD_CANDIDATE_TABLE });
    const before = fs.get(tablePath);

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({
          adoptedAt: ADOPTED_AT,
          baseline: { classify: { errorRate: 0.05 } },
          current: { classify: { errorRate: 0.3 } },
        }),
        nowIso: () => "2026-07-20T00:10:00.000Z",
        killSwitchOn: () => false,
        adoptDeps: deps,
      },
      TEST_POLICY,
      { dryRun: true }
    );

    expect(report.dryRun).toBe(true);
    expect(report.items[0]?.evaluation.verdict).toBe("breach");
    expect(report.items[0]?.action).toBe("would-revert");
    expect(fs.get(tablePath)).toBe(before);
    // The pre-existing watchdog/quarantine state is unchanged (still "pending"); events — which
    // only a REAL run would create — were never written at all.
    expect(loadWatchdogState(dataDir)).toEqual(stateBefore);
    expect(loadQuarantineState(dataDir)).toEqual(quarantineBefore);
    expect(existsSync(watchdogPaths(dataDir).eventsPath)).toBe(false);
  });

  it("a revert whose restore WRITE fails is recorded honestly as UNKNOWN (mirrors performRollback), and the axis is still quarantined", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    seedPendingRecord(dataDir);
    const { deps, fs, tablePath } = fakeAdoptDeps({
      initialTable: BAD_CANDIDATE_TABLE,
      writeTable: () => {
        throw new Error("ENOSPC: no space left on device");
      },
    });

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({
          adoptedAt: ADOPTED_AT,
          baseline: { classify: { errorRate: 0.05 } },
          current: { classify: { errorRate: 0.3 } },
        }),
        nowIso: () => "2026-07-20T00:10:00.000Z",
        killSwitchOn: () => false,
        adoptDeps: deps,
      },
      TEST_POLICY
    );

    const item = report.items[0]!;
    expect(item.evaluation.verdict).toBe("breach");
    expect(item.revert?.status).toBe("unknown");
    expect(item.revert?.rollback?.restoreWriteOk).toBe(false);
    // The table on disk never actually changed (the write always throws) — still the bad candidate.
    expect(fs.get(tablePath)).toBe(BAD_CANDIDATE_TABLE);
    // Quarantine still applies — the breach itself is the trigger, independent of revert quality.
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();
  });

  it("a first-ever adoption (no snapshot) that breaches genuinely DELETES the bad table instead of just calling itself reverted (round 8 follow-up b)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "watchdog-run-"));
    recordAdoptionForWatch({
      dataDir,
      adoptedAt: ADOPTED_AT,
      candidateHash: "sha256:candidate1",
      decisionRef: "grimnir#88",
      approvedBy: "magnus",
      changedTaskTypes: ["classify"],
      priorRaw: null, // nothing to snapshot
    });
    const { deps, fs, tablePath } = fakeAdoptDeps({ initialTable: BAD_CANDIDATE_TABLE });

    const report = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: makeQueryGuardMetrics({
          adoptedAt: ADOPTED_AT,
          baseline: { classify: { errorRate: 0.05 } },
          current: { classify: { errorRate: 0.3 } },
        }),
        nowIso: () => "2026-07-20T00:10:00.000Z",
        killSwitchOn: () => false,
        adoptDeps: deps,
      },
      TEST_POLICY
    );

    // Round 8 follow-up (b): the OLD "skipped-no-snapshot" behavior never actually deleted the bad
    // table — it stayed live forever while the record called itself "reverted". Confirmed
    // delete+reload now reports "restored", and the table is genuinely gone.
    expect(report.items[0]?.action).toBe("reverted");
    expect(report.items[0]?.revert?.status).toBe("restored");
    expect(fs.has(tablePath)).toBe(false);
    expect(loadWatchdogState(dataDir).records[0]?.status).toBe("breach");
    // Quarantine still applies even though nothing could be RESTORED TO (deleted, not rolled back).
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();
    expect(loadQuarantineState(dataDir).byTaskType["classify"]?.baselinePassRateAtQuarantine).toBeNull();
  });
});

describe("DEFAULT_WATCHDOG_POLICY", () => {
  it("matches the design doc's proposed defaults (grimnir docs/autonomous-improvement-design.md §6)", () => {
    expect(DEFAULT_WATCHDOG_POLICY.windowHours).toBe(72);
    expect(DEFAULT_WATCHDOG_POLICY.windowTaskCap).toBe(50);
    expect(DEFAULT_WATCHDOG_POLICY.requiredMarginDelta).toBeGreaterThan(0.05); // δ′ > δ=5pp
  });
});
