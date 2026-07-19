import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "../db.js";
import {
  DEFAULT_COST_CATALOG_VERSION,
  DEFAULT_PREMIUM_BASELINE_MODEL_ID,
  estimateLocalTokenCostUsd,
  estimateTokenCostUsd,
  lookupModelTokenPrice,
  roundUsd,
} from "./cost-catalog.js";

/**
 * Durable, content-blind savings ledger for local delegation.
 *
 * This is intentionally separate from the capability ledger. Capability verdicts answer
 * "is this task type suitable for M5?"; this table answers "how much money did a verified
 * local delegation save under the configured baselines?"
 */

export type DelegationCostStatus = "verified" | "unverified" | "failed" | "escalated" | "not_applicable";
export type DelegationPolicyMode = "off" | "shadow" | "enforce";
export type DelegationPolicyAction = "allow" | "shadow" | "deny";

export interface CostMetrics {
  promptTokens: number;
  completionTokens: number;
}

export interface BuildDelegationCostTraceOptions {
  taskType: string;
  localModelId: string;
  delegated: boolean;
  escalated: boolean;
  outcome?: string | null;
  metrics?: CostMetrics | null;
  ledgerId?: string | null;
  keyAlias?: string | null;
  source?: string | null;
  delegatorModelId?: string | null;
  premiumBaselineModelId?: string | null;
  fallbackModelId?: string | null;
  delegatePolicyMode?: DelegationPolicyMode | null;
  delegatePolicyAction?: DelegationPolicyAction | null;
  m5MarginalUsdPerMTok?: number;
  m5AmortizedUsdPerMTok?: number;
  priceCatalogVersion?: string;
}

export interface DelegationCostTrace {
  id: string;
  ts: string;
  delegationId: string | null;
  taskType: string;
  keyAlias: string | null;
  source: string | null;
  localModel: string;
  delegatorModel: string | null;
  premiumBaselineModel: string;
  fallbackModel: string | null;
  delegatePolicyMode: DelegationPolicyMode | null;
  delegatePolicyAction: DelegationPolicyAction | null;
  costStatus: DelegationCostStatus;
  outcome: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  actualBaselineCostUsd: number | null;
  premiumBaselineCostUsd: number | null;
  m5MarginalCostUsd: number;
  m5AmortizedCostUsd: number;
  m5TotalCostUsd: number;
  verifiedSavingsActualUsd: number;
  verifiedSavingsPremiumUsd: number;
  potentialSavingsActualUsd: number;
  potentialSavingsPremiumUsd: number;
  priceCatalogVersion: string;
  notes: string[];
}

const COST_COLUMNS = [
  "id",
  "ts",
  "delegation_id",
  "task_type",
  "key_alias",
  "source",
  "local_model",
  "delegator_model",
  "premium_baseline_model",
  "fallback_model",
  "delegate_policy_mode",
  "delegate_policy_action",
  "cost_status",
  "outcome",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "actual_baseline_cost_usd",
  "premium_baseline_cost_usd",
  "m5_marginal_cost_usd",
  "m5_amortized_cost_usd",
  "m5_total_cost_usd",
  "verified_savings_actual_usd",
  "verified_savings_premium_usd",
  "potential_savings_actual_usd",
  "potential_savings_premium_usd",
  "price_catalog_version",
  "notes",
] as const;

