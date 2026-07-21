/**
 * adoption-watchdog.ts — the post-adoption regression watchdog (issue #47, gille-inference).
 *
 * The #7 routing-lifecycle pipeline (routing-lifecycle.ts) ends at
 * GENERATE → VALIDATE → REVIEW → ADOPT → RELOAD → CANARY. For unattended/autonomous adoption
 * (grimnir docs/autonomous-improvement-design.md §4, tracked by grimnir#88 Phase 4) every mutation
 * additionally needs a WATCH WINDOW after adoption: for W hours or T affected tasks (whichever
 * completes first), compare production guard metrics on the CHANGED task types against the
 * pre-adoption baseline harvested from the ledger. A regression ⇒ auto-revert to the exact adoption
 * snapshot + QUARANTINE (that axis is refused at review/adopt until a cooldown elapses AND a fresh
 * candidate clears a STRONGER margin than the one that got it adopted — hysteresis, preventing
 * oscillation).
 *
 * PRODUCTION-ROUTING-MUTATION (same discipline as routing-lifecycle.ts):
 *   - `evaluateWatchWindow` is PURE and never touches disk/network — it takes pre/post guard-metric
 *     snapshots plus a policy and returns a verdict. Fully unit-testable with fixture data.
 *   - `evaluateQuarantineGate` is PURE — the single admissibility test the CLI's `review`/`adopt`
 *     paths consult (mirrors routing-lifecycle.ts's `gateAdmitsOrganicEvidence`: one definition,
 *     never a second hand-maintained copy).
 *   - `runAdoptionWatch` is the thin runner: reads ledger guard metrics (injected), evaluates, and
 *     ONLY on a `breach` verdict calls the EXISTING #7 rollback primitives (`manualRollback` +
 *     `runCanary`, imported — never reimplemented) to auto-revert, then writes a durable quarantine
 *     record. Durable state lives under `<dataDir>/adoption-watchdog/` — NOT a path any deploy
 *     rsyncs over (deploy-gateway.sh excludes `data/` wholesale; see deploy/README.md's
 *     "Routing-table adoption survives deploys (issue #44)") — the gi#44 discipline this ticket
 *     depends on, so watch state survives both a gateway restart and a redeploy.
 *
 * Kill switch: `AUTONOMY_KILL_SWITCH=on` means the watchdog still EVALUATES and RECORDS every
 * window (the breach is detected and logged), but performs NO auto-revert and NO quarantine write —
 * it reports what it would have done. The record is deliberately left in `pending` status (not
 * resolved to `breach`) so that once the switch is cleared, the NEXT `watch` run still acts on the
 * same, still-unresolved regression — the switch pauses MUTATION, not detection. Absent env = acting
 * ENABLED (fail closed toward the safe direction: reverting to a known-good snapshot is the safe
 * default, never the risky one — see the module header's asymmetry with routing-lifecycle.ts, where
 * fail-closed means REFUSING a mutation; here it means PERFORMING the corrective one).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";

import {
  manualRollback,
  deleteTableAndReload,
  runCanary,
  type AdoptDeps,
  type RollbackRecord,
  type CanaryOutcome,
} from "./routing-lifecycle.js";
import { routingTarget, type RoutingTable } from "./routing-table.js";
import {
  acquireMutationLock,
  MutationLockBusyError,
  MutationLockStaleError,
  mutationLockDbPath,
  ensureLeaseTables,
  isLeaseCurrent,
} from "./mutation-lock.js";
import { tableContentHash, isVerifiedEnoentError } from "./evidence-identity.js";
import type { RoutingTableDoc } from "./routing-table-generator.js";
import type { GuardMetricSnapshot } from "./ledger.js";

export type { GuardMetricSnapshot } from "./ledger.js";

// ─── Policy / config ────────────────────────────────────────────────────────────

export interface MetricBoundConfig {
  /** Minimum post-adoption sample size before this metric may be judged at all (avoids tiny-n noise). */
  minSample: number;
  /** Minimum ABSOLUTE delta (current - baseline) required before a regression counts — a floor. */
  absoluteFloor: number;
  /** Minimum RELATIVE regression (delta / baseline) required, ON TOP OF the absolute floor. */
  relativeBound: number;
}

export type MetricName = "errorRate" | "escalationRate" | "verifierFailRate" | "retryRate" | "latencyP50Ms";

export interface WatchdogPolicyConfig {
  /** W: watch-window duration in hours (also the baseline window's duration, taken immediately
   *  before adoptedAt, so baseline and post-adoption windows are the same length). */
  windowHours: number;
  /** T: the window is ALSO considered complete once this many post-adoption tasks have accumulated
   *  across the affected task types — whichever of W hours / T tasks completes first. */
  windowTaskCap: number;
  /** Per-metric regression bounds. Every metric here is "higher is worse". */
  metrics: Record<MetricName, MetricBoundConfig>;
  /** Cooldown (hours) an axis stays quarantined after a breach before it may even be CONSIDERED for
   *  re-adoption — necessary but not sufficient; see requiredMarginDelta. */
  cooldownHours: number;
  /** δ′: the stronger passRate margin (0..1) a fresh candidate must beat the pre-breach baseline by
   *  before a quarantined axis clears — strictly greater than the ordinary adoption margin δ, so a
   *  reverted change cannot oscillate back in on the same weak evidence that got it reverted. */
  requiredMarginDelta: number;
}

/** Defaults proposed in grimnir docs/autonomous-improvement-design.md §6: W=72h or 50 tasks,
 *  δ=5pp ⇒ δ′=10pp here (2×), 24h per-route cooldown. Every bound is intentionally conservative
 *  (tunable at the call site) — this module ships sane defaults, not a promise they are final. */
export const DEFAULT_WATCHDOG_POLICY: WatchdogPolicyConfig = {
  windowHours: 72,
  windowTaskCap: 50,
  metrics: {
    errorRate: { minSample: 10, absoluteFloor: 0.05, relativeBound: 0.5 },
    escalationRate: { minSample: 10, absoluteFloor: 0.1, relativeBound: 0.5 },
    verifierFailRate: { minSample: 10, absoluteFloor: 0.05, relativeBound: 0.5 },
    retryRate: { minSample: 10, absoluteFloor: 0.1, relativeBound: 0.5 },
    latencyP50Ms: { minSample: 10, absoluteFloor: 500, relativeBound: 0.5 },
  },
  cooldownHours: 24,
  requiredMarginDelta: 0.1,
};

// ─── Pure evaluation (WATCH WINDOW) ───────────────────────────────────────────────

export interface MetricBreachDetail {
  metric: MetricName;
  baseline: number;
  current: number;
  delta: number;
}

export type TaskTypeVerdict =
  | { taskType: string; status: "breach"; breaches: MetricBreachDetail[]; sampleSize: number }
  | { taskType: string; status: "healthy"; sampleSize: number }
  | { taskType: string; status: "insufficient-sample"; sampleSize: number; shortMetrics: MetricName[] }
  /** No pre-adoption baseline row exists for this task type at all (e.g. a brand-new route this
   *  adoption introduced) — there is nothing to regress AGAINST, so this axis can never breach via
   *  this mechanism. It also never blocks the overall verdict from being `healthy` once the window
   *  completes (documented limitation: a genuinely bad brand-new route is not caught here — it has
   *  no history to compare to; it is caught by ordinary evidence accumulation instead). */
  | { taskType: string; status: "no-baseline"; sampleSize: number };

export type WatchdogVerdict = "pending" | "healthy" | "breach" | "inconclusive";

export interface WatchWindowEvaluation {
  verdict: WatchdogVerdict;
  windowComplete: boolean;
  elapsedHours: number;
  totalPostAdoptionTasks: number;
  perTaskType: TaskTypeVerdict[];
  evaluatedAt: string;
}

function metricValue(row: GuardMetricSnapshot, metric: MetricName): number | null {
  return row[metric];
}

/** A metric "regresses" only when BOTH the absolute floor AND the relative bound are crossed — a
 *  floor alone (e.g. baseline 0.4%, current 0.9%: +0.5pp absolute but "only" 2.25x relative on a
 *  near-zero base) is exactly the tiny-n noise pattern this guards against; requiring both keeps a
 *  single flaky request on a low-traffic route from triggering an automatic revert. */
function regressed(baselineVal: number, currentVal: number, cfg: MetricBoundConfig): boolean {
  const delta = currentVal - baselineVal;
  if (delta < cfg.absoluteFloor) return false;
  const relative = baselineVal > 0 ? delta / baselineVal : currentVal > 0 ? Number.POSITIVE_INFINITY : 0;
  return relative >= cfg.relativeBound;
}

/**
 * PURE. The single WATCH WINDOW verdict: `breach` the instant any guard metric on any affected task
 * type regresses beyond its bound (with sufficient post-adoption sample for THAT metric); otherwise
 * `healthy` once the window completes with sufficient samples on every task type; `inconclusive` if
 * the window ends without sufficient data anywhere (surfaces for review, mutates nothing); `pending`
 * while the window is still open and nothing has breached yet (keep watching, take no action —
 * "insufficient sample" is never itself a breach and never itself a pass, mid-window OR at window
 * end).
 */
export function evaluateWatchWindow(p: {
  adoptedAt: string;
  nowIso: string;
  changedTaskTypes: string[];
  baseline: GuardMetricSnapshot[];
  current: GuardMetricSnapshot[];
  policy: WatchdogPolicyConfig;
}): WatchWindowEvaluation {
  const elapsedMs = Date.parse(p.nowIso) - Date.parse(p.adoptedAt);
  const elapsedHours = elapsedMs / (60 * 60 * 1000);
  const baselineByType = new Map(p.baseline.map((r) => [r.taskType, r]));
  const currentByType = new Map(p.current.map((r) => [r.taskType, r]));

  const totalPostAdoptionTasks = p.changedTaskTypes.reduce(
    (sum, t) => sum + (currentByType.get(t)?.sampleSize ?? 0),
    0
  );
  const windowComplete = elapsedHours >= p.policy.windowHours || totalPostAdoptionTasks >= p.policy.windowTaskCap;

  const perTaskType: TaskTypeVerdict[] = p.changedTaskTypes.map((taskType) => {
    const baseline = baselineByType.get(taskType) ?? null;
    const current = currentByType.get(taskType) ?? null;
    const sampleSize = current?.sampleSize ?? 0;

    if (baseline === null) {
      return { taskType, status: "no-baseline", sampleSize };
    }

    const breaches: MetricBreachDetail[] = [];
    const shortMetrics: MetricName[] = [];
    (Object.keys(p.policy.metrics) as MetricName[]).forEach((metric) => {
      const cfg = p.policy.metrics[metric];
      if (current === null || sampleSize < cfg.minSample) {
        shortMetrics.push(metric);
        return;
      }
      const baseVal = metricValue(baseline, metric);
      const curVal = metricValue(current, metric);
      if (baseVal === null || curVal === null) return; // e.g. latencyP50Ms with zero latency samples
      if (regressed(baseVal, curVal, cfg)) {
        breaches.push({ metric, baseline: baseVal, current: curVal, delta: curVal - baseVal });
      }
    });

    if (breaches.length > 0) return { taskType, status: "breach", breaches, sampleSize };
    if (shortMetrics.length > 0) return { taskType, status: "insufficient-sample", sampleSize, shortMetrics };
    return { taskType, status: "healthy", sampleSize };
  });

  const anyBreach = perTaskType.some((t) => t.status === "breach");
  let verdict: WatchdogVerdict;
  if (anyBreach) {
    verdict = "breach"; // acts the instant sufficient evidence exists — never waits out a known-bad window
  } else if (!windowComplete) {
    verdict = "pending";
  } else {
    const allResolved = perTaskType.every((t) => t.status === "healthy" || t.status === "no-baseline");
    verdict = allResolved ? "healthy" : "inconclusive";
  }

  return { verdict, windowComplete, elapsedHours, totalPostAdoptionTasks, perTaskType, evaluatedAt: p.nowIso };
}

// ─── Quarantine ─────────────────────────────────────────────────────────────────

export interface QuarantineRecord {
  taskType: string;
  quarantinedAt: string;
  reason: string;
  /** Quarantine cannot clear before this timestamp even with a passing margin. */
  cooldownUntil: string;
  /** δ′ > δ — see WatchdogPolicyConfig.requiredMarginDelta, snapshotted at quarantine time so a
   *  later policy change cannot retroactively weaken an already-quarantined axis's bar. */
  requiredMarginDelta: number;
  /** The passRate the REVERTED-TO (known-good) table had for this task type at quarantine time — the
   *  reference point a future candidate's margin is measured against. Null when unknown (e.g. no
   *  snapshot existed to read it from). */
  baselinePassRateAtQuarantine: number | null;
  clearedAt: string | null;
}

export interface QuarantineState {
  schemaVersion: 1;
  byTaskType: Record<string, QuarantineRecord>;
}

export function emptyQuarantineState(): QuarantineState {
  return { schemaVersion: 1, byTaskType: {} };
}

export interface QuarantineGateResult {
  blocked: boolean;
  blockedAxes: Array<{ taskType: string; reason: string }>;
}

/**
 * PURE. The single quarantine-admissibility test the CLI's `review`/`adopt` paths consult — mirrors
 * routing-lifecycle.ts's `gateAdmitsOrganicEvidence`'s role for the #6 rule: one definition, never a
 * second hand-maintained copy that could silently diverge. An axis with no (or already-cleared)
 * quarantine record is never blocked. A quarantined axis clears ONLY when BOTH the cooldown has
 * elapsed AND the candidate's passRate for that task type beats the pre-breach baseline by AT LEAST
 * the stronger margin δ′ recorded at quarantine time — a missing/unreadable candidate passRate is
 * treated as NOT clearing (fail closed; this is a refusal gate, most restrictive on missing data).
 */
export function evaluateQuarantineGate(p: {
  changedTaskTypes: string[];
  quarantine: QuarantineState;
  nowIso: string;
  candidatePassRateByTaskType: Record<string, number | null | undefined>;
}): QuarantineGateResult {
  const blockedAxes: Array<{ taskType: string; reason: string }> = [];
  for (const taskType of p.changedTaskTypes) {
    const record = p.quarantine.byTaskType[taskType];
    if (!record || record.clearedAt !== null) continue;

    const cooldownElapsed = Date.parse(p.nowIso) >= Date.parse(record.cooldownUntil);
    const candidatePassRate = p.candidatePassRateByTaskType[taskType];
    const baseline = record.baselinePassRateAtQuarantine;
    const margin = typeof candidatePassRate === "number" && baseline !== null ? candidatePassRate - baseline : null;
    const marginOk = margin !== null && margin >= record.requiredMarginDelta;

    if (!cooldownElapsed || !marginOk) {
      blockedAxes.push({
        taskType,
        reason: !cooldownElapsed
          ? `quarantined until ${record.cooldownUntil} (cooldown not yet elapsed; reason: ${record.reason})`
          : `quarantined — candidate margin ${margin !== null ? margin.toFixed(3) : "unknown"} does not meet the ` +
            `required stronger margin δ′=${record.requiredMarginDelta} over baseline passRate ` +
            `${baseline ?? "unknown"} (reason: ${record.reason})`,
      });
    }
  }
  return { blocked: blockedAxes.length > 0, blockedAxes };
}

