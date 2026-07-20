/**
 * External exposure-receipt intake (gille#10).
 *
 * Narrow, authenticated admission path for CONTENT-BLIND exposure observations reported by
 * surfaces that complete real work without ever entering gille's own gateway lanes — Codex App,
 * Codex CLI, and Pi. This is gille's half of the pair with Hugin's external task/outcome receipt
 * intake (Magnus-Gille/hugin#237): that side answers "what happened to a task on a surface Hugin
 * never dispatched it to"; this side answers "has this exact logical task already been exposed
 * on surface X", feeding the SAME content-blind freshness oracle (`task-exposure.ts`, #4/#257)
 * gille's own gateway lanes already populate.
 *
 * Authentication is deliberately NOT a new HMAC/keystore scheme (unlike hugin#237, which had no
 * existing per-producer auth system to reuse): gille already has one — a minted owner-tier API
 * key (`keystore.ts`). Every external producer/subscription is provisioned its own minted key;
 * the gateway route handler authenticates it exactly like every other `/admin/*` endpoint
 * (`requireAdmin()` / the same "real minted owner key" check `/admin/task-exposures/lookup`
 * already uses) BEFORE this module ever sees the request, and passes down the authenticated
 * `principal.alias` as the trusted subscription identity — never a body-supplied claim.
 *
 * Admission order, each step fail-closed with a specific reason:
 *
 *  1. Structural + content-blindness validation (`exposureReceiptEnvelopeSchema` — unknown fields
 *     and free-text-shaped tokens are rejected, not stripped).
 *  2. Placeholder/fictional identity rejection, reusing #5's `findPlaceholderIdentityFields` over
 *     whatever identity fields this receipt actually supplies.
 *  3. Idempotent, content-hash-checked mapping into `task-exposure.ts`'s existing registry
 *     mechanism — this module never reimplements that registry, it only decides what to feed it.
 *
 * Non-goals (per gille-inference#10 scope): no raw transcript/prompt/output ingestion; no
 * treatment of two subscription aliases as independent reviewers; no routing/holdout decision is
 * ever made from a receipt alone.
 */

import type { z } from "zod";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { jcsCanonicalize } from "./learning-task-contract.js";
import {
  contentDigest,
  buildEvidenceIdentityBundle,
  findPlaceholderIdentityFields,
  digestIdentity,
  labelIdentity,
  unknownIdentity,
  type IdentityField,
} from "./evidence-identity.js";
import {
  recordTaskExposure,
  recordExternalProducerHeartbeat,
  TASK_EXPOSURE_EXTERNAL_LANE,
} from "./task-exposure.js";
import {
  exposureReceiptEnvelopeSchema,
  EXPOSURE_RECEIPT_LATE_THRESHOLD_MS,
  type ExposureReceiptEnvelope,
  type ExposureReceiptCoverageState,
  type IdentityFieldWire,
} from "./exposure-receipt-schema.js";

export const EXPOSURE_RECEIPT_REJECTION_REASONS = [
  "incomplete-envelope",
  "non-content-blind",
  "unsupported-schema-version",
  "unsupported-contract-version",
  "unsupported-fingerprint-version",
  "placeholder-identity",
  "receipt-id-reused-with-different-content",
] as const;
export type ExposureReceiptRejectionReason = (typeof EXPOSURE_RECEIPT_REJECTION_REASONS)[number];

export interface ExposureReceiptRejection {
  status: "rejected";
  reason: ExposureReceiptRejectionReason;
  detail: string;
}

export interface ExposureReceiptAdmission {
  status: "admitted";
  /** "created" the first time this receipt enters the store; "exact-existing" when this is a
   *  genuine redelivery of the exact same receipt (idempotent no-op). */
  admission: "created" | "exact-existing";
  surface: string;
  subscriptionAlias: string;
  coverage: ExposureReceiptCoverageState;
  canonicalFingerprintSha256: string;
}

export type ExposureReceiptIntakeResult = ExposureReceiptAdmission | ExposureReceiptRejection;

function rejected(reason: ExposureReceiptRejectionReason, detail: string): ExposureReceiptRejection {
  return { status: "rejected", reason, detail };
}

/**
 * Classify a failed `exposureReceiptEnvelopeSchema` parse into one of intake's specific,
 * auditable rejection reasons rather than one generic "invalid" bucket (mirrors hugin#237's
 * `classifyEnvelopeParseError` exactly) — so a caller/test can tell "incomplete" apart from "you
 * tried to sneak free text into an identity field" apart from "unsupported version".
 */
