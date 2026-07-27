/**
 * W5 roster-proposal admission.
 *
 * This module deliberately owns no actuator. It validates one atomic,
 * epoch-bound server observation plus content-addressed evidence, then persists
 * a content-blind proposal lifecycle under the provider's synchronous fence.
 * It does not import model load/unload/download, routing, deploy, restart, key,
 * config-writer, or artifact-writer primitives.
 */
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../db.js";
import { jcsCanonicalize } from "./learning-task-contract.js";
import {
  evidenceIdentityHash,
  evidenceIdentityDisclosure,
  type EvidenceIdentityBundle,
} from "./evidence-identity.js";
import {
  getEvidenceIdentitySnapshot,
  type EvidenceIdentitySnapshot,
} from "./evidence-identity-store.js";
import type { ModelInfo } from "./model-admin.js";

export const ROSTER_PROPOSAL_CONTRACT_VERSION = "gille-roster-proposal-v1" as const;
export const ROSTER_PROPOSAL_SCHEMA_EPOCH = "gille-roster-admission-schema-v1" as const;
export const ROSTER_PROPOSAL_POLICY_EPOCH = "grimnir-autonomy-v2" as const;
export const ROSTER_PROPOSAL_PRINCIPAL = "service:hugin" as const;
export const ROSTER_PROPOSAL_AXIS = "served-model-roster" as const;
export const ROSTER_MAX_CHANGED_ENTRIES = 1;
export const ROSTER_MAX_CANARY_REQUESTS = 10;
export const ROSTER_MAX_CANARY_SECONDS = 3_600;
export const ROSTER_MAX_EVIDENCE_AGE_SECONDS = 86_400;
const MAX_PROPOSAL_LIFETIME_MS = 86_400_000;
const CLOCK_SKEW_MS = 5_000;

export type RosterBackend = "llamaswap" | "lmstudio";
export type RosterBackendOperation = "load" | "unload" | "reload-config";

export interface ServerRosterBackendCapability {
  backend: RosterBackend;
  supportedOperations: readonly RosterBackendOperation[];
  aliasControl: boolean;
  contextControl: boolean;
  capabilityDigest: string;
}

export function backendCapabilityIdentity(
  backend: RosterBackend,
): ServerRosterBackendCapability {
  const capability = backend === "llamaswap"
    ? {
      schema_version: "gille-roster-backend-capability-v1" as const,
      backend,
      supported_operations: ["load", "unload"] as const,
      alias_control: false,
      context_control: false,
    }
    : {
      schema_version: "gille-roster-backend-capability-v1" as const,
      backend,
      supported_operations: ["load", "unload", "reload-config"] as const,
      alias_control: true,
      context_control: true,
    };
  return {
    backend: capability.backend,
    supportedOperations: capability.supported_operations,
    aliasControl: capability.alias_control,
    contextControl: capability.context_control,
    capabilityDigest: rosterDigest(capability),
  };
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const idSchema = z.string().regex(/^[a-z][a-z0-9._:-]{2,127}$/);
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function isCanonicalRosterUtc(value: string): boolean {
  if (!utcPattern.test(value)) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().replace(".000Z", "Z") === value;
}

const timestampSchema = z.string().refine(isCanonicalRosterUtc, {
  message: "timestamp must be canonical UTC",
});

const candidateEntrySchema = z.object({
  model_id: idSchema,
  alias: idSchema,
  artifact_digest: digestSchema,
  quantization: idSchema,
  template_digest: digestSchema,
  context_length: z.number().int().positive().max(1_048_576),
  serving_config_digest: digestSchema,
  evidence_identity_hash: digestSchema,
  restore_descriptor_ref: digestSchema,
  restore_descriptor_digest: digestSchema,
}).strict();

const boundedCanaryFields = {
  model_id: idSchema,
  registry_id: idSchema,
  registry_version: idSchema,
  registry_digest: digestSchema,
  max_requests: z.number().int().positive().max(ROSTER_MAX_CANARY_REQUESTS),
  duration_seconds: z.number().int().positive().max(ROSTER_MAX_CANARY_SECONDS),
  max_concurrency: z.literal(1),
};

const canarySchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.enum(["load", "reload-config"]),
    expected_state: z.literal("served"),
    fallback_model_id: z.null(),
    ...boundedCanaryFields,
  }).strict(),
  z.object({
    operation: z.literal("unload"),
    expected_state: z.literal("absent"),
    fallback_model_id: idSchema,
    ...boundedCanaryFields,
  }).strict(),
]);

const proposalWithoutDigestSchema = z.object({
  contract_version: z.literal(ROSTER_PROPOSAL_CONTRACT_VERSION),
  proposal_id: idSchema,
  idempotency_key: idSchema,
  producer: z.object({
    component: z.literal("hugin"),
    instance_id: idSchema,
    serializer_version: z.literal("hugin-roster-proposal-v1"),
  }).strict(),
  expected_transport_principal_id: z.literal(ROSTER_PROPOSAL_PRINCIPAL),
  axis: z.literal(ROSTER_PROPOSAL_AXIS),
  baseline: z.object({
    catalogue_digest: digestSchema,
    roster_digest: digestSchema,
  }).strict(),
  candidate: z.object({
    entries: z.array(candidateEntrySchema).min(1).max(64),
    roster_digest: digestSchema,
  }).strict(),
  delta: z.object({
    operation: z.enum(["load", "unload", "reload-config"]),
    model_id: idSchema,
    backend: z.enum(["llamaswap", "lmstudio"]),
    backend_capability_digest: digestSchema,
  }).strict(),
  evidence: z.object({
    schema_epoch: z.literal(ROSTER_PROPOSAL_SCHEMA_EPOCH),
    policy_epoch: z.literal(ROSTER_PROPOSAL_POLICY_EPOCH),
    freshness_seconds: z.number().int().positive().max(ROSTER_MAX_EVIDENCE_AGE_SECONDS),
  }).strict(),
  canary: canarySchema,
  requested_bounds: z.object({
    max_changed_entries: z.number().int().positive().max(ROSTER_MAX_CHANGED_ENTRIES),
  }).strict(),
  requested_operations: z.tuple([z.literal("admit"), z.literal("arm")]),
  created_at: timestampSchema,
  expires_at: timestampSchema,
}).strict();

export const rosterProposalSchema = proposalWithoutDigestSchema.extend({
  proposal_digest: digestSchema,
}).strict();

export type RosterProposal = z.infer<typeof rosterProposalSchema>;
export type RosterCandidateEntry = z.infer<typeof candidateEntrySchema>;

export interface ServerTemplateIdentity {
  modelId: string;
  digest: string;
  observedAt: string;
  identityDigest: string;
}

export interface ServerRestoreDescriptor {
  modelId: string;
  alias: string;
  artifactDigest: string;
  quantization: string;
  templateDigest: string;
  contextLength: number;
  servingConfigDigest: string;
  evidenceIdentityHash: string;
  ref: string;
  digest: string;
}

export interface ServerCanaryDefinition {
  registryId: string;
  registryVersion: string;
  operation: RosterBackendOperation;
  modelId: string;
  routeDigest: string;
  configDigest: string;
  verifierDigest: string;
  postconditionsDigest: string;
  registryDigest: string;
}

const baselineEntrySchema = z.object({
  model_id: idSchema,
  alias: idSchema,
  context_length: z.number().int().positive().max(1_048_576),
  artifact_digest: digestSchema,
  serving_config_digest: digestSchema,
  template_digest: digestSchema,
  quantization: idSchema,
  evidence_identity_hash: digestSchema,
  restore_descriptor_ref: digestSchema,
  restore_descriptor_digest: digestSchema,
}).strict();

const observedCatalogueEntrySchema = z.object({
  model_id: idSchema,
  type: idSchema,
  quantization: idSchema.nullable(),
}).strict();