// ─── Durable adoption-watch state (issue #44 discipline: lives under data/, deploy never touches it) ──

/**
 * Structured provenance (gille-inference#49, Sol-xhigh review finding 7): WHO/WHAT initiated an
 * adoption, set ONLY by the actual caller of `recordAdoptionForWatch` — never inferred from
 * `approvedBy` (free text a human `adopt --approved-by` invocation could type identically to the
 * autonomy controller's own convention, e.g. `autonomy-controller:tier1`, spoofing risk-budget/
 * revert-rate accounting). Any accounting that needs to know "was this autonomous" MUST read this
 * field, never parse `approvedBy`. Optional/absent on records written before this field existed —
 * treat a missing field as `"manual"` (the least-privileged classification), never upgrade it.
 */
export type AdoptionProvenance = { kind: "manual" } | { kind: "autonomy"; tier: 0 | 1 | 2 | 3 };

export interface AdoptionWatchRecord {
  id: string;
  adoptedAt: string;
  candidateHash: string;
  decisionRef: string;
  /** Free-text approver identity — DISPLAY ONLY. Never parsed for accounting; see `provenance`. */
  approvedBy: string;
  /** Task types whose route changed in this adoption — the affected axes the watchdog monitors. */
  changedTaskTypes: string[];
  /** Absolute path to the EXACT prior table bytes captured at adopt time — the #7 rollback
   *  machinery's snapshot, persisted so a much LATER (possibly post-restart) `watch` run can still
   *  restore it. Null for a first-ever adoption (no prior table existed to snapshot). */
  snapshotPath: string | null;
  /**
   * Round 6 finding 2: `"reverting"` is a NEW intermediate state, CAS-claimed (`pending ->
   * reverting`) transactionally BEFORE the external rollback action (`manualRollback`) is even
   * attempted — the watchdog used to perform the (externally-visible, side-effecting) revert FIRST
   * and only record the outcome afterward, so a crash mid-revert left the record `"pending"` with
   * no trace that a revert was ever attempted, and the NEXT watch run would blindly attempt it
   * AGAIN (a double revert / double gateway-reload call). See `revertingToken`/`revertingAt`.
   *
   * Round 7 finding 1: `"superseded"` is a SECOND new terminal state — a revert (or its recovery)
   * that finds the live table matches NEITHER this record's candidate NOR its snapshot means a
   * NEWER legitimate adoption is live; rolling back over it would clobber that newer work. This
   * record's breach evidence is resolved as `"superseded"` (never `"breach"`) with ZERO table
   * mutation — the axis is still quarantined (the OLD candidate genuinely regressed), but nothing
   * is written to the routing table.
   */
  status: "pending" | "reverting" | "healthy" | "breach" | "inconclusive" | "superseded";
  lastEvaluatedAt: string | null;
  /** Structured provenance — see `AdoptionProvenance`'s doc comment. Absent on legacy records
   *  (treat as `"manual"`). */
  provenance?: AdoptionProvenance;
  /**
   * The autonomy controller's own `AdoptionIntent.id` this record finalizes (gille-inference#49
   * round 4 finding 8). Present ONLY for autonomously-adopted records (the manual CLI adopt path
   * has no intent journal). `reconcileAdoptionIntent`'s crash-recovery dedup check matches on THIS,
   * never on `candidateHash` alone: two DIFFERENT intents (e.g. two separate ticks that each
   * legitimately adopted the identical candidate bytes for the same axis, or a candidate hash that
   * happens to collide with an unrelated axis's prior watch record) must never be conflated into
   * "this intent's watch record already exists" just because the content hash matches.
   */
  intentId?: string;
  /**
   * Round 6 finding 2: while `status === "reverting"`, the fencing token of the mutation lease that
   * claimed this record for an in-flight revert, and when it claimed it. A LATER watch run checks
   * whether `revertingToken` is STILL the current lease: if so, someone is genuinely mid-revert
   * right now (skip it, do not race); if not, the claiming process died mid-revert, and this run
   * recovers it (compares the live table against the snapshot — already-reverted means resolve
   * directly, not-yet-reverted means retry the revert under a freshly re-claimed token).
   */
  revertingToken?: number;
  revertingAt?: string;
  /**
   * Round 7 finding 2: "incomplete revert must not finalize" — a restore-write, reload, or
   * confirmation (canary) failure keeps the record `"reverting"` (retriable) rather than the prior
   * behavior of finalizing to `"breach"` unconditionally. These three fields are the watchdog's
   * counterpart of `AdoptionIntent.restoreAttempts`/`lastRestoreAttemptAt`/`lastRestoreError` — a
   * failed attempt is "failure-marked" (visible on the durable record) rather than silently retried
   * with no trace, or worse, silently certified as resolved.
   */
  revertAttempts?: number;
  lastRevertAttemptAt?: string;
  lastRevertError?: string;
  /**
   * Round 8 finding 1: absolute path to the EXACT candidate table bytes this record's own adoption
   * wrote (mirrors `snapshotPath`'s persistence pattern, one directory over) — persisted so a later
   * "superseded" classification (the whole table matches neither this record's candidate nor its
   * snapshot) can be refined PER AXIS: for each of `changedTaskTypes`, compare the LIVE table's
   * routing target against THIS candidate's own target for that axis, rather than only ever being
   * able to answer the whole-table question. Absent on legacy records (predating this field) and on
   * a first-ever adoption's crash-recovery retroactive record (no candidate bytes were captured at
   * the time) — a missing path means the whole-table "superseded" classification is the most this
   * record can ever support; per-axis refinement is a strict enhancement, not a requirement.
   */
  candidateSnapshotPath?: string | null;
  /**
   * Round 9 finding 1: while a PARTIAL (per-axis) restore's WRITE has landed but reload/canary has
   * not yet CONFIRMED it, this is `tableContentHash` of the exact merged bytes that write produced.
   * Recovery must NOT reclassify a live table that still matches this hash — whole-table
   * classification would read "matches neither candidate nor snapshot" and wrongly conclude
   * "superseded", abandoning an axis that is, in fact, THIS record's own in-flight attempted merge
   * (Sol's exact reproduction: run1 restored-reload-failed/reverting, run2 wrongly resolved
   * superseded, reload count never advanced past 1). Set by the partial-restore attempt that produced
   * these bytes; cleared once finalized (`finalizeReverting` always clears both fields) OR once the
   * live table no longer matches it (someone else changed the table since — re-enter classification
   * fresh, per the whole-table/generic-error failure-mark paths, which explicitly clear it too).
   */
  pendingMergeHash?: string;
  /** The exact axes `pendingMergeHash`'s attempted merge covers — reused verbatim to retry
   *  reload+canary confirmation of THAT exact state, never re-planned from scratch while it matches. */
  pendingMergeAxes?: string[];
  /**
   * Round 9 follow-up (b): the axes that ACTUALLY breached at the moment this record was FIRST
   * claimed for reverting — a SUBSET of `changedTaskTypes` on a "mixed axis" adoption where only some
   * of the adopted axes regressed. Persisted (once, at the first "pending -> reverting" CAS claim) so
   * recovery restores/quarantines exactly the axes that actually breached, never broadening to every
   * `changedTaskTypes` the way a legacy record's conservative fallback must (absent on records
   * predating this field, and on the manual/non-watchdog-detected paths that never go through the
   * breach-detection loop at all).
   */
  breachedTaskTypes?: string[];
}

export interface WatchdogState {
  schemaVersion: 1;
  records: AdoptionWatchRecord[];
}

export function emptyWatchdogState(): WatchdogState {
  return { schemaVersion: 1, records: [] };
}

export interface WatchdogPaths {
  root: string;
  /** Legacy JSON state path — no longer written (round 5 finding 3 moved records into SQLite), kept
   *  ONLY as the one-time migration source and for any external tooling that still expects the path
   *  to resolve. */
  statePath: string;
  /** Legacy JSON quarantine path — same status as `statePath` above. */
  quarantinePath: string;
  eventsPath: string;
  snapshotsDir: string;
  /** Round 8 finding 1: mirrors `snapshotsDir` for the POST-adoption candidate bytes — see
   *  `AdoptionWatchRecord.candidateSnapshotPath`'s doc comment. */
  candidateSnapshotsDir: string;
}

export function watchdogPaths(dataDir: string): WatchdogPaths {
  const root = join(dataDir, "adoption-watchdog");
  return {
    root,
    statePath: join(root, "state.json"),
    quarantinePath: join(root, "quarantine.json"),
    eventsPath: join(root, "events.jsonl"),
    snapshotsDir: join(root, "snapshots"),
    candidateSnapshotsDir: join(root, "candidate-snapshots"),
  };
}

// ─── SQLite-backed watch-record + quarantine storage (round 5 finding 3) ─────────
//
// Round 4's file-based storage had a lost-update class of bug: `runAdoptionWatch`'s
// load-whole-state → evaluate → save-whole-state and `recordAdoptionForWatch`'s
// load-whole-state → append → save-whole-state could interleave across two process invocations
// (a cron watch tick overlapping a manual `adopt`, say) — whichever finishes its "save the WHOLE
// array I loaded" LAST silently wins, discarding whatever the other call added or changed. This
// class of bug cannot be patched away by locking harder around a whole-file overwrite; it requires
// each COMMIT to be scoped to exactly the row(s) it actually changed, transactionally, so two
// concurrent commits to DIFFERENT rows can never clobber each other, and two commits to the SAME
// row are serialized by SQLite's own write lock (never a silent last-writer-wins).
//
// Records + quarantine entries now live in the SAME db file the mutation lease itself uses
// (`mutationLockDbPath`) — round 5's fencing (finding 1) can then verify the caller's lease token
// and commit the protected row change in ONE transaction, not a check followed by a separate write.
// `loadWatchdogState`/`saveWatchdogState`/`loadQuarantineState`/`saveQuarantineState` keep their
// EXACT exported signatures (`saveWatchdogState`/`saveQuarantineState` are now bulk upsert-alls, used
// by tests and any caller that legitimately wants to set the whole state at once); the PRODUCTION
// hot paths (`recordAdoptionForWatch`, `runAdoptionWatch`'s own per-record resolution) never call
// them — each commits only the row(s) it actually owns.

interface WatchRecordRow {
  id: string;
  adopted_at: string;
  candidate_hash: string;
  decision_ref: string;
  approved_by: string;
  changed_task_types: string;
  snapshot_path: string | null;
  status: string;
  last_evaluated_at: string | null;
  provenance: string | null;
  intent_id: string | null;
  reverting_token: number | null;
  reverting_at: string | null;
  revert_attempts: number | null;
  last_revert_attempt_at: string | null;
  last_revert_error: string | null;
  candidate_snapshot_path: string | null;
  pending_merge_hash: string | null;
  pending_merge_axes: string | null;
  breached_task_types: string | null;
}

interface QuarantineRow {
  task_type: string;
  quarantined_at: string;
  reason: string;
  cooldown_until: string;
  required_margin_delta: number;
  baseline_pass_rate_at_quarantine: number | null;
  cleared_at: string | null;
}

function rowToRecord(row: WatchRecordRow): AdoptionWatchRecord {
  return {
    id: row.id,
    adoptedAt: row.adopted_at,
    candidateHash: row.candidate_hash,
    decisionRef: row.decision_ref,
    approvedBy: row.approved_by,
    changedTaskTypes: JSON.parse(row.changed_task_types) as string[],
    snapshotPath: row.snapshot_path,
    status: row.status as AdoptionWatchRecord["status"],
    lastEvaluatedAt: row.last_evaluated_at,
    ...(row.provenance ? { provenance: JSON.parse(row.provenance) as AdoptionProvenance } : {}),
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    ...(row.reverting_token !== null ? { revertingToken: row.reverting_token } : {}),
    ...(row.reverting_at !== null ? { revertingAt: row.reverting_at } : {}),
    ...(row.revert_attempts !== null ? { revertAttempts: row.revert_attempts } : {}),
    ...(row.last_revert_attempt_at !== null ? { lastRevertAttemptAt: row.last_revert_attempt_at } : {}),
    ...(row.last_revert_error !== null ? { lastRevertError: row.last_revert_error } : {}),
    ...(row.candidate_snapshot_path !== null ? { candidateSnapshotPath: row.candidate_snapshot_path } : {}),
    ...(row.pending_merge_hash !== null ? { pendingMergeHash: row.pending_merge_hash } : {}),
    ...(row.pending_merge_axes !== null ? { pendingMergeAxes: JSON.parse(row.pending_merge_axes) as string[] } : {}),
    ...(row.breached_task_types !== null ? { breachedTaskTypes: JSON.parse(row.breached_task_types) as string[] } : {}),
  };
}

function recordToRowParams(r: AdoptionWatchRecord) {
  return {
    id: r.id,
    adopted_at: r.adoptedAt,
    candidate_hash: r.candidateHash,
    decision_ref: r.decisionRef,
    approved_by: r.approvedBy,
    changed_task_types: JSON.stringify(r.changedTaskTypes),
    snapshot_path: r.snapshotPath,
    status: r.status,
    last_evaluated_at: r.lastEvaluatedAt,
    provenance: r.provenance ? JSON.stringify(r.provenance) : null,
    intent_id: r.intentId ?? null,
    reverting_token: r.revertingToken ?? null,
    reverting_at: r.revertingAt ?? null,
    revert_attempts: r.revertAttempts ?? null,
    last_revert_attempt_at: r.lastRevertAttemptAt ?? null,
    last_revert_error: r.lastRevertError ?? null,
    candidate_snapshot_path: r.candidateSnapshotPath ?? null,
    pending_merge_hash: r.pendingMergeHash ?? null,
    pending_merge_axes: r.pendingMergeAxes ? JSON.stringify(r.pendingMergeAxes) : null,
    breached_task_types: r.breachedTaskTypes ? JSON.stringify(r.breachedTaskTypes) : null,
  };
}

function rowToQuarantineRecord(row: QuarantineRow): QuarantineRecord {
  return {
    taskType: row.task_type,
    quarantinedAt: row.quarantined_at,
    reason: row.reason,
    cooldownUntil: row.cooldown_until,
    requiredMarginDelta: row.required_margin_delta,
    baselinePassRateAtQuarantine: row.baseline_pass_rate_at_quarantine,
    clearedAt: row.cleared_at,
  };
}

