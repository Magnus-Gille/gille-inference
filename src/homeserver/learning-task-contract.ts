import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Public wire constants from Grimnir's accepted LearningTaskContract v1. */
export const LEARNING_TASK_CONTRACT_VERSION = "grimnir.learning-task/v1" as const;
export const LEARNING_TASK_SCHEMA_REVISION = 1 as const;
export const LEARNING_TASK_PREFLIGHT_ENDPOINT = "/v1/capabilities/learning-task" as const;
export const LEARNING_TASK_PREFLIGHT_PROTOCOL = "learning-task-preflight/v1" as const;
export const LEARNING_TASK_SERVICE_PRINCIPAL = "service:gille-inference" as const;
export const LEARNING_TASK_PREFLIGHT_TTL_MS = 15 * 60 * 1_000;
export const LEARNING_TASK_FEATURES = [
  "hugin-request-stamp-v1",
  "gateway-echo-v1",
  "three-stage-prompt-provenance-v1",
  "reproducible-serving-digests-v1",
] as const;

export const LEARNING_TASK_CAPABILITIES = {
  contract_version: LEARNING_TASK_CONTRACT_VERSION,
  schema_revision: LEARNING_TASK_SCHEMA_REVISION,
  features: [...LEARNING_TASK_FEATURES],
} as const;

