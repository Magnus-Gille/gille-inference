/**
 * Gille-owned LearningTaskContract v1 accounting — record model (issue #3).
 *
 * Companion to Hugin's durable append-only task/outcome registry (hugin#232,
 * `learning-registry-schema.ts` / `learning-registry-store.ts`, vendored read-only at
 * `git show origin/main:src/learning-registry-store.ts` in the hugin repo). Same architectural
 * spirit — append-only natural-key idempotent events, membership evidence issued at capture,
 * authoritative partition/high-water proofs, fail-closed period closes, immutable correction
 * chains — but NOT a copy: different store (SQLite via better-sqlite3, not Munin), different
 * natural keys, and a different ownership boundary.
 *
 * Ownership boundary (grimnir docs/learning-task-contract.md "Normative ownership" table):
 * gille-inference owns direct request identity, exposure, and capability admission/routing
 * accounting for its OWN six counters — direct-attempt, direct-exposure, admission, outcome,
 * exclusion, erasure-adjustment — plus the immutable correction-chain mechanism. Hugin owns its
 * own capture/join/evaluation accounting (hugin#241) and its own submission/attempt-reference/
 * terminal-outcome/publication counters (hugin#232). Neither owner may fabricate or re-assert the
 * other's evidence: a gille-produced joined-exposure record MAY reference a Hugin-issued join
 * receipt, but only after independently verifying it against a durably admitted Hugin request
 * (learning-task-admission-store.ts, issue #2) — never by trusting a body-supplied
 * `owner_component: "hugin"` field (grimnir contract, "Erasure and expiry protocol": "saying
 * owner_component: hugin in a gille body is not evidence").
 *
 * Deliberately pure: no DB, no fs, no network — same purity discipline as evidence-identity.ts
 * and the *-contract.ts modules, so natural-key derivation, membership construction, denominator-
 * basis rules, and partition-proof chain-digest arithmetic are unit-testable without SQLite.
 * gille-accounting-store.ts wires this into `better-sqlite3`.
 *
 * Content-blind throughout: every type here carries only opaque ids, digests, and closed
 * classifications — never prompt/response bytes (mirrors task-exposure.ts and
 * learning-task-admission-store.ts).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { jcsCanonicalize } from "./learning-task-contract.js";

export const GILLE_ACCOUNTING_SCHEMA_VERSION = 1 as const;
/** Every record kind in this module is owned and counted by gille-inference itself. Hugin's own
 *  counters (capture/join/evaluation) are owned and issued by Hugin (hugin#241); this module only
 *  ever CONSUMES a verified reference to them, never emits on Hugin's behalf. */
export const GILLE_ACCOUNTING_COUNTER_OWNER = "gille-inference" as const;

export class GilleAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GilleAccountingError";
  }
}

// ─── Timestamps and periods ────────────────────────────────────────────────────

const utcTimestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

