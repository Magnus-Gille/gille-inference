import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import { ensureLedgerSchema } from "./ledger.js";
import {
  EXECUTION_FEEDBACK_EPOCH,
  EXECUTION_FEEDBACK_VALUES,
  type ExecutionFeedbackValue,
  type ExecutionTrafficPurpose,
} from "./execution-feedback-contract.js";

/** Private server context, never accepted from a request body or exported in reports. */
export interface ExecutionFeedbackOwner { keyHash: string; alias: string }
export type ExecutionFeedbackSurface = "ask" | "delegate" | "code_loop";

/** This narrow permission is not general ledger access or reviewer-overlay authority. */
export function executionFeedbackOwner(principal: {
  tier: string; scope: string; keyHash: string | null; alias: string;
}): ExecutionFeedbackOwner | null {
  return principal.tier === "owner"
    && (principal.scope === "agent" || principal.scope === "admin")
    && typeof principal.keyHash === "string" && principal.keyHash.trim().length > 0
    && typeof principal.alias === "string" && principal.alias.trim().length > 0
    ? { keyHash: principal.keyHash, alias: principal.alias } : null;
}

const initialized = new WeakSet<Database.Database>();
export function ensureExecutionFeedbackSchema(): void {
  ensureLedgerSchema();
  const db = getDb();
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS execution_feedback (
    handle TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL UNIQUE REFERENCES delegations(id) ON DELETE CASCADE,
    principal_hash TEXT NOT NULL,
    surface TEXT NOT NULL CHECK(surface IN ('ask','delegate','code_loop')),
    traffic_purpose TEXT NOT NULL CHECK(traffic_purpose IN ('organic','evaluation','synthetic','unknown')),
    epoch TEXT NOT NULL,
    available INTEGER NOT NULL DEFAULT 1 CHECK(available IN (0,1)),
    usefulness TEXT CHECK(usefulness IN ('pass','partial','redo','wrong')),
    conflict_count INTEGER NOT NULL DEFAULT 0 CHECK(conflict_count >= 0)
  )`);
  initialized.add(db);
}

interface BindingRow {
  handle: string; principal_hash: string; surface: string; traffic_purpose: string; epoch: string;
}

/**
 * Called only by server completion paths after local output is available to return/retrieve.
 * The handle alone is not authority. Binding is immutable and exact-row idempotent.
 * Unknown purpose remains unknown; retrospective relabelling is deliberately forbidden.
 */
export function bindExecutionFeedback(args: {
  ledgerId: string; owner: ExecutionFeedbackOwner; surface: ExecutionFeedbackSurface;
  trafficPurpose: ExecutionTrafficPurpose; outputAvailable: boolean;
  deferAvailability?: boolean;
}): string | null {
  ensureExecutionFeedbackSchema();
  if (!args.outputAvailable || !args.owner.keyHash || !args.owner.alias) return null;
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT key_alias, source FROM delegations
      WHERE id = ? AND shadow = 0 AND superseded_at IS NULL AND outcome != 'error'`)
      .get(args.ledgerId) as { key_alias: string | null; source: string | null } | undefined;
    const source = args.surface === "delegate" ? "gateway" : args.surface === "ask" ? "mcp-ask" : "code-loop";
    if (!row || row.key_alias !== args.owner.alias || row.source !== source) return null;
    const existing = db.prepare("SELECT handle, principal_hash, surface, traffic_purpose, epoch FROM execution_feedback WHERE ledger_id = ?")
      .get(args.ledgerId) as BindingRow | undefined;
    if (existing) {
      return existing.principal_hash === args.owner.keyHash && existing.surface === args.surface
        && existing.traffic_purpose === args.trafficPurpose && existing.epoch === EXECUTION_FEEDBACK_EPOCH
        ? existing.handle : null;
    }
    const handle = randomUUID();
    db.prepare(`INSERT INTO execution_feedback
      (handle, ledger_id, principal_hash, surface, traffic_purpose, epoch, available) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(handle, args.ledgerId, args.owner.keyHash, args.surface, args.trafficPurpose, EXECUTION_FEEDBACK_EPOCH, args.deferAvailability ? 0 : 1);
    return handle;
  }).immediate();
}

export type ExecutionFeedbackResult = {
  kind: "recorded" | "unchanged" | "conflict" | "not_found" | "ineligible" | "invalid";
};

/** Called only after the trusted durable async result has been written or recovered. */
export function publishDurableExecutionFeedback(handle: string): void {
  try {
    ensureExecutionFeedbackSchema();
    getDb().prepare("UPDATE execution_feedback SET available = 1 WHERE handle = ? AND surface = 'code_loop'").run(handle);
  } catch {
    // The durable result remains authoritative. A later recovery can retry publication; an
    // unavailable telemetry store must not overwrite an already committed terminal result.
    console.error("[execution-feedback] durable binding publication failed; recovery may retry");
  }
}

/** Read-side filtering: an opaque handle is not a transferable reporting capability. */
export function ownsExecutionFeedback(handle: string, owner: ExecutionFeedbackOwner | null): boolean {
  if (!owner) return false;
  ensureExecutionFeedbackSchema();
  return !!getDb().prepare(`SELECT 1 FROM execution_feedback f JOIN delegations d ON d.id = f.ledger_id
    WHERE f.handle = ? AND f.principal_hash = ? AND d.key_alias = ?`).get(handle, owner.keyHash, owner.alias);
}

/** Atomic compare-and-set; rejected conflicts retain only a count, never caller content. */
export function recordExecutionFeedback(args: {
  handle: string; owner: ExecutionFeedbackOwner; usefulness: ExecutionFeedbackValue;
}): ExecutionFeedbackResult {
  if (!(EXECUTION_FEEDBACK_VALUES as readonly unknown[]).includes(args.usefulness)) return { kind: "invalid" };
  ensureExecutionFeedbackSchema();
  const db = getDb();
  return db.transaction((): ExecutionFeedbackResult => {
    const row = db.prepare(`SELECT f.usefulness, f.traffic_purpose, f.epoch, f.available,
      d.shadow, d.superseded_at, d.outcome, d.key_alias
      FROM execution_feedback f JOIN delegations d ON d.id = f.ledger_id
      WHERE f.handle = ? AND f.principal_hash = ?`)
      .get(args.handle, args.owner.keyHash) as {
        usefulness: string | null; traffic_purpose: string; epoch: string; available: number;
        shadow: number; superseded_at: string | null; outcome: string; key_alias: string | null;
      } | undefined;
    if (!row || row.key_alias !== args.owner.alias) return { kind: "not_found" };
    if (row.available !== 1 || row.traffic_purpose !== "organic" || row.epoch !== EXECUTION_FEEDBACK_EPOCH
      || row.shadow !== 0 || row.superseded_at !== null || row.outcome === "error") return { kind: "ineligible" };
    if (row.usefulness === args.usefulness) return { kind: "unchanged" };
    if (row.usefulness !== null) {
      db.prepare("UPDATE execution_feedback SET conflict_count = conflict_count + 1 WHERE handle = ?").run(args.handle);
      return { kind: "conflict" };
    }
    db.prepare("UPDATE execution_feedback SET usefulness = ? WHERE handle = ?").run(args.usefulness, args.handle);
    return { kind: "recorded" };
  }).immediate();
}
