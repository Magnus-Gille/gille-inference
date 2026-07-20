/**
 * External exposure-receipt schema (gille#10).
 *
 * This is gille's half of the pair with Hugin's external task/outcome receipt intake
 * (Magnus-Gille/hugin#237, `external-receipt-schema.ts` / `external-receipt-intake.ts`). Hugin's
 * side answers "what happened to this task on a surface Hugin never dispatched it to". This side
 * answers a narrower, exposure-specific question: **has this exact logical task already been
 * EXPOSED — seen, sent to a model, worked on — on Codex App, Codex CLI, or Pi**, so it can be
 * recorded into the SAME content-blind freshness oracle (`task-exposure.ts`, #4/#257) that
 * already answers this question for gille's own gateway-observed lanes.
 *
 * A receipt is a small, versioned, content-blind fact: "surface X, subscription alias Y, using
 * provider/model/harness/effort Z, observed this exact canonical task, at time T." It is never a
 * transcript, prompt, diff, or output — enforced structurally, not just by convention:
 *
 *  - The envelope is `.strict()` — Zod rejects any unrecognised field outright.
 *  - Every identity string is an opaque token (`exposureReceiptTokenSchema`): a bounded character
 *    class with no whitespace or control characters, so free text structurally cannot fit through
 *    an identity field.
 *  - `subscriptionNotIndependentNote` is a fixed literal, never caller-supplied prose — a producer
 *    cannot phrase their way out of the "not independent evidence" disclosure.
 *  - gille NEVER receives raw task text on this path at all: only the producer's own
 *    already-computed `trim-utf8-sha256-v1` digest over the canonical logical task (the exact
 *    same fingerprint contract `task-exposure.ts`'s "canonical-raw" identity already uses for
 *    Hugin's stamped `/delegate` traffic — see docs/task-exposure-contract.md).
 *
 * Non-goals (per gille-inference#10 scope): no raw transcript/prompt/output ingestion; no
 * treatment of two subscription aliases as independent reviewers; no routing/holdout decision is
 * ever made from a receipt alone — see `exposure-receipt-intake.ts`, which only appends registry
 * evidence via `task-exposure.ts`'s existing mechanism.
 */

import { z } from "zod";
import { TASK_FINGERPRINT_VERSION } from "./task-exposure.js";

export const EXPOSURE_RECEIPT_SCHEMA_VERSION = 1 as const;
export const EXPOSURE_RECEIPT_CONTRACT_VERSION = "gille-inference.exposure-receipt/v1" as const;

/** The three non-gateway surfaces this intake accepts (mirrors hugin#237's EXTERNAL_RECEIPT_SURFACES
 *  exactly — the same vocabulary on both sides of the pair). */
export const EXPOSURE_RECEIPT_SURFACES = ["codex_app", "codex_cli", "pi"] as const;
export const exposureReceiptSurfaceSchema = z.enum(EXPOSURE_RECEIPT_SURFACES);
export type ExposureReceiptSurface = z.infer<typeof exposureReceiptSurfaceSchema>;

/** Common reasoning-effort vocabulary across current Codex/Pi harnesses. Not every harness has an
 *  effort dial — `null` means "not applicable / not observed", distinct from omitting the field
 *  (which the schema rejects — the producer must say ONE of a real level or null, never silently
 *  drop it). */
export const EXPOSURE_RECEIPT_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export const exposureReceiptEffortSchema = z.enum(EXPOSURE_RECEIPT_EFFORTS);
export type ExposureReceiptEffort = z.infer<typeof exposureReceiptEffortSchema>;

/** A terminal/observation receipt arriving more than this long after its own `occurredAt` is
 *  marked `imported-late` rather than silently folded in as prompt (mirrors hugin#237's identical
 *  7-day EXTERNAL_RECEIPT_LATE_THRESHOLD_MS constant and rationale: external surfaces have no
 *  dispatcher heartbeat forcing prompt reporting of any ONE fact — this is orthogonal to, and
 *  independent of, the ONGOING producer-heartbeat liveness tracked in task-exposure.ts). */
export const EXPOSURE_RECEIPT_LATE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export const EXPOSURE_RECEIPT_COVERAGE_STATES = ["imported", "imported-late"] as const;
export const exposureReceiptCoverageStateSchema = z.enum(EXPOSURE_RECEIPT_COVERAGE_STATES);
export type ExposureReceiptCoverageState = z.infer<typeof exposureReceiptCoverageStateSchema>;

/**
 * Fixed, non-caller-supplied annotation bound into every admitted receipt (mirrors hugin#237's
 * `CAPACITY_PRINCIPAL_INDEPENDENCE_NOTE` exactly, renamed for gille's own "subscription/account
 * alias" vocabulary — see the issue's scope: "another subscription with same provider/model/
 * harness is NOT an independent reviewer"). A fixed literal rather than free text keeps this
 * assertion itself content-blind and tamper-proof.
 */
export const SUBSCRIPTION_NOT_INDEPENDENT_NOTE =
  "subscription-alias-not-independent-model-evidence" as const;

/** Opaque identity token: letters, digits, and a small punctuation set used by real identifiers.
 *  No whitespace or control characters — structurally content-blind, not merely policy-blind. */
