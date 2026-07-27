/**
 * Faithful in-process consumer of Grimnir ADR-008 W0.1 authorization and
 * runtime-narrowing contracts.  Inputs are deliberately supplied by protected
 * readers; this module never reads controller-writable paths or supplies keys.
 */
import { createHash, createPublicKey, verify } from "node:crypto";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9-]{2,62}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const DOMAINS = new Set(["micro-routing", "macro-routing", "prompt", "harness", "tool-policy", "served-model-roster", "no-reboot-security-bugfix-maintenance"]);
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export const canonicalJson = (v: unknown): string => {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") throw new Error("ADR-008 authorization rejected: non-JSON canonical value");
  if (plain(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const encoded = JSON.stringify(v);
  if (encoded === undefined) throw new Error("ADR-008 authorization rejected: non-JSON canonical value");
  return encoded;
};
export const digestJson = (v: unknown, omit?: string): string => { const x = structuredClone(v) as Record<string, unknown>; if (omit) delete x[omit]; return `sha256:${createHash("sha256").update(canonicalJson(x)).digest("hex")}`; };
const exact = (v: unknown, keys: string[]) => plain(v) && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const utc = (v: unknown) => { if (typeof v !== "string" || !UTC.test(v)) return false; const ms = Date.parse(v); return Number.isFinite(ms) && new Date(ms).toISOString().replace(".000Z", "Z") === v; };
function fail(reason: string): never { throw new Error(`ADR-008 authorization rejected: ${reason}`); }
function bounded(v: unknown): void { let nodes = 0; const walk = (x: unknown, depth = 0) => { if (++nodes > 10_000 || depth > 64) fail("input exceeds structural limits"); if (plain(x)) Object.values(x).forEach((y) => walk(y, depth + 1)); else if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1)); }; walk(v); if (Buffer.byteLength(canonicalJson(v)) > 1_000_000) fail("input exceeds 1 MiB"); }

