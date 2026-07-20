/**
 * HOLD/GO-shaped safety gate for the retention DELETE/redact job (issue #9, scope item 6 — the
 * load-bearing safety requirement of this issue).
 *
 * Mirrors two existing reviewed-enablement seams in this repo rather than inventing a third idiom:
 *   - calibration-gate.ts: a PURE verdict computed from measured evidence, plus a SEPARATE
 *     `attachReviewedDecision`/`ReviewedEnablementDecision` that is the only way to record a human
 *     approval, and which REFUSES to attach to a non-GO verdict.
 *   - routing-lifecycle.ts: `prepareReview` (pure, dry-run, default path) -> `approveArtifact`
 *     (binds an approval to the artifact's own content hash) -> `adoptRoutingTable` (requires the
 *     token, re-verifies the content-hash binding, and only then mutates).
 *
 * Three independent conditions must ALL hold before `executeRetentionPrune` deletes or redacts a
 * single byte — any one missing is a refusal, never a partial/best-effort prune:
 *   1. A `PruneApprovalToken` bound (by content hash) to a dry-run report that STILL matches what
 *      `runRetentionDryRun` recomputes right now — a stale or hand-crafted report is rejected, same
 *      "recompute and compare, never trust the caller" discipline as gille-accounting-store.ts's
 *      `verifyGilleBasisProofForErasure`.
 *   2. The caller-supplied confirmation phrase exactly matches `RETENTION_LIVE_PRUNE_CONFIRM` — a
 *      constant deliberately too specific to type by accident.
 *   3. `process.env[RETENTION_LIVE_PRUNE_ENV] === "on"` (or an injected override for tests) — an
 *      operator-controlled runtime switch this repository's own config/startup code never sets.
 *
 * Nothing in this PR calls `executeRetentionPrune`, sets `HOMESERVER_RETENTION_LIVE_PRUNE=on`, or
 * wires a scheduler/cron to any of this. Live pruning is default-off by construction, not merely by
 * convention: omit any ONE of the three conditions above and the function returns `"refused"`,
 * never `"executed"`.
 */

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  listExpiredCodeLoopFiles,
  runRetentionDryRun,
  retentionReportContentHash,
  type RetentionDryRunReport,
  type RetentionDryRunOptions,
} from "./retention-enforcement.js";
import { getHarvestStoreDescriptor } from "./retention-registry.js";

export class RetentionPruneGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionPruneGateError";
  }
}

// ─── Reviewed enablement (never produced automatically) ───────────────────────────────────────

export interface ReviewedPruneEnablement {
  reviewerId: string;
  /** Free-text reason IS permitted — a human-authored decision, not extracted task content (same
   *  allowance as calibration-gate.ts's `ReviewedEnablementDecision.reason`). */
  reason: string;
  decisionRef: string;
  reviewedAt: string;
}

export interface PruneApprovalToken {
  schemaVersion: 1;
  /** Binds this approval to the EXACT dry-run report content — see retentionReportContentHash. */
  reportContentHash: string;
  reportGeneratedAt: string;
  enablement: ReviewedPruneEnablement;
}

/**
 * The ONLY way to produce a `PruneApprovalToken`. Pure: never touches the DB, never deletes
 * anything, never reads `process.env`. A human reviewer calls this after inspecting a
 * `RetentionDryRunReport` they consider safe to act on.
 */
export function approveRetentionPrune(
  report: RetentionDryRunReport,
  enablement: ReviewedPruneEnablement,
): PruneApprovalToken {
  if (!enablement.reviewerId.trim() || !enablement.reason.trim() || !enablement.decisionRef.trim()) {
    throw new RetentionPruneGateError(
      "a reviewed prune enablement requires a non-empty reviewerId, reason, and decisionRef",
    );
  }
  if (Number.isNaN(Date.parse(enablement.reviewedAt))) {
    throw new RetentionPruneGateError(`reviewedAt is not a valid ISO instant: ${enablement.reviewedAt}`);
  }
  return {
    schemaVersion: 1,
    reportContentHash: retentionReportContentHash(report),
    reportGeneratedAt: report.generatedAt,
    enablement,
  };
}

// ─── Execution (destructive; default-off) ──────────────────────────────────────────────────────

export const RETENTION_LIVE_PRUNE_ENV = "HOMESERVER_RETENTION_LIVE_PRUNE";
/** Deliberately specific — never satisfied by a truthy-looking "1"/"true" typo. */
export const RETENTION_LIVE_PRUNE_CONFIRM = "I_UNDERSTAND_THIS_DELETES_HARVEST_SOURCE_DATA" as const;

export interface ExecuteRetentionPruneInput {
  db: Database.Database;
  token: PruneApprovalToken;
  /** Must equal `RETENTION_LIVE_PRUNE_CONFIRM` exactly. */
  confirm: string;
  now: string;
  workroot?: string;
  /** Test-only seam. Production reads `process.env[RETENTION_LIVE_PRUNE_ENV]`. */
  liveEnableEnvValue?: string | undefined;
}

