/**
 * Pure, content-blind provenance for one model selected by the operator.
 *
 * This module describes what was observed; it does not read files, inspect a process, or turn a
 * declaration into proof. In particular, a content digest with an `unproven` or `stale` binding
 * remains incomplete even when the digest itself is well-formed.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const SERVED_PROVENANCE_SCHEMA_VERSION = 1 as const;
export const SERVED_PROVENANCE_BINDINGS = ["verified-immutable", "unproven", "stale"] as const;
export type ServedProvenanceBinding = (typeof SERVED_PROVENANCE_BINDINGS)[number];

export const SERVED_PROVENANCE_SOURCES = ["observed", "operator-declared", "unknown"] as const;
export type ServedProvenanceSource = (typeof SERVED_PROVENANCE_SOURCES)[number];

export const SERVED_PROVENANCE_FRESHNESS = ["fresh", "stale", "unavailable"] as const;
export type ServedProvenanceFreshness = (typeof SERVED_PROVENANCE_FRESHNESS)[number];

export const SERVED_PROVENANCE_COMPLETENESS = ["complete", "incomplete"] as const;
export type ServedProvenanceCompleteness = (typeof SERVED_PROVENANCE_COMPLETENESS)[number];

/** Fixed diagnostics emitted by the process collector; no collector text enters this contract. */
export const SERVED_PROVENANCE_COLLECTOR_REASON_CODES = [
  "pid-invalid",
  "process-unavailable",
  "process-not-llama-server",
  "proc-stat-unavailable",
  "proc-cmdline-unavailable",
  "proc-exe-unavailable",
  "process-view-unavailable",
  "process-view-changed",
  "process-identity-changed",
  "cmdline-changed",
  "executable-changed",
  "model-flag-missing",
  "model-flag-ambiguous",
  "projector-flag-ambiguous",
  "artifact-path-unavailable",
  "artifact-remote",
  "artifact-missing",
  "artifact-not-regular",
  "artifact-hash-failed",
  "artifact-changed",
  "artifact-shards-unavailable",
  "unsupported-model-loader-feature",
  "runtime-unavailable",
  "runtime-changed",
  "launch-flag-ambiguous",
  "launch-flag-invalid",
  "environment-unavailable",
] as const;
export type ServedProvenanceCollectorReasonCode = (typeof SERVED_PROVENANCE_COLLECTOR_REASON_CODES)[number];

/** Closed machine-readable reasons. No free-form collector errors enter this contract. */
export const SERVED_PROVENANCE_REASON_CODES = [
  "observation-unavailable",
  "observation-stale",
  "required-evidence-missing",
  "required-evidence-unknown",
  "required-evidence-operator-declared",
  "served-bytes-unproven",
  "served-bytes-stale",
  ...SERVED_PROVENANCE_COLLECTOR_REASON_CODES,
] as const;
export type ServedProvenanceReasonCode = (typeof SERVED_PROVENANCE_REASON_CODES)[number];

const bindingSchema = z.enum(SERVED_PROVENANCE_BINDINGS);
const freshnessSchema = z.enum(SERVED_PROVENANCE_FRESHNESS);
const completenessSchema = z.enum(SERVED_PROVENANCE_COMPLETENESS);
const reasonCodeSchema = z.enum(SERVED_PROVENANCE_REASON_CODES);

const modelAliasSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, "invalid model alias");
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 hex digest");
const gatewayBuildShaSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, "must be a lowercase build SHA");
const identityValueSchema = z.string().regex(/^[A-Za-z0-9._=-]{1,160}$/, "invalid identity token");

const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
function isExactUtcTimestamp(value: string): boolean {
  const match = utcTimestampPattern.exec(value);
  if (!match) return false;
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return false;
  return instant.getUTCFullYear() === Number(match[1])
    && instant.getUTCMonth() + 1 === Number(match[2])
    && instant.getUTCDate() === Number(match[3])
    && instant.getUTCHours() === Number(match[4])
    && instant.getUTCMinutes() === Number(match[5])
    && instant.getUTCSeconds() === Number(match[6]);
}

const timestampSchema = z.string().refine(isExactUtcTimestamp, "invalid RFC 3339 UTC timestamp");
const observedAtSchema = timestampSchema.nullable();

const unknownEvidenceSchema = z.object({
  source: z.literal("unknown"),
  reason: reasonCodeSchema,
}).strict();

function evidenceSchema<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.union([
    z.object({ source: z.literal("observed"), value: valueSchema }).strict(),
    z.object({ source: z.literal("operator-declared"), value: valueSchema }).strict(),
    unknownEvidenceSchema,
  ]);
}