function quarantineToRowParams(r: QuarantineRecord) {
  return {
    task_type: r.taskType,
    quarantined_at: r.quarantinedAt,
    reason: r.reason,
    cooldown_until: r.cooldownUntil,
    required_margin_delta: r.requiredMarginDelta,
    baseline_pass_rate_at_quarantine: r.baselinePassRateAtQuarantine,
    cleared_at: r.clearedAt,
  };
}

const UPSERT_RECORD_SQL = `
  INSERT INTO adoption_watch_records
    (id, adopted_at, candidate_hash, decision_ref, approved_by, changed_task_types, snapshot_path, status, last_evaluated_at, provenance, intent_id, reverting_token, reverting_at, revert_attempts, last_revert_attempt_at, last_revert_error, candidate_snapshot_path, pending_merge_hash, pending_merge_axes, breached_task_types)
  VALUES
    (@id, @adopted_at, @candidate_hash, @decision_ref, @approved_by, @changed_task_types, @snapshot_path, @status, @last_evaluated_at, @provenance, @intent_id, @reverting_token, @reverting_at, @revert_attempts, @last_revert_attempt_at, @last_revert_error, @candidate_snapshot_path, @pending_merge_hash, @pending_merge_axes, @breached_task_types)
  ON CONFLICT(id) DO UPDATE SET
    adopted_at = excluded.adopted_at, candidate_hash = excluded.candidate_hash, decision_ref = excluded.decision_ref,
    approved_by = excluded.approved_by, changed_task_types = excluded.changed_task_types, snapshot_path = excluded.snapshot_path,
    status = excluded.status, last_evaluated_at = excluded.last_evaluated_at, provenance = excluded.provenance, intent_id = excluded.intent_id,
    reverting_token = excluded.reverting_token, reverting_at = excluded.reverting_at,
    revert_attempts = excluded.revert_attempts, last_revert_attempt_at = excluded.last_revert_attempt_at, last_revert_error = excluded.last_revert_error,
    candidate_snapshot_path = excluded.candidate_snapshot_path,
    pending_merge_hash = excluded.pending_merge_hash, pending_merge_axes = excluded.pending_merge_axes,
    breached_task_types = excluded.breached_task_types
`;

const UPSERT_QUARANTINE_SQL = `
  INSERT INTO quarantine_entries
    (task_type, quarantined_at, reason, cooldown_until, required_margin_delta, baseline_pass_rate_at_quarantine, cleared_at)
  VALUES
    (@task_type, @quarantined_at, @reason, @cooldown_until, @required_margin_delta, @baseline_pass_rate_at_quarantine, @cleared_at)
  ON CONFLICT(task_type) DO UPDATE SET
    quarantined_at = excluded.quarantined_at, reason = excluded.reason, cooldown_until = excluded.cooldown_until,
    required_margin_delta = excluded.required_margin_delta,
    baseline_pass_rate_at_quarantine = excluded.baseline_pass_rate_at_quarantine, cleared_at = excluded.cleared_at
`;

// ─── Legacy JSON -> SQLite migration (round 6 finding 5: FAIL CLOSED, marker-gated) ──
//
// Round 5's migration was best-effort: any read/parse error on the legacy file was silently
// swallowed, and re-migration was gated on "is the records table still empty" — so a partially or
// incorrectly imported file could pass silently, AND a genuinely failed migration would be retried
// as many times as `recordCount === 0` held true, but a PARTIAL success (some records imported, one
// bad record silently skipped, the table now non-empty) would look "done" forever, permanently
// losing whatever record(s) failed to parse. Round 6 fixes both halves:
//   - The whole source file is parsed AND SCHEMA-VALIDATED (zod) before anything is imported; any
//     failure throws (propagated to the caller, which is every read/write function in this module —
//     the tick this runs inside records an honest infra failure and does NOT proceed to operate on
//     silently-partial safety state). This is intentionally MORE disruptive than round 5's
//     best-effort skip — "fail closed" here means stopping, not limping along on an unverified
//     import.
//   - A per-source MARKER ROW (source path, completed, imported count, completed-at) is written in
//     the SAME transaction as the (all-or-nothing) import itself — never table-emptiness. A source
//     that has never successfully completed retries on the very next access; a source that has
//     already completed is never re-imported even if new records later exist in the (no-longer-
//     authoritative) legacy file.

const adoptionProvenanceSchema = z.union([
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({ kind: z.literal("autonomy"), tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]) }).strict(),
]) satisfies z.ZodType<AdoptionProvenance>;

const adoptionWatchRecordSchema = z.object({
  id: z.string().min(1),
  adoptedAt: z.string().min(1),
  candidateHash: z.string().min(1),
  decisionRef: z.string().min(1),
  approvedBy: z.string().min(1),
  changedTaskTypes: z.array(z.string().min(1)),
  snapshotPath: z.string().min(1).nullable(),
  status: z.enum(["pending", "reverting", "healthy", "breach", "inconclusive", "superseded"]),
  lastEvaluatedAt: z.string().min(1).nullable(),
  provenance: adoptionProvenanceSchema.optional(),
  intentId: z.string().min(1).optional(),
  revertingToken: z.number().optional(),
  revertingAt: z.string().min(1).optional(),
  revertAttempts: z.number().optional(),
  lastRevertAttemptAt: z.string().min(1).optional(),
  lastRevertError: z.string().min(1).optional(),
  candidateSnapshotPath: z.string().min(1).nullable().optional(),
  pendingMergeHash: z.string().min(1).optional(),
  pendingMergeAxes: z.array(z.string().min(1)).optional(),
  breachedTaskTypes: z.array(z.string().min(1)).optional(),
}) satisfies z.ZodType<AdoptionWatchRecord>;

const watchdogStateSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(adoptionWatchRecordSchema),
}) satisfies z.ZodType<WatchdogState>;

const quarantineRecordSchema = z.object({
  taskType: z.string().min(1),
  quarantinedAt: z.string().min(1),
  reason: z.string().min(1),
  cooldownUntil: z.string().min(1),
  requiredMarginDelta: z.number(),
  baselinePassRateAtQuarantine: z.number().nullable(),
  clearedAt: z.string().min(1).nullable(),
}) satisfies z.ZodType<QuarantineRecord>;

const quarantineStateSchema = z.object({
  schemaVersion: z.literal(1),
  byTaskType: z.record(z.string(), quarantineRecordSchema),
}) satisfies z.ZodType<QuarantineState>;

const UPSERT_MIGRATION_MARKER_SQL = `
  INSERT INTO migration_markers (source_path, completed, imported_count, completed_at)
  VALUES (@source_path, 1, @imported_count, @completed_at)
  ON CONFLICT(source_path) DO UPDATE SET
    completed = excluded.completed, imported_count = excluded.imported_count, completed_at = excluded.completed_at
`;

function migrationCompleted(db: Database.Database, sourcePath: string): boolean {
  const row = db.prepare(`SELECT completed FROM migration_markers WHERE source_path = ?`).get(sourcePath) as
    | { completed: number }
    | undefined;
  return row !== undefined && row.completed === 1;
}

/**
 * One-time migration of the legacy `state.json` into SQLite — gated on its OWN marker row, never
 * table-emptiness. Throws (propagated) on ANY read/parse/schema-validation failure; the import
 * itself and the marker write commit together, atomically, so a crash between them simply leaves
 * the marker absent and the next access retries the WHOLE import from scratch (never a partial
 * "some rows landed, marker never written" state that could go undetected).
 */
function migrateLegacyStateIfNeeded(db: Database.Database, dataDir: string): void {
  const { statePath } = watchdogPaths(dataDir);
  if (migrationCompleted(db, statePath) || !existsSync(statePath)) return;

  let parsed: WatchdogState;
  try {
    parsed = watchdogStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))) as WatchdogState;
  } catch (err) {
    throw new Error(
      `adoption-watchdog: legacy state file at ${statePath} failed to migrate (${err instanceof Error ? err.message : String(err)}) — refusing to operate on silently-partial safety state; fix or remove the file, then retry.`
    );
  }

  const insert = db.prepare(UPSERT_RECORD_SQL);
  const markMarker = db.prepare(UPSERT_MIGRATION_MARKER_SQL);
  const importAll = db.transaction((): void => {
    for (const r of parsed.records) insert.run(recordToRowParams(r));
    markMarker.run({ source_path: statePath, imported_count: parsed.records.length, completed_at: new Date().toISOString() });
  });
  importAll.immediate();
}

/** Same contract as `migrateLegacyStateIfNeeded`, for the legacy `quarantine.json`. */
function migrateLegacyQuarantineIfNeeded(db: Database.Database, dataDir: string): void {
  const { quarantinePath } = watchdogPaths(dataDir);
  if (migrationCompleted(db, quarantinePath) || !existsSync(quarantinePath)) return;

  let parsed: QuarantineState;
  try {
    parsed = quarantineStateSchema.parse(JSON.parse(readFileSync(quarantinePath, "utf8"))) as QuarantineState;
  } catch (err) {
    throw new Error(
      `adoption-watchdog: legacy quarantine file at ${quarantinePath} failed to migrate (${err instanceof Error ? err.message : String(err)}) — refusing to operate on silently-partial safety state; fix or remove the file, then retry.`
    );
  }

  const entries = Object.values(parsed.byTaskType);
  const insert = db.prepare(UPSERT_QUARANTINE_SQL);
  const markMarker = db.prepare(UPSERT_MIGRATION_MARKER_SQL);
  const importAll = db.transaction((): void => {
    for (const r of entries) insert.run(quarantineToRowParams(r));
    markMarker.run({ source_path: quarantinePath, imported_count: entries.length, completed_at: new Date().toISOString() });
  });
  importAll.immediate();
}

function migrateLegacyJsonIfNeeded(db: Database.Database, dataDir: string): void {
  migrateLegacyStateIfNeeded(db, dataDir);
  migrateLegacyQuarantineIfNeeded(db, dataDir);
}

/** Round 6 finding 2: adds `reverting_token`/`reverting_at` to an existing
 *  `adoption_watch_records` table that predates them (a table created by round 5's own code before
 *  this finding landed) — SQLite has no `ADD COLUMN IF NOT EXISTS`, so this checks `PRAGMA
 *  table_info` first. Idempotent and cheap (a single pragma query) on every open. */
