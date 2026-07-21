/**
 * routing-lifecycle.ts — the reviewed GENERATE → VALIDATE → REVIEW → DEPLOY/RELOAD → CANARY →
 * ROLLBACK lifecycle around the existing routing-table primitives (issue #7).
 *
 * PRODUCTION-ROUTING-MUTATION: this module is the load-bearing safety seam between "evidence
 * changed" and "production routing changed". It does not reimplement generation (`generateRoutingTable`,
 * routing-table-generator.ts), diffing (`diffRoutingTables`/`formatRoutingDiff`, routing-table-diff.ts),
 * or the reader (`loadRoutingTable`/`routingTarget`/`resetRoutingTable`, routing-table.ts) — it
 * orchestrates them behind a human approval gate that is impossible to bypass by construction:
 *
 *   - `prepareReview` is PURE and NEVER mutates anything — it builds a machine-readable decision
 *     artifact (candidate hash, human diff, per-route evidence lineage, validation result, the #6
 *     calibration-gate verdict consulted) and stops. This is the dry-run/default path.
 *   - `approveArtifact` is the ONLY way to produce an `ApprovalToken`, and it REFUSES to approve an
 *     artifact whose validation failed (mirrors calibration-gate.ts's `attachReviewedDecision`
 *     refusing a HOLD gate — a human cannot "approve past" a measured refusal).
 *   - `adoptRoutingTable` REQUIRES an `ApprovalToken` argument (the TypeScript signature has no
 *     zero-approval overload) and cryptographically binds the token to the EXACT artifact content
 *     (`artifactContentHash`) before doing anything — an approval for a different candidate, or a
 *     hand-typed token, is rejected. It then snapshots the current live table, writes the new one,
 *     triggers an in-process gateway reload (no restart), runs a content-blind canary over the
 *     CHANGED routes, and rolls back to the EXACT prior bytes on any failure.
 *
 * #6 admissibility (calibration-gate.ts): harvest-derived / organic-judge evidence (the harvest
 * judge's `llm-judge:<model>` verifier — see harvest.ts, calibration-sample.ts's `verifierClassOf`)
 * is admissible to DRIVE A ROUTE CHANGE only when the current `CalibrationGateDecision` is
 * `verdict === "GO" && enabling !== null`. This module detects that case by diffing the CANDIDATE
 * table against a second candidate generated with organic-judge evidence excluded
 * (`ledgerReport(policy, { excludeOrganicJudge: true })`, see ledger.ts): a route change that
 * disappears once organic-judge evidence is removed is "organic-judge-dependent", and is refused
 * unless the gate admits it. A verifier-backed/deterministic change survives the exclusion and is
 * never gated by this rule — this is what lets a HOLD gate block one class of change while allowing
 * the other (AC: "no route changes merely because new shadow evidence exists").
 *
 * Deliberately DB/fs-injected (not imported) everywhere except the tiny amount of IO that IS the
 * deploy mechanism itself (`adoptRoutingTable`'s `deps.readTable`/`writeTable`/`reload`) — same
 * purity discipline as routing-table-generator.ts, with the IO composition root in
 * `scripts/routing-lifecycle-cli.ts` and the gateway's `/admin/routing-table/reload` endpoint.
 */

import { contentDigest, isVerifiedEnoentError, tableContentHash } from "./evidence-identity.js";
import { fencedWrite, renewMutationLock, MutationLockStaleError } from "./mutation-lock.js";
import { generateRoutingTable, type RoutingTableDoc } from "./routing-table-generator.js";
import {
  diffRoutingTables,
  formatRoutingDiff,
  type RoutingTableDiff,
  type DiffableRoutingTable,
} from "./routing-table-diff.js";
import { routingTarget, FRONTIER, UNKNOWN_ROUTE, type RoutingTable } from "./routing-table.js";
import type { CalibrationGateDecision } from "./calibration-gate.js";

export type { RoutingTableDoc };

// ─── Validation ─────────────────────────────────────────────────────────────────

export type ValidationCode =
  | "taxonomy-incomplete"
  | "model-unavailable"
  | "evidence-stale"
  | "capability-downgrade"
  | "policy-epoch-mismatch"
  | "inadmissible-organic-evidence";

