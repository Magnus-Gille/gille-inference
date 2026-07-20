# Retention and erasure for harvest source data (issue #9)

Status: store map, retention windows, and the destructive-prune safety gate landed 2026-07-20.
**Live pruning is NOT enabled by this work** — see "Default-off, by construction" below.

This document is gille-inference's implementation of grimnir's data-lifecycle policy
(`grimnir:docs/data-lifecycle.md`, adopted 2026-07-10 under grimnir#66) for its own "M5 capability
ledger" row, plus every other durable store that holds harvest-source or harvest-derived data.
grimnir's document is the authoritative source for the retention DEFAULTS; this document and its
backing code (`src/homeserver/retention-registry.ts`, `retention-enforcement.ts`,
`retention-prune-gate.ts`, `retention-erasure.ts`) are the owning-repo implementation grimnir's
own store map explicitly defers to ("Automatic pruning and missing erasure mechanisms must be
implemented and tested by the owning repo").

## Why this exists

Request logs and related metadata are source material for organic harvesting (issue #3's
capability ledger, issue #8's experiment imports, issue #5's evidence-identity reconstruction).
Before this issue, retention was operator hygiene, not an enforced lifecycle: nothing counted
what was expired, nothing could safely delete it, and an erasure request had no path that both
respected issue #3's denominator-membership guarantees and left an auditable trail.

## Store inventory

Every store below is registered in `src/homeserver/retention-registry.ts`'s
`HARVEST_STORE_REGISTRY` — the single machine-readable source of truth. This table is a rendering
of that registry; if the two drift, the registry (and its own unit tests) win.

| storeId | table / mechanism | classification | data class | window | action |
|---|---|---|---|---|---|
| `request-log` | `request_log` (sqlite) | content-blind | operational-telemetry | 183d | delete-row |
| `owner-request-log` | `owner_request_log` (sqlite) | content-bearing | transient-task-artifact | 30d | redact-content (`messages_json`, `completion`) |
| `owner-request-log-row` | `owner_request_log` (sqlite) | content-blind (post-redaction) | operational-telemetry | 183d | delete-row |
| `delegations-content` | `delegations` (sqlite) | content-bearing | transient-task-artifact | 30d | redact-content (`prompt_excerpt`) |
| `delegations-evidence` | `delegations` (sqlite) | content-blind (post-redaction) | operational-telemetry | 183d | delete-row |
| `task-exposure-events` | `task_exposure_events` (sqlite) | content-blind | operational-telemetry | 183d | delete-row |
| `learning-task-admissions` | `learning_task_admissions` (sqlite) | content-blind | operational-telemetry | 183d | delete-row |
| `experiment-import-records` | `experiment_import_records` (sqlite) | content-blind | operational-telemetry | 183d | delete-row |
| `evidence-identity-snapshots` | `evidence_identity_snapshots` (sqlite) | content-blind | operational-telemetry | 183d | delete-row |
| `code-loop-workspace` | `<workroot>/.code-loop-state-v1/*.json` (filesystem) | content-bearing | transient-task-artifact | 30d | delete-file (by mtime only, content never opened) |
| `gille-accounting-events` | `gille_accounting_events` / `gille_accounting_partitions` (sqlite) | content-blind | operational-telemetry | 183d | **none — never pruned by this job** |

The `delegations` and `owner_request_log` tables each appear TWICE: once for their content
column(s) on the shorter 30-day transient-artifact window, once for the remaining (now
content-blind) row on the longer 183-day operational-telemetry window. This directly implements
grimnir's own "M5 capability ledger" row: *"Verdict and routing evidence use the
operational-telemetry default. Payload-derived fixtures use the transient default ... Target:
six-month evidence and 30-day payload-fixture expiry while retaining only the minimum aggregate
routing evidence."*

`gille_accounting_events`/`gille_accounting_partitions` (issue #3's durable evidence/counter
chain: direct-attempt, direct-exposure, admission, outcome, exclusion, erasure-adjustment,
correction) is documented but **never pruned**. The whole point of those six counters is that a
record's original natural key, occurrence period, and counter identity survive an erasure —
deleting the row would defeat that guarantee. Erasure reaches this store only through
`writeErasureAdjustment` (an additional event, never a delete) — see "Erasure propagation" below.

`access-log.ts` is a structured stdout logger, not a durable store (no persisted rows), and is out
of this inventory's scope. `admission.ts`/`quota.ts`/`delegation-cost.ts`/`image-jobs.ts` hold
operational/quota bookkeeping rather than harvest-source material and were not in scope for this
pass; they are natural candidates for a follow-up ticket using the same registry pattern.

## Retention windows (from grimnir docs/data-lifecycle.md)

| Data class | Days | Source |
|---|---|---|
| `operational-telemetry` | 183 (~6 months) | "Operational telemetry ... 6 months from collection" |
| `transient-task-artifact` | 30 | "Transient task artifacts ... 30 days after task completion" |

## Enforcement — dry-run first, always

`src/homeserver/retention-enforcement.ts::runRetentionDryRun(db, { now, workroot })` scans every
`prunable: true` descriptor and returns a `RetentionDryRunReport`: per store, the retention
cutoff, an expired-row COUNT, and a capped, content-blind sample of primary keys/file names —
**never** a content column's value or a file's bytes. Nothing in this function, or anywhere else
in this PR, issues a `DELETE` or `UPDATE`. `retentionReportContentHash` produces a deterministic
content hash of a report, used to bind a human approval to the exact state it reviewed.

`tsx scripts/retention-cli.ts dry-run [--out report.json]` is the composition root: it wires
`runRetentionDryRun` to the real eval DB and code-loop workroot and prints/persists the report.

## The destructive-prune safety gate — default OFF

`src/homeserver/retention-prune-gate.ts` mirrors two existing reviewed-enablement seams in this
repo (`calibration-gate.ts`'s HOLD/GO + `attachReviewedDecision`, and
`routing-lifecycle.ts`'s `prepareReview` → `approveArtifact` → `adoptRoutingTable`) rather than
inventing a third idiom. Three independent conditions must ALL hold before
`executeRetentionPrune` deletes or redacts a single byte:

1. A `PruneApprovalToken` (from `approveRetentionPrune`, the only way to produce one) whose bound
   report content hash matches a **freshly recomputed** dry-run right now — a stale or
   hand-crafted report is rejected.
2. The caller supplies the exact confirmation phrase `RETENTION_LIVE_PRUNE_CONFIRM`
   (`"I_UNDERSTAND_THIS_DELETES_HARVEST_SOURCE_DATA"`) — deliberately too specific to type by
   accident.
3. `process.env.HOMESERVER_RETENTION_LIVE_PRUNE === "on"` — an operator-controlled runtime switch
   this repository's own code, config, startup path, and CI never set.

Omit any ONE of the three and `executeRetentionPrune` returns `{ status: "refused", reason, ... }`
— it never partially executes. **Nothing in this PR calls `executeRetentionPrune` with a live
enablement, and nothing sets `HOMESERVER_RETENTION_LIVE_PRUNE=on` anywhere in this repository.**
Enabling live pruning in production is a deliberate, separate, reviewed operator action outside
of this change — exactly like enabling calibration-gated harvest (issue #6/#7) required its own
explicit reviewed decision, never an automatic consequence of measurement code landing.

`tsx scripts/retention-cli.ts prune --report <reviewed-report.json> --approved-by <name> --reason
"<why>" --decision-ref <issue/PR>` is the composition root for the (still gated) destructive path.

## Erasure propagation — through issue #3's accounting, not around it

`src/homeserver/retention-erasure.ts::propagateErasure` erases a harvest-source subject WITHOUT
reimplementing erasure-safe denominator membership:

1. It looks up the target's gille-accounting event and reads its denominator basis
   (`denominatorBasisFor`, issue #3). If that basis includes a **Hugin-owned counter** (a joined
   exposure), a cross-owner acknowledgement is required and independently re-verified against
   `learning_task_admissions` (the same store `verifyHuginAttemptReference` already trusts) — a
   **fabricated acknowledgement is rejected**, never trusted on a caller's say-so.
2. It calls issue #3's `writeErasureAdjustment`, which itself re-derives and re-verifies the
   basis proof before writing anything. This is the ONLY mechanism that adjusts a counter; the
   target's own row, natural key, and occurrence period are never touched, so a July record
   cannot be pushed into August membership and content is never resurrected (there was none to
   begin with — issue #3's events are content-blind by construction).
3. It records a durable, content-blind tombstone (`retention_erasures`, keyed by
   `(storeId, subjectRef)`) so `isErased(db, storeId, subjectRef)` lets a later import/admission
   path refuse to re-accept the same subject.
4. Optionally, it redacts one specific row's registered content columns
   (`redactStoreSubjectContent`) — the same column list and NULL/`""` convention the windowed
   prune uses (see "NOT NULL columns" below).

`excludeSubjectFromHarvesting` is a thin forward to issue #3's own `recordExclusion` with two new
issue-#9 exclusion reasons (`retention-owner-opt-out`, `retention-erasure-requested`) — an
additive event that never rewrites the subject's own prior direct-attempt/exposure/admission/
outcome rows.

### NOT NULL columns

`owner_request_log.messages_json`/`completion` are `NOT NULL` in owner-log.ts's existing schema.
Redacting them to real SQL `NULL` would violate that constraint, so their descriptor's
`redactedContentValue` is `""` (empty string) rather than `null` — exactly as content-blind for
reporting purposes (the dry-run report never reads a content column's value either way).
`delegations.prompt_excerpt` is nullable, so its `redactedContentValue` is `null`.

## Backups and derived data

gille-inference does not own backup infrastructure (grimnir's Backups row: "Owning service
(replication/retention); Brokkr"). This repo's own derived/candidate data — the `delegations`
table, i.e. the "M5 capability ledger" — is the store this issue's windows were written for; any
OS/Brokkr-level backup of `data/eval.db` inherits whatever retention that job applies
independently. `retention-enforcement.ts`'s cutoff arithmetic (`cutoffIsoFor`) is a single,
reusable function specifically so a future backup-expiry job can compute the SAME cutoff a
source-side prune would use, rather than inventing an independent (and potentially longer-lived)
backup retention window that could silently resurrect pruned data on restore.

## What this PR does NOT do

- Does not enable live pruning (see above).
- Does not change routing, admission, or any production request path.
- Does not wire a scheduler/cron/timer to any of this — `retention-cli.ts dry-run` is intended to
  be run manually or by an external, separately-reviewed scheduling mechanism.
- Does not wire `isErased`/tombstone checks into every existing store's write path (e.g.
  `experiment-import-store.ts`'s import disposition logic) — the primitive is built and tested;
  full call-site integration is left as a bounded follow-up to keep this change's blast radius
  proportionate to a first retention/erasure implementation.
- Does not cover `admission.ts`/`quota.ts`/`delegation-cost.ts`/`image-jobs.ts` — flagged above as
  follow-up scope using the same registry pattern.