export function isExactUtcTimestamp(value: string): boolean {
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

export const gilleAccountingTimestampSchema = z.string().refine(isExactUtcTimestamp, {
  message: "invalid RFC 3339 UTC timestamp",
});

/** Half-open UTC calendar month, e.g. "2026-07" — the contract's occurrence-period grain. */
export const occurrencePeriodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Derived from the instant itself, never asserted freely (contract: "occurrence_month_utc is
 *  derived from that instant rather than asserted freely"). */
export function occurrencePeriodUtcFromInstant(iso: string): string {
  if (!isExactUtcTimestamp(iso)) {
    throw new GilleAccountingError(`cannot derive occurrence period from invalid timestamp ${iso}`);
  }
  return iso.slice(0, 7);
}

// ─── Digests ────────────────────────────────────────────────────────────────────

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function jcsDigestHex(value: unknown): string {
  return sha256Hex(jcsCanonicalize(value));
}

export function canonicalEqual(left: unknown, right: unknown): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}

export const EMPTY_CHAIN_DIGEST = sha256Hex("");

/** Running hash chain over ordered event digests — tamper-evident, same idiom as
 *  hugin's learning-registry-store.ts `nextChainDigest`. */
export function nextChainDigest(previousChainDigest: string, eventDigest: string): string {
  return sha256Hex(`${previousChainDigest}\0${eventDigest}`);
}

// ─── Record kinds and natural keys ─────────────────────────────────────────────

/**
 * The six counters gille-inference owns (issue #3 scope: "direct attempts/exposures, admissions,
 * outcomes, exclusions, and erasure adjustments") plus "correction" for the immutable correction-
 * chain mechanism itself. Each is its own partition/high-water counter — mirrors hugin#232's
 * `REGISTRY_RECORD_KINDS` shape, different vocabulary.
 */
export const GILLE_ACCOUNTING_RECORD_KINDS = [
  "direct-attempt",
  "direct-exposure",
  "admission",
  "outcome",
  "exclusion",
  "erasure-adjustment",
  "correction",
] as const;
export const gilleAccountingRecordKindSchema = z.enum(GILLE_ACCOUNTING_RECORD_KINDS);
export type GilleAccountingRecordKind = z.infer<typeof gilleAccountingRecordKindSchema>;

/** A reference into a genuinely separate durable evidence store (never a content copy) —
 *  mirrors hugin#232's `RegistryEvidenceRef`. */
export const gilleEvidenceRefSchema = z.object({
  namespace: z.string().min(1),
  key: z.string().min(1),
}).strict();
export type GilleEvidenceRef = z.infer<typeof gilleEvidenceRefSchema>;

/** A reference to a specific Hugin-side attempt, verified (not merely asserted) against
 *  learning-task-admission-store.ts before it may back a joined-exposure or negative-exposure
 *  decision (issue #3 AC "negative exposure evidence identifies and validates the exact
 *  authoritative attempt"). This type only carries the CLAIM; verification lives in the store. */
export const huginAttemptRefSchema = z.object({
  taskInstanceId: z.string().min(1),
  attemptId: z.string().min(1),
}).strict();
export type HuginAttemptRef = z.infer<typeof huginAttemptRefSchema>;

const directAttemptNaturalKeySchema = z.object({
  recordKind: z.literal("direct-attempt"),
  requestId: z.string().min(1),
}).strict();

/** Exposure's two mutually exclusive projections (contract "Exposure facts"): an event actually
 *  observed by a lane, or a later negative-coverage query result. Exactly one id is present. */
const directExposureObservedNaturalKeySchema = z.object({
  recordKind: z.literal("direct-exposure"),
  exposureKind: z.literal("observed"),
  eventKey: z.string().min(1),
}).strict();
const directExposureNegativeCoverageNaturalKeySchema = z.object({
  recordKind: z.literal("direct-exposure"),
  exposureKind: z.literal("negative-coverage"),
  lookupId: z.string().min(1),
}).strict();
/** Plain `z.union`, not `z.discriminatedUnion`: both variants share the SAME `recordKind` literal
 *  ("direct-exposure") and are only distinguished by the nested `exposureKind` field, and zod's
 *  discriminated union requires its member schemas to be plain `ZodObject`s at the chosen
 *  discriminant, not another union — see the outer `gilleNaturalKeySchema` below, which nests this
 *  as one of its own (necessarily non-discriminated-at-this-level) members. */
const directExposureNaturalKeySchema = z.union([
  directExposureObservedNaturalKeySchema,
  directExposureNegativeCoverageNaturalKeySchema,
]);

const admissionNaturalKeySchema = z.object({
  recordKind: z.literal("admission"),
  evidenceId: z.string().min(1),
}).strict();

const outcomeNaturalKeySchema = z.object({
  recordKind: z.literal("outcome"),
  requestId: z.string().min(1),
}).strict();

/** Candidate/boundary exclusion codes this module represents (contract: candidate-* codes plus
 *  the capture/join/direct boundary codes gille itself can observe). Kept intentionally narrower
 *  than Hugin's own evaluation-candidate vocabulary — gille does not own evaluation-candidate
 *  accounting (that is hugin#241); this is scoped to gille's own direct/admission boundary. */
export const GILLE_EXCLUSION_REASONS = [
  "candidate-governance-denied",
  "candidate-erased-or-expired",
  "candidate-exposure-incomplete",
  "candidate-provenance-incomplete",
  "candidate-verifier-inadmissible",
  "candidate-duplicate-lineage",
  "synthetic-test",
  "pre-v1-migration",
] as const;
export const gilleExclusionReasonSchema = z.enum(GILLE_EXCLUSION_REASONS);
export type GilleExclusionReason = z.infer<typeof gilleExclusionReasonSchema>;

const exclusionNaturalKeySchema = z.object({
  recordKind: z.literal("exclusion"),
  subjectId: z.string().min(1),
  exclusionReason: gilleExclusionReasonSchema,
}).strict();

const erasureAdjustmentNaturalKeySchema = z.object({
  recordKind: z.literal("erasure-adjustment"),
  targetEventId: z.string().min(1),
}).strict();

const correctionNaturalKeySchema = z.object({
  recordKind: z.literal("correction"),
  predecessorEventId: z.string().min(1),
}).strict();

/** Plain `z.union` for the same reason as `directExposureNaturalKeySchema` above: one member
 *  (direct-exposure) is itself a union rather than a bare `ZodObject`, which
 *  `z.discriminatedUnion` cannot accept as a member regardless of the outer discriminant. Runtime
 *  behavior is unaffected (zod tries each member; the key space here is seven items) and TypeScript
 *  still narrows `GilleNaturalKey` by `.recordKind` normally since it is a plain structural union. */
export const gilleNaturalKeySchema = z.union([
  directAttemptNaturalKeySchema,
  directExposureNaturalKeySchema,
  admissionNaturalKeySchema,
  outcomeNaturalKeySchema,
  exclusionNaturalKeySchema,
  erasureAdjustmentNaturalKeySchema,
  correctionNaturalKeySchema,
]);
export type GilleNaturalKey = z.infer<typeof gilleNaturalKeySchema>;

/** Deterministic content-derived id: same natural key -> same event id, always. This is what
 *  makes duplicate delivery a natural no-op rather than a second row (issue #3 AC1). */
export function naturalKeyDigest(key: GilleNaturalKey): string {
  return jcsDigestHex(gilleNaturalKeySchema.parse(key));
}

export function deriveEventId(key: GilleNaturalKey): string {
  return `gacc-${naturalKeyDigest(key).slice(0, 32)}`;
}

export function gilleEventKey(eventId: string): string {
  if (!/^gacc-[0-9a-f]{32}$/.test(eventId)) {
    throw new GilleAccountingError(`not a valid gille accounting event id: ${eventId}`);
  }
  return eventId;
}

// ─── Membership evidence ────────────────────────────────────────────────────────

/**
 * Membership evidence issued at capture time (issue #3 AC2): binds the record, counter, the
 * ORIGINAL occurrence period, natural key, and counter owner — established when the record is
 * first captured, never reconstructible after the fact because `issuedAt` is fixed at
 * construction and a correction/erasure never mutates an existing event's own membership row.
 */
export const gilleMembershipSchema = z.object({
  naturalKey: gilleNaturalKeySchema,
  occurrencePeriodUtc: occurrencePeriodSchema,
  counter: gilleAccountingRecordKindSchema,
  counterOwner: z.literal(GILLE_ACCOUNTING_COUNTER_OWNER),
  /** Issued at original capture time — never re-derived or backdated later. */
  issuedAt: gilleAccountingTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.naturalKey.recordKind !== value.counter) {
    ctx.addIssue({
      code: "custom",
      path: ["counter"],
      message: "membership counter must equal the natural key's record kind",
    });
  }
});
export type GilleMembership = z.infer<typeof gilleMembershipSchema>;

