/**
 * Content-addressed capability-evidence identity (issue #5).
 *
 * Problem this closes: the capability ledger (ledger.ts) keys evidence by (task_type, model_id)
 * — and nothing else. A rebuilt or differently-configured model sharing that same model_id
 * silently inherits evidence earned by another implementation: a different quantization, a
 * different prompt/harness/tool-policy version, a different sampling profile, or a different lane
 * (direct chat vs. a Hugin-delegated task) can all produce a verdict that looks identical to, and
 * gets merged with, evidence from something else entirely.
 *
 * This module defines the IDENTITY half of the fix: a typed bundle of content-addressed fields
 * (model artifact/build/quantization, serving-configuration epoch, logical task bytes, rendered
 * prompt bytes, harness, taxonomy version, verifier/rubric, sampling, tool policy, lane) plus the
 * rules for turning a bundle into a stable content hash, for distinguishing a MECHANICALLY VERIFIED
 * identity (bound to a real digest of real bytes) from a bare symbolic LABEL, and for rejecting
 * placeholder/fictional values outright. ledger.ts wires this into the `delegations` table and
 * evidence-identity-store.ts provides the content-addressed reconstruction store.
 *
 * Deliberately pure: no DB, no fs, no network — same purity discipline as routing-table-generator.ts
 * and the *-contract.ts modules, so this is unit-testable without touching SQLite.
 *
 * Design note on "verified vs. label": the normative provenance contract
 * (grimnir docs/learning-task-contract.md, read for this issue) binds prompt/harness/tool-policy
 * identity to typed source-document digests carried on the Hugin request stamp. Where a caller has
 * that digest (see `evidenceIdentityFromAdmittedStamp`), the field is `kind: "digest"` — mechanically
 * bound, not merely asserted. Where only a symbolic name is available (e.g. the task taxonomy's
 * pinned id+version, which the stamp does not accompany with its own hashed source document), the
 * field is honestly `kind: "label"`. Where nothing is known at all, it is `kind: "unknown"` with an
 * explicit reason — never a fabricated value standing in for missing data.
 */

import { createHash } from "node:crypto";
import { jcsCanonicalize } from "./learning-task-contract.js";
import type { HuginRequestStamp } from "./learning-task-contract.js";
import { TASK_EXPOSURE_LANES, type TaskExposureLane } from "./task-exposure.js";

export { TASK_EXPOSURE_LANES };
/** The canonical lane vocabulary already established by task-exposure.ts (#4/#257) — reused here
 *  rather than reinvented, so an evidence identity's lane and an exposure event's lane agree. */
export type EvidenceLane = TaskExposureLane;

// ─── Identity fields ────────────────────────────────────────────────────────────

/** Where an identity field's value came from — provenance of the provenance. */
export type IdentityOrigin =
  /** Mechanically read off an admitted LearningTaskContract Hugin request stamp. */
  | "learning-task-stamp"
  /** Computed by this process from genuinely observed local server state (e.g. llama-swap's
   *  `/running` cmd string) — not asserted, not guessed. */
  | "server-observed"
  /** Supplied directly by the calling code path with no independent source document to hash
   *  against (e.g. a curated model-registry role name) — always a LABEL, never a digest. */
  | "operator-declared";

export type IdentityUnknownReason =
  | "not-applicable"
  | "not-observed"
  | "legacy"
  | "producer-error"
  | "policy-unavailable";

/** A mechanically verified identity: a real sha256 digest of real, genuinely observed bytes. */
export interface DigestIdentity {
  readonly kind: "digest";
  readonly id: string;
  readonly version: string;
  /** "sha256:<64 lowercase hex>". */
  readonly digest: string;
  readonly origin: IdentityOrigin;
}

/** A symbolic name with no independently hashed source document backing it. Real, but weaker
 *  than a digest — never treated as equivalent to one by any admission or comparison logic. */
export interface LabelIdentity {
  readonly kind: "label";
  readonly label: string;
  readonly origin: IdentityOrigin;
}

/** Explicit, qualified absence — never bare `null`. Mirrors the contract's unknown-marker shape. */
export interface UnknownIdentity {
  readonly kind: "unknown";
  readonly reason: IdentityUnknownReason;
  readonly detail?: string;
}

export type IdentityField = DigestIdentity | LabelIdentity | UnknownIdentity;

