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
 * `runAutonomyTick` additionally ATTEMPTS AT MOST ONE axis per tick (never two, even when several
 * are simultaneously eligible) — see the "fix-forward" section immediately below for why.
 *
 * ─── Fix-forward: the Sol (xhigh) cross-model review findings ────────────────────────────────
 *
 * The first version of this module (gille-inference#53) shipped with several defects an
 * adversarial cross-model review reproduced before any timer was ever installed against it, and a
 * SECOND review round found 3 partial fixes + 5 new defects in the round-1 fixes themselves. Fixed
 * here, in `runAutonomyTick` unless noted (round 1 numbering preserved; round-3 items marked):
 *
 *   1. STALE SNAPSHOT ACROSS WATCH — the adopted-table baseline is read AFTER WATCH runs
 *      (`tryReadLiveTable`/`parseAdoptedTable`), never handed in pre-built by the caller (removed
 *      from `AutonomyReviewInputs` entirely), so a WATCH-triggered revert this same tick is never
 *      diffed against — and silently undone by — a stale pre-watch snapshot. An optimistic-
 *      concurrency check (`tableContentHash`) re-verifies the live table immediately before the one
 *      attempted axis actually writes — round 3: now taken UNDER the mutation lock (finding 2,
 *      below), since the round-1 check alone still left a window for a concurrent writer.
 *   2. ADOPT-THEN-WATCH CRASH GAP — every attempted adoption is journalled durably (`AdoptionIntent`
 *      / `saveAdoptionIntent`) BEFORE the mutating `adoptRoutingTable` call and finalized only after
 *      `recordAdoptionForWatch` succeeds. `reconcileAdoptionIntent`, called at the very start of
 *      every tick (step 0, before WATCH), recovers a `"pending"` intent left by a crashed prior
 *      tick. Round 3 finding 1 ("journal commit ambiguity"): the round-1 version treated "live table
 *      content matches the candidate" as proof of a completed adoption, but the #7 adopt sequence is
 *      write -> reload -> canary -> (rollback on failure) — a crash after the WRITE but before
 *      reload/canary confirms would have been falsely certified. The intent now tracks its PHASE
 *      (`AdoptionIntentPhase`; `instrumentAdoptDepsForIntent` persists each transition the instant
 *      it happens) and `reconcileAdoptionIntent` RESTORES the prior snapshot (`manualRollback`) for
 *      anything short of `"canary-passed"`, only ever finalizing a truly canary-confirmed adoption.
 *   3. MULTI-AXIS SAME-TICK OVERWRITE — `runAutonomyTick` attempts AT MOST ONE axis per tick;
 *      every OTHER changed axis is left as a standing-proposal entry for the next tick, never
 *      adopted in the same pass that could see (and silently revert) an axis this tick already
 *      wrote. Round 3 finding 5: round 1 achieved this by giving every axis AFTER the first a
 *      FABRICATED placeholder evaluation, which both lied in the standing proposal and let the
 *      lexically-first eligible axis starve every other one forever. Every changed axis now gets an
 *      HONEST, full predicate evaluation every tick; WHICH eligible axis is attempted is decided by
 *      a persisted round-robin cursor (`RotationState`/`rotateEligibleAxes`), and a pre-write
 *      refusal (gate recheck, lock, hash recheck) tries the NEXT eligible axis in rotation without
 *      consuming the tick's one mutation slot.
 *   4. FAILED ADOPTION COUNTED HEALTHY — the healthy-cycle computation runs AFTER any mutation
 *      attempt; a write/reload/rollback/canary failure, a stale-gate refusal, or a stale-baseline
 *      abort all set `mutationAttemptFailed`, which forces `healthyCycle: false` regardless of the
 *      review artifact's own validation.
 *   5. CRASH LOSES A REQUIRED DEMOTION — `TierState.ackedBreachIds` (bounded — round 3 finding 7,
 *      below) durably tracks which watchdog breach records have already triggered a demotion. Every
 *      tick reconciles BOTH this tick's fresh watch verdicts (needed because a kill-switch-blocked
 *      breach never reaches durable `"breach"` status at all — see `runAdoptionWatch`'s own
 *      semantics) and any already-durable `"breach"` record left unacknowledged by a crashed prior
 *      tick, and persists the resulting demotion IMMEDIATELY (step 1.5), before REVIEW/ADOPT even
 *      run — also revoking the Tier-2 ladder enablement (finding 4, round 3) if the demotion drops
 *      below Tier 2.
 *   6. STALE GATE AT ORGANIC ADOPTION — `AutonomyTickDeps.recomputeCalibrationGate` is invoked
 *      immediately before adopting an organic-judge-dependent axis; a live gate that has decayed
 *      off GO+enabled since REVIEW time refuses the adoption (without consuming the mutation slot —
 *      finding 5, round 3), mirroring `routing-lifecycle-cli.ts`'s own adopt-time recheck (#37).
 *   7. APPROVER-STRING SPOOFING — risk-budget/cooldown accounting (`countsTowardRiskBudget`) and
 *      health/revert-rate accounting (`countsTowardAutonomousHealthStats`) each read the STRUCTURED
 *      `AdoptionWatchRecord.provenance` field (only this controller ever sets `{kind:"autonomy"}`),
 *      never `approvedBy` text ALONE (free text a human `adopt --approved-by` invocation could type
 *      identically) — round 3 finding 6 refined the direction: an ambiguous legacy record (no
 *      `provenance`, `approvedBy` matching the display convention) COUNTS toward the risk budget
 *      (restrictive — never manufactures extra mutation headroom) but is EXCLUDED from the health/
 *      revert-rate stat (restrictive the other way — never manufactures a false-healthy track
 *      record). See both functions' own doc comments. `adoption-watchdog.ts`'s `AdoptionProvenance`
 *      type carries the structured signal.
 *
 * ─── Round-3-only findings ─────────────────────────────────────────────────────────────────────
 *
 *   R3-2. CONCURRENT WRITERS — an exclusive, file-based mutation lock (`mutation-lock.ts`,
 *      `acquireMutationLock`) is taken by BOTH this module's own adopt attempt and
 *      `routing-lifecycle-cli.ts`'s human `adopt` command immediately before their respective
 *      table-hash recheck + `adoptRoutingTable` call, so the tick and a concurrent manual adopt can
 *      never interleave a check-then-write race. A busy lock is a pre-write refusal (does not
 *      consume the mutation slot — finding 5).
 *   R3-3. tryReadLiveTable SWALLOWED ALL READ ERRORS — `isVerifiedEnoent` now distinguishes a
 *      genuine "file does not exist" (a real errno `ENOENT`, or a test fake's equivalent message)
 *      from any OTHER read failure (permission denied, disk fault, transient I/O error), which now
 *      PROPAGATES instead of being silently treated as "no table exists yet".
 *   R3-4. TIER-2 ORGANIC PATH VACUOUS IN PRODUCTION — `computeLiveCalibrationGate` NEVER populates
 *      `CalibrationGateDecision.enabling` (only a human-authored `attachReviewedDecision` does,
 *      which this unattended cron path never invokes), making Tier 2 permanently unreachable
 *      outside a test's hand-injected gate. `AnchoredEnablementRecord`/`applyLadderEnablement`: the
 *      tier ladder itself durably GRANTS enablement the moment its own Tier-2 unlock condition is
 *      met (`TierState.consecutiveGoCycles` sustained + Tier-1 revert rate; see `maybePromote`),
 *      and REVOKES it on any demotion below Tier 2 — gate PARAMETERS (κ, windows) stay owner-side/
 *      code-configured while the enablement STATE is ladder-computed, consistent with the
 *      protected-lanes rule.
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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  buildDecisionArtifact,
  approveArtifact,
  adoptRoutingTable,
  manualRollback,
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
  type AdoptionProvenance,
} from "./adoption-watchdog.js";
import { wilsonInterval } from "./calibration-metrics.js";
import type { CalibrationGateDecision } from "./calibration-gate.js";
import { tableContentHash } from "./evidence-identity.js";
import { acquireMutationLock, MutationLockBusyError } from "./mutation-lock.js";