const opaqueIdSchema = z.string().regex(
  /^opaque:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const nonEmptyStringSchema = z.string().min(1);
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

const timestampSchema = z.string().refine(isExactUtcTimestamp, {
  message: "invalid RFC 3339 UTC timestamp",
});

const featureSchema = z.enum(LEARNING_TASK_FEATURES);
const capabilityAdvertisementSchema = z.object({
  contract_version: z.literal(LEARNING_TASK_CONTRACT_VERSION),
  schema_revision: z.literal(LEARNING_TASK_SCHEMA_REVISION),
  features: z.array(featureSchema).length(LEARNING_TASK_FEATURES.length).superRefine((features, ctx) => {
    if (new Set(features).size !== LEARNING_TASK_FEATURES.length) {
      ctx.addIssue({ code: "custom", message: "learning-task features must be unique and complete" });
    }
    for (const required of LEARNING_TASK_FEATURES) {
      if (!features.includes(required)) {
        ctx.addIssue({ code: "custom", message: `missing required learning-task feature ${required}` });
      }
    }
  }),
}).strict();

export type GatewayCapabilityAdvertisement = z.infer<typeof capabilityAdvertisementSchema>;

const preflightRequestSchema = z.object({
  request_id: opaqueIdSchema,
  endpoint: z.literal(LEARNING_TASK_PREFLIGHT_ENDPOINT),
  protocol_version: z.literal(LEARNING_TASK_PREFLIGHT_PROTOCOL),
  requested_at: timestampSchema,
  requested_capabilities: capabilityAdvertisementSchema,
}).strict();

const preflightResponseSchema = z.object({
  advertisement_id: opaqueIdSchema,
  endpoint: z.literal(LEARNING_TASK_PREFLIGHT_ENDPOINT),
  protocol_version: z.literal(LEARNING_TASK_PREFLIGHT_PROTOCOL),
  advertised_at: timestampSchema,
  expires_at: timestampSchema,
  authenticated_principal_id: z.literal(LEARNING_TASK_SERVICE_PRINCIPAL),
  authentication: z.literal("service-auth"),
  capabilities: capabilityAdvertisementSchema,
}).strict();

export type LearningTaskPreflightRequest = z.infer<typeof preflightRequestSchema>;
export type LearningTaskPreflightResponse = z.infer<typeof preflightResponseSchema>;

const sourceDocumentTypeSchema = z.enum([
  "raw-input",
  "prompt-stage",
  "origin-prompt-config",
  "origin-harness-config",
  "origin-tool-policy-config",
  "gateway-harness-config",
  "gateway-tool-policy-config",
  "capability-policy-config",
  "experiment-config",
  "rubric-config",
  "quality-receipt-native-v1",
  "quality-receipt-native-v2",
  "artifact-manifest",
  "effective-runtime-config",
  "effective-sampling-post-default-post-clamp",
  "governance-policy-manifest",
]);
const sourceDocumentDigestSchema = z.object({
  algorithm: z.literal("sha256"),
  canonicalization: z.literal("jcs-rfc8785-utf8-v1"),
  source_ref: z.string().regex(/^source-doc:[a-z0-9][a-z0-9._/-]*$/),
  source_type: sourceDocumentTypeSchema,
  source_version: nonEmptyStringSchema,
  digest: sha256Schema,
}).strict();

const unknownSchema = z.object({
  value: z.null(),
  unknown_reason: z.enum([
    "not-applicable",
    "not-observed",
    "legacy",
    "producer-error",
    "redacted",
    "erased",
    "expired",
    "not-admitted",
    "transport-auth-failed",
    "policy-unavailable",
  ]),
  detail: nonEmptyStringSchema.optional(),
}).strict();
const sourcePrincipalSchema = z.object({
  id: nonEmptyStringSchema,
  authentication: z.enum(["verified-signature", "gateway-owner-auth", "service-auth"]),
  scope: z.enum(["owner", "service"]),
}).strict();
const sourceSchema = z.object({
  component: z.literal("hugin"),
  system: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
  created_at: timestampSchema,
  accepted_at: timestampSchema,
  principal: z.union([sourcePrincipalSchema, unknownSchema]),
  content_owner: z.object({
    id: nonEmptyStringSchema,
    authority: z.enum(["authenticated-owner", "delegated-owner"]),
  }).strict(),
}).strict();

const TASK_TYPE_IDS = [
  "draft", "code-implement", "code-edit", "code-review", "unit-test-gen", "summarize",
  "extract", "classify", "data-transform", "regex", "sql", "reason-math", "reason-hard",
  "rewrite", "translate", "plan-decompose", "qa-factual", "triage", "memory-decision",
  "research-plan", "source-distill", "claim-verify", "gap-check", "synthesis", "conversation",
  "other",
] as const;
const taskTypeSchema = z.object({
  id: z.enum(TASK_TYPE_IDS),
  taxonomy_id: z.literal("gille-inference/task-types"),
  taxonomy_version: z.literal("gille-inference-task-types-2026-07-19-v1"),
}).strict();

const versionedConfigIdentitySchema = z.object({
  id: nonEmptyStringSchema,
  version: nonEmptyStringSchema,
  config_digest: sourceDocumentDigestSchema,
}).strict();

const rawInputDigestSchema = sourceDocumentDigestSchema.refine(
  (value) => value.source_type === "raw-input",
  { message: "raw_input source_type must be raw-input" },
);
const huginEnvelopeDigestSchema = sourceDocumentDigestSchema.refine(
  (value) => value.source_type === "prompt-stage",
  { message: "hugin_envelope source_type must be prompt-stage" },
);
function configIdentityOf(sourceType: "origin-prompt-config" | "origin-harness-config" | "origin-tool-policy-config") {
  return versionedConfigIdentitySchema.refine(
    (value) => value.config_digest.source_type === sourceType,
    { message: `configuration digest source_type must be ${sourceType}` },
  );
}

const huginRequestStampSchema = z.object({
  task_instance_id: nonEmptyStringSchema,
  attempt_id: nonEmptyStringSchema,
  client_id: nonEmptyStringSchema,
  expected_transport_principal_id: nonEmptyStringSchema,
  idempotency_key: opaqueIdSchema,
  request_id: opaqueIdSchema,
  stamped_at: timestampSchema,
  contract_request: capabilityAdvertisementSchema,
  preflight: z.object({
    request: preflightRequestSchema,
    response: preflightResponseSchema,
  }).strict(),
  source: sourceSchema,
  task_type: taskTypeSchema,
  raw_input: rawInputDigestSchema,
  raw_fingerprint: z.object({
    algorithm: z.literal("sha256"),
    version: z.literal("trim-utf8-sha256-v1"),
    digest: sha256Schema,
  }).strict(),
  hugin_envelope: huginEnvelopeDigestSchema,
  origin_config: z.object({
    prompt: configIdentityOf("origin-prompt-config"),
    harness: configIdentityOf("origin-harness-config"),
    tool_policy: configIdentityOf("origin-tool-policy-config"),
  }).strict(),
  macro_decision: z.object({
    policy_id: nonEmptyStringSchema,
    version: nonEmptyStringSchema,
    decision_id: nonEmptyStringSchema,
    target: z.literal("m5"),
    service: z.literal("gille-inference"),
  }).strict(),
}).strict();

export type HuginRequestStamp = z.infer<typeof huginRequestStampSchema>;

const gatewayEchoSchema = z.object({
  echoed_request: huginRequestStampSchema,
  gateway_request_id: opaqueIdSchema,
  admission_id: opaqueIdSchema,
  admitted_at: timestampSchema,
  authenticated_principal_id: nonEmptyStringSchema,
  authentication: z.enum(["gateway-owner-auth", "service-auth"]),
  principal_binding_digest: z.object({
    algorithm: z.literal("sha256"),
    version: z.literal("gateway-principal-request-binding-jcs-v1"),
    digest: sha256Schema,
  }).strict(),
  capabilities: capabilityAdvertisementSchema,
}).strict();

export type LearningTaskGatewayEcho = z.infer<typeof gatewayEchoSchema>;

export class LearningTaskContractError extends Error {
  constructor(message: string, public readonly detail?: unknown) {
    super(message);
    this.name = "LearningTaskContractError";
  }
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new LearningTaskContractError("JCS rejects a lone high surrogate");
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new LearningTaskContractError("JCS rejects a lone low surrogate");
    }
  }
}

