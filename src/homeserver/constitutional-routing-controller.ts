/**
 * ADR-008 constitutional micro-routing executor.
 *
 * This is the only autonomous route-writer path. It deliberately does not
 * reuse the legacy approval-token/adoption-watchdog path: that path remains
 * useful for shadow proposals and owner-driven adoption, but its journal and
 * recovery authority do not satisfy the ADR-008 v2 constitution.
 *
 * Security boundary:
 * - protected authority readers are injected and re-read immediately before
 *   apply and commit;
 * - the controller can CAS baseline -> candidate, but has no restore or
 *   runtime-narrowing signing capability;
 * - a separately composed watchdog receives a restore-only recovery
 *   capability and a pre-registered recovery-worker signer;
 * - the exact public journal-v2 envelope is the authoritative state machine.
 *   Raw baseline/candidate bytes live in a mode-0600 recovery sidecar bound by
 *   the journal digests and cannot affect authorization.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  canonicalJson,
  digestJson,
  validateJournalV2,
  validateJournalV2Prefix,
  verifyMicroRoutingTargetStateV2,
  verifyOwnerAuthorization,
  verifyRuntimeNarrowing,
  type OwnerAuthorizationInputs,
  type VerifiedAuthorization,
} from "./autonomy-contract-v1.js";
import {
  ConstitutionalFencedLease,
  constitutionalResourceExists,
  readConstitutionalResource,
  type ConstitutionalLeaseOptions,
} from "./constitutional-fenced-lease.js";
import type { CandidateRouteDeadline, RouteFence, RouteGuardOwner } from "./constitutional-route-database.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{2,62}$/;

export interface ConstitutionalRouteStore {
  read(): string;
  /** Acquires the lease stored beside the authoritative route value. */
  acquireWriterLease(options?: ConstitutionalLeaseOptions): RouteWriterLease;
  /**
   * Atomic with respect to every autonomous writer for this route table.
   * The authoritative resource MUST compare and persist this fence atomically
   * with the value mutation.
   */
  compareAndSwap(
    expected: string,
    next: string,
    fence: RouteFence,
    candidateDeadline?: CandidateRouteDeadline,
  ): boolean;
  /** Removes the serving deadline only after a durable exact commit. */
  clearCandidateDeadline(candidateDeadline: CandidateRouteDeadline, fence: RouteFence): boolean;
}

export interface RouteWriterLease extends RouteFence {
  release(): void;
}

export interface AuthoritySnapshot extends OwnerAuthorizationInputs {
  runtimeNarrowing: unknown;
  runtimeNarrowingCheckpoint: unknown;
}

export interface ProtectedAuthorityReader {
  /** Reads independently protected/pinned artifacts, never controller-writable files. */
  read(): AuthoritySnapshot;
  /** Must be backed by a protected kill-switch source. */
  killSwitchActive(): boolean;
  /** Must be an authenticated monotonic/wall-clock source in production. */
  trustedNowIso(): string;
  /** Content-blind liveness proof from the independently supervised gateway. */
  liveness(): { healthy: boolean; observedAt: string; digest: string };
  currentDigests(): {
    config: string;
    evidence: string;
    policy: string;
    postconditions: string;
  };
}

export interface RouteMutationPlan {
  mutationId: string;
  attemptId: string;
  recoveryDisarmId: string;
  idempotencyKey: string;
  journalId: string;
  baseline: string;
  candidate: string;
  targetScopeDigest: string;
  configDigest: string;
  evidenceDigest: string;
  policyDigest: string;
  postconditionsDigest: string;
  recoveryDescriptorDigest: string;
  deadline: string;
  contentRef: string;
}

export interface ConstitutionalPolicy {
  applyVerifySeconds: number;
  deadlineSeconds: number;
  minimumWatchSeconds: number;
  commitGraceSeconds: number;
  maxAttempts: number;
  minSecondsBetweenAttempts: number;
  maxAttemptsPerWindow: number;
  attemptWindowSeconds: number;
  maxSilenceSeconds: number;
}

export interface CandidateProof {
  ok: boolean;
  candidateDigest: string;
  postconditionsDigest: string;
  proofDigest: string;
}

export interface CandidateVerifier {
  verify(input: {
    candidate: string;
    candidateDigest: string;
    configDigest: string;
    evidenceDigest: string;
    policyDigest: string;
    postconditionsDigest: string;
  }): CandidateProof;
}

export const MICRO_ROUTING_CONSTITUTIONAL_POLICY: ConstitutionalPolicy = {
  applyVerifySeconds: 300,
  deadlineSeconds: 4200,
  minimumWatchSeconds: 3600,
  commitGraceSeconds: 300,
  maxAttempts: 1,
  minSecondsBetweenAttempts: 3600,
  maxAttemptsPerWindow: 1,
  attemptWindowSeconds: 86400,
  maxSilenceSeconds: 900,
};

type Phase =
  | "prepare"
  | "apply"
  | "verify"
  | "watch"
  | "commit"
  | "unknown"
  | "revert"
  | "disarm"
  | "terminally-blocked";
type Outcome =
  | "prepared"
  | "applied"
  | "verified"
  | "watching"
  | "committed"
  | "unknown"
  | "reverted"
  | "disarmed"
  | "terminally-blocked";

interface JournalBinding {
  mutation_id: string;
  attempt_id: string;
  recovery_disarm_id: string;
  idempotency_key: string;
  writer_owner: string;
  owner_authority_ref: string;
  owner_authority_digest: string;
  configuration_owner: string;
  configuration_owner_authority_ref: string;
  configuration_owner_authority_digest: string;
  target_scope_digest: string;
  admission_coverage_digest: string;
  admission_binding_state: "armed-canary" | "armed-fleet";
  owner_identity: string;
  controller_identity: string;
  watchdog_identity: string;
  kill_switch_identity: string;
  recovery_worker_identity: string;
  risk_scope: "micro-routing";
  candidate_digest: string;
  config_digest: string;
  evidence_digest: string;
  policy_digest: string;
  baseline_digest: string;
  postconditions_digest: string;
  deadline: string;
  canary: { scope_digest: string; target_count: 1 };
  recovery: {
    class: "R-exact";
    worker_identity: string;
    descriptor_digest: string;
    disarms_after_action: true;
  };
}

interface JournalEntry {
  entry_id: string;
  sequence: number;
  recorded_at: string;
  phase: Phase;
  outcome: Outcome;
  executor_identity: string;
  binding_digest: string;
  quarantine: { state: "not-applicable" | "active"; reason_digest: string };
  coverage_transition: null | {
    from_state: "armed-canary" | "armed-fleet";
    to_state: "shadow";
    target_scope_digest: string;
    actor_identity: string;
  };
  terminal_reason_digest: string | null;
  previous_receipt_digest: string | null;
  receipt_digest: string;
  content_refs: string[];
}