export interface OwnerAuthorizationInputs { authorization: unknown; constitution: unknown; coverage: unknown; attestations: unknown; recoveryRegistry: unknown; pinnedOwnerPublicKeyPem: string; checkpoint: unknown; }
export interface VerifiedAuthorization { authorizationDigest: string; recoveryRegistryDigest: string; authorization: Record<string, unknown>; }
/** Mirrors Grimnir's verify-autonomy-owner-authorization.mjs, including its independent pin/checkpoint. */
export function verifyOwnerAuthorization(i: OwnerAuthorizationInputs): VerifiedAuthorization {
  Object.values(i).forEach(bounded);
  const a = i.authorization as Record<string, any>;
  if (!exact(a, ["kind", "schema_version", "authorization_id", "authorization_sequence", "previous_authorization_digest", "issued_at", "authority", "bindings", "signature"]) || !exact(a.authority, ["key_id", "algorithm", "public_key_pem", "public_key_fingerprint"]) || !exact(a.bindings, ["constitution_digest", "coverage_intent_digest", "owner_attestation_registry_digest", "recovery_worker_registry_digest"]) || !exact(a.signature, ["algorithm", "value_base64"])) fail("invalid closed manifest shape");
  const c = i.checkpoint as Record<string, any>;
  if (!exact(c, ["kind", "schema_version", "authorization_digest", "minimum_sequence"]) || c.kind !== "autonomy-owner-authorization-checkpoint" || c.schema_version !== "v1" || !DIGEST.test(String(c.authorization_digest)) || !Number.isSafeInteger(c.minimum_sequence) || c.minimum_sequence < 1) fail("invalid protected checkpoint");
  if (a.kind !== "autonomy-owner-authorization" || a.schema_version !== "v1" || !ID.test(String(a.authorization_id)) || !ID.test(String(a.authority.key_id)) || !utc(a.issued_at) || !Number.isSafeInteger(a.authorization_sequence) || a.authorization_sequence < c.minimum_sequence || (a.authorization_sequence === 1) !== (a.previous_authorization_digest === null) || (a.authorization_sequence > 1 && !DIGEST.test(String(a.previous_authorization_digest)))) fail("invalid authorization identity, time, sequence, or predecessor");
  if (a.authority.algorithm !== "Ed25519" || a.signature.algorithm !== "Ed25519" || typeof a.signature.value_base64 !== "string") fail("non-Ed25519 authorization");
  const key = createPublicKey(String(a.authority.public_key_pem)), pin = createPublicKey(i.pinnedOwnerPublicKeyPem);
  if (key.asymmetricKeyType !== "ed25519" || pin.asymmetricKeyType !== "ed25519" || !key.export({ type: "spki", format: "der" }).equals(pin.export({ type: "spki", format: "der" }))) fail("manifest key is not independently pinned");
  const fingerprint = `sha256:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`;
  if (a.authority.public_key_fingerprint !== fingerprint || !verify(null, Buffer.from(canonicalJson(Object.fromEntries(Object.entries(a).filter(([k]) => k !== "signature")))), key, Buffer.from(a.signature.value_base64, "base64"))) fail("owner key fingerprint or signature mismatch");
  const bindings = a.bindings as Record<string, unknown>;
  if (bindings.constitution_digest !== digestJson(i.constitution, "constitution_digest") || bindings.coverage_intent_digest !== digestJson(i.coverage, "registry_digest") || bindings.owner_attestation_registry_digest !== digestJson(i.attestations, "registry_digest") || bindings.recovery_worker_registry_digest !== digestJson(i.recoveryRegistry, "registry_digest")) fail("artifact digest binding mismatch");
  if (!plain(i.constitution) || !plain(i.coverage) || !plain(i.attestations) || !plain(i.recoveryRegistry) || i.constitution.constitution_digest !== digestJson(i.constitution, "constitution_digest") || i.coverage.registry_digest !== digestJson(i.coverage, "registry_digest") || i.attestations.registry_digest !== digestJson(i.attestations, "registry_digest") || i.recoveryRegistry.registry_digest !== digestJson(i.recoveryRegistry, "registry_digest")) fail("artifact self-digest mismatch");
  const rr = i.recoveryRegistry as Record<string, any>;
  if (!exact(rr, ["kind", "schema_version", "registry_id", "entries", "registry_digest", "extensions"]) || rr.kind !== "autonomy-recovery-worker-registry" || rr.schema_version !== "v1" || !ID.test(String(rr.registry_id)) || !Array.isArray(rr.entries) || rr.entries.length > 256 || !Array.isArray(rr.extensions) || rr.extensions.length) fail("invalid closed recovery registry");
  const tuples = new Set<string>(), fingerprints = new Set<string>();
  for (const entry of rr.entries) {
    if (!exact(entry, ["domain", "target_scope_digest", "recovery_worker_identity", "public_key_pem", "public_key_fingerprint"]) || !DOMAINS.has(String(entry.domain)) || !DIGEST.test(String(entry.target_scope_digest)) || !ID.test(String(entry.recovery_worker_identity))) fail("invalid recovery binding");
    const recoveryKey = createPublicKey(String(entry.public_key_pem)), fp = `sha256:${createHash("sha256").update(recoveryKey.export({ type: "spki", format: "der" })).digest("hex")}`, tuple = `${entry.domain}:${entry.target_scope_digest}:${entry.recovery_worker_identity}`;
    if (recoveryKey.asymmetricKeyType !== "ed25519" || fp !== entry.public_key_fingerprint || tuples.has(tuple) || fingerprints.has(fp)) fail("invalid or ambiguous recovery key"); tuples.add(tuple); fingerprints.add(fp);
  }
  const authDigest = digestJson(a); if (c.authorization_digest !== authDigest) fail("authorization replay or protected checkpoint mismatch");
  return { authorizationDigest: authDigest, recoveryRegistryDigest: digestJson(i.recoveryRegistry, "registry_digest"), authorization: a };
}

export interface VerifiedRuntimeNarrowing {
  narrowedTargets: ReadonlySet<string>;
  entryCount: number;
  tailDigest: string | null;
}