export type PruneExecutionResult =
  | { status: "refused"; reason: string; freshReport: RetentionDryRunReport }
  | {
      status: "executed";
      freshReport: RetentionDryRunReport;
      /** Rows deleted or content-redacted per storeId — content-blind (counts only). */
      affectedCounts: Record<string, number>;
    };

function performDeletes(
  db: Database.Database,
  report: RetentionDryRunReport,
  workroot: string | undefined,
): Record<string, number> {
  const affected: Record<string, number> = {};
  for (const result of report.stores) {
    if (result.expiredCount === 0) {
      affected[result.storeId] = 0;
      continue;
    }
    const descriptor = getHarvestStoreDescriptor(result.storeId);
    if (!descriptor) {
      throw new RetentionPruneGateError(`unknown store in dry-run report: ${result.storeId}`);
    }
    if (descriptor.mechanism === "sqlite" && descriptor.table && descriptor.timestampColumn) {
      const cutoffValue = descriptor.timestampKind === "epoch-ms" ? Date.parse(result.cutoffIso) : result.cutoffIso;
      if (descriptor.pruneAction === "delete-row") {
        const info = db
          .prepare(`DELETE FROM ${descriptor.table} WHERE ${descriptor.timestampColumn} < ?`)
          .run(cutoffValue);
        affected[result.storeId] = info.changes;
      } else if (descriptor.pruneAction === "redact-content" && descriptor.contentColumns.length > 0) {
        // redactedContentValue is null for a nullable column, "" for a NOT NULL one — see
        // retention-registry.ts's field doc. Bound as a real parameter, never string-interpolated.
        const redactedValue = descriptor.redactedContentValue;
        const setClause = descriptor.contentColumns.map((c) => `${c} = @redactedValue`).join(", ");
        const guard = descriptor.contentColumns
          .map((c) => (redactedValue === null ? `${c} IS NOT NULL` : `${c} != @redactedValue`))
          .join(" OR ");
        const info = db
          .prepare(
            `UPDATE ${descriptor.table} SET ${setClause} WHERE ${descriptor.timestampColumn} < @cutoff AND (${guard})`,
          )
          .run({ cutoff: cutoffValue, redactedValue });
        affected[result.storeId] = info.changes;
      } else {
        affected[result.storeId] = 0;
      }
    } else if (descriptor.mechanism === "filesystem" && descriptor.pruneAction === "delete-file") {
      if (!workroot) throw new RetentionPruneGateError(`store ${result.storeId} needs a workroot to prune`);
      const stateDir = join(workroot, ".code-loop-state-v1");
      // Re-derive the FULL expired-file list independently — never rely on the dry-run report's own
      // `sampleRefs`, which is deliberately capped (MAX_SAMPLE_REFS) for reporting and would silently
      // delete nothing once more files were expired than the cap (a real bug an earlier version of
      // this function had).
      const expiredFiles = listExpiredCodeLoopFiles(workroot, report.generatedAt, descriptor.retentionDays);
      let removed = 0;
      for (const name of expiredFiles) {
        try {
          unlinkSync(join(stateDir, name));
          removed += 1;
        } catch {
          // Raced with a concurrent cleanup — not fatal to the overall prune run.
        }
      }
      affected[result.storeId] = removed;
    } else {
      affected[result.storeId] = 0;
    }
  }
  return affected;
}

/**
 * The ONLY function in this module (or, by construction, this repository) capable of deleting or
 * redacting a harvest-store row. Refuses — deletes nothing — unless ALL of: the token's bound
 * report content hash matches a FRESHLY recomputed dry-run right now; `confirm` is the exact
 * phrase; and the live-enable environment switch reads `"on"`. See this module's header comment.
 */
export function executeRetentionPrune(input: ExecuteRetentionPruneInput): PruneExecutionResult {
  const dryRunOptions: RetentionDryRunOptions = { now: input.now, workroot: input.workroot };
  const freshReport = runRetentionDryRun(input.db, dryRunOptions);
  const freshHash = retentionReportContentHash(freshReport);

  if (freshHash !== input.token.reportContentHash) {
    return {
      status: "refused",
      reason:
        "approval token does not match the store's current state (the report has changed since " +
        "it was reviewed, or the token was hand-crafted) — re-run the dry-run and re-approve",
      freshReport,
    };
  }
  if (input.confirm !== RETENTION_LIVE_PRUNE_CONFIRM) {
    return {
      status: "refused",
      reason: `confirm phrase missing or incorrect — must equal exactly "${RETENTION_LIVE_PRUNE_CONFIRM}"`,
      freshReport,
    };
  }
  const envValue = input.liveEnableEnvValue ?? process.env[RETENTION_LIVE_PRUNE_ENV];
  if (envValue !== "on") {
    return {
      status: "refused",
      reason:
        `live pruning is default-off — set ${RETENTION_LIVE_PRUNE_ENV}=on to enable it. This ` +
        "value is never set by this repository's own code, config, or CI: an operator must set it " +
        "explicitly and deliberately outside of source control.",
      freshReport,
    };
  }

  const affectedCounts = performDeletes(input.db, freshReport, input.workroot);
  return { status: "executed", freshReport, affectedCounts };
}
