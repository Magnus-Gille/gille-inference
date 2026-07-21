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
  runCanary,
  type AdoptDeps,
  type RollbackRecord,
  type CanaryOutcome,
} from "./routing-lifecycle.js";
import {
  acquireMutationLock,
  MutationLockBusyError,
  MutationLockStaleError,
  mutationLockDbPath,
  ensureLeaseTables,
  isLeaseCurrent,
} from "./mutation-lock.js";
import { tableContentHash } from "./evidence-identity.js";
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
   */
  status: "pending" | "reverting" | "healthy" | "breach" | "inconclusive";
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
}

export function watchdogPaths(dataDir: string): WatchdogPaths {
  const root = join(dataDir, "adoption-watchdog");
  return {
    root,
    statePath: join(root, "state.json"),
    quarantinePath: join(root, "quarantine.json"),
    eventsPath: join(root, "events.jsonl"),
    snapshotsDir: join(root, "snapshots"),
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
    (id, adopted_at, candidate_hash, decision_ref, approved_by, changed_task_types, snapshot_path, status, last_evaluated_at, provenance, intent_id, reverting_token, reverting_at)
  VALUES
    (@id, @adopted_at, @candidate_hash, @decision_ref, @approved_by, @changed_task_types, @snapshot_path, @status, @last_evaluated_at, @provenance, @intent_id, @reverting_token, @reverting_at)
  ON CONFLICT(id) DO UPDATE SET
    adopted_at = excluded.adopted_at, candidate_hash = excluded.candidate_hash, decision_ref = excluded.decision_ref,
    approved_by = excluded.approved_by, changed_task_types = excluded.changed_task_types, snapshot_path = excluded.snapshot_path,
    status = excluded.status, last_evaluated_at = excluded.last_evaluated_at, provenance = excluded.provenance, intent_id = excluded.intent_id,
    reverting_token = excluded.reverting_token, reverting_at = excluded.reverting_at
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
  status: z.enum(["pending", "reverting", "healthy", "breach", "inconclusive"]),
  lastEvaluatedAt: z.string().min(1).nullable(),
  provenance: adoptionProvenanceSchema.optional(),
  intentId: z.string().min(1).optional(),
  revertingToken: z.number().optional(),
  revertingAt: z.string().min(1).optional(),
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
        reverting_at       TEXT
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
  const { snapshotsDir } = watchdogPaths(p.dataDir);
  const id = randomUUID();
  let snapshotPath: string | null = null;
  if (p.priorRaw !== null) {
    mkdirSync(snapshotsDir, { recursive: true });
    const abs = join(snapshotsDir, `${id}.json`);
    writeFileSync(abs, p.priorRaw, "utf8");
    snapshotPath = abs;
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

export type WatchdogAction = "none" | "would-revert" | "reverted";

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
    | "skipped-lock-busy";
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
}): boolean {
  const db = openWatchdogDb(p.dataDir);
  try {
    const commit = db.transaction((): boolean => {
      const result =
        p.fromStatus === "pending"
          ? db
              .prepare(`UPDATE adoption_watch_records SET status = 'reverting', reverting_token = ?, reverting_at = ? WHERE id = ? AND status = 'pending'`)
              .run(p.leaseToken, p.nowIso, p.recordId)
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
      const result = db
        .prepare(
          `UPDATE adoption_watch_records SET status = ?, reverting_token = NULL, reverting_at = NULL, last_evaluated_at = ? WHERE id = ? AND status = 'reverting' AND reverting_token = ?`
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
 * Round 6 finding 2: performs the external rollback action for ONE breaching record, but ONLY after
 * winning the CAS claim (`fromStatus -> "reverting"`) — "watchdog acts before claiming" is exactly
 * the bug this closes: the CAS now happens BEFORE `manualRollback`, not after. A stale-lease refusal
 * inside the fenced write (round 6 finding 1: "a stale holder must never roll back") leaves the
 * record claimed-but-unresolved (`"reverting"`, never finalized) for the NEXT run's recovery path to
 * pick up — never finalized as if the revert had actually happened.
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
}> {
  const { deps, policy, record, breachingTaskTypes, now, lockToken, fromStatus, dryRun } = p;

  const claimed = claimForReverting({
    dataDir: deps.dataDir,
    recordId: record.id,
    fromStatus,
    expectedRevertingToken: record.revertingToken,
    leaseToken: lockToken,
    nowIso: now,
  });
  if (!claimed) {
    // Someone else (another process, or this same record having already moved on) beat us to it.
    return { claimed: false, action: "none", newStatus: record.status, quarantined: [] };
  }

  const snapshotRaw = readFileSync(record.snapshotPath as string, "utf8");
  // Round 6 finding 1: fence the actual rollback write with THIS SAME lease token.
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
    // the NEXT watch run's recovery path detects the stale claim and re-examines it.
    return {
      claimed: true,
      action: "would-revert",
      revert: { status: "unknown", rollback },
      newStatus: "reverting",
      quarantined: [],
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

  const status: WatchdogRevertResult["status"] = !rollback.restoreWriteOk
    ? "unknown" // mirrors performRollback's own "UNKNOWN state, manual recovery required"
    : !rollback.reloadOk
      ? "restored-reload-failed"
      : "restored";
  const revert: WatchdogRevertResult = { status, rollback, canary };
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
): Promise<{ item: WatchRunReportItem; event: WatchdogEvent } | null> {
  let lockHandle: ReturnType<typeof acquireMutationLock> | null = null;
  try {
    lockHandle = acquireMutationLock(deps.dataDir);
  } catch (err) {
    if (!(err instanceof MutationLockBusyError)) throw err;
  }
  if (lockHandle === null) return null; // busy — leave the stuck row exactly as-is; try again next run

  try {
    const snapshotRaw = record.snapshotPath ? readFileSync(record.snapshotPath, "utf8") : null;
    const liveRaw = (() => {
      try {
        return deps.adoptDeps.readTable(deps.adoptDeps.tablePath);
      } catch {
        return null;
      }
    })();
    const alreadyReverted = snapshotRaw !== null && tableContentHash(liveRaw) === tableContentHash(snapshotRaw);
    const breachingTaskTypes = record.changedTaskTypes;

    let action: WatchdogAction;
    let revert: WatchdogRevertResult;
    let newStatus: AdoptionWatchRecord["status"];
    let quarantined: string[] = [];

    if (snapshotRaw === null) {
      // No snapshot to compare against (first-ever adoption) — nothing to verify or retry; resolve
      // directly, matching the ordinary `snapshotPath === null` path's own handling.
      const claimed = claimForReverting({
        dataDir: deps.dataDir,
        recordId: record.id,
        fromStatus: "reverting",
        expectedRevertingToken: record.revertingToken,
        leaseToken: lockHandle.token,
        nowIso: now,
      });
      action = "reverted";
      revert = { status: "skipped-no-snapshot" };
      newStatus = "breach";
      if (claimed && !dryRun) {
        const quarantineEntries = quarantineEntriesFor(
          breachingTaskTypes,
          now,
          policy,
          record,
          " — recovered after a crashed revert attempt"
        );
        finalizeReverting({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockHandle.token, newStatus, lastEvaluatedAt: now, quarantineEntries });
      }
    } else if (alreadyReverted) {
      const claimed = claimForReverting({
        dataDir: deps.dataDir,
        recordId: record.id,
        fromStatus: "reverting",
        expectedRevertingToken: record.revertingToken,
        leaseToken: lockHandle.token,
        nowIso: now,
      });
      action = "reverted";
      revert = { status: "restored" };
      newStatus = "breach";
      if (claimed && !dryRun) {
        const quarantineEntries = quarantineEntriesFor(
          breachingTaskTypes,
          now,
          policy,
          record,
          " — recovered after a crashed revert attempt; the live table already matched the pre-breach snapshot"
        );
        finalizeReverting({ dataDir: deps.dataDir, recordId: record.id, claimToken: lockHandle.token, newStatus, lastEvaluatedAt: now, quarantineEntries });
      }
    } else {
      // Not yet reverted — retry the revert from scratch, re-claiming from "reverting".
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
      action = outcome.action;
      revert = outcome.revert ?? { status: "unknown" };
      newStatus = outcome.newStatus;
      quarantined = outcome.quarantined;
    }

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

  for (const record of state.records) {
    if (record.status === "reverting") {
      // Round 6 finding 2 recovery: is the claiming lease still current?
      if (record.revertingToken !== undefined && isRevertingClaimStillCurrent(deps.dataDir, record.revertingToken)) {
        continue; // genuinely in-flight elsewhere right now — do not race it
      }
      if (dryRun) continue; // recovery is itself a mutation; dry-run never performs it
      const recovered = await recoverStuckReverting(deps, policy, record, now, dryRun);
      if (recovered) items.push(recovered.item);
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
      } else if (record.snapshotPath === null) {
        // No table mutation is involved in this branch (nothing to restore) — no mutation LEASE is
        // needed either (fixed round 5: the round-4 comment here claimed the lock was taken but the
        // code never actually acquired one). The record-status + quarantine-row commit is still
        // atomic: both land in ONE SQLite transaction via `commitRecordResolution`.
        newStatus = "breach";
        revert = { status: "skipped-no-snapshot" };
        action = "reverted";
        quarantineEntriesToCommit = breachingTaskTypes.map((t) => ({
          taskType: t,
          quarantinedAt: now,
          reason: `guard-metric breach on adoption ${record.candidateHash} (${record.decisionRef})`,
          cooldownUntil: new Date(Date.parse(now) + policy.cooldownHours * 60 * 60 * 1000).toISOString(),
          requiredMarginDelta: policy.requiredMarginDelta,
          baselinePassRateAtQuarantine: readPassRateForTaskType(record.snapshotPath, t),
          clearedAt: null,
        }));
        quarantined = breachingTaskTypes;
      } else {
        // Round 4 finding 3 (+ round 5 finding 1's fencing, + round 6 finding 2's CAS-before-act):
        // the revert WRITE must run under the SAME exclusive mutation lease every other table
        // mutation takes — otherwise a breach revert here could race a concurrent write exactly
        // like the pre-round-4 file-CAS bugs did. `performRevertAndFinalize` CAS-claims the record
        // (`pending -> reverting`, stamping this lease's token) BEFORE attempting the external
        // `manualRollback` action — never the reverse — so a crash mid-revert leaves an honest
        // `"reverting"` trace for the NEXT run's recovery path, rather than silently looking
        // untouched and inviting a double revert.
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

  return { evaluatedAt: now, dryRun, killSwitchActive, items };
}
