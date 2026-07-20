/**
 * Machine-readable harvest-store inventory (issue #9, scope item 1).
 *
 * grimnir's data-lifecycle policy (`docs/data-lifecycle.md`, adopted 2026-07-10, authored under
 * grimnir#66) is the authoritative source for the retention DEFAULTS below — this module is the
 * gille-inference-owned implementation of the "M5 capability ledger" row of that store map:
 *
 *   "Verdict and routing evidence use the operational-telemetry default. Payload-derived fixtures
 *    use the transient default unless explicitly promoted as an eval asset."
 *   "Target: six-month evidence and 30-day payload-fixture expiry while retaining only the
 *    minimum aggregate routing evidence."
 *
 * This file is the STORE MAP: what exists, what class of data class it is, whether it carries
 * actual prompt/response bytes ("content-bearing") or only opaque ids/digests/counts
 * ("content-blind"), and which column(s) retention enforcement acts on. `retention-enforcement.ts`
 * and `retention-prune-gate.ts` consume this list; they never hard-code a table name themselves.
 *
 * Deliberately pure data + types — no DB, no fs — same purity discipline as the other *-contract.ts
 * / *-policy.ts modules in this directory, so the inventory itself is trivially unit-testable and
 * reviewable independent of any store's live schema.
 */

// ─── Retention data classes (grimnir docs/data-lifecycle.md "Default classes") ────────────────────

/** Approximates "6 months" as a fixed day count for deterministic cutoff arithmetic. */
const SIX_MONTHS_DAYS = 183;
/** grimnir docs/data-lifecycle.md "Transient task artifacts: 30 days after task completion". */
const THIRTY_DAYS = 30;

export const RETENTION_DATA_CLASSES = {
  /** "Operational telemetry ... 6 months from collection" — verdict/routing evidence rows. */
  "operational-telemetry": {
    retentionDays: SIX_MONTHS_DAYS,
    source: "grimnir docs/data-lifecycle.md — Default classes: Operational telemetry",
  },
  /** "Transient task artifacts ... 30 days after task completion" — payload-derived fixtures and
   *  disposable per-run workspace state, unless explicitly promoted into a durable owned store. */
  "transient-task-artifact": {
    retentionDays: THIRTY_DAYS,
    source: "grimnir docs/data-lifecycle.md — Default classes: Transient task artifacts",
  },
} as const;
export type HarvestDataClass = keyof typeof RETENTION_DATA_CLASSES;

// ─── Store descriptor ──────────────────────────────────────────────────────────────────────────

export type HarvestStoreClassification = "content-bearing" | "content-blind";
export type HarvestStoreMechanism = "sqlite" | "filesystem";
export type HarvestPruneAction =
  /** DELETE the whole row once its own timestamp column has expired. */
  | "delete-row"
  /** UPDATE the listed content column(s) to NULL once expired — the row (now content-blind)
   *  persists under its own, separately-registered, longer content-blind window. */
  | "redact-content"
  /** Remove an expired file from a filesystem-backed store (never inspects its bytes to decide). */
  | "delete-file"
  /** Documented but not pruned by this job — a durable evidence/counter chain (see `prunable`). */
  | "none";