// ─── Tiers and policy ─────────────────────────────────────────────────────────────

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

/**
 * Two DIFFERENT admissibility tests for "was this adoption autonomous" (Sol-xhigh review findings
 * 7 and 6-round-3), because the SAFE fail-direction is opposite for the two things this question
 * gates:
 *
 *   - `countsTowardRiskBudget` — RESTRICTIVE: a record with NO `provenance` at all (legacy, written
 *     before this field existed) whose `approvedBy` text nonetheless matches the autonomy display
 *     convention (`autonomy-controller:tier<N>`) COUNTS toward the risk budget/cooldown. Erring
 *     toward "counted" never lets ambiguity manufacture MORE mutation headroom than intended — the
 *     restrictive direction for a ceiling. A record EXPLICITLY marked `{kind:"manual"}` never
 *     counts, regardless of its `approvedBy` text (explicit provenance always wins over a
 *     free-text guess).
 *   - `countsTowardAutonomousHealthStats` — STRICT: ONLY an explicit `{kind:"autonomy"}` record
 *     counts toward the revert-rate/health signal the tier ladder reads to decide PROMOTION.
 *     Erring toward "excluded" never lets an ambiguous legacy record inflate (or deflate) the
 *     evidence that unlocks MORE autonomy — the restrictive direction for a promotion gate.
 *
 * `approvedBy` itself is NEVER the sole signal for either — a record with STRUCTURED provenance
 * (either kind) is always classified by that field alone, never by its display text.
 */
function countsTowardRiskBudget(record: Pick<AdoptionWatchRecord, "provenance" | "approvedBy">): boolean {
  if (record.provenance?.kind === "autonomy") return true;
  if (record.provenance?.kind === "manual") return false;
  return record.approvedBy.startsWith(AUTONOMY_APPROVER_PREFIX);
}

function countsTowardAutonomousHealthStats(record: Pick<AdoptionWatchRecord, "provenance">): boolean {
  return record.provenance?.kind === "autonomy";
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
  /**
   * Consecutive ticks whose live #6/#48 gate verdict was `"GO"` (round 3 finding 4) — the
   * "sustained anchored GO ≥ κ over the required window" condition the design doc (§6) names for
   * unlocking Tier 2, tracked SEPARATELY from `consecutiveHealthyCycles` because a tick can be
   * healthy without the anchored feed being GO (most of the time, before Tier 2 is even relevant).
   * Resets to 0 on any non-GO tick or any demotion, exactly like the healthy-cycle streak.
   */
  consecutiveGoCycles: number;
  lastCycleAt: string | null;
  lastEvent: TierEvent | null;
  /**
   * Watchdog `AdoptionWatchRecord.id`s whose `"breach"` resolution has ALREADY triggered a
   * demotion (Sol-xhigh review finding 5). `runAdoptionWatch` only ever evaluates records whose
   * status is still `"pending"` — once a record resolves to `"breach"` it is durably marked so and
   * NEVER re-surfaced by a later `watch` run. Without this durable acknowledgement list, a crash
   * between that durable save (inside `runAdoptionWatch`) and this module's own demotion save would
   * permanently lose the demotion: the next tick's `watch.items` would simply never mention that
   * record again. Reconciled at the START of every tick against ALL breach-status records in
   * `adoption-watchdog.ts`'s durable state, not just the ones this specific tick's watch pass
   * freshly resolved. Bounded (round 3 finding 7) — capped at `MAX_ACKED_BREACH_IDS`, oldest
   * evicted first, so this list cannot grow without limit over the system's lifetime. */
  ackedBreachIds: string[];
}

/** Cap for `TierState.ackedBreachIds` (round 3 finding 7) — breach events are rare, so this is far
 *  more headroom than any realistic operating history needs while still bounding growth. */
export const MAX_ACKED_BREACH_IDS = 500;

export function emptyTierState(): TierState {
  return {
    schemaVersion: 1,
    tier: 0,
    consecutiveHealthyCycles: 0,
    consecutiveGoCycles: 0,
    lastCycleAt: null,
    lastEvent: null,
    ackedBreachIds: [],
  };
}

export interface AutonomyPaths {
  root: string;
  tierStatePath: string;
  tierEventsPath: string;
  standingProposalPath: string;
  adoptionIntentPath: string;
  anchoredEnablementPath: string;
  rotationStatePath: string;
}