export interface ValidationIssue {
  code: ValidationCode;
  taskType?: string;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface RouteLineage {
  taskType: string;
  model: string | null;
  verdict: string;
  attempts: number;
  /**
   * True iff this task type's route CHANGED vs the adopted table, and the change disappears when
   * organic-judge evidence is excluded — i.e. the change is explained ONLY by harvest-derived
   * evidence (the #6 admissibility class this module gates).
   */
  organicJudgeDependent: boolean;
}

export interface CalibrationGateSummary {
  policyId: string;
  generatedAt: string;
  verdict: "HOLD" | "GO";
  enabled: boolean;
}

export function summarizeCalibrationGate(gate: CalibrationGateDecision | null): CalibrationGateSummary | null {
  if (gate === null) return null;
  return { policyId: gate.policyId, generatedAt: gate.generatedAt, verdict: gate.verdict, enabled: gate.enabling !== null };
}

/**
 * The single #6 admissibility test: a route change explained only by organic-judge evidence may
 * proceed iff the gate is a measured `GO` with a recorded reviewed enablement. A `null` gate (none
 * consulted) or a `HOLD` gate is MOST RESTRICTIVE — never permissive — by construction: both fall
 * through to `false` here, never `true`.
 *
 * Exported (rather than left as validateCandidate's private inline expression) so
 * `scripts/routing-lifecycle-cli.ts`'s adopt-time re-validation (issue #37 — recomputing the LIVE
 * gate immediately before a mutating adopt, as defense-in-depth alongside the policy-epoch staleness
 * check) uses this EXACT same definition instead of a second, independently-maintained copy that
 * could silently diverge from validateCandidate's own rule.
 */
export function gateAdmitsOrganicEvidence(gate: CalibrationGateSummary | null): boolean {
  return gate !== null && gate.verdict === "GO" && gate.enabled;
}

export interface ValidateCandidateInputs {
  candidate: RoutingTableDoc;
  /** Semantic diff of `candidate` vs the currently-adopted table (see diffRoutingTables). */
  diff: RoutingTableDiff;
  /** Same diff, but against a candidate generated with organic-judge evidence excluded — the #6 probe. */
  deterministicDiff: RoutingTableDiff;
  /** Currently servable model ids, or null when the serving catalogue was unavailable (fail closed). */
  servableModelIds: string[] | null;
  /** Task types that must be present in `candidate.routing` (routableTaskTypes()). */
  requiredTaskTypes: string[];
  /** Candidate must be no older than this many ms as of `nowIso`. */
  freshnessMaxAgeMs: number;
  nowIso: string;
  calibrationGate: CalibrationGateSummary | null;
  /** Content digest of the routing PolicyConfig used to generate `candidate`. */
  policyEpochHash: string;
  /** Content digest of the CURRENT routing PolicyConfig (may differ for a stored, re-reviewed artifact). */
  expectedPolicyEpochHash: string;
}

export interface ValidateCandidateResult {
  issues: ValidationIssue[];
  lineage: RouteLineage[];
}

/**
 * The consolidated, fail-closed VALIDATE gate. Every check below is additive — a candidate is
 * refused (ok=false) if ANY check fails, and every failure names its exact task type/reason rather
 * than a generic message, so a broken or stale candidate is refused BEFORE any production mutation
 * with a diagnosable cause.
 */
export function validateCandidate(p: ValidateCandidateInputs): ValidateCandidateResult {
  const issues: ValidationIssue[] = [];

  // 1. Taxonomy completeness — every routable task type must be present (own-property; a
  //    prototype-named type like "__proto__" must not silently resolve via inheritance).
  for (const taskType of p.requiredTaskTypes) {
    if (!Object.prototype.hasOwnProperty.call(p.candidate.routing, taskType)) {
      issues.push({
        code: "taxonomy-incomplete",
        taskType,
        detail: `required task type '${taskType}' is missing from the candidate routing table — a routable taxonomy value cannot be silently omitted`,
      });
    }
  }

  // 2. Served-model availability — fail CLOSED when the catalogue itself is unavailable (never
  //    silently keep a possibly-stale model id), and refuse any route naming a model that is not
  //    currently in the servable set.
  for (const [taskType, entry] of Object.entries(p.candidate.routing)) {
    if (entry.model === null) continue;
    if (p.servableModelIds === null) {
      issues.push({
        code: "model-unavailable",
        taskType,
        detail: `serving catalogue unavailable — cannot verify '${entry.model}' is currently served; refusing to trust a possibly-stale model id (fail closed)`,
      });
    } else if (!p.servableModelIds.includes(entry.model)) {
      issues.push({
        code: "model-unavailable",
        taskType,
        detail: `route names model '${entry.model}' which is not in the current served-model catalogue (${p.servableModelIds.length} model(s) servable)`,
      });
    }
  }

  // 3. Evidence freshness.
  const generatedAtMs = Date.parse(p.candidate.generatedAt);
  const nowMs = Date.parse(p.nowIso);
  const ageMs = nowMs - generatedAtMs;
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > p.freshnessMaxAgeMs) {
    issues.push({
      code: "evidence-stale",
      detail: `candidate generatedAt=${p.candidate.generatedAt} is ${
        Number.isFinite(ageMs) && ageMs >= 0 ? `${Math.round(ageMs / 1000)}s` : "unparseable/negative-age"
      } old — exceeds the ${Math.round(p.freshnessMaxAgeMs / 1000)}s freshness bound`,
    });
  }

  // 4. Downgrade guards — reuse diffRoutingTables' own capability-regression classification
  //    (verdictRank) rather than re-deriving it; every downgrade is a refusal, not merely a warning.
  for (const d of p.diff.downgrades) {
    issues.push({ code: "capability-downgrade", taskType: d.taskType, detail: d.detail });
  }

  // 5. Policy epoch — the candidate must have been generated under the CURRENT routing policy.
  if (p.policyEpochHash !== p.expectedPolicyEpochHash) {
    issues.push({
      code: "policy-epoch-mismatch",
      detail: `candidate was generated under policy epoch ${p.policyEpochHash} but the current policy epoch is ${p.expectedPolicyEpochHash} — regenerate the candidate against the current policy before reviewing/adopting it`,
    });
  }

  // 6. #6 admissibility — a route change explained ONLY by organic-judge evidence requires an
  //    enabled GO gate; a verifier-backed/deterministic change is never gated by this rule.
  //
  //    "Survives without organic evidence" means: regenerating with organic-judge evidence
  //    EXCLUDED reaches the SAME final route (model + verdict) as the full candidate — not merely
  //    "the deterministic diff also shows *some* change vs adopted". A type absent from the adopted
  //    table always classifies as `kind: "added"` in BOTH diffs regardless of what it was added AS,
  //    so comparing diff *kinds* would wrongly call an organic-only escalate-frontier "added" the
  //    same as a organic-driven delegate-local "added" — comparing the `after` SNAPSHOTS directly is
  //    the correct, kind-independent test.
  const gateAdmits = gateAdmitsOrganicEvidence(p.calibrationGate);
  const changedEntries = p.diff.changes.filter((c) => c.kind !== "unchanged");
  const deterministicAfterByType = new Map(p.deterministicDiff.changes.map((c) => [c.taskType, c.after]));
  const organicDependent = new Set<string>();
  for (const c of changedEntries) {
    const taskType = c.taskType;
    const detAfter = deterministicAfterByType.get(taskType) ?? null;
    const survivesWithoutOrganicEvidence =
      detAfter !== null && c.after !== null && detAfter.model === c.after.model && detAfter.verdict === c.after.verdict;
    if (survivesWithoutOrganicEvidence) continue; // verifier-backed/deterministic evidence alone explains it
    organicDependent.add(taskType);
    if (!gateAdmits) {
      issues.push({
        code: "inadmissible-organic-evidence",
        taskType,
        detail: `route change for '${taskType}' is explained only by harvest-derived/organic-judge evidence, which is inadmissible to drive a route change unless the #6 calibration gate is GO with a recorded reviewed enablement (current: ${
          p.calibrationGate
            ? `${p.calibrationGate.verdict}${p.calibrationGate.enabled ? "+enabled" : ""}`
            : "no gate consulted"
        })`,
      });
    }
  }