export interface HarvestStoreDescriptor {
  /** Stable identifier used across the registry, dry-run reports, and approval tokens. Multiple
   *  descriptors MAY reference the same physical table (e.g. a table's row-level window and one of
   *  its content columns' shorter window are two separate, independently prunable descriptors). */
  readonly storeId: string;
  readonly mechanism: HarvestStoreMechanism;
  /** SQLite table name; required when mechanism === "sqlite". */
  readonly table: string | null;
  readonly classification: HarvestStoreClassification;
  readonly dataClass: HarvestDataClass;
  /** Resolved from `dataClass` — kept as an explicit field so a descriptor can be inspected without
   *  re-deriving it, and so a test can assert the two never drift apart (see the registry test). */
  readonly retentionDays: number;
  /** False for a durable evidence/counter/tombstone chain this job must never delete (issue #3's
   *  gille_accounting_events/partitions): erasure there is via `writeErasureAdjustment`, never a
   *  DELETE, because the counters and their original occurrence-period membership must survive. */
  readonly prunable: boolean;
  readonly pruneAction: HarvestPruneAction;
  /** Column (sqlite) counted/compared against the retention cutoff; null for a store with no
   *  enforceable timestamp today (documented as a target, not enforced — mirrors grimnir's own
   *  Current/Target store-map convention). */
  readonly timestampColumn: string | null;
  readonly timestampKind: "iso" | "epoch-ms" | null;
  readonly primaryKeyColumn: string | null;
  /** Columns holding actual prompt/response/content bytes. Empty for a content-blind store. Never
   *  read by the dry-run reporter — only their COUNT and the row's primary key are ever reported. */
  readonly contentColumns: readonly string[];
  /**
   * The value a `redact-content` action writes into every `contentColumns` entry, and the value a
   * "still pending redaction" scan excludes. `null` for a nullable column (SQL `NULL`, matched with
   * `IS NOT NULL` / `IS NULL`); `""` for a `NOT NULL` column (owner_request_log's schema predates
   * this feature and has no nullable content columns), matched with `!= ''` / `= ''`. Never a value
   * that could be confused with real content — an empty string is exactly as content-blind as NULL
   * for reporting purposes (the dry-run report never inspects this column's value either way).
   */
  readonly redactedContentValue: null | "";
  readonly ownerSource: "gille-inference";
  readonly sensitivity: "low" | "medium" | "high";
  /** The policy epoch this descriptor's window was adopted under — bumped when the window itself
   *  (not the implementation) changes, so a report can disclose which policy produced it. */
  readonly policyEpoch: string;
  readonly purpose: string;
}

const POLICY_EPOCH_2026_07_20 = "2026-07-20-data-lifecycle-v1";

function retentionDaysFor(dataClass: HarvestDataClass): number {
  return RETENTION_DATA_CLASSES[dataClass].retentionDays;
}

// ─── The inventory itself ──────────────────────────────────────────────────────────────────────