export interface JournalV2 {
  kind: "autonomous-mutation-journal";
  schema_version: "v2";
  journal_id: string;
  domain: "micro-routing";
  constitution_digest: string;
  binding: JournalBinding;
  binding_digest: string;
  entries: JournalEntry[];
  extensions: [];
}

interface RecoveryMaterial {
  schema_version: 1;
  journal_id: string;
  binding_digest: string;
  candidate: string;
  baseline_digest: string;
  candidate_digest: string;
  recovery_handle: string;
  recovery_registration_digest: string;
  plan: Omit<RouteMutationPlan, "baseline">;
  authority_epoch_digest: string;
  prepared_authority: AuthoritySnapshot;
  material_digest: string;
}

interface AttemptIndex {
  schema_version: 1;
  attempts: Array<{ attempt_id: string; started_at: string; binding_digest: string }>;
}

export interface ConstitutionalPaths {
  root: string;
  journal: string;
  recoveryMaterial: string;
  attemptIndex: string;
  lock: string;
  targetBlock: string;
}

export function constitutionalPaths(dataDir: string): ConstitutionalPaths {
  const root = join(dataDir, "autonomy-constitution", "micro-routing");
  return {
    root,
    journal: "journal-v2.json",
    recoveryMaterial: "recovery-material.json",
    attemptIndex: "attempt-index.json",
    lock: join(root, "constitutional-state.db"),
    targetBlock: "target-block.json",
  };
}

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function strictUtc(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) throw new Error(`constitutional time rejected: ${value}`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`constitutional time rejected: ${value}`);
  const normalized = new Date(parsed).toISOString().replace(".000Z", "Z");
  if (value !== normalized) {
    throw new Error(`constitutional time rejected: ${value}`);
  }
  return parsed;
}

function readJson(dbPath: string, resource: string): unknown {
  const bytes = readConstitutionalResource(dbPath, resource);
  if (bytes === undefined) throw new Error(`constitutional resource is missing: ${resource}`);
  if (Buffer.byteLength(bytes) > 1_000_000) throw new Error(`constitutional JSON exceeds 1 MiB: ${resource}`);
  const parsed = JSON.parse(bytes) as unknown;
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 64) throw new Error(`constitutional JSON exceeds structural limits: ${resource}`);
    if (Array.isArray(value)) {
      if (value.length > 4096) throw new Error(`constitutional JSON array exceeds entry limit: ${resource}`);
      for (const entry of value) walk(entry, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) walk(entry, depth + 1);
    }
  };
  walk(parsed, 0);
  return parsed;
}

function withLease<T>(
  path: string,
  options: ConstitutionalLeaseOptions,
  operation: (lease: ConstitutionalFencedLease) => T,
): T {
  const lease = ConstitutionalFencedLease.acquire(path, options);
  try {
    return operation(lease);
  } finally {
    lease.release();
  }
}

function withRouteAndStateLease<T>(
  path: string,
  table: ConstitutionalRouteStore,
  options: ConstitutionalLeaseOptions,
  operation: (stateLease: ConstitutionalFencedLease, routeFence: RouteFence) => T,
): T {
  // Never invalidate a demonstrably current state writer merely because a
  // second timer invocation arrived. Once the state lease is takeable, fence
  // the effect-owning route database FIRST. A predecessor resumed after this
  // point cannot mutate the route, even before the new state lease advances.
  ConstitutionalFencedLease.assertAcquirable(path, options);
  const routeLease = table.acquireWriterLease(options);
  try {
    return withLease(path, options, (stateLease) => operation(stateLease, {
      epoch: routeLease.epoch,
      token: routeLease.token,
    }));
  } finally {
    routeLease.release();
  }
}

function requirePlan(plan: RouteMutationPlan, policy: ConstitutionalPolicy, now: string): void {
  for (const id of [plan.mutationId, plan.attemptId, plan.recoveryDisarmId, plan.idempotencyKey, plan.journalId]) {
    if (!ID.test(id)) throw new Error(`invalid constitutional identifier: ${id}`);
  }
  for (const digest of [
    plan.targetScopeDigest,
    plan.configDigest,
    plan.evidenceDigest,
    plan.policyDigest,
    plan.postconditionsDigest,
    plan.recoveryDescriptorDigest,
  ]) {
    if (!DIGEST.test(digest)) throw new Error(`invalid constitutional digest: ${digest}`);
  }
  if (!/^ref:[a-z][a-z0-9-]{2,120}$/.test(plan.contentRef)) {
    throw new Error("content reference must be opaque");
  }
  const start = strictUtc(now);
  const deadline = strictUtc(plan.deadline);
  if (deadline <= start || deadline - start > policy.deadlineSeconds * 1000) {
    throw new Error("whole-operation deadline exceeds constitution");
  }
  if (plan.baseline === plan.candidate) throw new Error("candidate is identical to baseline");
}

interface FreshGate {
  snapshot: AuthoritySnapshot;
  verified: VerifiedAuthorization;
  coverage: Record<string, any>;
  attestations: Record<string, any>;
  binding: Record<string, any>;
  state: "armed-canary" | "armed-fleet";
  now: string;
}

function freshGate(
  authority: ProtectedAuthorityReader,
  plan: Omit<RouteMutationPlan, "baseline">,
  policy: ConstitutionalPolicy,
): FreshGate {
  if (authority.killSwitchActive()) throw new Error("constitutional kill switch is active");
  const now = authority.trustedNowIso();
  const nowMs = strictUtc(now);
  const liveness = authority.liveness();
  if (!liveness.healthy || !DIGEST.test(liveness.digest) || nowMs - strictUtc(liveness.observedAt) > policy.maxSilenceSeconds * 1000 || strictUtc(liveness.observedAt) > nowMs) {
    throw new Error("constitutional liveness proof is missing, future-dated, or stale");
  }
  const current = authority.currentDigests();
  if (
    current.config !== plan.configDigest
    || current.evidence !== plan.evidenceDigest
    || current.policy !== plan.policyDigest
    || current.postconditions !== plan.postconditionsDigest
  ) {
    throw new Error("constitutional config, evidence, policy, or postcondition digest changed");
  }
  const snapshot = authority.read();
  const verified = verifyOwnerAuthorization(snapshot);
  const narrowing = verifyRuntimeNarrowing(
    snapshot.runtimeNarrowing,
    snapshot.recoveryRegistry,
    verified,
    snapshot.runtimeNarrowingCheckpoint,
  );
  const target = verifyMicroRoutingTargetStateV2({
    coverage: snapshot.coverage,
    attestations: snapshot.attestations,
    verified,
    narrowing,
    targetScopeDigest: plan.targetScopeDigest,
    writerOwner: "gille-inference",
    controllerIdentity: "micro-route-controller",
  });
  if (target.effectiveState === "shadow") throw new Error("micro-routing target is runtime-demoted to shadow");
  const coverage = snapshot.coverage as Record<string, any>;
  const attestations = snapshot.attestations as Record<string, any>;
  const row = coverage.domains.find((candidate: any) => candidate.domain === "micro-routing");
  const binding = row.bindings.find((candidate: any) => candidate.target_scope_digest === plan.targetScopeDigest);
  return { snapshot, verified, coverage, attestations, binding, state: target.admittedState, now };
}

