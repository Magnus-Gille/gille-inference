/**
 * Regression tests for ROUND 7 of the Sol (xhigh) cross-model review on gille-inference#49's
 * autonomy controller — the re-review after round 6's fixes confirmed round 5's closure and
 * fencing were real. Round 7 closes the remaining 3 HIGH findings, all in the watchdog
 * revert/recovery subsystem, plus 2 cheap follow-ups:
 *
 *   1. Revert/recovery must never clobber a SUPERSEDED table: before any restore, classify the
 *      live table against THIS record's candidate/snapshot; a match to neither means a newer
 *      legitimate adoption is live, and the record resolves `"superseded"` with ZERO mutation.
 *   2. An incomplete revert (failed/unconfirmed write, reload, or canary) must not finalize to
 *      terminal `"breach"` — it stays `"reverting"` (retriable, failure-marked), and recovery must
 *      reload+confirm IDEMPOTENTLY even when disk already matches the snapshot.
 *   3. The manual rollback CLI's exit code/message must reflect `restoreWriteOk && reloadOk`, never
 *      `reloadOk` alone.
 *   4. Follow-ups: the losing reload fetch is actually aborted (AbortController, not bare
 *      `Promise.race`); the failure-marking journal save in `reconcileAdoptionIntent` is
 *      fenced/revalidated against a stale lease before it writes.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadWatchdogState,
  saveWatchdogState,
  loadQuarantineState,
  recordAdoptionForWatch,
  runAdoptionWatch,
  type WatchdogRunnerDeps,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock } from "../src/homeserver/mutation-lock.js";
import type { AdoptDeps, ReloadOutcome, RollbackRecord } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import { tableContentHash } from "../src/homeserver/evidence-identity.js";
import { describeRollbackOutcome } from "../scripts/routing-lifecycle-cli.js";

const AUTONOMY_APPROVER_PREFIX = "autonomy:";

type RouteSpec = { model: string | null; verdict: string; attempts: number; passRate?: number; tokPerSec?: number | null };

function makeDoc(routing: Record<string, RouteSpec>): RoutingTableDoc {
  return {
    _comment: "test fixture",
    _generator: "test",
    generatedAt: "2026-07-21T00:00:00.000Z",
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

const WATCHDOG_POLICY = {
  windowHours: 1,
  windowTaskCap: 1000,
  metrics: {
    errorRate: { minSample: 5, absoluteFloor: 0.05, relativeBound: 0.5 },
    escalationRate: { minSample: 5, absoluteFloor: 0.1, relativeBound: 0.5 },
    verifierFailRate: { minSample: 5, absoluteFloor: 0.05, relativeBound: 0.5 },
    retryRate: { minSample: 5, absoluteFloor: 0.1, relativeBound: 0.5 },
    latencyP50Ms: { minSample: 500, absoluteFloor: 500, relativeBound: 0.5 },
  },
  cooldownHours: 24,
  requiredMarginDelta: 0.1,
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r7-"));
}

function fakeAdoptDeps(p: {
  initialTable: string | null;
  reload?: () => ReloadOutcome;
  writeTable?: (path: string, data: string) => void;
  readTable?: (path: string) => string;
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
    nowIso: () => "2026-07-21T00:00:00.000Z",
    currentPolicyEpochHash: "epoch-1",
    deleteTable: (path) => fs.delete(path),
  };
  return { deps, fs, tablePath };
}

// A guard-metrics fixture that ALWAYS reports a breach for every task type it's asked about
// (baseline healthy, current regressed) — the exact shape `evaluateWatchWindow` treats as
// "verdict: breach" once the window has enough sample and has closed.
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

// ── Finding 1 — a live table matching NEITHER candidate NOR snapshot is "superseded", never rolled back ──

describe("Finding 1 — revert/recovery classifies the live table before acting; a superseded table is NEVER rolled back", () => {
  it("recovery: adopt A, breach detected + claimed (crash before the external write), adopt B manually, recovery runs ⇒ B's content survives intact and the record resolves 'superseded'", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const aRaw = tableJson({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const bRaw = tableJson({ classify: { model: "gemma4", verdict: "delegate-local", attempts: 30, passRate: 0.95 } }); // a DIFFERENT, newer, legitimate adoption

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: tableContentHash(aRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // Simulate "breach detected + CAS-claimed for reverting, then crashed before the external
    // rollback write ran" — a PAST lease token, never renewed, long gone (exactly like round 6's
    // own "stuck reverting" recovery fixture).
    const staleClaimHolder = acquireMutationLock(dataDir);
    const staleToken = staleClaimHolder.token;
    staleClaimHolder.release();
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "reverting", revertingToken: staleToken, revertingAt: "2026-07-20T00:30:00.000Z" };
    saveWatchdogState(dataDir, wstate);

    // THEN a legitimate manual adopt of B happened — the live table now holds B, not A.
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: bRaw });

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: () => [],
      nowIso: () => "2026-07-20T02:00:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };
    const report = await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);

    const item = report.items.find((i) => i.record.id === record.id);
    expect(item?.action).toBe("superseded");
    expect(item?.revert?.status).toBe("superseded");

    // B's content is EXACTLY intact — no rollback was attempted at all.
    expect(fs.get(tablePath)).toBe(bRaw);

    const finalState = loadWatchdogState(dataDir).records.find((r) => r.id === record.id);
    expect(finalState?.status).toBe("superseded");
    expect(finalState?.revertingToken).toBeUndefined(); // claim was cleared on this terminal resolution

    // Quarantine still applies — A's breach evidence remains valid even though the table moved on.
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();

    // A warning was surfaced on the report (never silently dropped).
    expect(report.warnings.some((w) => w.includes(record.id) && /superseded/i.test(w))).toBe(true);
  });

  it("the ordinary (non-recovery) breach path also classifies before acting: a live table that already differs from the record's candidate at breach-detection time resolves 'superseded', not 'reverted'", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ extract: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const aRaw = tableJson({ extract: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const bRaw = tableJson({ extract: { model: "gemma4", verdict: "delegate-local", attempts: 30, passRate: 0.95 } });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: tableContentHash(aRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["extract"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });
    // record is still "pending" — no claim has ever happened. The live table has ALREADY moved on
    // to B by the time this watch tick evaluates it (e.g. a manual adopt raced the watch window).
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({ initialTable: bRaw });

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: breachingGuardMetrics(record.adoptedAt),
      nowIso: () => "2026-07-20T02:00:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };
    const report = await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);

    const item = report.items[0]!;
    expect(item.evaluation.verdict).toBe("breach");
    expect(item.action).toBe("superseded");
    expect(fs.get(tablePath)).toBe(bRaw); // untouched
    expect(loadWatchdogState(dataDir).records[0]?.status).toBe("superseded");
    expect(loadQuarantineState(dataDir).byTaskType["extract"]).toBeDefined();
  });
});

// ── Finding 2 — incomplete revert never finalizes; recovery reloads+confirms idempotently ────────

describe("Finding 2 — incomplete revert stays 'reverting' (retriable); recovery reloads/confirms even when disk already matches the snapshot", () => {
  it("crash between the restore WRITE and reload/confirm: recovery still performs a real reload+canary (never trusts disk content alone) and then finalizes", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const aRaw = tableJson({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: tableContentHash(aRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const staleClaimHolder = acquireMutationLock(dataDir);
    const staleToken = staleClaimHolder.token;
    staleClaimHolder.release();
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = { ...wstate.records[idx]!, status: "reverting", revertingToken: staleToken, revertingAt: "2026-07-20T00:30:00.000Z" };
    saveWatchdogState(dataDir, wstate);

    // The restore WRITE already landed (disk === the snapshot, byte for byte — as if a prior
    // attempt wrote successfully and then crashed before reload/confirm ran at all).
    let reloadCalls = 0;
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({
      initialTable: priorRaw,
      reload: () => {
        reloadCalls++;
        return { ok: true };
      },
    });

    const watchDeps: WatchdogRunnerDeps = {
      dataDir,
      queryGuardMetrics: () => [],
      nowIso: () => "2026-07-20T02:00:00.000Z",
      killSwitchOn: () => false,
      adoptDeps,
    };
    const report = await runAdoptionWatch(watchDeps, WATCHDOG_POLICY);

    // Reload+confirm ran for REAL — "the gateway caches the table; disk state alone proves nothing".
    expect(reloadCalls).toBeGreaterThan(0);
    const item = report.items.find((i) => i.record.id === record.id);
    expect(item?.action).toBe("reverted");
    expect(item?.revert?.status).toBe("restored"); // fully confirmed, not just "disk looked right"
    expect(fs.get(tablePath)).toBe(priorRaw);
    expect(loadWatchdogState(dataDir).records.find((r) => r.id === record.id)?.status).toBe("breach");
  });

  it("an unconfirmed revert (restore write + reload succeed, but the canary does NOT confirm) stays 'reverting' — never finalizes to 'breach' — and quarantine still applies", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const aRaw = tableJson({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-20T00:00:00.000Z",
      candidateHash: tableContentHash(aRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // First tick: the live table still holds A (the regressed candidate) — an ordinary first
    // revert attempt. `servableModelIdsAfterReload` deliberately OMITS "mellum" (the snapshot's own
    // target for "classify") so the post-reload canary cannot confirm the revert took effect.
    const { deps: firstTickDeps, fs, tablePath } = fakeAdoptDeps({
      initialTable: aRaw,
      servableModelIdsAfterReload: () => ["qwen3-coder-next-80b"], // "mellum" NOT servable
    });

    const firstReport = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: breachingGuardMetrics(record.adoptedAt),
        nowIso: () => "2026-07-20T01:00:00.000Z",
        killSwitchOn: () => false,
        adoptDeps: firstTickDeps,
      },
      WATCHDOG_POLICY
    );

    const firstItem = firstReport.items[0]!;
    expect(firstItem.evaluation.verdict).toBe("breach");
    expect(firstItem.revert?.status).toBe("restored-unconfirmed");
    // The write+reload DID actually happen (this is NOT a failed write) — disk now holds the
    // restored bytes — but the record must NOT be finalized as "breach" off that alone.
    expect(fs.get(tablePath)).toBe(priorRaw);

    const afterFirst = loadWatchdogState(dataDir).records.find((r) => r.id === record.id);
    expect(afterFirst?.status).toBe("reverting"); // NEVER "breach" — unconfirmed
    expect(afterFirst?.revertAttempts).toBe(1);
    expect(afterFirst?.lastRevertError).toBeTruthy();
    // Quarantine still applies — the breach itself is the trigger, independent of revert quality.
    expect(loadQuarantineState(dataDir).byTaskType["classify"]).toBeDefined();

    // Second tick: the SAME stuck "reverting" row is now recovered — this time the canary CAN
    // confirm ("mellum" is servable) — and it finalizes for real, retrying via the same mechanism
    // rather than being silently abandoned.
    const { deps: secondTickDeps } = fakeAdoptDeps({
      initialTable: priorRaw, // already matches the snapshot (attempt 1's write landed)
      servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b"],
    });
    const secondReport = await runAdoptionWatch(
      {
        dataDir,
        queryGuardMetrics: () => [],
        nowIso: () => "2026-07-20T02:00:00.000Z",
        killSwitchOn: () => false,
        adoptDeps: secondTickDeps,
      },
      WATCHDOG_POLICY
    );

    const secondItem = secondReport.items.find((i) => i.record.id === record.id);
    expect(secondItem?.revert?.status).toBe("restored");
    const afterSecond = loadWatchdogState(dataDir).records.find((r) => r.id === record.id);
    expect(afterSecond?.status).toBe("breach"); // NOW finalized — write AND reload AND confirm all succeeded
  });
});

// ── Finding 3 — manual rollback CLI truthfulness ──────────────────────────────────

describe("Finding 3 — describeRollbackOutcome (the CLI's rollback exit-code/message source of truth) requires restoreWriteOk AND reloadOk", () => {
  function record(overrides: Partial<RollbackRecord>): RollbackRecord {
    return {
      rolledBackAt: "2026-07-21T00:00:00.000Z",
      reason: "test",
      restoredHash: "sha256:x",
      restoreWriteOk: true,
      reloadOk: true,
      ...overrides,
    };
  }

  it("success (restoreWriteOk && reloadOk) reports ok:true / 'ROLLED BACK'", () => {
    const outcome = describeRollbackOutcome(record({}));
    expect(outcome.ok).toBe(true);
    expect(outcome.label).toBe("ROLLED BACK");
  });

  it("a stale-lease-refused restore reports ok:false / 'REFUSED', even though it never touched reloadOk's default", () => {
    const outcome = describeRollbackOutcome(record({ restoreWriteOk: false, staleLeaseRefused: true, reason: "stale holder must never roll back" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.label).toBe("REFUSED");
    expect(outcome.message).toMatch(/UNRESOLVED/);
  });

  it("a failed restore write that nonetheless reports reloadOk: true is NEVER reported as success (the pre-round-7 bug)", () => {
    const outcome = describeRollbackOutcome(record({ restoreWriteOk: false, reloadOk: true, reason: "ENOSPC" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.label).toBe("INCOMPLETE");
  });

  it("a successful restore write whose reload failed is also never reported as success", () => {
    const outcome = describeRollbackOutcome(record({ restoreWriteOk: true, reloadOk: false, reason: "gateway unreachable" }));
    expect(outcome.ok).toBe(false);
    expect(outcome.label).toBe("INCOMPLETE");
  });
});

// ── Follow-up (a) — the losing reload fetch is actually aborted ──────────────────

describe("Follow-up (a) — reloadAndRenew wires a real AbortController to its timeout, not just Promise.race", () => {
  it("the signal passed to deps.reload() is aborted once the timeout wins the race", async () => {
    const { reloadAndRenew } = await import("../src/homeserver/routing-lifecycle.js");
    let observedSignal: AbortSignal | undefined;
    const deps: AdoptDeps = {
      tablePath: "/virtual/t.json",
      readTable: () => "{}",
      writeTable: () => {},
      reload: (signal) =>
        new Promise<ReloadOutcome>((resolve) => {
          observedSignal = signal;
          // Never resolves on its own within the test's short timeout — only the timeout branch
          // settles the outer race. If the signal is never aborted, this "leaks" (in production, a
          // real fetch would keep running); the test's job is to prove the signal DOES fire.
          setTimeout(() => resolve({ ok: true }), 10_000).unref?.();
        }),
      servableModelIdsAfterReload: () => [],
      nowIso: () => "2026-07-21T00:00:00.000Z",
      currentPolicyEpochHash: "epoch-1",
    };

    const result = await reloadAndRenew(deps, 20);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    expect(observedSignal?.aborted).toBe(true);
  });
});

// ── Follow-up (b) — the failure-marking journal save is fenced ───────────────────

describe("Follow-up (b) — reconcileAdoptionIntent's restore-failure journal save is fenced against a stale lease", () => {
  it("a reconcile call whose lease goes stale mid-rollback-attempt defers instead of overwriting a newer terminal resolution with a stale failure mark", async () => {
    const { reconcileAdoptionIntent, saveAdoptionIntent, loadAdoptionIntent } = await import("../src/homeserver/autonomy-controller.js");
    const { acquireMutationLock: acquire, mutationLockDbPath } = await import("../src/homeserver/mutation-lock.js");
    const Database = (await import("better-sqlite3")).default;

    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const candidateDoc = makeDoc({ classify: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const candidateHash = tableContentHash(JSON.stringify(candidateDoc));

    saveAdoptionIntent(dataDir, {
      schemaVersion: 1,
      id: "intent-stale-mid-rollback",
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

    const { deps: adoptDeps } = fakeAdoptDeps({
      initialTable: JSON.stringify(candidateDoc, null, 2) + "\n",
      // An ordinary restore-write failure (no lease trickery here — `writeTable` runs INSIDE
      // `fencedWrite`'s own open transaction on the lease db, so mutating that same db from within
      // this callback would self-deadlock against SQLite's single-writer lock).
      writeTable: () => {
        throw new Error("simulated disk-full on restore write");
      },
      // `reload` runs AFTER the (failed) write attempt, once `fencedWrite`'s transaction has already
      // closed — a safe place to simulate "this call's lease went stale WHILE the rollback attempt
      // was in flight": some OTHER holder reclaims the lease here, before `reconcileAdoptionIntent`
      // reaches its own post-rollback fencing check.
      reload: () => {
        const db = new Database(mutationLockDbPath(dataDir));
        db.prepare(`UPDATE mutation_lease SET acquired_at_ms = 0 WHERE id = 1`).run();
        db.close();
        const reclaimer = acquire(dataDir);
        reclaimer.release(); // leaves a FRESH (different) token as "current" — this call's own token is now stale
        return { ok: true };
      },
    });

    const result = await reconcileAdoptionIntent(dataDir, "2026-07-20T12:05:00.000Z", adoptDeps);

    // Must defer, not silently succeed at writing a "restore-failed-will-retry" failure mark under
    // a lease it can no longer vouch for.
    expect(result.action).toBe("deferred-lease-went-stale");
    // The intent's failure-marking fields were NEVER written by this stale call.
    const intent = loadAdoptionIntent(dataDir);
    expect(intent?.restoreAttempts ?? 0).toBe(0);
    expect(intent?.lastRestoreError).toBeUndefined();
  });
});