export const HARVEST_STORE_REGISTRY: readonly HarvestStoreDescriptor[] = [
  // ── request-log.ts — request_log: durable, content-blind, pseudonymous fleet telemetry. There is
  //    no column for prompt/response/messages; requestLogColumns() enforces this by construction.
  {
    storeId: "request-log",
    mechanism: "sqlite",
    table: "request_log",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "ts",
    timestampKind: "epoch-ms",
    primaryKeyColumn: "id",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Content-blind, pseudonymous-by-alias fleet telemetry (distinct users, throughput, outcome " +
      "breakdown) for every principal including the owner. Basis: operational-telemetry.",
  },

  // ── owner-log.ts — owner_request_log: the FULL prompt/response for authenticated owner keys
  //    only. Content-bearing by design; never written for a guest.
  {
    storeId: "owner-request-log",
    mechanism: "sqlite",
    table: "owner_request_log",
    classification: "content-bearing",
    dataClass: "transient-task-artifact",
    retentionDays: retentionDaysFor("transient-task-artifact"),
    prunable: true,
    pruneAction: "redact-content",
    timestampColumn: "ts",
    timestampKind: "iso",
    primaryKeyColumn: "id",
    contentColumns: ["messages_json", "completion"],
    // Both columns are NOT NULL in owner-log.ts's schema — redact to an empty string, never NULL.
    redactedContentValue: "",
    ownerSource: "gille-inference",
    sensitivity: "high",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "The owner's own full request/response content, for the owner's own later analysis. No " +
      "documented data-lifecycle row names this store explicitly; it is treated conservatively as " +
      "payload-derived (transient-task-artifact, 30 days) — the SHORTEST applicable default — " +
      "rather than assuming an unstated longer retention. An owner may promote a specific " +
      "conversation out of this window by copying it into a durable owned store before it expires.",
  },
  {
    storeId: "owner-request-log-row",
    mechanism: "sqlite",
    table: "owner_request_log",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "ts",
    timestampKind: "iso",
    primaryKeyColumn: "id",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Once its content columns have been redacted (owner-request-log, above), the remaining row " +
      "(alias/model/route/token counts/outcome) is content-blind operational telemetry and follows " +
      "the longer six-month window before the row itself is deleted.",
  },

  // ── ledger.ts — delegations: the M5 capability ledger. Verdict/routing evidence columns are
  //    content-blind; `prompt_excerpt` is an optional payload-derived fixture column redacted on
  //    its own, shorter window — directly implementing the data-lifecycle doc's "M5 capability
  //    ledger" row ("six-month evidence and 30-day payload-fixture expiry").
  {
    storeId: "delegations-content",
    mechanism: "sqlite",
    table: "delegations",
    classification: "content-bearing",
    dataClass: "transient-task-artifact",
    retentionDays: retentionDaysFor("transient-task-artifact"),
    prunable: true,
    pruneAction: "redact-content",
    timestampColumn: "ts",
    timestampKind: "iso",
    primaryKeyColumn: "id",
    contentColumns: ["prompt_excerpt"],
    // ledger.ts's schema has `prompt_excerpt TEXT` (nullable) — redact to real SQL NULL.
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "medium",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Payload-derived fixture data (an optional excerpt of the prompt that produced a delegation " +
      "row) unless explicitly promoted as an eval asset — no promotion mechanism exists in this " +
      "PR, so every non-null excerpt is subject to the 30-day fixture window.",
  },
  {
    storeId: "delegations-evidence",
    mechanism: "sqlite",
    table: "delegations",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "ts",
    timestampKind: "iso",
    primaryKeyColumn: "id",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Capability verdict/routing evidence (task_type, model_id, outcome, score, latencies, " +
      "evidence_identity_hash) — content-blind once prompt_excerpt is redacted. Six-month window.",
  },

  // ── task-exposure.ts — task_exposure_events: content-blind fingerprint dedup registry (#257).
  {
    storeId: "task-exposure-events",
    mechanism: "sqlite",
    table: "task_exposure_events",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "ts",
    timestampKind: "iso",
    primaryKeyColumn: "event_key",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Versioned digest + content-blind execution metadata used to decide whether a Hugin holdout " +
      "task has already reached an owned runtime through another client. Never the task/prompt " +
      "text itself.",
  },

  // ── learning-task-admission-store.ts — replay-protection identity, content-blind by construction
  //    (ids, fingerprints, an echoed stamp — never task content).
  {
    storeId: "learning-task-admissions",
    mechanism: "sqlite",
    table: "learning_task_admissions",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "created_at",
    timestampKind: "iso",
    primaryKeyColumn: "admission_record_id",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Durable admission/replay-protection identity for LearningTaskContract traffic (issue #2). " +
      "Also the authoritative store `verifyHuginAttemptReference` (issue #3) checks against — a " +
      "cross-owner acknowledgement's authenticity depends on this row still existing, so pruning " +
      "here must never race an in-flight erasure that still needs to verify a joined exposure.",
  },

  // ── experiment-import-store.ts — content-blind natural-key/disposition registry (issue #8). The
  //    product rating carries a `reason_digest`, never the raw reviewer reason text.
  {
    storeId: "experiment-import-records",
    mechanism: "sqlite",
    table: "experiment_import_records",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "imported_at",
    timestampKind: "iso",
    primaryKeyColumn: "natural_key",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Idempotency/disposition registry for imported Hugin experiment-outcome observations. Links " +
      "to a `delegations` row rather than duplicating its content.",
  },

  // ── evidence-identity-store.ts — content-addressed reconstruction store (issue #5). Every field
  //    of an IdentityField is a digest/label/unknown — never raw prompt bytes (evidence-identity.ts
  //    `IdentityField` union has no free-text content variant).
  {
    storeId: "evidence-identity-snapshots",
    mechanism: "sqlite",
    table: "evidence_identity_snapshots",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: true,
    pruneAction: "delete-row",
    timestampColumn: "last_seen_at",
    timestampKind: "iso",
    primaryKeyColumn: "identity_hash",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Hash -> reconstructable evidence-identity bundle (model/build/config/lane digests). A " +
      "`delegations` row references this store only by its hash; deleting a stale, unreferenced " +
      "snapshot never resurrects or invalidates a delegation row's own evidence_identity_hash " +
      "column (it simply becomes non-reconstructable, same as any expired evidence).",
  },

  // ── code-loop-store.ts — per-run durable state file (`work-<id>.json` / `client-<id>.json` under
  //    <workroot>/.code-loop-state-v1/). Filesystem-backed, not a SQLite table: `DurableCodeLoopRun`
  //    carries a `result: CodeLoopResult | null`, which can include diff/output content. Retention
  //    enforcement for this store uses file mtime, never file content (see
  //    `scanCodeLoopWorkspaceForExpiry` in retention-enforcement.ts).
  {
    storeId: "code-loop-workspace",
    mechanism: "filesystem",
    table: null,
    classification: "content-bearing",
    dataClass: "transient-task-artifact",
    retentionDays: retentionDaysFor("transient-task-artifact"),
    prunable: true,
    pruneAction: "delete-file",
    timestampColumn: null,
    timestampKind: null,
    primaryKeyColumn: null,
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "medium",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "Durable per-run code-loop caller-idempotency records (#251), including a bounded agentic " +
      "run's result. Disposable workspace-shaped data — grimnir's own Hugin store-map row uses the " +
      "same 30-day transient-artifact default for unpromoted task workspaces/outputs.",
  },

  // ── gille-accounting-store.ts — the #3 durable evidence/counter chain. NEVER pruned by this job:
  //    the whole point of the six owned counters is that their original natural key, occurrence
  //    period, and counter identity survive an erasure — `writeErasureAdjustment` records an
  //    ADDITIONAL adjustment event; it never deletes or mutates the target's own row. Documented
  //    here (not silently omitted) so the inventory is complete, mirroring grimnir's Verdandi row
  //    ("Keep evidence for at least as long as the action or retained record it explains").
  {
    storeId: "gille-accounting-events",
    mechanism: "sqlite",
    table: "gille_accounting_events",
    classification: "content-blind",
    dataClass: "operational-telemetry",
    retentionDays: retentionDaysFor("operational-telemetry"),
    prunable: false,
    pruneAction: "none",
    timestampColumn: "recorded_at",
    timestampKind: "iso",
    primaryKeyColumn: "event_id",
    contentColumns: [],
    redactedContentValue: null,
    ownerSource: "gille-inference",
    sensitivity: "low",
    policyEpoch: POLICY_EPOCH_2026_07_20,
    purpose:
      "The durable, content-blind evidence/counter chain issue #3 owns (direct-attempt, direct-" +
      "exposure, admission, outcome, exclusion, erasure-adjustment, correction). Erasure of a " +
      "harvest-store subject that participates in these counters goes THROUGH " +
      "`writeErasureAdjustment` (retention-erasure.ts), never a DELETE against this table.",
  },
] as const;

export function getHarvestStoreDescriptor(storeId: string): HarvestStoreDescriptor | undefined {
  return HARVEST_STORE_REGISTRY.find((d) => d.storeId === storeId);
}

/** Every descriptor this job will actually scan/prune — excludes the durable evidence chain. */
export function prunableHarvestStores(): HarvestStoreDescriptor[] {
  return HARVEST_STORE_REGISTRY.filter((d) => d.prunable);
}