function ensureRevertingColumns(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(adoption_watch_records)`).all() as Array<{ name: string }>;
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("reverting_token")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN reverting_token INTEGER`);
  if (!names.has("reverting_at")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN reverting_at TEXT`);
  // Round 7 finding 2.
  if (!names.has("revert_attempts")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN revert_attempts INTEGER`);
  if (!names.has("last_revert_attempt_at")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN last_revert_attempt_at TEXT`);
  if (!names.has("last_revert_error")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN last_revert_error TEXT`);
  // Round 8 finding 1.
  if (!names.has("candidate_snapshot_path")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN candidate_snapshot_path TEXT`);
  // Round 9 finding 1 + follow-up (b).
  if (!names.has("pending_merge_hash")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN pending_merge_hash TEXT`);
  if (!names.has("pending_merge_axes")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN pending_merge_axes TEXT`);
  if (!names.has("breached_task_types")) db.exec(`ALTER TABLE adoption_watch_records ADD COLUMN breached_task_types TEXT`);
}

function openWatchdogDb(dataDir: string): Database.Database {
  const path = mutationLockDbPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    ensureLeaseTables(db); // same db file as the mutation lease — see the module note above
    db.exec(`
      CREATE TABLE IF NOT EXISTS adoption_watch_records (
        id                 TEXT PRIMARY KEY,
        adopted_at         TEXT NOT NULL,
        candidate_hash     TEXT NOT NULL,
        decision_ref       TEXT NOT NULL,
        approved_by        TEXT NOT NULL,
        changed_task_types TEXT NOT NULL,
        snapshot_path      TEXT,
        status             TEXT NOT NULL,
        last_evaluated_at  TEXT,
        provenance         TEXT,
        intent_id          TEXT,
        reverting_token    INTEGER,
        reverting_at       TEXT,
        revert_attempts        INTEGER,
        last_revert_attempt_at TEXT,
        last_revert_error      TEXT,
        candidate_snapshot_path TEXT,
        pending_merge_hash TEXT,
        pending_merge_axes TEXT,
        breached_task_types TEXT
      );
      CREATE TABLE IF NOT EXISTS quarantine_entries (
        task_type                        TEXT PRIMARY KEY,
        quarantined_at                   TEXT NOT NULL,
        reason                           TEXT NOT NULL,
        cooldown_until                   TEXT NOT NULL,
        required_margin_delta            REAL NOT NULL,
        baseline_pass_rate_at_quarantine REAL,
        cleared_at                       TEXT
      );
      CREATE TABLE IF NOT EXISTS migration_markers (
        source_path    TEXT PRIMARY KEY,
        completed      INTEGER NOT NULL,
        imported_count INTEGER NOT NULL,
        completed_at   TEXT NOT NULL
      );
    `);
    ensureRevertingColumns(db);
    migrateLegacyJsonIfNeeded(db, dataDir);
    return db;
  } catch (err) {
    // Round 6 finding 5: a migration failure (or any other setup failure) must not leak this
    // connection — close it before propagating so the caller's honest infra-failure throw does not
    // ALSO leave a dangling open sqlite handle (and, on some platforms, a held file lock) behind.
    db.close();
    throw err;
  }
}

export function loadWatchdogState(dataDir: string): WatchdogState {
  const db = openWatchdogDb(dataDir);
  try {
    const rows = db.prepare(`SELECT * FROM adoption_watch_records ORDER BY rowid`).all() as WatchRecordRow[];
    return { schemaVersion: 1, records: rows.map(rowToRecord) };
  } finally {
    db.close();
  }
}

/**
 * Bulk UPSERT-ALL of `state.records` — a convenience setter for tests and any caller that
 * legitimately wants to set the whole state at once (e.g. seeding a fixture). NOT used by this
 * module's own production hot paths (`recordAdoptionForWatch`, `runAdoptionWatch`) — those commit
 * only the ONE row they actually own, which is what closes the lost-update race this migration
 * fixes (round 5 finding 3). Still transactional, so a single call is atomic across every record.
 *
 * Round 6 follow-up — exact semantics, spelled out because they are easy to assume wrong:
 *   - Every record in `state.records` is INSERTed if its `id` is new, or UPDATEd (every column
 *     overwritten from `excluded.*`) if a row with that `id` already exists — an ordinary UPSERT,
 *     nothing surprising there.
 *   - This function NEVER DELETES a row. Passing a state with FEWER records than are currently in
 *     the db does NOT remove the missing ones — they are simply left untouched. This is NOT a
 *     "replace the table with exactly this array" operation; it is "ensure at least these records
 *     exist with these exact values". A caller that wants a genuinely empty table must delete rows
 *     itself (there is no exported helper for that — production code never needs to, and a test
 *     that does should use a fresh `dataDir` instead of trying to clear an existing one).
 */
export function saveWatchdogState(dataDir: string, state: WatchdogState): void {
  const db = openWatchdogDb(dataDir);
  try {
    const insert = db.prepare(UPSERT_RECORD_SQL);
    const upsertAll = db.transaction((records: AdoptionWatchRecord[]) => {
      for (const r of records) insert.run(recordToRowParams(r));
    });
    upsertAll.immediate(state.records);
  } finally {
    db.close();
  }
}

export function loadQuarantineState(dataDir: string): QuarantineState {
  const db = openWatchdogDb(dataDir);
  try {
    const rows = db.prepare(`SELECT * FROM quarantine_entries ORDER BY rowid`).all() as QuarantineRow[];
    const byTaskType: Record<string, QuarantineRecord> = {};
    for (const row of rows) byTaskType[row.task_type] = rowToQuarantineRecord(row);
    return { schemaVersion: 1, byTaskType };
  } finally {
    db.close();
  }
}

/** Bulk UPSERT-ALL — same convenience-setter role, and the SAME never-deletes semantics, as
 *  `saveWatchdogState` above (see its doc comment): entries in `state.byTaskType` are inserted or
 *  overwritten by task type; a task type ABSENT from `state.byTaskType` is never removed from the
 *  db just because this call's argument didn't mention it. */
export function saveQuarantineState(dataDir: string, state: QuarantineState): void {
  const db = openWatchdogDb(dataDir);
  try {
    const insert = db.prepare(UPSERT_QUARANTINE_SQL);
    const upsertAll = db.transaction((rows: QuarantineRecord[]) => {
      for (const r of rows) insert.run(quarantineToRowParams(r));
    });
    upsertAll.immediate(Object.values(state.byTaskType));
  } finally {
    db.close();
  }
}

/**
 * Called by the CLI immediately after a successful `adoptRoutingTable` outcome (never before —
 * this records what WAS adopted, it does not gate whether adoption happens). Persists the exact
 * prior table bytes as a durable snapshot (when one existed) and queues a `pending`
 * AdoptionWatchRecord for future `watch` runs to evaluate. Round 5 finding 3: this is now a SCOPED
 * single-row INSERT (never a load-whole-state/append/save-whole-state round trip), so it can never
 * clobber a concurrent `runAdoptionWatch` run's OWN scoped updates to other rows.
 */
export function recordAdoptionForWatch(p: {
  dataDir: string;
  adoptedAt: string;
  candidateHash: string;
  decisionRef: string;
  approvedBy: string;
  changedTaskTypes: string[];
  /** Exact prior live-table bytes (read BEFORE the candidate write), or null when no prior table
   *  existed (first-ever adoption — nothing to snapshot). */
  priorRaw: string | null;
  /**
   * Round 8 finding 1: exact POST-adoption candidate bytes — i.e. exactly what was just written to
   * the live table. Persisted alongside `priorRaw` so a later whole-table "superseded" breach-revert
   * classification can be refined PER AXIS (see `AdoptionWatchRecord.candidateSnapshotPath`). Optional
   * and omittable (a caller with no candidate bytes handy — e.g. a crash-recovery retroactive record —
   * simply gets a record that can only ever answer the whole-table question, never the per-axis one).
   */
  candidateRaw?: string | null;
  /** Structured provenance (issue #49 finding 7) — omit for a human/manual adoption (the
   *  routing-lifecycle CLI's own `adopt` command never passes this, so its records correctly read
   *  as `undefined`/"manual"); the autonomy controller ALWAYS passes `{kind:"autonomy", tier}`. */
  provenance?: AdoptionProvenance;
  /** The autonomy controller's `AdoptionIntent.id` this record finalizes (round 4 finding 8) —
   *  omitted for a manual CLI adopt, which has no intent journal. */
  intentId?: string;
  /**
   * Round 5 finding 1: when the caller already holds the mutation lease (both production call
   * sites do — the autonomy controller's own adopt path, and the manual CLI `adopt` command), pass
   * its token so this insert's fencing check and the row commit happen in ONE transaction on this
   * db file, never a check followed by a separate write. Throws `MutationLockStaleError` (nothing
   * was written) if the token is no longer current. Omitted by a caller with no lease context
   * (e.g. `reconcileAdoptionIntent`'s canary-passed finalize, which the CALLER wraps in its own
   * lease-held scope instead — see round 5 finding 2).
   */
  leaseToken?: number;
}): AdoptionWatchRecord {
  const { snapshotsDir, candidateSnapshotsDir } = watchdogPaths(p.dataDir);
  const id = randomUUID();
  let snapshotPath: string | null = null;
  if (p.priorRaw !== null) {
    mkdirSync(snapshotsDir, { recursive: true });
    const abs = join(snapshotsDir, `${id}.json`);
    writeFileSync(abs, p.priorRaw, "utf8");
    snapshotPath = abs;
  }
  let candidateSnapshotPath: string | null = null;
  if (p.candidateRaw != null) {
    mkdirSync(candidateSnapshotsDir, { recursive: true });
    const abs = join(candidateSnapshotsDir, `${id}.json`);
    writeFileSync(abs, p.candidateRaw, "utf8");
    candidateSnapshotPath = abs;
  }
  const record: AdoptionWatchRecord = {
    id,
    adoptedAt: p.adoptedAt,
    candidateHash: p.candidateHash,
    decisionRef: p.decisionRef,
    approvedBy: p.approvedBy,
    changedTaskTypes: p.changedTaskTypes,
    snapshotPath,
    status: "pending",
    lastEvaluatedAt: null,
    ...(p.provenance ? { provenance: p.provenance } : {}),
    ...(p.intentId ? { intentId: p.intentId } : {}),
    ...(candidateSnapshotPath !== null ? { candidateSnapshotPath } : {}),
  };
  const db = openWatchdogDb(p.dataDir);
  try {
    const insert = db.prepare(UPSERT_RECORD_SQL);
    const commit = db.transaction((): void => {
      if (p.leaseToken !== undefined && !isLeaseCurrent(db, p.leaseToken)) {
        throw new MutationLockStaleError(
          `adoption-watchdog: fencing token ${p.leaseToken} is no longer the current mutation lease — refusing to commit a new watch record with a stale token.`
        );
      }
      insert.run(recordToRowParams(record));
    });
    commit.immediate();
  } finally {
    db.close();
  }
  return record;
}

// ─── Durable watchdog events (audit trail) ────────────────────────────────────────

/** Round 7 finding 1: `"superseded"` — resolved without any table mutation because a newer
 *  legitimate adoption was found live; see `AdoptionWatchRecord.status`'s doc comment.
 *  Round 8 finding 1: `"reverted-partial"` — a whole-table "superseded" classification was refined
 *  PER AXIS: at least one of this record's own breaching axes still carried its own bad candidate
 *  value (reverted to snapshot) while at least one other was left untouched (genuinely superseded
 *  by a newer, unrelated adoption to that specific axis). */
export type WatchdogAction = "none" | "would-revert" | "reverted" | "reverted-partial" | "superseded";

export interface WatchdogRevertResult {
  status:
    | "restored"
    | "restored-reload-failed"
    | "unknown"
    | "skipped-no-snapshot"
    /** A concurrent table mutation (a manual adopt, or the autonomy controller's own adopt attempt)
     *  held the mutation lease at the moment this breach was detected (round 4 finding 3) — the
     *  revert was deliberately NOT attempted rather than racing it. The record is left `"pending"`
     *  (never resolved to `"breach"`) so the NEXT watch run re-detects and reverts it for real. */
    | "skipped-lock-busy"
    /** Round 7 finding 1: the live table matched NEITHER this record's candidate NOR its snapshot —
     *  a newer legitimate adoption is live. NO table mutation was attempted; the record resolves to
     *  the terminal `"superseded"` status instead (quarantine still applies to the axis). */
    | "superseded"
    /** Round 7 finding 2: the restore write and reload both succeeded, but the canary could not
     *  CONFIRM the revert took effect (or did not run at all) — "incomplete revert must not
     *  finalize": the record stays `"reverting"` (retriable), never terminal `"breach"`, until
     *  write AND reload AND confirmation all succeed. */
    | "restored-unconfirmed";
  rollback?: RollbackRecord;
  canary?: CanaryOutcome;
}

export interface WatchdogEvent {
  schemaVersion: 1;
  emittedAt: string;
  recordId: string;
  adoptedAt: string;
  candidateHash: string;
  decisionRef: string;
  verdict: WatchdogVerdict;
  changedTaskTypes: string[];
  metricsBefore: GuardMetricSnapshot[];
  metricsAfter: GuardMetricSnapshot[];
  breaches: Array<MetricBreachDetail & { taskType: string }>;
  killSwitchActive: boolean;
  dryRun: boolean;
  action: WatchdogAction;
  revert?: WatchdogRevertResult;
  quarantined: string[];
}

export function appendWatchdogEvent(dataDir: string, event: WatchdogEvent): void {
  const { eventsPath, root } = watchdogPaths(dataDir);
  mkdirSync(root, { recursive: true });
  appendFileSync(eventsPath, JSON.stringify(event) + "\n", "utf8");
}

// ─── The thin runner ──────────────────────────────────────────────────────────────

export interface WatchdogRunnerDeps {
  dataDir: string;
  /** Injected ledger read — real callers pass `ledger.ts`'s `guardMetricsWindow`; tests pass a fixture. */
  queryGuardMetrics: (taskTypes: string[], sinceIso: string, untilIso: string) => GuardMetricSnapshot[];
  nowIso: () => string;
  /** Reads AUTONOMY_KILL_SWITCH (or any other gate the caller wants to wire in) — injected so tests
   *  never touch process.env. */
  killSwitchOn: () => boolean;
  /** The SAME #7 AdoptDeps the routing-lifecycle CLI already builds for `adopt`/`rollback` — reused
   *  verbatim (never reimplemented) to restore+reload the exact prior snapshot on a breach. */
  adoptDeps: AdoptDeps;
}

export interface WatchRunReportItem {
  record: AdoptionWatchRecord;
  evaluation: WatchWindowEvaluation;
  action: WatchdogAction;
  revert?: WatchdogRevertResult;
  quarantined: string[];
}

export interface WatchRunReport {
  evaluatedAt: string;
  dryRun: boolean;
  killSwitchActive: boolean;
  items: WatchRunReportItem[];
  /** Round 7 finding 1: non-fatal observability warnings — e.g. a record resolved as `"superseded"`
   *  (a newer legitimate adoption was found live, so no rollback was attempted). Never gates any
   *  in-tick decision; merged into `AutonomyTickReport.warnings` by the caller. */
  warnings: string[];
}

function readPassRateForTaskType(snapshotPath: string | null, taskType: string): number | null {
  if (snapshotPath === null) return null;
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as RoutingTableDoc;
    const entry = parsed.routing?.[taskType];
    return typeof entry?.passRate === "number" ? entry.passRate : null;
  } catch {
    return null;
  }
}

/**
 * Evaluate every `pending` AdoptionWatchRecord and act on breaches. Suitable for cron (idempotent —
 * `healthy`/`inconclusive` records are resolved and never re-evaluated; `pending` records are simply
 * re-checked next run; a kill-switch-blocked breach stays `pending` so it is retried automatically
 * once the switch clears).
 *
 * `opts.dryRun: true` performs ZERO mutation: no state save, no quarantine write, no revert call, no
 * durable event append — it only returns the report so a caller (the CLI) can print what WOULD
 * happen.
 */
/**
 * Round 5 finding 3: commits ONE record's resolution (status + lastEvaluatedAt), optionally
 * alongside quarantine rows, in a SINGLE SQLite transaction guarded by `WHERE status = 'pending'` —
 * never a whole-state overwrite. Two concurrent `runAdoptionWatch` invocations resolving DIFFERENT
 * records can never clobber each other (different rows); resolving the SAME record has one commit
 * win (rows affected = 1) and the other affect zero rows (reported via the return value, never
 * silently overwritten). `leaseToken`, when supplied, is verified in the SAME transaction (round 5
 * finding 1) — used only by the branch that already holds the mutation lease because it just
 * performed a real table write (`manualRollback`); the no-table-write paths (healthy/inconclusive/
 * no-snapshot-breach) never need the lease at all, since SQLite's own transaction already serializes
 * concurrent commits to this db file.
 */
function commitRecordResolution(p: {
  dataDir: string;
  recordId: string;
  newStatus: AdoptionWatchRecord["status"];
  lastEvaluatedAt: string;
  quarantineEntries?: QuarantineRecord[];
  leaseToken?: number;
}): boolean {
  const db = openWatchdogDb(p.dataDir);
  try {
    const insertQuarantine = p.quarantineEntries && p.quarantineEntries.length > 0 ? db.prepare(UPSERT_QUARANTINE_SQL) : null;
    const commit = db.transaction((): boolean => {
      if (p.leaseToken !== undefined && !isLeaseCurrent(db, p.leaseToken)) {
        throw new MutationLockStaleError(
          `adoption-watchdog: fencing token ${p.leaseToken} is no longer the current mutation lease — refusing to commit this record's resolution with a stale token.`
        );
      }
      const result = db
        .prepare(`UPDATE adoption_watch_records SET status = ?, last_evaluated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(p.newStatus, p.lastEvaluatedAt, p.recordId);
      if (insertQuarantine) {
        for (const q of p.quarantineEntries!) insertQuarantine.run(quarantineToRowParams(q));
      }
      return result.changes > 0;
    });
    return commit.immediate();
  } finally {
    db.close();
  }
}

/**
 * Round 6 finding 2: transactionally CAS a record `fromStatus -> "reverting"`, stamping the lease
 * token that is about to perform (or retry) the external rollback action — BEFORE that action is
 * ever attempted. Only the CAS winner may proceed.
 *   - `fromStatus: "pending"` — the ordinary first-time claim; matches on status alone.
 *   - `fromStatus: "reverting"` — a RECOVERY re-claim of a row whose original claiming lease has
 *     gone stale; matches on status AND the exact stale `expectedRevertingToken` observed, so two
 *     concurrent recovery attempts on the SAME stuck row cannot both "win" (the second's `WHERE
 *     reverting_token = <the stale value>` no longer matches once the first winner's UPDATE has
 *     already replaced it with its own fresh token).
 */
function claimForReverting(p: {
  dataDir: string;
  recordId: string;
  fromStatus: "pending" | "reverting";
  expectedRevertingToken?: number;
  leaseToken: number;
  nowIso: string;
  /**
   * Round 9 follow-up (b): only meaningful when `fromStatus === "pending"` (the FIRST-ever claim) —
   * the axes that ACTUALLY breached this evaluation (a subset of `changedTaskTypes` on a "mixed
   * axis" adoption), stamped once so recovery never has to guess/widen to the full
   * `changedTaskTypes`. Omitted leaves the column NULL — recovery's own fallback
   * (`breachedTaskTypes ?? changedTaskTypes`) handles a legacy record the same conservative way it
   * always has. Never touched on a `fromStatus: "reverting"` re-claim (the value from the ORIGINAL
   * "pending -> reverting" claim persists across recovery re-claims of the same stuck row).
   */
  breachedTaskTypes?: string[];
}): boolean {
  const db = openWatchdogDb(p.dataDir);
  try {
    const commit = db.transaction((): boolean => {
      const result =
        p.fromStatus === "pending"
          ? db
              .prepare(
                `UPDATE adoption_watch_records SET status = 'reverting', reverting_token = ?, reverting_at = ?, breached_task_types = ? WHERE id = ? AND status = 'pending'`
              )
              .run(p.leaseToken, p.nowIso, p.breachedTaskTypes ? JSON.stringify(p.breachedTaskTypes) : null, p.recordId)
          : db
              .prepare(
                `UPDATE adoption_watch_records SET reverting_token = ?, reverting_at = ? WHERE id = ? AND status = 'reverting' AND reverting_token = ?`
              )
              .run(p.leaseToken, p.nowIso, p.recordId, p.expectedRevertingToken);
      return result.changes > 0;
    });
    return commit.immediate();
  } finally {
    db.close();
  }
}

/**
 * Finalizes a `"reverting"`-claimed record to its resolved status, clearing the claim, and — ONLY
 * on this same commit — writing any quarantine rows ("quarantine row written only on CAS win": a
 * claim that never reaches finalize, e.g. because the lease went stale mid-revert, never quarantines
 * anything). Guarded by the SAME token that holds the claim, so a since-superseded claim can never
 * finalize (mirrors `commitRecordResolution`'s fencing for the non-revert paths).
 */
function finalizeReverting(p: {
  dataDir: string;
  recordId: string;
  claimToken: number;
  newStatus: AdoptionWatchRecord["status"];
  lastEvaluatedAt: string;
  quarantineEntries?: QuarantineRecord[];
}): boolean {
  const db = openWatchdogDb(p.dataDir);
  try {
    const insertQuarantine = p.quarantineEntries && p.quarantineEntries.length > 0 ? db.prepare(UPSERT_QUARANTINE_SQL) : null;
    const commit = db.transaction((): boolean => {
      // Round 9 finding 1: a terminal resolution ALWAYS clears any pending-merge marker — a
      // confirmed finalize means either there was nothing to retry, or the retry just succeeded;
      // either way, nothing should be left for a LATER, unrelated evaluation of this (now-terminal)
      // record to misread.
      const result = db
        .prepare(
          `UPDATE adoption_watch_records SET status = ?, reverting_token = NULL, reverting_at = NULL, last_evaluated_at = ?, pending_merge_hash = NULL, pending_merge_axes = NULL WHERE id = ? AND status = 'reverting' AND reverting_token = ?`
        )
        .run(p.newStatus, p.lastEvaluatedAt, p.recordId, p.claimToken);
      if (result.changes > 0 && insertQuarantine) {
        for (const q of p.quarantineEntries!) insertQuarantine.run(quarantineToRowParams(q));
      }
      return result.changes > 0;
    });
    return commit.immediate();
  } finally {
    db.close();
  }
}

/** True iff `token` is still the CURRENT mutation lease — used to tell "a `reverting` claim is
 *  genuinely still in flight" (skip it) from "the claiming process died mid-revert" (recover it). */
function isRevertingClaimStillCurrent(dataDir: string, token: number): boolean {
  const db = openWatchdogDb(dataDir);
  try {
    return isLeaseCurrent(db, token);
  } finally {
    db.close();
  }
}

function quarantineEntriesFor(
  taskTypes: string[],
  now: string,
  policy: WatchdogPolicyConfig,
  record: Pick<AdoptionWatchRecord, "candidateHash" | "decisionRef" | "snapshotPath">,
  reasonSuffix = ""
): QuarantineRecord[] {
  return taskTypes.map((t) => ({
    taskType: t,
    quarantinedAt: now,
    reason: `guard-metric breach on adoption ${record.candidateHash} (${record.decisionRef})${reasonSuffix}`,
    cooldownUntil: new Date(Date.parse(now) + policy.cooldownHours * 60 * 60 * 1000).toISOString(),
    requiredMarginDelta: policy.requiredMarginDelta,
    baselinePassRateAtQuarantine: readPassRateForTaskType(record.snapshotPath, t),
    clearedAt: null,
  }));
}

/**
 * Round 7 finding 1: before ANY restore (a fresh breach revert OR a stuck-row recovery retry),
 * classify what the LIVE table currently holds relative to THIS record:
 *   - `"matches-candidate"` — the live table still holds what this record's own adoption wrote —
 *     the ordinary case; a revert is exactly the intended, safe corrective action.
 *   - `"matches-snapshot"` — the live table already holds the PRE-adoption snapshot — a revert
 *     write already landed (e.g. a crashed prior attempt), but reload/confirmation may not have.
 *   - `"superseded"` — the live table matches NEITHER: a NEWER legitimate adoption is live. A full-
 *     table rollback here would clobber that newer, unrelated work. NEVER roll back in this case.
 */
function classifyLiveTable(liveRaw: string | null, candidateHash: string, snapshotRaw: string): "matches-candidate" | "matches-snapshot" | "superseded" {
  const liveHash = tableContentHash(liveRaw);
  if (liveHash === candidateHash) return "matches-candidate";
  if (liveHash === tableContentHash(snapshotRaw)) return "matches-snapshot";
  return "superseded";
}

/**
 * Round 7 finding 2: "incomplete revert must not finalize" — records a failed/unconfirmed revert
 * ATTEMPT (attempt count, timestamp, error) WITHOUT transitioning status away from `"reverting"`.
 * Guarded by the SAME claim token, so a since-superseded claim cannot mark an attempt against a row
 * some OTHER holder now owns. Mirrors `AdoptionIntent.restoreAttempts`'s failure-marking pattern.
 */
function markRevertAttemptFailed(p: {
  dataDir: string;
  recordId: string;
  claimToken: number;
  attemptAt: string;
  error: string;
  /** Round 6's "quarantine every breaching axis regardless of revert quality — the breach itself
   *  is the trigger; a failed restore-write does not make the axis any MORE trustworthy" applies
   *  here too: an incomplete/failed revert attempt still quarantines, it just does not FINALIZE the
   *  record. Upserted by task_type (`UPSERT_QUARANTINE_SQL`), so retried attempts across multiple
   *  ticks safely re-write the SAME rows rather than duplicating them. */
  quarantineEntries?: QuarantineRecord[];
  /**
   * Round 9 finding 1: REQUIRED (never silently defaulted) so every call site makes an explicit
   * choice. `{ hash, axes }` SETS the pending-merge marker — this failed/incomplete attempt's own
   * merged bytes, to be retried (without reclassifying) next time the live table still matches
   * `hash`. `null` CLEARS it — this failure is NOT a partial-restore attempt (the whole-table path,
   * a fully-superseded resolution, or the generic per-record error handler), so any marker a
   * DIFFERENT, earlier attempt might have left behind must not linger and be misread by a later,
   * unrelated evaluation of this same record.
   */
  pendingMerge: { hash: string; axes: string[] } | null;
}): boolean {
  const db = openWatchdogDb(p.dataDir);
  try {
    const insertQuarantine = p.quarantineEntries && p.quarantineEntries.length > 0 ? db.prepare(UPSERT_QUARANTINE_SQL) : null;
    const commit = db.transaction((): boolean => {
      const result = db
        .prepare(
          `UPDATE adoption_watch_records SET revert_attempts = COALESCE(revert_attempts, 0) + 1, last_revert_attempt_at = ?, last_revert_error = ?, pending_merge_hash = ?, pending_merge_axes = ? WHERE id = ? AND status = 'reverting' AND reverting_token = ?`
        )
        .run(
          p.attemptAt,
          p.error,
          p.pendingMerge ? p.pendingMerge.hash : null,
          p.pendingMerge ? JSON.stringify(p.pendingMerge.axes) : null,
          p.recordId,
          p.claimToken
        );
      if (result.changes > 0 && insertQuarantine) {
        for (const q of p.quarantineEntries!) insertQuarantine.run(quarantineToRowParams(q));
      }
      return result.changes > 0;
    });
    return commit.immediate();
  } finally {
    db.close();
  }
}

function describeIncompleteRevert(rollback: RollbackRecord, canary: CanaryOutcome | undefined): string {
  if (!rollback.restoreWriteOk) return `restore write failed: ${rollback.reason}`;
  if (!rollback.reloadOk) return `reload failed after restore write: ${rollback.reason}`;
  if (!canary) return "restore write + reload succeeded but the canary could not run to confirm";
  if (!canary.ok) {
    return `restore write + reload succeeded but canary did NOT confirm: ${canary.checks
      .filter((c) => !c.ok)
      .map((c) => `${c.taskType}: ${c.detail}`)
      .join("; ")}`;
  }
  return "unknown incomplete state"; // unreachable in practice — confirmed cases never reach this describer
}

/**
 * Round 8 finding 1: refines a whole-table "superseded" classification PER AXIS. `p.axes` is
 * normally `record.changedTaskTypes` (the axes THIS record's own adoption touched). For each axis,
 * compares the LIVE table's routing TARGET (`routingTarget` — the same content-blind "what would a
 * request for this task type actually resolve to" unit the canary itself uses) against what THIS
 * record's own persisted candidate bytes say that axis should be:
 *   - target UNCHANGED since this record's adoption (`restoreAxes`) — the breach is STILL LIVE for
 *     this axis; it needs reverting to the snapshot value.
 *   - target DIFFERS from this record's candidate (`supersededAxes`) — a newer, unrelated adoption
 *     re-routed THIS SPECIFIC axis since; rolling it back would clobber that newer work.
 * `p.candidateRaw === null` (no persisted candidate bytes — a legacy record, or a crash-recovery
 * retroactive record that never captured them) means per-axis refinement is IMPOSSIBLE: every axis
 * is conservatively treated as `supersededAxes` (the safe direction — falls back to round 7's
 * whole-table "superseded, zero mutation" behavior via an empty `restoreAxes`).
 */
function planPartialAxisRestore(p: { liveRaw: string | null; candidateRaw: string | null; axes: string[] }): {
  restoreAxes: string[];
  supersededAxes: string[];
} {
  if (p.candidateRaw === null) {
    return { restoreAxes: [], supersededAxes: [...p.axes] };
  }
  const liveParsed = p.liveRaw !== null ? (JSON.parse(p.liveRaw) as RoutingTableDoc) : null;
  const candidateParsed = JSON.parse(p.candidateRaw) as RoutingTableDoc;
  const liveTable: RoutingTable = { routing: liveParsed?.routing ?? {}, escalateToFrontier: liveParsed?.escalateToFrontier ?? [] };
  const candidateTable: RoutingTable = { routing: candidateParsed.routing ?? {}, escalateToFrontier: candidateParsed.escalateToFrontier ?? [] };
  const restoreAxes: string[] = [];
  const supersededAxes: string[] = [];
  for (const axis of p.axes) {
    if (routingTarget(axis, liveTable) === routingTarget(axis, candidateTable)) {
      restoreAxes.push(axis);
    } else {
      supersededAxes.push(axis);
    }
  }
  return { restoreAxes, supersededAxes };
}

/**
 * Round 8 finding 1: builds the restoration table for a PARTIAL (per-axis) revert — the CURRENT
 * live table with ONLY `axes` reset to their snapshot values (routing entry AND `escalateToFrontier`
 * membership, both taken from the snapshot); every OTHER axis (superseded axes this record chose not
 * to touch, and any entirely unrelated axis a newer adoption introduced) is preserved byte-for-byte
 * as the live table currently has it. Mirrors `autonomy-controller.ts`'s `buildAxisArtifactInputs` —
 * the SAME "isolate to just these axes, leave everything else exactly as it is" approach, reused here
 * for the watchdog's own revert direction instead of the controller's adopt direction.
 */
function buildPartialAxisRestoreRaw(liveRaw: string, snapshotRaw: string, axes: string[]): string {
  const live = JSON.parse(liveRaw) as RoutingTableDoc;
  const snapshot = JSON.parse(snapshotRaw) as RoutingTableDoc;
  const routing = { ...live.routing };
  const escalateSet = new Set(live.escalateToFrontier ?? []);
  for (const axis of axes) {
    if (Object.prototype.hasOwnProperty.call(snapshot.routing, axis)) {
      routing[axis] = snapshot.routing[axis];
    } else {
      delete routing[axis];
    }
    if ((snapshot.escalateToFrontier ?? []).includes(axis)) {
      escalateSet.add(axis);
    } else {
      escalateSet.delete(axis);
    }
  }
  return JSON.stringify({ ...live, routing, escalateToFrontier: [...escalateSet] }, null, 2) + "\n";
}

/**
 * Round 9 follow-up (a): lazily captures the missing `candidateSnapshotPath` for a LEGACY record
 * (one that predates round 8's per-axis machinery, or whose candidate bytes were never captured for
 * some other reason) — but ONLY while it is still safe to do so: the live table right now must still
 * hash-match this record's own `candidateHash`. Once that stops being true (a newer adoption has
 * superseded it), backfilling would capture the WRONG bytes under this record's name — the
 * no-candidate-bytes fallback (whole-table "superseded") is the correct, safe answer at that point,
 * not a backfill. Runs "at first access under the lease" — called from `performRevertAndFinalize`,
 * which only ever runs while this record is durably claimed `"reverting"` under `p.claimToken`; the
 * DB update is fenced by that same claim (and guarded against a concurrent double-backfill) so a
 * since-superseded claim cannot attribute a backfill to a record another holder now owns — the FILE
 * itself is still written either way (an orphaned file on a lost race is harmless, just unreferenced).
 */
function backfillCandidateSnapshotIfPossible(p: {
  dataDir: string;
  recordId: string;
  claimToken: number;
  liveRaw: string | null;
  candidateHash: string;
}): string | null {
  if (p.liveRaw === null) return null;
  if (tableContentHash(p.liveRaw) !== p.candidateHash) return null;
  const { candidateSnapshotsDir } = watchdogPaths(p.dataDir);
  mkdirSync(candidateSnapshotsDir, { recursive: true });
  const abs = join(candidateSnapshotsDir, `${p.recordId}.json`);
  writeFileSync(abs, p.liveRaw, "utf8");
  const db = openWatchdogDb(p.dataDir);
  try {
    const commit = db.transaction((): boolean => {
      const result = db
        .prepare(
          `UPDATE adoption_watch_records SET candidate_snapshot_path = ? WHERE id = ? AND status = 'reverting' AND reverting_token = ? AND candidate_snapshot_path IS NULL`
        )
        .run(abs, p.recordId, p.claimToken);
      return result.changes > 0;
    });
    return commit.immediate() ? abs : null;
  } finally {
    db.close();
  }
}

/**
 * Round 9 follow-up (c): a defensive, pre-write structural check on a constructed partial-restore
 * table — "trust but verify" before a production mutation. Confirms the merged bytes actually parse
 * as a routing table, and that EVERY task type NOT in `axes` (both its routing entry and its
 * `escalateToFrontier` membership) is byte/value-IDENTICAL between the live table and the merged
 * table — i.e. the merge touched ONLY the intended axes. Throws (never returns a boolean) on any
 * violation; the caller never catches this locally — it is meant to propagate to
 * `performRevertAndFinalize`'s own outer per-record error handler (round 8 finding 5), which
 * fail-marks the record and retries later rather than writing a merge that touched more than
 * intended. This should never actually fire given correct construction; it exists as a last-resort
 * guard against a future regression in `buildPartialAxisRestoreRaw` reaching production.
 */
export function validatePartialRestoreRaw(liveRaw: string, mergedRaw: string, axes: string[]): void {
  const live = JSON.parse(liveRaw) as RoutingTableDoc;
  const merged = JSON.parse(mergedRaw) as RoutingTableDoc;
  if (!merged || typeof merged !== "object" || !merged.routing || typeof merged.routing !== "object") {
    throw new Error("partial-restore validation failed: merged table does not parse as a routing table (missing/invalid 'routing' object)");
  }
  const axisSet = new Set(axes);
  const allTaskTypes = new Set([...Object.keys(live.routing ?? {}), ...Object.keys(merged.routing ?? {})]);
  for (const taskType of allTaskTypes) {
    if (axisSet.has(taskType)) continue; // an intended axis — expected (allowed) to differ
    const liveEntry = JSON.stringify((live.routing ?? {})[taskType] ?? null);
    const mergedEntry = JSON.stringify((merged.routing ?? {})[taskType] ?? null);
    if (liveEntry !== mergedEntry) {
      throw new Error(
        `partial-restore validation failed: unrelated axis '${taskType}' changed in the merged table but was never one of the intended restore axes [${axes.join(", ")}] — refusing to write a merge that touches more than intended`
      );
    }
  }
  const liveEscalate = new Set(live.escalateToFrontier ?? []);
  const mergedEscalate = new Set(merged.escalateToFrontier ?? []);
  for (const taskType of new Set([...liveEscalate, ...mergedEscalate])) {
    if (axisSet.has(taskType)) continue;
    if (liveEscalate.has(taskType) !== mergedEscalate.has(taskType)) {
      throw new Error(
        `partial-restore validation failed: unrelated axis '${taskType}'s escalateToFrontier membership changed in the merged table but it was never one of the intended restore axes [${axes.join(", ")}]`
      );
    }
  }
}

/**
 * Round 10 finding 1: persists the pending-merge marker (hash + axes), fenced under the caller's
 * claim token, WITHOUT touching `revert_attempts`/`last_revert_error`/quarantine — a deliberately
 * separate, narrower write than `markRevertAttemptFailed`'s. Called BEFORE `manualRollback` ever
 * attempts the write (see `attemptPartialRestore`'s own doc comment for why the ORDERING is the
 * fix): a crash between this call and the write leaves an HONEST "intended to reach this merged
 * state, but did I?" marker; recovery's own hash-mismatch check (the live table still shows the
 * PRE-write content) correctly clears it and reclassifies fresh — "a pre-write crash is safe."
 */
function markPendingMergeAttempt(p: { dataDir: string; recordId: string; claimToken: number; hash: string; axes: string[] }): boolean {
  const db = openWatchdogDb(p.dataDir);
  try {
    const commit = db.transaction((): boolean => {
      const result = db
        .prepare(`UPDATE adoption_watch_records SET pending_merge_hash = ?, pending_merge_axes = ? WHERE id = ? AND status = 'reverting' AND reverting_token = ?`)
        .run(p.hash, JSON.stringify(p.axes), p.recordId, p.claimToken);
      return result.changes > 0;
    });
    return commit.immediate();
  } finally {
    db.close();
  }
}

/**
 * Round 9 finding 1 (+ round 10 finding 1's ordering fix): the shared write+reload+canary+confirm+
 * finalize/fail-mark core for a PARTIAL (per-axis) restore — used for BOTH a fresh attempt (freshly
 * planned via `planPartialAxisRestore`/`buildPartialAxisRestoreRaw`) and a RETRY of an already-
 * in-flight attempted merge (the live table already matches `record.pendingMergeHash` —
 * re-confirming, never re-planning). `restorationRaw` is already the exact bytes to write (identical
 * content is a safe no-op, per round 7's own "re-writing bytes that are already present is a safe
 * no-op" pattern).
 *
 * Round 10 finding 1: the pending-merge marker is now persisted (`markPendingMergeAttempt`) BEFORE
 * `manualRollback` is even attempted — round 9's version persisted it only in the FAILURE branches,
 * AFTER the write+reload had already run, leaving a real gap: a crash between a SUCCESSFUL write and
 * a successful reload (i.e. exactly mid-reload) left NO marker at all, so recovery's classification
 * saw the merged (now-live) table matching neither candidateHash nor snapshotHash, read it as
 * "superseded", and finalized WITHOUT ever confirming the reload actually happened. Persisting the
 * marker first closes this: even a crash before the write ever runs is safe (the live table still
 * shows the OLD, pre-write content, which does not match the marker's hash — recovery's own
 * hash-mismatch check clears the now-stale marker and reclassifies fresh, exactly as intended).
 *
 * This function's job is: mark the intended merge -> write -> reload -> canary (scoped to
 * `restoreAxes`) -> confirm -> finalize `"breach"` (clearing the merge marker, via
 * `finalizeReverting`'s own unconditional clear) OR fail-mark, RE-PERSISTING
 * `pendingMergeHash`/`pendingMergeAxes` (same values — a harmless re-affirm) on any non-confirmed
 * outcome so a LATER run retries confirmation of THIS EXACT state without reclassifying (Sol's
 * exact round-9 reproduction: run1 restored-reload-failed/reverting, run2 wrongly resolved
 * superseded, reload count never advanced).
 */
async function attemptPartialRestore(p: {
  deps: WatchdogRunnerDeps;
  policy: WatchdogPolicyConfig;
  record: AdoptionWatchRecord;
  breachingTaskTypes: string[];
  restoreAxes: string[];
  supersededAxes: string[];
  restorationRaw: string;
  snapshotRaw: string;
  now: string;
  lockToken: number;
  dryRun: boolean;
}): Promise<{
  claimed: true;
  action: WatchdogAction;
  revert: WatchdogRevertResult;
  newStatus: AdoptionWatchRecord["status"];
  quarantined: string[];
  warning?: string;
}> {
  const { deps, policy, record, breachingTaskTypes, restoreAxes, supersededAxes, restorationRaw, snapshotRaw, now, lockToken, dryRun } = p;
  const mergeHash = tableContentHash(restorationRaw);
  const warningPrefix = `adoption-watchdog: record ${record.id} (candidateHash=${record.candidateHash}) was PARTIALLY superseded — axes [${restoreAxes.join(", ")}] still carried this record's own regressed candidate value and were restored to snapshot${supersededAxes.length > 0 ? `; axes [${supersededAxes.join(", ")}] were left untouched (already superseded by a newer, unrelated adoption)` : ""}.`;

  // Round 10 finding 1: persist the pending-merge marker BEFORE the write is even attempted — see
  // this function's own doc comment for why the ordering closes the "crash mid-reload leaves no
  // marker" gap. Best-effort: if this itself is refused (e.g. the claim token has already gone
  // stale by this point), the write below will independently discover the same staleness via
  // `manualRollback`'s own fencing and refuse too — never a silent divergence.
  if (!dryRun) {
    markPendingMergeAttempt({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, hash: mergeHash, axes: restoreAxes });
  }

  // Round 6 finding 1: fence the actual rollback write with THIS SAME lease token.
  const fencedDeps: AdoptDeps = { ...deps.adoptDeps, leaseContext: { dataDir: deps.dataDir, token: lockToken } };
  const rollback = await manualRollback({
    deps: fencedDeps,
    snapshotRaw: restorationRaw,
    reason:
      `adoption-watchdog: guard-metric breach on [${restoreAxes.join(", ")}] within the post-adoption watch ` +
      `window (candidateHash=${record.candidateHash}, decisionRef=${record.decisionRef}) — PARTIAL (per-axis) ` +
      `restore${supersededAxes.length > 0 ? `; axes [${supersededAxes.join(", ")}] preserved as superseded` : ""}`,
  });

  if (rollback.staleLeaseRefused) {
    const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record, " — partial revert attempt refused (stale lease); retrying next tick");
    if (!dryRun) {
      markRevertAttemptFailed({
        dataDir: deps.dataDir,
        recordId: record.id,
        claimToken: lockToken,
        attemptAt: now,
        error: rollback.reason,
        quarantineEntries,
        pendingMerge: { hash: mergeHash, axes: restoreAxes },
      });
    }
    return { claimed: true, action: "would-revert", revert: { status: "unknown", rollback }, newStatus: "reverting", quarantined: breachingTaskTypes, warning: warningPrefix };
  }

  let canary: CanaryOutcome | undefined;
  if (rollback.restoreWriteOk && rollback.reloadOk) {
    try {
      const reloadedRaw = deps.adoptDeps.readTable(deps.adoptDeps.tablePath);
      const reloadedParsed = JSON.parse(reloadedRaw) as { routing?: RoutingTableDoc["routing"]; escalateToFrontier?: string[] };
      const priorParsed = JSON.parse(snapshotRaw) as RoutingTableDoc;
      const servableModelIds = await deps.adoptDeps.servableModelIdsAfterReload();
      canary = runCanary({
        changedTaskTypes: restoreAxes,
        reloadedTable: { routing: reloadedParsed.routing ?? {}, escalateToFrontier: reloadedParsed.escalateToFrontier ?? [] },
        candidate: priorParsed,
        servableModelIds,
      });
    } catch {
      canary = undefined;
    }
  }

  const status: WatchdogRevertResult["status"] = !rollback.restoreWriteOk
    ? "unknown"
    : !rollback.reloadOk
      ? "restored-reload-failed"
      : canary?.ok === true
        ? "restored"
        : "restored-unconfirmed";
  const revert: WatchdogRevertResult = { status, rollback, canary };
  const confirmed = status === "restored";

  if (!confirmed) {
    const quarantineEntries = quarantineEntriesFor(
      breachingTaskTypes,
      now,
      policy,
      record,
      ` — partial revert attempt incomplete (${describeIncompleteRevert(rollback, canary)}); retrying next tick`
    );
    if (!dryRun) {
      markRevertAttemptFailed({
        dataDir: deps.dataDir,
        recordId: record.id,
        claimToken: lockToken,
        attemptAt: now,
        error: describeIncompleteRevert(rollback, canary),
        quarantineEntries,
        pendingMerge: { hash: mergeHash, axes: restoreAxes },
      });
    }
    return { claimed: true, action: "would-revert", revert, newStatus: "reverting", quarantined: breachingTaskTypes, warning: warningPrefix };
  }

  // Quarantine the FULL breaching set (both restored and superseded axes) — the OLD candidate's
  // breach evidence remains valid for every axis it originally touched, regardless of whether THIS
  // revert action mutated it (same rule as the whole-table superseded/incomplete paths).
  const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record);
  if (!dryRun) {
    finalizeReverting({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, newStatus: "breach", lastEvaluatedAt: now, quarantineEntries });
  }
  return { claimed: true, action: "reverted-partial", revert, newStatus: "breach", quarantined: breachingTaskTypes, warning: warningPrefix };
}