const observedBackendCapabilitySchema = z.object({
  backend: z.enum(["llamaswap", "lmstudio"]),
  supported_operations: z.array(
    z.enum(["load", "unload", "reload-config"]),
  ).min(1).max(3),
  alias_control: z.boolean(),
  context_control: z.boolean(),
  capability_digest: digestSchema,
}).strict();

const serverRosterObservationWithoutDigestSchema = z.object({
  schema_version: z.literal("gille-roster-server-observation-v1"),
  observed_at: timestampSchema,
  observation_epoch: idSchema,
  catalogue: z.array(observedCatalogueEntrySchema).max(256),
  backend_capability: observedBackendCapabilitySchema,
  desired_roster: z.array(baselineEntrySchema).max(64),
  resident_model_ids: z.array(idSchema).max(64),
  running_model_ids: z.array(idSchema).max(64),
}).strict();

export const serverRosterObservationSchema =
  serverRosterObservationWithoutDigestSchema.extend({
    observation_digest: digestSchema,
  }).strict();

export const serverRosterObservationTokenSchema = z.object({
  schema_version: z.literal("gille-roster-server-observation-token-v1"),
  observation_epoch: idSchema,
  observation_digest: digestSchema,
}).strict();

export type ServerRosterObservation = z.infer<typeof serverRosterObservationSchema>;
export type ServerRosterObservationToken =
  z.infer<typeof serverRosterObservationTokenSchema>;

const baselineSnapshotWithoutDigestSchema = z.object({
  schema_version: z.literal("gille-roster-baseline-v1"),
  observed_at: timestampSchema,
  observation_epoch: idSchema,
  observation_digest: digestSchema,
  backend: z.enum(["llamaswap", "lmstudio"]),
  backend_capability_digest: digestSchema,
  catalogue_digest: digestSchema,
  roster_digest: digestSchema,
  resident_model_ids: z.array(idSchema).max(64),
  running_model_ids: z.array(idSchema).max(64),
  entries: z.array(baselineEntrySchema).max(64),
}).strict();

const baselineSnapshotSchema = baselineSnapshotWithoutDigestSchema.extend({
  snapshot_digest: digestSchema,
}).strict();

export type DurableRosterBaselineSnapshot = z.infer<typeof baselineSnapshotSchema>;