function classifyEnvelopeParseError(error: z.ZodError): ExposureReceiptRejection {
  const issues = error.issues;

  const unrecognized = issues.find((issue) => issue.code === "unrecognized_keys");
  if (unrecognized) {
    const keys = (unrecognized as { keys?: string[] }).keys ?? [];
    return rejected(
      "non-content-blind",
      `unexpected field(s) not permitted by the content-blind receipt envelope: ${keys.join(", ") || "(unknown)"}`,
    );
  }

  const schemaVersionIssue = issues.find((issue) => issue.path.length === 1 && issue.path[0] === "schemaVersion");
  if (schemaVersionIssue) return rejected("unsupported-schema-version", schemaVersionIssue.message);

  const contractVersionIssue = issues.find((issue) => issue.path.length === 1 && issue.path[0] === "contractVersion");
  if (contractVersionIssue) return rejected("unsupported-contract-version", contractVersionIssue.message);

  const fingerprintVersionIssue = issues.find((issue) => issue.path.length === 1 && issue.path[0] === "fingerprintVersion");
  if (fingerprintVersionIssue) return rejected("unsupported-fingerprint-version", fingerprintVersionIssue.message);

  const tokenViolation = issues.find((issue) => issue.code === "invalid_string");
  if (tokenViolation) {
    return rejected(
      "non-content-blind",
      `field "${tokenViolation.path.join(".")}" is not a short opaque token — looks like free text rather than identity metadata: ${tokenViolation.message}`,
    );
  }

  const detail = issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
    .slice(0, 500);
  return rejected("incomplete-envelope", detail || "receipt envelope failed validation");
}

/** Map the receipt's wire IdentityField shape into evidence-identity.ts's real IdentityField
 *  (#5) — reusing its own constructors so the same sha256/placeholder validation applies. */
function toIdentityField(wire: IdentityFieldWire): IdentityField {
  switch (wire.kind) {
    case "digest":
      return digestIdentity({ id: wire.id, version: wire.version, digest: wire.digest, origin: "operator-declared" });
    case "label":
      return labelIdentity(wire.label, "operator-declared");
    case "unknown":
      return unknownIdentity(wire.reason, wire.detail);
  }
}

/** A plain string label for `task-exposure.ts`'s existing `harnessId`/`modelId` columns, derived
 *  honestly from whichever identity kind the receipt actually supplied. */
function identityFieldToLabel(field: IdentityField): string | null {
  switch (field.kind) {
    case "digest":
      return `${field.id}@${field.version}`;
    case "label":
      return field.label;
    case "unknown":
      return null;
  }
}

function receiptKeyOf(surface: string, subscriptionAlias: string, receiptId: string): string {
  return `${surface}:${subscriptionAlias}:${receiptId}`;
}

/** Everything about the receipt that must be IDENTICAL across a genuine redelivery — excludes
 *  nothing server-stamped (this module stamps no field onto the caller's own envelope; the
 *  content hash is simply over the full validated envelope). */
function receiptContentHash(receipt: ExposureReceiptEnvelope): string {
  return contentDigest(jcsCanonicalize(receipt));
}

let _receiptStoreInitDb: Database.Database | null = null;