/**
 * Round 6 finding 2: performs the external rollback action for ONE breaching record, but ONLY after
 * winning the CAS claim (`fromStatus -> "reverting"`) — "watchdog acts before claiming" is exactly
 * the bug this closes: the CAS now happens BEFORE `manualRollback`, not after.
 *
 * Round 7 finding 1: immediately after claiming (and BEFORE any restore action), the live table is
 * classified against this record's candidate/snapshot (`classifyLiveTable`). A `"superseded"`
 * result means a NEWER legitimate adoption is live — this function NEVER rolls back in that case;
 * it resolves the record to the terminal `"superseded"` status with ZERO table mutation (quarantine
 * still applies to the axis) and surfaces a warning. Otherwise (still matches the candidate, OR
 * already matches the snapshot from an earlier crashed attempt) it proceeds with the SAME
 * `manualRollback` call either way — re-writing bytes that are already present is a safe no-op, and
 * critically this means reload+canary ALWAYS run regardless of whether the write itself was a
 * no-op (round 7 finding 2: "the gateway caches the table; disk state alone proves nothing about
 * what's being served").
 *
 * Round 8 finding 1: a "superseded" whole-table classification is refined PER AXIS
 * (`planPartialAxisRestore`) before giving up — a later adoption that only touched an UNRELATED axis
 * must never strand THIS record's own still-live bad axis served forever. See the `"superseded"`
 * branch below.
 *
 * Round 8 finding 5: everything from the snapshot read onward is wrapped in a try/catch — a read
 * error (EIO/EACCES) or malformed JSON anywhere in this record's own files must fail-mark THIS
 * record and retry later, never throw past this function (which would abort the ENTIRE watch run,
 * starving every OTHER record this same run would otherwise have evaluated).
 *
 * Round 7 finding 2: finalizes to terminal `"breach"` ONLY when the restore write AND reload AND
 * canary confirmation ALL succeeded. Anything less (a stale-lease refusal, a failed write, a failed
 * reload, or a reload that succeeded without canary confirmation) leaves the record `"reverting"`
 * (retriable) and records the attempt via `markRevertAttemptFailed` — never finalized as if the
 * revert had actually, confirmedly happened.
 */