export function buildMembership(input: { naturalKey: GilleNaturalKey; issuedAt: string }): GilleMembership {
  return gilleMembershipSchema.parse({
    naturalKey: input.naturalKey,
    occurrencePeriodUtc: occurrencePeriodUtcFromInstant(input.issuedAt),
    counter: input.naturalKey.recordKind,
    counterOwner: GILLE_ACCOUNTING_COUNTER_OWNER,
    issuedAt: input.issuedAt,
  });
}

// ─── Denominator basis (issue #3 AC3/AC "tombstone cannot downgrade") ─────────────
//
// Placed before the Events section deliberately: `erasureAdjustmentEventSchema` below embeds
// `gilleBasisProofSchema` directly (not via z.lazy), so the schema value must already exist by the
// time that object literal is constructed at module load.

/**
 * The exact required counter set is derived from `denominator_basis` (contract, "Erasure and
 * expiry protocol"). `denominatorBasisFor`/`basisProofFor` reference the `GilleAccountingEvent`
 * type declared further below purely as a TYPE (erased at runtime) — TypeScript allows forward
 * type references freely; only the runtime `const` schema objects below have to precede their use.
 */
export type DenominatorBasis =
  | "direct-request-capture"
  | "direct-exposure"
  | "joined-exposure"
  | "negative-exposure-query"
  | "admission-decision"
  | "not-denominator-bearing";