export function verifyRuntimeNarrowing(ledger: unknown, registry: unknown, verified: VerifiedAuthorization, tail: unknown): VerifiedRuntimeNarrowing {
  bounded(ledger); bounded(registry); bounded(tail);
  const l = ledger as Record<string, any>, r = registry as Record<string, any>, t = tail as Record<string, any>;
  if (!exact(l, ["kind", "schema_version", "ledger_id", "owner_authorization_digest", "entries", "extensions"]) || l.kind !== "autonomy-runtime-narrowing" || l.schema_version !== "v1" || !ID.test(String(l.ledger_id)) || l.owner_authorization_digest !== verified.authorizationDigest || !Array.isArray(l.entries) || l.entries.length > 4096 || !Array.isArray(l.extensions) || l.extensions.length) fail("invalid closed runtime ledger");
  if (!exact(r, ["kind", "schema_version", "registry_id", "entries", "registry_digest", "extensions"]) || r.kind !== "autonomy-recovery-worker-registry" || r.schema_version !== "v1" || !ID.test(String(r.registry_id)) || r.registry_digest !== verified.recoveryRegistryDigest || r.registry_digest !== digestJson(r, "registry_digest") || !Array.isArray(r.entries) || r.entries.length > 256 || !Array.isArray(r.extensions) || r.extensions.length) fail("substituted recovery registry");
  let previous: string | null = null;
  const bindings = new Set<string>();
  const narrowedTargets = new Set<string>();
  for (const [index, entry] of l.entries.entries()) {
    if (!exact(entry, ["sequence", "recorded_at", "domain", "target_scope_digest", "from_state", "to_state", "recovery_worker_identity", "journal_receipt_digest", "previous_entry_digest", "entry_digest", "signature"]) || !exact(entry.signature, ["algorithm", "value_base64"]) || !Number.isSafeInteger(entry.sequence) || entry.sequence !== index + 1 || !utc(entry.recorded_at) || !DOMAINS.has(String(entry.domain)) || !ID.test(String(entry.recovery_worker_identity)) || !DIGEST.test(String(entry.target_scope_digest)) || !DIGEST.test(String(entry.journal_receipt_digest)) || !DIGEST.test(String(entry.entry_digest)) || (entry.previous_entry_digest !== null && !DIGEST.test(String(entry.previous_entry_digest))) || entry.previous_entry_digest !== previous || !["armed-canary", "armed-fleet"].includes(String(entry.from_state)) || entry.to_state !== "shadow" || entry.signature.algorithm !== "Ed25519" || !/^[A-Za-z0-9+/]+={0,2}$/.test(String(entry.signature.value_base64))) fail("invalid or widening narrowing entry");
    const bound = r.entries.find((binding: any) => binding.domain === entry.domain && binding.target_scope_digest === entry.target_scope_digest && binding.recovery_worker_identity === entry.recovery_worker_identity);
    if (!bound || !exact(bound, ["domain", "target_scope_digest", "recovery_worker_identity", "public_key_pem", "public_key_fingerprint"])) fail("unbound recovery binding");
    const bindingIdentity = `${entry.domain}:${entry.target_scope_digest}:${entry.recovery_worker_identity}`;
    if (bindings.has(bindingIdentity)) fail("duplicate narrowing worker binding");
    bindings.add(bindingIdentity);
    const key = createPublicKey(bound.public_key_pem), fp = `sha256:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`;
    if (key.asymmetricKeyType !== "ed25519" || fp !== bound.public_key_fingerprint || !verify(null, Buffer.from(canonicalJson(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "signature")))), key, Buffer.from(String(entry.signature.value_base64), "base64")) || entry.entry_digest !== digestJson(Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "entry_digest" && k !== "signature")))) fail("unbound or forged narrowing entry");
    previous = entry.entry_digest as string;
    narrowedTargets.add(`${entry.domain}:${entry.target_scope_digest}`);
  }
  if (!exact(t, ["kind", "schema_version", "owner_authorization_digest", "ledger_tail_digest", "minimum_entries"]) || t.kind !== "autonomy-runtime-narrowing-checkpoint" || t.schema_version !== "v1" || t.owner_authorization_digest !== verified.authorizationDigest || t.ledger_tail_digest !== previous || !Number.isSafeInteger(t.minimum_entries) || t.minimum_entries < 0 || l.entries.length < t.minimum_entries) fail("narrowing truncation or tail checkpoint mismatch");
  return { narrowedTargets, entryCount: l.entries.length, tailDigest: previous };
}