let _costInitDb: Database.Database | null = null;

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function ensureSchema(db: Database.Database): void {
  if (_costInitDb === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegation_costs (
      id                            TEXT PRIMARY KEY,
      ts                            TEXT NOT NULL,
      delegation_id                 TEXT,
      task_type                     TEXT NOT NULL,
      key_alias                     TEXT,
      source                        TEXT,
      local_model                   TEXT NOT NULL,
      delegator_model               TEXT,
      premium_baseline_model        TEXT NOT NULL,
      fallback_model                TEXT,
      delegate_policy_mode          TEXT,
      delegate_policy_action        TEXT,
      cost_status                   TEXT NOT NULL,
      outcome                       TEXT,
      prompt_tokens                 INTEGER,
      completion_tokens             INTEGER,
      total_tokens                  INTEGER,
      actual_baseline_cost_usd      REAL,
      premium_baseline_cost_usd     REAL,
      m5_marginal_cost_usd          REAL NOT NULL,
      m5_amortized_cost_usd         REAL NOT NULL,
      m5_total_cost_usd             REAL NOT NULL,
      verified_savings_actual_usd   REAL NOT NULL,
      verified_savings_premium_usd  REAL NOT NULL,
      potential_savings_actual_usd  REAL NOT NULL,
      potential_savings_premium_usd REAL NOT NULL,
      price_catalog_version         TEXT NOT NULL,
      notes                         TEXT
    );
  `);
  const cols = tableColumns(db, "delegation_costs");
  if (!cols.has("delegate_policy_mode")) {
    db.exec(`ALTER TABLE delegation_costs ADD COLUMN delegate_policy_mode TEXT`);
  }
  if (!cols.has("delegate_policy_action")) {
    db.exec(`ALTER TABLE delegation_costs ADD COLUMN delegate_policy_action TEXT`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_delegation_costs_ts      ON delegation_costs(ts);
    CREATE INDEX IF NOT EXISTS idx_delegation_costs_deleg   ON delegation_costs(delegation_id);
    CREATE INDEX IF NOT EXISTS idx_delegation_costs_type    ON delegation_costs(task_type);
    CREATE INDEX IF NOT EXISTS idx_delegation_costs_status  ON delegation_costs(cost_status);
    CREATE INDEX IF NOT EXISTS idx_delegation_costs_policy  ON delegation_costs(delegate_policy_mode, delegate_policy_action);
  `);
  _costInitDb = db;
}

function costDb(): Database.Database {
  const db = getDb();
  ensureSchema(db);
  return db;
}

export function ensureDelegationCostSchema(): void {
  ensureSchema(getDb());
}

export function delegationCostColumns(): string[] {
  return [...COST_COLUMNS];
}

function cleanModelId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function deriveCostStatus(opts: BuildDelegationCostTraceOptions): DelegationCostStatus {
  if (!opts.delegated) return "escalated";
  if (opts.outcome === "pass") return "verified";
  if (opts.outcome === "fail" || opts.outcome === "error") return "failed";
  if (opts.outcome === "partial" || opts.outcome === "unverified") return "unverified";
  return "not_applicable";
}

function savingsAgainst(baselineCost: number | null, localCost: number): number {
  if (baselineCost == null) return 0;
  return roundUsd(Math.max(0, baselineCost - localCost));
}

