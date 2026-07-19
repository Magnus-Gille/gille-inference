import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  buildDelegationCostTrace,
  ensureDelegationCostSchema,
  recordDelegationCost,
  type DelegationPolicyAction,
} from "../src/homeserver/delegation-cost.js";
import {
  buildPolicyGrowthPanel,
  buildPolicyLanesPanel,
  buildPolicyStatusPanel,
  hasDelegatePolicyColumns,
  openReadOnlyPolicyDb,
  queryDailyPolicyCounts,
  queryPolicyLanes,
} from "../scripts/post-delegate-policy-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-policy-panel-test-"));
  initDb(join(dir, "test.db"));
  ensureDelegationCostSchema();
});

beforeEach(() => {
  getDb().prepare(`DELETE FROM delegation_costs`).run();
});

function insertPolicyTrace(over: {
  taskType?: string;
  model?: string;
  action: DelegationPolicyAction;
  outcome?: "pass" | "unverified" | "error";
  totalTokens?: number;
}): void {
  const total = over.totalTokens ?? 100;
  const outcome = over.outcome ?? (over.action === "allow" ? "pass" : "unverified");
  recordDelegationCost(
    buildDelegationCostTrace({
      taskType: over.taskType ?? "qa-factual",
      localModelId: over.model ?? "mellum",
      delegated: outcome !== "error",
      escalated: outcome === "error",
      outcome,
      metrics: outcome === "error" ? null : { promptTokens: Math.floor(total / 2), completionTokens: Math.ceil(total / 2) },
      delegatorModelId: "openai/gpt-5.5",
      premiumBaselineModelId: "claude-fable-5",
      delegatePolicyMode: "shadow",
      delegatePolicyAction: over.action,
    })
  );
}

describe("post-delegate-policy-panel", () => {
  it("detects whether delegation_costs has delegate-policy columns", () => {
    expect(hasDelegatePolicyColumns(getDb())).toBe(true);
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE delegation_costs (id TEXT PRIMARY KEY, ts TEXT NOT NULL)`);
    expect(hasDelegatePolicyColumns(db)).toBe(false);
  });

  it("aggregates daily delegate-policy action counts", () => {
    insertPolicyTrace({ action: "allow", outcome: "pass" });
    insertPolicyTrace({ action: "shadow", outcome: "unverified" });
    insertPolicyTrace({ action: "deny", outcome: "error" });

    const rows = queryDailyPolicyCounts(getDb(), 1, Date.now());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 3, allow: 1, shadow: 1, deny: 1, escalated: 1 });
  });

  it("builds top lane rows grouped by task/model/mode", () => {
    insertPolicyTrace({ taskType: "qa-factual", model: "mellum", action: "shadow", totalTokens: 20 });
    insertPolicyTrace({ taskType: "qa-factual", model: "mellum", action: "shadow", totalTokens: 30 });
    insertPolicyTrace({ taskType: "extract", model: "qwen3-coder-next-80b", action: "allow", outcome: "pass", totalTokens: 50 });

    const lanes = queryPolicyLanes(getDb(), 1, Date.now());
    expect(lanes[0]).toMatchObject({
      taskType: "qa-factual",
      model: "mellum",
      mode: "shadow",
      calls: 2,
      shadow: 2,
      totalTokens: 50,
    });
    expect(lanes.find((r) => r.taskType === "extract")?.allow).toBe(1);
  });

  it("builds valid Heimdall panels with an explanation that shadow is observational", () => {
    insertPolicyTrace({ action: "shadow" });
    const daily = queryDailyPolicyCounts(getDb(), 1, Date.now());
    const lanes = queryPolicyLanes(getDb(), 1, Date.now());
    const status = buildPolicyStatusPanel(daily, lanes, 1);
    const growth = buildPolicyGrowthPanel(daily, 1);
    const lanePanel = buildPolicyLanesPanel(lanes, 1);

    expect(status.kind).toBe("status");
    expect(status.message).toContain("Shadow mode only observes");
    expect(growth.kind).toBe("timeseries");
    expect(lanePanel.kind).toBe("table");
    for (const panel of [status, growth, lanePanel]) {
      expect(panel.service).toBe("m5-inference");
      expect(PANEL_ID_RE.test(panel.panel)).toBe(true);
    }
  });

  it("zero-fills when the table or policy columns are absent", () => {
    const empty = new Database(":memory:");
    expect(queryDailyPolicyCounts(empty, 2, Date.UTC(2026, 6, 8))).toEqual([
      { date: "2026-07-07", calls: 0, allow: 0, shadow: 0, deny: 0, escalated: 0 },
      { date: "2026-07-08", calls: 0, allow: 0, shadow: 0, deny: 0, escalated: 0 },
    ]);

    const old = new Database(":memory:");
    old.exec(`CREATE TABLE delegation_costs (id TEXT PRIMARY KEY, ts TEXT NOT NULL)`);
    expect(queryPolicyLanes(old, 1, Date.UTC(2026, 6, 8))).toEqual([]);
  });

  it("opens a missing db path as an empty policy source", () => {
    const db = openReadOnlyPolicyDb(join(tmpdir(), `missing-policy-${Date.now()}.db`));
    expect(hasDelegatePolicyColumns(db)).toBe(false);
    db.close();
  });
});