async function performRevertAndFinalize(p: {
  deps: WatchdogRunnerDeps;
  policy: WatchdogPolicyConfig;
  record: AdoptionWatchRecord;
  breachingTaskTypes: string[];
  now: string;
  lockToken: number;
  fromStatus: "pending" | "reverting";
  dryRun: boolean;
}): Promise<{
  claimed: boolean;
  action: WatchdogAction;
  revert?: WatchdogRevertResult;
  newStatus: AdoptionWatchRecord["status"];
  quarantined: string[];
  warning?: string;
}> {
  const { deps, policy, record, breachingTaskTypes, now, lockToken, fromStatus, dryRun } = p;

  const claimed = claimForReverting({
    dataDir: deps.dataDir,
    recordId: record.id,
    fromStatus,
    expectedRevertingToken: record.revertingToken,
    leaseToken: lockToken,
    nowIso: now,
    // Round 9 follow-up (b): only meaningful (and only ever applied) on the FIRST "pending ->
    // reverting" claim — `claimForReverting` itself ignores this on a `fromStatus: "reverting"`
    // re-claim, so this is safe to pass unconditionally on every call.
    breachedTaskTypes: breachingTaskTypes,
  });
  if (!claimed) {
    // Someone else (another process, or this same record having already moved on) beat us to it.
    return { claimed: false, action: "none", newStatus: record.status, quarantined: [] };
  }

  // Round 10 finding 2: "check/carry the marker first" — captured ONCE, before any of the reads
  // below that could throw, so the generic per-record catch (finding 5) can PRESERVE it rather than
  // guessing. `record` itself never mutates during this call, so this is exactly the marker state
  // this record entered the call with.
  const enteringPendingMerge: { hash: string; axes: string[] } | null = record.pendingMergeHash
    ? { hash: record.pendingMergeHash, axes: record.pendingMergeAxes ?? [] }
    : null;

  try {
    if (record.snapshotPath === null) {
      // Round 8 follow-up (b): no snapshot to restore TO (first-ever adoption) does NOT mean
      // "nothing can be done" — the correct undo is DELETING the bad, unconfirmed table outright
      // (mirrors `reconcileAdoptionIntent`'s own first-ever-adoption undo), never leaving it live
      // forever while calling the record "reverted". Confirmation-gated exactly like the
      // whole-table path below (round 7 finding 2): terminal "breach" only once the delete AND the
      // reload both genuinely succeed — there is no table content left to canary-check against, so
      // "confirmed" here is `restoreWriteOk && reloadOk`.
      const fencedDeps: AdoptDeps = { ...deps.adoptDeps, leaseContext: { dataDir: deps.dataDir, token: lockToken } };
      const rollback = await deleteTableAndReload({
        deps: fencedDeps,
        reason:
          `adoption-watchdog: guard-metric breach on [${breachingTaskTypes.join(", ")}] within the post-adoption ` +
          `watch window (candidateHash=${record.candidateHash}, decisionRef=${record.decisionRef}) — no prior ` +
          `snapshot existed (first-ever adoption); deleting the unconfirmed table`,
      });
      const confirmed = rollback.restoreWriteOk && rollback.reloadOk;
      const status: WatchdogRevertResult["status"] = rollback.staleLeaseRefused
        ? "unknown"
        : !rollback.restoreWriteOk
          ? "unknown"
          : !rollback.reloadOk
            ? "restored-reload-failed"
            : "restored";
      const revert: WatchdogRevertResult = { status, rollback };
      if (!confirmed) {
        const quarantineEntries = quarantineEntriesFor(
          breachingTaskTypes,
          now,
          policy,
          record,
          ` — revert attempt incomplete (delete-and-reload did not fully succeed: ${rollback.reason}); retrying next tick`
        );
        if (!dryRun) {
          // Round 9 finding 1: not a partial-restore attempt (no snapshot even exists) — clear any
          // stale merge marker (defensive; none should ever be set for a no-snapshot record).
          markRevertAttemptFailed({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, attemptAt: now, error: rollback.reason, quarantineEntries, pendingMerge: null });
        }
        return { claimed: true, action: "would-revert", revert, newStatus: "reverting", quarantined: breachingTaskTypes };
      }
      const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record);
      if (!dryRun) {
        finalizeReverting({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, newStatus: "breach", lastEvaluatedAt: now, quarantineEntries });
      }
      return { claimed: true, action: "reverted", revert, newStatus: "breach", quarantined: breachingTaskTypes };
    }

    const snapshotRaw = readFileSync(record.snapshotPath, "utf8");
    // Round 9 finding 2: null ONLY on a VERIFIED "no table at all" (ENOENT) — any OTHER read error
    // (EACCES, EIO, a transient I/O fault) must PROPAGATE to the outer per-record catch (round 8
    // finding 5), never be silently folded into `null`. `tableContentHash(null)` reads as the
    // sentinel "(none)", which matches neither a real candidateHash nor a real snapshot hash —
    // treating a permission error as "the table is absent" wrongly resolved this record terminal
    // "superseded" (Sol reproduced this with EACCES) instead of a retriable failure-mark.
    const liveRawBeforeAction = (() => {
      try {
        return deps.adoptDeps.readTable(deps.adoptDeps.tablePath);
      } catch (err) {
        if (isVerifiedEnoentError(err)) return null;
        throw err;
      }
    })();

    // Round 9 follow-up (a): opportunistically backfill a LEGACY record's missing
    // `candidateSnapshotPath` while it is still safe (live currently matches candidateHash) — never
    // changes this run's own classification/outcome, just enriches the record for a LATER run that
    // might need per-axis refinement after all.
    const candidateSnapshotPathForThisRun =
      record.candidateSnapshotPath ??
      backfillCandidateSnapshotIfPossible({
        dataDir: deps.dataDir,
        recordId: record.id,
        claimToken: lockToken,
        liveRaw: liveRawBeforeAction,
        candidateHash: record.candidateHash,
      });

    // Round 9 finding 1: a PENDING attempted merge from a prior incomplete partial-restore attempt —
    // retry ITS confirmation, NEVER reclassify, as long as the live table still matches it. Matching
    // means write+reload+canary against THIS EXACT state (a safe no-op write, since the bytes are
    // already there); NOT matching means someone else changed the table since — fall through to
    // fresh classification below (the stale marker is explicitly cleared by every path that follows,
    // so it can never linger and be misread by a later, unrelated evaluation of this same record).
    if (record.pendingMergeHash && liveRawBeforeAction !== null && tableContentHash(liveRawBeforeAction) === record.pendingMergeHash) {
      return await attemptPartialRestore({
        deps,
        policy,
        record,
        breachingTaskTypes,
        restoreAxes: record.pendingMergeAxes ?? breachingTaskTypes,
        supersededAxes: [],
        restorationRaw: liveRawBeforeAction,
        snapshotRaw,
        now,
        lockToken,
        dryRun,
      });
    }

    const classification = classifyLiveTable(liveRawBeforeAction, record.candidateHash, snapshotRaw);

    if (classification === "superseded") {
      // Round 8 finding 1: a whole-table mismatch does NOT mean every axis THIS record touched is
      // actually superseded — a later, unrelated adoption to a DIFFERENT axis produces the exact
      // same whole-table hash mismatch while leaving this record's own bad axis untouched and still
      // live. Refine per axis before giving up.
      const candidateRawForPlan = candidateSnapshotPathForThisRun ? readFileSync(candidateSnapshotPathForThisRun, "utf8") : null;
      const { restoreAxes, supersededAxes } = planPartialAxisRestore({
        liveRaw: liveRawBeforeAction,
        candidateRaw: candidateRawForPlan,
        axes: breachingTaskTypes,
      });

      if (restoreAxes.length === 0) {
        // Every one of this record's own axes has moved on to something other than what THIS
        // record's own candidate wrote (or per-axis refinement was unavailable) — genuinely
        // superseded on every axis; zero mutation (unchanged from round 7's whole-table behavior).
        const warning = `adoption-watchdog: record ${record.id} (candidateHash=${record.candidateHash}) was SUPERSEDED by a newer adoption before its breach revert could run — the live table matches neither this record's candidate nor its snapshot${candidateRawForPlan ? " (per-axis check confirmed every breaching axis has since moved on)" : " (no persisted candidate bytes to refine this per axis)"}. No rollback was attempted; quarantine still applied to [${breachingTaskTypes.join(", ")}].`;
        const quarantineEntries = quarantineEntriesFor(
          breachingTaskTypes,
          now,
          policy,
          record,
          " — table was superseded by a newer adoption before this revert could run; quarantine still applied, no rollback attempted"
        );
        if (!dryRun) {
          finalizeReverting({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, newStatus: "superseded", lastEvaluatedAt: now, quarantineEntries });
        }
        return {
          claimed: true,
          action: "superseded",
          revert: { status: "superseded" },
          newStatus: "superseded",
          quarantined: breachingTaskTypes,
          warning,
        };
      }

      // At least one axis still carries THIS record's own (bad) candidate value — the breach is
      // still live for it. Build a restoration table: the CURRENT live table with ONLY the
      // still-live axes reset to their snapshot values — every other axis (superseded axes, and any
      // entirely unrelated axis a newer adoption touched) is preserved exactly as-is.
      const restorationRaw = buildPartialAxisRestoreRaw(liveRawBeforeAction as string, snapshotRaw, restoreAxes);
      // Round 9 follow-up (c): a defensive structural check BEFORE this ever reaches a write —
      // throws (caught by the outer per-record handler, round 8 finding 5) if the merge somehow
      // touched more than the intended axes; never writes a merge it cannot verify is scoped
      // correctly.
      validatePartialRestoreRaw(liveRawBeforeAction as string, restorationRaw, restoreAxes);
      return await attemptPartialRestore({
        deps,
        policy,
        record,
        breachingTaskTypes,
        restoreAxes,
        supersededAxes,
        restorationRaw,
        snapshotRaw,
        now,
        lockToken,
        dryRun,
      });
    }

    // Round 6 finding 1: fence the actual rollback write with THIS SAME lease token. Safe to call
    // regardless of whether the live table already matches the snapshot (classification ===
    // "matches-snapshot") — re-writing identical bytes is a no-op, and this guarantees reload+canary
    // ALWAYS run (round 7 finding 2), never skipped just because disk content already looked right.
    const fencedDeps: AdoptDeps = { ...deps.adoptDeps, leaseContext: { dataDir: deps.dataDir, token: lockToken } };
    const rollback = await manualRollback({
      deps: fencedDeps,
      snapshotRaw,
      reason:
        `adoption-watchdog: guard-metric breach on [${breachingTaskTypes.join(", ")}] within the ` +
        `post-adoption watch window (candidateHash=${record.candidateHash}, decisionRef=${record.decisionRef})`,
    });

    if (rollback.staleLeaseRefused) {
      // Round 6 finding 1: "a stale holder must never roll back" — the write was correctly refused,
      // never attempted. Do NOT finalize: leave this record claimed ("reverting") with its now-stale
      // token, an honest unresolved state + warning (the rollback record's own `reason` says so) —
      // the NEXT watch run's recovery path detects the stale claim and re-examines it. Quarantine
      // STILL applies — the breach itself (not the revert's success) is the trigger (round 6's
      // "quarantine regardless of revert quality", carried forward to every incomplete-revert path).
      const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record, " — revert attempt refused (stale lease); retrying next tick");
      if (!dryRun) {
        // Round 9 finding 1: NOT a partial-restore attempt — clear any stale merge marker an
        // EARLIER, different attempt might have left behind so a later evaluation never misreads it.
        markRevertAttemptFailed({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, attemptAt: now, error: rollback.reason, quarantineEntries, pendingMerge: null });
      }
      return {
        claimed: true,
        action: "would-revert",
        revert: { status: "unknown", rollback },
        newStatus: "reverting",
        quarantined: breachingTaskTypes,
      };
    }

    let canary: CanaryOutcome | undefined;
    if (rollback.restoreWriteOk && rollback.reloadOk) {
      try {
        const reloadedRaw = deps.adoptDeps.readTable(deps.adoptDeps.tablePath);
        const reloadedParsed = JSON.parse(reloadedRaw) as { routing?: RoutingTableDoc["routing"]; escalateToFrontier?: string[] };
        const priorParsed = JSON.parse(snapshotRaw) as RoutingTableDoc;
        const servableModelIds = await deps.adoptDeps.servableModelIdsAfterReload();
        canary = runCanary({
          changedTaskTypes: breachingTaskTypes,
          reloadedTable: { routing: reloadedParsed.routing ?? {}, escalateToFrontier: reloadedParsed.escalateToFrontier ?? [] },
          candidate: priorParsed,
          servableModelIds,
        });
      } catch {
        canary = undefined; // best-effort confirmation; the rollback record is authoritative
      }
    }

    // Round 7 finding 2: terminal "breach" requires write AND reload AND CONFIRMATION (canary) — an
    // unconfirmed (or outright failed) revert is never finalized as if it had actually happened.
    const status: WatchdogRevertResult["status"] = !rollback.restoreWriteOk
      ? "unknown" // mirrors performRollback's own "UNKNOWN state, manual recovery required"
      : !rollback.reloadOk
        ? "restored-reload-failed"
        : canary?.ok === true
          ? "restored"
          : "restored-unconfirmed";
    const revert: WatchdogRevertResult = { status, rollback, canary };
    const confirmed = status === "restored";

    if (!confirmed) {
      // Failure-marked (never silently dropped) — status stays "reverting". Once this call's own
      // lease is released (by the caller's `finally`), the claim naturally goes stale, and the NEXT
      // run's recovery path re-examines this record from scratch (re-classifying superseded/
      // matches-snapshot/matches-candidate, never assuming the prior attempt's classification still
      // holds). Quarantine STILL applies (round 6: "the breach itself is the trigger; a failed
      // restore-write does not make the axis any MORE trustworthy") — an incomplete revert is not a
      // reason to leave the regressed axis eligible for further traffic while it retries.
      const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record, ` — revert attempt incomplete (${describeIncompleteRevert(rollback, canary)}); retrying next tick`);
      if (!dryRun) {
        // Round 9 finding 1: NOT a partial-restore attempt — clear any stale merge marker.
        markRevertAttemptFailed({
          dataDir: deps.dataDir,
          recordId: record.id,
          claimToken: lockToken,
          attemptAt: now,
          error: describeIncompleteRevert(rollback, canary),
          quarantineEntries,
          pendingMerge: null,
        });
      }
      return { claimed: true, action: "would-revert", revert, newStatus: "reverting", quarantined: breachingTaskTypes };
    }

    const newStatus: AdoptionWatchRecord["status"] = "breach";

    // Quarantine every breaching axis regardless of revert quality — the breach itself is the
    // trigger; a failed restore-write does not make the axis any MORE trustworthy. Written ONLY as
    // part of THIS finalize commit — "quarantine row written only on CAS win" (round 6 finding 2).
    const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record);

    if (!dryRun) {
      finalizeReverting({
        dataDir: deps.dataDir,
        recordId: record.id,
        claimToken: lockToken,
        newStatus,
        lastEvaluatedAt: now,
        quarantineEntries,
      });
    }

    return { claimed: true, action: "reverted", revert, newStatus, quarantined: breachingTaskTypes };
  } catch (err) {
    // Round 8 finding 5: a read error (EIO/EACCES) or malformed JSON anywhere above (the snapshot
    // file, the candidate-snapshot file, the live table) must fail-mark THIS record and retry later
    // — never throw past this function, which would abort the ENTIRE watch run and starve every
    // OTHER record this same run would otherwise have evaluated. Mirrors the ordinary
    // "incomplete revert" failure-mark path: status stays "reverting", never "superseded" (a
    // classification error is not evidence of anything, safe or otherwise) and never terminal.
    // Round 10 finding 2: PRESERVE whatever pending-merge marker this record entered the call with
    // (`enteringPendingMerge`) — round 9's version hard-cleared it here, which wiped a GENUINELY
    // still-valid "this is my own in-flight attempted merge" marker on nothing more than a
    // TRANSIENT read/parse error (e.g. a momentary EIO reading the snapshot file), losing the
    // retry-without-reclassifying guarantee item 1 exists to provide. The marker is cleared ONLY at
    // the specific point that PROVES (via a successful live-table read) the table no longer matches
    // it — never merely because this call happened to hit an unrelated, possibly-transient error.
    const message = err instanceof Error ? err.message : String(err);
    const quarantineEntries = quarantineEntriesFor(breachingTaskTypes, now, policy, record, ` — revert attempt failed with an unexpected error (${message}); retrying next tick`);
    if (!dryRun) {
      markRevertAttemptFailed({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockToken, attemptAt: now, error: message, quarantineEntries, pendingMerge: enteringPendingMerge });
    }
    return {
      claimed: true,
      action: "would-revert",
      revert: { status: "unknown" },
      newStatus: "reverting",
      quarantined: breachingTaskTypes,
      warning: `adoption-watchdog: record ${record.id} hit an unexpected error while classifying/restoring (${message}) — failure-marked and left retriable, not silently dropped.`,
    };
  }
}