export function unknownIdentity(reason: IdentityUnknownReason, detail?: string): UnknownIdentity {
  return detail === undefined ? { kind: "unknown", reason } : { kind: "unknown", reason, detail };
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

/** Content digest of a UTF-8 string this process genuinely hashed itself. */
export function contentDigest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function normalizeDigest(digest: string): string {
  return digest.startsWith("sha256:") ? digest : `sha256:${digest}`;
}

export function digestIdentity(p: {
  id: string;
  version: string;
  digest: string;
  origin: IdentityOrigin;
}): DigestIdentity {
  const digest = normalizeDigest(p.digest);
  const hex = digest.slice("sha256:".length);
  if (!SHA256_HEX.test(hex)) {
    throw new Error(
      `evidence-identity: digest must be sha256:<64 lowercase hex>, got ${JSON.stringify(p.digest)}`
    );
  }
  return { kind: "digest", id: p.id, version: p.version, digest, origin: p.origin };
}

export function labelIdentity(label: string, origin: IdentityOrigin): LabelIdentity {
  return { kind: "label", label, origin };
}

// ─── The bundle ─────────────────────────────────────────────────────────────────

/**
 * The full content-addressed identity of one piece of capability evidence. Every field is
 * present (never omitted) — a genuinely unknown field is `{ kind: "unknown", reason: ... }`, so
 * `evidenceIdentityHash` below is total and a missing field can never silently widen a bucket.
 */
export interface EvidenceIdentityBundle {
  /** Model build/quantization — e.g. derived from the served gguf path (evidenceIdentityFromServedModelCmd). */
  readonly modelArtifact: IdentityField;
  /** Serving-configuration epoch — context size, sampling defaults, every runtime flag in force. */
  readonly configEpoch: IdentityField;
  /** Logical task bytes identity (Hugin's pre-orchestration raw input, or the direct accepted turn). */
  readonly logicalTask: IdentityField;
  /** Rendered gateway/runtime prompt bytes identity (after context/system wrapping). */
  readonly renderedPrompt: IdentityField;
  /** Harness identity (id/version/digest) that produced this attempt. */
  readonly harness: IdentityField;
  /** Task-taxonomy id+version this row was classified under. */
  readonly taxonomyVersion: IdentityField;
  /** Verifier/rubric identity — distinct from (and more structured than) DelegationRecord.verifier. */
  readonly verifierRubric: IdentityField;
  /** Sampling-parameter identity (temperature/top_p/... after defaults and clamps). */
  readonly sampling: IdentityField;
  /** Tool-policy identity in force for this attempt. */
  readonly toolPolicy: IdentityField;
  /** Direct-chat vs. delegate vs. code-loop vs. ... — see EvidenceLane. `"unknown"` is honest
   *  absence, distinct from every real lane, and — like every other field — participates in the
   *  identity hash, so an unknown-lane row never silently merges with a known-lane one. */
  readonly lane: EvidenceLane | "unknown";
}

const IDENTITY_FIELD_NAMES = [
  "modelArtifact",
  "configEpoch",
  "logicalTask",
  "renderedPrompt",
  "harness",
  "taxonomyVersion",
  "verifierRubric",
  "sampling",
  "toolPolicy",
] as const satisfies readonly (keyof Omit<EvidenceIdentityBundle, "lane">)[];

/**
 * Construct a full bundle from whatever is known, defaulting every unspecified field to an honest
 * `unknown("not-observed")` rather than omitting it. Ergonomic entry point for a future call site
 * that only has some of the nine fields available (e.g. only what the admitted stamp supplies).
 */
export function buildEvidenceIdentityBundle(p: Partial<EvidenceIdentityBundle>): EvidenceIdentityBundle {
  return {
    modelArtifact: p.modelArtifact ?? unknownIdentity("not-observed"),
    configEpoch: p.configEpoch ?? unknownIdentity("not-observed"),
    logicalTask: p.logicalTask ?? unknownIdentity("not-observed"),
    renderedPrompt: p.renderedPrompt ?? unknownIdentity("not-observed"),
    harness: p.harness ?? unknownIdentity("not-observed"),
    taxonomyVersion: p.taxonomyVersion ?? unknownIdentity("not-observed"),
    verifierRubric: p.verifierRubric ?? unknownIdentity("not-observed"),
    sampling: p.sampling ?? unknownIdentity("not-observed"),
    toolPolicy: p.toolPolicy ?? unknownIdentity("not-observed"),
    lane: p.lane ?? "unknown",
  };
}

/**
 * The bucket key: a stable sha256 content hash over the JCS-canonicalized bundle (reusing the
 * same canonicalizer the LearningTaskContract digests use, for one dependency-free deterministic
 * implementation repo-wide). Two bundles that differ in ANY field — including `lane` — hash
 * differently. This is what makes "a changed identity yields a NEW evidence bucket rather than
 * inheriting the old verdict" mechanical rather than a policy an aggregator has to remember.
 */
export function evidenceIdentityHash(bundle: EvidenceIdentityBundle): string {
  return contentDigest(jcsCanonicalize(bundle));
}

export type EvidenceIdentityDisclosure = "complete" | "partial" | "legacy";

/**
 * `"legacy"` — no bundle at all (the pre-#5 population, and any future call site that still omits
 * one). `"partial"` — a bundle exists but at least one field (or the lane) is `unknown`.
 * `"complete"` — every field AND the lane are known. Never upgraded except by the bundle itself
 * changing, so a caller cannot accidentally promote incomplete evidence by re-reading it.
 */
export function evidenceIdentityDisclosure(bundle: EvidenceIdentityBundle | null): EvidenceIdentityDisclosure {
  if (bundle === null) return "legacy";
  const allFieldsKnown = IDENTITY_FIELD_NAMES.every((name) => bundle[name].kind !== "unknown");
  return allFieldsKnown && bundle.lane !== "unknown" ? "complete" : "partial";
}

// ─── Placeholder / fictional identity rejection ──────────────────────────────────

/**
 * Reserved tokens that name a placeholder or fictional artifact rather than a real served one.
 * `fixture-model-v1` is the exact synthetic identity the normative provenance contract's own
 * fixtures use (grimnir docs/learning-task-contract.md: "conspicuously fixture_only ... synthetic
 * fixture-model-v1 identities") — admissible in a fixture file, never in production evidence.
 */
const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([
  "fixture-model-v1",
  "fixture_only",
  "fixture-model",
  "fixture",
  "placeholder",
  "placeholder-model",
  "unknown-model",
  "fake-model",
  "synthetic-model",
  "test-model",
  "todo",
  "tbd",
  "n/a",
  "example",
  "example-model",
]);

function isPlaceholderDigestHex(hex: string): boolean {
  // A real sha256 output is never a single repeated character across all 64 hex digits.
  return new Set(hex).size === 1;
}

function isPlaceholderToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return false;
  if (PLACEHOLDER_TOKENS.has(normalized)) return true;
  const asHex = normalized.startsWith("sha256:") ? normalized.slice("sha256:".length) : normalized;
  if (SHA256_HEX.test(asHex) && isPlaceholderDigestHex(asHex)) return true;
  return false;
}