  const lineage: RouteLineage[] = Object.entries(p.candidate.routing).map(([taskType, entry]) => ({
    taskType,
    model: entry.model,
    verdict: entry.verdict,
    attempts: entry.attempts,
    organicJudgeDependent: organicDependent.has(taskType),
  }));

  return { issues, lineage };
}

// ─── Decision artifact (REVIEW stage) ────────────────────────────────────────────

export interface RoutingDecisionArtifact {
  schemaVersion: 1;
  generatedAt: string;
  candidateHash: string;
  adoptedHash: string | null;
  policyEpochHash: string;
  diff: RoutingTableDiff;
  humanDiff: string;
  validation: ValidationResult;
  calibrationGate: CalibrationGateSummary | null;
  lineage: RouteLineage[];
  candidate: RoutingTableDoc;
}

export interface BuildArtifactInputs {
  candidate: RoutingTableDoc;
  /** A second candidate generated identically but with organic-judge evidence excluded — the #6 probe. */
  deterministicCandidate: RoutingTableDoc;
  /** Currently-adopted live table, parsed, or null when none exists yet (first-ever adoption). */
  adopted: DiffableRoutingTable | null;
  servableModelIds: string[] | null;
  requiredTaskTypes: string[];
  freshnessMaxAgeMs: number;
  nowIso: string;
  calibrationGate: CalibrationGateDecision | null;
  policyEpochHash: string;
  expectedPolicyEpochHash: string;
}

/**
 * PURE. Builds the machine-readable decision artifact: candidate hash, human-readable diff,
 * per-route evidence lineage, the consolidated validation result, and the #6 gate consulted. Never
 * touches disk, never mutates production state — this is the entire content of the default/dry-run
 * path (AC: a broken/stale candidate is refused before ANY production mutation, because nothing here
 * performs one).
 */
export function buildDecisionArtifact(inputs: BuildArtifactInputs): RoutingDecisionArtifact {
  const candidateHash = contentDigest(JSON.stringify(inputs.candidate));
  const adoptedHash = inputs.adopted !== null ? contentDigest(JSON.stringify(inputs.adopted)) : null;
  const diff = diffRoutingTables(inputs.adopted ?? {}, inputs.candidate);
  const deterministicDiff = diffRoutingTables(inputs.adopted ?? {}, inputs.deterministicCandidate);
  const calibrationGate = summarizeCalibrationGate(inputs.calibrationGate);

  const { issues, lineage } = validateCandidate({
    candidate: inputs.candidate,
    diff,
    deterministicDiff,
    servableModelIds: inputs.servableModelIds,
    requiredTaskTypes: inputs.requiredTaskTypes,
    freshnessMaxAgeMs: inputs.freshnessMaxAgeMs,
    nowIso: inputs.nowIso,
    calibrationGate,
    policyEpochHash: inputs.policyEpochHash,
    expectedPolicyEpochHash: inputs.expectedPolicyEpochHash,
  });

  return {
    schemaVersion: 1,
    generatedAt: inputs.nowIso,
    candidateHash,
    adoptedHash,
    policyEpochHash: inputs.policyEpochHash,
    diff,
    humanDiff: formatRoutingDiff(diff),
    validation: { ok: issues.length === 0, issues },
    calibrationGate,
    lineage,
    candidate: inputs.candidate,
  };
}

/**
 * The dry-run/default entry point (GENERATE + VALIDATE + REVIEW, stops at the approval gate).
 * Thin, obviously-pure wrapper over `buildDecisionArtifact` — kept as a separate name so call sites
 * (CLI/tests) can say "prepareReview" and mean exactly "produce artifact + diff, mutate nothing".
 */
export function prepareReview(inputs: BuildArtifactInputs): RoutingDecisionArtifact {
  return buildDecisionArtifact(inputs);
}

// ─── Approval (the non-bypassable gate) ──────────────────────────────────────────

export interface ApprovalDecisionInput {
  approvedBy: string;
  reason: string;
  decisionRef: string;
  approvedAt: string;
}

export interface ApprovalToken extends ApprovalDecisionInput {
  /** Binds this token to the EXACT artifact it was issued for — see artifactContentHash. */
  artifactHash: string;
}

export class ApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRefusedError";
  }
}

export class ApprovalMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalMismatchError";
  }
}

export class PolicyEpochStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEpochStaleError";
  }
}

/** Content hash binding an approval to the artifact's decision-relevant content (candidate, diff,
 *  validation) — an approval computed from this hash cannot be replayed against a different
 *  candidate, a different diff, or a since-changed validation result. */
export function artifactContentHash(artifact: RoutingDecisionArtifact): string {
  return contentDigest(
    JSON.stringify({
      schemaVersion: artifact.schemaVersion,
      candidateHash: artifact.candidateHash,
      adoptedHash: artifact.adoptedHash,
      policyEpochHash: artifact.policyEpochHash,
      diff: artifact.diff,
      validation: artifact.validation,
    })
  );
}