/**
 * Round 6 finding 2 recovery: a `"reverting"` row whose claiming lease is no longer current means
 * the process that claimed it died mid-revert. Re-claims it under a FRESH lease (guarded by the
 * exact stale token observed — see `claimForReverting`), then resolves it by comparing the LIVE
 * table against the snapshot: if they already match (the revert write landed before the crash, just
 * never got finalized), resolve directly to `"breach"` without repeating the external action; if
 * not, retry the revert from scratch via the SAME `performRevertAndFinalize` used for a fresh claim.
 * Quarantines the record's FULL `changedTaskTypes` (conservative — the original per-metric breach
 * detail from the crashed attempt was never persisted, and over-quarantining a route that merely
 * shared an adoption with a genuinely bad one is the safe direction here).
 */
async function recoverStuckReverting(
  deps: WatchdogRunnerDeps,
  policy: WatchdogPolicyConfig,
  record: AdoptionWatchRecord,
  now: string,
  dryRun: boolean
): Promise<{ item: WatchRunReportItem; event: WatchdogEvent; warning?: string } | null> {
  let lockHandle: ReturnType<typeof acquireMutationLock> | null = null;
  try {
    lockHandle = acquireMutationLock(deps.dataDir);
  } catch (err) {
    if (!(err instanceof MutationLockBusyError)) throw err;
  }
  if (lockHandle === null) return null; // busy — leave the stuck row exactly as-is; try again next run

  try {
    // Round 9 follow-up (b): use the axes that ACTUALLY breached (persisted once, at the FIRST
    // "pending -> reverting" claim) — never broaden to the full `changedTaskTypes` on a "mixed axis"
    // adoption where only some of the adopted axes regressed. Falls back to the full set for a
    // legacy record that predates this field (the same conservative default this code always used).
    const breachingTaskTypes = record.breachedTaskTypes ?? record.changedTaskTypes;

    // Round 7 findings 1+2 + round 8 finding 5: delegate ENTIRELY to `performRevertAndFinalize` —
    // it performs the SAME three-way classification (matches-candidate / matches-snapshot /
    // superseded, refined per axis per round 8 finding 1), the SAME write-AND-reload-AND-confirm
    // gate, the SAME `record.snapshotPath === null` delete-and-reload handling (round 8 follow-up
    // b), and the SAME per-record error safety (round 8 finding 5) uniformly for both a first
    // attempt and a recovery retry — no separate read-and-branch needed here at all, and no
    // separate "no snapshot" shortcut that used to skip verification entirely.
    const outcome = await performRevertAndFinalize({
      deps,
      policy,
      record,
      breachingTaskTypes,
      now,
      lockToken: lockHandle.token,
      fromStatus: "reverting",
      dryRun,
    });
    const action = outcome.action;
    const revert = outcome.revert ?? { status: "unknown" };
    const newStatus = outcome.newStatus;
    const quarantined = outcome.quarantined;
    const warning = outcome.warning;

    const event: WatchdogEvent = {
      schemaVersion: 1,
      emittedAt: now,
      recordId: record.id,
      adoptedAt: record.adoptedAt,
      candidateHash: record.candidateHash,
      decisionRef: record.decisionRef,
      verdict: "breach",
      changedTaskTypes: record.changedTaskTypes,
      metricsBefore: [],
      metricsAfter: [],
      breaches: [],
      killSwitchActive: false,
      dryRun,
      action,
      revert,
      quarantined,
    };
    if (!dryRun) appendWatchdogEvent(deps.dataDir, event);

    return {
      item: {
        record: { ...record, status: newStatus, lastEvaluatedAt: now },
        evaluation: {
          verdict: "breach",
          windowComplete: true,
          elapsedHours: (Date.parse(now) - Date.parse(record.adoptedAt)) / (60 * 60 * 1000),
          totalPostAdoptionTasks: 0,
          perTaskType: [],
          evaluatedAt: now,
        },
        action,
        revert,
        quarantined,
      },
      event,
      warning,
    };
  } finally {
    lockHandle.release();
  }
}