/** RFC 8785 / ECMAScript JSON canonicalization used by the accepted contract's digest fields. */
export function jcsCanonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jcsCanonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => {
      assertUnicodeScalarString(key);
      return `${JSON.stringify(key)}:${jcsCanonicalize(object[key])}`;
    }).join(",")}}`;
  }
  if (typeof value === "string") assertUnicodeScalarString(value);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new LearningTaskContractError("JCS rejects non-finite numbers");
  }
  if (!(["string", "number", "boolean"] as const).includes(typeof value as "string" | "number" | "boolean") && value !== null) {
    throw new LearningTaskContractError(`JCS rejects non-JSON value ${typeof value}`);
  }
  return JSON.stringify(value);
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}

function hmacUuid(secret: Buffer, payload: unknown): string {
  const bytes = createHmac("sha256", secret).update(jcsCanonicalize(payload), "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function unsignedPreflightResponse(
  advertisedAt: string,
  expiresAt: string,
): Omit<LearningTaskPreflightResponse, "advertisement_id"> {
  return {
    endpoint: LEARNING_TASK_PREFLIGHT_ENDPOINT,
    protocol_version: LEARNING_TASK_PREFLIGHT_PROTOCOL,
    advertised_at: advertisedAt,
    expires_at: expiresAt,
    authenticated_principal_id: LEARNING_TASK_SERVICE_PRINCIPAL,
    authentication: "service-auth",
    capabilities: {
      contract_version: LEARNING_TASK_CONTRACT_VERSION,
      schema_revision: LEARNING_TASK_SCHEMA_REVISION,
      features: [...LEARNING_TASK_FEATURES],
    },
  };
}

/**
 * Process/configuration epoch for authenticated preflight responses. The opaque advertisement id
 * is an HMAC over the exact closed response. Restarting an incompatible (or any) gateway process
 * rotates the secret, so a cached response cannot silently cross an epoch even while its wall
 * clock expiry remains in the future. No secret or deployment identifier is exposed on the wire.
 */
export class LearningTaskCapabilityEpoch {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  advertise(now: Date = new Date()): LearningTaskPreflightResponse {
    if (Number.isNaN(now.getTime())) throw new LearningTaskContractError("invalid preflight observation time");
    const advertisedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + LEARNING_TASK_PREFLIGHT_TTL_MS).toISOString();
    const unsigned = unsignedPreflightResponse(advertisedAt, expiresAt);
    return preflightResponseSchema.parse({
      advertisement_id: `opaque:${hmacUuid(this.secret, unsigned)}`,
      ...unsigned,
    });
  }

  accepts(raw: unknown, now: Date = new Date()): boolean {
    const parsed = preflightResponseSchema.safeParse(raw);
    if (!parsed.success || Number.isNaN(now.getTime())) return false;
    const response = parsed.data;
    const advertised = Date.parse(response.advertised_at);
    const expires = Date.parse(response.expires_at);
    if (!(advertised <= now.getTime() && now.getTime() < expires)) return false;
    if (expires - advertised > LEARNING_TASK_PREFLIGHT_TTL_MS) return false;
    const { advertisement_id: _advertisementId, ...unsigned } = response;
    const expected = `opaque:${hmacUuid(this.secret, unsigned)}`;
    const actualBytes = Buffer.from(response.advertisement_id, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  }
}

export function createLearningTaskCapabilityEpoch(): LearningTaskCapabilityEpoch {
  return new LearningTaskCapabilityEpoch();
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ");
}

/** Structural parser shared by the live gateway, fixtures, and the future Hugin #240 serializer. */
export function parseHuginRequestStamp(raw: unknown): HuginRequestStamp {
  const parsed = huginRequestStampSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LearningTaskContractError(`invalid Hugin request stamp: ${formatZodIssues(parsed.error)}`, parsed.error.flatten());
  }
  return parsed.data;
}

/** Structural reader for durable echo recovery; rejects partial or silently widened payloads. */
export function parseLearningTaskGatewayEcho(raw: unknown): LearningTaskGatewayEcho {
  const parsed = gatewayEchoSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LearningTaskContractError(`invalid gateway echo: ${formatZodIssues(parsed.error)}`, parsed.error.flatten());
  }
  return parsed.data;
}

export interface LearningTaskStampValidationContext {
  capabilityEpoch: LearningTaskCapabilityEpoch;
  authenticatedPrincipalId: string;
  authentication: "gateway-owner-auth" | "service-auth";
  /**
   * A transport-level idempotency key, when the hosting surface has one outside the stamp.
   * `code_loop_start` supplies `client_run_id`; `/delegate` does not duplicate the stamp's key.
   */
  transportIdempotencyKey?: string | null;
  effectiveTaskType: string;
  now?: Date;
}

/** Fail-closed semantic validation before any new model admission. */
export function validateHuginRequestStamp(
  raw: unknown,
  context: LearningTaskStampValidationContext,
): HuginRequestStamp {
  const stamp = parseHuginRequestStamp(raw);
  const now = context.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new LearningTaskContractError("invalid gateway validation time");
  if (!context.capabilityEpoch.accepts(stamp.preflight.response, now)) {
    throw new LearningTaskContractError("preflight advertisement is expired or belongs to another gateway epoch");
  }
  if (!canonicalEqual(stamp.contract_request, stamp.preflight.request.requested_capabilities)
    || !canonicalEqual(stamp.contract_request, stamp.preflight.response.capabilities)
    || !canonicalEqual(stamp.contract_request, LEARNING_TASK_CAPABILITIES)) {
    throw new LearningTaskContractError("contract version, schema revision, or required feature set does not match the accepted preflight");
  }
  if (stamp.expected_transport_principal_id !== context.authenticatedPrincipalId) {
    throw new LearningTaskContractError("authenticated principal does not match expected transport principal");
  }
  if (context.transportIdempotencyKey !== undefined
    && (context.transportIdempotencyKey === null || stamp.idempotency_key !== context.transportIdempotencyKey)) {
    throw new LearningTaskContractError("learning-task idempotency key must equal the durable transport idempotency key");
  }
  if (stamp.task_type.id !== context.effectiveTaskType) {
    throw new LearningTaskContractError("stamped task type does not match the effective gateway task type");
  }

  // The accepted v1 schema defines client_id as a non-empty producer namespace, not the literal
  // "hugin". The durable admission guard therefore does not invent a narrower wire contract; it
  // prevents client-id substitution by keying task-attempt and request uniqueness to the verified
  // transport principal without client_id, while retaining client_id as part of exact equality.

  // Do not compare raw_fingerprint with code_loop.instruction. The accepted contract deliberately
  // distinguishes Hugin's pre-orchestration raw input from its post-context/system task envelope;
  // `instruction` is allowed to be that envelope. Hugin owns the source documents that prove the
  // two stages. Here the full closed stamp and actual instruction are instead bound together by
  // codeLoopRequestFingerprint, so an idempotency replay cannot substitute either one.

  const created = Date.parse(stamp.source.created_at);
  const accepted = Date.parse(stamp.source.accepted_at);
  const requested = Date.parse(stamp.preflight.request.requested_at);
  const advertised = Date.parse(stamp.preflight.response.advertised_at);
  const stamped = Date.parse(stamp.stamped_at);
  const expires = Date.parse(stamp.preflight.response.expires_at);
  if (!(created <= accepted && accepted <= stamped)) {
    throw new LearningTaskContractError("source creation/acceptance clocks are outside the request stamp ordering");
  }
  if (!(requested <= advertised && advertised <= stamped && stamped < expires && stamped <= now.getTime())) {
    throw new LearningTaskContractError("preflight freshness does not cover the request stamp");
  }
  if (expires - advertised > LEARNING_TASK_PREFLIGHT_TTL_MS) {
    throw new LearningTaskContractError("preflight freshness window exceeds fifteen minutes");
  }
  return stamp;
}

/** Content-blind digest of the request as observed by a concrete gateway surface. */
export function learningTaskObservedRequestFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(jcsCanonicalize(value), "utf8").digest("hex")}`;
}