export function rosterDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(jcsCanonicalize(value), "utf8").digest("hex")}`;
}

export function serverRosterObservationDigest(
  observation: Omit<ServerRosterObservation, "observation_digest">,
): string {
  return rosterDigest(observation);
}

export function canonicalRosterProposalDigest(
  proposal: Omit<RosterProposal, "proposal_digest">,
): string {
  return rosterDigest(proposal);
}

export function candidateRosterDigest(entries: RosterCandidateEntry[]): string {
  return rosterDigest({ entries });
}

export function restoreDescriptorDigest(
  descriptor: Omit<ServerRestoreDescriptor, "digest">,
): string {
  return rosterDigest({
    schema_version: "gille-roster-restore-descriptor-v1",
    model_id: descriptor.modelId,
    alias: descriptor.alias,
    artifact_digest: descriptor.artifactDigest,
    quantization: descriptor.quantization,
    template_digest: descriptor.templateDigest,
    context_length: descriptor.contextLength,
    serving_config_digest: descriptor.servingConfigDigest,
    evidence_identity_hash: descriptor.evidenceIdentityHash,
    ref: descriptor.ref,
  });
}

export function templateIdentityDigest(
  identity: Omit<ServerTemplateIdentity, "identityDigest">,
): string {
  return rosterDigest({
    schema_version: "gille-roster-template-identity-v1",
    model_id: identity.modelId,
    template_digest: identity.digest,
    observed_at: identity.observedAt,
  });
}

export function canaryRegistryDigest(
  definition: Omit<ServerCanaryDefinition, "registryDigest">,
): string {
  return rosterDigest({
    schema_version: "gille-roster-canary-registry-v1",
    registry_id: definition.registryId,
    registry_version: definition.registryVersion,
    operation: definition.operation,
    model_id: definition.modelId,
    route_digest: definition.routeDigest,
    config_digest: definition.configDigest,
    verifier_digest: definition.verifierDigest,
    postconditions_digest: definition.postconditionsDigest,
  });
}

interface NormalizedCatalogueEntry {
  model_id: string;
  type: string;
  quantization: string | null;
}

function normalizeCatalogue(models: ModelInfo[]): NormalizedCatalogueEntry[] {
  return models.map((model) => ({
    model_id: model.key,
    type: model.type,
    quantization: model.quantization ?? null,
  })).sort((left, right) => left.model_id.localeCompare(right.model_id));
}

export function liveCatalogueIdentity(models: ModelInfo[]): {
  catalogueDigest: string;
  rosterDigest: string;
} {
  const catalogue = normalizeCatalogue(models);
  return {
    catalogueDigest: rosterDigest({ catalogue }),
    rosterDigest: rosterDigest({
      // Compatibility helper only: admission never uses this transient digest
      // as the desired-roster mutation axis.
      roster: models
        .filter((model) => model.loaded)
        .map((model) => ({
          model_id: model.key,
          loaded_context: model.loadedContext ?? null,
        }))
        .sort((left, right) => left.model_id.localeCompare(right.model_id)),
    }),
  };
}

export const ROSTER_PROPOSAL_STATES = [
  "submitted",
  "rejected",
  "accepted",
  "armed",
  "expired",
] as const;
export type RosterProposalState = typeof ROSTER_PROPOSAL_STATES[number];

export const ROSTER_REJECTION_REASONS = [
  "BASELINE_MISMATCH",
  "CATALOGUE_UNAVAILABLE",
  "UNKNOWN_MODEL",
  "NON_RESIDENT_MODEL",
  "DUPLICATE_MODEL",
  "DUPLICATE_ALIAS",
  "EVIDENCE_MISSING",
  "EVIDENCE_STALE",
  "EVIDENCE_INCOMPLETE",
  "EVIDENCE_IDENTITY_MISMATCH",
  "EVIDENCE_SNAPSHOT_INVALID",
  "TEMPLATE_IDENTITY_UNAVAILABLE",
  "TEMPLATE_IDENTITY_MISMATCH",
  "BASELINE_IDENTITY_UNAVAILABLE",
  "BASELINE_DUPLICATE",
  "BASELINE_NON_RESIDENT",
  "BASELINE_RESTORE_UNAVAILABLE",
  "BASELINE_RESTORE_MISMATCH",
  "ROSTER_OBSERVATION_INVALID",
  "OBSERVATION_REVALIDATION_UNAVAILABLE",
  "OBSERVATION_CHANGED",
  "BACKEND_CAPABILITY_MISMATCH",
  "BACKEND_CONFIG_MISMATCH",
  "UNSUPPORTED_OPERATION",
  "ROSTER_OBSERVER_UNAVAILABLE",
  "RESTORE_DESCRIPTOR_UNAVAILABLE",
  "RESTORE_DESCRIPTOR_MISMATCH",
  "CANARY_REGISTRY_UNAVAILABLE",
  "CANARY_REGISTRY_MISMATCH",
  "CANDIDATE_DIGEST_MISMATCH",
  "NO_CHANGES",
  "CANARY_OUTSIDE_PROPOSAL",
  "CANARY_OUTSIDE_CHANGE",
  "BOUNDS_EXCEEDED",
  "ACTIVE_PROPOSAL_EXISTS",
  "PROPOSAL_EXPIRED",
] as const;
export type RosterRejectionReason = typeof ROSTER_REJECTION_REASONS[number];

export interface DurableRosterProposal {
  recordId: string;
  proposalId: string;
  principalId: string;
  credentialBindingDigest: string;
  producerId: string;
  idempotencyKey: string;
  proposalDigest: string;
  axis: typeof ROSTER_PROPOSAL_AXIS;
  state: RosterProposalState;
  reasonCode: RosterRejectionReason | "TTL_EXPIRED" | null;
  createdAt: string;
  expiresAt: string;
  /** Final protected-clock time at which the durable decision was persisted. */
  decisionAt: string;
  updatedAt: string;
  normalizedDelta: RosterProposal["delta"];
  proposal: RosterProposal;
  baselineSnapshot: DurableRosterBaselineSnapshot | null;
  admissionDigest: string;
}

interface ProposalRow {
  record_id: string;
  proposal_id: string;
  principal_id: string;
  credential_binding_digest: string;
  producer_id: string;
  idempotency_key: string;
  proposal_digest: string;
  axis: string;
  state: string;
  reason_code: string | null;
  created_at: string;
  expires_at: string;
  decision_at: string;
  updated_at: string;
  created_at_ms: number;
  expires_at_ms: number;
  decision_at_ms: number;
  updated_at_ms: number;
  proposal_json: string;
  delta_json: string;
  baseline_json: string | null;
  baseline_digest: string | null;
  admission_digest: string;
}

export class RosterProposalSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterProposalSchemaError";
  }
}

const ROSTER_PROPOSAL_COLUMNS = [
  "record_id",
  "proposal_id",
  "principal_id",
  "credential_binding_digest",
  "producer_id",
  "idempotency_key",
  "proposal_digest",
  "axis",
  "state",
  "reason_code",
  "created_at",
  "expires_at",
  "decision_at",
  "updated_at",
  "created_at_ms",
  "expires_at_ms",
  "decision_at_ms",
  "updated_at_ms",
  "proposal_json",
  "delta_json",
  "baseline_json",
  "baseline_digest",
  "admission_digest",
] as const;

const initialized = new WeakSet<Database.Database>();

function ensureSchema(db: Database.Database): void {
  if (initialized.has(db)) return;
  const existing = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'table' AND name = 'roster_proposals'
  `).get() as { name: string } | undefined;
  if (existing) {
    const actualColumns = (
      db.prepare("PRAGMA table_info(roster_proposals)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    if (
      actualColumns.length !== ROSTER_PROPOSAL_COLUMNS.length
      || actualColumns.some(
        (column, index) => column !== ROSTER_PROPOSAL_COLUMNS[index],
      )
    ) {
      throw new RosterProposalSchemaError(
        "existing roster_proposals schema is incompatible; " +
        "no legacy migration is supported because pre-fence rows lack " +
        "observation epoch/digest and the current admission-digest formula",
      );
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS roster_proposals (
      record_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL,
      credential_binding_digest TEXT NOT NULL,
      producer_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      proposal_digest TEXT NOT NULL,
      axis TEXT NOT NULL CHECK (axis = 'served-model-roster'),
      state TEXT NOT NULL CHECK (state IN ('submitted','rejected','accepted','armed','expired')),
      reason_code TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decision_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      decision_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      proposal_json TEXT NOT NULL,
      delta_json TEXT NOT NULL,
      baseline_json TEXT,
      baseline_digest TEXT,
      admission_digest TEXT NOT NULL,
      UNIQUE (principal_id, idempotency_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_roster_proposals_one_armed_axis
      ON roster_proposals(axis) WHERE state = 'armed';
    CREATE INDEX IF NOT EXISTS idx_roster_proposals_expiry
      ON roster_proposals(state, expires_at_ms);
    CREATE TABLE IF NOT EXISTS roster_proposal_events (
      proposal_id TEXT NOT NULL REFERENCES roster_proposals(proposal_id),
      sequence INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('submitted','rejected','accepted','armed','expired')),
      reason_code TEXT,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (proposal_id, sequence)
    );
  `);
  initialized.add(db);
}

export function ensureRosterProposalSchema(
  db: Database.Database = getDb(),
): void {
  ensureSchema(db);
}

export class RosterProposalContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterProposalContractError";
  }
}

export class RosterProposalStateCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RosterProposalStateCorruptError";
  }
}

class ServerObservationFenceProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerObservationFenceProtocolError";
  }
}

class ServerObservationFenceProviderError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "ServerObservationFenceProviderError";
  }
}

const LATE_FENCE_CALLBACK_IGNORED = Object.freeze({
  kind: "late-fence-callback-ignored",
} as const);

function rowToRecord(
  row: ProposalRow,
  db: Database.Database,
): DurableRosterProposal {
  const parsed = rosterProposalSchema.safeParse(JSON.parse(row.proposal_json));
  const baseline = row.baseline_json === null
    ? null
    : baselineSnapshotSchema.safeParse(JSON.parse(row.baseline_json));
  const delta = parsed.success
    ? parsed.data.delta
    : null;
  const events = db.prepare(`
    SELECT sequence, state, reason_code, recorded_at
      FROM roster_proposal_events
     WHERE proposal_id = ?
     ORDER BY sequence
  `).all(row.proposal_id) as Array<{
    sequence: number;
    state: string;
    reason_code: string | null;
    recorded_at: string;
  }>;
  const expectedStates = row.state === "armed"
    ? ["submitted", "accepted", "armed"]
    : row.state === "rejected"
      ? ["submitted", "rejected"]
      : row.state === "expired"
        ? ["submitted", "accepted", "armed", "expired"]
        : [];
  const admissionDigest = parsed.success && delta
    ? rosterDigest({
      proposal_digest: parsed.data.proposal_digest,
      authenticated_principal_id: row.principal_id,
      credential_binding_digest: row.credential_binding_digest,
      baseline_snapshot_digest: baseline?.success
        ? baseline.data.snapshot_digest
        : null,
      observation_epoch: baseline?.success
        ? baseline.data.observation_epoch
        : null,
      observation_digest: baseline?.success
        ? baseline.data.observation_digest
        : null,
      decision_at: row.decision_at,
      normalized_delta: delta,
    })
    : "";
  const eventTimes = events.map((event) => Date.parse(event.recorded_at));
  const expectedEventReason = (eventState: string): string | null => {
    if (eventState === "rejected") return row.reason_code;
    if (eventState === "expired") return "TTL_EXPIRED";
    return null;
  };
  if (
    !parsed.success
    || (baseline !== null && !baseline.success)
    || !ROSTER_PROPOSAL_STATES.includes(row.state as RosterProposalState)
    || row.axis !== ROSTER_PROPOSAL_AXIS
    || row.proposal_id !== parsed.data.proposal_id
    || row.idempotency_key !== parsed.data.idempotency_key
    || row.proposal_digest !== parsed.data.proposal_digest
    || row.producer_id !== parsed.data.producer.instance_id
    || row.principal_id !== parsed.data.expected_transport_principal_id
    || row.created_at !== parsed.data.created_at
    || row.expires_at !== parsed.data.expires_at
    || row.created_at_ms !== Date.parse(row.created_at)
    || row.expires_at_ms !== Date.parse(row.expires_at)
    || row.decision_at_ms !== Date.parse(row.decision_at)
    || row.updated_at_ms !== Date.parse(row.updated_at)
    || !isCanonicalRosterUtc(row.decision_at)
    || !isCanonicalRosterUtc(row.updated_at)
    || row.decision_at_ms > row.updated_at_ms
    || jcsCanonicalize(JSON.parse(row.delta_json)) !== jcsCanonicalize(parsed.data.delta)
    || canonicalRosterProposalDigest((() => {
      const unsigned = { ...parsed.data } as Partial<RosterProposal>;
      delete unsigned.proposal_digest;
      return unsigned as Omit<RosterProposal, "proposal_digest">;
    })()) !== parsed.data.proposal_digest
    || candidateRosterDigest(parsed.data.candidate.entries) !== parsed.data.candidate.roster_digest
    || !/^sha256:[a-f0-9]{64}$/.test(row.admission_digest)
    || !/^sha256:[a-f0-9]{64}$/.test(row.credential_binding_digest)
    || row.admission_digest !== admissionDigest
    || (
      baseline !== null
      && (
        row.baseline_digest !== baseline.data.snapshot_digest
        || rosterDigest((() => {
          const unsigned = { ...baseline.data } as Partial<DurableRosterBaselineSnapshot>;
          delete unsigned.snapshot_digest;
          return unsigned;
        })()) !== baseline.data.snapshot_digest
      )
    )
    || expectedStates.length !== events.length
    || events.some(
      (event, index) =>
        event.sequence !== index + 1
        || event.state !== expectedStates[index]
        || event.reason_code !== expectedEventReason(event.state)
        || !isCanonicalRosterUtc(event.recorded_at)
        || !Number.isFinite(eventTimes[index])
        || (index > 0 && eventTimes[index]! < eventTimes[index - 1]!)
        || eventTimes[index]! > row.updated_at_ms
        || eventTimes[index] !== (
          event.state === "expired"
            ? row.updated_at_ms
            : row.decision_at_ms
        ),
    )
    || eventTimes.at(-1) !== row.updated_at_ms
    || (row.state === "armed" && (row.reason_code !== null || baseline === null))
    || (
      row.state === "rejected"
      && (
        !ROSTER_REJECTION_REASONS.includes(row.reason_code as RosterRejectionReason)
        || events.at(-1)?.reason_code !== row.reason_code
      )
    )
    || (
      row.state === "expired"
      && (
        row.reason_code !== "TTL_EXPIRED"
        || events.at(-1)?.reason_code !== "TTL_EXPIRED"
      )
    )
  ) {
    throw new RosterProposalStateCorruptError("durable roster proposal is invalid");
  }
  return {
    recordId: row.record_id,
    proposalId: row.proposal_id,
    principalId: row.principal_id,
    credentialBindingDigest: row.credential_binding_digest,
    producerId: row.producer_id,
    idempotencyKey: row.idempotency_key,
    proposalDigest: row.proposal_digest,
    axis: ROSTER_PROPOSAL_AXIS,
    state: row.state as RosterProposalState,
    reasonCode: row.reason_code as DurableRosterProposal["reasonCode"],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decisionAt: row.decision_at,
    updatedAt: row.updated_at,
    normalizedDelta: parsed.data.delta,
    proposal: parsed.data,
    baselineSnapshot: baseline === null ? null : baseline.data,
    admissionDigest: row.admission_digest,
  };
}

const selectColumns = `
  record_id, proposal_id, principal_id, credential_binding_digest,
  producer_id, idempotency_key,
  proposal_digest, axis, state, reason_code, created_at, expires_at,
  decision_at, updated_at, created_at_ms, expires_at_ms,
  decision_at_ms, updated_at_ms,
  proposal_json, delta_json
  , baseline_json, baseline_digest, admission_digest
`;

function findCollision(
  db: Database.Database,
  proposal: RosterProposal,
): DurableRosterProposal | null {
  const row = db.prepare(`
    SELECT ${selectColumns}
      FROM roster_proposals
     WHERE proposal_id = @proposalId
        OR (principal_id = @principalId AND idempotency_key = @idempotencyKey)
     LIMIT 1
  `).get({
    proposalId: proposal.proposal_id,
    principalId: proposal.expected_transport_principal_id,
    idempotencyKey: proposal.idempotency_key,
  }) as ProposalRow | undefined;
  return row ? rowToRecord(row, db) : null;
}

function isExactRetry(
  record: DurableRosterProposal,
  principalId: string,
  proposal: RosterProposal,
): boolean {
  return record.principalId === principalId
    && record.proposalId === proposal.proposal_id
    && record.idempotencyKey === proposal.idempotency_key
    && record.proposalDigest === proposal.proposal_digest
    && jcsCanonicalize(record.proposal) === jcsCanonicalize(proposal);
}

export function expireRosterProposals(
  now = new Date(),
  db: Database.Database = getDb(),
): number {
  ensureSchema(db);
  const at = now.toISOString().replace(".000Z", "Z");
  const atMs = now.getTime();
  return db.transaction(() => {
    const due = db.prepare(`
      SELECT ${selectColumns} FROM roster_proposals
       WHERE state = 'armed' AND expires_at_ms <= ?
       ORDER BY proposal_id
    `).all(atMs) as ProposalRow[];
    // Validate every due record before the first mutation. A corrupt event
    // tail must never be "repaired" by appending an expiry event.
    for (const row of due) rowToRecord(row, db);
    for (const row of due) {
      db.prepare(`
        UPDATE roster_proposals
           SET state = 'expired', reason_code = 'TTL_EXPIRED',
               updated_at = ?, updated_at_ms = ?
         WHERE proposal_id = ? AND state = 'armed'
      `).run(at, atMs, row.proposal_id);
      db.prepare(`
        INSERT INTO roster_proposal_events
          (proposal_id, sequence, state, reason_code, recorded_at)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1, 'expired', 'TTL_EXPIRED', ?
          FROM roster_proposal_events WHERE proposal_id = ?
      `).run(row.proposal_id, at, row.proposal_id);
      const validated = db.prepare(`
        SELECT ${selectColumns} FROM roster_proposals WHERE proposal_id = ?
      `).get(row.proposal_id) as ProposalRow;
      rowToRecord(validated, db);
    }
    return due.length;
  }).immediate();
}

export function getRosterProposalForPrincipal(
  principalId: string,
  proposalId: string,
  db: Database.Database = getDb(),
  now = new Date(),
): DurableRosterProposal | null {
  ensureSchema(db);
  expireRosterProposals(now, db);
  const row = db.prepare(`
    SELECT ${selectColumns}
      FROM roster_proposals
     WHERE proposal_id = ? AND principal_id = ?
  `).get(proposalId, principalId) as ProposalRow | undefined;
  return row ? rowToRecord(row, db) : null;
}

export function rosterProposalEvents(
  proposalId: string,
  db: Database.Database = getDb(),
): Array<{ sequence: number; state: RosterProposalState; reasonCode: string | null }> {
  ensureSchema(db);
  return (db.prepare(`
    SELECT sequence, state, reason_code FROM roster_proposal_events
     WHERE proposal_id = ? ORDER BY sequence
  `).all(proposalId) as Array<{
    sequence: number;
    state: RosterProposalState;
    reason_code: string | null;
  }>).map((row) => ({
    sequence: row.sequence,
    state: row.state,
    reasonCode: row.reason_code,
  }));
}

export interface RosterAdmissionDependencies {
  /**
   * One atomic provider observation. The admission layer validates this unknown
   * value as a closed, content-addressed object before using any field.
   */
  readServerObservation(): Promise<unknown>;
  /**
   * Synchronous provider fence. The provider must hold the same local lock
   * honored by every roster/backend mutator while it confirms the current
   * token and invokes the callback. The callback performs the final protected
   * checks and SQLite transaction before that lock is released.
   */
  withServerObservationFence(
    expectedToken: ServerRosterObservationToken,
    callback: (confirmedToken: unknown) => unknown,
  ): unknown;
  readEvidence(identityHash: string): EvidenceIdentitySnapshot | null;
  readCandidateTemplateIdentity(modelId: string): ServerTemplateIdentity | null;
  resolveRestoreDescriptor(ref: string): ServerRestoreDescriptor | null;
  resolveCanary(registryId: string, registryVersion: string): ServerCanaryDefinition | null;
  now(): Date;
}

const defaultDependencies: RosterAdmissionDependencies = {
  // No backend currently exposes an atomic, epoch-bound observation over all
  // five required values. Production therefore fails closed until #113
  // supplies this boundary.
  readServerObservation: async () => null,
  withServerObservationFence: () => {
    throw new RosterProposalContractError(
      "server observation fence unavailable",
    );
  },
  readEvidence: (hash) => getEvidenceIdentitySnapshot(hash),
  // No backend currently exposes a stable, server-observed template identity.
  // Admission therefore stays unavailable in production instead of deriving or
  // guessing one from per-request rendered-prompt evidence.
  readCandidateTemplateIdentity: () => null,
  resolveRestoreDescriptor: () => null,
  resolveCanary: () => null,
  now: () => new Date(),
};

export type RosterAdmissionResult =
  | { kind: "armed"; record: DurableRosterProposal }
  | { kind: "rejected"; record: DurableRosterProposal }
  | { kind: "existing"; record: DurableRosterProposal }
  | { kind: "conflict" };

function validateContract(raw: unknown): RosterProposal {
  const parsed = rosterProposalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RosterProposalContractError(parsed.error.issues[0]?.message ?? "invalid roster proposal");
  }
  const proposal = parsed.data;
  const unsigned = { ...proposal } as Partial<RosterProposal>;
  delete unsigned.proposal_digest;
  if (
    canonicalRosterProposalDigest(
      unsigned as Omit<RosterProposal, "proposal_digest">,
    ) !== proposal.proposal_digest
  ) {
    throw new RosterProposalContractError("proposal digest mismatch");
  }
  if (candidateRosterDigest(proposal.candidate.entries) !== proposal.candidate.roster_digest) {
    throw new RosterProposalContractError("candidate roster digest mismatch");
  }
  const modelIds = proposal.candidate.entries.map((entry) => entry.model_id);
  const aliases = proposal.candidate.entries.map((entry) => entry.alias);
  if (new Set(modelIds).size !== modelIds.length) {
    throw new RosterProposalContractError("candidate contains duplicate model ids");
  }
  if (new Set(aliases).size !== aliases.length) {
    throw new RosterProposalContractError("candidate contains duplicate aliases");
  }
  if (
    [...modelIds].sort().join("\0") !== modelIds.join("\0")
    || [...aliases].sort().join("\0") !== aliases.join("\0")
  ) {
    throw new RosterProposalContractError("candidate entries and aliases must be canonical-sort ordered");
  }
  return proposal;
}

function digestIdentity(
  bundle: EvidenceIdentityBundle,
  field: "modelArtifact" | "configEpoch",
): { digest: string; version: string } | null {
  const identity = bundle[field];
  return identity.kind === "digest"
    ? { digest: identity.digest, version: identity.version }
    : null;
}

interface ValidatedServerObservation {
  observation: ServerRosterObservation;
  baselineSnapshot: DurableRosterBaselineSnapshot;
  backendCapability: ServerRosterBackendCapability;
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isCanonicalOrder(values: readonly string[]): boolean {
  return [...values].sort().join("\0") === values.join("\0");
}

function validateServerObservation(
  raw: unknown,
  now: Date,
): { value: ValidatedServerObservation | null; reason: RosterRejectionReason | null } {
  const parsed = serverRosterObservationSchema.safeParse(raw);
  if (!parsed.success) {
    return { value: null, reason: "ROSTER_OBSERVATION_INVALID" };
  }
  const observation = parsed.data;
  const unsigned = { ...observation } as Partial<ServerRosterObservation>;
  delete unsigned.observation_digest;
  if (
    serverRosterObservationDigest(
      unsigned as Omit<ServerRosterObservation, "observation_digest">,
    ) !== observation.observation_digest
    || Date.parse(observation.observed_at) > now.getTime() + CLOCK_SKEW_MS
  ) {
    return { value: null, reason: "ROSTER_OBSERVATION_INVALID" };
  }

  const catalogueIds = observation.catalogue.map((entry) => entry.model_id);
  const desiredIds = observation.desired_roster.map((entry) => entry.model_id);
  const desiredAliases = observation.desired_roster.map((entry) => entry.alias);
  const residentIds = observation.resident_model_ids;
  const runningIds = observation.running_model_ids;
  if (
    !isUnique(catalogueIds)
    || !isUnique(residentIds)
    || !isUnique(runningIds)
    || !isCanonicalOrder(catalogueIds)
    || !isCanonicalOrder(desiredIds)
    || !isCanonicalOrder(residentIds)
    || !isCanonicalOrder(runningIds)
  ) {
    return { value: null, reason: "ROSTER_OBSERVATION_INVALID" };
  }
  if (!isUnique(desiredIds) || !isUnique(desiredAliases)) {
    return { value: null, reason: "BASELINE_DUPLICATE" };
  }

  const configured = new Set(catalogueIds);
  const resident = new Set(residentIds);
  if (
    desiredIds.some((id) => !configured.has(id))
    || residentIds.some((id) => !configured.has(id))
    || runningIds.some((id) => !configured.has(id) || !resident.has(id))
  ) {
    return { value: null, reason: "ROSTER_OBSERVATION_INVALID" };
  }
  if (desiredIds.some((id) => !resident.has(id))) {
    return { value: null, reason: "BASELINE_NON_RESIDENT" };
  }

  const expectedCapability =
    backendCapabilityIdentity(observation.backend_capability.backend);
  const observedCapability = observation.backend_capability;
  if (
    observedCapability.capability_digest !== expectedCapability.capabilityDigest
    || observedCapability.alias_control !== expectedCapability.aliasControl
    || observedCapability.context_control !== expectedCapability.contextControl
    || observedCapability.supported_operations.join("\0")
      !== expectedCapability.supportedOperations.join("\0")
  ) {
    return { value: null, reason: "BACKEND_CAPABILITY_MISMATCH" };
  }

  const withoutSnapshotDigest: Omit<
    DurableRosterBaselineSnapshot,
    "snapshot_digest"
  > = {
    schema_version: "gille-roster-baseline-v1",
    observed_at: observation.observed_at,
    observation_epoch: observation.observation_epoch,
    observation_digest: observation.observation_digest,
    backend: expectedCapability.backend,
    backend_capability_digest: expectedCapability.capabilityDigest,
    catalogue_digest: rosterDigest({ catalogue: observation.catalogue }),
    roster_digest: candidateRosterDigest(observation.desired_roster),
    resident_model_ids: [...residentIds],
    running_model_ids: [...runningIds],
    entries: observation.desired_roster.map((entry) => ({ ...entry })),
  };
  return {
    value: {
      observation,
      backendCapability: expectedCapability,
      baselineSnapshot: {
        ...withoutSnapshotDigest,
        snapshot_digest: rosterDigest(withoutSnapshotDigest),
      },
    },
    reason: null,
  };
}

function semanticDecision(
  proposal: RosterProposal,
  observation: ValidatedServerObservation | null,
  observationFailureReason: RosterRejectionReason | null,
  baselineSnapshot: DurableRosterBaselineSnapshot | null,
  backendCapability: ServerRosterBackendCapability | null,
  deps: RosterAdmissionDependencies,
  timing: Array<{
    observedAtMs: number;
    maxAgeMs: number;
    reason: "EVIDENCE_STALE" | "TEMPLATE_IDENTITY_MISMATCH";
  }>,
): RosterRejectionReason | null {
  if (observationFailureReason !== null) return observationFailureReason;
  if (observation === null) return "ROSTER_OBSERVER_UNAVAILABLE";
  const catalogue = observation.observation.catalogue;
  if (
    rosterDigest({ catalogue }) !== proposal.baseline.catalogue_digest
  ) {
    return "BASELINE_MISMATCH";
  }
  if (baselineSnapshot === null) return "ROSTER_OBSERVER_UNAVAILABLE";
  if (baselineSnapshot.roster_digest !== proposal.baseline.roster_digest) {
    return "BASELINE_MISMATCH";
  }
  const baselineModelIds = baselineSnapshot.entries.map((entry) => entry.model_id);
  const baselineAliases = baselineSnapshot.entries.map((entry) => entry.alias);
  if (
    new Set(baselineModelIds).size !== baselineModelIds.length
    || new Set(baselineAliases).size !== baselineAliases.length
  ) return "BASELINE_DUPLICATE";
  if (
    backendCapability === null
    || proposal.delta.backend !== backendCapability.backend
    || proposal.delta.backend_capability_digest !== backendCapability.capabilityDigest
    || baselineSnapshot.backend !== backendCapability.backend
    || baselineSnapshot.backend_capability_digest !== backendCapability.capabilityDigest
  ) return "BACKEND_CAPABILITY_MISMATCH";
  if (!backendCapability.supportedOperations.includes(proposal.delta.operation)) {
    return "UNSUPPORTED_OPERATION";
  }
  if (
    !backendCapability.aliasControl
    && proposal.candidate.entries.some((entry) => entry.alias !== entry.model_id)
  ) return "BACKEND_CONFIG_MISMATCH";

  const resident = new Set(baselineSnapshot.resident_model_ids);
  for (const entry of baselineSnapshot.entries) {
    if (!resident.has(entry.model_id)) return "BASELINE_NON_RESIDENT";
    const descriptor = deps.resolveRestoreDescriptor(entry.restore_descriptor_ref);
    if (!descriptor) return "BASELINE_RESTORE_UNAVAILABLE";
    if (
      descriptor.digest !== restoreDescriptorDigest({
        modelId: descriptor.modelId,
        alias: descriptor.alias,
        artifactDigest: descriptor.artifactDigest,
        quantization: descriptor.quantization,
        templateDigest: descriptor.templateDigest,
        contextLength: descriptor.contextLength,
        servingConfigDigest: descriptor.servingConfigDigest,
        evidenceIdentityHash: descriptor.evidenceIdentityHash,
        ref: descriptor.ref,
      })
      || descriptor.ref !== entry.restore_descriptor_ref
      || descriptor.digest !== entry.restore_descriptor_digest
      || descriptor.modelId !== entry.model_id
      || descriptor.alias !== entry.alias
      || descriptor.artifactDigest !== entry.artifact_digest
      || descriptor.quantization !== entry.quantization
      || descriptor.templateDigest !== entry.template_digest
      || descriptor.contextLength !== entry.context_length
      || descriptor.servingConfigDigest !== entry.serving_config_digest
      || descriptor.evidenceIdentityHash !== entry.evidence_identity_hash
    ) return "BASELINE_RESTORE_MISMATCH";
  }

  const modelIds = proposal.candidate.entries.map((entry) => entry.model_id);
  if (new Set(modelIds).size !== modelIds.length) return "DUPLICATE_MODEL";
  const aliases = proposal.candidate.entries.map((entry) => entry.alias);
  if (new Set(aliases).size !== aliases.length) return "DUPLICATE_ALIAS";

  const byId = new Map(catalogue.map((model) => [model.model_id, model]));
  for (const entry of proposal.candidate.entries) {
    const model = byId.get(entry.model_id);
    if (!model) return "UNKNOWN_MODEL";
    if (!resident.has(entry.model_id)) return "NON_RESIDENT_MODEL";
    const evidence = deps.readEvidence(entry.evidence_identity_hash);
    if (!evidence) return "EVIDENCE_MISSING";
    const firstSeenAt = Date.parse(evidence.firstSeenAt);
    const lastSeenAt = Date.parse(evidence.lastSeenAt);
    if (
      evidence.identityHash !== entry.evidence_identity_hash
      || evidenceIdentityHash(evidence.bundle) !== entry.evidence_identity_hash
      || !isCanonicalRosterUtc(evidence.firstSeenAt)
      || !isCanonicalRosterUtc(evidence.lastSeenAt)
      || !Number.isFinite(firstSeenAt)
      || !Number.isFinite(lastSeenAt)
      || firstSeenAt > lastSeenAt
      || !Number.isSafeInteger(evidence.observationCount)
      || evidence.observationCount <= 0
    ) return "EVIDENCE_SNAPSHOT_INVALID";
    const artifactIdentity = evidence.bundle.modelArtifact;
    if (
      artifactIdentity.kind !== "digest"
      || artifactIdentity.origin !== "server-observed"
    ) return "NON_RESIDENT_MODEL";
    if (evidenceIdentityDisclosure(evidence.bundle) !== "complete") return "EVIDENCE_INCOMPLETE";
    timing.push({
      observedAtMs: lastSeenAt,
      maxAgeMs: proposal.evidence.freshness_seconds * 1_000,
      reason: "EVIDENCE_STALE",
    });
    const artifact = digestIdentity(evidence.bundle, "modelArtifact");
    const config = digestIdentity(evidence.bundle, "configEpoch");
    const template = deps.readCandidateTemplateIdentity(entry.model_id);
    if (
      !artifact
      || !config
      || artifact.digest !== entry.artifact_digest
      || artifact.version !== entry.quantization
      || config.digest !== entry.serving_config_digest
    ) return "EVIDENCE_IDENTITY_MISMATCH";
    if (!template) return "TEMPLATE_IDENTITY_UNAVAILABLE";
    const templateObservedAt = Date.parse(template.observedAt);
    if (
      template.identityDigest !== templateIdentityDigest({
        modelId: template.modelId,
        digest: template.digest,
        observedAt: template.observedAt,
      })
      || template.modelId !== entry.model_id
      || template.digest !== entry.template_digest
      || !isCanonicalRosterUtc(template.observedAt)
    ) return "TEMPLATE_IDENTITY_MISMATCH";
    timing.push({
      observedAtMs: templateObservedAt,
      maxAgeMs: proposal.evidence.freshness_seconds * 1_000,
      reason: "TEMPLATE_IDENTITY_MISMATCH",
    });
    const descriptor = deps.resolveRestoreDescriptor(entry.restore_descriptor_ref);
    if (!descriptor) return "RESTORE_DESCRIPTOR_UNAVAILABLE";
    if (
      descriptor.digest !== restoreDescriptorDigest({
        modelId: descriptor.modelId,
        alias: descriptor.alias,
        artifactDigest: descriptor.artifactDigest,
        quantization: descriptor.quantization,
        templateDigest: descriptor.templateDigest,
        contextLength: descriptor.contextLength,
        servingConfigDigest: descriptor.servingConfigDigest,
        evidenceIdentityHash: descriptor.evidenceIdentityHash,
        ref: descriptor.ref,
      })
      || descriptor.ref !== entry.restore_descriptor_ref
      || descriptor.digest !== entry.restore_descriptor_digest
      || descriptor.modelId !== entry.model_id
      || descriptor.alias !== entry.alias
      || descriptor.artifactDigest !== entry.artifact_digest
      || descriptor.quantization !== entry.quantization
      || descriptor.templateDigest !== entry.template_digest
      || descriptor.contextLength !== entry.context_length
      || descriptor.servingConfigDigest !== entry.serving_config_digest
      || descriptor.evidenceIdentityHash !== entry.evidence_identity_hash
    ) return "RESTORE_DESCRIPTOR_MISMATCH";
  }

  const baselineById = new Map(
    baselineSnapshot.entries.map((entry) => [entry.model_id, entry]),
  );
  const desiredRoster = new Set(baselineSnapshot.entries.map((entry) => entry.model_id));
  const candidate = new Map(
    proposal.candidate.entries.map((entry) => [entry.model_id, entry]),
  );
  const changed = new Set<string>();
  const operations = new Map<string, RosterBackendOperation>();
  for (const id of desiredRoster) {
    if (!candidate.has(id)) {
      changed.add(id);
      operations.set(id, "unload");
      continue;
    }
    const current = baselineById.get(id);
    const proposed = candidate.get(id);
    if (
      !current
      || !proposed
      || proposed.alias !== current.alias
      || proposed.context_length !== current.context_length
      || proposed.artifact_digest !== current.artifact_digest
      || proposed.quantization !== current.quantization
      || proposed.serving_config_digest !== current.serving_config_digest
      || proposed.template_digest !== current.template_digest
      || proposed.evidence_identity_hash !== current.evidence_identity_hash
      || proposed.restore_descriptor_ref !== current.restore_descriptor_ref
      || proposed.restore_descriptor_digest !== current.restore_descriptor_digest
    ) {
      changed.add(id);
      operations.set(id, "reload-config");
    }
  }
  for (const id of candidate.keys()) {
    if (!desiredRoster.has(id)) {
      changed.add(id);
      operations.set(id, "load");
    }
  }
  if (changed.size === 0) return "NO_CHANGES";
  if (
    changed.size > ROSTER_MAX_CHANGED_ENTRIES
    || changed.size > proposal.requested_bounds.max_changed_entries
  ) return "BOUNDS_EXCEEDED";
  if (
    proposal.delta.model_id !== proposal.canary.model_id
    || !changed.has(proposal.delta.model_id)
    || operations.get(proposal.delta.model_id) !== proposal.delta.operation
    || proposal.canary.operation !== proposal.delta.operation
  ) return "CANARY_OUTSIDE_CHANGE";
  const canary = deps.resolveCanary(
    proposal.canary.registry_id,
    proposal.canary.registry_version,
  );
  if (!canary) return "CANARY_REGISTRY_UNAVAILABLE";
  if (
    canary.registryDigest !== canaryRegistryDigest({
      registryId: canary.registryId,
      registryVersion: canary.registryVersion,
      operation: canary.operation,
      modelId: canary.modelId,
      routeDigest: canary.routeDigest,
      configDigest: canary.configDigest,
      verifierDigest: canary.verifierDigest,
      postconditionsDigest: canary.postconditionsDigest,
    })
    || canary.registryDigest !== proposal.canary.registry_digest
    || canary.operation !== proposal.delta.operation
    || canary.modelId !== proposal.delta.model_id
  ) return "CANARY_REGISTRY_MISMATCH";
  if (proposal.canary.operation === "unload") {
    const fallback = proposal.canary.fallback_model_id;
    if (
      !candidate.has(fallback)
      || !desiredRoster.has(fallback)
      || changed.has(fallback)
    ) return "CANARY_OUTSIDE_PROPOSAL";
  } else if (!candidate.has(proposal.canary.model_id)) {
    return "CANARY_OUTSIDE_PROPOSAL";
  }
  return null;
}

function finalTimeDecision(
  proposal: RosterProposal,
  timing: ReadonlyArray<{
    observedAtMs: number;
    maxAgeMs: number;
    reason: "EVIDENCE_STALE" | "TEMPLATE_IDENTITY_MISMATCH";
  }>,
  now: Date,
): RosterRejectionReason | null {
  if (Date.parse(proposal.expires_at) <= now.getTime()) {
    return "PROPOSAL_EXPIRED";
  }
  for (const observation of timing) {
    if (
      observation.observedAtMs > now.getTime() + CLOCK_SKEW_MS
      || now.getTime() - observation.observedAtMs > observation.maxAgeMs
    ) return observation.reason;
  }
  return null;
}

function insertDecisionLocked(
  proposal: RosterProposal,
  principalId: string,
  credentialBindingDigest: string,
  reason: RosterRejectionReason | null,
  baselineSnapshot: DurableRosterBaselineSnapshot | null,
  now: Date,
  db: Database.Database,
): RosterAdmissionResult {
  const at = now.toISOString().replace(".000Z", "Z");
  expireRosterProposals(now, db);
  const collision = findCollision(db, proposal);
  if (collision) {
    return isExactRetry(collision, principalId, proposal)
      ? { kind: "existing" as const, record: collision }
      : { kind: "conflict" as const };
  }
  let finalReason = reason;
  if (finalReason === null) {
    const active = db.prepare(`
        SELECT proposal_id FROM roster_proposals
         WHERE axis = ? AND state = 'armed' LIMIT 1
      `).get(ROSTER_PROPOSAL_AXIS);
    if (active) finalReason = "ACTIVE_PROPOSAL_EXISTS";
  }
  const recordId = randomUUID();
  const state = finalReason === null ? "armed" : "rejected";
  if (finalReason === null && baselineSnapshot === null) {
    throw new RosterProposalStateCorruptError(
      "cannot arm without a server-derived baseline",
    );
  }
  const admissionDigest = rosterDigest({
    proposal_digest: proposal.proposal_digest,
    authenticated_principal_id: principalId,
    credential_binding_digest: credentialBindingDigest,
    baseline_snapshot_digest: baselineSnapshot?.snapshot_digest ?? null,
    observation_epoch: baselineSnapshot?.observation_epoch ?? null,
    observation_digest: baselineSnapshot?.observation_digest ?? null,
    decision_at: at,
    normalized_delta: proposal.delta,
  });
  db.prepare(`
      INSERT INTO roster_proposals (
        record_id, proposal_id, principal_id, credential_binding_digest,
        producer_id, idempotency_key,
        proposal_digest, axis, state, reason_code, created_at, expires_at,
        decision_at, updated_at, created_at_ms, expires_at_ms,
        decision_at_ms, updated_at_ms,
        proposal_json, delta_json, baseline_json, baseline_digest,
        admission_digest
      ) VALUES (
        @recordId, @proposalId, @principalId, @credentialBindingDigest,
        @producerId, @idempotencyKey,
        @proposalDigest, @axis, @state, @reasonCode, @createdAt, @expiresAt,
        @decisionAt, @updatedAt, @createdAtMs, @expiresAtMs,
        @decisionAtMs, @updatedAtMs,
        @proposalJson, @deltaJson, @baselineJson, @baselineDigest,
        @admissionDigest
      )
  `).run({
    recordId,
    proposalId: proposal.proposal_id,
    principalId,
    credentialBindingDigest,
    producerId: proposal.producer.instance_id,
    idempotencyKey: proposal.idempotency_key,
    proposalDigest: proposal.proposal_digest,
    axis: ROSTER_PROPOSAL_AXIS,
    state,
    reasonCode: finalReason,
    createdAt: proposal.created_at,
    expiresAt: proposal.expires_at,
    decisionAt: at,
    updatedAt: at,
    createdAtMs: Date.parse(proposal.created_at),
    expiresAtMs: Date.parse(proposal.expires_at),
    decisionAtMs: now.getTime(),
    updatedAtMs: now.getTime(),
    proposalJson: JSON.stringify(proposal),
    deltaJson: JSON.stringify(proposal.delta),
    baselineJson: baselineSnapshot === null
      ? null
      : JSON.stringify(baselineSnapshot),
    baselineDigest: baselineSnapshot?.snapshot_digest ?? null,
    admissionDigest,
  });
  const events: Array<[RosterProposalState, string | null]> = finalReason === null
    ? [["submitted", null], ["accepted", null], ["armed", null]]
    : [["submitted", null], ["rejected", finalReason]];
  for (const [index, [eventState, eventReason]] of events.entries()) {
    db.prepare(`
        INSERT INTO roster_proposal_events
          (proposal_id, sequence, state, reason_code, recorded_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(proposal.proposal_id, index + 1, eventState, eventReason, at);
  }
  const row = db.prepare(`
      SELECT ${selectColumns} FROM roster_proposals WHERE proposal_id = ?
    `).get(proposal.proposal_id) as ProposalRow;
  const record = rowToRecord(row, db);
  return finalReason === null
    ? { kind: "armed" as const, record }
    : { kind: "rejected" as const, record };
}

function persistRejectedOutsideFence(
  proposal: RosterProposal,
  principalId: string,
  credentialBindingDigest: string,
  reason: RosterRejectionReason,
  baselineSnapshot: DurableRosterBaselineSnapshot | null,
  now: Date,
  db: Database.Database,
): RosterAdmissionResult {
  return db.transaction(() => insertDecisionLocked(
    proposal,
    principalId,
    credentialBindingDigest,
    reason,
    baselineSnapshot,
    now,
    db,
  )).immediate();
}

export async function admitRosterProposal(
  raw: unknown,
  authenticatedPrincipalId: string,
  options: {
    db?: Database.Database;
    dependencies?: RosterAdmissionDependencies;
    credentialBindingDigest?: string;
  } = {},
): Promise<RosterAdmissionResult> {
  const db = options.db ?? getDb();
  const deps = options.dependencies ?? defaultDependencies;
  ensureSchema(db);
  const proposal = validateContract(raw);
  const credentialBindingDigest = options.credentialBindingDigest;
  if (
    !credentialBindingDigest
    || !/^sha256:[a-f0-9]{64}$/.test(credentialBindingDigest)
  ) {
    throw new RosterProposalContractError(
      "authenticated credential binding unavailable",
    );
  }
  if (
    authenticatedPrincipalId !== ROSTER_PROPOSAL_PRINCIPAL
    || proposal.expected_transport_principal_id !== authenticatedPrincipalId
  ) {
    throw new RosterProposalContractError("authenticated transport principal mismatch");
  }
  const startedAt = deps.now();
  if (!Number.isFinite(startedAt.getTime())) {
    throw new RosterProposalContractError("protected admission clock unavailable");
  }
  const created = Date.parse(proposal.created_at);
  const expires = Date.parse(proposal.expires_at);
  if (
    created > startedAt.getTime() + CLOCK_SKEW_MS
    || expires <= created
    || expires - created > MAX_PROPOSAL_LIFETIME_MS
  ) {
    throw new RosterProposalContractError("invalid proposal lifetime");
  }
  expireRosterProposals(startedAt, db);
  const existing = findCollision(db, proposal);
  if (existing) {
    return isExactRetry(
      existing,
      authenticatedPrincipalId,
      proposal,
    )
      ? { kind: "existing", record: existing }
      : { kind: "conflict" };
  }
  let rawObservation: unknown = null;
  let observationReadFailed = false;
  try {
    rawObservation = await deps.readServerObservation();
  } catch {
    observationReadFailed = true;
  }
  const validated = observationReadFailed || rawObservation === null
    ? { value: null, reason: "ROSTER_OBSERVER_UNAVAILABLE" as RosterRejectionReason }
    : validateServerObservation(rawObservation, startedAt);
  const observation = validated.value;
  if (observation === null) {
    const decisionNow = deps.now();
    if (
      !Number.isFinite(decisionNow.getTime())
      || decisionNow.getTime() < startedAt.getTime()
    ) {
      throw new RosterProposalContractError(
        "protected admission clock became incoherent",
      );
    }
    const reason = Date.parse(proposal.expires_at) <= decisionNow.getTime()
      ? "PROPOSAL_EXPIRED"
      : validated.reason ?? "ROSTER_OBSERVER_UNAVAILABLE";
    return persistRejectedOutsideFence(
      proposal,
      authenticatedPrincipalId,
      credentialBindingDigest,
      reason,
      null,
      decisionNow,
      db,
    );
  }

  const expectedObservationEpoch = observation.observation.observation_epoch;
  const expectedObservationDigest = observation.observation.observation_digest;
  const expectedToken: ServerRosterObservationToken = Object.freeze({
    schema_version: "gille-roster-server-observation-token-v1",
    observation_epoch: expectedObservationEpoch,
    observation_digest: expectedObservationDigest,
  });
  let callbackCalls = 0;
  let callbackError: unknown = null;
  let outcome: RosterAdmissionResult | null = null;
  let fenceOpen = false;
  let fenceRequestActive = true;
  try {
    // DEFERRED is deliberate: the provider acquires its roster-state fence
    // before the callback performs the first SQLite read/write. The transaction
    // still spans the whole synchronous provider invocation, so a zero/multiple
    // callback or thenable protocol failure rolls back a tentative arm.
    return db.transaction(() => {
      fenceOpen = true;
      try {
        let providerResult: unknown;
        try {
          providerResult = deps.withServerObservationFence(
            expectedToken,
            (rawConfirmedToken) => {
              if (!fenceOpen) {
                if (fenceRequestActive && callbackError === null) {
                  callbackError = new ServerObservationFenceProtocolError(
                    "server observation fence callback escaped its synchronous lifetime",
                  );
                }
                return LATE_FENCE_CALLBACK_IGNORED;
              }
              callbackCalls += 1;
              if (callbackCalls !== 1) {
                const error = new ServerObservationFenceProtocolError(
                  "server observation fence invoked callback multiple times",
                );
                callbackError = error;
                throw error;
              }
              try {
                const confirmed =
                  serverRosterObservationTokenSchema.safeParse(rawConfirmedToken);
                let reason: RosterRejectionReason | null = null;
                const timing: Array<{
                  observedAtMs: number;
                  maxAgeMs: number;
                  reason: "EVIDENCE_STALE" | "TEMPLATE_IDENTITY_MISMATCH";
                }> = [];
                if (!confirmed.success) {
                  reason = "OBSERVATION_REVALIDATION_UNAVAILABLE";
                } else if (
                  confirmed.data.observation_epoch !== expectedObservationEpoch
                  || confirmed.data.observation_digest !== expectedObservationDigest
                ) {
                  reason = "OBSERVATION_CHANGED";
                } else {
                  reason = semanticDecision(
                    proposal,
                    observation,
                    null,
                    observation.baselineSnapshot,
                    observation.backendCapability,
                    deps,
                    timing,
                  );
                }
                const decisionNow = deps.now();
                if (
                  !Number.isFinite(decisionNow.getTime())
                  || decisionNow.getTime() < startedAt.getTime()
                ) {
                  throw new RosterProposalContractError(
                    "protected admission clock became incoherent",
                  );
                }
                const timeReason = finalTimeDecision(proposal, timing, decisionNow);
                if (timeReason === "PROPOSAL_EXPIRED" || reason === null) {
                  reason = timeReason ?? reason;
                }
                outcome = insertDecisionLocked(
                  proposal,
                  authenticatedPrincipalId,
                  credentialBindingDigest,
                  reason,
                  observation.baselineSnapshot,
                  decisionNow,
                  db,
                );
                return outcome;
              } catch (error) {
                callbackError = error;
                throw error;
              }
            },
          );
        } catch (error) {
          if (callbackError !== null) throw callbackError;
          throw new ServerObservationFenceProviderError(
            "server observation fence provider failed",
            error,
          );
        }
        if (
          typeof providerResult === "object"
          && providerResult !== null
          && "then" in providerResult
        ) {
          throw new ServerObservationFenceProtocolError(
            "server observation fence returned a thenable",
          );
        }
      } finally {
        fenceOpen = false;
      }
      if (callbackError !== null) throw callbackError;
      if (callbackCalls !== 1 || outcome === null) {
        throw new ServerObservationFenceProtocolError(
          "server observation fence did not invoke callback exactly once",
        );
      }
      return outcome;
    }).deferred();
  } catch (error) {
    fenceOpen = false;
    if (
      !(error instanceof ServerObservationFenceProtocolError)
      && !(error instanceof ServerObservationFenceProviderError)
    ) throw error;
    const decisionNow = deps.now();
    if (
      !Number.isFinite(decisionNow.getTime())
      || decisionNow.getTime() < startedAt.getTime()
    ) {
      throw new RosterProposalContractError(
        "protected admission clock became incoherent",
      );
    }
    return persistRejectedOutsideFence(
      proposal,
      authenticatedPrincipalId,
      credentialBindingDigest,
      Date.parse(proposal.expires_at) <= decisionNow.getTime()
        ? "PROPOSAL_EXPIRED"
        : "OBSERVATION_REVALIDATION_UNAVAILABLE",
      observation.baselineSnapshot,
      decisionNow,
      db,
    );
  } finally {
    fenceOpen = false;
    fenceRequestActive = false;
  }
}
