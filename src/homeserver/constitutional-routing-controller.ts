/**
 * ADR-008 constitutional micro-routing executor.
 *
 * This is the only autonomous route-writer path. It deliberately does not
 * reuse the legacy approval-token/adoption-watchdog path: that path remains
 * useful for shadow proposals and owner-driven adoption, but its journal and
 * recovery authority do not satisfy the W0.1 constitution.
 *
 * Security boundary:
 * - protected authority readers are injected and re-read immediately before
 *   apply and commit;
 * - the controller can CAS baseline -> candidate, but has no restore or
 *   runtime-narrowing signing capability;
 * - a separately composed watchdog receives a restore-only recovery
 *   capability and a pre-registered recovery-worker signer;
 * - the exact public journal-v1 envelope is the authoritative state machine.
 *   Raw baseline/candidate bytes live in a mode-0600 recovery sidecar bound by
 *   the journal digests and cannot affect authorization.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  canonicalJson,
  digestJson,
  validateJournalV1,
  validateJournalV1Prefix,
  verifyMicroRoutingTargetState,
  verifyOwnerAuthorization,
  verifyRuntimeNarrowing,
  type OwnerAuthorizationInputs,
  type VerifiedAuthorization,
} from "./autonomy-contract-v1.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{2,62}$/;

export interface ConstitutionalRouteStore {
  read(): string;
  /** Atomic with respect to every autonomous writer for this route table. */
  compareAndSwap(expected: string, next: string): boolean;
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
  watchDeadline: string;
  contentRef: string;
}

