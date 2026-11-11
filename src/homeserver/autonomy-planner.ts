/** Pure routing review and per-axis planning, shared by legacy and shadow ticks. */
import { buildDecisionArtifact, type RoutingDecisionArtifact } from "./routing-lifecycle.js";
import type { RoutingTableDoc, GeneratedRoutingEntry } from "./routing-table-generator.js";
import type { DiffableRoutingTable, DiffableRoutingEntry } from "./routing-table-diff.js";
import { evaluateQuarantineGate, type AdoptionWatchRecord } from "./adoption-watchdog.js";
import { wilsonInterval } from "./calibration-metrics.js";
import type { CalibrationGateDecision } from "./calibration-gate.js";

export type AutonomyTier = 0 | 1 | 2 | 3;

/**
 * Prefix for the `approvedBy` DISPLAY string recorded on every autonomous adoption —
 * `${prefix}${tier}`, e.g. `autonomy-controller:tier1`. Human-legible only (Sol-xhigh review
 * finding 7): risk-budget/cooldown/revert-rate accounting NEVER parses this string — it reads the
 * structured `AdoptionWatchRecord.provenance` field instead (see `isAutonomousRecord`), because
 * `approvedBy` is free text an operator's manual `adopt --approved-by` invocation could type
 * identically, which would otherwise silently spoof the autonomous-adoption count.
 */
export const AUTONOMY_APPROVER_PREFIX = "autonomy-controller:tier";

/**
 * Hard-coded deny-list of task-type routes NEVER auto-adopted, regardless of tier or predicates
 * (design doc §5). Empty by default — no currently-routed task type represents owner-priority
 * policy or verifier-gate parameters (those live in separate config files this controller cannot
 * write at all; see the module header). Grow this ONLY with a reviewed, deliberate addition, the
 * same discipline routing-table-generator.ts's `MODEL_META`/`MODEL_FAMILY` maps use.
 */
export const PROTECTED_ROUTES: ReadonlySet<string> = new Set<string>([]);

export interface AutonomyPolicyConfig {
  /** δ: minimum Wilson-CI-lower-bound margin the challenger must clear over the incumbent's
   *  recorded passRate. Default 0.05 (5pp), per the design doc's proposed default. */
  marginDelta: number;
  /** N: minimum challenger sample size (attempts) before an axis is statistically evaluable at
   *  all. The design doc names the concept ("n>=N") without fixing a default; 30 is a conventional,
   *  documented floor for a binomial-proportion CI to be informative — tune at deploy time. */
  minSampleSize: number;
  /** z for the Wilson interval (calibration-metrics.ts's `wilsonInterval`) — default 1.96 (~95%),
   *  matching every other #6/#48 gate in this codebase. */
  confidenceZ: number;
  /** K: max autonomous adoptions per rolling risk-budget window. Default 3/week. */
  maxAdoptionsPerWindow: number;
  /** Rolling window (hours) the risk budget is counted over. Default 168h (7 days). */
  riskBudgetWindowHours: number;
  /** Per-route cooldown (hours) after an autonomous adoption of that SAME axis, before it may be
   *  autonomously adopted again. Default 24h. */
  perRouteCooldownHours: number;
  /** C1: consecutive healthy cycles required to unlock the next tier. Default 10. */
  tier1UnlockCycles: number;
  /** r: max Tier-1 revert rate (breaches / autonomous adoptions) permitted when unlocking Tier 2.
   *  Default 0.2 (20%). */
  tier2RevertRateMax: number;
  /** Hard-coded protected routes — see `PROTECTED_ROUTES`. Overridable only for tests; production
   *  callers should pass the exported constant. */
  protectedRoutes: ReadonlySet<string>;
}

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicyConfig = {
  marginDelta: 0.05,
  minSampleSize: 30,
  confidenceZ: 1.96,
  maxAdoptionsPerWindow: 3,
  riskBudgetWindowHours: 7 * 24,
  perRouteCooldownHours: 24,
  tier1UnlockCycles: 10,
  tier2RevertRateMax: 0.2,
  protectedRoutes: PROTECTED_ROUTES,
};

// Legacy ambiguous provenance still consumes ceilings; explicit manual provenance does not.
function countsTowardRiskBudget(record: Pick<AdoptionWatchRecord, "provenance" | "approvedBy">): boolean {
  if (record.provenance?.kind === "autonomy") return true;
  if (record.provenance?.kind === "manual") return false;
  return record.approvedBy.startsWith(AUTONOMY_APPROVER_PREFIX);
}

