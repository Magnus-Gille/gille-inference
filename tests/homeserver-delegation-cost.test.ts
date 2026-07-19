import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  buildDelegationCostTrace,
  delegationCostColumns,
  ensureDelegationCostSchema,
  recordDelegationCost,
} from "../src/homeserver/delegation-cost.js";

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-deleg-cost-test-"));
  initDb(join(dir, "test.db"));
});

describe("delegation cost trace", () => {
  it("records verified savings only when outcome is pass", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      delegatorModelId: "claude-sonnet-5",
      premiumBaselineModelId: "claude-fable-5",
      m5MarginalUsdPerMTok: 1,
      m5AmortizedUsdPerMTok: 2,
    });

    expect(trace.costStatus).toBe("verified");
    expect(trace.actualBaselineCostUsd).toBe(12); // Sonnet 5 intro: $2 + $10
    expect(trace.premiumBaselineCostUsd).toBe(60); // Fable 5: $10 + $50
    expect(trace.m5MarginalCostUsd).toBe(2);
    expect(trace.m5AmortizedCostUsd).toBe(4);
    expect(trace.verifiedSavingsActualUsd).toBe(6);
    expect(trace.verifiedSavingsPremiumUsd).toBe(54);
    expect(trace.potentialSavingsPremiumUsd).toBe(54);
  });

  it("keeps verified savings at zero for unverified output while retaining potential savings", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "unverified",
      metrics: { promptTokens: 100_000, completionTokens: 100_000 },
      delegatorModelId: "claude-fable-5",
      premiumBaselineModelId: "claude-fable-5",
    });

    expect(trace.costStatus).toBe("unverified");
    expect(trace.verifiedSavingsPremiumUsd).toBe(0);
    expect(trace.potentialSavingsPremiumUsd).toBe(6);
    expect(trace.notes).toContain("verified-savings-zero-until-pass");
  });

  it("zeros both verified and potential savings for failed local attempts", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: true,
      outcome: "error",
      metrics: { promptTokens: 100_000, completionTokens: 100_000 },
      delegatorModelId: "claude-fable-5",
    });

    expect(trace.costStatus).toBe("failed");
    expect(trace.verifiedSavingsPremiumUsd).toBe(0);
    expect(trace.potentialSavingsPremiumUsd).toBe(0);
  });

  it("does not invent actual-delegator savings when the delegator model is unknown", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 100_000, completionTokens: 100_000 },
    });

    expect(trace.actualBaselineCostUsd).toBeNull();
    expect(trace.verifiedSavingsActualUsd).toBe(0);
    expect(trace.notes).toContain("missing-delegator-model");
  });

  it("persists a content-blind savings row", () => {
    ensureDelegationCostSchema();
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 10, completionTokens: 20 },
      ledgerId: "deleg-1",
      keyAlias: "owner",
      delegatorModelId: "claude-fable-5",
      delegatePolicyMode: "shadow",
      delegatePolicyAction: "shadow",
    });
    recordDelegationCost(trace);

    const db = getDb();
    const row = db.prepare(`SELECT * FROM delegation_costs WHERE id = ?`).get(trace.id) as Record<string, unknown>;
    expect(row["delegation_id"]).toBe("deleg-1");
    expect(row["key_alias"]).toBe("owner");
    expect(row["task_type"]).toBe("summarize");
    expect(row["delegate_policy_mode"]).toBe("shadow");
    expect(row["delegate_policy_action"]).toBe("shadow");
    expect(row["verified_savings_premium_usd"]).toBeGreaterThan(0);
    expect(delegationCostColumns()).not.toContain("prompt");
    expect(delegationCostColumns()).not.toContain("response");
  });

  it("migrates an existing delegation_costs table to include delegate policy fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-deleg-cost-migration-test-"));
    initDb(join(dir, "test.db"));
    const db = getDb();
    db.exec(`
      CREATE TABLE delegation_costs (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        delegation_id TEXT,
        task_type TEXT NOT NULL,
        key_alias TEXT,
        source TEXT,
        local_model TEXT NOT NULL,
        delegator_model TEXT,
        premium_baseline_model TEXT NOT NULL,
        fallback_model TEXT,
        cost_status TEXT NOT NULL,
        outcome TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        actual_baseline_cost_usd REAL,
        premium_baseline_cost_usd REAL,
        m5_marginal_cost_usd REAL NOT NULL,
        m5_amortized_cost_usd REAL NOT NULL,
        m5_total_cost_usd REAL NOT NULL,
        verified_savings_actual_usd REAL NOT NULL,
        verified_savings_premium_usd REAL NOT NULL,
        potential_savings_actual_usd REAL NOT NULL,
        potential_savings_premium_usd REAL NOT NULL,
        price_catalog_version TEXT NOT NULL,
        notes TEXT
      )
    `);

    ensureDelegationCostSchema();

    const cols = new Set((db.prepare(`PRAGMA table_info(delegation_costs)`).all() as Array<{ name: string }>).map((r) => r.name));
    expect(cols.has("delegate_policy_mode")).toBe(true);
    expect(cols.has("delegate_policy_action")).toBe(true);
  });
});