function authorityEpochDigest(gate: FreshGate): string {
  return digestJson({
    authorization_digest: gate.verified.authorizationDigest,
    coverage_digest: gate.coverage.registry_digest,
    attestations_digest: digestJson(gate.attestations, "registry_digest"),
    recovery_registry_digest: gate.verified.recoveryRegistryDigest,
    runtime_narrowing: gate.snapshot.runtimeNarrowing,
    runtime_narrowing_checkpoint: gate.snapshot.runtimeNarrowingCheckpoint,
    exact_binding: gate.binding,
  });
}

function requirePreparedEpoch(gate: FreshGate, material: RecoveryMaterial): void {
  if (authorityEpochDigest(gate) !== material.authority_epoch_digest) {
    throw new Error("protected authority epoch changed after prepare");
  }
}

function makeBinding(plan: RouteMutationPlan, gate: FreshGate): JournalBinding {
  const identities = gate.binding.identities as Record<string, string>;
  return {
    mutation_id: plan.mutationId,
    attempt_id: plan.attemptId,
    recovery_disarm_id: plan.recoveryDisarmId,
    idempotency_key: plan.idempotencyKey,
    writer_owner: gate.binding.writer_owner,
    owner_authority_ref: gate.binding.owner_authority_ref,
    owner_authority_digest: gate.binding.owner_authority_digest,
    configuration_owner: gate.binding.configuration_owner,
    configuration_owner_authority_ref: gate.binding.configuration_owner_authority_ref,
    configuration_owner_authority_digest: gate.binding.configuration_owner_authority_digest,
    target_scope_digest: plan.targetScopeDigest,
    admission_coverage_digest: gate.coverage.registry_digest,
    admission_binding_state: gate.state,
    owner_identity: identities.owner,
    controller_identity: identities.controller,
    watchdog_identity: identities.watchdog,
    kill_switch_identity: identities.kill_switch,
    recovery_worker_identity: identities.recovery_worker,
    risk_scope: "micro-routing",
    candidate_digest: sha(plan.candidate),
    config_digest: plan.configDigest,
    evidence_digest: plan.evidenceDigest,
    policy_digest: plan.policyDigest,
    baseline_digest: sha(plan.baseline),
    postconditions_digest: plan.postconditionsDigest,
    deadline: plan.deadline,
    canary: { scope_digest: plan.targetScopeDigest, target_count: 1 },
    recovery: {
      class: "R-exact",
      worker_identity: identities.recovery_worker,
      descriptor_digest: plan.recoveryDescriptorDigest,
      disarms_after_action: true,
    },
  };
}

function reasonDigest(reason: string): string {
  return sha(`constitutional-reason-v2:${reason}`);
}

function append(
  journal: JournalV2,
  phase: Phase,
  outcome: Outcome,
  executor: string,
  recordedAt: string,
  reason: string,
  contentRef: string,
): void {
  const recoveryTerminal = phase === "disarm" || phase === "terminally-blocked";
  const entry: JournalEntry = {
    entry_id: `${journal.binding.attempt_id}-${phase}`,
    sequence: journal.entries.length + 1,
    recorded_at: recordedAt,
    phase,
    outcome,
    executor_identity: executor,
    binding_digest: journal.binding_digest,
    quarantine: {
      state: phase === "terminally-blocked" ? "active" : "not-applicable",
      reason_digest: reasonDigest(reason),
    },
    coverage_transition: recoveryTerminal ? {
      from_state: journal.binding.admission_binding_state,
      to_state: "shadow",
      target_scope_digest: journal.binding.target_scope_digest,
      actor_identity: journal.binding.recovery_worker_identity,
    } : null,
    terminal_reason_digest: ["unknown", "disarm", "terminally-blocked"].includes(phase) ? reasonDigest(reason) : null,
    previous_receipt_digest: journal.entries.at(-1)?.receipt_digest ?? null,
    receipt_digest: "",
    content_refs: [contentRef],
  };
  entry.receipt_digest = digestJson(entry, "receipt_digest");
  journal.entries.push(entry);
}

function loadAttemptIndex(paths: ConstitutionalPaths): AttemptIndex {
  if (!constitutionalResourceExists(paths.lock, paths.attemptIndex)) return { schema_version: 1, attempts: [] };
  const parsed = readJson(paths.lock, paths.attemptIndex) as AttemptIndex;
  if (
    parsed.schema_version !== 1
    || !Array.isArray(parsed.attempts)
    || parsed.attempts.some((attempt) => !ID.test(attempt.attempt_id) || !DIGEST.test(attempt.binding_digest) || !Number.isFinite(strictUtc(attempt.started_at)))
  ) {
    throw new Error("constitutional attempt index is corrupt");
  }
  return parsed;
}

function enforceAttemptBounds(index: AttemptIndex, plan: RouteMutationPlan, now: string, policy: ConstitutionalPolicy): void {
  const nowMs = strictUtc(now);
  if (index.attempts.some((attempt) => attempt.attempt_id === plan.attemptId)) {
    throw new Error("constitutional attempt id was already consumed");
  }
  // maxAttempts is the lifetime budget retained in the durable attempt index;
  // maxAttemptsPerWindow is an additional rate limit, not an accidental alias
  // that resets the total budget whenever the time window rolls over.
  if (index.attempts.length >= policy.maxAttempts) {
    throw new Error("constitutional attempt budget exhausted");
  }
  const inWindow = index.attempts.filter((attempt) => nowMs - strictUtc(attempt.started_at) < policy.attemptWindowSeconds * 1000);
  if (inWindow.length >= policy.maxAttemptsPerWindow) {
    throw new Error("constitutional attempt budget exhausted");
  }
  const latest = index.attempts.at(-1);
  if (latest && nowMs - strictUtc(latest.started_at) < policy.minSecondsBetweenAttempts * 1000) {
    throw new Error("constitutional minimum attempt interval has not elapsed");
  }
}

