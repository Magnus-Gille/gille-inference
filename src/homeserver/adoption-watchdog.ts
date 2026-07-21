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
  status: "pending" | "healthy" | "breach" | "inconclusive";
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
    (id, adopted_at, candidate_hash, decision_ref, approved_by, changed_task_types, snapshot_path, status, last_evaluated_at, provenance, intent_id)
  VALUES
    (@id, @adopted_at, @candidate_hash, @decision_ref, @approved_by, @changed_task_types, @snapshot_path, @status, @last_evaluated_at, @provenance, @intent_id)
  ON CONFLICT(id) DO UPDATE SET
    adopted_at = excluded.adopted_at, candidate_hash = excluded.candidate_hash, decision_ref = excluded.decision_ref,
    approved_by = excluded.approved_by, changed_task_types = excluded.changed_task_types, snapshot_path = excluded.snapshot_path,
    status = excluded.status, last_evaluated_at = excluded.last_evaluated_at, provenance = excluded.provenance, intent_id = excluded.intent_id
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

/**
 * One-time, idempotent migration of the legacy JSON state/quarantine files into SQLite, run the
 * first time this db file is opened for THIS dataDir (checked via "table is empty" — a real
 * production install has exactly the records it has ever recorded, so an empty table unambiguously
 * means "never migrated yet", and every subsequent open is a fast no-op COUNT query). Best-effort:
 * a corrupt/unreadable legacy file is logged-and-skipped here (this is a migration convenience, not
 * the authoritative read path — `loadWatchdogState`'s CALLERS have never depended on the legacy
 * JSON file directly once this module owns storage), never allowed to block startup.
 */
function migrateLegacyJsonIfNeeded(db: Database.Database, dataDir: string): void {
  const { statePath, quarantinePath } = watchdogPaths(dataDir);

  const recordCount = (db.prepare(`SELECT COUNT(*) AS n FROM adoption_watch_records`).get() as { n: number }).n;
  if (recordCount === 0 && existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as WatchdogState;
      if (Array.isArray(parsed.records) && parsed.records.length > 0) {
        const insert = db.prepare(UPSERT_RECORD_SQL);
        const importAll = db.transaction((records: AdoptionWatchRecord[]) => {
          for (const r of records) insert.run(recordToRowParams(r));
        });
        importAll.immediate(parsed.records);
      }
    } catch {
      // Best-effort: an unreadable legacy file is not migrated, but does not block operation either.
    }
  }

  const quarantineCount = (db.prepare(`SELECT COUNT(*) AS n FROM quarantine_entries`).get() as { n: number }).n;
  if (quarantineCount === 0 && existsSync(quarantinePath)) {
    try {
      const parsed = JSON.parse(readFileSync(quarantinePath, "utf8")) as QuarantineState;
      if (parsed.byTaskType && typeof parsed.byTaskType === "object") {
        const entries = Object.values(parsed.byTaskType);
        if (entries.length > 0) {
          const insert = db.prepare(UPSERT_QUARANTINE_SQL);
          const importAll = db.transaction((rows: QuarantineRecord[]) => {
            for (const r of rows) insert.run(quarantineToRowParams(r));
          });
          importAll.immediate(entries);
        }
      }
    } catch {
      // Best-effort, same rationale as above.
    }
  }
}

function openWatchdogDb(dataDir: string): Database.Database {
  const path = mutationLockDbPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
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
      intent_id          TEXT
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
  `);
  migrateLegacyJsonIfNeeded(db, dataDir);
  return db;
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
 * Bulk upsert-all of `state.records` — a convenience setter for tests and any caller that
 * legitimately wants to set the whole state at once (e.g. seeding a fixture). NOT used by this
 * module's own production hot paths (`recordAdoptionForWatch`, `runAdoptionWatch`) — those commit
 * only the ONE row they actually own, which is what closes the lost-update race this migration
 * fixes (round 5 finding 3). Still transactional, so a single call is atomic across every record.
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

/** Bulk upsert-all — same convenience-setter role as `saveWatchdogState` above. */
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
        // Round 4 finding 3 (+ round 5 finding 1's fencing): the revert WRITE must run under the
        // SAME exclusive mutation lease every other table mutation takes (a manual `adopt`, or this
        // same tick's own autonomous adopt attempt) — otherwise a breach revert here could race a
        // concurrent write exactly like the pre-round-4 file-CAS bugs did. The record-status +
        // quarantine commit below is fenced by THIS SAME token, verified again immediately before it
        // lands (finding 1's "enforced at the resource", not only at acquire).
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
            const snapshotRaw = readFileSync(record.snapshotPath, "utf8");
            const rollback = await manualRollback({
              deps: deps.adoptDeps,
              snapshotRaw,
              reason:
                `adoption-watchdog: guard-metric breach on [${breachingTaskTypes.join(", ")}] within the ` +
                `post-adoption watch window (candidateHash=${record.candidateHash}, decisionRef=${record.decisionRef})`,
            });

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
            revert = { status, rollback, canary };
            action = "reverted";
            newStatus = "breach";

            // Quarantine every breaching axis regardless of revert quality — the breach itself is
            // the trigger; a failed restore-write does not make the axis any MORE trustworthy.
            // Committed in the SAME transaction as the record-status update, fenced by this token.
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

            // Round 5 finding 1: commit WHILE STILL HOLDING the lease — fencing the token against
            // this SAME lease that is about to be released would be meaningless if checked after.
            if (!dryRun) {
              commitRecordResolution({
                dataDir: deps.dataDir,
                recordId: record.id,
                newStatus,
                lastEvaluatedAt: now,
                quarantineEntries: quarantineEntriesToCommit,
                leaseToken: lockHandle.token,
              });
            }
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