export interface TargetStateVerificationInputs {
  coverage: unknown;
  attestations: unknown;
  verified: VerifiedAuthorization;
  narrowing: VerifiedRuntimeNarrowing;
  targetScopeDigest: string;
  writerOwner: string;
  controllerIdentity: string;
}

const COVERAGE_ROW_KEYS = ["domain", "required_for_levels", "owner_scope", "owner", "recovery_class", "coverage", "target_state", "bindings"];
const COVERAGE_BINDING_KEYS = ["writer_owner", "owner_authority_ref", "owner_authority_digest", "configuration_owner", "configuration_owner_authority_ref", "configuration_owner_authority_digest", "target_scope_digest", "state", "identities"];
const IDENTITY_KEYS = ["owner", "controller", "watchdog", "kill_switch", "recovery_worker"];
const ATTESTATION_KEYS = ["attestation_id", "domain", "target_scope_digest", "configuration_owner", "issued_at", "attestation_digest"];

/** Resolves one exact owner-attested target from signed intent plus the signed runtime tail. */
export function verifyMicroRoutingTargetState(i: TargetStateVerificationInputs): { admittedState: "armed-canary" | "armed-fleet"; effectiveState: "armed-canary" | "armed-fleet" | "shadow" } {
  bounded(i.coverage); bounded(i.attestations);
  const coverage = i.coverage as Record<string, any>, attestations = i.attestations as Record<string, any>;
  const authorizationBindings = i.verified.authorization["bindings"] as Record<string, unknown>;
  if (authorizationBindings["coverage_intent_digest"] !== digestJson(coverage, "registry_digest") || authorizationBindings["owner_attestation_registry_digest"] !== digestJson(attestations, "registry_digest")) fail("current state is not owner-authorized");
  if (!exact(coverage, ["kind", "schema_version", "registry_id", "issued_at", "constitution_digest", "mutation_policy", "global_state", "domains", "registry_digest", "extensions"]) || coverage.kind !== "autonomy-coverage-registry" || coverage.schema_version !== "v1" || coverage.global_state !== "armed" || coverage.registry_digest !== digestJson(coverage, "registry_digest") || !Array.isArray(coverage.domains) || !Array.isArray(coverage.extensions) || coverage.extensions.length) fail("invalid or disarmed current coverage");
  if (!exact(attestations, ["kind", "schema_version", "registry_id", "issued_at", "issuer_identity", "mutation_policy", "attestations", "registry_digest", "extensions"]) || attestations.kind !== "autonomy-owner-attestation-registry" || attestations.schema_version !== "v1" || attestations.mutation_policy !== "owner-controlled-protected-lane" || attestations.registry_digest !== digestJson(attestations, "registry_digest") || !Array.isArray(attestations.attestations) || !Array.isArray(attestations.extensions) || attestations.extensions.length) fail("invalid owner attestation registry");
  for (const row of coverage.domains) {
    if (!exact(row, COVERAGE_ROW_KEYS) || !Array.isArray(row.bindings)) fail("invalid closed coverage row");
    for (const binding of row.bindings) if (!exact(binding, COVERAGE_BINDING_KEYS) || !exact(binding.identities, IDENTITY_KEYS)) fail("invalid closed coverage binding");
  }
  for (const attestation of attestations.attestations) if (!exact(attestation, ATTESTATION_KEYS) || attestation.attestation_digest !== digestJson(attestation, "attestation_digest")) fail("invalid closed owner attestation");
  const row = coverage.domains.find((candidate: any) => candidate?.domain === "micro-routing");
  if (!row || !["armed-canary", "armed-fleet"].includes(row.coverage) || !Array.isArray(row.bindings)) fail("micro-routing is not armed");
  const binding = row.bindings.find((candidate: any) => candidate?.target_scope_digest === i.targetScopeDigest);
  if (!binding || binding.state !== row.coverage || binding.writer_owner !== i.writerOwner || binding.configuration_owner !== i.writerOwner || binding.identities?.controller !== i.controllerIdentity) fail("exact target, owner, controller, or current state mismatch");
  const attestation = attestations.attestations.find((candidate: any) =>
    candidate?.domain === "micro-routing"
    && candidate.target_scope_digest === i.targetScopeDigest
    && candidate.configuration_owner === i.writerOwner
    && `ref:${candidate.attestation_id}` === binding.configuration_owner_authority_ref
    && candidate.attestation_digest === binding.configuration_owner_authority_digest);
  if (!attestation) fail("exact target owner attestation mismatch");
  const admittedState = binding.state as "armed-canary" | "armed-fleet";
  const effectiveState = i.narrowing.narrowedTargets.has(`micro-routing:${i.targetScopeDigest}`) ? "shadow" : admittedState;
  return { admittedState, effectiveState };
}