function loadJournal(paths: ConstitutionalPaths): JournalV2 {
  if (!constitutionalResourceExists(paths.lock, paths.journal)) throw new Error("no constitutional journal");
  return readJson(paths.lock, paths.journal) as JournalV2;
}

function loadMaterial(paths: ConstitutionalPaths, journal: JournalV2): RecoveryMaterial {
  const material = readJson(paths.lock, paths.recoveryMaterial) as RecoveryMaterial;
  const claimed = material.material_digest;
  const computed = digestJson(material, "material_digest");
  if (
    material.schema_version !== 1
    || material.journal_id !== journal.journal_id
    || material.binding_digest !== journal.binding_digest
    || material.baseline_digest !== journal.binding.baseline_digest
    || material.candidate_digest !== journal.binding.candidate_digest
    || !/^recovery-[a-f0-9-]{36}$/.test(material.recovery_handle)
    || !DIGEST.test(material.recovery_registration_digest)
    || material.authority_epoch_digest.length === 0
    || material.plan.attemptId !== journal.binding.attempt_id
    || !journal.entries.every((entry) => entry.content_refs.length === 1 && entry.content_refs[0] === material.plan.contentRef)
    || sha(material.candidate) !== material.candidate_digest
    || claimed !== computed
  ) {
    throw new Error("constitutional recovery material is corrupt or mismatched");
  }
  return material;
}

function saveAndValidate(
  paths: ConstitutionalPaths,
  journal: JournalV2,
  gate: FreshGate,
  terminal: boolean,
  lease: ConstitutionalFencedLease,
): void {
  if (terminal) {
    validateJournalV2(journal, gate.snapshot.constitution, gate.snapshot.coverage, gate.snapshot.attestations);
  } else {
    validateJournalV2Prefix(journal, gate.snapshot.constitution, gate.snapshot.coverage, gate.snapshot.attestations);
  }
  lease.writeResource(paths.journal, `${canonicalJson(journal)}\n`);
}

export type BeginResult =
  | { outcome: "watching"; journal: JournalV2 }
  | { outcome: "unknown"; journal: JournalV2; reason: string };

export interface RecoveryRegistrar {
  registerPreRecovery(input: {
    journalId: string;
    bindingDigest: string;
    targetScopeDigest: string;
    baseline: string;
    baselineDigest: string;
    candidateDigest: string;
    descriptorDigest: string;
  }): { handle: string; registrationDigest: string };
}

export class ConstitutionalRoutingController {
  private readonly paths: ConstitutionalPaths;

  constructor(
    dataDir: string,
    private readonly table: ConstitutionalRouteStore,
    private readonly authority: ProtectedAuthorityReader,
    private readonly verifier: CandidateVerifier,
    private readonly recoveryRegistrar: RecoveryRegistrar,
    private readonly policy: ConstitutionalPolicy = MICRO_ROUTING_CONSTITUTIONAL_POLICY,
    private readonly leaseOptions: ConstitutionalLeaseOptions = {},
  ) {
    this.paths = constitutionalPaths(dataDir);
  }

  begin(plan: RouteMutationPlan): BeginResult {
    return withRouteAndStateLease(this.paths.lock, this.table, this.leaseOptions, (lease, routeFence) => {
      if (constitutionalResourceExists(this.paths.lock, this.paths.targetBlock)) throw new Error("micro-routing target is persistently blocked pending signed demotion reconciliation");
      const initial = freshGate(this.authority, plan, this.policy);
      requirePlan(plan, this.policy, initial.now);
      if (plan.recoveryDescriptorDigest !== digestJson(initial.snapshot)) {
        throw new Error("recovery descriptor does not bind the exact prepared authority snapshot");
      }
      if (constitutionalResourceExists(this.paths.lock, this.paths.journal)) {
        const prior = loadJournal(this.paths);
        const last = prior.entries.at(-1)?.phase;
        throw new Error(
          ["commit", "disarm", "terminally-blocked"].includes(String(last))
            ? "prior constitutional attempt must be archived by the owner procedure"
            : "constitutional attempt already in flight",
        );
      }
      if (this.table.read() !== plan.baseline) throw new Error("live route table does not match the proposed baseline");

      const index = loadAttemptIndex(this.paths);
      enforceAttemptBounds(index, plan, initial.now, this.policy);
      const binding = makeBinding(plan, initial);
      const journal: JournalV2 = {
        kind: "autonomous-mutation-journal",
        schema_version: "v2",
        journal_id: plan.journalId,
        domain: "micro-routing",
        constitution_digest: (initial.snapshot.constitution as Record<string, string>).constitution_digest,
        binding,
        binding_digest: digestJson(binding),
        entries: [],
        extensions: [],
      };
      append(journal, "prepare", "prepared", binding.controller_identity, initial.now, "prepared-durable-before-write", plan.contentRef);
      // The recovery service authenticates this prepared journal and reads
      // the canonical live baseline itself. It never trusts controller bytes
      // as recovery authority.
      saveAndValidate(this.paths, journal, initial, false, lease);
      const registration = this.recoveryRegistrar.registerPreRecovery({
        journalId: journal.journal_id,
        bindingDigest: journal.binding_digest,
        targetScopeDigest: journal.binding.target_scope_digest,
        baseline: plan.baseline,
        baselineDigest: binding.baseline_digest,
        candidateDigest: binding.candidate_digest,
        descriptorDigest: binding.recovery.descriptor_digest,
      });
      if (!/^recovery-[a-f0-9-]{36}$/.test(registration.handle) || !DIGEST.test(registration.registrationDigest)) {
        throw new Error("recovery service returned an invalid opaque preregistration receipt");
      }
      const { baseline: _baseline, ...persistedPlan } = plan;
      const materialBase = {
        schema_version: 1 as const,
        journal_id: journal.journal_id,
        binding_digest: journal.binding_digest,
        candidate: plan.candidate,
        baseline_digest: binding.baseline_digest,
        candidate_digest: binding.candidate_digest,
        recovery_handle: registration.handle,
        recovery_registration_digest: registration.registrationDigest,
        plan: structuredClone(persistedPlan),
        authority_epoch_digest: authorityEpochDigest(initial),
        prepared_authority: structuredClone(initial.snapshot),
      };
      const material: RecoveryMaterial = { ...materialBase, material_digest: digestJson(materialBase) };

      // Only the candidate and opaque recovery handle return to the
      // controller-owned state directory; baseline bytes remain recovery-owned.
      lease.writeResource(this.paths.recoveryMaterial, `${canonicalJson(material)}\n`);
      // The attempt index follows the recoverable journal. A crash before
      // this write leaves an in-flight journal that blocks/reconciles; it
      // never consumes an attempt without a journal.
      lease.writeResource(this.paths.attemptIndex, `${canonicalJson({
        ...index,
        attempts: [...index.attempts, { attempt_id: plan.attemptId, started_at: initial.now, binding_digest: journal.binding_digest }],
      } satisfies AttemptIndex)}\n`);

      try {
        // No stale admission window: independently re-read all protected
        // authorization, narrowing, kill-switch, evidence/config, time and
        // liveness inputs immediately before the CAS.
        const preApply = freshGate(this.authority, plan, this.policy);
        requirePreparedEpoch(preApply, material);
        if (strictUtc(preApply.now) - strictUtc(initial.now) > this.policy.applyVerifySeconds * 1000) {
          throw new Error("apply/readback/verify budget expired before apply");
        }
      } catch (error) {
        return this.unknown(journal, plan, `pre-apply-gate:${error instanceof Error ? error.message : String(error)}`, lease);
      }

      if (
        !this.table.compareAndSwap(plan.baseline, plan.candidate, routeFence, {
          journalId: journal.journal_id,
          attemptId: plan.attemptId,
          bindingDigest: journal.binding_digest,
          targetScopeDigest: journal.binding.target_scope_digest,
          candidateDigest: journal.binding.candidate_digest,
          notAfter: journal.binding.deadline,
        })
        || sha(this.table.read()) !== binding.candidate_digest
      ) {
        return this.unknown(journal, plan, "apply-or-candidate-readback-failed", lease);
      }
      const appliedAt = this.authority.trustedNowIso();
      if (strictUtc(appliedAt) - strictUtc(initial.now) > this.policy.applyVerifySeconds * 1000) {
        return this.unknown(journal, plan, "apply-readback-exceeded-budget", lease);
      }
      append(journal, "apply", "applied", binding.controller_identity, appliedAt, "candidate-readback-matches", plan.contentRef);
      saveAndValidate(this.paths, journal, initial, false, lease);

      try {
        requirePreparedEpoch(freshGate(this.authority, plan, this.policy), material);
        this.requireProof(material);
      } catch (error) {
        return this.unknown(journal, plan, `verify-gate:${error instanceof Error ? error.message : String(error)}`, lease);
      }
      const verifiedAt = this.authority.trustedNowIso();
      if (strictUtc(verifiedAt) - strictUtc(initial.now) > this.policy.applyVerifySeconds * 1000) {
        return this.unknown(journal, plan, "verify-exceeded-apply-readback-budget", lease);
      }
      append(journal, "verify", "verified", binding.controller_identity, verifiedAt, "verifier-passes", plan.contentRef);
      append(journal, "watch", "watching", binding.controller_identity, verifiedAt, "canary-watch-started", plan.contentRef);
      saveAndValidate(this.paths, journal, initial, false, lease);
      return { outcome: "watching", journal };
    });
  }