export interface ConstitutionalPolicy {
  deadlineSeconds: number;
  watchSeconds: number;
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
  deadlineSeconds: 3600,
  watchSeconds: 3600,
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
  canary: { scope_digest: string; target_count: 1; watch_deadline: string };
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

export interface JournalV1 {
  kind: "autonomous-mutation-journal";
  schema_version: "v1";
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
  baseline: string;
  candidate: string;
  baseline_digest: string;
  candidate_digest: string;
  plan: RouteMutationPlan;
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
    journal: join(root, "journal-v1.json"),
    recoveryMaterial: join(root, "recovery-material.json"),
    attemptIndex: join(root, "attempt-index.json"),
    lock: join(root, "writer-lock.db"),
    targetBlock: join(root, "target-block.json"),
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

function atomicJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", mode);
  try {
    writeFileSync(fd, `${canonicalJson(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 1_000_000) throw new Error(`constitutional JSON exceeds 1 MiB: ${path}`);
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  let nodes = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 64) throw new Error(`constitutional JSON exceeds structural limits: ${path}`);
    if (Array.isArray(value)) {
      if (value.length > 4096) throw new Error(`constitutional JSON array exceeds entry limit: ${path}`);
      for (const entry of value) walk(entry, depth + 1);
    } else if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) walk(entry, depth + 1);
    }
  };
  walk(parsed, 0);
  return parsed;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Transactional ownership avoids file-lock stale-reclaim TOCTOU entirely. */
function withLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 2000");
  db.exec("CREATE TABLE IF NOT EXISTS constitutional_writer_lock (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL, token TEXT NOT NULL)");
  db.transaction(() => {
    const existing = db.prepare("SELECT pid, token FROM constitutional_writer_lock WHERE id=1").get() as { pid: number; token: string } | undefined;
    if (existing && processIsAlive(existing.pid)) throw new Error("constitutional route writer is already active");
    db.prepare("INSERT INTO constitutional_writer_lock(id,pid,token) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token").run(process.pid, token);
  }).immediate();
  try {
    return operation();
  } finally {
    try {
      db.transaction(() => {
        db.prepare("DELETE FROM constitutional_writer_lock WHERE id=1 AND token=?").run(token);
      }).immediate();
    } catch {
      // Never mask the operation result or delete another holder.
    }
    db.close();
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
  const watch = strictUtc(plan.watchDeadline);
  if (deadline <= start || deadline - start > policy.deadlineSeconds * 1000) {
    throw new Error("whole-operation deadline exceeds constitution");
  }
  if (watch <= start || watch > deadline || watch - start > policy.watchSeconds * 1000) {
    throw new Error("watch window exceeds constitution");
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
  plan: RouteMutationPlan,
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
  const target = verifyMicroRoutingTargetState({
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
    canary: { scope_digest: plan.targetScopeDigest, target_count: 1, watch_deadline: plan.watchDeadline },
    recovery: {
      class: "R-exact",
      worker_identity: identities.recovery_worker,
      descriptor_digest: plan.recoveryDescriptorDigest,
      disarms_after_action: true,
    },
  };
}

function reasonDigest(reason: string): string {
  return sha(`constitutional-reason-v1:${reason}`);
}

function append(
  journal: JournalV1,
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

function loadAttemptIndex(path: string): AttemptIndex {
  if (!existsSync(path)) return { schema_version: 1, attempts: [] };
  const parsed = readJson(path) as AttemptIndex;
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
  const inWindow = index.attempts.filter((attempt) => nowMs - strictUtc(attempt.started_at) < policy.attemptWindowSeconds * 1000);
  if (inWindow.length >= policy.maxAttemptsPerWindow || inWindow.length >= policy.maxAttempts) {
    throw new Error("constitutional attempt budget exhausted");
  }
  const latest = index.attempts.at(-1);
  if (latest && nowMs - strictUtc(latest.started_at) < policy.minSecondsBetweenAttempts * 1000) {
    throw new Error("constitutional minimum attempt interval has not elapsed");
  }
}

function loadJournal(paths: ConstitutionalPaths): JournalV1 {
  if (!existsSync(paths.journal)) throw new Error("no constitutional journal");
  return readJson(paths.journal) as JournalV1;
}

function loadMaterial(paths: ConstitutionalPaths, journal: JournalV1): RecoveryMaterial {
  const material = readJson(paths.recoveryMaterial) as RecoveryMaterial;
  const claimed = material.material_digest;
  const computed = digestJson(material, "material_digest");
  if (
    material.schema_version !== 1
    || material.journal_id !== journal.journal_id
    || material.binding_digest !== journal.binding_digest
    || material.baseline_digest !== journal.binding.baseline_digest
    || material.candidate_digest !== journal.binding.candidate_digest
    || material.authority_epoch_digest.length === 0
    || material.plan.attemptId !== journal.binding.attempt_id
    || !journal.entries.every((entry) => entry.content_refs.length === 1 && entry.content_refs[0] === material.plan.contentRef)
    || sha(material.baseline) !== material.baseline_digest
    || sha(material.candidate) !== material.candidate_digest
    || claimed !== computed
  ) {
    throw new Error("constitutional recovery material is corrupt or mismatched");
  }
  return material;
}

function saveAndValidate(paths: ConstitutionalPaths, journal: JournalV1, gate: FreshGate, terminal: boolean): void {
  if (terminal) {
    validateJournalV1(journal, gate.snapshot.constitution, gate.snapshot.coverage, gate.snapshot.attestations);
  } else {
    validateJournalV1Prefix(journal, gate.snapshot.constitution, gate.snapshot.coverage, gate.snapshot.attestations);
  }
  atomicJson(paths.journal, journal);
}

export type BeginResult =
  | { outcome: "watching"; journal: JournalV1 }
  | { outcome: "unknown"; journal: JournalV1; reason: string };

export class ConstitutionalRoutingController {
  private readonly paths: ConstitutionalPaths;

  constructor(
    dataDir: string,
    private readonly table: ConstitutionalRouteStore,
    private readonly authority: ProtectedAuthorityReader,
    private readonly verifier: CandidateVerifier,
    private readonly policy: ConstitutionalPolicy = MICRO_ROUTING_CONSTITUTIONAL_POLICY,
  ) {
    this.paths = constitutionalPaths(dataDir);
  }

  begin(plan: RouteMutationPlan): BeginResult {
    return withLock(this.paths.lock, () => {
      if (existsSync(this.paths.targetBlock)) throw new Error("micro-routing target is persistently blocked pending signed demotion reconciliation");
      const initial = freshGate(this.authority, plan, this.policy);
      requirePlan(plan, this.policy, initial.now);
      if (plan.recoveryDescriptorDigest !== digestJson(initial.snapshot)) {
        throw new Error("recovery descriptor does not bind the exact prepared authority snapshot");
      }
      if (existsSync(this.paths.journal)) {
        const prior = loadJournal(this.paths);
        const last = prior.entries.at(-1)?.phase;
        throw new Error(
          ["commit", "disarm", "terminally-blocked"].includes(String(last))
            ? "prior constitutional attempt must be archived by the owner procedure"
            : "constitutional attempt already in flight",
        );
      }
      if (this.table.read() !== plan.baseline) throw new Error("live route table does not match the proposed baseline");

      const index = loadAttemptIndex(this.paths.attemptIndex);
      enforceAttemptBounds(index, plan, initial.now, this.policy);
      const binding = makeBinding(plan, initial);
      const journal: JournalV1 = {
        kind: "autonomous-mutation-journal",
        schema_version: "v1",
        journal_id: plan.journalId,
        domain: "micro-routing",
        constitution_digest: (initial.snapshot.constitution as Record<string, string>).constitution_digest,
        binding,
        binding_digest: digestJson(binding),
        entries: [],
        extensions: [],
      };
      append(journal, "prepare", "prepared", binding.controller_identity, initial.now, "prepared-durable-before-write", plan.contentRef);
      const materialBase = {
        schema_version: 1 as const,
        journal_id: journal.journal_id,
        binding_digest: journal.binding_digest,
        baseline: plan.baseline,
        candidate: plan.candidate,
        baseline_digest: binding.baseline_digest,
        candidate_digest: binding.candidate_digest,
        plan: structuredClone(plan),
        authority_epoch_digest: authorityEpochDigest(initial),
        prepared_authority: structuredClone(initial.snapshot),
      };
      const material: RecoveryMaterial = { ...materialBase, material_digest: digestJson(materialBase) };

      // Recovery bytes and consumed attempt are durable before the public
      // prepare receipt; a crash at any later instruction is recoverable.
      atomicJson(this.paths.recoveryMaterial, material);
      saveAndValidate(this.paths, journal, initial, false);
      // The attempt index follows the recoverable journal. A crash before
      // this write leaves an in-flight journal that blocks/reconciles; it
      // never consumes an attempt without a journal.
      atomicJson(this.paths.attemptIndex, {
        ...index,
        attempts: [...index.attempts, { attempt_id: plan.attemptId, started_at: initial.now, binding_digest: journal.binding_digest }],
      } satisfies AttemptIndex);

      try {
        // No stale admission window: independently re-read all protected
        // authorization, narrowing, kill-switch, evidence/config, time and
        // liveness inputs immediately before the CAS.
        requirePreparedEpoch(freshGate(this.authority, plan, this.policy), material);
      } catch (error) {
        return this.unknown(journal, plan, `pre-apply-gate:${error instanceof Error ? error.message : String(error)}`);
      }

      if (!this.table.compareAndSwap(plan.baseline, plan.candidate) || sha(this.table.read()) !== binding.candidate_digest) {
        return this.unknown(journal, plan, "apply-or-candidate-readback-failed");
      }
      const appliedAt = this.authority.trustedNowIso();
      append(journal, "apply", "applied", binding.controller_identity, appliedAt, "candidate-readback-matches", plan.contentRef);
      saveAndValidate(this.paths, journal, initial, false);

      try {
        requirePreparedEpoch(freshGate(this.authority, plan, this.policy), material);
        this.requireProof(material);
      } catch (error) {
        return this.unknown(journal, plan, `verify-gate:${error instanceof Error ? error.message : String(error)}`);
      }
      const verifiedAt = this.authority.trustedNowIso();
      append(journal, "verify", "verified", binding.controller_identity, verifiedAt, "verifier-passes", plan.contentRef);
      append(journal, "watch", "watching", binding.controller_identity, verifiedAt, "canary-watch-started", plan.contentRef);
      saveAndValidate(this.paths, journal, initial, false);
      return { outcome: "watching", journal };
    });
  }

  commit(): { outcome: "committed" | "unknown"; journal: JournalV1; reason?: string } {
    return withLock(this.paths.lock, () => {
      const journal = loadJournal(this.paths);
      const material = loadMaterial(this.paths, journal);
      const plan = material.plan;
      if (journal.entries.at(-1)?.phase !== "watch") {
        throw new Error("constitutional commit does not match an in-flight watch");
      }
      let gate: FreshGate;
      try {
        gate = freshGate(this.authority, plan, this.policy);
        requirePreparedEpoch(gate, material);
        const now = strictUtc(gate.now);
        if (now < strictUtc(journal.binding.canary.watch_deadline)) throw new Error("watch window is incomplete");
        if (now > strictUtc(journal.binding.deadline)) throw new Error("whole-operation deadline expired");
        if (sha(this.table.read()) !== journal.binding.candidate_digest) throw new Error("candidate readback changed during watch");
        this.requireProof(material);
      } catch (error) {
        const result = this.unknown(journal, plan, `pre-commit-gate:${error instanceof Error ? error.message : String(error)}`);
        return { outcome: "unknown", journal: result.journal, reason: result.reason };
      }
      append(journal, "commit", "committed", journal.binding.controller_identity, gate.now, "canary-watch-complete", plan.contentRef);
      saveAndValidate(this.paths, journal, gate, true);
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

  private unknown(journal: JournalV1, plan: RouteMutationPlan, reason: string): BeginResult & { outcome: "unknown" } {
    const now = this.authority.trustedNowIso();
    append(journal, "unknown", "unknown", journal.binding.controller_identity, now, reason, plan.contentRef);
    // Prefix validation is performed against a fresh protected read when
    // possible. If authority itself is unavailable, persist the monotone
    // receipt anyway; the watchdog validates it against its protected copy.
    try {
      const gate = freshGate(this.authority, plan, this.policy);
      saveAndValidate(this.paths, journal, gate, false);
    } catch {
      atomicJson(this.paths.journal, journal);
    }
    return { outcome: "unknown", journal, reason };
  }
}

export interface RestoreOnlyCapability {
  readonly recoveryWorkerIdentity: string;
  /**
   * Implemented by a separately privileged worker. It can write only the
   * pre-registered baseline bound to this journal, never arbitrary bytes.
   */
  restorePreRegisteredBaseline(input: {
    journalId: string;
    bindingDigest: string;
    baseline: string;
    baselineDigest: string;
    candidateDigest: string;
  }): "restored" | "already-baseline" | "failed";
  /**
   * Appends a recovery-worker-signed armed-* -> shadow narrowing and returns
   * the independently readable resulting ledger and protected tail.
   */
  signAndPersistDemotion(input: {
    ownerAuthorizationDigest: string;
    domain: "micro-routing";
    targetScopeDigest: string;
    journalReceiptDigest: string;
  }): { ledger: unknown; registry: unknown; checkpoint: unknown };
}

export interface WatchdogTickResult {
  outcome: "noop" | "waiting" | "reverted" | "terminally-blocked";
  reason: string;
  journal?: JournalV1;
}

export class ConstitutionalRoutingWatchdog {
  private readonly paths: ConstitutionalPaths;

  constructor(
    dataDir: string,
    private readonly authority: ProtectedAuthorityReader,
    private readonly recovery: RestoreOnlyCapability,
    private readonly notifyBestEffort: (summary: string) => void = () => undefined,
    private readonly policy: ConstitutionalPolicy = MICRO_ROUTING_CONSTITUTIONAL_POLICY,
  ) {
    this.paths = constitutionalPaths(dataDir);
  }

  tick(): WatchdogTickResult {
    return withLock(this.paths.lock, () => {
      if (!existsSync(this.paths.journal)) return { outcome: "noop", reason: "no-journal" };
      const journal = loadJournal(this.paths);
      const last = journal.entries.at(-1);
      if (!last) return { outcome: "terminally-blocked", reason: "empty-journal" };
      if (["commit", "disarm", "terminally-blocked"].includes(last.phase)) {
        if (last.phase === "terminally-blocked" && existsSync(this.paths.targetBlock)) {
          try {
            const material = loadMaterial(this.paths, journal);
            const snapshot = material.prepared_authority;
            const verified = verifyOwnerAuthorization(snapshot);
            const demotion = this.recovery.signAndPersistDemotion({
              ownerAuthorizationDigest: verified.authorizationDigest,
              domain: "micro-routing",
              targetScopeDigest: journal.binding.target_scope_digest,
              journalReceiptDigest: last.receipt_digest,
            });
            const narrowed = verifyRuntimeNarrowing(demotion.ledger, demotion.registry, verified, demotion.checkpoint);
            const entries = (demotion.ledger as { entries?: Array<{ journal_receipt_digest?: unknown }> }).entries;
            if (
              entries?.at(-1)?.journal_receipt_digest !== last.receipt_digest
              || !narrowed.narrowedTargets.has(`micro-routing:${journal.binding.target_scope_digest}`)
            ) {
              throw new Error("reconciled demotion is not bound to the terminal receipt and target");
            }
            unlinkSync(this.paths.targetBlock);
            return { outcome: "noop", reason: "terminal-signed-demotion-reconciled", journal };
          } catch (error) {
            return {
              outcome: "terminally-blocked",
              reason: `terminal-signed-demotion-pending:${error instanceof Error ? error.message : String(error)}`,
              journal,
            };
          }
        }
        return { outcome: "noop", reason: `terminal-${last.phase}`, journal };
      }
      const material = loadMaterial(this.paths, journal);
      const now = this.authority.trustedNowIso();
      const expired = strictUtc(now) >= strictUtc(journal.binding.deadline);
      const silence = strictUtc(now) - strictUtc(last.recorded_at) >= this.policy.maxSilenceSeconds * 1000;
      const kill = this.authority.killSwitchActive();
      if (!expired && !silence && !kill && last.phase !== "unknown") {
        return { outcome: "waiting", reason: "watch-active", journal };
      }

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
        const target = verifyMicroRoutingTargetState({
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
        validateJournalV1Prefix(journal, snapshot.constitution, snapshot.coverage, snapshot.attestations);
      } catch (error) {
        return this.terminalBlock(
          journal,
          material,
          `authority-or-journal-invalid:${error instanceof Error ? error.message : String(error)}`,
          now,
        );
      }
      if (this.recovery.recoveryWorkerIdentity !== journal.binding.recovery_worker_identity) {
        return this.terminalBlock(journal, material, "recovery-worker-identity-mismatch", now);
      }

      if (last.phase !== "unknown") {
        append(journal, "unknown", "unknown", journal.binding.watchdog_identity, now, expired ? "deadline-expired" : kill ? "kill-switch-active" : "watchdog-silence-bound-exceeded", material.plan.contentRef);
        saveAndValidate(this.paths, journal, gate, false);
      }
      atomicJson(this.paths.targetBlock, {
        schema_version: 1,
        target_scope_digest: journal.binding.target_scope_digest,
        binding_digest: journal.binding_digest,
        reason_digest: reasonDigest("recovery-in-progress"),
        blocked_at: now,
        signed_demotion_pending: true,
      });

      const restored = this.recovery.restorePreRegisteredBaseline({
        journalId: journal.journal_id,
        bindingDigest: journal.binding_digest,
        baseline: material.baseline,
        baselineDigest: material.baseline_digest,
        candidateDigest: material.candidate_digest,
      });
      if (!["restored", "already-baseline"].includes(restored)) {
        return this.terminalBlock(journal, material, "exact-baseline-restore-failed", now, gate);
      }
      append(journal, "revert", "reverted", journal.binding.recovery_worker_identity, now, "baseline-digest-restored", material.plan.contentRef);
      saveAndValidate(this.paths, journal, gate, false);

      let demotion: ReturnType<RestoreOnlyCapability["signAndPersistDemotion"]>;
      try {
        demotion = this.recovery.signAndPersistDemotion({
          ownerAuthorizationDigest: gate.verified.authorizationDigest,
          domain: "micro-routing",
          targetScopeDigest: journal.binding.target_scope_digest,
          journalReceiptDigest: journal.entries.at(-1)!.receipt_digest,
        });
        const narrowed = verifyRuntimeNarrowing(
          demotion.ledger,
          demotion.registry,
          gate.verified,
          demotion.checkpoint,
        );
        const entries = (demotion.ledger as { entries?: Array<{ journal_receipt_digest?: unknown }> }).entries;
        if (entries?.at(-1)?.journal_receipt_digest !== journal.entries.at(-1)!.receipt_digest) {
          throw new Error("signed demotion is not bound to the exact revert receipt");
        }
        if (!narrowed.narrowedTargets.has(`micro-routing:${journal.binding.target_scope_digest}`)) {
          throw new Error("signed demotion did not narrow the exact target");
        }
      } catch (error) {
        return this.terminalBlock(
          journal,
          material,
          `signed-demotion-failed:${error instanceof Error ? error.message : String(error)}`,
          now,
          gate,
        );
      }
      append(journal, "disarm", "disarmed", journal.binding.recovery_worker_identity, now, "recovery-worker-disarm-confirmed", material.plan.contentRef);
      saveAndValidate(this.paths, journal, gate, true);
      unlinkSync(this.paths.targetBlock);
      try {
        this.notifyBestEffort(canonicalJson({ kind: "constitutional-route-reverted", journal_id: journal.journal_id }));
      } catch {
        // Observers and notification transport never gate recovery.
      }
      return { outcome: "reverted", reason: "baseline-restored-and-target-demoted", journal };
    });
  }

  private terminalBlock(
    journal: JournalV1,
    material: RecoveryMaterial,
    reason: string,
    now: string,
    gate?: FreshGate,
  ): WatchdogTickResult {
    if (journal.entries.at(-1)?.phase !== "unknown") {
      append(journal, "unknown", "unknown", journal.binding.watchdog_identity, now, reason, material.plan.contentRef);
    }
    append(journal, "terminally-blocked", "terminally-blocked", journal.binding.recovery_worker_identity, now, reason, material.plan.contentRef);
    atomicJson(this.paths.targetBlock, {
      schema_version: 1,
      target_scope_digest: journal.binding.target_scope_digest,
      binding_digest: journal.binding_digest,
      reason_digest: reasonDigest(reason),
      blocked_at: now,
      signed_demotion_pending: true,
    });
    if (gate) {
      try {
        saveAndValidate(this.paths, journal, gate, true);
      } catch {
        atomicJson(this.paths.journal, journal);
      }
    } else {
      atomicJson(this.paths.journal, journal);
    }
    try {
      this.notifyBestEffort(canonicalJson({ kind: "constitutional-route-terminally-blocked", journal_id: journal.journal_id, reason_digest: reasonDigest(reason) }));
    } catch {
      // Best effort by design.
    }
    return { outcome: "terminally-blocked", reason, journal };
  }
}