export function autonomyPaths(dataDir: string): AutonomyPaths {
  const root = join(dataDir, "autonomy");
  return {
    root,
    tierStatePath: join(root, "tier-state.json"),
    tierEventsPath: join(root, "tier-events.jsonl"),
    standingProposalPath: join(root, "standing-proposal.json"),
    adoptionIntentPath: join(root, "adoption-intent.json"),
    anchoredEnablementPath: join(root, "anchored-enablement.json"),
    rotationStatePath: join(root, "rotation-state.json"),
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
    // `ackedBreachIds` is new (finding 5) — a state file saved before this field existed simply
    // has no acknowledged breaches yet, never a corruption.
    if (!Array.isArray(parsed.ackedBreachIds)) parsed.ackedBreachIds = [];
    // `consecutiveGoCycles` is new (round 3 finding 4) — same "legacy file, not corruption" story.
    if (typeof parsed.consecutiveGoCycles !== "number") parsed.consecutiveGoCycles = 0;
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

// ─── Adoption intent journal (Sol-xhigh review finding 2) ────────────────────────

/**
 * A durable, two-phase record of an IN-FLIGHT autonomous adoption. Written `"pending"` BEFORE
 * `approveArtifact`/`adoptRoutingTable` ever run; finalized AFTER `recordAdoptionForWatch`
 * succeeds. If the process crashes in the gap between the table write landing and the watch record
 * being created, the intent stays `"pending"` on disk and `reconcileAdoptionIntent` (called at the
 * START of the next tick, before WATCH) recovers deterministically: the live table's content is the
 * ONLY source of truth for "did the write actually happen" (`candidateHash` here is
 * `RoutingDecisionArtifact.candidateHash`, i.e. `contentDigest(JSON.stringify(candidate))` — see
 * `tableContentHash`'s doc comment for why this is safely comparable against the live file's bytes
 * even though `adoptRoutingTable` pretty-prints when it writes).
 */
/**
 * Phase transitions of an in-flight adoption (round 3 finding 1 — "journal commit ambiguity").
 * The #7 `adoptRoutingTable` sequence is write -> reload -> canary -> (rollback on failure); a
 * crash can land the process at ANY of these steps, and "the live table matches the candidate" by
 * itself only proves the WRITE happened — NOT that reload confirmed it or canary passed. Each
 * phase is persisted THE INSTANT it happens (via an instrumented `AdoptDeps` wrapper — see
 * `instrumentAdoptDepsForIntent` — never inferred after the fact from table content alone):
 *   - `"planned"` — the intent was written, `adoptRoutingTable` has not been called yet.
 *   - `"table-written"` — the candidate WRITE succeeded (reload/canary not yet attempted/confirmed).
 *   - `"reloaded"` — the RELOAD succeeded (canary not yet confirmed).
 *   - `"canary-passed"` — `adoptRoutingTable` returned `"adopted"` — canary DID pass; only
 *     `recordAdoptionForWatch`/finalizing may still be pending.
 * `reconcileAdoptionIntent` treats anything short of `"canary-passed"` as UNCONFIRMED and restores
 * the prior snapshot rather than certifying an uncanaried table as an adoption.
 */
export type AdoptionIntentPhase = "planned" | "table-written" | "reloaded" | "canary-passed";

export interface AdoptionIntent {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  taskType: string;
  candidateHash: string;
  decisionRef: string;
  approvedBy: string;
  tier: AutonomyTier;
  /** Exact prior live-table bytes read BEFORE the write this intent describes — carried here (not
   *  just handed to `recordAdoptionForWatch` in the happy path) so a CRASH-RECOVERY reconciliation
   *  can still open the exact same watch-window snapshot the normal path would have, OR restore it
   *  directly if the crash happened before canary confirmation. */
  priorRaw: string | null;
  phase: AdoptionIntentPhase;
  status: "pending" | "finalized" | "aborted";
  finalizedAt?: string;
  abortedAt?: string;
  abortReason?: string;
  watchRecordId?: string;
}

export function loadAdoptionIntent(dataDir: string): AdoptionIntent | null {
  const { adoptionIntentPath } = autonomyPaths(dataDir);
  if (!existsSync(adoptionIntentPath)) return null;
  try {
    return JSON.parse(readFileSync(adoptionIntentPath, "utf8")) as AdoptionIntent;
  } catch (err) {
    throw new Error(
      `autonomy-controller: adoption intent at ${adoptionIntentPath} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to operate on unreadable durable state.`
    );
  }
}

export function saveAdoptionIntent(dataDir: string, intent: AdoptionIntent): void {
  atomicWriteFile(autonomyPaths(dataDir).adoptionIntentPath, JSON.stringify(intent, null, 2) + "\n");
}

// `tableContentHash` now lives in evidence-identity.ts (round 3 finding 2) so
// scripts/routing-lifecycle-cli.ts's human `adopt` path can share the EXACT same hash semantics
// without importing this module — re-exported here (of the binding imported above) for existing
// call sites/tests that still import it from here.
export { tableContentHash };

export interface ReconcileAdoptionIntentResult {
  action: "none" | "finalized-existing-watch-record" | "finalized-new-watch-record" | "aborted";
  detail?: string;
}

/**
 * Wraps a REAL `AdoptDeps` so `writeTable`/`reload` ALSO persist the intent's phase (round 3
 * finding 1) the INSTANT each underlying call succeeds, before `adoptRoutingTable`'s own internal
 * sequence proceeds to the next step — composing the injected DI surface, never reimplementing
 * `adoptRoutingTable` itself. `writeTable` only marks `"table-written"` on its FIRST call within one
 * attempt (the candidate write); a SECOND call (the write half of `adoptRoutingTable`'s own internal
 * rollback-on-failure) is deliberately left unmarked, since by then this is no longer the phase
 * "table-written" describes — the candidate write already happened and failed downstream. Callers
 * MUST construct a FRESH wrapper per adopt attempt (the `written` flag is attempt-scoped).
 */
function instrumentAdoptDepsForIntent(base: AdoptDeps, dataDir: string, intentId: string): AdoptDeps {
  let candidateWriteMarked = false;
  const markPhase = (phase: AdoptionIntentPhase): void => {
    const current = loadAdoptionIntent(dataDir);
    if (current && current.id === intentId && current.status === "pending") {
      saveAdoptionIntent(dataDir, { ...current, phase });
    }
  };
  return {
    ...base,
    writeTable: (path, data) => {
      base.writeTable(path, data);
      if (!candidateWriteMarked) {
        candidateWriteMarked = true;
        markPhase("table-written");
      }
    },
    reload: async () => {
      const result = await base.reload();
      if (result.ok) markPhase("reloaded");
      return result;
    },
  };
}

/**
 * Called at the START of every tick, before WATCH even runs (so a just-recovered watch record is
 * visible to THIS tick's own watch pass too). A `"pending"` intent left over from a crashed prior
 * tick is resolved from its PERSISTED PHASE, never from table content alone (round 3 finding 1 —
 * "the intent record treats live-table-matches-candidate as adoption-committed, but a crash after
 * the WRITE and before reload/canary completes would falsely finalize an uncanaried table"):
 *   - phase is anything SHORT OF `"canary-passed"` — the write may have landed but reload/canary
 *     never confirmed it — RESTORE the intent's own snapshot (`manualRollback`, the SAME #7
 *     rollback primitive every other revert in this codebase uses) and mark `"aborted"`. No prior
 *     snapshot (first-ever adoption) means there is nothing to restore TO; the table is left as-is
 *     and the abort reason says so explicitly.
 *   - phase is `"canary-passed"` — the adopt fully succeeded through canary; only
 *     `recordAdoptionForWatch`/finalizing may still be pending. A final live-table-hash check
 *     guards against something ELSE changing the table since (refuses to fabricate a watch record
 *     for content that is no longer live); otherwise this is the original finding-2 gap: finalize
 *     an EXISTING watch record if one already exists (crash between recording and finalizing), or
 *     retroactively create the missing one (crash between canary passing and recording).
 */
export async function reconcileAdoptionIntent(
  dataDir: string,
  now: string,
  adoptDeps: AdoptDeps
): Promise<ReconcileAdoptionIntentResult> {
  const intent = loadAdoptionIntent(dataDir);
  if (!intent || intent.status !== "pending") return { action: "none" };

  if (intent.phase !== "canary-passed") {
    let restoreNote: string;
    if (intent.priorRaw !== null) {
      await manualRollback({
        deps: adoptDeps,
        snapshotRaw: intent.priorRaw,
        reason: `autonomy-controller: reconciling an adoption intent that crashed before canary confirmation (phase: ${intent.phase})`,
      });
      restoreNote = "restored to the pre-adoption snapshot";
    } else {
      restoreNote = "no prior snapshot existed (first-ever adoption) — table left as-is";
    }
    saveAdoptionIntent(dataDir, {
      ...intent,
      status: "aborted",
      abortedAt: now,
      abortReason: `crashed before canary confirmation (phase: ${intent.phase}) — ${restoreNote}`,
    });
    return { action: "aborted", detail: intent.phase };
  }

  const liveHash = tableContentHash(tryReadLiveTable(adoptDeps));
  if (liveHash !== intent.candidateHash) {
    saveAdoptionIntent(dataDir, {
      ...intent,
      status: "aborted",
      abortedAt: now,
      abortReason: `canary had passed but the live table (${liveHash}) no longer matches the intent's candidate (${intent.candidateHash}) — refusing to register a watch record for content that is no longer live`,
    });
    return { action: "aborted", detail: "table-changed-after-canary" };
  }

  const existing = loadWatchdogState(dataDir).records.find((r) => r.candidateHash === intent.candidateHash);
  if (existing) {
    saveAdoptionIntent(dataDir, { ...intent, status: "finalized", finalizedAt: now, watchRecordId: existing.id });
    return { action: "finalized-existing-watch-record", detail: existing.id };
  }

  const record = recordAdoptionForWatch({
    dataDir,
    adoptedAt: intent.createdAt,
    candidateHash: intent.candidateHash,
    decisionRef: intent.decisionRef,
    approvedBy: intent.approvedBy,
    changedTaskTypes: [intent.taskType],
    priorRaw: intent.priorRaw,
    provenance: { kind: "autonomy", tier: intent.tier },
  });
  saveAdoptionIntent(dataDir, { ...intent, status: "finalized", finalizedAt: now, watchRecordId: record.id });
  return { action: "finalized-new-watch-record", detail: record.id };
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

// ─── Tier ladder (§6) ─────────────────────────────────────────────────────────────

/**
 * The tier ladder's OWN durable enablement record (round 3 finding 4). `computeLiveCalibrationGate`
 * (calibration-gate-live.ts) NEVER populates `CalibrationGateDecision.enabling` — that field is
 * only ever set by `calibration-gate.ts`'s `attachReviewedDecision`, a HUMAN-authored action this
 * unattended cron path deliberately never invokes (see autonomy-tick-cli.ts's own header on why it
 * never accepts a `--calibration-gate` override). Left as-is, this makes Tier 2 (which REQUIRES
 * `gateAdmitsOrganicEvidence`, i.e. `enabling !== null`) permanently unreachable in production —
 * the exact gap this record closes.
 *
 * Written ONLY by `maybePromote` the moment the Tier 1 -> Tier 2 unlock condition is met (sustained
 * anchored GO — `TierState.consecutiveGoCycles` — over the required window, plus the Tier-1 track
 * record); REVOKED the instant a demotion drops the tier below 2. `applyLadderEnablement` is the
 * ONLY place this record is ever consulted, and only to synthesize `enabling` onto an ALREADY-`GO`
 * gate — a `HOLD` verdict is untouched (still fails closed) regardless of this record's presence.
 * This keeps gate PARAMETERS (κ, windows) owner-side/code-configured while the enablement STATE
 * itself is ladder-computed — consistent with the protected-lanes rule that promotion policy
 * parameters are never something the loop can rewrite, while the loop's OWN measured operating
 * record is exactly what is allowed to move it up the ladder.
 */
export interface AnchoredEnablementRecord {
  schemaVersion: 1;
  reviewerId: string;
  reason: string;
  decisionRef: string;
  reviewedAt: string;
  /** The tier this enablement was granted at — audit/debugging only. */
  grantedAtTier: AutonomyTier;
}

export function loadAnchoredEnablement(dataDir: string): AnchoredEnablementRecord | null {
  const path = autonomyPaths(dataDir).anchoredEnablementPath;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AnchoredEnablementRecord;
  } catch (err) {
    throw new Error(
      `autonomy-controller: anchored enablement record at ${path} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to operate on unreadable durable state.`
    );
  }
}

export function saveAnchoredEnablement(dataDir: string, record: AnchoredEnablementRecord): void {
  atomicWriteFile(autonomyPaths(dataDir).anchoredEnablementPath, JSON.stringify(record, null, 2) + "\n");
}

/** Revokes the ladder's own enablement — called the instant a demotion drops the tier below 2.
 *  Idempotent (a missing file is not an error). */
export function revokeAnchoredEnablement(dataDir: string): void {
  const path = autonomyPaths(dataDir).anchoredEnablementPath;
  try {
    unlinkSync(path);
  } catch {
    // Already absent — nothing to revoke.
  }
}

/**
 * Applies the tier ladder's OWN durable enablement to a freshly-computed live gate: a
 * `verdict: "GO"` gate gains `enabling` FROM the ladder's own record (written only when Tier 2 was
 * unlocked, revoked immediately on any demotion below Tier 2) — never from a human
 * `attachReviewedDecision` file this unattended cron path does not accept. A `"HOLD"` gate, or the
 * absence of a ladder record, is returned UNCHANGED (`enabling` stays `null` — fail closed).
 */
export function applyLadderEnablement(
  gate: CalibrationGateDecision | null,
  dataDir: string
): CalibrationGateDecision | null {
  if (gate === null || gate.verdict !== "GO") return gate;
  const record = loadAnchoredEnablement(dataDir);
  if (!record) return gate;
  return {
    ...gate,
    enabling: {
      reviewerId: record.reviewerId,
      reason: record.reason,
      decisionRef: record.decisionRef,
      reviewedAt: record.reviewedAt,
    },
  };
}

/** Tier-1 revert rate (breaches / autonomous adoptions) from the SAME durable watchdog records —
 *  no new accounting. Uses the STRICT `countsTowardAutonomousHealthStats` predicate (round 3
 *  finding 6: an ambiguous legacy record must never inflate OR deflate this health signal). Zero
 *  adoptions so far reads as 0 (no evidence of failure), not a refusal. */
export function computeAutonomousRevertRate(records: readonly AdoptionWatchRecord[]): number {
  const auto = records.filter((r) => countsTowardAutonomousHealthStats(r));
  if (auto.length === 0) return 0;
  return auto.filter((r) => r.status === "breach").length / auto.length;
}

/**
 * Tier 1 -> Tier 2's unlock condition is "sustained anchored GO ... AND Tier-1 revert rate <= r"
 * (design doc §6) — NOT "the gate already admits organic evidence" (`gateAdmitsOrganicEvidence`
 * requires `enabling !== null`, which is EXACTLY what promotion is supposed to grant; checking it
 * as a PRECONDITION of the promotion that creates it is circular and makes Tier 2 unreachable —
 * round 3 finding 4). `state.consecutiveGoCycles` tracks the RAW verdict being `"GO"` (the anchored
 * feed clearing kappa) sustained over `tier1UnlockCycles` ticks; reaching the threshold is what
 * lets `maybePromote` itself durably GRANT `enabling`, via `saveAnchoredEnablement`, dataDir-side.
 */
function maybePromote(
  state: TierState,
  now: string,
  policy: AutonomyPolicyConfig,
  dataDir: string,
  decisionRef: string,
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
    return { state: { ...state, tier: 1, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastEvent: event }, event };
  }

  if (state.tier === 1) {
    if (state.consecutiveGoCycles < policy.tier1UnlockCycles || tier1RevertRate > policy.tier2RevertRateMax) return null;
    const event: TierEvent = {
      schemaVersion: 1,
      at: now,
      kind: "promotion",
      fromTier: 1,
      toTier: 2,
      reason:
        `${policy.tier1UnlockCycles} consecutive healthy cycles + ${state.consecutiveGoCycles} consecutive anchored-GO cycles + ` +
        `Tier-1 revert rate ${tier1RevertRate.toFixed(3)} <= r=${policy.tier2RevertRateMax} — unlocking Tier 2 (organic-gated auto-adopt); ` +
        `ladder-granted anchored enablement recorded`,
    };
    // The ladder ITSELF is the reviewer here — this is the one and only place `enabling` is ever
    // durably granted for the anchored gate (round 3 finding 4).
    saveAnchoredEnablement(dataDir, {
      schemaVersion: 1,
      reviewerId: "autonomy-controller:tier-ladder",
      reason: event.reason,
      decisionRef,
      reviewedAt: now,
      grantedAtTier: 2,
    });
    return { state: { ...state, tier: 2, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastEvent: event }, event };
  }

  return null; // tier === 2: Tier 3 (roster/serving promotion) is out of scope for this ticket.
}

// ─── Axis rotation (round 3 finding 5) ────────────────────────────────────────────

export interface RotationState {
  schemaVersion: 1;
  /** The task type actually ATTEMPTED (mutation-wise) on the last tick that attempted one, or
   *  `null` before any attempt has ever happened. */
  lastAttemptedTaskType: string | null;
}

export function emptyRotationState(): RotationState {
  return { schemaVersion: 1, lastAttemptedTaskType: null };
}

export function loadRotationState(dataDir: string): RotationState {
  const path = autonomyPaths(dataDir).rotationStatePath;
  if (!existsSync(path)) return emptyRotationState();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as RotationState;
    if (parsed.lastAttemptedTaskType !== null && typeof parsed.lastAttemptedTaskType !== "string") {
      throw new Error("invalid lastAttemptedTaskType");
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `autonomy-controller: rotation state at ${path} is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to operate on unreadable durable state.`
    );
  }
}