  commit(): { outcome: "committed" | "unknown"; journal: JournalV2; reason?: string } {
    return withRouteAndStateLease(this.paths.lock, this.table, this.leaseOptions, (lease, routeFence) => {
      if (constitutionalResourceExists(this.paths.lock, this.paths.targetBlock)) {
        throw new Error("micro-routing target is persistently blocked pending signed demotion reconciliation");
      }
      const journal = loadJournal(this.paths);
      const material = loadMaterial(this.paths, journal);
      const plan = material.plan;
      const candidateDeadline: CandidateRouteDeadline = {
        journalId: journal.journal_id,
        attemptId: plan.attemptId,
        bindingDigest: journal.binding_digest,
        targetScopeDigest: journal.binding.target_scope_digest,
        candidateDigest: journal.binding.candidate_digest,
        notAfter: journal.binding.deadline,
      };
      // Commit is durable before it makes the candidate non-expiring. A retry
      // after a crash in that narrow post-receipt window is exact and safe.
      if (journal.entries.at(-1)?.phase === "commit") {
        if (!this.table.clearCandidateDeadline(candidateDeadline, routeFence)) {
          throw new Error("committed candidate deadline could not be cleared at the serving resource");
        }
        return { outcome: "committed", journal };
      }
      if (journal.entries.at(-1)?.phase !== "watch") {
        throw new Error("constitutional commit does not match an in-flight watch");
      }
      let gate: FreshGate;
      try {
        gate = freshGate(this.authority, plan, this.policy);
        requirePreparedEpoch(gate, material);
        const now = strictUtc(gate.now);
        const watchReceipt = journal.entries.find((entry) => entry.phase === "watch");
        if (!watchReceipt) throw new Error("durable watch receipt is missing");
        const watchStart = strictUtc(watchReceipt.recorded_at);
        if (now < watchStart + this.policy.minimumWatchSeconds * 1000) throw new Error("watch window is incomplete");
        if (now > watchStart + (this.policy.minimumWatchSeconds + this.policy.commitGraceSeconds) * 1000) throw new Error("commit grace expired");
        if (now > strictUtc(journal.binding.deadline)) throw new Error("whole-operation deadline expired");
        if (sha(this.table.read()) !== journal.binding.candidate_digest) throw new Error("candidate readback changed during watch");
        this.requireProof(material);
      } catch (error) {
        const result = this.unknown(journal, plan, `pre-commit-gate:${error instanceof Error ? error.message : String(error)}`, lease);
        return { outcome: "unknown", journal: result.journal, reason: result.reason };
      }
      append(journal, "commit", "committed", journal.binding.controller_identity, gate.now, "canary-watch-complete", plan.contentRef);
      saveAndValidate(this.paths, journal, gate, true, lease);
      if (!this.table.clearCandidateDeadline(candidateDeadline, routeFence)) {
        throw new Error("committed candidate deadline could not be cleared at the serving resource");
      }
      return { outcome: "committed", journal };
    });
  }

  private requireProof(material: RecoveryMaterial): CandidateProof {
    const proof = this.verifier.verify({
      candidate: material.candidate,
      candidateDigest: material.candidate_digest,
      configDigest: material.plan.configDigest,
      evidenceDigest: material.plan.evidenceDigest,
      policyDigest: material.plan.policyDigest,
      postconditionsDigest: material.plan.postconditionsDigest,
    });
    if (
      proof.ok !== true
      || proof.candidateDigest !== material.candidate_digest
      || proof.postconditionsDigest !== material.plan.postconditionsDigest
      || !DIGEST.test(proof.proofDigest)
    ) {
      throw new Error("candidate verifier returned an unbound or failed proof");
    }
    return proof;
  }