export const gilleCounterRefSchema = z.object({
  owner: z.enum([GILLE_ACCOUNTING_COUNTER_OWNER, "hugin"]),
  counter: z.string().min(1),
}).strict();
export type GilleCounterRef = z.infer<typeof gilleCounterRefSchema>;

/**
 * PURE function of the event's own recordKind/payload — it takes no caller-supplied basis or
 * counter set, so a caller can never talk a direct-exposure tombstone into looking
 * `not-denominator-bearing` or omitting the direct counter (issue #3 AC).
 */
export function denominatorBasisFor(
  event: GilleAccountingEvent,
): { basis: DenominatorBasis; counterSet: GilleCounterRef[] } {
  switch (event.recordKind) {
    case "direct-attempt":
      return {
        basis: "direct-request-capture",
        counterSet: [{ owner: GILLE_ACCOUNTING_COUNTER_OWNER, counter: "direct-attempt" }],
      };
    case "direct-exposure": {
      const gilleCounter: GilleCounterRef = { owner: GILLE_ACCOUNTING_COUNTER_OWNER, counter: "direct-exposure" };
      if (event.payload.exposureKind === "negative-coverage") {
        const counterSet = event.payload.joined
          ? [gilleCounter, { owner: "hugin" as const, counter: "join" }]
          : [gilleCounter];
        return { basis: "negative-exposure-query", counterSet };
      }
      if (event.payload.joined) {
        return { basis: "joined-exposure", counterSet: [gilleCounter, { owner: "hugin", counter: "join" }] };
      }
      return { basis: "direct-exposure", counterSet: [gilleCounter] };
    }
    case "admission":
      return {
        basis: "admission-decision",
        counterSet: [{ owner: GILLE_ACCOUNTING_COUNTER_OWNER, counter: "admission" }],
      };
    case "outcome":
    case "exclusion":
    case "erasure-adjustment":
    case "correction":
      return { basis: "not-denominator-bearing", counterSet: [] };
  }
}

/**
 * Authenticated denominator-basis evidence (issue #3 AC3). Binds producer identity, record
 * kind+id, the exact basis, the exact applicable counter set, the authoritative issuer, and an
 * issuance clock. `issuedAt` is always the record's OWN original `membership.issuedAt` — this
 * proof is never minted fresh with "now" at erasure time, so it cannot be backdated or postdated
 * independently of the record it describes.
 */
export const gilleBasisProofSchema = z.object({
  producer: z.literal(GILLE_ACCOUNTING_COUNTER_OWNER),
  recordKind: gilleAccountingRecordKindSchema,
  recordId: z.string().min(1),
  basis: z.enum([
    "direct-request-capture", "direct-exposure", "joined-exposure",
    "negative-exposure-query", "admission-decision", "not-denominator-bearing",
  ]),
  counterSet: z.array(gilleCounterRefSchema),
  issuer: z.literal(GILLE_ACCOUNTING_COUNTER_OWNER),
  issuedAt: gilleAccountingTimestampSchema,
}).strict().superRefine((value, ctx) => {
  if (value.basis === "not-denominator-bearing" && value.counterSet.length > 0) {
    ctx.addIssue({ code: "custom", path: ["counterSet"], message: "a not-denominator-bearing basis must carry no counters" });
  }
  if (value.basis !== "not-denominator-bearing" && value.counterSet.length === 0) {
    ctx.addIssue({ code: "custom", path: ["counterSet"], message: "a denominator-bearing basis must carry at least one counter" });
  }
});
export type GilleBasisProof = z.infer<typeof gilleBasisProofSchema>;