/**
 * The ONLY way an `ApprovalToken` is ever produced. Mirrors calibration-gate.ts's
 * `attachReviewedDecision`: refuses outright when the artifact's own validation failed — a human
 * cannot "approve past" a measured refusal; the correct remedy is fixing the underlying cause and
 * regenerating the candidate, never overriding validation here.
 */
export function approveArtifact(artifact: RoutingDecisionArtifact, decision: ApprovalDecisionInput): ApprovalToken {
  if (!artifact.validation.ok) {
    throw new ApprovalRefusedError(
      `routing-lifecycle: refusing to approve an artifact that failed validation (${artifact.validation.issues
        .map((i) => i.code)
        .join(", ")}) — fix the underlying issue(s) and regenerate the candidate; validation is never overridden by approval.`
    );
  }
  const trimmed = {
    approvedBy: decision.approvedBy.trim(),
    reason: decision.reason.trim(),
    decisionRef: decision.decisionRef.trim(),
    approvedAt: decision.approvedAt,
  };
  if (!trimmed.approvedBy || !trimmed.reason || !trimmed.decisionRef) {
    throw new ApprovalRefusedError(
      "routing-lifecycle: approval requires non-empty approvedBy, reason, and decisionRef."
    );
  }
  return { ...trimmed, artifactHash: artifactContentHash(artifact) };
}

function assertApprovalBindsArtifact(artifact: RoutingDecisionArtifact, approval: ApprovalToken): void {
  const expected = artifactContentHash(artifact);
  if (approval.artifactHash !== expected) {
    throw new ApprovalMismatchError(
      `routing-lifecycle: approval token does not match this exact candidate artifact (expected ${expected}, got ${approval.artifactHash}) — the approval was issued for a different candidate/diff/validation. Regenerate the review artifact and obtain a fresh approval; refusing to adopt.`
    );
  }
}

// ─── Canary ───────────────────────────────────────────────────────────────────────

export interface CanaryCheckResult {
  taskType: string;
  expectedTarget: string;
  actualTarget: string;
  ok: boolean;
  detail: string;
}

export interface CanaryOutcome {
  ok: boolean;
  checks: CanaryCheckResult[];
}

/**
 * Content-blind, cheap canary: for every task type whose route CHANGED, assert (a) the freshly
 * RELOADED table resolves it to the intended target (catches a reload bug — the write succeeded but
 * the live process didn't pick it up correctly) and (b) that target's model is in the freshly
 * re-checked servable set (catches a model that became unavailable between validate and deploy). No
 * task content is read or sent anywhere — this only inspects structural routing identities.
 */
export function runCanary(p: {
  changedTaskTypes: string[];
  reloadedTable: RoutingTable;
  candidate: RoutingTableDoc;
  servableModelIds: string[] | null;
}): CanaryOutcome {
  const candidateTable: RoutingTable = { routing: p.candidate.routing, escalateToFrontier: p.candidate.escalateToFrontier };
  const checks: CanaryCheckResult[] = p.changedTaskTypes.map((taskType) => {
    const expected = routingTarget(taskType, candidateTable);
    const actual = routingTarget(taskType, p.reloadedTable);
    const namesRealModel = expected !== FRONTIER && expected !== UNKNOWN_ROUTE;
    const servable = !namesRealModel || (p.servableModelIds !== null && p.servableModelIds.includes(expected));
    const resolvesAsIntended = expected === actual;
    const ok = resolvesAsIntended && servable;
    const detail = ok
      ? `resolves to ${actual} as intended`
      : !resolvesAsIntended
        ? `expected ${expected}, reloaded table resolves to ${actual}`
        : `expected ${expected} is not in the currently servable model set (fail closed)`;
    return { taskType, expectedTarget: expected, actualTarget: actual, ok, detail };
  });
  return { ok: checks.every((c) => c.ok), checks };
}

// ─── Deploy / reload / rollback (ADOPT) ──────────────────────────────────────────

export interface ReloadOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Round 7 follow-up (a): accepts an optional `AbortSignal` so `reloadAndRenew`'s timeout branch can
 * actually CANCEL the losing reload attempt, not just stop waiting on it. A bare `Promise.race`
 * (the pre-round-7 shape) never cancels its loser — an unbounded/slow `fetch` kept running in the
 * background even after the timeout branch "won", wasting a connection and risking a late,
 * unobserved side effect. Implementations that ignore the signal (e.g. test fakes) remain valid;
 * the parameter is additive.
 */
export type ReloadFn = (signal?: AbortSignal) => Promise<ReloadOutcome> | ReloadOutcome;