export function buildDelegationCostTrace(opts: BuildDelegationCostTraceOptions): DelegationCostTrace {
  const promptTokens = opts.metrics?.promptTokens ?? null;
  const completionTokens = opts.metrics?.completionTokens ?? null;
  const totalTokens = promptTokens == null || completionTokens == null ? null : promptTokens + completionTokens;
  const delegatorModel = cleanModelId(opts.delegatorModelId);
  const premiumBaselineModel = cleanModelId(opts.premiumBaselineModelId) ?? DEFAULT_PREMIUM_BASELINE_MODEL_ID;
  const fallbackModel = cleanModelId(opts.fallbackModelId);
  const costStatus = deriveCostStatus(opts);

  const actualBaselineCostUsd = estimateTokenCostUsd(delegatorModel, promptTokens, completionTokens);
  const premiumBaselineCostUsd = estimateTokenCostUsd(premiumBaselineModel, promptTokens, completionTokens);
  const m5MarginalCostUsd = estimateLocalTokenCostUsd(
    promptTokens,
    completionTokens,
    opts.m5MarginalUsdPerMTok ?? 0
  );
  const m5AmortizedCostUsd = estimateLocalTokenCostUsd(
    promptTokens,
    completionTokens,
    opts.m5AmortizedUsdPerMTok ?? 0
  );
  const m5TotalCostUsd = roundUsd(m5MarginalCostUsd + m5AmortizedCostUsd);

  const notes: string[] = [];
  if (promptTokens == null || completionTokens == null) notes.push("missing-token-usage");
  if (delegatorModel === null) notes.push("missing-delegator-model");
  else if (!lookupModelTokenPrice(delegatorModel)) notes.push(`missing-price:${delegatorModel}`);
  if (!lookupModelTokenPrice(premiumBaselineModel)) notes.push(`missing-price:${premiumBaselineModel}`);
  if (costStatus !== "verified") notes.push("verified-savings-zero-until-pass");

  const actualDelta = savingsAgainst(actualBaselineCostUsd, m5TotalCostUsd);
  const premiumDelta = savingsAgainst(premiumBaselineCostUsd, m5TotalCostUsd);
  const potentialAllowed = costStatus === "verified" || costStatus === "unverified";

  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    delegationId: opts.ledgerId ?? null,
    taskType: opts.taskType,
    keyAlias: opts.keyAlias ?? null,
    source: opts.source ?? null,
    localModel: opts.localModelId,
    delegatorModel,
    premiumBaselineModel,
    fallbackModel,
    delegatePolicyMode: opts.delegatePolicyMode ?? null,
    delegatePolicyAction: opts.delegatePolicyAction ?? null,
    costStatus,
    outcome: opts.outcome ?? null,
    promptTokens,
    completionTokens,
    totalTokens,
    actualBaselineCostUsd,
    premiumBaselineCostUsd,
    m5MarginalCostUsd,
    m5AmortizedCostUsd,
    m5TotalCostUsd,
    verifiedSavingsActualUsd: costStatus === "verified" ? actualDelta : 0,
    verifiedSavingsPremiumUsd: costStatus === "verified" ? premiumDelta : 0,
    potentialSavingsActualUsd: potentialAllowed ? actualDelta : 0,
    potentialSavingsPremiumUsd: potentialAllowed ? premiumDelta : 0,
    priceCatalogVersion: opts.priceCatalogVersion ?? DEFAULT_COST_CATALOG_VERSION,
    notes,
  };
}

export function recordDelegationCost(trace: DelegationCostTrace): string {
  costDb()
    .prepare(
      `INSERT INTO delegation_costs
         (id, ts, delegation_id, task_type, key_alias, source, local_model, delegator_model,
          premium_baseline_model, fallback_model, delegate_policy_mode, delegate_policy_action,
          cost_status, outcome,
          prompt_tokens, completion_tokens, total_tokens,
          actual_baseline_cost_usd, premium_baseline_cost_usd,
          m5_marginal_cost_usd, m5_amortized_cost_usd, m5_total_cost_usd,
          verified_savings_actual_usd, verified_savings_premium_usd,
          potential_savings_actual_usd, potential_savings_premium_usd,
          price_catalog_version, notes)
       VALUES
         (@id, @ts, @delegationId, @taskType, @keyAlias, @source, @localModel, @delegatorModel,
          @premiumBaselineModel, @fallbackModel, @delegatePolicyMode, @delegatePolicyAction,
          @costStatus, @outcome,
          @promptTokens, @completionTokens, @totalTokens,
          @actualBaselineCostUsd, @premiumBaselineCostUsd,
          @m5MarginalCostUsd, @m5AmortizedCostUsd, @m5TotalCostUsd,
          @verifiedSavingsActualUsd, @verifiedSavingsPremiumUsd,
          @potentialSavingsActualUsd, @potentialSavingsPremiumUsd,
          @priceCatalogVersion, @notes)`
    )
    .run({
      ...trace,
      notes: trace.notes.join(" | ") || null,
    });
  return trace.id;
}

export function tryRecordDelegationCost(trace: DelegationCostTrace): void {
  try {
    recordDelegationCost(trace);
  } catch (err) {
    console.error("[delegation-cost] failed to record savings trace (ignored):", err);
  }
}
