/**
 * Regression tests for issue #57 — the 3 LOW follow-ups from the FINAL Sol (xhigh) pass on
 * gille-inference#49's autonomy controller (verdict was SHIP; these were below the Tier-0 bar).
 *
 *   1. A pending-merge marker DISPROVEN by a successful live read (hash no longer matches) is
 *      cleared eagerly at the disproof point — a later error (e.g. reading the candidate-snapshot
 *      file) reaching the generic catch can no longer re-persist the stale marker for an extra
 *      cycle via round 10's preservation.
 *   2. `attemptPartialRestore` fails CLOSED when `markPendingMergeAttempt` refuses (stale claim
 *      token / record moved on): the partial write is NOT attempted on the strength of the
 *      mutation-lock lease alone.
 *   3. (Covered in the round-10 file) the fresh skipped-lock-busy breach asserts
 *      `autonomyTickExitCode(report) === 3` directly.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AUTONOMY_APPROVER_PREFIX } from "../src/homeserver/autonomy-controller.js";
import {
  loadWatchdogState,
  saveWatchdogState,
  recordAdoptionForWatch,
  runAdoptionWatch,
} from "../src/homeserver/adoption-watchdog.js";
import { acquireMutationLock } from "../src/homeserver/mutation-lock.js";
import type { AdoptDeps, ReloadOutcome } from "../src/homeserver/routing-lifecycle.js";
import type { RoutingTableDoc } from "../src/homeserver/routing-table-generator.js";
import { tableContentHash } from "../src/homeserver/evidence-identity.js";

const NOW = "2026-07-24T00:00:00.000Z";

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
  readTable?: (path: string) => string;
}): { deps: AdoptDeps; fs: Map<string, string>; tablePath: string } {
  const tablePath = "/virtual/m5-routing.json";
  const fs = new Map<string, string>();
  if (p.initialTable !== null) fs.set(tablePath, p.initialTable);
  const deps: AdoptDeps = {
    tablePath,
    readTable: p.readTable ?? ((path) => { if (!fs.has(path)) throw new Error(`ENOENT: ${path}`); return fs.get(path)!; }),
    writeTable: (path, data) => fs.set(path, data),
    reload: (): ReloadOutcome => ({ ok: true }),
    servableModelIdsAfterReload: () => ["mellum", "qwen3-coder-next-80b", "good-model", "bad-model"],
    nowIso: () => NOW,
    currentPolicyEpochHash: "epoch-1",
    deleteTable: (path) => fs.delete(path),
  };
  return { deps, fs, tablePath };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autonomy-solfixes-r11-"));
}

function staleClaimToken(dataDir: string): number {
  const holder = acquireMutationLock(dataDir);
  const token = holder.token;
  holder.release();
  return token;
}

// ── Item 1 — a DISPROVEN marker is cleared eagerly, even when a later read errors ─────

describe("#57 item 1 — a disproven pending-merge marker is cleared at the disproof point, not preserved through a later error", () => {
  it("live-hash mismatch + a candidate-snapshot read error afterwards: the stale marker is gone, the attempt is failure-marked retriable", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({ classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 } });
    const candidateRaw = tableJson({ classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 } });
    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-24T00:00:00.000Z",
      candidateHash: tableContentHash(candidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    // A PRIOR incomplete partial-restore attempt left a marker; since then the table changed to
    // content matching NEITHER the marker, the candidate, nor the snapshot (→ "superseded"
    // classification, whose per-axis refinement reads the candidate-snapshot file)...
    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = {
      ...wstate.records[idx]!,
      status: "reverting",
      revertingToken: staleClaimToken(dataDir),
      revertingAt: "2026-07-24T00:30:00.000Z",
      pendingMergeHash: "sha256:some-prior-attempted-merge-now-disproven",
      pendingMergeAxes: ["classify"],
      // ...and the candidate-snapshot file this record points at is GONE — the read in the
      // "superseded" branch throws, reaching the generic catch AFTER the marker was disproven.
      candidateSnapshotPath: join(dataDir, "definitely-missing-candidate-snapshot.json"),
      revertAttempts: 1,
      lastRevertAttemptAt: "2026-07-24T00:35:00.000Z",
      lastRevertError: "prior attempt did not confirm",
    };
    saveWatchdogState(dataDir, wstate);

    const liveNeitherRaw = tableJson({ classify: { model: "good-model", verdict: "delegate-local", attempts: 60, passRate: 0.95 } });
    const { deps: adoptDeps } = fakeAdoptDeps({ initialTable: liveNeitherRaw });

    const report = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: () => [], nowIso: () => "2026-07-24T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    const item = report.items.find((i) => i.record.id === record.id)!;
    expect(item.action).toBe("would-revert"); // failure-marked, never terminal on a read error

    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.status).toBe("reverting"); // retriable
    expect(after.revertAttempts).toBeGreaterThan(1); // the attempt IS failure-marked
    // The disproven marker must NOT survive the error path: the successful live read already
    // proved the table no longer matches it, and the eager clear + nulled carry keep the round-10
    // preservation from re-persisting it.
    expect(after.pendingMergeHash).toBeUndefined();
    expect(after.pendingMergeAxes).toBeUndefined();
  });
});

// ── Item 2 — marker-persist refusal fails closed: no write on the lease fence alone ─────

describe("#57 item 2 — attemptPartialRestore fails closed when the pending-merge marker cannot be persisted", () => {
  it("a claim token invalidated between claim and marker-persist refuses the partial write entirely", async () => {
    const dataDir = tmp();
    const priorRaw = tableJson({
      classify: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
      summarize: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    const candidateRaw = tableJson({
      classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      summarize: { model: "mellum", verdict: "delegate-local", attempts: 50, passRate: 0.9 },
    });
    // Live table: this record's own breaching axis (classify) still carries the candidate's value,
    // but ANOTHER axis moved on → whole-table "superseded" classification → per-axis refinement →
    // restoreAxes=["classify"] → attemptPartialRestore → markPendingMergeAttempt.
    const liveRaw = tableJson({
      classify: { model: "bad-model", verdict: "delegate-local", attempts: 40, passRate: 0.5 },
      summarize: { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 70, passRate: 0.97 },
    });

    const record = recordAdoptionForWatch({
      dataDir,
      adoptedAt: "2026-07-24T00:00:00.000Z",
      candidateHash: tableContentHash(candidateRaw),
      decisionRef: "r",
      approvedBy: `${AUTONOMY_APPROVER_PREFIX}1`,
      changedTaskTypes: ["classify"],
      priorRaw,
      candidateRaw,
      provenance: { kind: "autonomy", tier: 1 },
    });

    const wstate = loadWatchdogState(dataDir);
    const idx = wstate.records.findIndex((r) => r.id === record.id);
    wstate.records[idx] = {
      ...wstate.records[idx]!,
      status: "reverting",
      revertingToken: staleClaimToken(dataDir),
      revertingAt: "2026-07-24T00:30:00.000Z",
    };
    saveWatchdogState(dataDir, wstate);

    // Simulate the race: the moment the live table is read (post-claim, pre-marker), another
    // claimant takes over the record — the DB claim token this run holds becomes stale while the
    // mutation-lock lease it also holds stays valid. Item 2 is exactly about NOT letting the write
    // proceed on that second fence alone.
    const { deps: adoptDeps, fs, tablePath } = fakeAdoptDeps({
      initialTable: liveRaw,
      readTable: (path) => {
        const st = loadWatchdogState(dataDir);
        const i = st.records.findIndex((r) => r.id === record.id);
        if (i >= 0 && st.records[i]!.status === "reverting") {
          st.records[i] = { ...st.records[i]!, revertingToken: 987654321 };
          saveWatchdogState(dataDir, st);
        }
        const v = fs.get(path);
        if (v === undefined) throw new Error(`ENOENT: ${path}`);
        return v;
      },
    });

    const report = await runAdoptionWatch(
      { dataDir, queryGuardMetrics: () => [], nowIso: () => "2026-07-24T02:00:00.000Z", killSwitchOn: () => false, adoptDeps },
      WATCHDOG_POLICY
    );

    const item = report.items.find((i) => i.record.id === record.id)!;
    expect(item.action).toBe("would-revert"); // refused before write, retriable
    // Fail closed means the live table was NOT touched — the partial restore write never ran.
    expect(fs.get(tablePath)).toBe(liveRaw);

    const after = loadWatchdogState(dataDir).records.find((r) => r.id === record.id)!;
    expect(after.status).toBe("reverting"); // never terminal on a refused marker persist
  });
});