const OUTCOME_FOR: Record<string, string> = {
  prepare: "prepared", apply: "applied", verify: "verified", watch: "watching", commit: "committed",
  unknown: "unknown", revert: "reverted", recover: "recovered", quarantine: "quarantined",
  disarm: "disarmed", "terminally-blocked": "terminally-blocked",
};
const BINDING_KEYS = ["mutation_id", "attempt_id", "recovery_disarm_id", "idempotency_key", "writer_owner", "owner_authority_ref", "owner_authority_digest", "configuration_owner", "configuration_owner_authority_ref", "configuration_owner_authority_digest", "target_scope_digest", "admission_coverage_digest", "admission_binding_state", "owner_identity", "controller_identity", "watchdog_identity", "kill_switch_identity", "recovery_worker_identity", "risk_scope", "candidate_digest", "config_digest", "evidence_digest", "policy_digest", "baseline_digest", "postconditions_digest", "deadline", "canary", "recovery"];
const ENTRY_KEYS = ["entry_id", "sequence", "recorded_at", "phase", "outcome", "executor_identity", "binding_digest", "quarantine", "coverage_transition", "terminal_reason_digest", "previous_receipt_digest", "receipt_digest", "content_refs"];

export interface JournalValidationResult {
  terminal: "commit" | "disarm" | "terminally-blocked";
  entries: number;
  bindingDigest: string;
}
export interface JournalPrefixValidationResult {
  phase: string;
  terminal: boolean;
  entries: number;
  bindingDigest: string;
}

/** Strict schema + semantic verifier for the exact public journal-v1 contract. */
export function validateJournalV1(journal: unknown, constitution: unknown, coverage: unknown, attestations: unknown): JournalValidationResult {
  const result = validateJournal(journal, constitution, coverage, attestations, true);
  return {
    terminal: result.phase as JournalValidationResult["terminal"],
    entries: result.entries,
    bindingDigest: result.bindingDigest,
  };
}

/**
 * Strictly validates an in-flight prefix of journal-v1.
 *
 * The public terminal fixtures intentionally require an explicit commit,
 * disarm, or terminally-blocked outcome. A durable executor must also be able
 * to validate the prepared/applied/verified/watching prefix after a crash
 * without pretending that it is terminal. This function applies every
 * envelope, binding, receipt-chain, authority, deadline, role, and transition
 * check below, but returns the current phase instead of requiring a terminal.
 */
export function validateJournalV1Prefix(
  journal: unknown,
  constitution: unknown,
  coverage: unknown,
  attestations: unknown,
): JournalPrefixValidationResult {
  return validateJournal(journal, constitution, coverage, attestations, false);
}

