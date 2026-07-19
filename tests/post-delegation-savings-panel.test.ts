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
} from "../src/homeserver/delegation-cost.js";
import {
  buildSavingsByTaskPanel,
  buildSavingsTimeseriesPanel,
  hasDelegationCostsTable,
  openReadOnlySavingsDb,
  queryDailySavings,
  querySavingsByTaskType,
} from "../scripts/post-delegation-savings-panel.js";
import { PANEL_ID_RE } from "../src/homeserver/heimdall-push.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-savings-panel-test-"));
  initDb(join(dir, "test.db"));
  ensureDelegationCostSchema();
});

beforeEach(() => {
  getDb().prepare(`DELETE FROM delegation_costs`).run();
});

function insertTrace(over: {
  taskType?: string;
  outcome: "pass" | "unverified" | "error";
  promptTokens?: number;
  completionTokens?: number;
}): void {
  recordDelegationCost(
    buildDelegationCostTrace({
      taskType: over.taskType ?? "summarize",
      localModelId: "mellum",
      delegated: true,
      escalated: over.outcome === "error",
      outcome: over.outcome,
      metrics: {
        promptTokens: over.promptTokens ?? 100_000,
        completionTokens: over.completionTokens ?? 100_000,
      },
      delegatorModelId: "claude-fable-5",
      premiumBaselineModelId: "claude-fable-5",
    })
  );
}

describe("post-delegation-savings-panel", () => {
  it("detects whether delegation_costs exists", () => {
    expect(hasDelegationCostsTable(getDb())).toBe(true);
    const db = new Database(":memory:");
    expect(hasDelegationCostsTable(db)).toBe(false);
  });

  it("aggregates daily verified and potential savings separately", () => {
    insertTrace({ outcome: "pass" });
    insertTrace({ outcome: "unverified" });
    insertTrace({ outcome: "error" });

    const rows = queryDailySavings(getDb(), 1, Date.now(), 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.calls).toBe(3);
    expect(rows[0]!.verifiedCalls).toBe(1);
    expect(rows[0]!.unverifiedCalls).toBe(1);
    expect(rows[0]!.failedCalls).toBe(1);
    // Fable 100k+100k = $6. Verified row only → 60 SEK at rate 10.
    expect(rows[0]!.verifiedSavingsPremiumSek).toBe(60);
    // Verified + unverified potential → 120 SEK. Failed contributes zero.
    expect(rows[0]!.potentialSavingsPremiumSek).toBe(120);
  });

  it("aggregates savings by task type", () => {
    insertTrace({ taskType: "summarize", outcome: "pass" });
    insertTrace({ taskType: "extract", outcome: "unverified" });
    const rows = querySavingsByTaskType(getDb(), 1, Date.now(), 10);
    expect(rows.map((r) => r.taskType).sort()).toEqual(["extract", "summarize"]);
    expect(rows.find((r) => r.taskType === "summarize")?.verifiedCalls).toBe(1);
    expect(rows.find((r) => r.taskType === "extract")?.unverifiedCalls).toBe(1);
  });

  it("builds valid Heimdall panel ids", () => {
    const daily = queryDailySavings(getDb(), 1, Date.now(), 10);
    const byTask = querySavingsByTaskType(getDb(), 1, Date.now(), 10);
    const ts = buildSavingsTimeseriesPanel(daily, 1);
    const table = buildSavingsByTaskPanel(byTask, 1);
    expect(ts.kind).toBe("timeseries");
    expect(table.kind).toBe("table");
    expect(PANEL_ID_RE.test(ts.service)).toBe(true);
    expect(PANEL_ID_RE.test(ts.panel)).toBe(true);
    expect(PANEL_ID_RE.test(table.panel)).toBe(true);
  });

  it("zero-fills the daily series when the table is absent", () => {
    const db = new Database(":memory:");
    const rows = queryDailySavings(db, 3, Date.UTC(2026, 6, 8), 10);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.calls === 0 && r.verifiedSavingsPremiumSek === 0)).toBe(true);
  });

  it("opens a missing db path as an empty savings source", () => {
    const db = openReadOnlySavingsDb(join(tmpdir(), `missing-savings-${Date.now()}.db`));
    expect(hasDelegationCostsTable(db)).toBe(false);
    expect(querySavingsByTaskType(db, 1, Date.UTC(2026, 6, 8), 10)).toEqual([]);
    db.close();
  });
});
