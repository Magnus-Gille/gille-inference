/**
 * Retention dry-run enforcement (issue #9, scope items 2 and 6).
 *
 * Pure reporting: every function here only ever SELECTs (sqlite) or `stat`s (filesystem) — never a
 * DELETE/UPDATE. Reports are content-blind by construction: a sample-ref list carries only primary
 * keys (already-opaque ids/digests for every registered store — see retention-registry.ts's
 * comments), never a content column's value. The destructive counterpart
 * (`retention-prune-gate.ts::executeRetentionPrune`) always recomputes and re-verifies a report
 * from this module before it is allowed to delete anything; nothing here performs enforcement on
 * its own, and nothing in this repository schedules it to run automatically (issue #9 STRICT:
 * default off, no live deletion enabled by this PR).
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import {
  HARVEST_STORE_REGISTRY,
  prunableHarvestStores,
  type HarvestStoreDescriptor,
} from "./retention-registry.js";

export class RetentionEnforcementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionEnforcementError";
  }
}

const MAX_SAMPLE_REFS = 20;

export interface StoreDryRunResult {
  storeId: string;
  table: string | null;
  classification: HarvestStoreDescriptor["classification"];
  dataClass: HarvestStoreDescriptor["dataClass"];
  pruneAction: HarvestStoreDescriptor["pruneAction"];
  retentionDays: number;
  /** ISO instant: rows/files strictly older than this are "expired". */
  cutoffIso: string;
  /** Count of rows/files that WOULD be affected. Never larger than the store's true count. */
  expiredCount: number;
  /** Capped, content-blind primary-key/file-name sample — never a content column's value. */
  sampleRefs: string[];
}

export interface RetentionDryRunReport {
  schemaVersion: 1;
  generatedAt: string;
  /** Every prunable store scanned, in registry order — deterministic for content-hash binding. */
  stores: StoreDryRunResult[];
  totalExpiredRows: number;
}

function requireIsoNow(nowIso: string): void {
  if (Number.isNaN(Date.parse(nowIso))) {
    throw new RetentionEnforcementError(`retention dry-run "now" is not a valid ISO instant: ${nowIso}`);
  }
}

function cutoffIsoFor(nowIso: string, retentionDays: number): string {
  const cutoffMs = Date.parse(nowIso) - retentionDays * 24 * 60 * 60 * 1000;
  return new Date(cutoffMs).toISOString();
}

/** Scan one sqlite-backed store descriptor for expired rows. Never touches `contentColumns`. */
export function scanSqliteStoreForExpiry(
  db: Database.Database,
  descriptor: HarvestStoreDescriptor,
  nowIso: string,
): StoreDryRunResult {
  requireIsoNow(nowIso);
  if (descriptor.mechanism !== "sqlite" || !descriptor.table || !descriptor.timestampColumn || !descriptor.primaryKeyColumn) {
    throw new RetentionEnforcementError(
      `store ${descriptor.storeId} is not a fully-specified sqlite descriptor (mechanism/table/timestampColumn/primaryKeyColumn required)`,
    );
  }
  const cutoffIso = cutoffIsoFor(nowIso, descriptor.retentionDays);
  const cutoffValue = descriptor.timestampKind === "epoch-ms" ? Date.parse(cutoffIso) : cutoffIso;

  // For redact-content descriptors, "expired" additionally requires the content column to still
  // carry an un-redacted value — an already-redacted row is not reported again as pending work.
  // The comparison depends on the descriptor's own redactedContentValue (NULL for a nullable
  // column, '' for a NOT NULL one — see retention-registry.ts's field doc).
  const pendingClauseFor = (column: string): string =>
    descriptor.redactedContentValue === null ? `${column} IS NOT NULL` : `${column} != ''`;
  const contentGuard =
    descriptor.pruneAction === "redact-content" && descriptor.contentColumns.length > 0
      ? ` AND (${descriptor.contentColumns.map(pendingClauseFor).join(" OR ")})`
      : "";

  const tableExists = db
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(descriptor.table) as { present: 1 } | undefined;
  if (!tableExists) {
    return {
      storeId: descriptor.storeId,
      table: descriptor.table,
      classification: descriptor.classification,
      dataClass: descriptor.dataClass,
      pruneAction: descriptor.pruneAction,
      retentionDays: descriptor.retentionDays,
      cutoffIso,
      expiredCount: 0,
      sampleRefs: [],
    };
  }

  const countRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM ${descriptor.table} WHERE ${descriptor.timestampColumn} < ?${contentGuard}`,
    )
    .get(cutoffValue) as { n: number };
  const sampleRows = db
    .prepare(
      `SELECT ${descriptor.primaryKeyColumn} AS ref FROM ${descriptor.table} ` +
        `WHERE ${descriptor.timestampColumn} < ?${contentGuard} ` +
        `ORDER BY ${descriptor.primaryKeyColumn} LIMIT ${MAX_SAMPLE_REFS}`,
    )
    .all(cutoffValue) as Array<{ ref: string | number }>;

  return {
    storeId: descriptor.storeId,
    table: descriptor.table,
    classification: descriptor.classification,
    dataClass: descriptor.dataClass,
    pruneAction: descriptor.pruneAction,
    retentionDays: descriptor.retentionDays,
    cutoffIso,
    expiredCount: countRow.n,
    sampleRefs: sampleRows.map((r) => String(r.ref)),
  };
}

/**
 * Scan the code-loop filesystem workspace (`<workroot>/.code-loop-state-v1/*.json`) for files whose
 * mtime is older than the cutoff. Content-blind: only the file NAME (already an opaque hash/work id
 * — see code-loop-store.ts's `clientPath`/`workPath`) and mtime are ever read; file contents are
 * never opened by this scanner.
 */
/**
 * The FULL (uncapped) list of expired file names under `<workroot>/.code-loop-state-v1/`. Exported
 * separately from `scanCodeLoopWorkspaceForExpiry` so the executor (retention-prune-gate.ts) can
 * delete every expired file, not just the capped reporting sample a dry-run report carries — an
 * earlier version of the executor relied on the report's own (intentionally capped at
 * MAX_SAMPLE_REFS) `sampleRefs`, which silently deleted NOTHING once more than that many files were
 * expired (`sampleRefs.length !== expiredCount` in that case). Content-blind: only names/mtimes.
 */
export function listExpiredCodeLoopFiles(workroot: string, nowIso: string, retentionDays: number): string[] {
  requireIsoNow(nowIso);
  const cutoffMs = Date.parse(cutoffIsoFor(nowIso, retentionDays));
  const stateDir = join(workroot, ".code-loop-state-v1");

  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    return [];
  }

  const expired: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(join(stateDir, name)).mtimeMs;
    } catch {
      continue; // raced with a concurrent unlink — not this scan's concern
    }
    if (mtimeMs < cutoffMs) expired.push(name);
  }
  expired.sort();
  return expired;
}

