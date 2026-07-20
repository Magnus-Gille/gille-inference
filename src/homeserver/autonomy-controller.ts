/**
 * autonomy-controller.ts — the mechanical promotion policy that replaces the human routing-table
 * approver (issue #49, gille-inference — the Phase 4 capstone of
 * grimnir docs/autonomous-improvement-design.md).
 *
 * This module does not reimplement any of the safety-load-bearing primitives it composes — it is
 * the DECISION LAYER on top of them:
 *
 *   - REVIEW: `routing-lifecycle.ts`'s `buildDecisionArtifact` (issue #7) — VALIDATE + the #6/#48
 *     admissibility rule (`gateAdmitsOrganicEvidence`) are reused verbatim.
 *   - WATCH: `adoption-watchdog.ts`'s `runAdoptionWatch`/`evaluateQuarantineGate` (issue #47) —
 *     auto-revert, quarantine, and the kill-switch-respecting runner are reused verbatim.
 *   - ADOPT: `routing-lifecycle.ts`'s `approveArtifact`/`adoptRoutingTable`, followed by
 *     `adoption-watchdog.ts`'s `recordAdoptionForWatch` to open the parachute (the watch window)
 *     for every autonomous adoption — exactly the same call sequence a human operator's `adopt`
 *     CLI invocation makes.
 *   - STATS: `calibration-metrics.ts`'s `wilsonInterval` (already used by anchored-calibration.ts,
 *     issue #48, for its own conservative-CI-lower-bound gate) is the ONLY confidence-interval
 *     formula in this module — the design doc's §2 "statistical sufficiency" predicate is this
 *     same math applied to the artifact's own recorded `passRate`/`attempts` fields, not a new
 *     statistic.
 *
 * ─── One axis per adoption (§5's risk budget) ─────────────────────────────────────────────────
 *
 * `adoptRoutingTable` writes its ENTIRE `artifact.candidate` verbatim — there is no partial-write
 * primitive. To honor "one axis per change" (and to make Tier 1's "adopt only the eligible subset"
 * genuinely possible when a review artifact mixes eligible and ineligible changes), this module
 * builds a FRESH single-axis `RoutingDecisionArtifact` per changed task type via
 * `buildAxisArtifactInputs` + `buildDecisionArtifact` (both reused, never reimplemented): every
 * OTHER changed task type is pinned to an identical value on BOTH sides of the diff (the real
 * adopted table for entries it already had, or a neutral "not yet adopted" stub for a brand-new
 * task type) so `diffRoutingTables` classifies it `unchanged` and it cannot spuriously trip
 * `validateCandidate`'s downgrade/admissibility checks for an axis this tick is not touching. This
 * is the "regenerate/filter the candidate" partial-adoption path the ticket names as preferred over
 * the all-or-nothing fallback — see this repository's PR description for the full rationale.
 *
 * ─── Protected lanes ───────────────────────────────────────────────────────────────────────────
 *
 * `PROTECTED_ROUTES` is the hard-coded, never-auto-adopted task-type deny-list this module tests
 * against every changed axis (recorded as `protected-route: requires-owner`). The OTHER protected
 * surfaces the design doc names — auth/keys, the calibration/watchdog/promotion policy PARAMETERS
 * themselves, retention/erasure enablement, deploy tooling — are protected by CONSTRUCTION: this
 * controller's only mutation capability is `adoptRoutingTable` over the routing table. It has no
 * code path that writes calibration-policy.ts, adoption-watchdog.ts's policy config, this module's
 * own `AutonomyPolicyConfig`, or any credential/key material — a self-improving loop cannot relax
 * gates it has no way to touch.
 *
 * ─── Kill switch / dry run ─────────────────────────────────────────────────────────────────────
 *
 * `AUTONOMY_KILL_SWITCH=on` (checked once per tick via the injected `killSwitchOn`): the tick still
 * runs WATCH + REVIEW + every predicate and RECORDS everything (durable events, the standing
 * proposal) — it simply never calls `adoptRoutingTable` and never promotes a tier. Demotion still
 * applies (a watchdog breach is evidence of a real regression regardless of whether the switch let
 * the revert execute). `--dry-run` (the CLI's flag, threaded in as `opts.dryRun`) is strictly
 * stronger: nothing is written to durable state at all, mirroring `runAdoptionWatch`'s own
 * dry-run contract.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildDecisionArtifact,
  approveArtifact,
  adoptRoutingTable,
  gateAdmitsOrganicEvidence,
  summarizeCalibrationGate,
  type RoutingDecisionArtifact,
  type AdoptDeps,
  type AdoptOutcome,
} from "./routing-lifecycle.js";
import type { RoutingTableDoc, GeneratedRoutingEntry } from "./routing-table-generator.js";
import type { DiffableRoutingTable, DiffableRoutingEntry } from "./routing-table-diff.js";
import {
  runAdoptionWatch,
  loadWatchdogState,
  loadQuarantineState,
  evaluateQuarantineGate,
  recordAdoptionForWatch,
  type WatchdogRunnerDeps,
  type WatchdogPolicyConfig,
  type WatchRunReport,
  type AdoptionWatchRecord,
} from "./adoption-watchdog.js";
import { wilsonInterval } from "./calibration-metrics.js";
import type { CalibrationGateDecision } from "./calibration-gate.js";

// ─── Tiers and policy ─────────────────────────────────────────────────────────────

export type AutonomyTier = 0 | 1 | 2 | 3;

/** Prefix for the `approvedBy` recorded on every autonomous adoption — `${prefix}${tier}`, e.g.
 *  `autonomy-controller:tier1`. Also how risk-budget/cooldown accounting recognises which durable
 *  watchdog records were autonomous (vs a human `adopt` invocation) without a second ledger. */
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