export interface ObservedEvidence<T> {
  readonly source: "observed";
  readonly value: T;
}

export interface OperatorDeclaredEvidence<T> {
  readonly source: "operator-declared";
  readonly value: T;
}

export interface UnknownEvidence {
  readonly source: "unknown";
  readonly reason: ServedProvenanceReasonCode;
}

export type Evidence<T> = ObservedEvidence<T> | OperatorDeclaredEvidence<T> | UnknownEvidence;

const contentShaEvidenceSchema = evidenceSchema(sha256HexSchema);
const identityEvidenceSchema = evidenceSchema(identityValueSchema);

export interface ServedArtifact {
  readonly contentSha256: Evidence<string>;
  readonly binding: ServedProvenanceBinding;
}

const servedArtifactSchema = z.object({
  contentSha256: contentShaEvidenceSchema,
  binding: bindingSchema,
}).strict();

export interface NotApplicableProjector {
  readonly kind: "not-applicable";
}

/** An omitted or unresolved projector is normalized to an unknown artifact. */
export interface UnknownProjector {
  readonly kind: "unknown";
  readonly reason: ServedProvenanceReasonCode;
}

const notApplicableProjectorSchema = z.object({ kind: z.literal("not-applicable") }).strict();
const unknownProjectorSchema = z.object({
  kind: z.literal("unknown"),
  reason: reasonCodeSchema,
}).strict();
export type ProjectorEvidence = ServedArtifact | NotApplicableProjector;
export type ProjectorInputEvidence = ProjectorEvidence | UnknownProjector;

const projectorSchema = z.union([servedArtifactSchema, notApplicableProjectorSchema]);
const projectorInputSchema = z.union([projectorSchema, unknownProjectorSchema]);

export interface GatewayBuildArtifact {
  readonly sha: Evidence<string>;
  readonly binding: ServedProvenanceBinding;
}

const gatewayBuildArtifactSchema = z.object({
  sha: evidenceSchema(gatewayBuildShaSchema),
  binding: bindingSchema,
}).strict();

export interface EffectiveConfiguration {
  readonly contextTokens: Evidence<number>;
  readonly defaults: {
    readonly maxTokens: Evidence<number>;
    readonly temperature: Evidence<number>;
    readonly topP: Evidence<number | null>;
    readonly topK: Evidence<number | null>;
    readonly minP: Evidence<number | null>;
  };
  readonly limits: {
    readonly maxTokens: Evidence<number>;
    readonly maxInputTokens: Evidence<number | null>;
    readonly maxOutputTokens: Evidence<number | null>;
  };
}

const finiteNumber = z.number().finite();
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const effectiveConfigurationSchema = z.object({
  contextTokens: evidenceSchema(positiveInteger),
  defaults: z.object({
    maxTokens: evidenceSchema(positiveInteger),
    temperature: evidenceSchema(finiteNumber),
    topP: evidenceSchema(finiteNumber.nullable()),
    topK: evidenceSchema(nonNegativeInteger.nullable()),
    minP: evidenceSchema(finiteNumber.nullable()),
  }).strict(),
  limits: z.object({
    maxTokens: evidenceSchema(positiveInteger),
    maxInputTokens: evidenceSchema(positiveInteger.nullable()),
    maxOutputTokens: evidenceSchema(positiveInteger.nullable()),
  }).strict(),
}).strict();

/** Numeric values recovered from the selected process launch command line. */
export interface LaunchConfiguration {
  readonly contextSize: Evidence<number>;
  readonly parallelism: Evidence<number>;
  readonly temperature: Evidence<number>;
  readonly topP: Evidence<number>;
  readonly topK: Evidence<number>;
  readonly minP: Evidence<number>;
  readonly predictLimit: Evidence<number>;
}

export type ServedLaunchConfiguration = LaunchConfiguration;

const launchConfigurationSchema = z.object({
  contextSize: evidenceSchema(finiteNumber),
  parallelism: evidenceSchema(finiteNumber),
  temperature: evidenceSchema(finiteNumber),
  topP: evidenceSchema(finiteNumber),
  topK: evidenceSchema(finiteNumber),
  minP: evidenceSchema(finiteNumber),
  predictLimit: evidenceSchema(finiteNumber),
}).strict();

export interface EnvironmentSnapshot {
  readonly os: string;
  readonly arch: string;
  readonly cpuCount: number;
  readonly memoryBytes: number;
  readonly resourceCeilings: {
    /** null means the ceiling was not observed; it is never an assertion of unlimited capacity. */
    readonly cpuCount: number | null;
    readonly memoryBytes: number | null;
  };
}