export const exposureReceiptTokenSchema = z.string().regex(
  /^[A-Za-z0-9._:@/-]{1,128}$/,
  { message: "must be a short opaque token (letters, digits, . _ : @ / -), not free text" },
);

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a lowercase 64-character SHA-256 hex string" });
const sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, { message: "must be 'sha256:' followed by a lowercase 64-character hex digest" });

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
/** Exact RFC 3339 UTC timestamp — same discipline as learning-task-contract.ts's timestampSchema. */
export const exposureReceiptTimestampSchema = z.string().refine(isExactUtcTimestamp, {
  message: "invalid RFC 3339 UTC timestamp",
});

/**
 * Wire shape mirroring evidence-identity.ts's `IdentityField` (#5) exactly: a mechanically-bound
 * digest, a weaker symbolic label, or an honest, reasoned "unknown" — never a fabricated value
 * standing in for missing data. Reused here (rather than invented fresh) so a model-config-epoch/
 * harness/instruction/prompt/skill/tool-policy digest asserted by an external producer speaks the
 * SAME identity vocabulary #5 already uses for gille's own capability evidence.
 */
export const identityFieldWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("digest"),
    id: exposureReceiptTokenSchema,
    version: exposureReceiptTokenSchema,
    digest: sha256DigestSchema,
  }).strict(),
  z.object({
    kind: z.literal("label"),
    label: exposureReceiptTokenSchema,
  }).strict(),
  z.object({
    kind: z.literal("unknown"),
    reason: z.enum(["not-applicable", "not-observed", "legacy", "producer-error", "policy-unavailable"]),
    detail: z.string().max(200).optional(),
  }).strict(),
]);
export type IdentityFieldWire = z.infer<typeof identityFieldWireSchema>;

/** Requested vs. effective model, distinguished (issue AC): a requested model is always a plain
 *  asserted token; the EFFECTIVE model the producer actually observed serving the task may
 *  legitimately be unknown (a harness that does not disclose post-routing model substitution) —
 *  that must stay honestly unknown, never guessed to equal the requested model. */
export const modelFieldWireSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), modelId: exposureReceiptTokenSchema }).strict(),
  z.object({
    status: z.literal("unknown"),
    reason: z.enum(["not-applicable", "not-observed", "producer-error", "policy-unavailable"]),
  }).strict(),
]);
export type ModelFieldWire = z.infer<typeof modelFieldWireSchema>;

export const exposureReceiptEnvelopeSchema = z.object({
  schemaVersion: z.literal(EXPOSURE_RECEIPT_SCHEMA_VERSION),
  contractVersion: z.literal(EXPOSURE_RECEIPT_CONTRACT_VERSION),
  kind: z.literal("observation"),
  /** Delivery-level id for this exact receipt — the intake's idempotent-replay/dedup key,
   *  scoped per (surface, authenticated subscription alias). */
  receiptId: exposureReceiptTokenSchema,
  surface: exposureReceiptSurfaceSchema,
  /** The versioned canonical logical-task fingerprint (#4's "canonical-raw" identity) — the ONLY
   *  identity this receipt ever carries; gille never sees the underlying text. */
  fingerprintVersion: z.literal(TASK_FINGERPRINT_VERSION),
  canonicalFingerprintSha256: sha256HexSchema,
  provider: exposureReceiptTokenSchema,
  requestedModel: exposureReceiptTokenSchema,
  effectiveModel: modelFieldWireSchema,
  modelConfigEpoch: identityFieldWireSchema,
  harness: identityFieldWireSchema,
  reasoningEffort: exposureReceiptEffortSchema.nullable(),
  instructionDigest: identityFieldWireSchema,
  promptDigest: identityFieldWireSchema,
  skillDigest: identityFieldWireSchema,
  toolPolicyDigest: identityFieldWireSchema,
  /** Non-secret entitlement/quota epoch for the subscription (issue scope: "for quota/latency/
   *  utilization ONLY" — never read by intake as evidence of anything else). Optional: many
   *  producers have no separate entitlement-epoch concept to report. */
  subscriptionEntitlementEpoch: exposureReceiptTokenSchema.optional(),
  /** When the producer observed the exposure. */
  occurredAt: exposureReceiptTimestampSchema,
  /** When the producer generated this receipt — may be well after `occurredAt` for a late report;
   *  never before it (enforced below). */
  producedAt: exposureReceiptTimestampSchema,
  subscriptionNotIndependentNote: z.literal(SUBSCRIPTION_NOT_INDEPENDENT_NOTE),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.occurredAt) > Date.parse(value.producedAt)) {
    ctx.addIssue({ code: "custom", message: "occurredAt cannot be after producedAt" });
  }
});
export type ExposureReceiptEnvelope = z.infer<typeof exposureReceiptEnvelopeSchema>;

/**
 * The durable, content-blind record intake persists once a receipt is admitted, plus intake's own
 * server-stamped verification facts a caller can never forge because they are never accepted as
 * caller input (`verifiedSubscriptionAlias`, `receivedAt`, `coverage`).
 */
export const storedExposureReceiptSchema = z.object({
  schemaVersion: z.literal(EXPOSURE_RECEIPT_SCHEMA_VERSION),
  receipt: exposureReceiptEnvelopeSchema,
  /** The authenticated gille principal alias that submitted this receipt — a non-secret
   *  subscription/account alias (issue scope), never independent model evidence on its own. */
  verifiedSubscriptionAlias: z.string().min(1),
  receivedAt: exposureReceiptTimestampSchema,
  coverage: exposureReceiptCoverageStateSchema,
}).strict();
export type StoredExposureReceipt = z.infer<typeof storedExposureReceiptSchema>;