export interface AxisEvaluation {
  taskType: string;
  /** True iff this axis's route change survives regeneration with organic-judge evidence
   *  excluded (routing-lifecycle.ts's own lineage classification) — Tier 1 only auto-adopts these. */
  verifierBacked: boolean;
  validationOk: boolean;
  validationIssues: string[];
  statisticallySufficient: boolean;
  ciLower: number | null;
  protectedRoute: boolean;
  quarantined: boolean;
  quarantineReason?: string;
  cooldownActive: boolean;
  cooldownUntil?: string;
  riskBudgetAvailable: boolean;
  /** All predicates AND the current tier's rule pass, AND (when this axis was actually attempted)
   *  the adopt-time recheck(s) — organic-gate recheck (finding 6), live-table-hash check (finding
   *  1) — also passed. False whenever this axis did not end up adopted, for any reason. */
  eligible: boolean;
  /** True iff this axis was the ONE this tick actually attempted to adopt (finding 3 — at most one
   *  axis is ever attempted per tick). An eligible-but-not-attempted axis (kill switch, dry run, or
   *  another axis was already chosen this tick) has `attempted: false`. */
  attempted: boolean;
  /** Human-legible reasons for every predicate/recheck that failed (empty when `eligible`). */
  reasons: string[];
}

export interface AxisEvidenceInputs {
  challengerAttempts: number;
  /** The candidate's own recorded passRate for this axis (routing-table-generator.ts's rounded
   *  `successRate`) — reused verbatim as wilsonInterval's numerator source, never re-derived from a
   *  second ledger query. */
  challengerPassRate: number;
  /** The CURRENTLY ADOPTED table's recorded passRate for this axis, or null when there is no
   *  incumbent (a brand-new task type / first-ever route) — treated as baseline 0 (see
   *  `evaluateStatisticalSufficiency`'s doc comment). */
  incumbentPassRate: number | null;
}

export interface StatisticalSufficiencyResult {
  sufficient: boolean;
  ciLower: number | null;
  detail: string;
}

/**
 * PURE. The single statistical-sufficiency predicate every changed axis is evaluated against:
 * the challenger needs >= N attempts (else there is not enough evidence to compute an informative
 * interval at all) and its Wilson-CI lower bound (calibration-metrics.ts, the SAME formula #48's
 * anchored-calibration.ts already uses for its own conservative bound) must beat the incumbent's
 * recorded passRate by at least δ. A `null` incumbent (no prior adopted route for this task type)
 * is treated as baseline 0 — "no local capability was ever measured here" is a legitimate zero, not
 * a missing value to fail closed on; the challenger still has to clear its OWN CI-lower-bound >= δ
 * to pass, so a thin/lucky brand-new route cannot slip through unmeasured.
 */
export function evaluateStatisticalSufficiency(
  ev: AxisEvidenceInputs,
  policy: Pick<AutonomyPolicyConfig, "marginDelta" | "minSampleSize" | "confidenceZ">
): StatisticalSufficiencyResult {
  if (ev.challengerAttempts < policy.minSampleSize) {
    return {
      sufficient: false,
      ciLower: null,
      detail: `challenger has ${ev.challengerAttempts} attempt(s) — below the minimum sample size N=${policy.minSampleSize}`,
    };
  }
  const numerator = Math.round(ev.challengerPassRate * ev.challengerAttempts);
  const { ciLower } = wilsonInterval(numerator, ev.challengerAttempts, policy.confidenceZ);
  if (ciLower === null) {
    return { sufficient: false, ciLower: null, detail: "no confidence interval computable (zero denominator)" };
  }
  const incumbent = ev.incumbentPassRate ?? 0;
  const margin = ciLower - incumbent;
  const sufficient = margin >= policy.marginDelta;
  return {
    sufficient,
    ciLower,
    detail: sufficient
      ? `CI lower bound ${ciLower.toFixed(3)} beats incumbent ${incumbent.toFixed(3)} by ${margin.toFixed(3)} (>= δ=${policy.marginDelta})`
      : `CI lower bound ${ciLower.toFixed(3)} vs incumbent ${incumbent.toFixed(3)} — margin ${margin.toFixed(3)} < required δ=${policy.marginDelta}`,
  };
}