export function saveRotationState(dataDir: string, state: RotationState): void {
  atomicWriteFile(autonomyPaths(dataDir).rotationStatePath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * PURE. Orders a set of ELIGIBLE task types so the rotation starts right after whichever one was
 * last actually attempted (round 3 finding 5 — "the lexically-first axis owns every tick"
 * starvation fix). Every eligible axis still gets a full, honest predicate evaluation each tick
 * (this function only decides ATTEMPT ORDER, never which axes are eligible); a pre-write refusal on
 * one candidate simply moves to the next entry in this list within the SAME tick, still capped at
 * one actual mutation. Deterministic (alphabetical) when there is no prior attempt, or when the
 * previously-attempted axis is no longer in the eligible set (it just starts from the top again).
 */
export function rotateEligibleAxes(eligibleTaskTypes: readonly string[], lastAttempted: string | null): string[] {
  const sorted = [...eligibleTaskTypes].sort();
  if (sorted.length === 0 || lastAttempted === null) return sorted;
  const idx = sorted.indexOf(lastAttempted);
  if (idx === -1) return sorted;
  // Start with the NEXT axis after lastAttempted, wrapping around — lastAttempted itself comes
  // last, so it still gets tried again if it is the ONLY eligible axis, but never hogs first place.
  return [...sorted.slice(idx + 1), ...sorted.slice(0, idx + 1)];
}

// ─── The tick ─────────────────────────────────────────────────────────────────────

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

/**
 * True iff `err` represents a VERIFIED "file does not exist" condition (round 3 finding 3) —
 * either a real Node `NodeJS.ErrnoException` with `code === "ENOENT"` (what `readFileSync` throws
 * in production) or, for test fakes that throw a plain `Error` without an errno code, a message
 * that says so explicitly. Anything else (permission denied, disk error, a transient I/O fault) is
 * NOT this — see `tryReadLiveTable`'s doc comment for why that distinction matters.
 */
function isVerifiedEnoent(err: unknown): boolean {
  const code = err && typeof err === "object" ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\bENOENT\b/.test(message);
}

/**
 * Reads the LIVE routing table via the SAME `AdoptDeps.readTable` every other consumer uses.
 * Deliberately NOT part of `AutonomyReviewInputs` (Sol-xhigh review finding 1) — the caller building
 * `deps.review` runs BEFORE `runAutonomyTick` is even called, which is exactly the staleness bug:
 * WATCH can revert/quarantine an axis, and only a read taken AFTER that point is a valid diff
 * baseline. This module reads it itself, at the correct point in the tick, every time.
 *
 * Returns `null` ONLY on a verified ENOENT (round 3 finding 3: the original version swallowed
 * EVERY read error — a permission error, a disk fault, any transient I/O failure — as "no table
 * exists yet", which could make REVIEW silently assume an empty baseline and write a synthetic
 * full table with no real rollback snapshot behind it). Any other error PROPAGATES, so the tick
 * fails loudly (an honest infra failure, not a wrong assumption).
 */
function tryReadLiveTable(adoptDeps: AdoptDeps): string | null {
  try {
    return adoptDeps.readTable(adoptDeps.tablePath);
  } catch (err) {
    if (isVerifiedEnoent(err)) return null;
    throw err;
  }
}

/**
 * Parses a live routing-table file into BOTH the type-narrow `DiffableRoutingTable` (the real
 * review diff baseline) and a `passRate`-preserving raw map (per-axis revert fidelity —
 * `buildAxisArtifactInputs` — and the statistical-sufficiency incumbent baseline). Machine-
 * generated tables (the only kind this pipeline ever writes) carry both; a hand-edited legacy table
 * simply yields `passRate: undefined` per entry, which callers already treat as "no fidelity info,
 * cosmetic-only default".
 */
export function parseAdoptedTable(
  raw: string | null
): { diffable: DiffableRoutingTable | null; raw: Record<string, AdoptedRawEntry | undefined> } {
  if (raw === null) return { diffable: null, raw: {} };
  let parsed: { routing?: Record<string, Record<string, unknown>> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (err) {
    throw new Error(
      `autonomy-controller: adopted table is corrupt (${err instanceof Error ? err.message : String(err)}) — refusing to diff against an unreadable table.`
    );
  }
  const rawEntries: Record<string, AdoptedRawEntry | undefined> = {};
  for (const [taskType, entry] of Object.entries(parsed.routing ?? {})) {
    rawEntries[taskType] = {
      model: typeof entry["model"] === "string" ? (entry["model"] as string) : null,
      verdict: typeof entry["verdict"] === "string" ? (entry["verdict"] as string) : "escalate-frontier",
      attempts: typeof entry["attempts"] === "number" ? (entry["attempts"] as number) : 0,
      passRate: typeof entry["passRate"] === "number" ? (entry["passRate"] as number) : undefined,
      tokPerSec: typeof entry["tokPerSec"] === "number" ? (entry["tokPerSec"] as number) : null,
    };
  }
  return { diffable: parsed as DiffableRoutingTable, raw: rawEntries };
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
  /**
   * Recomputes the LIVE #6/#48 calibration gate at the exact moment of adoption (Sol-xhigh review
   * finding 6) — required so an organic-judge-dependent axis is refused if the gate decayed to
   * HOLD (or lost its `enabling`) between REVIEW time and this tick's actual adopt attempt, exactly
   * mirroring `routing-lifecycle-cli.ts`'s own adopt-time recheck for the human path (issue #37).
   * Never optional in practice — a caller with no organic-dependent axes may pass a function that
   * just returns `deps.review.calibrationGate` unchanged, but the field itself is required so this
   * recheck is never silently skipped by omission.
   */
  recomputeCalibrationGate: () => CalibrationGateDecision | null;
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
 * Sequence (exactly the numbered steps in the ticket, with the Sol-xhigh review's round 1-3 fixes
 * folded in): RECONCILE any crashed prior tick's adoption intent (findings 2/1: phase-aware, never
 * certifies an uncanaried write) → WATCH (#47) → ACKNOWLEDGE every resolved-but-unacknowledged
 * breach and persist any demotion IMMEDIATELY, revoking Tier-2 ladder enablement if it drops below
 * Tier 2 (findings 5/4) → REVIEW (#7 artifact, adopted-table baseline re-read AFTER watch — finding
 * 1; the live #6/#48 gate augmented with the ladder's OWN durable enablement — finding 4) →
 * HONEST per-axis PREDICATES for every changed axis (finding 5 — never a fabricated placeholder) →
 * DECIDE by TIER → ADOPT: rotate over the ELIGIBLE axes (persisted cursor, finding 5) attempting
 * the first one whose pre-write rechecks (organic-gate recheck, finding 6; exclusive mutation lock
 * + table-hash recheck, findings 2/1) also pass — a pre-write refusal tries the NEXT eligible axis
 * without consuming the tick's one mutation slot — journalled via a durable, PHASE-TRACKED intent
 * record (finding 1) BEFORE the mutating call → healthy-cycle computed AFTER any mutation attempt
 * (finding 4) → TIER LADDER promotion (writes the ladder enablement record on Tier 2 unlock,
 * finding 4) → NOTIFY. `AUTONOMY_KILL_SWITCH=on` suppresses adopt + promotion only (demotion/
 * reconciliation still apply); `opts.dryRun` suppresses every durable write (including the lock).
 */
export async function runAutonomyTick(
  deps: AutonomyTickDeps,
  opts: { dryRun?: boolean } = {}
): Promise<AutonomyTickReport> {
  const dryRun = opts.dryRun ?? false;
  const now = deps.nowIso();
  const killSwitchActive = deps.killSwitchOn();
  const policy = deps.policy;

  // 0. RECONCILE (findings 2/1): a "pending" adoption intent left over from a crashed prior tick is
  // resolved BEFORE anything else — including before WATCH runs, so a just-recovered watch record
  // is visible to THIS tick's own watch pass too. Skipped under --dry-run (zero mutation); NOT
  // skipped under the kill switch (this is honest bookkeeping for a write that already happened,
  // not a new autonomous mutation).
  if (!dryRun) {
    await reconcileAdoptionIntent(deps.dataDir, now, deps.adoptDeps);
  }

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
  // Finding 7 (round 3): the demotion event below is persisted IMMEDIATELY (before REVIEW/ADOPT) —
  // this flag stops the end-of-tick save block from appending the SAME event a second time.
  let tierEventAlreadyPersisted = false;

  // 1.5 ACKNOWLEDGE + DEMOTE (finding 5, round 1): reconcile every breach not yet acknowledged by
  // the tier ladder, from BOTH signals — not just the DURABLE "breach" status, and not just THIS
  // tick's fresh verdict alone:
  //   (a) `watch.items` whose EVALUATION verdict is "breach" this tick — this is the ONLY signal
  //       available while `AUTONOMY_KILL_SWITCH=on`, because `runAdoptionWatch` itself deliberately
  //       leaves a kill-switch-blocked record's durable `status` at `"pending"` (never "breach") —
  //       see its own module header. Without this signal, a kill-switch-active tick would see zero
  //       durably-breached records and wrongly skip the "demotion still applies" requirement.
  //   (b) any watchdog record whose DURABLE `status` is already `"breach"` — covers a crash between
  //       `runAdoptionWatch`'s own internal save (which DID resolve it, kill switch off) and this
  //       module's demotion save, per finding 5's exact reproduction.
  // Acknowledging by RECORD ID across BOTH signals (not by "was this the fresh-verdict path or the
  // durable-status path") is what prevents a DOUBLE demotion: a record demoted for while
  // kill-switch-blocked (signal a) is acked immediately, so its LATER durable resolution to
  // "breach" (once the switch clears, signal b) is not treated as a second, new event.
  const freshBreachIds = watch.items.filter((i) => i.evaluation.verdict === "breach").map((i) => i.record.id);
  const durableBreachIds = loadWatchdogState(deps.dataDir)
    .records.filter((r) => r.status === "breach")
    .map((r) => r.id);
  const allBreachIds = [...new Set([...freshBreachIds, ...durableBreachIds])];
  const unackedBreachIds = allBreachIds.filter((id) => !tierState.ackedBreachIds.includes(id));
  const anyBreach = unackedBreachIds.length > 0;
  if (anyBreach) {
    // Finding 7 (round 3): bound `ackedBreachIds` — evict the OLDEST entries once the cap is
    // exceeded rather than growing this list without limit over the system's lifetime.
    const rawNextAcked = [...tierState.ackedBreachIds, ...unackedBreachIds];
    const nextAcked =
      rawNextAcked.length > MAX_ACKED_BREACH_IDS ? rawNextAcked.slice(rawNextAcked.length - MAX_ACKED_BREACH_IDS) : rawNextAcked;
    if (tierState.tier > 0) {
      const toTier = (tierState.tier - 1) as AutonomyTier;
      const event: TierEvent = {
        schemaVersion: 1,
        at: now,
        kind: "demotion",
        fromTier: tierState.tier,
        toTier,
        reason: `watchdog breach record id(s) [${unackedBreachIds.join(", ")}] resolved and not yet acknowledged — demoting and resetting progress`,
      };
      tierState = {
        ...tierState,
        tier: toTier,
        consecutiveHealthyCycles: 0,
        consecutiveGoCycles: 0,
        lastCycleAt: now,
        lastEvent: event,
        ackedBreachIds: nextAcked,
      };
      tierEvent = event;
      if (!dryRun && toTier < 2) revokeAnchoredEnablement(deps.dataDir); // finding 4: revoke on drop below Tier 2
    } else {
      tierState = { ...tierState, consecutiveHealthyCycles: 0, consecutiveGoCycles: 0, lastCycleAt: now, ackedBreachIds: nextAcked };
    }
    if (!dryRun) {
      saveTierState(deps.dataDir, tierState);
      if (tierEvent) {
        appendTierEvent(deps.dataDir, tierEvent);
        tierEventAlreadyPersisted = true;
      }
    }
  }

  // 2. REVIEW (#7 + live #48 gate) — the adopted-table baseline is read HERE, AFTER watch, so a
  // breach's revert earlier THIS SAME tick is never diffed against a stale pre-watch snapshot
  // (finding 1, round 1). buildDecisionArtifact itself remains pure; this is the only IO REVIEW
  // performs. The gate is augmented with the tier ladder's OWN durable enablement (finding 4,
  // round 3) BEFORE it is used anywhere — including inside `buildDecisionArtifact`'s own
  // admissibility check — so an organic-dependent axis at Tier 2 is never wrongly flagged
  // inadmissible by a raw production gate that (by construction) never carries `enabling` itself.
  const liveRawForReview = tryReadLiveTable(deps.adoptDeps);
  const { diffable: adoptedTable, raw: adoptedRaw } = parseAdoptedTable(liveRawForReview);
  const effectiveReviewGate = applyLadderEnablement(deps.review.calibrationGate, deps.dataDir);

  const fullArtifact = buildDecisionArtifact({
    candidate: deps.review.candidate,
    deterministicCandidate: deps.review.deterministicCandidate,
    adopted: adoptedTable,
    servableModelIds: deps.review.servableModelIds,
    requiredTaskTypes: deps.review.requiredTaskTypes,
    freshnessMaxAgeMs: deps.review.freshnessMaxAgeMs,
    nowIso: now,
    calibrationGate: effectiveReviewGate,
    policyEpochHash: deps.review.policyEpochHash,
    expectedPolicyEpochHash: deps.review.expectedPolicyEpochHash,
  });

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
    const recordsAtStart = loadWatchdogState(deps.dataDir).records;
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
        adoptedTable,
        adoptedRaw,
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
        calibrationGate: effectiveReviewGate,
        policyEpochHash: deps.review.policyEpochHash,
        expectedPolicyEpochHash: deps.review.expectedPolicyEpochHash,
      });
      axisArtifactByType.set(taskType, axisArtifact);

      const challengerEntry = deps.review.candidate.routing[taskType];
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

      const tierAllows = tierState.tier >= 2 ? true : tierState.tier === 1 ? verifierBacked : false;
      if (tierState.tier === 0) reasons.push("tier-0: propose-only (never auto-adopts)");
      else if (tierState.tier === 1 && !verifierBacked) reasons.push("tier-1: organic-judge-dependent changes require Tier 2");

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

      if (predicatesPass && !killSwitchActive && !dryRun) eligibleTaskTypes.push(taskType);
    }
  }

  // 4. DECIDE BY TIER + ADOPT — rotate over the ELIGIBLE axes (persisted cursor, finding 5) and
  // attempt the FIRST one whose pre-write rechecks also pass; at most ONE actual mutation per tick
  // (finding 3, round 1) — a pre-write refusal tries the next axis in rotation WITHOUT consuming
  // that one slot (finding 5, round 3).
  const adopted: AutonomyAdoptionOutcome[] = [];
  let mutationAttemptFailed = false;

  if (!noop && eligibleTaskTypes.length > 0) {
    const rotationState = loadRotationState(deps.dataDir);
    const rotationOrder = rotateEligibleAxes(eligibleTaskTypes, rotationState.lastAttemptedTaskType);
    // Captured ONCE, right after the post-watch read above — the optimistic-concurrency baseline
    // every attempted axis's write is checked against immediately before it mutates (finding 1).
    const baselineHash = tableContentHash(liveRawForReview);

    for (const taskType of rotationOrder) {
      const axisArtifact = axisArtifactByType.get(taskType)!;
      const evalRecord = axisEvalByType.get(taskType)!;

      // 4a. Finding 6 (round 1): recheck the LIVE gate immediately before an organic-dependent
      // adopt, also augmented with the ladder's own enablement (finding 4, round 3) — a pre-write
      // refusal here does NOT consume this tick's mutation slot; the rotation just tries the next
      // eligible axis.
      if (!evalRecord.verifierBacked) {
        const freshGateSummary = summarizeCalibrationGate(applyLadderEnablement(deps.recomputeCalibrationGate(), deps.dataDir));
        if (!gateAdmitsOrganicEvidence(freshGateSummary)) {
          axisEvalByType.set(taskType, {
            ...evalRecord,
            eligible: false,
            reasons: [
              ...evalRecord.reasons,
              `organic-gate-recheck-failed: the live #6/#48 gate is no longer GO+enabled at adopt time (review-time snapshot was ${
                summarizeCalibrationGate(effectiveReviewGate)?.verdict ?? "none consulted"
              })`,
            ],
          });
          continue;
        }
      }

      // 4b. Finding 2 (round 3): the exclusive mutation lock, shared with the human
      // `routing-lifecycle-cli.ts adopt` path — refuses (does not consume the slot) rather than
      // racing a concurrent writer between this recheck and the write below.
      let lockHandle: { release: () => void };
      try {
        lockHandle = acquireMutationLock(deps.dataDir);
      } catch (err) {
        if (err instanceof MutationLockBusyError) {
          axisEvalByType.set(taskType, { ...evalRecord, eligible: false, reasons: [...evalRecord.reasons, err.message] });
          continue;
        }
        throw err;
      }

      try {
        // 4c. Finding 1 (round 1, re-verified UNDER the lock per round 3 finding 2): refuse if the
        // live table changed since this tick's REVIEW baseline was read.
        const liveRawNow = tryReadLiveTable(deps.adoptDeps);
        if (tableContentHash(liveRawNow) !== baselineHash) {
          axisEvalByType.set(taskType, {
            ...evalRecord,
            eligible: false,
            reasons: [
              ...evalRecord.reasons,
              "table-changed-since-baseline: the live routing table was mutated after this tick's REVIEW baseline was read — refusing to adopt against a stale artifact",
            ],
          });
          continue;
        }

        // This IS the one axis this tick attempts — the rotation loop stops after this iteration
        // regardless of the eventual outcome (success or failure both consume the slot).
        const approval = approveArtifact(axisArtifact, {
          approvedBy: `${AUTONOMY_APPROVER_PREFIX}${tierState.tier}`,
          reason: `autonomy-controller tick ${now}: ${statDetailByType.get(taskType) ?? ""}`,
          decisionRef: deps.decisionRef,
          approvedAt: now,
        });

        // 4d. Finding 2 (round 1) + finding 1 (round 3 phase tracking): journal the INTENT durably
        // BEFORE the mutating call, then wrap `adoptDeps` so each phase (table-written, reloaded)
        // is ALSO persisted the instant it happens inside `adoptRoutingTable`'s own sequence.
        const intentId = randomUUID();
        const intent: AdoptionIntent = {
          schemaVersion: 1,
          id: intentId,
          createdAt: now,
          taskType,
          candidateHash: axisArtifact.candidateHash,
          decisionRef: deps.decisionRef,
          approvedBy: approval.approvedBy,
          tier: tierState.tier,
          priorRaw: liveRawNow,
          phase: "planned",
          status: "pending",
        };
        saveAdoptionIntent(deps.dataDir, intent);
        const instrumentedDeps = instrumentAdoptDepsForIntent(deps.adoptDeps, deps.dataDir, intentId);

        const outcome = await adoptRoutingTable(axisArtifact, approval, instrumentedDeps);
        let watchRecord: AdoptionWatchRecord | undefined;
        if (outcome.outcome === "adopted") {
          // Canary DID pass by construction of this outcome — mark it BEFORE recordAdoptionForWatch
          // so a crash in the remaining gap still reconciles as "finalize", never "restore".
          const afterAdopt = loadAdoptionIntent(deps.dataDir);
          if (afterAdopt && afterAdopt.id === intentId && afterAdopt.status === "pending") {
            saveAdoptionIntent(deps.dataDir, { ...afterAdopt, phase: "canary-passed" });
          }
          watchRecord = recordAdoptionForWatch({
            dataDir: deps.dataDir,
            adoptedAt: outcome.record.adoptedAt,
            candidateHash: outcome.record.candidateHash,
            decisionRef: outcome.record.decisionRef,
            approvedBy: outcome.record.approvedBy,
            changedTaskTypes: [taskType],
            priorRaw: liveRawNow,
            provenance: { kind: "autonomy", tier: tierState.tier },
          });
          const finalIntent = loadAdoptionIntent(deps.dataDir);
          if (finalIntent && finalIntent.id === intentId) {
            saveAdoptionIntent(deps.dataDir, {
              ...finalIntent,
              status: "finalized",
              finalizedAt: deps.nowIso(),
              watchRecordId: watchRecord.id,
            });
          }
        } else {
          // Finding 4 (round 1): a write/reload/rollback/canary failure is NOT a healthy cycle.
          // `adoptRoutingTable` already restored the prior bytes internally on this path.
          mutationAttemptFailed = true;
          const current = loadAdoptionIntent(deps.dataDir);
          if (current && current.id === intentId) {
            saveAdoptionIntent(deps.dataDir, {
              ...current,
              status: "aborted",
              abortedAt: deps.nowIso(),
              abortReason: `adoptRoutingTable outcome: ${outcome.outcome}`,
            });
          }
        }
        adopted.push({ taskType, outcome, watchRecord });
        axisEvalByType.set(taskType, { ...evalRecord, eligible: outcome.outcome === "adopted", attempted: true });
        if (!dryRun) saveRotationState(deps.dataDir, { schemaVersion: 1, lastAttemptedTaskType: taskType });
      } finally {
        lockHandle.release();
      }

      break; // exactly one attempt this tick, whatever its outcome
    }
  }

  const axisEvaluations = changedTaskTypes.map((t) => axisEvalByType.get(t)!);

  // Healthy-cycle bookkeeping (§6, finding 4, round 1): computed AFTER any mutation attempt — a
  // failed write/reload/rollback/canary, a stale-baseline abort, or a stale-gate refusal is NEVER a
  // healthy cycle, regardless of what the review artifact's own validation said.
  const anyInfraFailure = watch.items.some((i) => i.revert?.status === "unknown");
  const healthyCycle = fullArtifact.validation.ok && !anyBreach && !anyInfraFailure && !mutationAttemptFailed;
  if (healthyCycle) {
    tierState = { ...tierState, consecutiveHealthyCycles: tierState.consecutiveHealthyCycles + 1, lastCycleAt: now };
  } else if (!anyBreach) {
    // The breach path (1.5, above) already reset the streak when applicable; this covers every
    // OTHER unhealthy cause (invalid review, infra failure, failed mutation attempt) — breaks the
    // streak (not "consecutive" anymore) without itself being a demotion trigger.
    tierState = { ...tierState, consecutiveHealthyCycles: 0, lastCycleAt: now };
  }
  // Finding 4 (round 3): the SUSTAINED anchored-GO streak the Tier-2 unlock condition reads —
  // tracked independently of `consecutiveHealthyCycles` (a tick can be healthy without being GO,
  // which is the common case before Tier 2 is even relevant). The breach path already reset this
  // to 0 above when applicable.
  const isGoTick = deps.review.calibrationGate?.verdict === "GO";
  if (isGoTick) {
    tierState = { ...tierState, consecutiveGoCycles: tierState.consecutiveGoCycles + 1 };
  } else if (!anyBreach) {
    tierState = { ...tierState, consecutiveGoCycles: 0 };
  }

  // 6. TIER LADDER — promotion only (demotion already applied + durably persisted in step 1.5;
  // never evaluated under the kill switch). May itself write the Tier-2 ladder-enablement record
  // (finding 4, round 3) — see `maybePromote`'s own doc comment.
  if (!killSwitchActive && !tierEvent) {
    const revertRate = computeAutonomousRevertRate(loadWatchdogState(deps.dataDir).records);
    const promotion = maybePromote(tierState, now, policy, deps.dataDir, deps.decisionRef, revertRate);
    if (promotion) {
      tierEvent = promotion.event;
      tierState = promotion.state;
    }
  }

  // Standing proposal (#46 subsumed): refresh whenever a real proposal remains unresolved this
  // tick — Tier 0 always; a kill-switch/dry-run tick where nothing was actually adopted; more than
  // one changed axis (at most one is ever adopted per tick); or the one attempted axis failed.
  const fullyResolved =
    !noop && changedTaskTypes.length === 1 && adopted.length === 1 && adopted[0]!.outcome.outcome === "adopted";
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
    // Finding 7 (round 3): never append the SAME demotion event a second time — only a genuinely
    // new (promotion) event reaches this point unpersisted.
    if (tierEvent && !tierEventAlreadyPersisted) appendTierEvent(deps.dataDir, tierEvent);
    saveStandingProposal(deps.dataDir, standingProposal);
  }

  // 8. NOTIFICATION — content-blind summary, after any adopt/revert/tier-change/failed attempt.
  const anyAdopted = adopted.some((a) => a.outcome.outcome === "adopted");
  if (!dryRun && deps.notify && (anyAdopted || anyBreach || tierEvent !== null || mutationAttemptFailed)) {
    const summary = {
      at: now,
      tier: { before: tierBefore, after: tierState.tier, event: tierEvent },
      adopted: adopted.filter((a) => a.outcome.outcome === "adopted").map((a) => a.taskType),
      mutationAttemptFailed,
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
