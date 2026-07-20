/**
 * Import admissible Hugin experiment outcomes into authoritative capability evidence (issue #8).
 *
 * Hugin runs controlled champion/challenger experiments (LearningExperimentStore, hugin#233's
 * packager) and produces per-arm outcomes carrying attempt evidence, quality receipts, and
 * configuration identity. This module is the gille-side IMPORT bridge that admits a *verified,
 * complete* such outcome into the capability ledger (ledger.ts) — see docs/learning-task-contract.md
 * (grimnir) for the normative vocabulary this deliberately narrow bridge draws on (independent
 * verifier admissibility, the mechanical-capability vs product-quality boundary, correction lineage,
 * append-only conflict keys) without implementing that contract's full wire format, which this
 * repository does not yet emit for experiment-observation/quality-receipt/experiment-product-rating
 * record kinds (Phase 1 adoption is scoped to issues #2/#3/#4 — see the contract's "Adoption" section).
 *
 * Two hard boundaries this module preserves (issue #8 Non-goals):
 *
 *  1. Mechanical capability vs product quality. `ledger.Outcome` (pass/partial/fail/error/unverified)
 *     is a MECHANICAL verdict only. A Hugin product/quality rating is never written into that column
 *     or otherwise merged into a pass/fail signal — it is stored separately in
 *     experiment-import-store.ts's `rating` field, LINKED to the mechanical row by natural key and
 *     queryable alongside it, never flattened into it. gille does not own or reproduce Hugin's
 *     product-quality judgment (that stays Hugin's).
 *  2. No routing-policy change. This module ADMITS evidence into the ledger via the exact same
 *     `importDelegations` primitive every other durable-evidence importer uses (issue #151) — it does
 *     not touch getVerdict/shouldDelegate/routing-table-generator. A failed/inconclusive EXPERIMENT
 *     (as opposed to an individual arm's mechanical fail, which is itself real evidence) is retained
 *     as a `shadow` row (#234's existing exclude-by-default mechanism) so it is visible for audit
 *     without influencing any verdict math or recommendation.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  importDelegations,
  importId,
  supersedeDelegationById,
  type ErrorClass,
  type ImportableDelegation,
  type Outcome,
} from "./ledger.js";
import {
  assertAdmissibleEvidenceIdentity,
  digestIdentity,
  evidenceIdentityDisclosure,
  labelIdentity,
  unknownIdentity,
  PlaceholderEvidenceIdentityError,
  TASK_EXPOSURE_LANES,
  type EvidenceIdentityBundle,
  type IdentityField,
  type IdentityOrigin,
  type IdentityUnknownReason,
} from "./evidence-identity.js";
import { jcsCanonicalize } from "./learning-task-contract.js";
import {
  getActiveExperimentSubjectRecord,
  getExperimentImportRecord,
  insertExperimentImportRecord,
  markExperimentImportRecordSuperseded,
  type ExperimentProductOutcome,
  type ExperimentProductRating,
} from "./experiment-import-store.js";

// ─── Wire schema ─────────────────────────────────────────────────────────────────

const identityOriginSchema = z.enum([
  "learning-task-stamp",
  "server-observed",
  "operator-declared",
]) satisfies z.ZodType<IdentityOrigin>;

const identityUnknownReasonSchema = z.enum([
  "not-applicable",
  "not-observed",
  "legacy",
  "producer-error",
  "policy-unavailable",
]) satisfies z.ZodType<IdentityUnknownReason>;

const SHA256_DIGEST = /^(sha256:)?[a-f0-9]{64}$/;

const identityFieldSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("digest"),
      id: z.string().min(1),
      version: z.string().min(1),
      digest: z.string().regex(SHA256_DIGEST, "digest must be sha256:<64 lowercase hex>"),
      origin: identityOriginSchema,
    })
    .strict(),
  z.object({ kind: z.literal("label"), label: z.string().min(1), origin: identityOriginSchema }).strict(),
  z
    .object({
      kind: z.literal("unknown"),
      reason: identityUnknownReasonSchema,
      detail: z.string().min(1).optional(),
    })
    .strict(),
]);

const evidenceLaneWireSchema = z.union([z.enum(TASK_EXPOSURE_LANES), z.literal("unknown")]);

/** Wire shape of the nine-field content-addressed identity bundle (evidence-identity.ts). */
const evidenceIdentityWireSchema = z
  .object({
    modelArtifact: identityFieldSchema,
    configEpoch: identityFieldSchema,
    logicalTask: identityFieldSchema,
    renderedPrompt: identityFieldSchema,
    harness: identityFieldSchema,
    taxonomyVersion: identityFieldSchema,
    verifierRubric: identityFieldSchema,
    sampling: identityFieldSchema,
    toolPolicy: identityFieldSchema,
    lane: evidenceLaneWireSchema,
  })
  .strict();