export async function runAdoptionWatch(
  deps: WatchdogRunnerDeps,
  policy: WatchdogPolicyConfig = DEFAULT_WATCHDOG_POLICY,
  opts: { dryRun?: boolean } = {}
): Promise<WatchRunReport> {
  const dryRun = opts.dryRun ?? false;
  const now = deps.nowIso();
  const killSwitchActive = deps.killSwitchOn();
  const state = loadWatchdogState(deps.dataDir);
  const items: WatchRunReportItem[] = [];
  // Round 7 finding 1: non-fatal observability warnings (e.g. a "superseded" resolution) collected
  // across the whole run and surfaced on the report — merged into `AutonomyTickReport.warnings` by
  // `runAutonomyTick`, never gating any in-tick decision on their own.
  const warnings: string[] = [];

  for (const record of state.records) {
    if (record.status === "reverting") {
      // Round 6 finding 2 recovery: is the claiming lease still current?
      if (record.revertingToken !== undefined && isRevertingClaimStillCurrent(deps.dataDir, record.revertingToken)) {
        continue; // genuinely in-flight elsewhere right now — do not race it
      }
      if (dryRun) continue; // recovery is itself a mutation; dry-run never performs it
      if (killSwitchActive) {
        // Round 8 finding 3: a stuck "reverting" row's claiming lease has gone stale — ordinarily
        // this triggers reclaim-and-execute recovery, but that IS a mutation (a re-claim, a
        // possible table write, a possible quarantine write), exactly what the kill switch exists to
        // suppress. Mirrors the fresh-breach path's own kill-switch contract exactly: evaluate and
        // RECORD (an event, a report item) but perform NO reclaim, NO table mutation, NO quarantine
        // write. The record stays "reverting" untouched — it resumes once the switch clears.
        const event: WatchdogEvent = {
          schemaVersion: 1,
          emittedAt: now,
          recordId: record.id,
          adoptedAt: record.adoptedAt,
          candidateHash: record.candidateHash,
          decisionRef: record.decisionRef,
          verdict: "breach",
          changedTaskTypes: record.changedTaskTypes,
          metricsBefore: [],
          metricsAfter: [],
          breaches: [],
          killSwitchActive: true,
          dryRun,
          action: "would-revert",
          quarantined: [],
        };
        appendWatchdogEvent(deps.dataDir, event);
        items.push({
          record,
          evaluation: {
            verdict: "breach",
            windowComplete: true,
            elapsedHours: (Date.parse(now) - Date.parse(record.adoptedAt)) / (60 * 60 * 1000),
            totalPostAdoptionTasks: 0,
            perTaskType: [],
            evaluatedAt: now,
          },
          action: "would-revert",
          quarantined: [],
        });
        continue;
      }
      const recovered = await recoverStuckReverting(deps, policy, record, now, dryRun);
      if (recovered) {
        items.push(recovered.item);
        if (recovered.warning) warnings.push(recovered.warning);
      }
      continue;
    }
    if (record.status !== "pending") continue; // already resolved — nothing further to do

    const baselineSinceIso = new Date(Date.parse(record.adoptedAt) - policy.windowHours * 60 * 60 * 1000).toISOString();
    const baseline = deps.queryGuardMetrics(record.changedTaskTypes, baselineSinceIso, record.adoptedAt);
    const current = deps.queryGuardMetrics(record.changedTaskTypes, record.adoptedAt, now);

    const evaluation = evaluateWatchWindow({
      adoptedAt: record.adoptedAt,
      nowIso: now,
      changedTaskTypes: record.changedTaskTypes,
      baseline,
      current,
      policy,
    });

    record.lastEvaluatedAt = now;

    let action: WatchdogAction = "none";
    let revert: WatchdogRevertResult | undefined;
    let quarantined: string[] = [];
    // Round 5 finding 3: the in-memory `record.status` mutations below still drive the RETURNED
    // report/items (unchanged shape) and the `WatchdogEvent` written below, but the DURABLE
    // resolution is committed via `commitRecordResolution` (scoped, guarded) — never a bulk
    // `saveWatchdogState` of the whole array at the end of this loop.
    let newStatus: AdoptionWatchRecord["status"] = record.status;
    let quarantineEntriesToCommit: QuarantineRecord[] | undefined;
    // Set true only by the branch that commits WHILE STILL HOLDING the mutation lease (below) — the
    // fencing check (round 5 finding 1) is meaningless once the lease has already been released, so
    // that branch's commit must happen BEFORE its own `lockHandle.release()`, not after this loop
    // iteration's generic post-decision commit further down.
    let committedUnderLock = false;

    if (evaluation.verdict === "healthy") {
      newStatus = "healthy";
    } else if (evaluation.verdict === "inconclusive") {
      newStatus = "inconclusive";
    } else if (evaluation.verdict === "breach") {
      const breachingTaskTypes = evaluation.perTaskType
        .filter((t): t is Extract<TaskTypeVerdict, { status: "breach" }> => t.status === "breach")
        .map((t) => t.taskType);

      if (dryRun || killSwitchActive) {
        // Report-only: detected and (outside dry-run) recorded, but no mutation — see the module
        // header on why the record stays `pending` under a kill switch rather than resolving.
        action = "would-revert";
      } else {
        // Round 4 finding 3 (+ round 5 finding 1's fencing, + round 6 finding 2's CAS-before-act):
        // the revert WRITE must run under the SAME exclusive mutation lease every other table
        // mutation takes — otherwise a breach revert here could race a concurrent write exactly
        // like the pre-round-4 file-CAS bugs did. `performRevertAndFinalize` CAS-claims the record
        // (`pending -> reverting`, stamping this lease's token) BEFORE attempting the external
        // `manualRollback` action — never the reverse — so a crash mid-revert leaves an honest
        // `"reverting"` trace for the NEXT run's recovery path, rather than silently looking
        // untouched and inviting a double revert.
        //
        // Round 8 follow-up (b): this now ALSO covers `record.snapshotPath === null` (first-ever
        // adoption) — the old separate "no snapshot, no lease needed" branch never actually undid
        // the bad table at all (it just called itself "reverted"). `performRevertAndFinalize`'s own
        // `snapshotPath === null` handling now genuinely deletes+reloads+confirms, which DOES need
        // the lease like every other table mutation.
        let lockHandle: ReturnType<typeof acquireMutationLock> | null = null;
        try {
          lockHandle = acquireMutationLock(deps.dataDir);
        } catch (err) {
          if (!(err instanceof MutationLockBusyError)) throw err;
        }

        if (lockHandle === null) {
          // Busy: do NOT race the concurrent mutation. Leave the record "pending" (never resolve it
          // to "breach") — a genuine breach's underlying metrics do not self-heal, so the very next
          // watch run re-evaluates this record from scratch and reverts it then.
          revert = { status: "skipped-lock-busy" };
          action = "would-revert";
        } else {
          try {
            const outcome = await performRevertAndFinalize({
              deps,
              policy,
              record,
              breachingTaskTypes,
              now,
              lockToken: lockHandle.token,
              fromStatus: "pending",
              dryRun,
            });
            action = outcome.action;
            revert = outcome.revert;
            newStatus = outcome.newStatus;
            quarantined = outcome.quarantined;
            if (outcome.warning) warnings.push(outcome.warning);
            // Finalize already committed (fenced, WHILE holding this lease) inside
            // performRevertAndFinalize — never re-commit via the generic path below.
            committedUnderLock = true;
          } finally {
            lockHandle.release();
          }
        }
      }
    }
    // evaluation.verdict === "pending": no state transition, no action — keep watching.

    record.status = newStatus; // keep the in-memory copy consistent with what was (or is about to be) committed
    if (!dryRun && !committedUnderLock) {
      // The locked branch above already committed (WHILE holding its lease) before releasing it —
      // every other path (healthy/inconclusive/no-snapshot-breach/pending) never took a lease at
      // all, so it commits here, unfenced (no table write to protect; SQLite's own transaction is
      // the only serialization this path needs).
      commitRecordResolution({
        dataDir: deps.dataDir,
        recordId: record.id,
        newStatus,
        lastEvaluatedAt: now,
        quarantineEntries: quarantineEntriesToCommit,
      });
      // A `false` return means another process resolved this exact record first (extremely rare —
      // watch runs are typically single-flight via cron); we do not retry or crash — if we performed
      // a real revert action above, that action itself is idempotent-safe (a redundant rollback to
      // the same snapshot), and the WINNING commit is the authoritative durable resolution either way.
    }

    const event: WatchdogEvent = {
      schemaVersion: 1,
      emittedAt: now,
      recordId: record.id,
      adoptedAt: record.adoptedAt,
      candidateHash: record.candidateHash,
      decisionRef: record.decisionRef,
      verdict: evaluation.verdict,
      changedTaskTypes: record.changedTaskTypes,
      metricsBefore: baseline,
      metricsAfter: current,
      breaches: evaluation.perTaskType.flatMap((t) =>
        t.status === "breach" ? t.breaches.map((b) => ({ ...b, taskType: t.taskType })) : []
      ),
      killSwitchActive,
      dryRun,
      action,
      revert,
      quarantined,
    };
    if (!dryRun) appendWatchdogEvent(deps.dataDir, event);

    items.push({ record, evaluation, action, revert, quarantined });
  }

  return { evaluatedAt: now, dryRun, killSwitchActive, items, warnings };
}