export interface AdoptDeps {
  tablePath: string;
  readTable: (path: string) => string;
  writeTable: (path: string, data: string) => void;
  /** Triggers the LIVE gateway process to pick up the new file without a restart — in production
   *  this is an authenticated call to POST /admin/routing-table/reload; tests may inject an
   *  in-process resetRoutingTable()+loadRoutingTable() call instead. */
  reload: ReloadFn;
  /** Freshly re-checked servable-model catalogue, read AFTER reload (for the canary). */
  servableModelIdsAfterReload: () => Promise<string[] | null> | string[] | null;
  nowIso: () => string;
  /** Current routing-policy epoch hash, recomputed at adopt time (see PolicyEpochStaleError). */
  currentPolicyEpochHash: string;
  /**
   * Optional (gille-inference#49 round 4 finding 11): called synchronously immediately after the
   * post-reload canary passes, BEFORE `adoptRoutingTable` returns its `"adopted"` outcome to the
   * caller. Exists so a caller journaling adoption phases (`autonomy-controller.ts`'s
   * `instrumentAdoptDepsForIntent`) can persist "canary-passed" AT THE INSTANT it becomes true,
   * closing the crash window between canary success and the awaited call unwinding back to the
   * caller — marking the phase only AFTER `adoptRoutingTable` returns would leave the journal at
   * "reloaded" if the process died in that window, and crash-recovery would then roll back a table
   * that had already been canary-confirmed.
   */
  onCanaryPassed?: () => void;
  /**
   * Optional (gille-inference#49 round 4 finding 2): deletes the table file outright. Only ever
   * needed to restore a "first-ever adoption" (no prior snapshot existed) that must be undone —
   * `performRollback`'s own internal rollback intentionally leaves such a table live-as-is
   * (out of scope for this change; see its doc comment), but `autonomy-controller.ts`'s crash-
   * recovery reconciliation (`reconcileAdoptionIntent`) must actually remove a bad first-ever
   * write rather than abort-in-place. Omitted by production deps that never exercise that path is
   * a caller bug, not a silent no-op — `deleteTableAndReload` below reports it as a failed restore.
   */
  deleteTable?: (path: string) => void;
  /**
   * Round 6 finding 1: when present, EVERY filesystem mutation this module performs through these
   * deps (`writeTable`/`deleteTable`, in `adoptRoutingTable`'s candidate write, `performRollback`'s
   * restore write, and `deleteTableAndReload`'s delete) is routed through `fencedWrite` — the token
   * check and the write commit inside ONE SQLite transaction, never a separate check-then-write.
   * Set this on the deps object itself (not passed as a call-by-call opt) so it automatically
   * covers every write path a caller's `deps` flows through, including ones this module calls
   * internally (`manualRollback`/`deleteTableAndReload` reached via `performRollback`) — the manual
   * CLI `adopt`/`rollback` commands set this via `buildAdoptDeps`'s lease-aware construction, and
   * the autonomy controller sets it on its own instrumented deps, both AFTER acquiring the lease
   * (the token is not known before that). Omitted entirely (no lease context at all) means NO
   * fencing — reserved for call sites that are not lease-protected at all (there are none left in
   * production; kept optional so this is additive, not a breaking signature change).
   */
  leaseContext?: { dataDir: string; token: number };
}

export interface AdoptionRecord {
  adoptedAt: string;
  candidateHash: string;
  approvedBy: string;
  decisionRef: string;
  reason: string;
  policyEpochHash: string;
  lineage: RouteLineage[];
}

export interface RollbackRecord {
  rolledBackAt: string;
  reason: string;
  /** sha256 content digest of the EXACT bytes restored, or a sentinel when no prior table existed. */
  restoredHash: string;
  /**
   * False iff the restore WRITE itself threw (e.g. disk full while writing back the prior bytes) —
   * the most severe failure mode this module can hit: the candidate write already happened, and
   * now the safety net that restores the prior table failed too. Never thrown past this function;
   * always surfaced as a structured field so a caller sees "rollback ALSO failed, manual recovery
   * required" instead of an unhandled rejection with no actionable record.
   */
  restoreWriteOk: boolean;
  restoreWriteError?: string;
  /**
   * Round 6 finding 1: true iff the restore write was REFUSED (never even attempted) because
   * `fencedWrite` found the caller's lease token was no longer current. This is NOT an ordinary
   * write failure — `restoreWriteOk` is `false`, but the correct response is "the table is in an
   * UNRESOLVED state, requiring reconciliation under a FRESH lease", never a blind retry with this
   * same (superseded) token and never any other recovery attempt: "a stale holder must never roll
   * back" — this holder can no longer be sure it is not clobbering a newer holder's legitimate work.
   */
  staleLeaseRefused?: boolean;
  reloadOk: boolean;
  reloadError?: string;
}

export type AdoptOutcome =
  | { outcome: "adopted"; record: AdoptionRecord }
  | { outcome: "rolled-back"; record: AdoptionRecord; rollback: RollbackRecord; canary: CanaryOutcome }
  | { outcome: "reload-failed"; rollback: RollbackRecord }
  /** The candidate WRITE itself threw (e.g. disk full) — reload was never attempted. `rollback`
   *  still runs (best-effort restore of the prior bytes, which likely never left disk in the first
   *  place) so this outcome carries the same structured recovery record as every other failure. */
  | { outcome: "write-failed"; rollback: RollbackRecord };

/**
 * Round 6 finding 1: routes a filesystem mutation through `fencedWrite` when `deps.leaseContext` is
 * present (check-AND-write, one SQLite transaction), or runs it unfenced otherwise (no lease context
 * at all — never partially fenced). ALL of this module's filesystem writes go through this, so
 * `adoptRoutingTable`'s candidate write, `performRollback`'s restore write, and
 * `deleteTableAndReload`'s delete are uniformly protected whenever the caller's deps carry a lease.
 */
function withFencing<T>(deps: AdoptDeps, fn: () => T): T {
  if (deps.leaseContext) {
    return fencedWrite(deps.leaseContext.dataDir, deps.leaseContext.token, fn);
  }
  return fn();
}

const DEFAULT_RELOAD_TIMEOUT_MS = 30_000;

/**
 * Round 6 finding 1 (defense in depth): bounds `deps.reload()` with a timeout (the live gateway
 * reload is a network call; an unbounded hang here would hold the mutation lease open indefinitely,
 * denying every other caller) and, when `deps.leaseContext` is present, re-asserts/renews the lease
 * immediately after reload returns — a slow-but-successful reload can eat meaningfully into the
 * lease's staleness clock, and renewing here keeps it fresh for whatever fenced write happens next
 * in THIS SAME call (e.g. a canary-failure rollback). Renewal is best-effort and never throws: if
 * the token has already been superseded, the renewal is simply a no-op — the NEXT `fencedWrite` in
 * this call correctly refuses with `MutationLockStaleError` regardless of whether renewal ran.
 *
 * Exported (round 7 follow-up (a)) so its `AbortController`-on-timeout behavior is directly unit
 * testable with a short `timeoutMs`, rather than only reachable through `manualRollback`/
 * `adoptRoutingTable`'s fixed 30s default.
 */