  private unknown(
    journal: JournalV2,
    plan: Omit<RouteMutationPlan, "baseline">,
    reason: string,
    lease: ConstitutionalFencedLease,
  ): BeginResult & { outcome: "unknown" } {
    const now = this.authority.trustedNowIso();
    append(journal, "unknown", "unknown", journal.binding.controller_identity, now, reason, plan.contentRef);
    // Prefix validation is performed against a fresh protected read when
    // possible. If authority itself is unavailable, persist the monotone
    // receipt anyway; the watchdog validates it against its protected copy.
    try {
      const gate = freshGate(this.authority, plan, this.policy);
      saveAndValidate(this.paths, journal, gate, false, lease);
    } catch {
      lease.writeResource(this.paths.journal, `${canonicalJson(journal)}\n`);
    }
    return { outcome: "unknown", journal, reason };
  }
}

export interface RestoreOnlyCapability {
  readonly recoveryWorkerIdentity: string;
  /** Recovery service acquires the lease stored beside the route value. */
  acquireRouteFence(): RouteFence;
  releaseRouteFence(fence: RouteFence): void;
  blockRoute(fence: RouteFence, owner?: RouteGuardOwner): void;
  clearRouteBlock(fence: RouteFence): void;
  /** Fenced reconciliation for a guard proven to belong to this watchdog attempt. */
  clearOwnedRouteBlock(fence: RouteFence, owner: RouteGuardOwner): boolean;
  /** Clears an exact committed candidate's serving deadline. */
  clearCandidateDeadline(candidateDeadline: CandidateRouteDeadline, fence: RouteFence): void;
  /** Independently reads the serving route digest under the held recovery fence. */
  readRouteDigest(fence: RouteFence): string;
  /**
   * Implemented by a separately privileged worker. It can write only the
   * pre-registered baseline bound to this journal, never arbitrary bytes.
   */
  actuatePreRegisteredRecovery(input: {
    handle: string;
    journalId: string;
    bindingDigest: string;
    targetScopeDigest: string;
    journalReceiptDigest: string;
    fenceEpoch: number;
    fenceToken: string;
  }): "restored" | "already-baseline" | "superseded" | "failed";
  /**
   * Appends a recovery-worker-signed armed-* -> shadow narrowing and returns
   * the independently readable resulting ledger and protected tail.
   */
  signAndPersistDemotion(input: {
    journalId: string;
    ownerAuthorizationDigest: string;
    domain: "micro-routing";
    targetScopeDigest: string;
    journalReceiptDigest: string;
    fenceEpoch: number;
    fenceToken: string;
  }): { ledger: unknown; registry: unknown; checkpoint: unknown };
}

export interface WatchdogTickResult {
  outcome: "noop" | "waiting" | "reverted" | "terminally-blocked";
  reason: string;
  journal?: JournalV2;
}

export class ConstitutionalRoutingWatchdog {
  private readonly paths: ConstitutionalPaths;

  constructor(
    dataDir: string,
    private readonly authority: ProtectedAuthorityReader,
    private readonly recovery: RestoreOnlyCapability,
    private readonly notifyBestEffort: (summary: string) => void = () => undefined,
    private readonly policy: ConstitutionalPolicy = MICRO_ROUTING_CONSTITUTIONAL_POLICY,
    private readonly leaseOptions: ConstitutionalLeaseOptions = {},
    private readonly verifier?: CandidateVerifier,
  ) {
    this.paths = constitutionalPaths(dataDir);
  }