function validateJournal(
  journal: unknown,
  constitution: unknown,
  coverage: unknown,
  attestations: unknown,
  requireTerminal: boolean,
): JournalPrefixValidationResult {
  bounded(journal); bounded(constitution); bounded(coverage); bounded(attestations);
  const j = journal as Record<string, any>, c = constitution as Record<string, any>, registry = coverage as Record<string, any>, owners = attestations as Record<string, any>;
  if (!exact(j, ["kind", "schema_version", "journal_id", "domain", "constitution_digest", "binding", "binding_digest", "entries", "extensions"]) || j.kind !== "autonomous-mutation-journal" || j.schema_version !== "v1" || !ID.test(String(j.journal_id)) || !DOMAINS.has(String(j.domain)) || !Array.isArray(j.entries) || j.entries.length < (requireTerminal ? 2 : 1) || !Array.isArray(j.extensions) || j.extensions.length) fail("malformed journal envelope");
  if (!plain(c) || c.constitution_digest !== digestJson(c, "constitution_digest") || j.constitution_digest !== c.constitution_digest || !Array.isArray(c.autonomous_classes)) fail("journal constitution binding mismatch");
  const policy = c.autonomous_classes.find((candidate: any) => candidate?.class === j.domain);
  if (!policy || !plain(policy.bounds)) fail("journal domain is not an approved class");
  const b = j.binding as Record<string, any>;
  if (!exact(b, BINDING_KEYS) || !exact(b.canary, ["scope_digest", "target_count", "watch_deadline"]) || !exact(b.recovery, ["class", "worker_identity", "descriptor_digest", "disarms_after_action"])) fail("invalid closed journal binding");
  const identities = [b.owner_identity, b.controller_identity, b.watchdog_identity, b.kill_switch_identity, b.recovery_worker_identity];
  if (![b.mutation_id, b.attempt_id, b.recovery_disarm_id, b.idempotency_key, b.writer_owner, b.configuration_owner, ...identities, b.risk_scope].every((x) => ID.test(String(x))) || new Set(identities).size !== 5 || b.attempt_id === b.recovery_disarm_id) fail("journal binding identities invalid");
  if (![b.owner_authority_digest, b.configuration_owner_authority_digest, b.target_scope_digest, b.admission_coverage_digest, b.candidate_digest, b.config_digest, b.evidence_digest, b.policy_digest, b.baseline_digest, b.postconditions_digest, b.recovery.descriptor_digest].every((x) => DIGEST.test(String(x))) || !/^ref:[a-z][a-z0-9-]{2,120}$/.test(String(b.owner_authority_ref)) || !/^ref:[a-z][a-z0-9-]{2,120}$/.test(String(b.configuration_owner_authority_ref))) fail("journal binding formats invalid");
  if (!utc(b.deadline) || !utc(b.canary.watch_deadline) || b.canary.target_count !== 1 || b.canary.scope_digest !== b.target_scope_digest || b.recovery.class !== policy.recovery_class || b.recovery.worker_identity !== b.recovery_worker_identity || b.recovery.disarms_after_action !== true || b.risk_scope !== j.domain || !["armed-canary", "armed-fleet"].includes(b.admission_binding_state) || j.binding_digest !== digestJson(b)) fail("journal immutable binding mismatch");
  if (!exact(registry, ["kind", "schema_version", "registry_id", "issued_at", "constitution_digest", "mutation_policy", "global_state", "domains", "registry_digest", "extensions"]) || registry.registry_digest !== digestJson(registry, "registry_digest") || registry.global_state !== "armed" || b.admission_coverage_digest !== registry.registry_digest || !Array.isArray(registry.domains) || !Array.isArray(registry.extensions) || registry.extensions.length) fail("journal admission coverage mismatch");
  for (const coverageRow of registry.domains) {
    if (!exact(coverageRow, COVERAGE_ROW_KEYS) || !Array.isArray(coverageRow.bindings)) fail("invalid closed journal coverage row");
    for (const binding of coverageRow.bindings) if (!exact(binding, COVERAGE_BINDING_KEYS) || !exact(binding.identities, IDENTITY_KEYS)) fail("invalid closed journal coverage binding");
  }
  const row = registry.domains.find((candidate: any) => candidate?.domain === j.domain);
  const ownerBinding = row?.bindings?.find((candidate: any) => candidate?.target_scope_digest === b.target_scope_digest && candidate.writer_owner === b.writer_owner && candidate.owner_authority_ref === b.owner_authority_ref && candidate.owner_authority_digest === b.owner_authority_digest && candidate.configuration_owner === b.configuration_owner && candidate.configuration_owner_authority_ref === b.configuration_owner_authority_ref && candidate.configuration_owner_authority_digest === b.configuration_owner_authority_digest);
  if (!ownerBinding || row.coverage !== b.admission_binding_state || ownerBinding.state !== b.admission_binding_state || b.writer_owner !== b.configuration_owner) fail("journal exact owner-controlled coverage binding mismatch");
  if (!exact(owners, ["kind", "schema_version", "registry_id", "issued_at", "issuer_identity", "mutation_policy", "attestations", "registry_digest", "extensions"]) || owners.registry_digest !== digestJson(owners, "registry_digest") || !Array.isArray(owners.attestations) || !Array.isArray(owners.extensions) || owners.extensions.length) fail("journal owner attestation registry mismatch");
  for (const ownerAttestation of owners.attestations) if (!exact(ownerAttestation, ATTESTATION_KEYS) || ownerAttestation.attestation_digest !== digestJson(ownerAttestation, "attestation_digest")) fail("invalid closed journal owner attestation");
  const attestation = owners.attestations.find((candidate: any) => candidate?.domain === j.domain && candidate.target_scope_digest === b.target_scope_digest && candidate.configuration_owner === b.configuration_owner && `ref:${candidate.attestation_id}` === b.configuration_owner_authority_ref && candidate.attestation_digest === b.configuration_owner_authority_digest);
  if (!attestation) fail("journal exact target owner attestation mismatch");
  const identityFields: Array<[string, string]> = [["owner_identity", "owner"], ["controller_identity", "controller"], ["watchdog_identity", "watchdog"], ["kill_switch_identity", "kill_switch"], ["recovery_worker_identity", "recovery_worker"]];
  for (const [field, identity] of identityFields) if (b[field] !== ownerBinding.identities?.[identity]) fail("journal authority identity does not match coverage");
  const start = Date.parse(j.entries[0]?.recorded_at);
  if (!Number.isFinite(start) || Date.parse(b.deadline) - start > policy.bounds.deadline_seconds * 1000 || Date.parse(b.canary.watch_deadline) > Date.parse(b.deadline)) fail("journal deadline exceeds constitutional bound");
  const transitions: Record<string, string[]> = policy.recovery_class === "R-exact"
    ? { prepare: ["apply", "unknown"], apply: ["verify", "unknown"], verify: ["watch", "unknown"], watch: ["commit", "unknown"], commit: [], unknown: ["revert", "terminally-blocked"], revert: ["disarm", "terminally-blocked"], disarm: [], "terminally-blocked": [] }
    : { prepare: ["apply", "unknown"], apply: ["verify", "unknown"], verify: ["watch", "unknown"], watch: ["commit", "unknown"], commit: [], unknown: ["recover", "terminally-blocked"], recover: ["quarantine", "terminally-blocked"], quarantine: ["disarm", "terminally-blocked"], disarm: [], "terminally-blocked": [] };
  let previous: string | null = null;
  const entryIds = new Set<string>();
  for (const [index, e] of j.entries.entries()) {
    if (!exact(e, ENTRY_KEYS) || !ID.test(String(e.entry_id)) || entryIds.has(e.entry_id) || e.sequence !== index + 1 || !utc(e.recorded_at) || OUTCOME_FOR[e.phase] !== e.outcome || !ID.test(String(e.executor_identity)) || e.binding_digest !== j.binding_digest || e.previous_receipt_digest !== previous || !DIGEST.test(String(e.receipt_digest)) || e.receipt_digest !== digestJson(e, "receipt_digest")) fail("malformed or tampered journal receipt");
    entryIds.add(e.entry_id);
    if (!exact(e.quarantine, ["state", "reason_digest"]) || !["not-applicable", "active"].includes(e.quarantine.state) || !DIGEST.test(String(e.quarantine.reason_digest)) || (e.terminal_reason_digest !== null && !DIGEST.test(String(e.terminal_reason_digest)))) fail("invalid journal quarantine or terminal reason");
    if (!Array.isArray(e.content_refs) || e.content_refs.length < 1 || new Set(e.content_refs).size !== e.content_refs.length || !e.content_refs.every((ref: unknown) => typeof ref === "string" && /^ref:[a-z][a-z0-9-]{2,120}$/.test(ref) && !/[/:.]/.test(ref.slice(4)))) fail("journal content references are not opaque and content-blind");
    if (index > 0) {
      const prior = j.entries[index - 1];
      if (Date.parse(e.recorded_at) < Date.parse(prior.recorded_at) || !transitions[prior.phase]?.includes(e.phase)) fail(`illegal journal transition ${prior.phase} -> ${e.phase}`);
    }
    if (["prepare", "apply", "verify", "watch", "commit"].includes(e.phase) && Date.parse(e.recorded_at) > Date.parse(b.deadline)) fail("late admission or mutation phase");
    if (e.phase === "watch" && (Date.parse(e.recorded_at) > Date.parse(b.canary.watch_deadline) || Date.parse(b.canary.watch_deadline) - Date.parse(e.recorded_at) > policy.bounds.watch_seconds * 1000)) fail("watch deadline exceeds constitutional bound");
    if (e.phase === "commit" && Date.parse(e.recorded_at) < Date.parse(b.canary.watch_deadline)) fail("commit occurred before watch completion");
    const recoveryPhase = ["revert", "recover", "quarantine", "disarm", "terminally-blocked"].includes(e.phase);
    if (e.phase === "unknown") {
      if (![b.controller_identity, b.watchdog_identity].includes(e.executor_identity)) fail("unknown was not declared by controller or watchdog");
    } else if (e.executor_identity !== (recoveryPhase ? b.recovery_worker_identity : b.controller_identity)) fail("journal executor role mismatch");
    if (["unknown", "disarm", "terminally-blocked"].includes(e.phase) && !e.terminal_reason_digest) fail("terminal or recovery reason is missing");
    if (e.phase === "terminally-blocked" && e.quarantine.state !== "active") fail("terminally blocked attempt is not quarantined");
    if (["disarm", "terminally-blocked"].includes(e.phase)) {
      const transition = e.coverage_transition;
      if (!exact(transition, ["from_state", "to_state", "target_scope_digest", "actor_identity"]) || transition.from_state !== b.admission_binding_state || transition.to_state !== "shadow" || transition.target_scope_digest !== b.target_scope_digest || transition.actor_identity !== b.recovery_worker_identity || transition.actor_identity !== e.executor_identity) fail("invalid recovery coverage transition");
    } else if (e.coverage_transition !== null) fail("non-recovery phase changed coverage");
    previous = e.receipt_digest;
  }
  if (j.entries[0].phase !== "prepare") fail("journal does not start prepared");
  const terminal = j.entries.at(-1).phase as string;
  const isTerminal = ["commit", "disarm", "terminally-blocked"].includes(terminal);
  if (requireTerminal && !isTerminal) fail("journal has no explicit terminal state");
  if (terminal === "commit" && j.entries.some((e: any) => ["unknown", "revert", "recover", "quarantine", "disarm", "terminally-blocked"].includes(e.phase))) fail("successful journal entered recovery");
  if (requireTerminal && j.entries.some((e: any) => e.phase === "unknown") && !["disarm", "terminally-blocked"].includes(terminal)) fail("unknown did not terminally disarm");
  if (terminal === "disarm" && policy.recovery_class === "R-exact" && !j.entries.some((e: any) => e.phase === "revert")) fail("R-exact disarm lacks revert");
  if (terminal === "disarm" && policy.recovery_class === "R-forward" && (!j.entries.some((e: any) => e.phase === "recover") || !j.entries.some((e: any) => e.phase === "quarantine" && e.quarantine.state === "active"))) fail("R-forward disarm lacks recover and quarantine");
  return { phase: terminal, terminal: isTerminal, entries: j.entries.length, bindingDigest: j.binding_digest };
}