export async function reloadAndRenew(deps: AdoptDeps, timeoutMs = DEFAULT_RELOAD_TIMEOUT_MS): Promise<ReloadOutcome> {
  // Round 7 follow-up (a): a real `AbortController` wired to the timeout, not just `Promise.race` —
  // `Promise.race` alone never cancels its loser; the losing `deps.reload()` call would keep running
  // (and could still "land late", e.g. writing something or holding a socket open) even after this
  // function had already returned a timeout failure to its caller.
  const controller = new AbortController();
  let result: ReloadOutcome;
  try {
    result = await Promise.race([
      Promise.resolve(deps.reload(controller.signal)),
      new Promise<ReloadOutcome>((resolve) => {
        setTimeout(() => {
          controller.abort();
          resolve({ ok: false, error: `gateway reload timed out after ${timeoutMs}ms` });
        }, timeoutMs).unref?.();
      }),
    ]);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (deps.leaseContext) {
    try {
      renewMutationLock(deps.leaseContext.dataDir, deps.leaseContext.token);
    } catch {
      // Best-effort keep-alive only — never let a renewal hiccup mask the reload's own result.
    }
  }
  return result;
}

/**
 * Restores `priorRaw` (exact bytes) and reloads. NEVER throws — every IO step is caught and folded
 * into the returned `RollbackRecord`, because this is the function everything else calls when
 * something has ALREADY gone wrong; if it can also throw, a caller has no safe way to react (an
 * uncaught rejection here would surface as a crash with no structured "what is the table's state
 * now" answer, which is the worst possible outcome on the PRODUCTION-ROUTING-MUTATION seam).
 *
 * Round 6 finding 1: the restore write is fenced (`withFencing`/`fencedWrite`) — and a REFUSED write
 * (`MutationLockStaleError`, this holder's lease is no longer current) is NEVER treated as an
 * ordinary write failure to retry or paper over. "A stale holder must never roll back": the record
 * comes back with `restoreWriteOk: false` AND `staleLeaseRefused: true`, and the reason says plainly
 * that the table is in an UNRESOLVED state requiring reconciliation under a fresh lease — never a
 * blind retry with this same (superseded) token.
 */
async function performRollback(p: {
  deps: AdoptDeps;
  priorRaw: string | null;
  reason: string;
}): Promise<RollbackRecord> {
  let restoreWriteOk = true;
  let restoreWriteError: string | undefined;
  let staleLeaseRefused = false;
  if (p.priorRaw !== null) {
    try {
      withFencing(p.deps, () => p.deps.writeTable(p.deps.tablePath, p.priorRaw as string));
    } catch (err) {
      restoreWriteOk = false;
      if (err instanceof MutationLockStaleError) {
        staleLeaseRefused = true;
      }
      restoreWriteError = err instanceof Error ? err.message : String(err);
    }
  }

  let reloadOk = true;
  let reloadError: string | undefined;
  try {
    const r = await reloadAndRenew(p.deps);
    reloadOk = r.ok;
    reloadError = r.error;
  } catch (err) {
    reloadOk = false;
    reloadError = err instanceof Error ? err.message : String(err);
  }

  const record: RollbackRecord = {
    rolledBackAt: p.deps.nowIso(),
    reason: staleLeaseRefused
      ? `${p.reason} — REFUSED: the mutation lease was no longer current when this rollback write was about to commit; a stale holder must never roll back. Table state is UNRESOLVED — requires reconciliation under a FRESH lease, never a retry with this same (superseded) token.`
      : restoreWriteOk
        ? p.reason
        : `${p.reason} — AND the rollback restore write itself failed (${restoreWriteError}); table is in an UNKNOWN state, manual recovery required`,
    restoredHash: p.priorRaw !== null ? contentDigest(p.priorRaw) : "(none — no prior table existed)",
    restoreWriteOk,
    // `reloadOk` reports what reload() actually returned (best-effort, attempted regardless of
    // restoreWriteOk) — a caller must check BOTH restoreWriteOk and reloadOk to know the table is
    // trustworthy; a true reloadOk after a failed restore write does not mean the RIGHT table loaded.
    reloadOk,
  };
  return {
    ...record,
    ...(staleLeaseRefused ? { staleLeaseRefused: true } : {}),
    ...(restoreWriteError ? { restoreWriteError } : {}),
    ...(reloadError ? { reloadError } : {}),
  };
}

/**
 * The ONLY function that mutates the production routing table. REQUIRES a real `ApprovalToken`
 * (the TypeScript signature has no zero-argument or optional-approval overload) and refuses
 * (throws, before any write) unless that token is bound to THIS EXACT artifact and the artifact's
 * own validation passed — defense in depth beyond `approveArtifact`'s own refusal, in case a caller
 * hand-constructs an artifact+token pair.
 *
 * Sequence: snapshot current bytes (for rollback) → write candidate → trigger live reload (no
 * restart) → run the content-blind canary over changed routes → on ANY failure, restore the EXACT
 * prior bytes, reload again, and record a rollback event with reason. A successful adoption records
 * the adopted candidate hash, approver identity, and full per-route evidence lineage.
 */
export async function adoptRoutingTable(
  artifact: RoutingDecisionArtifact,
  approval: ApprovalToken,
  deps: AdoptDeps,
  opts: {
    verifiedPriorRaw?: string | null;
    /** Round 5 follow-up (defense in depth alongside `deps.leaseContext`'s fencing): the caller's
     *  OWN content hash of `verifiedPriorRaw` at the moment it was captured (e.g.
     *  `tableContentHash(liveRawNow)`, already computed for the caller's own staleness recheck) —
     *  a pure, no-IO cross-check that the value threaded through as `verifiedPriorRaw` is really
     *  what the caller believes it is (catches a caller-side wiring bug, e.g. the wrong variable
     *  threaded through), never a substitute for the lease's own concurrency guarantee. */
    verifiedPriorRawHash?: string;
  } = {}
): Promise<AdoptOutcome> {
  assertApprovalBindsArtifact(artifact, approval);
  if (!artifact.validation.ok) {
    throw new ApprovalRefusedError(
      "routing-lifecycle: refusing to adopt — artifact failed validation; this should be unreachable via approveArtifact and indicates a hand-constructed bypass attempt."
    );
  }
  if (artifact.policyEpochHash !== deps.currentPolicyEpochHash) {
    throw new PolicyEpochStaleError(
      `routing-lifecycle: refusing to adopt — the routing policy changed since this artifact was reviewed (artifact epoch ${artifact.policyEpochHash}, current epoch ${deps.currentPolicyEpochHash}). Regenerate and re-review the candidate against the current policy.`
    );
  }

  const candidateJson = JSON.stringify(artifact.candidate, null, 2) + "\n";
  // Round 4 finding 4: a caller that has ALREADY captured a verified snapshot of the live table
  // this same tick (autonomy-controller.ts's journal, taken under the mutation lock immediately
  // before this call) passes it via `opts.verifiedPriorRaw` so this function does NOT re-read —
  // avoiding a second, independent read whose own error-handling could silently disagree with the
  // caller's. Absent that, this reads for itself — and, unlike the pre-fix version, only treats a
  // VERIFIED ENOENT as "no prior table" (first-ever adoption); any other read error (permission
  // denied, disk fault, transient I/O) now PROPAGATES rather than being silently swallowed as
  // "no prior table", which could otherwise make a manual `adopt` skip a real rollback snapshot.
  const priorRaw =
    "verifiedPriorRaw" in opts
      ? (opts.verifiedPriorRaw ?? null)
      : (() => {
          try {
            return deps.readTable(deps.tablePath);
          } catch (err) {
            if (isVerifiedEnoentError(err)) return null; // no prior table on disk yet — first-ever adoption
            throw err;
          }
        })();

  // Round 5 follow-up: defensive, no-IO integrity check on a caller-supplied verifiedPriorRaw —
  // catches a caller-side wiring bug (e.g. the wrong variable threaded through), independent of
  // (and no substitute for) the fencing check inside `withFencing`/`fencedWrite` below.
  if ("verifiedPriorRaw" in opts && opts.verifiedPriorRawHash !== undefined) {
    const actualHash = tableContentHash(priorRaw);
    if (actualHash !== opts.verifiedPriorRawHash) {
      throw new Error(
        `routing-lifecycle: verifiedPriorRaw does not match its own claimed hash (expected ${opts.verifiedPriorRawHash}, got ${actualHash}) — refusing to trust a caller-supplied prior-table snapshot that fails its own integrity check.`
      );
    }
  }

  try {
    // Round 6 finding 1: the check (is `deps.leaseContext`'s token still current?) and the write
    // commit in ONE SQLite transaction via `withFencing`/`fencedWrite` — not a separate
    // `assertLeaseCurrent` call followed by an unfenced write. Throws `MutationLockStaleError`
    // (propagated) if the token was superseded; nothing has been written at that point, so the
    // caller's correct response is a clean abort (no rollback needed), never a recovery attempt.
    withFencing(deps, () => deps.writeTable(deps.tablePath, candidateJson));
  } catch (err) {
    if (err instanceof MutationLockStaleError) throw err;
    // The candidate write itself threw (e.g. disk full) — reload was never attempted. Route
    // through the SAME rollback primitive as every other failure so this is never an uncaught
    // rejection: best-effort restore of the prior bytes (which very likely never left disk, since
    // this write never completed) and a structured record, not a crash with no recovery signal.
    const rollback = await performRollback({
      deps,
      priorRaw,
      reason: `candidate write failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { outcome: "write-failed", rollback };
  }
  // Round 6 finding 1: bounded (timeout) + lease-renewing — see `reloadAndRenew`'s doc comment.
  const reloadResult = await reloadAndRenew(deps);

  if (!reloadResult.ok) {
    const rollback = await performRollback({
      deps,
      priorRaw,
      reason: `reload failed: ${reloadResult.error ?? "unknown error"}`,
    });
    return { outcome: "reload-failed", rollback };
  }

  const changedTaskTypes = artifact.diff.changes.filter((c) => c.kind !== "unchanged").map((c) => c.taskType);

  let reloadedTable: RoutingTable;
  try {
    const raw = deps.readTable(deps.tablePath);
    const parsed = JSON.parse(raw) as Partial<RoutingTable>;
    if (!parsed.routing || typeof parsed.routing !== "object") throw new Error("reloaded table has no routing object");
    reloadedTable = { routing: parsed.routing, escalateToFrontier: parsed.escalateToFrontier ?? [] };
  } catch (err) {
    const rollback = await performRollback({
      deps,
      priorRaw,
      reason: `post-reload table unreadable/corrupt: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { outcome: "reload-failed", rollback };
  }

  const servableModelIds = await deps.servableModelIdsAfterReload();
  const canary = runCanary({ changedTaskTypes, reloadedTable, candidate: artifact.candidate, servableModelIds });

  const record: AdoptionRecord = {
    adoptedAt: deps.nowIso(),
    candidateHash: artifact.candidateHash,
    approvedBy: approval.approvedBy,
    decisionRef: approval.decisionRef,
    reason: approval.reason,
    policyEpochHash: artifact.policyEpochHash,
    lineage: artifact.lineage,
  };

  if (!canary.ok) {
    const rollback = await performRollback({
      deps,
      priorRaw,
      reason: `canary failed: ${canary.checks
        .filter((c) => !c.ok)
        .map((c) => `${c.taskType}: ${c.detail}`)
        .join("; ")}`,
    });
    return { outcome: "rolled-back", record, rollback, canary };
  }

  // Round 4 finding 11: fire BEFORE returning — see `AdoptDeps.onCanaryPassed`'s doc comment.
  deps.onCanaryPassed?.();

  return { outcome: "adopted", record };
}

/**
 * The documented MANUAL rollback command (AC: "restores the exact prior table + reload + records a
 * rollback event ... automatic, plus one documented command"). Restores caller-supplied exact
 * snapshot bytes (e.g. read from a previously-recorded snapshot file) and reloads — same primitive
 * `adoptRoutingTable` uses internally for its automatic rollback, exposed directly for the
 * operator-invoked recovery path (scripts/routing-lifecycle-cli.ts's `rollback` subcommand).
 */
export async function manualRollback(p: { deps: AdoptDeps; snapshotRaw: string; reason: string }): Promise<RollbackRecord> {
  return performRollback({ deps: p.deps, priorRaw: p.snapshotRaw, reason: p.reason });
}

/**
 * Round 4 finding 2: the restore counterpart of `manualRollback` for the ONE case
 * `manualRollback`'s signature cannot represent — undoing a "first-ever adoption" (no prior
 * snapshot ever existed, so there is nothing to restore TO; the correct undo is deleting the
 * table entirely, then reloading so the live gateway state reflects "no table"). Used by
 * `autonomy-controller.ts`'s `reconcileAdoptionIntent` when recovering a crashed intent whose
 * `priorRaw` was `null`. Mirrors `performRollback`'s own never-throws, always-structured-record
 * contract: every IO step is caught and folded into the returned `RollbackRecord`, and
 * `restoreWriteOk` is `false` (with a `restoreWriteError` explaining why) both when the delete
 * itself throws AND when `deps.deleteTable` was never supplied at all — a caller MUST check
 * `restoreWriteOk` before treating this as a completed restore.
 *
 * Round 6: the delete is fenced the same way `performRollback`'s restore write is (a stale lease
 * refuses, never silently deletes on a superseded token — `staleLeaseRefused`). Round 6 follow-up:
 * a verified ENOENT (the table is ALREADY gone — e.g. a previous call's delete succeeded but the
 * process crashed before this function could record that) is treated as idempotent SUCCESS, not a
 * failure — deleting something that does not exist achieves the exact same end state the caller
 * wants ("no table"), so failing here would only make an already-correct outcome retry forever.
 */
export async function deleteTableAndReload(p: { deps: AdoptDeps; reason: string }): Promise<RollbackRecord> {
  let restoreWriteOk = true;
  let restoreWriteError: string | undefined;
  let staleLeaseRefused = false;
  if (p.deps.deleteTable) {
    try {
      withFencing(p.deps, () => p.deps.deleteTable!(p.deps.tablePath));
    } catch (err) {
      if (isVerifiedEnoentError(err)) {
        // Already gone — idempotent success, not a failure (round 6 follow-up).
      } else if (err instanceof MutationLockStaleError) {
        restoreWriteOk = false;
        staleLeaseRefused = true;
        restoreWriteError = err.message;
      } else {
        restoreWriteOk = false;
        restoreWriteError = err instanceof Error ? err.message : String(err);
      }
    }
  } else {
    restoreWriteOk = false;
    restoreWriteError = "AdoptDeps.deleteTable was not provided — cannot delete a first-ever-adoption table to restore it";
  }

  let reloadOk = true;
  let reloadError: string | undefined;
  try {
    const r = await reloadAndRenew(p.deps);
    reloadOk = r.ok;
    reloadError = r.error;
  } catch (err) {
    reloadOk = false;
    reloadError = err instanceof Error ? err.message : String(err);
  }

  const record: RollbackRecord = {
    rolledBackAt: p.deps.nowIso(),
    reason: staleLeaseRefused
      ? `${p.reason} — REFUSED: the mutation lease was no longer current when this delete was about to commit; a stale holder must never roll back. Table state is UNRESOLVED — requires reconciliation under a FRESH lease, never a retry with this same (superseded) token.`
      : restoreWriteOk
        ? p.reason
        : `${p.reason} — AND deleting the table failed (${restoreWriteError}); table is in an UNKNOWN state, manual recovery required`,
    restoredHash: "(deleted — first-ever adoption had no prior snapshot)",
    restoreWriteOk,
    reloadOk,
  };
  return {
    ...record,
    ...(staleLeaseRefused ? { staleLeaseRefused: true } : {}),
    ...(restoreWriteError ? { restoreWriteError } : {}),
    ...(reloadError ? { reloadError } : {}),
  };
}

// ─── GENERATE helper (thin, still pure) ──────────────────────────────────────────

/**
 * Convenience wrapper: builds BOTH the full-evidence candidate and the deterministic-only candidate
 * (organic-judge evidence excluded) that `buildDecisionArtifact` needs for the #6 admissibility
 * check, from the same generator inputs. Pure — `verdicts`/`deterministicVerdicts` must already be
 * two separately-queried ledger reads (full vs. `excludeOrganicJudge: true`); this function performs
 * no IO itself, matching routing-table-generator.ts's own purity contract.
 */
export function buildCandidatePair(
  inputs: Omit<Parameters<typeof generateRoutingTable>[0], "verdicts"> & {
    verdicts: Parameters<typeof generateRoutingTable>[0]["verdicts"];
    deterministicVerdicts: Parameters<typeof generateRoutingTable>[0]["verdicts"];
  }
): { candidate: RoutingTableDoc; deterministicCandidate: RoutingTableDoc } {
  const { deterministicVerdicts, ...rest } = inputs;
  return {
    candidate: generateRoutingTable(rest),
    deterministicCandidate: generateRoutingTable({ ...rest, verdicts: deterministicVerdicts }),
  };
}