  tick(): WatchdogTickResult {
    // Fence the effect-owning route resource before advancing state. This
    // ordering closes the cross-database window where an expired predecessor
    // could resume after state takeover but before route invalidation.
    ConstitutionalFencedLease.assertAcquirable(this.paths.lock, this.leaseOptions);
    const routeFence = this.recovery.acquireRouteFence();
    try {
      return withLease(this.paths.lock, this.leaseOptions, (lease) => {
      if (!constitutionalResourceExists(this.paths.lock, this.paths.journal)) {
        if (constitutionalResourceExists(this.paths.lock, this.paths.targetBlock)) {
          return { outcome: "terminally-blocked", reason: "durable-target-block-without-journal" };
        }
        return { outcome: "noop", reason: "no-journal" };
      }
      // Establish the fail-closed target block before parsing any controller-
      // writable recovery state or consulting clock/liveness. Corruption can
      // therefore strand the target blocked, never active with an exception
      // loop. Healthy/no-journal passes never clear a block they did not create.
      let journal: JournalV2;
      try {
        journal = loadJournal(this.paths);
      } catch (error) {
        this.recovery.blockRoute(routeFence);
        return { outcome: "terminally-blocked", reason: `journal-unreadable:${error instanceof Error ? error.message : String(error)}` };
      }
      const last = journal.entries.at(-1);
      if (!last) return { outcome: "terminally-blocked", reason: "empty-journal" };
      if (this.terminalReceiptPersistencePending()) {
        // A terminal transition already exhausted its signer path but could
        // not durably append the terminal receipt. Retrying the signer would
        // turn a persistence fault into an unbounded privileged side effect.
        this.recovery.blockRoute(routeFence, guardOwner(journal));
        return { outcome: "terminally-blocked", reason: "terminal-owner-reconciliation-required", journal };
      }
      if (["commit", "disarm", "terminally-blocked"].includes(last.phase)) {
        if (constitutionalResourceExists(this.paths.lock, this.paths.targetBlock)) {
          // A durable resource-local block is authoritative even when the
          // controller journal reached a terminal phase. In particular, a
          // pending signed demotion must never be bypassed by generic terminal
          // deadline/block reconciliation.
          this.recovery.blockRoute(routeFence, guardOwner(journal));
          return {
            outcome: "terminally-blocked",
            reason: "terminal-owner-reconciliation-required",
            journal,
          };
        }
        if (last.phase === "commit") {
          try {
            this.recovery.clearCandidateDeadline({
              journalId: journal.journal_id,
              attemptId: journal.binding.attempt_id,
              bindingDigest: journal.binding_digest,
              targetScopeDigest: journal.binding.target_scope_digest,
              candidateDigest: journal.binding.candidate_digest,
              notAfter: journal.binding.deadline,
            }, routeFence);
          } catch (error) {
            this.recovery.blockRoute(routeFence, guardOwner(journal));
            return {
              outcome: "terminally-blocked",
              reason: `committed-deadline-reconciliation-pending:${error instanceof Error ? error.message : String(error)}`,
              journal,
            };
          }
        }
        if (last.phase !== "terminally-blocked") this.recovery.clearRouteBlock(routeFence);
        return { outcome: "noop", reason: `terminal-${last.phase}`, journal };
      }
      let material: RecoveryMaterial;
      let now: string;
      try {
        material = loadMaterial(this.paths, journal);
        now = this.authority.trustedNowIso();
        strictUtc(now);
      } catch (error) {
        this.recovery.blockRoute(routeFence, guardOwner(journal));
        lease.writeResource(this.paths.targetBlock, `${canonicalJson({
          schema_version: 1,
          target_scope_digest: journal.binding.target_scope_digest,
          binding_digest: journal.binding_digest,
          reason_digest: reasonDigest("recovery-input-unreadable"),
          blocked_at: "protected-clock-unavailable",
          signed_demotion_pending: true,
        })}\n`);
        // Material/clock corruption is a recovery condition, so block only
        // now—not during every healthy watch evaluation.
        return {
          outcome: "terminally-blocked",
          reason: `recovery-input-unreadable:${error instanceof Error ? error.message : String(error)}`,
          journal,
        };
      }
      const watchReceipt = journal.entries.find((entry) => entry.phase === "watch");
      const watchGraceExpired = watchReceipt !== undefined
        && strictUtc(now) > strictUtc(watchReceipt.recorded_at)
          + (this.policy.minimumWatchSeconds + this.policy.commitGraceSeconds) * 1000;
      const expired = strictUtc(now) > strictUtc(journal.binding.deadline) || watchGraceExpired;
      const kill = this.authority.killSwitchActive();
      // maxSilenceSeconds constrains the independently advancing protected
      // liveness proof in freshGate; it is not a journal-receipt cadence. A
      // one-hour canary is intentionally quiet between watch and commit.
      let watchFailure = ["prepare", "apply", "verify"].includes(last.phase)
        ? `interrupted-${last.phase}-phase`
        : last.phase === "revert"
          ? "resume-persisted-demotion"
          : undefined;
      if (!expired && !kill && last.phase === "watch") {
        try {
          const currentGate = freshGate(this.authority, material.plan, this.policy);
          requirePreparedEpoch(currentGate, material);
          if (!this.verifier) throw new Error("watchdog candidate verifier is unavailable");
          requireCandidateProof(this.verifier, material);
        } catch (error) {
          watchFailure = `watch-gate:${error instanceof Error ? error.message : String(error)}`;
        }
      }
      if (!expired && !kill && last.phase === "watch" && watchFailure === undefined) {
        // A crash can land after the SQLite serving block but before the
        // controller-state marker. Reconcile only an exact guard owned by this
        // journal/attempt/binding/target watchdog; operator and other-attempt
        // blocks deliberately remain fail-closed.
        this.recovery.clearOwnedRouteBlock(routeFence, guardOwner(journal));
        return { outcome: "waiting", reason: "watch-active", journal };
      }

      // A healthy watch is served uninterrupted. Only a condition that has
      // already selected recovery/ambiguity/deadline fail-closed obtains the
      // serving-side block.
      this.recovery.blockRoute(routeFence, guardOwner(journal));
      let gate: FreshGate;
      try {
        // Recovery validates against the cryptographically verified authority
        // epoch captured at prepare. A later owner-key/coverage rotation may
        // narrow current authority but cannot strand an already-written
        // candidate by making its exact baseline unrecoverable.
        const snapshot = material.prepared_authority;
        const verified = verifyOwnerAuthorization(snapshot);
        const narrowing = verifyRuntimeNarrowing(
          snapshot.runtimeNarrowing,
          snapshot.recoveryRegistry,
          verified,
          snapshot.runtimeNarrowingCheckpoint,
        );
        const target = verifyMicroRoutingTargetStateV2({
          coverage: snapshot.coverage,
          attestations: snapshot.attestations,
          verified,
          narrowing,
          targetScopeDigest: journal.binding.target_scope_digest,
          writerOwner: "gille-inference",
          controllerIdentity: journal.binding.controller_identity,
        });
        const coverage = snapshot.coverage as Record<string, any>;
        const row = coverage.domains.find((candidate: any) => candidate.domain === "micro-routing");
        const binding = row.bindings.find((candidate: any) => candidate.target_scope_digest === journal.binding.target_scope_digest);
        gate = {
          snapshot,
          verified,
          coverage,
          attestations: snapshot.attestations as Record<string, any>,
          binding,
          state: target.admittedState,
          now,
        };
        if (authorityEpochDigest(gate) !== material.authority_epoch_digest) {
          throw new Error("prepared authority history does not match its bound epoch digest");
        }
        validateJournalV2Prefix(journal, snapshot.constitution, snapshot.coverage, snapshot.attestations);
      } catch (error) {
        return this.terminalBlock(
          journal,
          material,
          `authority-or-journal-invalid:${error instanceof Error ? error.message : String(error)}`,
          now,
          undefined,
          lease,
        );
      }
      if (this.recovery.recoveryWorkerIdentity !== journal.binding.recovery_worker_identity) {
        return this.terminalBlock(journal, material, "recovery-worker-identity-mismatch", now, undefined, lease);
      }

      if (!["unknown", "revert"].includes(last.phase)) {
        append(
          journal,
          "unknown",
          "unknown",
          journal.binding.watchdog_identity,
          now,
          expired ? "deadline-expired" : kill ? "kill-switch-active" : watchFailure!,
          material.plan.contentRef,
        );
        saveAndValidate(this.paths, journal, gate, false, lease);
      }
      lease.writeResource(this.paths.targetBlock, `${canonicalJson({
        schema_version: 1,
        target_scope_digest: journal.binding.target_scope_digest,
        binding_digest: journal.binding_digest,
        reason_digest: reasonDigest("recovery-in-progress"),
        blocked_at: now,
        signed_demotion_pending: true,
      })}\n`);

      if (last.phase !== "revert") {
        const restored = lease.transition(() => this.recovery.actuatePreRegisteredRecovery({
          handle: material.recovery_handle,
          journalId: journal.journal_id,
          bindingDigest: journal.binding_digest,
          targetScopeDigest: journal.binding.target_scope_digest,
          journalReceiptDigest: journal.entries.at(-1)!.receipt_digest,
          fenceEpoch: routeFence.epoch,
          fenceToken: routeFence.token,
        }));
        if (!["restored", "already-baseline"].includes(restored)) {
          return this.terminalBlock(journal, material, "exact-baseline-restore-failed", now, gate, lease);
        }
        append(journal, "revert", "reverted", journal.binding.recovery_worker_identity, now, "baseline-digest-restored", material.plan.contentRef);
        saveAndValidate(this.paths, journal, gate, false, lease);
      }

      let demotion: ReturnType<RestoreOnlyCapability["signAndPersistDemotion"]>;
      try {
        demotion = lease.transition(() => this.recovery.signAndPersistDemotion({
          journalId: journal.journal_id,
          ownerAuthorizationDigest: gate.verified.authorizationDigest,
          domain: "micro-routing",
          targetScopeDigest: journal.binding.target_scope_digest,
          journalReceiptDigest: journal.entries.at(-1)!.receipt_digest,
          fenceEpoch: routeFence.epoch,
          fenceToken: routeFence.token,
        }));
        this.requirePersistedDemotion(
          demotion,
          journal.binding.target_scope_digest,
          journal.entries.at(-1)!.receipt_digest,
        );
      } catch (error) {
        return this.terminalBlock(
          journal,
          material,
          `signed-demotion-failed:${error instanceof Error ? error.message : String(error)}`,
          now,
          gate,
          lease,
        );
      }
      append(journal, "disarm", "disarmed", journal.binding.recovery_worker_identity, now, "recovery-worker-disarm-confirmed", material.plan.contentRef);
      saveAndValidate(this.paths, journal, gate, true, lease);
      lease.removeResource(this.paths.targetBlock);
      this.recovery.clearRouteBlock(routeFence);
      try {
        this.notifyBestEffort(canonicalJson({ kind: "constitutional-route-reverted", journal_id: journal.journal_id }));
      } catch {
        // Observers and notification transport never gate recovery.
      }
      return { outcome: "reverted", reason: "baseline-restored-and-target-demoted", journal };
      });
    } finally {
      this.recovery.releaseRouteFence(routeFence);
    }
  }