function isAutonomousApproval(approvedBy: string): boolean {
  return approvedBy.startsWith(AUTONOMY_APPROVER_PREFIX);
}

// ─── Durable tier state (data/autonomy/) ─────────────────────────────────────────

export interface TierEvent {
  schemaVersion: 1;
  at: string;
  kind: "promotion" | "demotion";
  fromTier: AutonomyTier;
  toTier: AutonomyTier;
  reason: string;
}

export interface TierState {
  schemaVersion: 1;
  tier: AutonomyTier;
  consecutiveHealthyCycles: number;
  lastCycleAt: string | null;
  lastEvent: TierEvent | null;
}

export function emptyTierState(): TierState {
  return { schemaVersion: 1, tier: 0, consecutiveHealthyCycles: 0, lastCycleAt: null, lastEvent: null };
}

export interface AutonomyPaths {
  root: string;
  tierStatePath: string;
  tierEventsPath: string;
  standingProposalPath: string;
}

export function autonomyPaths(dataDir: string): AutonomyPaths {
  const root = join(dataDir, "autonomy");
  return {
    root,
    tierStatePath: join(root, "tier-state.json"),
    tierEventsPath: join(root, "tier-events.jsonl"),
    standingProposalPath: join(root, "standing-proposal.json"),
  };
}

/** write-to-temp then rename — same atomicity discipline as adoption-watchdog.ts's own
 *  atomicWriteFile (private there; duplicated here rather than reaching across a module boundary
 *  for a six-line fs helper). */
function atomicWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}

export function loadTierState(dataDir: string): TierState {
  const { tierStatePath } = autonomyPaths(dataDir);
  if (!existsSync(tierStatePath)) return emptyTierState();
  try {
    const parsed = JSON.parse(readFileSync(tierStatePath, "utf8")) as TierState;
    if (typeof parsed.tier !== "number") throw new Error("no tier field");
    return parsed;
  } catch (err) {
    throw new Error(
      `autonomy-controller: tier state at ${tierStatePath} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to operate on unreadable durable state.`
    );
  }
}

export function saveTierState(dataDir: string, state: TierState): void {
  atomicWriteFile(autonomyPaths(dataDir).tierStatePath, JSON.stringify(state, null, 2) + "\n");
}

export function appendTierEvent(dataDir: string, event: TierEvent): void {
  const { tierEventsPath, root } = autonomyPaths(dataDir);
  mkdirSync(root, { recursive: true });
  appendFileSync(tierEventsPath, JSON.stringify(event) + "\n", "utf8");
}