function placeholderStringsOf(field: IdentityField): string[] {
  switch (field.kind) {
    case "digest":
      return [field.id, field.version, field.digest];
    case "label":
      return [field.label];
    case "unknown":
      return [];
  }
}

/** Every identity-field name (of the nine) whose value looks like a placeholder/fictional artifact. */
export function findPlaceholderIdentityFields(bundle: EvidenceIdentityBundle): string[] {
  const offending: string[] = [];
  for (const name of IDENTITY_FIELD_NAMES) {
    if (placeholderStringsOf(bundle[name]).some(isPlaceholderToken)) offending.push(name);
  }
  return offending;
}

export class PlaceholderEvidenceIdentityError extends Error {
  constructor(public readonly fields: string[]) {
    super(
      `evidence identity contains placeholder/fictional value(s) in: ${fields.join(", ")} — inadmissible for production capability evidence`
    );
    this.name = "PlaceholderEvidenceIdentityError";
  }
}

/** Fail-closed gate: throws PlaceholderEvidenceIdentityError if any field is a placeholder. This
 *  is the STRONGER of the two admissibility points (write-time rejection prevents the row from
 *  ever existing, vs. read-time exclusion which must remember to filter every reader forever) —
 *  ledger.ts calls this from recordDelegation/importDelegations before a row is ever persisted. */