const environmentSchema = z.object({
  os: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  arch: z.string().regex(/^[A-Za-z0-9._-]{1,32}$/),
  cpuCount: z.number().int().positive(),
  memoryBytes: z.number().int().positive(),
  resourceCeilings: z.object({
    cpuCount: z.number().int().positive().nullable(),
    memoryBytes: z.number().int().positive().nullable(),
  }).strict(),
}).strict();

export interface ServedProvenanceArtifacts {
  readonly weights: readonly ServedArtifact[];
  readonly projector: ProjectorEvidence;
  readonly runtimeBinary: ServedArtifact;
  readonly gatewayBuild: GatewayBuildArtifact;
}

const artifactsSchema = z.object({
  weights: z.array(servedArtifactSchema).max(256),
  projector: projectorSchema,
  runtimeBinary: servedArtifactSchema,
  gatewayBuild: gatewayBuildArtifactSchema,
}).strict();

export interface ServedProvenanceIdentities {
  readonly quantization: Evidence<string>;
  readonly tokenizer: Evidence<string>;
  readonly chatTemplate: Evidence<string>;
}

const identitiesSchema = z.object({
  quantization: identityEvidenceSchema,
  tokenizer: identityEvidenceSchema,
  chatTemplate: identityEvidenceSchema,
}).strict();

export interface ServedProvenanceInput {
  readonly modelAlias: string;
  readonly observedAt: string | null;
  readonly freshness: ServedProvenanceFreshness;
  readonly artifacts: Omit<ServedProvenanceArtifacts, "projector"> & {
    /** Omission is normalized to an explicit unknown state; known absence uses not-applicable. */
    readonly projector?: ProjectorInputEvidence;
  };
  readonly identities: ServedProvenanceIdentities;
  /** Per-request overrides intentionally do not fit this type or schema. */
  readonly effectiveConfiguration: EffectiveConfiguration;
  /** Optional process launch flags; omission is normalized to per-field unknown evidence. */
  readonly launchConfiguration?: LaunchConfiguration;
  /** Omission is normalized to unknown and therefore keeps the result incomplete. */
  readonly environment?: Evidence<EnvironmentSnapshot>;
}

export interface ServedProvenance extends Omit<ServedProvenanceInput, "artifacts" | "environment" | "launchConfiguration"> {
  readonly artifacts: ServedProvenanceArtifacts;
  readonly launchConfiguration: LaunchConfiguration;
  readonly environment: Evidence<EnvironmentSnapshot>;
  readonly schemaVersion: typeof SERVED_PROVENANCE_SCHEMA_VERSION;
  readonly completeness: ServedProvenanceCompleteness;
  readonly reasons: readonly ServedProvenanceReasonCode[];
  readonly configurationIdentity: string;
}

const configurationIdentitySchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const UNKNOWN_PROJECTOR_ARTIFACT: ServedArtifact = {
  contentSha256: { source: "unknown", reason: "required-evidence-unknown" },
  binding: "unproven",
};
const UNKNOWN_ENVIRONMENT: UnknownEvidence = { source: "unknown", reason: "required-evidence-unknown" };

function unknownNumericEvidence(): Evidence<number> {
  return { source: "unknown", reason: "required-evidence-unknown" };
}

function unknownLaunchConfiguration(): LaunchConfiguration {
  return {
    contextSize: unknownNumericEvidence(),
    parallelism: unknownNumericEvidence(),
    temperature: unknownNumericEvidence(),
    topP: unknownNumericEvidence(),
    topK: unknownNumericEvidence(),
    minP: unknownNumericEvidence(),
    predictLimit: unknownNumericEvidence(),
  };
}