function ensureExposureReceiptSchema(db: Database.Database): void {
  if (_receiptStoreInitDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_exposure_receipts (
      receipt_key                  TEXT PRIMARY KEY,
      surface                      TEXT NOT NULL,
      subscription_alias           TEXT NOT NULL,
      receipt_id                   TEXT NOT NULL,
      content_hash                 TEXT NOT NULL,
      received_at                  TEXT NOT NULL,
      coverage_state               TEXT NOT NULL,
      canonical_fingerprint_sha256 TEXT NOT NULL,
      provider                     TEXT NOT NULL,
      requested_model              TEXT NOT NULL,
      effective_model              TEXT,
      occurred_at                  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_external_exposure_receipts_surface
      ON external_exposure_receipts(surface, subscription_alias);
  `);
  _receiptStoreInitDb = db;
}

export interface ExposureReceiptIntakeDeps {
  db?: Database.Database;
  now?: () => string;
}

/**
 * Admit one external exposure receipt, or reject it with a specific auditable reason.
 * Content-blind throughout: nothing this function reads, writes, or logs is ever raw task
 * content — the receipt itself structurally cannot carry any (see exposure-receipt-schema.ts).
 *
 * `subscriptionAlias` MUST be the caller's own already-authenticated gille principal alias
 * (`principal.alias` from the gateway's requireAdmin()-equivalent check) — never taken from the
 * request body, so a receipt can never impersonate a different subscription's identity.
 */
export function ingestExposureReceipt(
  rawEnvelope: unknown,
  subscriptionAlias: string,
  deps: ExposureReceiptIntakeDeps = {},
): ExposureReceiptIntakeResult {
  const db = deps.db ?? getDb();
  const now = deps.now ?? (() => new Date().toISOString());

  const parsed = exposureReceiptEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) return classifyEnvelopeParseError(parsed.error);
  const receipt: ExposureReceiptEnvelope = parsed.data;

  // Placeholder/fictional identity rejection (#5 reuse): only the fields this receipt actually
  // asserts are checked; every other bundle field defaults to an honest "unknown" (which never
  // trips the placeholder check) via buildEvidenceIdentityBundle.
  const bundle = buildEvidenceIdentityBundle({
    modelArtifact: receipt.effectiveModel.status === "known"
      ? labelIdentity(receipt.effectiveModel.modelId, "operator-declared")
      : undefined,
    configEpoch: toIdentityField(receipt.modelConfigEpoch),
    harness: toIdentityField(receipt.harness),
    toolPolicy: toIdentityField(receipt.toolPolicyDigest),
  });
  const placeholders = findPlaceholderIdentityFields(bundle);
  if (placeholders.length > 0) {
    return rejected(
      "placeholder-identity",
      `placeholder/fictional identity value(s) in: ${placeholders.join(", ")} — inadmissible for production exposure evidence`,
    );
  }

  ensureExposureReceiptSchema(db);
  const receiptKey = receiptKeyOf(receipt.surface, subscriptionAlias, receipt.receiptId);
  const contentHash = receiptContentHash(receipt);
  const receivedAt = now();

  // The dedup check-then-act (SELECT existing → INSERT-if-absent, plus the downstream
  // recordTaskExposure/recordExternalProducerHeartbeat writes) is wrapped in ONE transaction —
  // defense in depth against a genuinely concurrent duplicate submission landing between the read
  // and the write. better-sqlite3 is synchronous with no `await` in this function body, so within
  // gille's actual single-process deployment no interleaving is possible today regardless; this
  // matches the same discipline `rotateCoverageEpoch` already uses ("a concurrent writer on
  // another gateway process cannot land a row between the read and the write").
  return db.transaction((): ExposureReceiptIntakeResult => {
    const existing = db.prepare(
      `SELECT content_hash, coverage_state FROM external_exposure_receipts WHERE receipt_key = ?`
    ).get(receiptKey) as { content_hash: string; coverage_state: ExposureReceiptCoverageState } | undefined;

    if (existing) {
      if (existing.content_hash !== contentHash) {
        return rejected(
          "receipt-id-reused-with-different-content",
          `receiptId "${receipt.receiptId}" was already ingested with different content for surface "${receipt.surface}"/subscription "${subscriptionAlias}" — use a fresh receiptId for a genuinely new observation`,
        );
      }
      // Exact replay: still a genuine liveness signal — refresh the heartbeat, no new registry row.
      recordExternalProducerHeartbeat({ surface: receipt.surface, principalAlias: subscriptionAlias, ts: receivedAt }, db);
      return {
        status: "admitted",
        admission: "exact-existing",
        surface: receipt.surface,
        subscriptionAlias,
        coverage: existing.coverage_state,
        canonicalFingerprintSha256: receipt.canonicalFingerprintSha256,
      };
    }

    const lateMs = Date.parse(receivedAt) - Date.parse(receipt.occurredAt);
    const coverage: ExposureReceiptCoverageState = lateMs > EXPOSURE_RECEIPT_LATE_THRESHOLD_MS ? "imported-late" : "imported";
    const effectiveModelId = receipt.effectiveModel.status === "known" ? receipt.effectiveModel.modelId : null;

    db.prepare(
      `INSERT INTO external_exposure_receipts
         (receipt_key, surface, subscription_alias, receipt_id, content_hash, received_at, coverage_state,
          canonical_fingerprint_sha256, provider, requested_model, effective_model, occurred_at)
       VALUES
         (@receiptKey, @surface, @subscriptionAlias, @receiptId, @contentHash, @receivedAt, @coverage,
          @canonicalFingerprintSha256, @provider, @requestedModel, @effectiveModel, @occurredAt)`
    ).run({
      receiptKey,
      surface: receipt.surface,
      subscriptionAlias,
      receiptId: receipt.receiptId,
      contentHash,
      receivedAt,
      coverage,
      canonicalFingerprintSha256: receipt.canonicalFingerprintSha256,
      provider: receipt.provider,
      requestedModel: receipt.requestedModel,
      effectiveModel: effectiveModelId,
      occurredAt: receipt.occurredAt,
    });

    // Feed the SAME content-blind exposure registry (#4/#257) gille's own gateway lanes already
    // populate — this is what makes a Codex-App-then-Hugin lookup return `seen` (gille#10 AC1).
    // No raw task text ever flows through this call: only the producer's own pre-computed
    // canonical digest, exactly like #4's canonical-raw identity for a stamped Hugin request.
    recordTaskExposure({
      lane: TASK_EXPOSURE_EXTERNAL_LANE,
      canonicalFingerprintSha256: receipt.canonicalFingerprintSha256,
      modelId: effectiveModelId,
      harnessId: identityFieldToLabel(toIdentityField(receipt.harness)),
      externalSurface: receipt.surface,
      eventKey: `external-exposure:${receiptKey}`,
      ts: receipt.occurredAt,
    }, db);

    recordExternalProducerHeartbeat({ surface: receipt.surface, principalAlias: subscriptionAlias, ts: receivedAt }, db);

    return {
      status: "admitted",
      admission: "created",
      surface: receipt.surface,
      subscriptionAlias,
      coverage,
      canonicalFingerprintSha256: receipt.canonicalFingerprintSha256,
    };
  })();
}