export interface LearningTaskEchoContext {
  authenticatedPrincipalId: string;
  authentication: "gateway-owner-auth" | "service-auth";
  gatewayRequestId: string;
  admissionId: string;
  admittedAt: Date;
}

/** Build the exact content-blind admission echo persisted for idempotent recovery. */
export function createLearningTaskGatewayEcho(
  stamp: HuginRequestStamp,
  context: LearningTaskEchoContext,
): LearningTaskGatewayEcho {
  if (context.authenticatedPrincipalId !== stamp.expected_transport_principal_id) {
    throw new LearningTaskContractError("cannot echo a request for another authenticated principal");
  }
  const admittedAt = context.admittedAt.toISOString();
  if (Date.parse(admittedAt) < Date.parse(stamp.stamped_at)) {
    throw new LearningTaskContractError("gateway admission precedes the Hugin request stamp");
  }
  const echoedRequest = structuredClone(stamp);
  const bindingSource = {
    authenticated_principal_id: context.authenticatedPrincipalId,
    request_stamp: echoedRequest,
  };
  const echo = {
    echoed_request: echoedRequest,
    gateway_request_id: context.gatewayRequestId,
    admission_id: context.admissionId,
    admitted_at: admittedAt,
    authenticated_principal_id: context.authenticatedPrincipalId,
    authentication: context.authentication,
    principal_binding_digest: {
      algorithm: "sha256" as const,
      version: "gateway-principal-request-binding-jcs-v1" as const,
      digest: createHash("sha256").update(jcsCanonicalize(bindingSource), "utf8").digest("hex"),
    },
    capabilities: structuredClone(stamp.contract_request),
  };
  const parsed = gatewayEchoSchema.safeParse(echo);
  if (!parsed.success) {
    throw new LearningTaskContractError(`invalid gateway echo: ${formatZodIssues(parsed.error)}`, parsed.error.flatten());
  }
  return parsed.data;
}