// ─── Standing proposal (Tier 0 behavior — subsumes issue #46) ────────────────────

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
  /** All predicates AND the current tier's rule pass — this is what WOULD be adopted absent a
   *  kill switch or dry-run (both reported separately at the tick level). */
  eligible: boolean;
  /** Human-legible reasons for every predicate that failed (empty when `eligible`). */
  reasons: string[];
}

export interface StandingProposalRecord {
  schemaVersion: 1;
  generatedAt: string;
  hasProposal: boolean;
  candidateHash: string | null;
  decisionRef: string | null;
  /** routing-lifecycle.ts's own human-readable diff — task-type/model/verdict only, content-blind. */
  humanDiff: string | null;
  tier: AutonomyTier;
  killSwitchActive: boolean;
  axisPredicates: AxisEvaluation[];
}

export function loadStandingProposal(dataDir: string): StandingProposalRecord | null {
  const { standingProposalPath } = autonomyPaths(dataDir);
  if (!existsSync(standingProposalPath)) return null;
  try {
    return JSON.parse(readFileSync(standingProposalPath, "utf8")) as StandingProposalRecord;
  } catch (err) {
    throw new Error(
      `autonomy-controller: standing proposal at ${standingProposalPath} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to operate on unreadable durable state.`
    );
  }
}

export function saveStandingProposal(dataDir: string, record: StandingProposalRecord): void {
  atomicWriteFile(autonomyPaths(dataDir).standingProposalPath, JSON.stringify(record, null, 2) + "\n");
}

// ─── Statistical sufficiency (§2: conservative CI lower bound beats incumbent by δ at n>=N) ──────

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
 * PURE. Counts prior AUTONOMOUS adoptions (approvedBy prefixed `autonomy-controller:tier`) within
 * the trailing risk-budget window from the SAME durable `AdoptionWatchRecord[]` issue #47 already
 * persists for every adoption — no second risk-budget ledger is invented.
 */