/** Recompute the authoritative basis proof directly from the stored event — never trust a
 *  caller-supplied one. Used both to ISSUE the proof and, again, to VERIFY a proof presented
 *  later by re-deriving and comparing (gille-accounting-store.ts). */
export function basisProofFor(event: GilleAccountingEvent): GilleBasisProof {
  const { basis, counterSet } = denominatorBasisFor(event);
  return gilleBasisProofSchema.parse({
    producer: GILLE_ACCOUNTING_COUNTER_OWNER,
    recordKind: event.recordKind,
    recordId: event.eventId,
    basis,
    counterSet,
    issuer: GILLE_ACCOUNTING_COUNTER_OWNER,
    issuedAt: event.membership.issuedAt,
  });
}

// ─── Events ─────────────────────────────────────────────────────────────────────

const gilleEventBase = {
  schemaVersion: z.literal(GILLE_ACCOUNTING_SCHEMA_VERSION),
  eventId: z.string().regex(/^gacc-[0-9a-f]{32}$/),
  membership: gilleMembershipSchema,
  /** When the underlying fact happened. */
  occurredAt: gilleAccountingTimestampSchema,
  /** When the store durably accepted the event. */
  recordedAt: gilleAccountingTimestampSchema,
};

export const directAttemptEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("direct-attempt"),
  requestId: z.string().min(1),
  payload: z.object({
    lane: z.string().min(1),
    fingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();

export const directExposureEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("direct-exposure"),
  payload: z.object({
    exposureKind: z.enum(["observed", "negative-coverage"]),
    fingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lane: z.string().min(1),
    /** True only when this exposure is joined to a Hugin-dispatched attempt. When true, a
     *  verified `huginAttemptRef` MUST be present — see gille-accounting-store.ts's
     *  `verifyHuginAttemptReference`, never trusted from this payload alone. */
    joined: z.boolean(),
    huginAttemptRef: huginAttemptRefSchema.optional(),
  }).strict(),
}).strict();

export const admissionEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("admission"),
  evidenceId: z.string().min(1),
  payload: z.object({
    admitted: z.boolean(),
    admissionBasis: z.enum(["full-pass", "policy-qualified-partial", "none"]),
  }).strict(),
}).strict();

export const outcomeEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("outcome"),
  requestId: z.string().min(1),
  payload: z.object({
    outcome: z.enum(["completed", "timeout", "cancelled", "failed", "infrastructure-error"]),
    failureMode: z.string().nullable(),
  }).strict(),
}).strict();

export const exclusionEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("exclusion"),
  subjectId: z.string().min(1),
  payload: z.object({
    exclusionReason: gilleExclusionReasonSchema,
    note: z.string().min(1).max(512).optional(),
  }).strict(),
}).strict();

export const erasureAdjustmentEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("erasure-adjustment"),
  payload: z.object({
    targetEventId: z.string().min(1),
    targetNaturalKey: gilleNaturalKeySchema,
    adjustmentReason: z.enum(["erasure", "exclusion"]),
    /** The exact basis proof that authorized this adjustment — retained for audit, content-blind. */
    basisProof: gilleBasisProofSchema,
    note: z.string().min(1).max(512).optional(),
  }).strict(),
}).strict();

export const correctionEventSchema = z.object({
  ...gilleEventBase,
  recordKind: z.literal("correction"),
  payload: z.object({
    predecessorEventId: z.string().min(1),
    /** Must equal the predecessor's own natural key — a correction cannot retarget. */
    correctedNaturalKey: gilleNaturalKeySchema,
    reason: z.string().min(1).max(512),
    evidenceRef: gilleEvidenceRefSchema.optional(),
  }).strict(),
}).strict();