const verifierIdentitySchema = z
  .object({
    name: z.string().min(1),
    independent: z.boolean(),
    mode: z.enum(["deterministic", "human", "calibrated-judge", "advisory-judge"]),
    calibrationEvidenceId: z.string().min(1).nullish(),
  })
  .strict();

const exposureIdentitySchema = z
  .object({
    contaminationStatus: z.enum(["clean", "contaminated", "coverage-incomplete"]),
  })
  .strict();

const reviewIdentitySchema = z
  .object({
    ratingId: z.string().min(1),
    reviewerId: z.string().min(1),
    independent: z.boolean(),
    productOutcome: z.enum(["accepted", "rejected", "conflicted", "unrated"]),
    reasonDigest: z.string().min(1),
    ratedAt: z.string().min(1),
  })
  .strict();

const outcomeSchema = z.enum(["pass", "partial", "fail", "error", "unverified"]) satisfies z.ZodType<Outcome>;
const errorClassSchema = z.enum([
  "empty",
  "truncated",
  "timeout",
  "parse",
  "infra",
]) satisfies z.ZodType<ErrorClass>;

/**
 * Structural shape only. `evidenceIdentity`/`verifier`/`exposure` are deliberately OPTIONAL here —
 * their outright ABSENCE is the `incomplete` rejection class; their PRESENCE with an unknown/
 * placeholder/uncalibrated value is the `identity-incomplete` / `non-independent-review` classes.
 * Collapsing "missing" and "present-but-bad" into one 400 would make an operator's rejection log
 * unable to tell "Hugin never sent this" from "Hugin sent something inadmissible" — the ticket's AC
 * asks for a SPECIFIC auditable reason per rejection class, so the two stay structurally distinct.
 */
const armOutcomeWireSchema = z
  .object({
    armId: z.string().min(1),
    sampleId: z.string().min(1),
    taskType: z.string().min(1),
    modelId: z.string().min(1),
    nodeId: z.enum(["m5", "orin"]).optional(),
    outcome: outcomeSchema,
    errorClass: errorClassSchema.nullish(),
    score: z.number().nullish(),
    latencyMs: z.number().nullish(),
    prompt: z.string().min(1),
    evidenceIdentity: evidenceIdentityWireSchema.optional(),
    verifier: verifierIdentitySchema.optional(),
    exposure: exposureIdentitySchema.optional(),
    review: reviewIdentitySchema.nullish(),
    policyEpoch: z.string().min(1),
    recordedAt: z.string().min(1),
    expiresAt: z.string().min(1).nullish(),
    supersedesRunId: z.string().min(1).nullish(),
    /** Explicit opt-in required for a `partial` outcome to be admission-eligible — mirrors the
     *  contract's "a partial can be admissible only when the versioned policy epoch explicitly
     *  yields policy-qualified-partial". Absent/false ⇒ a partial is retained (never discarded) but
     *  forced into shadow, same visible-but-routing-inert treatment as a failed experiment. */
    policyQualifiesPartial: z.boolean().optional(),
  })
  .strict();

const experimentOutcomeBundleWireSchema = z
  .object({
    experimentId: z.string().min(1),
    runId: z.string().min(1),
    status: z.enum(["completed", "failed", "inconclusive"]),
    arms: z.array(armOutcomeWireSchema).min(1),
  })
  .strict();

export type HuginExperimentOutcomeBundle = z.infer<typeof experimentOutcomeBundleWireSchema>;
export type HuginExperimentArmOutcome = z.infer<typeof armOutcomeWireSchema>;

export interface ExperimentImportParseFailure {
  ok: false;
  message: string;
  param: string | null;
}

/** Structural parse only (issue #8: this is the HTTP-layer 400 boundary — a per-arm admissibility
 *  failure below is NOT a parse failure and never surfaces here). */