export function computeRiskBudgetStatus(
  records: readonly AdoptionWatchRecord[],
  nowIso: string,
  policy: Pick<AutonomyPolicyConfig, "maxAdoptionsPerWindow" | "riskBudgetWindowHours">
): RiskBudgetStatus {
  const nowMs = Date.parse(nowIso);
  const windowStartMs = nowMs - policy.riskBudgetWindowHours * 60 * 60 * 1000;
  const used = records.filter((r) => {
    if (!isAutonomousApproval(r.approvedBy)) return false;
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
 *  adoption — same durable records as the risk budget, no separate cooldown store. */
export function routeCooldownActive(
  records: readonly AdoptionWatchRecord[],
  taskType: string,
  nowIso: string,
  policy: Pick<AutonomyPolicyConfig, "perRouteCooldownHours">
): RouteCooldownStatus {
  const relevant = records.filter((r) => isAutonomousApproval(r.approvedBy) && r.changedTaskTypes.includes(taskType));
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

// ─── Tier ladder (§6) ─────────────────────────────────────────────────────────────

/** Tier-1 revert rate (breaches / autonomous adoptions) from the SAME durable watchdog records —
 *  no new accounting. Zero adoptions so far reads as 0 (no evidence of failure), not a refusal. */
export function computeAutonomousRevertRate(records: readonly AdoptionWatchRecord[]): number {
  const auto = records.filter((r) => isAutonomousApproval(r.approvedBy));
  if (auto.length === 0) return 0;
  return auto.filter((r) => r.status === "breach").length / auto.length;
}

function maybePromote(
  state: TierState,
  now: string,
  policy: AutonomyPolicyConfig,
  calibrationGate: CalibrationGateDecision | null,
  tier1RevertRate: number
): { state: TierState; event: TierEvent } | null {
  if (state.tier >= 3) return null; // Tier 3 (roster/serving promotion) is out of scope — see PR notes.
  if (state.consecutiveHealthyCycles < policy.tier1UnlockCycles) return null;

  if (state.tier === 0) {
    const event: TierEvent = {
      schemaVersion: 1,
      at: now,
      kind: "promotion",
      fromTier: 0,
      toTier: 1,
      reason: `${policy.tier1UnlockCycles} consecutive healthy cycles reached — unlocking Tier 1 (verifier-backed auto-adopt)`,
    };
    return { state: { ...state, tier: 1, consecutiveHealthyCycles: 0, lastEvent: event }, event };
  }

  if (state.tier === 1) {
    const gateGo = gateAdmitsOrganicEvidence(summarizeCalibrationGate(calibrationGate));
    if (!gateGo || tier1RevertRate > policy.tier2RevertRateMax) return null;
    const event: TierEvent = {
      schemaVersion: 1,
      at: now,
      kind: "promotion",
      fromTier: 1,
      toTier: 2,
      reason:
        `${policy.tier1UnlockCycles} consecutive healthy cycles + anchored calibration GO+enabled + Tier-1 revert rate ` +
        `${tier1RevertRate.toFixed(3)} <= r=${policy.tier2RevertRateMax} — unlocking Tier 2 (organic-gated auto-adopt)`,
    };
    return { state: { ...state, tier: 2, consecutiveHealthyCycles: 0, lastEvent: event }, event };
  }

  return null; // tier === 2: Tier 3 (roster/serving promotion) is out of scope for this ticket.
}

// ─── The tick ─────────────────────────────────────────────────────────────────────

export interface AutonomyReviewInputs {
  candidate: RoutingTableDoc;
  deterministicCandidate: RoutingTableDoc;
  adopted: DiffableRoutingTable | null;
  /** Same on-disk adopted table as `adopted`, parsed with `passRate`/`tokPerSec` preserved — used
   *  ONLY for per-axis revert fidelity (buildAxisArtifactInputs) and the statistical-sufficiency
   *  incumbent baseline; never re-derived from a second ledger query. */
  adoptedRaw: Record<string, AdoptedRawEntry | undefined>;
  servableModelIds: string[] | null;
  requiredTaskTypes: string[];
  freshnessMaxAgeMs: number;
  /** The LIVE #6/#48 gate (calibration-gate-live.ts's `computeLiveCalibrationGate`) — the caller
   *  computes this fresh every tick; this module never accepts a stale/hand-supplied override. */
  calibrationGate: CalibrationGateDecision | null;
  policyEpochHash: string;
  expectedPolicyEpochHash: string;
}

export interface AutonomyTickDeps {
  dataDir: string;
  nowIso: () => string;
  killSwitchOn: () => boolean;
  decisionRef: string;
  policy: AutonomyPolicyConfig;
  watchdogPolicy: WatchdogPolicyConfig;
  review: AutonomyReviewInputs;
  /** Injected ledger read for the watchdog step — real callers pass ledger.ts's
   *  `guardMetricsWindow`; tests pass a fixture. Threaded straight through to `runAdoptionWatch`. */
  queryGuardMetrics: WatchdogRunnerDeps["queryGuardMetrics"];
  /** The SAME #7 AdoptDeps the routing-lifecycle CLI builds for `adopt`/`watch` — reused verbatim
   *  for both the watchdog step and this controller's own adopt calls. */
  adoptDeps: AdoptDeps;
  /** Optional content-blind notification hook (issue #49 item 8) — invoked with a short JSON
   *  summary after any adopt/revert/tier-change. The CLI wires AUTONOMY_NOTIFY_CMD here; this
   *  module never assumes an HTTP channel exists. */
  notify?: (summaryJson: string) => void | Promise<void>;
}

export interface AutonomyAdoptionOutcome {
  taskType: string;
  outcome: AdoptOutcome;
  watchRecord?: AdoptionWatchRecord;
}

export interface AutonomyTickReport {
  evaluatedAt: string;
  dryRun: boolean;
  killSwitchActive: boolean;
  tierBefore: AutonomyTier;
  tierAfter: AutonomyTier;
  tierEvent: TierEvent | null;
  watch: WatchRunReport;
  /** True iff the review found zero semantic routing changes — a healthy no-op cycle. */
  noop: boolean;
  axisEvaluations: AxisEvaluation[];
  adopted: AutonomyAdoptionOutcome[];
  standingProposal: StandingProposalRecord | null;
  healthyCycle: boolean;
}

/**
 * The one idempotent cron entrypoint (issue #49). Re-running this with an unchanged ledger/adopted
 * table is a no-op beyond re-evaluating (the review step re-diffs against whatever is CURRENTLY
 * adopted, so an axis this function already adopted no longer appears as "changed" on the next
 * call — idempotency falls out of the design rather than being special-cased).
 *
 * Sequence (exactly the numbered steps in the ticket): WATCH (#47, breach ⇒ auto-revert/quarantine
 * + immediate tier demotion) → REVIEW (#7 artifact under the live #48 gate) → per-axis PREDICATES
 * (validation, admissibility, statistical sufficiency, risk budget, protected lanes) → DECIDE by
 * TIER (0 = standing-proposal-only; 1 = verifier-backed-only; 2 = also organic-gated) → ADOPT
 * eligible axes one at a time (each opening its own #47 watch window) → TIER LADDER accounting →
 * NOTIFY. `AUTONOMY_KILL_SWITCH=on` (via `killSwitchOn`) suppresses adopt + promotion only;
 * `opts.dryRun` suppresses every durable write.
 */
export async function runAutonomyTick(
  deps: AutonomyTickDeps,
  opts: { dryRun?: boolean } = {}
): Promise<AutonomyTickReport> {
  const dryRun = opts.dryRun ?? false;
  const now = deps.nowIso();
  const killSwitchActive = deps.killSwitchOn();
  const policy = deps.policy;

  // 1. WATCH (#47) — reused verbatim, including its own kill-switch/dry-run semantics.
  const watchDeps: WatchdogRunnerDeps = {
    dataDir: deps.dataDir,
    queryGuardMetrics: deps.queryGuardMetrics,
    nowIso: deps.nowIso,
    killSwitchOn: deps.killSwitchOn,
    adoptDeps: deps.adoptDeps,
  };
  const watch = await runAdoptionWatch(watchDeps, deps.watchdogPolicy, { dryRun });

  let tierState = loadTierState(deps.dataDir);
  const tierBefore = tierState.tier;
  let tierEvent: TierEvent | null = null;

  const anyBreach = watch.items.some((i) => i.evaluation.verdict === "breach");
  if (anyBreach) {
    if (tierState.tier > 0) {
      const toTier = (tierState.tier - 1) as AutonomyTier;
      const breachingTaskTypes = watch.items
        .filter((i) => i.evaluation.verdict === "breach")
        .flatMap((i) => i.record.changedTaskTypes);
      const event: TierEvent = {
        schemaVersion: 1,
        at: now,
        kind: "demotion",
        fromTier: tierState.tier,
        toTier,
        reason: `watchdog breach on [${breachingTaskTypes.join(", ")}] during this tick's watch evaluation — demoting and resetting progress`,
      };
      tierState = { schemaVersion: 1, tier: toTier, consecutiveHealthyCycles: 0, lastCycleAt: now, lastEvent: event };
      tierEvent = event;
    } else {
      tierState = { ...tierState, consecutiveHealthyCycles: 0, lastCycleAt: now };
    }
  }

  // 2. REVIEW (#7 + live #48 gate) — buildDecisionArtifact is pure; all IO already happened in the
  // caller's `deps.review` construction.
  const fullArtifact = buildDecisionArtifact({
    candidate: deps.review.candidate,
    deterministicCandidate: deps.review.deterministicCandidate,
    adopted: deps.review.adopted,
    servableModelIds: deps.review.servableModelIds,
    requiredTaskTypes: deps.review.requiredTaskTypes,
    freshnessMaxAgeMs: deps.review.freshnessMaxAgeMs,
    nowIso: now,
    calibrationGate: deps.review.calibrationGate,
    policyEpochHash: deps.review.policyEpochHash,
    expectedPolicyEpochHash: deps.review.expectedPolicyEpochHash,
  });

  const changedTaskTypes = fullArtifact.diff.changes.filter((c) => c.kind !== "unchanged").map((c) => c.taskType);
  const noop = changedTaskTypes.length === 0;

  // Healthy-cycle bookkeeping (§6): "valid proposal or clean no-op, zero infra failures".
  const anyInfraFailure = watch.items.some((i) => i.revert?.status === "unknown");
  const healthyCycle = fullArtifact.validation.ok && !anyBreach && !anyInfraFailure;
  if (healthyCycle) {
    tierState = { ...tierState, consecutiveHealthyCycles: tierState.consecutiveHealthyCycles + 1, lastCycleAt: now };
  } else if (!anyBreach) {
    // A failed/invalid review breaks the streak (not "consecutive" anymore) but is not itself a
    // demotion trigger — only a watchdog breach demotes.
    tierState = { ...tierState, consecutiveHealthyCycles: 0, lastCycleAt: now };
  }

  // 3+4. PREDICATES + DECIDE BY TIER, per changed axis.
  const axisEvaluations: AxisEvaluation[] = [];
  const adopted: AutonomyAdoptionOutcome[] = [];

  if (!noop) {
    let recordsSoFar = [...loadWatchdogState(deps.dataDir).records];
    const quarantine = loadQuarantineState(deps.dataDir);
    const quarantineGate = evaluateQuarantineGate({
      changedTaskTypes,
      quarantine,
      nowIso: now,
      candidatePassRateByTaskType: Object.fromEntries(
        changedTaskTypes.map((t) => [t, deps.review.candidate.routing[t]?.passRate ?? null])
      ),
    });
    const quarantineReasonByAxis = new Map(quarantineGate.blockedAxes.map((b) => [b.taskType, b.reason]));

    for (const taskType of changedTaskTypes) {
      const lineageEntry = fullArtifact.lineage.find((l) => l.taskType === taskType);
      const verifierBacked = !(lineageEntry?.organicJudgeDependent ?? false);

      const { axisCandidate, axisBaseline } = buildAxisArtifactInputs(
        deps.review.candidate,
        deps.review.adopted,
        deps.review.adoptedRaw,
        taskType,
        changedTaskTypes
      );
      const axisArtifact = buildDecisionArtifact({
        candidate: axisCandidate,
        deterministicCandidate: deps.review.deterministicCandidate,
        adopted: axisBaseline,
        servableModelIds: deps.review.servableModelIds,
        requiredTaskTypes: deps.review.requiredTaskTypes,
        freshnessMaxAgeMs: deps.review.freshnessMaxAgeMs,
        nowIso: now,
        calibrationGate: deps.review.calibrationGate,
        policyEpochHash: deps.review.policyEpochHash,
        expectedPolicyEpochHash: deps.review.expectedPolicyEpochHash,
      });

      const challengerEntry = deps.review.candidate.routing[taskType];
      const incumbentEntry = deps.review.adoptedRaw[taskType];
      const stat = evaluateStatisticalSufficiency(
        {
          challengerAttempts: challengerEntry?.attempts ?? 0,
          challengerPassRate: challengerEntry?.passRate ?? 0,
          incumbentPassRate: incumbentEntry?.passRate ?? null,
        },
        policy
      );

      const protectedRoute = policy.protectedRoutes.has(taskType);
      const quarantineReason = quarantineReasonByAxis.get(taskType);
      const quarantined = quarantineReason !== undefined;
      const cooldown = routeCooldownActive(recordsSoFar, taskType, now, policy);
      const riskBudget = computeRiskBudgetStatus(recordsSoFar, now, policy);

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

      const tierAllows = tierState.tier >= 2 ? true : tierState.tier === 1 ? verifierBacked : false;
      if (tierState.tier === 0) reasons.push("tier-0: propose-only (never auto-adopts)");
      else if (tierState.tier === 1 && !verifierBacked) reasons.push("tier-1: organic-judge-dependent changes require Tier 2");

      const eligible =
        axisArtifact.validation.ok &&
        stat.sufficient &&
        !protectedRoute &&
        !quarantined &&
        !cooldown.active &&
        riskBudget.remaining > 0 &&
        tierAllows;

      axisEvaluations.push({
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
        eligible,
        reasons,
      });

      // 5. ADOPT — only when eligible AND neither the kill switch nor dry-run suppresses it.
      if (!eligible || killSwitchActive || dryRun) continue;

      const approval = approveArtifact(axisArtifact, {
        approvedBy: `${AUTONOMY_APPROVER_PREFIX}${tierState.tier}`,
        reason: `autonomy-controller tick ${now}: ${stat.detail}`,
        decisionRef: deps.decisionRef,
        approvedAt: now,
      });

      const priorRaw = ((): string | null => {
        try {
          return deps.adoptDeps.readTable(deps.adoptDeps.tablePath);
        } catch {
          return null;
        }
      })();

      const outcome = await adoptRoutingTable(axisArtifact, approval, deps.adoptDeps);
      let watchRecord: AdoptionWatchRecord | undefined;
      if (outcome.outcome === "adopted") {
        watchRecord = recordAdoptionForWatch({
          dataDir: deps.dataDir,
          adoptedAt: outcome.record.adoptedAt,
          candidateHash: outcome.record.candidateHash,
          decisionRef: outcome.record.decisionRef,
          approvedBy: outcome.record.approvedBy,
          changedTaskTypes: [taskType],
          priorRaw,
        });
        recordsSoFar = [...recordsSoFar, watchRecord];
      }
      adopted.push({ taskType, outcome, watchRecord });
    }
  }

  // 6. TIER LADDER — promotion (never under kill switch; demotion above already applied
  // unconditionally).
  if (!killSwitchActive && !tierEvent) {
    const revertRate = computeAutonomousRevertRate(loadWatchdogState(deps.dataDir).records);
    const promotion = maybePromote(tierState, now, policy, deps.review.calibrationGate, revertRate);
    if (promotion) {
      tierEvent = promotion.event;
      tierState = promotion.state;
    }
  }

  // Standing proposal (#46 subsumed): refresh whenever a real proposal remains unresolved this
  // tick (Tier 0 always; a kill-switch/dry-run tick where nothing was actually adopted; or a
  // partial Tier-1/2 adoption that left ineligible axes behind).
  const fullyResolved =
    !noop && changedTaskTypes.every((t) => adopted.some((a) => a.taskType === t && a.outcome.outcome === "adopted"));
  const standingProposal: StandingProposalRecord =
    !noop && !fullyResolved
      ? {
          schemaVersion: 1,
          generatedAt: now,
          hasProposal: true,
          candidateHash: fullArtifact.candidateHash,
          decisionRef: deps.decisionRef,
          humanDiff: fullArtifact.humanDiff,
          tier: tierState.tier,
          killSwitchActive,
          axisPredicates: axisEvaluations,
        }
      : {
          schemaVersion: 1,
          generatedAt: now,
          hasProposal: false,
          candidateHash: null,
          decisionRef: null,
          humanDiff: null,
          tier: tierState.tier,
          killSwitchActive,
          axisPredicates: [],
        };

  if (!dryRun) {
    saveTierState(deps.dataDir, tierState);
    if (tierEvent) appendTierEvent(deps.dataDir, tierEvent);
    saveStandingProposal(deps.dataDir, standingProposal);
  }

  // 8. NOTIFICATION — content-blind summary, only after a real adopt/revert/tier-change.
  const anyAdopted = adopted.some((a) => a.outcome.outcome === "adopted");
  if (!dryRun && deps.notify && (anyAdopted || anyBreach || tierEvent !== null)) {
    const summary = {
      at: now,
      tier: { before: tierBefore, after: tierState.tier, event: tierEvent },
      adopted: adopted.filter((a) => a.outcome.outcome === "adopted").map((a) => a.taskType),
      watchdogBreaches: watch.items
        .filter((i) => i.evaluation.verdict === "breach")
        .flatMap((i) => i.record.changedTaskTypes),
      killSwitchActive,
    };
    await deps.notify(JSON.stringify(summary));
  }

  return {
    evaluatedAt: now,
    dryRun,
    killSwitchActive,
    tierBefore,
    tierAfter: tierState.tier,
    tierEvent,
    watch,
    noop,
    axisEvaluations,
    adopted,
    standingProposal,
    healthyCycle,
  };
}