export function scanCodeLoopWorkspaceForExpiry(
  workroot: string,
  nowIso: string,
  descriptor: HarvestStoreDescriptor,
): StoreDryRunResult {
  requireIsoNow(nowIso);
  const cutoffIso = cutoffIsoFor(nowIso, descriptor.retentionDays);
  const expired = listExpiredCodeLoopFiles(workroot, nowIso, descriptor.retentionDays);

  return {
    storeId: descriptor.storeId,
    table: null,
    classification: descriptor.classification,
    dataClass: descriptor.dataClass,
    pruneAction: descriptor.pruneAction,
    retentionDays: descriptor.retentionDays,
    cutoffIso,
    expiredCount: expired.length,
    sampleRefs: expired.slice(0, MAX_SAMPLE_REFS),
  };
}

export interface RetentionDryRunOptions {
  now: string;
  /** Required only if the registry contains a filesystem-mechanism store (code-loop-workspace). */
  workroot?: string;
}

/**
 * Build the full, deterministic (registry-order) dry-run report across every PRUNABLE store. Never
 * mutates anything. `gille-accounting-events` and any other `prunable: false` descriptor are
 * deliberately excluded — see retention-registry.ts's comment on why that store is never pruned.
 */
export function runRetentionDryRun(db: Database.Database, options: RetentionDryRunOptions): RetentionDryRunReport {
  requireIsoNow(options.now);
  const stores: StoreDryRunResult[] = [];
  for (const descriptor of prunableHarvestStores()) {
    if (descriptor.mechanism === "sqlite") {
      stores.push(scanSqliteStoreForExpiry(db, descriptor, options.now));
    } else if (descriptor.mechanism === "filesystem") {
      if (!options.workroot) {
        throw new RetentionEnforcementError(
          `store ${descriptor.storeId} is filesystem-backed but no workroot was supplied to runRetentionDryRun`,
        );
      }
      stores.push(scanCodeLoopWorkspaceForExpiry(options.workroot, options.now, descriptor));
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: options.now,
    stores,
    totalExpiredRows: stores.reduce((sum, s) => sum + s.expiredCount, 0),
  };
}

/**
 * Deterministic content hash of a dry-run report, used by retention-prune-gate.ts to bind a human
 * approval to the EXACT report state it was reviewed against (same discipline as
 * routing-lifecycle.ts's `artifactContentHash`). Re-derives from a canonical field order — never
 * trusts JSON.stringify's own key order, which is not itself a content-addressing guarantee.
 */
export function retentionReportContentHash(report: RetentionDryRunReport): string {
  const canonical = {
    schemaVersion: report.schemaVersion,
    generatedAt: report.generatedAt,
    stores: [...report.stores]
      .sort((a, b) => a.storeId.localeCompare(b.storeId))
      .map((s) => ({
        storeId: s.storeId,
        table: s.table,
        classification: s.classification,
        dataClass: s.dataClass,
        pruneAction: s.pruneAction,
        retentionDays: s.retentionDays,
        cutoffIso: s.cutoffIso,
        expiredCount: s.expiredCount,
        sampleRefs: [...s.sampleRefs].sort(),
      })),
    totalExpiredRows: report.totalExpiredRows,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export { HARVEST_STORE_REGISTRY };