export const servedProvenanceSchema = z.object({
  schemaVersion: z.literal(SERVED_PROVENANCE_SCHEMA_VERSION),
  modelAlias: modelAliasSchema,
  observedAt: observedAtSchema,
  freshness: freshnessSchema,
  completeness: completenessSchema,
  reasons: z.array(reasonCodeSchema),
  artifacts: artifactsSchema,
  identities: identitiesSchema,
  effectiveConfiguration: effectiveConfigurationSchema,
  // Accept older version-1 snapshots while normalizing the newly explicit launch evidence.
  launchConfiguration: launchConfigurationSchema.default(unknownLaunchConfiguration()),
  environment: evidenceSchema(environmentSchema),
  configurationIdentity: configurationIdentitySchema,
}).strict();

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** RFC-8785-shaped canonical JSON for this module's finite, JSON-safe identity values. */
function canonicalize(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function evidenceIdentity<T>(evidence: Evidence<T>): JsonValue {
  // Reasons explain this observation only; changing one must not create a configuration epoch.
  if (evidence.source === "unknown") return { source: "unknown" };
  return evidence.value as JsonValue;
}

function artifactIdentity(artifact: ServedArtifact): JsonValue {
  return evidenceIdentity(artifact.contentSha256);
}

function projectorIdentity(projector: ProjectorEvidence): JsonValue {
  if ("kind" in projector) {
    return { kind: "not-applicable" };
  }
  return artifactIdentity(projector);
}

function normalizeProjector(projector: ProjectorInputEvidence | undefined): ProjectorEvidence {
  if (projector === undefined || ("kind" in projector && projector.kind === "unknown")) {
    return UNKNOWN_PROJECTOR_ARTIFACT;
  }
  return projector;
}

function gatewayBuildIdentity(artifact: GatewayBuildArtifact): JsonValue {
  return evidenceIdentity(artifact.sha);
}

function stableConfigurationProjection(input: Pick<ServedProvenanceInput, "modelAlias" | "artifacts" | "identities" | "effectiveConfiguration" | "launchConfiguration">): JsonValue {
  const projector = normalizeProjector(input.artifacts.projector);
  const configuration = input.effectiveConfiguration;
  const launch = input.launchConfiguration ?? unknownLaunchConfiguration();
  const projection: { [key: string]: JsonValue } = {
    modelAlias: input.modelAlias,
    artifacts: {
      weights: input.artifacts.weights.map(artifactIdentity),
      projector: projectorIdentity(projector),
      runtimeBinary: artifactIdentity(input.artifacts.runtimeBinary),
      gatewayBuild: gatewayBuildIdentity(input.artifacts.gatewayBuild),
    },
    identities: {
      quantization: evidenceIdentity(input.identities.quantization),
      tokenizer: evidenceIdentity(input.identities.tokenizer),
      chatTemplate: evidenceIdentity(input.identities.chatTemplate),
    },
    effectiveConfiguration: {
      contextTokens: evidenceIdentity(configuration.contextTokens),
      defaults: {
        maxTokens: evidenceIdentity(configuration.defaults.maxTokens),
        temperature: evidenceIdentity(configuration.defaults.temperature),
        topP: evidenceIdentity(configuration.defaults.topP),
        topK: evidenceIdentity(configuration.defaults.topK),
        minP: evidenceIdentity(configuration.defaults.minP),
      },
      limits: {
        maxTokens: evidenceIdentity(configuration.limits.maxTokens),
        maxInputTokens: evidenceIdentity(configuration.limits.maxInputTokens),
        maxOutputTokens: evidenceIdentity(configuration.limits.maxOutputTokens),
      },
    },
  };
  // An all-unknown optional field carries no identity information. Omitting it preserves
  // identity compatibility for older version-1 snapshots while observed launch values remain
  // distinct from effective defaults and limits.
  if (Object.values(launch).some((evidence) => evidence.source !== "unknown")) {
    projection.launchConfiguration = {
      contextSize: evidenceIdentity(launch.contextSize),
      parallelism: evidenceIdentity(launch.parallelism),
      temperature: evidenceIdentity(launch.temperature),
      topP: evidenceIdentity(launch.topP),
      topK: evidenceIdentity(launch.topK),
      minP: evidenceIdentity(launch.minP),
      predictLimit: evidenceIdentity(launch.predictLimit),
    };
  }
  return projection;
}

/** Stable identity over served artifacts, effective configuration, and observed launch values.
 * Observation time, environment, freshness, completeness, and diagnostic reasons are excluded.
 */
export function servedConfigurationIdentity(
  input: Pick<ServedProvenanceInput, "modelAlias" | "artifacts" | "identities" | "effectiveConfiguration" | "launchConfiguration">,
): string {
  return sha256(canonicalize(stableConfigurationProjection(input)));
}

/** Alias with a name that makes the stability and exclusion rules explicit at call sites. */
export const stableConfigurationIdentity = servedConfigurationIdentity;

function addReason(reasons: ServedProvenanceReasonCode[], reason: ServedProvenanceReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function checkEvidence<T>(evidence: Evidence<T>, reasons: ServedProvenanceReasonCode[]): boolean {
  if (evidence.source === "unknown") {
    addReason(reasons, "required-evidence-unknown");
    return false;
  }
  if (evidence.source === "operator-declared") {
    addReason(reasons, "required-evidence-operator-declared");
    return false;
  }
  return true;
}

function checkArtifact(artifact: ServedArtifact, reasons: ServedProvenanceReasonCode[]): boolean {
  let complete = checkEvidence(artifact.contentSha256, reasons);
  if (artifact.binding === "unproven") {
    addReason(reasons, "served-bytes-unproven");
    complete = false;
  } else if (artifact.binding === "stale") {
    addReason(reasons, "served-bytes-stale");
    complete = false;
  }
  return complete;
}

function checkEffectiveConfiguration(
  configuration: EffectiveConfiguration,
  reasons: ServedProvenanceReasonCode[],
): void {
  checkEvidence(configuration.contextTokens, reasons);
  checkEvidence(configuration.defaults.maxTokens, reasons);
  checkEvidence(configuration.defaults.temperature, reasons);
  checkEvidence(configuration.defaults.topP, reasons);
  checkEvidence(configuration.defaults.topK, reasons);
  checkEvidence(configuration.defaults.minP, reasons);
  checkEvidence(configuration.limits.maxTokens, reasons);
  checkEvidence(configuration.limits.maxInputTokens, reasons);
  checkEvidence(configuration.limits.maxOutputTokens, reasons);
}

function checkEnvironment(
  environment: Evidence<EnvironmentSnapshot>,
  reasons: ServedProvenanceReasonCode[],
): void {
  if (!checkEvidence(environment, reasons)) return;
  if (environment.source !== "observed") return;
  if (environment.value.resourceCeilings.cpuCount === null || environment.value.resourceCeilings.memoryBytes === null) {
    addReason(reasons, "required-evidence-unknown");
  }
}

function collectCompleteness(input: ServedProvenanceInput): { completeness: ServedProvenanceCompleteness; reasons: ServedProvenanceReasonCode[] } {
  const reasons: ServedProvenanceReasonCode[] = [];
  if (input.observedAt === null || input.freshness === "unavailable") addReason(reasons, "observation-unavailable");
  if (input.freshness === "stale") addReason(reasons, "observation-stale");

  if (input.artifacts.weights.length === 0) addReason(reasons, "required-evidence-missing");
  for (const weight of input.artifacts.weights) checkArtifact(weight, reasons);
  const projector = normalizeProjector(input.artifacts.projector);
  if (!("kind" in projector)) checkArtifact(projector, reasons);
  checkArtifact(input.artifacts.runtimeBinary, reasons);
  if (!checkEvidence(input.artifacts.gatewayBuild.sha, reasons)) {
    // checkEvidence already records the source-specific reason.
  }
  if (input.artifacts.gatewayBuild.binding === "unproven") addReason(reasons, "served-bytes-unproven");
  if (input.artifacts.gatewayBuild.binding === "stale") addReason(reasons, "served-bytes-stale");
  checkEvidence(input.identities.quantization, reasons);
  checkEvidence(input.identities.tokenizer, reasons);
  checkEvidence(input.identities.chatTemplate, reasons);
  checkEffectiveConfiguration(input.effectiveConfiguration, reasons);
  checkEnvironment(input.environment ?? UNKNOWN_ENVIRONMENT, reasons);

  return { completeness: reasons.length === 0 ? "complete" : "incomplete", reasons };
}

/** Build a schema-checked observation without adding any source, process, or filesystem access. */
export function collectServedProvenance(input: ServedProvenanceInput): ServedProvenance {
  if (input.artifacts.projector !== undefined) projectorInputSchema.parse(input.artifacts.projector);
  const normalizedInput: Omit<ServedProvenanceInput, "artifacts" | "environment" | "launchConfiguration"> & {
    artifacts: ServedProvenanceArtifacts;
    launchConfiguration: LaunchConfiguration;
    environment: Evidence<EnvironmentSnapshot>;
  } = {
    ...input,
    artifacts: {
      ...input.artifacts,
      projector: normalizeProjector(input.artifacts.projector),
    },
    launchConfiguration: input.launchConfiguration ?? unknownLaunchConfiguration(),
    environment: input.environment ?? UNKNOWN_ENVIRONMENT,
  };
  const { completeness, reasons } = collectCompleteness(normalizedInput);
  return servedProvenanceSchema.parse({
    schemaVersion: SERVED_PROVENANCE_SCHEMA_VERSION,
    ...normalizedInput,
    completeness,
    reasons,
    configurationIdentity: servedConfigurationIdentity(normalizedInput),
  });
}