export function assertAdmissibleEvidenceIdentity(bundle: EvidenceIdentityBundle): void {
  const offending = findPlaceholderIdentityFields(bundle);
  if (offending.length > 0) throw new PlaceholderEvidenceIdentityError(offending);
}

// ─── Deriving fields from sources that already computed them ────────────────────

interface SourceDocumentDigestLike {
  source_ref: string;
  source_version: string;
  digest: string;
}

function identityFromSourceDigest(doc: SourceDocumentDigestLike | undefined): IdentityField {
  if (!doc) return unknownIdentity("not-observed");
  return digestIdentity({
    id: doc.source_ref,
    version: doc.source_version,
    digest: doc.digest,
    origin: "learning-task-stamp",
  });
}

interface VersionedConfigIdentityLike {
  id: string;
  version: string;
  config_digest: { digest: string };
}

function identityFromVersionedConfig(cfg: VersionedConfigIdentityLike | undefined): IdentityField {
  if (!cfg) return unknownIdentity("not-observed");
  return digestIdentity({
    id: cfg.id,
    version: cfg.version,
    digest: cfg.config_digest.digest,
    origin: "learning-task-stamp",
  });
}

/**
 * Pure mapping from an already-validated, admitted Hugin request stamp
 * (learning-task-contract.ts's `validateHuginRequestStamp` output) to the identity fields it
 * genuinely carries. This CONSUMES what the stamp already computed and mechanically hashed — it
 * does not open a file, re-render a prompt, or otherwise re-derive an identity the stamp itself is
 * the source of truth for. `taxonomyVersion` is deliberately a LABEL, not a digest: the stamp pins
 * a taxonomy id+version literal but is not accompanied by an independently hashed taxonomy source
 * document, so binding it to a digest would fabricate provenance that does not exist yet.
 */
export function evidenceIdentityFromAdmittedStamp(
  stamp: HuginRequestStamp
): Pick<EvidenceIdentityBundle, "logicalTask" | "renderedPrompt" | "harness" | "toolPolicy" | "taxonomyVersion"> {
  return {
    logicalTask: identityFromSourceDigest(stamp.raw_input),
    renderedPrompt: identityFromSourceDigest(stamp.hugin_envelope),
    harness: identityFromVersionedConfig(stamp.origin_config.harness),
    toolPolicy: identityFromVersionedConfig(stamp.origin_config.tool_policy),
    taxonomyVersion: labelIdentity(
      `${stamp.task_type.taxonomy_id}@${stamp.task_type.taxonomy_version}`,
      "learning-task-stamp"
    ),
  };
}

const MODEL_PATH_FLAG = /(?:^|\s)(?:-m|--model)\s+(\S+)/;

/**
 * Derive model-artifact and configuration-epoch identity from a llama-swap `/running` entry's
 * `cmd` string (see llamaswap-admin.ts) — the exact invocation currently serving a model. This is
 * genuinely observed local server state, not a fabricated value: absent/empty input yields an
 * honest `unknown("not-observed")`, never a guessed model name or a zeroed digest.
 *
 * `modelArtifact` hashes just the `-m`/`--model` path (the gguf file identity — its filename
 * conventionally encodes build and quantization, e.g. `...-Q4_K_M.gguf`). `configEpoch` hashes the
 * FULL command line: any additional runtime flag (context size, parallelism, sampling defaults
 * passed at the process level) changes the epoch even when the model path is identical.
 */
export function evidenceIdentityFromServedModelCmd(
  cmd: string | null | undefined
): Pick<EvidenceIdentityBundle, "modelArtifact" | "configEpoch"> {
  const trimmed = cmd?.trim() ?? "";
  if (trimmed.length === 0) {
    const reason = unknownIdentity("not-observed", "no llama-swap /running cmd observed for this model");
    return { modelArtifact: reason, configEpoch: reason };
  }
  const pathMatch = MODEL_PATH_FLAG.exec(trimmed);
  const modelPath = pathMatch?.[1] ?? null;
  return {
    modelArtifact: modelPath
      ? digestIdentity({ id: modelPath, version: modelPath, digest: contentDigest(modelPath), origin: "server-observed" })
      : unknownIdentity("not-observed", "llama-swap cmd carried no -m/--model flag"),
    configEpoch: digestIdentity({
      id: "llama-swap-cmd",
      version: "observed",
      digest: contentDigest(trimmed),
      origin: "server-observed",
    }),
  };
}