export const gilleAccountingEventSchema = z.discriminatedUnion("recordKind", [
  directAttemptEventSchema,
  directExposureEventSchema,
  admissionEventSchema,
  outcomeEventSchema,
  exclusionEventSchema,
  erasureAdjustmentEventSchema,
  correctionEventSchema,
]).superRefine((value, ctx) => {
  if (value.membership.counter !== value.recordKind) {
    ctx.addIssue({ code: "custom", message: "event record kind does not match its membership counter" });
  }
  if (value.membership.naturalKey.recordKind !== value.recordKind) {
    ctx.addIssue({ code: "custom", message: "event does not bind its own natural key" });
  }
  if (Date.parse(value.occurredAt) > Date.parse(value.recordedAt)) {
    ctx.addIssue({ code: "custom", message: "occurredAt cannot be after recordedAt" });
  }
  if (value.occurredAt !== value.membership.issuedAt) {
    ctx.addIssue({
      code: "custom",
      message: "membership evidence must be issued at original capture time (occurredAt)",
    });
  }
  const expectedEventId = deriveEventId(value.membership.naturalKey);
  if (value.eventId !== expectedEventId) {
    ctx.addIssue({ code: "custom", path: ["eventId"], message: "event id is not content-derived from its natural key" });
  }
  if (value.recordKind === "direct-attempt" && value.membership.naturalKey.recordKind === "direct-attempt"
    && value.membership.naturalKey.requestId !== value.requestId) {
    ctx.addIssue({ code: "custom", path: ["requestId"], message: "event requestId does not match its natural key" });
  }
  if (value.recordKind === "outcome" && value.membership.naturalKey.recordKind === "outcome"
    && value.membership.naturalKey.requestId !== value.requestId) {
    ctx.addIssue({ code: "custom", path: ["requestId"], message: "event requestId does not match its natural key" });
  }
  if (value.recordKind === "admission" && value.membership.naturalKey.recordKind === "admission"
    && value.membership.naturalKey.evidenceId !== value.evidenceId) {
    ctx.addIssue({ code: "custom", path: ["evidenceId"], message: "event evidenceId does not match its natural key" });
  }
  if (value.recordKind === "exclusion" && value.membership.naturalKey.recordKind === "exclusion") {
    if (value.membership.naturalKey.subjectId !== value.subjectId) {
      ctx.addIssue({ code: "custom", path: ["subjectId"], message: "event subjectId does not match its natural key" });
    }
    if (value.membership.naturalKey.exclusionReason !== value.payload.exclusionReason) {
      ctx.addIssue({ code: "custom", path: ["payload", "exclusionReason"], message: "exclusion reason does not match its natural key" });
    }
  }
  if (value.recordKind === "direct-exposure" && value.membership.naturalKey.recordKind === "direct-exposure") {
    if (value.membership.naturalKey.exposureKind !== value.payload.exposureKind) {
      ctx.addIssue({ code: "custom", path: ["payload", "exposureKind"], message: "exposure kind does not match its natural key" });
    }
    if (value.payload.joined && !value.payload.huginAttemptRef) {
      ctx.addIssue({ code: "custom", path: ["payload", "huginAttemptRef"], message: "a joined exposure must carry a Hugin attempt reference" });
    }
  }
  if (value.recordKind === "correction") {
    if (value.membership.naturalKey.recordKind === "correction"
      && value.membership.naturalKey.predecessorEventId !== value.payload.predecessorEventId) {
      ctx.addIssue({ code: "custom", path: ["payload", "predecessorEventId"], message: "correction natural key does not match its own predecessor" });
    }
    if (value.payload.predecessorEventId === value.eventId) {
      ctx.addIssue({ code: "custom", message: "a correction cannot target itself" });
    }
  }
  if (value.recordKind === "erasure-adjustment") {
    if (value.membership.naturalKey.recordKind === "erasure-adjustment"
      && value.membership.naturalKey.targetEventId !== value.payload.targetEventId) {
      ctx.addIssue({ code: "custom", path: ["payload", "targetEventId"], message: "erasure-adjustment natural key does not match its own target" });
    }
    if (value.payload.targetEventId === value.eventId) {
      ctx.addIssue({ code: "custom", message: "an erasure-adjustment cannot target itself" });
    }
  }
});
export type GilleAccountingEvent = z.infer<typeof gilleAccountingEventSchema>;
export type DirectAttemptEvent = z.infer<typeof directAttemptEventSchema>;
export type DirectExposureEvent = z.infer<typeof directExposureEventSchema>;
export type AdmissionEvent = z.infer<typeof admissionEventSchema>;
export type OutcomeEvent = z.infer<typeof outcomeEventSchema>;
export type ExclusionEvent = z.infer<typeof exclusionEventSchema>;
export type ErasureAdjustmentEvent = z.infer<typeof erasureAdjustmentEventSchema>;
export type CorrectionEvent = z.infer<typeof correctionEventSchema>;

