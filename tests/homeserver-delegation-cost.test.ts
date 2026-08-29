import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  buildDelegationCostTrace,
  delegationCostColumns,
  ensureDelegationCostSchema,
  findUnpricedDelegatorModels,
  recordDelegationCost,
} from "../src/homeserver/delegation-cost.js";
import { cmdLedger } from "../src/homeserver/cli.js";

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
    expect(trace.delegatorModelSource).toBeNull();
    expect(trace.notes).toContain("missing-delegator-model");
  });

  // #83: regression coverage for the root cause — delegator_model was mostly unpopulated in
  // production, and even where it WAS populated the row never distinguished a caller's own stamp
  // from the configured HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID fallback. These four cases pin the
  // required behavior: caller stamp wins, is labelled "stamped", and is the only source ever
  // allowed to book verifiedSavingsActualUsd — a defaulted attribution is weaker evidence and must
  // never be reported as a measured displacement.
  it("labels a caller-supplied delegatorModelId as 'stamped' and books it as measured savings", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      delegatorModelId: "claude-sonnet-5",
    });

    expect(trace.delegatorModel).toBe("claude-sonnet-5");
    expect(trace.delegatorModelSource).toBe("stamped");
    expect(trace.actualBaselineCostUsd).toBeGreaterThan(0);
    expect(trace.verifiedSavingsActualUsd).toBeGreaterThan(0);
    expect(trace.notes).not.toContain(expect.stringContaining("delegator-model-defaulted"));
  });

  it("books a non-zero actual baseline for a stamped, officially priced frontier delegator", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      delegatorModelId: "anthropic/claude-opus-5",
    });

    expect(trace.delegatorModelSource).toBe("stamped");
    expect(trace.actualBaselineCostUsd).toBe(30);
    expect(trace.verifiedSavingsActualUsd).toBe(30);
  });

  it("keeps an unavailable or missing stamped model at zero with the existing missing-price note", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      delegatorModelId: "qwen3-30b-instruct",
    });

    expect(trace.actualBaselineCostUsd).toBeNull();
    expect(trace.verifiedSavingsActualUsd).toBe(0);
    expect(trace.notes).toContain("missing-price:qwen3-30b-instruct");
  });

  it("reports ledger delegator ids whose prices are missing, unavailable, or stale without exposing content", () => {
    ensureDelegationCostSchema();
    for (const delegatorModelId of ["anthropic/claude-opus-5", "qwen3-30b-instruct", "unlisted-model"]) {
      recordDelegationCost(buildDelegationCostTrace({
        taskType: "summarize",
        localModelId: "mellum",
        delegated: true,
        escalated: false,
        outcome: "pass",
        metrics: { promptTokens: 1, completionTokens: 1 },
        delegatorModelId,
      }));
    }

    expect(findUnpricedDelegatorModels()).toEqual([
      expect.objectContaining({ modelId: "qwen3-30b-instruct", reason: "unavailable", rows: 1 }),
      expect.objectContaining({ modelId: "unlisted-model", reason: "missing", rows: 1 }),
    ]);
    expect(findUnpricedDelegatorModels(new Date("2026-09-29T00:00:00.000Z"))).toEqual([
      expect.objectContaining({ modelId: "anthropic/claude-opus-5", reason: "stale", rows: 1 }),
      expect.objectContaining({ modelId: "qwen3-30b-instruct", reason: "unavailable", rows: 1 }),
      expect.objectContaining({ modelId: "unlisted-model", reason: "missing", rows: 1 }),
    ]);
  });

  it("shows an operator-visible ledger warning when a newly recorded delegator has no price", () => {
    ensureDelegationCostSchema();
    recordDelegationCost(buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1, completionTokens: 1 },
      delegatorModelId: "new-unpriced-delegator",
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      cmdLedger(); // The production `homeserver ledger` command calls this exact path.
      expect(log.mock.calls.flat().join("\n")).toContain("PRICING WARNINGS");
      expect(log.mock.calls.flat().join("\n")).toContain("new-unpriced-delegator: missing");
    } finally {
      log.mockRestore();
    }
  });

  it("falls back to defaultDelegatorModelId, labels it 'default', and never books it as measured savings", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      defaultDelegatorModelId: "claude-sonnet-5",
    });

    expect(trace.costStatus).toBe("verified");
    expect(trace.delegatorModel).toBe("claude-sonnet-5");
    expect(trace.delegatorModelSource).toBe("default");
    // The estimate is still computed (it's useful, honest information)...
    expect(trace.actualBaselineCostUsd).toBeGreaterThan(0);
    expect(trace.potentialSavingsActualUsd).toBeGreaterThan(0);
    // ...but MUST NOT be reported as a measured/verified displacement.
    expect(trace.verifiedSavingsActualUsd).toBe(0);
    expect(trace.notes).toContain("delegator-model-defaulted:claude-sonnet-5");
    expect(trace.notes).toContain("actual-savings-not-measured-default-attribution");
  });

  it("prefers a caller stamp over the configured default when both are present", () => {
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      delegatorModelId: "claude-sonnet-5",
      defaultDelegatorModelId: "claude-fable-5",
    });

    expect(trace.delegatorModel).toBe("claude-sonnet-5");
    expect(trace.delegatorModelSource).toBe("stamped");
    expect(trace.verifiedSavingsActualUsd).toBeGreaterThan(0);
  });

  it("persists delegator_model_source so it survives a round trip through the ledger", () => {
    ensureDelegationCostSchema();
    const trace = buildDelegationCostTrace({
      taskType: "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: false,
      outcome: "pass",
      metrics: { promptTokens: 10, completionTokens: 20 },
      defaultDelegatorModelId: "claude-fable-5",
    });
    recordDelegationCost(trace);

    const db = getDb();
    const row = db.prepare(`SELECT * FROM delegation_costs WHERE id = ?`).get(trace.id) as Record<string, unknown>;
    expect(row["delegator_model"]).toBe("claude-fable-5");
    expect(row["delegator_model_source"]).toBe("default");
    expect(row["verified_savings_actual_usd"]).toBe(0);
  });

  it("migrates an existing delegation_costs table to include delegator_model_source", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-deleg-cost-migration-source-test-"));
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
        delegate_policy_mode TEXT,
        delegate_policy_action TEXT,
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
    expect(cols.has("delegator_model_source")).toBe(true);
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