// ─── Risk budget + per-route cooldown (reuses adoption-watchdog's durable records — no new ledger) ──

export interface RiskBudgetStatus {
  used: number;
  remaining: number;
  windowHours: number;
}

/**
 * PURE. Counts prior AUTONOMOUS adoptions — the RESTRICTIVE `countsTowardRiskBudget` predicate
 * (round 3 finding 6: a legacy/ambiguous record still counts here, never `approvedBy` string
 * parsing ALONE, finding 7) — within the trailing risk-budget window from the SAME durable
 * `AdoptionWatchRecord[]` issue #47 already persists for every adoption — no second risk-budget
 * ledger is invented.
 */
export function computeRiskBudgetStatus(
  records: readonly AdoptionWatchRecord[],
  nowIso: string,
  policy: Pick<AutonomyPolicyConfig, "maxAdoptionsPerWindow" | "riskBudgetWindowHours">
): RiskBudgetStatus {
  const nowMs = Date.parse(nowIso);
  const windowStartMs = nowMs - policy.riskBudgetWindowHours * 60 * 60 * 1000;
  const used = records.filter((r) => {
    if (!countsTowardRiskBudget(r)) return false;
    const t = Date.parse(r.adoptedAt);
    return t >= windowStartMs && t <= nowMs;
  }).length;
  return { used, remaining: Math.max(0, policy.maxAdoptionsPerWindow - used), windowHours: policy.riskBudgetWindowHours };
}

export interface RouteCooldownStatus {
  active: boolean;
  until?: string;
}

/** PURE. An axis is on cooldown until `perRouteCooldownHours` after its MOST RECENT autonomous
 *  adoption (RESTRICTIVE `countsTowardRiskBudget` predicate — same direction as the risk budget) —
 *  same durable records, no separate cooldown store. */
export function routeCooldownActive(
  records: readonly AdoptionWatchRecord[],
  taskType: string,
  nowIso: string,
  policy: Pick<AutonomyPolicyConfig, "perRouteCooldownHours">
): RouteCooldownStatus {
  const relevant = records.filter((r) => countsTowardRiskBudget(r) && r.changedTaskTypes.includes(taskType));
  if (relevant.length === 0) return { active: false };
  const latest = relevant.reduce((a, b) => (Date.parse(a.adoptedAt) > Date.parse(b.adoptedAt) ? a : b));
  const untilMs = Date.parse(latest.adoptedAt) + policy.perRouteCooldownHours * 60 * 60 * 1000;
  const until = new Date(untilMs).toISOString();
  return { active: Date.parse(nowIso) < untilMs, until };
}

// ─── Per-axis candidate/baseline isolation ("one axis per change") ───────────────

export interface AdoptedRawEntry {
  model: string | null;
  verdict: string;
  attempts: number;
  passRate?: number;
  tokPerSec?: number | null;
}

function revertEntryFor(adoptedRaw: Record<string, AdoptedRawEntry | undefined>, taskType: string): AdoptedRawEntry {
  const a = adoptedRaw[taskType];
  if (a) return a;
  // No adopted baseline exists for this task type at all (a brand-new route) — the neutral
  // "not yet adopted" stub, matching routing-table-generator.ts's own fail-safe default.
  return { model: null, verdict: "escalate-frontier", attempts: 0, passRate: 0, tokPerSec: null };
}

/**
 * PURE. Builds a single-axis candidate + a MATCHING synthetic baseline so `diffRoutingTables`
 * classifies every OTHER changed task type as `unchanged` — see the module header's "one axis per
 * adoption" section for why both sides must move together (a task type absent from the real
 * adopted table can never read as `unchanged` against that real table no matter what the candidate
 * says; advancing the baseline's copy of it to the identical revert value is what makes this work
 * for a brand-new route too, not just an existing one).
 */