export function parseHuginExperimentOutcomeBundle(
  raw: unknown
): { ok: true; value: HuginExperimentOutcomeBundle } | ExperimentImportParseFailure {
  const parsed = experimentOutcomeBundleWireSchema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    message: issue ? `${issue.path.join(".") || "$"}: ${issue.message}` : "invalid experiment outcome bundle",
    param: issue ? issue.path.join(".") || null : null,
  };
}

// ─── Admissibility ─────────────────────────────────────────────────────────────

export type ExperimentImportRejectionReason =
  | "incomplete"
  | "identity-incomplete"
  | "non-independent-review"
  | "contaminated"
  | "expired"
  | "superseded"
  | "conflicting";

export class ExperimentImportRejectedError extends Error {
  constructor(
    public readonly reason: ExperimentImportRejectionReason,
    message: string
  ) {
    super(message);
    this.name = "ExperimentImportRejectedError";
  }
}

function toIdentityField(w: z.infer<typeof identityFieldSchema>): IdentityField {
  switch (w.kind) {
    case "digest":
      // digestIdentity() re-validates the sha256 shape and normalizes the "sha256:" prefix — the
      // stronger of two checks (schema regex above is the cheap early reject).
      return digestIdentity({ id: w.id, version: w.version, digest: w.digest, origin: w.origin });
    case "label":
      return labelIdentity(w.label, w.origin);
    case "unknown":
      return unknownIdentity(w.reason, w.detail);
  }
}

function toEvidenceIdentityBundle(w: z.infer<typeof evidenceIdentityWireSchema>): EvidenceIdentityBundle {
  return {
    modelArtifact: toIdentityField(w.modelArtifact),
    configEpoch: toIdentityField(w.configEpoch),
    logicalTask: toIdentityField(w.logicalTask),
    renderedPrompt: toIdentityField(w.renderedPrompt),
    harness: toIdentityField(w.harness),
    taxonomyVersion: toIdentityField(w.taxonomyVersion),
    verifierRubric: toIdentityField(w.verifierRubric),
    sampling: toIdentityField(w.sampling),
    toolPolicy: toIdentityField(w.toolPolicy),
    lane: w.lane,
  };
}

/**
 * Independent-verifier admissibility (learning-task-contract.md: "Evidence is admissible only when
 * the verifier is independent and is deterministic, human, or a calibrated judge carrying a
 * calibration evidence id... An advisory judge is always none-shadow."). Folds the calibration-id
 * requirement into the SAME `non-independent-review` reason as a bare non-independent verifier —
 * an uncalibrated judge is exactly as inadmissible as a non-independent one, not a separate class.
 */
function verifierIsAdmissible(v: z.infer<typeof verifierIdentitySchema>): boolean {
  if (!v.independent) return false;
  if (v.mode === "advisory-judge") return false;
  if (v.mode === "calibrated-judge" && !v.calibrationEvidenceId) return false;
  return true;
}

export interface ExperimentImportArmResult {
  armId: string;
  sampleId: string;
  status: "imported" | "idempotent-noop" | "rejected";
  delegationId?: string;
  shadow?: boolean;
  reason?: ExperimentImportRejectionReason;
  detail?: string;
}

export interface ExperimentImportResult {
  experimentId: string;
  runId: string;
  arms: ExperimentImportArmResult[];
}

/** Deterministic content hash over exactly the fields that define "the same observation" — used
 *  for idempotent-resend detection AND conflict detection at one (experiment, run, arm, sample)
 *  natural key. `recordedAt` is intentionally EXCLUDED: a byte-identical resend with a later wall
 *  clock stamp (a delivery retry) must still read as idempotent, not as a conflicting record. */
function armContentHash(bundle: HuginExperimentOutcomeBundle, arm: HuginExperimentArmOutcome): string {
  const { recordedAt: _recordedAt, ...stable } = arm;
  return createHash("sha256")
    .update(jcsCanonicalize({ experimentId: bundle.experimentId, status: bundle.status, ...stable }))
    .digest("hex");
}

function nowMs(now: Date): number {
  return now.getTime();
}

/**
 * Import one arm outcome. Returns the per-arm result (never throws for a business-rule rejection —
 * only a genuinely unexpected internal error propagates). This is the unit the gateway route below
 * calls once per arm in a bundle, so one inadmissible observation cannot block the others in the
 * same POST from being admitted.
 */