  private terminalBlock(
    journal: JournalV2,
    material: RecoveryMaterial,
    reason: string,
    now: string,
    gate?: FreshGate,
    lease?: ConstitutionalFencedLease,
  ): WatchdogTickResult {
    if (!lease) throw new Error("terminal block requires a current fenced lease");
    const terminalJournal = structuredClone(journal);
    if (!["unknown", "revert"].includes(terminalJournal.entries.at(-1)?.phase ?? "")) {
      append(terminalJournal, "unknown", "unknown", terminalJournal.binding.watchdog_identity, now, reason, material.plan.contentRef);
    }
    append(terminalJournal, "terminally-blocked", "terminally-blocked", terminalJournal.binding.recovery_worker_identity, now, reason, material.plan.contentRef);
    lease.writeResource(this.paths.targetBlock, `${canonicalJson({
      schema_version: 1,
      target_scope_digest: journal.binding.target_scope_digest,
      binding_digest: journal.binding_digest,
      reason_digest: reasonDigest(reason),
      blocked_at: now,
      signed_demotion_pending: true,
    })}\n`);
    let terminalPersisted = false;
    if (gate) {
      try {
        saveAndValidate(this.paths, terminalJournal, gate, true, lease);
        terminalPersisted = true;
      } catch {
        // Keep the last valid journal prefix. The authoritative route block is
        // already durable; never replace a valid prefix with an invalid
        // terminal fallback.
        lease.writeResource(this.paths.targetBlock, `${canonicalJson({
          schema_version: 1,
          target_scope_digest: journal.binding.target_scope_digest,
          binding_digest: journal.binding_digest,
          reason_digest: reasonDigest(reason),
          blocked_at: now,
          signed_demotion_pending: true,
          terminal_receipt_persistence_pending: true,
        })}\n`);
      }
    }
    try {
      this.notifyBestEffort(canonicalJson({ kind: "constitutional-route-terminally-blocked", journal_id: journal.journal_id, reason_digest: reasonDigest(reason) }));
    } catch {
      // Best effort by design.
    }
    return { outcome: "terminally-blocked", reason, journal: terminalPersisted ? terminalJournal : journal };
  }

  private terminalReceiptPersistencePending(): boolean {
    const bytes = readConstitutionalResource(this.paths.lock, this.paths.targetBlock);
    if (bytes === undefined) return false;
    try {
      const marker = JSON.parse(bytes) as { terminal_receipt_persistence_pending?: unknown };
      return marker.terminal_receipt_persistence_pending === true;
    } catch {
      // The target remains blocked by the resource-local marker; malformed
      // marker bytes must never authorize another signer attempt.
      return true;
    }
  }

  private requirePersistedDemotion(
    returned: ReturnType<RestoreOnlyCapability["signAndPersistDemotion"]>,
    targetScopeDigest: string,
    journalReceiptDigest: string,
  ): void {
    // The signer response is not durability evidence. Re-read the independently
    // protected authority paths after the helper returns, then require both the
    // returned view and durable view to identify the exact same signed tail.
    const persisted = this.authority.read();
    const verified = verifyOwnerAuthorization(persisted);
    const narrowed = verifyRuntimeNarrowing(
      persisted.runtimeNarrowing,
      persisted.recoveryRegistry,
      verified,
      persisted.runtimeNarrowingCheckpoint,
    );
    if (
      canonicalJson(returned.ledger) !== canonicalJson(persisted.runtimeNarrowing)
      || canonicalJson(returned.registry) !== canonicalJson(persisted.recoveryRegistry)
      || canonicalJson(returned.checkpoint) !== canonicalJson(persisted.runtimeNarrowingCheckpoint)
    ) {
      throw new Error("signed demotion response is not the independently persisted protected state");
    }
    const entries = (persisted.runtimeNarrowing as {
      entries?: Array<{ journal_receipt_digest?: unknown }>;
    }).entries;
    if (entries?.at(-1)?.journal_receipt_digest !== journalReceiptDigest) {
      throw new Error("persisted signed demotion is not bound to the exact revert receipt");
    }
    if (!narrowed.narrowedTargets.has(`micro-routing:${targetScopeDigest}`)) {
      throw new Error("persisted signed demotion did not narrow the exact target");
    }
  }
}

function guardOwner(journal: JournalV2): RouteGuardOwner {
  return {
    journalId: journal.journal_id,
    attemptId: journal.binding.attempt_id,
    bindingDigest: journal.binding_digest,
    targetScopeDigest: journal.binding.target_scope_digest,
    watchdogIdentity: journal.binding.watchdog_identity,
  };
}

function requireCandidateProof(verifier: CandidateVerifier, material: RecoveryMaterial): CandidateProof {
  const proof = verifier.verify({
    candidate: material.candidate,
    candidateDigest: material.candidate_digest,
    configDigest: material.plan.configDigest,
    evidenceDigest: material.plan.evidenceDigest,
    policyDigest: material.plan.policyDigest,
    postconditionsDigest: material.plan.postconditionsDigest,
  });
  if (
    proof.ok !== true
    || proof.candidateDigest !== material.candidate_digest
    || proof.postconditionsDigest !== material.plan.postconditionsDigest
    || !DIGEST.test(proof.proofDigest)
  ) throw new Error("candidate verifier returned an unbound or failed proof");
  return proof;
}