export function buildAxisArtifactInputs(
  fullCandidate: RoutingTableDoc,
  adopted: DiffableRoutingTable | null,
  adoptedRaw: Record<string, AdoptedRawEntry | undefined>,
  axisTaskType: string,
  changedTaskTypes: readonly string[]
): { axisCandidate: RoutingTableDoc; axisBaseline: DiffableRoutingTable } {
  const routing: Record<string, GeneratedRoutingEntry> = { ...fullCandidate.routing };
  const baselineRouting: Record<string, DiffableRoutingEntry> = { ...(adopted?.routing ?? {}) };
  for (const taskType of changedTaskTypes) {
    if (taskType === axisTaskType) continue;
    const revert = revertEntryFor(adoptedRaw, taskType);
    routing[taskType] = {
      model: revert.model,
      verdict: revert.verdict as GeneratedRoutingEntry["verdict"],
      attempts: revert.attempts,
      passRate: revert.passRate ?? 0,
      tokPerSec: revert.tokPerSec ?? null,
      note: fullCandidate.routing[taskType]?.note,
    };
    baselineRouting[taskType] = { model: revert.model, verdict: revert.verdict, attempts: revert.attempts };
  }
  return {
    axisCandidate: { ...fullCandidate, routing },
    axisBaseline: { ...(adopted ?? {}), routing: baselineRouting },
  };
}

export interface AutonomyReviewInputs {
  candidate: RoutingTableDoc;
  deterministicCandidate: RoutingTableDoc;
  servableModelIds: string[] | null;
  requiredTaskTypes: string[];
  freshnessMaxAgeMs: number;
  /** The LIVE #6/#48 gate (calibration-gate-live.ts's `computeLiveCalibrationGate`) — the caller
   *  computes this fresh every tick; this module never accepts a stale/hand-supplied override. */
  calibrationGate: CalibrationGateDecision | null;
  policyEpochHash: string;
  expectedPolicyEpochHash: string;
}

export interface AutonomyReviewPlanInputs {
  fullArtifact: RoutingDecisionArtifact;
  review: AutonomyReviewInputs;
  adoptedTable: DiffableRoutingTable | null;
  adoptedRaw: Record<string, AdoptedRawEntry | undefined>;
  effectiveReviewGate: CalibrationGateDecision | null;
  tier: AutonomyTier;
  recordsAtStart: readonly AdoptionWatchRecord[];
  quarantine: Parameters<typeof evaluateQuarantineGate>[0]["quarantine"];
  now: string;
  policy: AutonomyPolicyConfig;
}

/** Builds the whole-table review before the runner decides whether axis state is needed. */
export function buildAutonomyReviewArtifact(
  review: AutonomyReviewInputs,
  adoptedTable: DiffableRoutingTable | null,
  effectiveReviewGate: CalibrationGateDecision | null,
  now: string,
) {
  return buildDecisionArtifact({
    candidate: review.candidate,
    deterministicCandidate: review.deterministicCandidate,
    adopted: adoptedTable,
    servableModelIds: review.servableModelIds,
    requiredTaskTypes: review.requiredTaskTypes,
    freshnessMaxAgeMs: review.freshnessMaxAgeMs,
    nowIso: now,
    calibrationGate: effectiveReviewGate,
    policyEpochHash: review.policyEpochHash,
    expectedPolicyEpochHash: review.expectedPolicyEpochHash,
  });
}