function importArm(
  bundle: HuginExperimentOutcomeBundle,
  arm: HuginExperimentArmOutcome,
  now: Date
): ExperimentImportArmResult {
  const base = { armId: arm.armId, sampleId: arm.sampleId };

  // ── incomplete: related-record existence alone (armId/sampleId/outcome/...) is not enough — the
  // three admission-relevant sub-bundles must actually be present. ──
  if (!arm.evidenceIdentity || !arm.verifier || !arm.exposure) {
    const missing = [
      !arm.evidenceIdentity ? "evidenceIdentity" : null,
      !arm.verifier ? "verifier" : null,
      !arm.exposure ? "exposure" : null,
    ]
      .filter((x): x is string => x !== null)
      .join(", ");
    return { ...base, status: "rejected", reason: "incomplete", detail: `missing: ${missing}` };
  }

  // ── identity-incomplete: every one of the nine fields + lane must be KNOWN (not "unknown"), and
  // none may be a placeholder/fictional value — mirrors recordDelegation's write-time fail-closed
  // gate exactly (assertAdmissibleEvidenceIdentity), applied here BEFORE any DB write. ──
  let bundleIdentity: EvidenceIdentityBundle;
  try {
    bundleIdentity = toEvidenceIdentityBundle(arm.evidenceIdentity);
  } catch (err) {
    return {
      ...base,
      status: "rejected",
      reason: "identity-incomplete",
      detail: err instanceof Error ? err.message : "invalid identity field",
    };
  }
  if (evidenceIdentityDisclosure(bundleIdentity) !== "complete") {
    return {
      ...base,
      status: "rejected",
      reason: "identity-incomplete",
      detail: "evidence identity is not fully known (partial or legacy disclosure)",
    };
  }
  try {
    assertAdmissibleEvidenceIdentity(bundleIdentity);
  } catch (err) {
    if (err instanceof PlaceholderEvidenceIdentityError) {
      return { ...base, status: "rejected", reason: "identity-incomplete", detail: err.message };
    }
    throw err;
  }

  // ── non-independent-review: the verifier (and, when present, the human product review) must be
  // independent — self-graded, advisory, or uncalibrated-judge evidence cannot be admitted. ──
  if (!verifierIsAdmissible(arm.verifier)) {
    return {
      ...base,
      status: "rejected",
      reason: "non-independent-review",
      detail: `verifier '${arm.verifier.name}' (mode=${arm.verifier.mode}, independent=${arm.verifier.independent}) is not admissible`,
    };
  }
  if (arm.review && arm.review.independent === false) {
    return {
      ...base,
      status: "rejected",
      reason: "non-independent-review",
      detail: `product review '${arm.review.ratingId}' is not independent`,
    };
  }

  // ── contaminated: exact-hash freshness/coverage must be clean. ──
  if (arm.exposure.contaminationStatus !== "clean") {
    return {
      ...base,
      status: "rejected",
      reason: "contaminated",
      detail: `exposure coverage is '${arm.exposure.contaminationStatus}'`,
    };
  }

  // ── expired ──
  if (arm.expiresAt) {
    const expiresMs = Date.parse(arm.expiresAt);
    if (Number.isNaN(expiresMs) || expiresMs <= nowMs(now)) {
      return { ...base, status: "rejected", reason: "expired", detail: `expiresAt=${arm.expiresAt}` };
    }
  }

  // ── idempotency / correction / staleness / conflict, via the natural-key registry ──
  const subject = { experimentId: bundle.experimentId, armId: arm.armId, sampleId: arm.sampleId };
  const naturalKey = { ...subject, runId: bundle.runId };
  const contentHash = armContentHash(bundle, arm);

  const existingAtThisRun = getExperimentImportRecord(naturalKey);
  if (existingAtThisRun) {
    if (existingAtThisRun.contentHash === contentHash) {
      return { ...base, status: "idempotent-noop", delegationId: existingAtThisRun.delegationId };
    }
    return {
      ...base,
      status: "rejected",
      reason: "conflicting",
      detail: `run '${bundle.runId}' was already imported with different content at this natural key`,
    };
  }

  const active = getActiveExperimentSubjectRecord(subject);
  let supersedesDelegationId: string | null = null;
  let supersedesNaturalKey: (typeof naturalKey) | null = null;
  if (active) {
    if (arm.supersedesRunId) {
      if (arm.supersedesRunId !== active.runId) {
        return {
          ...base,
          status: "rejected",
          reason: "superseded",
          detail: `claims to correct run '${arm.supersedesRunId}' but the active run for this subject is '${active.runId}'`,
        };
      }
      supersedesDelegationId = active.delegationId;
      supersedesNaturalKey = { ...subject, runId: active.runId };
    } else if (Date.parse(arm.recordedAt) <= Date.parse(active.recordedAt)) {
      return {
        ...base,
        status: "rejected",
        reason: "superseded",
        detail: `recordedAt=${arm.recordedAt} is not newer than the already-imported observation (${active.recordedAt}) and does not claim to correct it`,
      };
    }
    // else: a genuinely newer, independent observation of the same subject — admitted alongside.
  }

  // ── admit ──
  // A failed/inconclusive EXPERIMENT retains its arm evidence for audit but must not move routing
  // (AC: "A failed or inconclusive experiment is retained without changing routing"); reuse the
  // existing shadow-lane exclusion (#234) rather than inventing a parallel mechanism. Likewise an
  // unqualified `partial` is retained but shadowed until an explicit policy epoch admits it.
  const shadow =
    bundle.status !== "completed" || (arm.outcome === "partial" && !arm.policyQualifiesPartial);

  const rating: ExperimentProductRating | null = arm.review
    ? {
        ratingId: arm.review.ratingId,
        reviewerId: arm.review.reviewerId,
        productOutcome: arm.review.productOutcome as ExperimentProductOutcome,
        reasonDigest: arm.review.reasonDigest,
        ratedAt: arm.review.ratedAt,
      }
    : null;

  const importable: ImportableDelegation = {
    ts: arm.recordedAt,
    taskType: arm.taskType,
    modelId: arm.modelId,
    nodeId: arm.nodeId ?? "m5",
    prompt: arm.prompt,
    outcome: arm.outcome,
    score: arm.score ?? null,
    latencyMs: arm.latencyMs ?? null,
    verifier: arm.verifier.name,
    errorClass: arm.errorClass ?? null,
    source: "hugin-experiment-import",
    notes: `hugin-experiment:${bundle.experimentId} run:${bundle.runId} arm:${arm.armId} sample:${arm.sampleId}`,
    judgePolicy: arm.policyEpoch,
    shadow,
    evidenceIdentity: bundleIdentity,
  };

  // importDelegations is itself content-hash idempotent on ITS OWN key shape (ts/taskType/model/
  // prompt/outcome/... — see ledger.ts importId()). Our registry above already de-duplicated the
  // (experiment,run,arm,sample) natural key before reaching here, so `inserted === 0` here would
  // mean the same underlying attempt was independently imported through a DIFFERENT path (e.g. a
  // probe battery) under an identical content shape — real evidence, not a bug. Either way, the
  // exact id is deterministic (importId()), so the registry can point at the definitive row
  // regardless of whether this call inserted or deduplicated against a prior one.
  importDelegations([importable]);
  const delegationId = importId(importable);

  if (supersedesNaturalKey && supersedesDelegationId) {
    supersedeDelegationById(supersedesDelegationId, now.toISOString());
    markExperimentImportRecordSuperseded(supersedesNaturalKey, bundle.runId);
  }

  insertExperimentImportRecord({
    experimentId: bundle.experimentId,
    runId: bundle.runId,
    armId: arm.armId,
    sampleId: arm.sampleId,
    contentHash,
    delegationId,
    recordedAt: arm.recordedAt,
    policyEpoch: arm.policyEpoch,
    experimentStatus: bundle.status,
    importedAt: now.toISOString(),
    rating,
  });

  return { ...base, status: "imported", delegationId, shadow };
}

/** Import every arm of one experiment-outcome bundle. Always returns a per-arm disposition — never
 *  throws for a business-rule rejection (see importArm). Callers (the gateway route, tests) inspect
 *  `arms[].status`/`reason` rather than catching. */
export function importHuginExperimentOutcome(
  bundle: HuginExperimentOutcomeBundle,
  now: Date = new Date()
): ExperimentImportResult {
  return {
    experimentId: bundle.experimentId,
    runId: bundle.runId,
    arms: bundle.arms.map((arm) => importArm(bundle, arm, now)),
  };
}

export {
  getActiveExperimentSubjectRecord,
  getExperimentImportRecord,
  getExperimentSubjectHistory,
} from "./experiment-import-store.js";
export type { ExperimentImportRecord, ExperimentProductRating } from "./experiment-import-store.js";