// ─── Partition / high-water proof primitives ───────────────────────────────────

export const gillePartitionProofStatusSchema = z.enum(["complete", "empty-confirmed", "partial"]);
export type GillePartitionProofStatus = z.infer<typeof gillePartitionProofStatusSchema>;

export const gillePartitionProofSchema = z.object({
  schemaVersion: z.literal(GILLE_ACCOUNTING_SCHEMA_VERSION),
  counter: gilleAccountingRecordKindSchema,
  counterOwner: z.literal(GILLE_ACCOUNTING_COUNTER_OWNER),
  occurrencePeriodUtc: occurrencePeriodSchema,
  status: gillePartitionProofStatusSchema,
  highWaterSeq: z.number().int().nonnegative(),
  eventIds: z.array(z.string()),
  chainDigest: z.string().regex(/^[0-9a-f]{64}$/),
  issuedAt: gilleAccountingTimestampSchema,
  /** Non-empty only for status "partial" — why certification was refused. */
  partialReason: z.string().min(1).max(256).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === "partial" && !value.partialReason) {
    ctx.addIssue({ code: "custom", path: ["partialReason"], message: "a partial proof must explain why it is not certifiable" });
  }
  if (value.status !== "partial" && value.partialReason) {
    ctx.addIssue({ code: "custom", path: ["partialReason"], message: "only a partial proof carries a partialReason" });
  }
  if (value.status === "empty-confirmed" && (value.highWaterSeq !== 0 || value.eventIds.length !== 0)) {
    ctx.addIssue({ code: "custom", message: "an empty-confirmed proof cannot carry events" });
  }
  if (value.eventIds.length !== value.highWaterSeq) {
    ctx.addIssue({ code: "custom", message: "proof event count does not match its high-water sequence" });
  }
});
export type GillePartitionProof = z.infer<typeof gillePartitionProofSchema>;

/**
 * Only a "complete" or an authenticated "empty-confirmed" proof may certify a full-period close.
 * A "partial" proof — including one a caller derives by recomputing a digest over whatever subset
 * it happened to load — is always ineligible (issue #3 AC "partial snapshots... ineligible for
 * certification"). Mirrors hugin#232's `isEligibleForCertification` exactly; same criteria, same
 * name, different store underneath.
 */
export function isEligibleForCertification(proof: GillePartitionProof): boolean {
  return proof.status === "complete" || proof.status === "empty-confirmed";
}

export class PartialSnapshotNotCertifiableError extends Error {
  constructor(public readonly proof: GillePartitionProof) {
    super(
      `gille accounting partition ${proof.counter}/${proof.occurrencePeriodUtc} is only a partial ` +
      `snapshot (${proof.partialReason ?? "no reason given"}) and cannot certify a full-period close`,
    );
    this.name = "PartialSnapshotNotCertifiableError";
  }
}

/** Fail-closed assertion: throws on anything but an eligible (complete/empty-confirmed) proof. */
export function assertCertifiable(proof: GillePartitionProof): void {
  if (!isEligibleForCertification(proof)) throw new PartialSnapshotNotCertifiableError(proof);
}