/** Reads only supplied snapshots; eligibility describes evidence, never mutation authority. */
export function planAutonomyReview(inputs: AutonomyReviewPlanInputs) {
  const { fullArtifact, review, adoptedTable, adoptedRaw, effectiveReviewGate, tier, recordsAtStart, quarantine, now, policy } = inputs;

  const changedTaskTypes = fullArtifact.diff.changes.filter((c) => c.kind !== "unchanged").map((c) => c.taskType);
  const noop = changedTaskTypes.length === 0;

  // 3. PREDICATES — an HONEST, full evaluation for EVERY changed axis, every tick (round 3 finding
  // 5: the round-1 fix hard-coded a placeholder for any axis after the first attempted one, both
  // fabricating its predicate results AND letting the lexically-first eligible axis starve every
  // other one forever). `eligibleTaskTypes` collects the subset whose predicates+tier genuinely
  // pass (kill switch/dry run aside — those never attempt anything, but still evaluate honestly).
  const axisEvalByType = new Map<string, AxisEvaluation>();
  const axisArtifactByType = new Map<string, RoutingDecisionArtifact>();
  const statDetailByType = new Map<string, string>();
  const eligibleTaskTypes: string[] = [];

  if (!noop) {
    const quarantineGate = evaluateQuarantineGate({
      changedTaskTypes,
      quarantine,
      nowIso: now,
      candidatePassRateByTaskType: Object.fromEntries(
        changedTaskTypes.map((t) => [t, review.candidate.routing[t]?.passRate ?? null])
      ),
    });
    const quarantineReasonByAxis = new Map(quarantineGate.blockedAxes.map((b) => [b.taskType, b.reason]));

    for (const taskType of changedTaskTypes) {
      const lineageEntry = fullArtifact.lineage.find((l) => l.taskType === taskType);
      const verifierBacked = !(lineageEntry?.organicJudgeDependent ?? false);

      const { axisCandidate, axisBaseline } = buildAxisArtifactInputs(
        review.candidate,
        adoptedTable,
        adoptedRaw,
        taskType,
        changedTaskTypes
      );
      const axisArtifact = buildDecisionArtifact({
        candidate: axisCandidate,
        deterministicCandidate: review.deterministicCandidate,
        adopted: axisBaseline,
        servableModelIds: review.servableModelIds,
        requiredTaskTypes: review.requiredTaskTypes,
        freshnessMaxAgeMs: review.freshnessMaxAgeMs,
        nowIso: now,
        calibrationGate: effectiveReviewGate,
        policyEpochHash: review.policyEpochHash,
        expectedPolicyEpochHash: review.expectedPolicyEpochHash,
      });
      axisArtifactByType.set(taskType, axisArtifact);

      const challengerEntry = review.candidate.routing[taskType];
      const incumbentEntry = adoptedRaw[taskType];
      const stat = evaluateStatisticalSufficiency(
        {
          challengerAttempts: challengerEntry?.attempts ?? 0,
          challengerPassRate: challengerEntry?.passRate ?? 0,
          incumbentPassRate: incumbentEntry?.passRate ?? null,
        },
        policy
      );
      statDetailByType.set(taskType, stat.detail);

      const protectedRoute = policy.protectedRoutes.has(taskType);
      const quarantineReason = quarantineReasonByAxis.get(taskType);
      const quarantined = quarantineReason !== undefined;
      const cooldown = routeCooldownActive(recordsAtStart, taskType, now, policy);
      const riskBudget = computeRiskBudgetStatus(recordsAtStart, now, policy);

      const reasons: string[] = [];
      if (!axisArtifact.validation.ok) {
        reasons.push(`validation: ${axisArtifact.validation.issues.map((i) => i.code).join(", ")}`);
      }
      if (!stat.sufficient) reasons.push(`insufficient-statistical-evidence: ${stat.detail}`);
      if (protectedRoute) reasons.push("protected-route: requires-owner (hard-coded deny list)");
      if (quarantined) reasons.push(`quarantined-axis: ${quarantineReason}`);
      if (cooldown.active) reasons.push(`route-cooldown-active: until ${cooldown.until}`);
      if (riskBudget.remaining <= 0) {
        reasons.push(
          `risk-budget-exhausted: ${riskBudget.used}/${policy.maxAdoptionsPerWindow} autonomous adoption(s) already used in the trailing ${policy.riskBudgetWindowHours}h window`
        );
      }

      const tierAllows = tier >= 2 ? true : tier === 1 ? verifierBacked : false;
      if (tier === 0) reasons.push("tier-0: propose-only (never auto-adopts)");
      else if (tier === 1 && !verifierBacked) reasons.push("tier-1: organic-judge-dependent changes require Tier 2");

      const predicatesPass =
        axisArtifact.validation.ok &&
        stat.sufficient &&
        !protectedRoute &&
        !quarantined &&
        !cooldown.active &&
        riskBudget.remaining > 0 &&
        tierAllows;

      axisEvalByType.set(taskType, {
        taskType,
        verifierBacked,
        validationOk: axisArtifact.validation.ok,
        validationIssues: axisArtifact.validation.issues.map(
          (i) => `${i.code}${i.taskType ? `(${i.taskType})` : ""}: ${i.detail}`
        ),
        statisticallySufficient: stat.sufficient,
        ciLower: stat.ciLower,
        protectedRoute,
        quarantined,
        quarantineReason,
        cooldownActive: cooldown.active,
        cooldownUntil: cooldown.until,
        riskBudgetAvailable: riskBudget.remaining > 0,
        eligible: predicatesPass,
        attempted: false,
        reasons,
      });

      if (predicatesPass) eligibleTaskTypes.push(taskType);
    }
  }

  return { fullArtifact, changedTaskTypes, noop, axisEvalByType, axisArtifactByType, statDetailByType, eligibleTaskTypes };
}

export type AutonomyReviewPlan = ReturnType<typeof planAutonomyReview>;
