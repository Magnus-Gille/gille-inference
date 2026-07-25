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
  buildSavingsTimeseriesPanels,
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
  delegatorModelId?: string | null;
  defaultDelegatorModelId?: string | null;
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
      delegatorModelId: over.delegatorModelId === undefined ? "claude-fable-5" : over.delegatorModelId,
      defaultDelegatorModelId: over.defaultDelegatorModelId,
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
    const ts = buildSavingsTimeseriesPanels(daily, 1);
    const table = buildSavingsByTaskPanel(byTask, 1);
    expect(ts.actual.kind).toBe("timeseries");
    expect(ts.premium.kind).toBe("timeseries");
    expect(table.kind).toBe("table");
    expect(PANEL_ID_RE.test(ts.actual.service)).toBe(true);
    expect(PANEL_ID_RE.test(ts.actual.panel)).toBe(true);
    expect(PANEL_ID_RE.test(ts.premium.panel)).toBe(true);
    expect(PANEL_ID_RE.test(table.panel)).toBe(true);
  });

  // #83: the panel that reported $0.00 actual savings across all 432 production rows, because the
  // top-level timeseries panel only ever plotted the premium-baseline number — the actual-baseline
  // series didn't exist at all. buildSavingsTimeseriesPanels must always return BOTH, as distinct
  // panels with distinct ids/labels, and never let the premium figure stand alone.
  it("returns the actual-baseline and premium-baseline savings as two distinct panels, never one alone", () => {
    insertTrace({ outcome: "pass" }); // stamped delegator, verified — feeds BOTH actual and premium
    const daily = queryDailySavings(getDb(), 1, Date.now(), 10);
    const panels = buildSavingsTimeseriesPanels(daily, 1);

    expect(panels.actual.panel).not.toBe(panels.premium.panel);
    expect(panels.actual.label.toLowerCase()).toContain("actual");
    expect(panels.premium.label.toLowerCase()).toContain("premium");
    // Fable 100k+100k = $6 → 60 SEK at rate 10, and this row is caller-stamped, so BOTH series
    // carry the same non-zero figure for a fully-stamped, fully-priced, verified row.
    expect(panels.actual.points[0]!.y).toBe(60);
    expect(panels.premium.points[0]!.y).toBe(60);
    // Every panel's own detail table also carries both figures side by side — auditable even in
    // isolation, not just when both panels happen to be viewed together.
    expect(panels.actual.detail?.cols).toEqual(expect.arrayContaining(["verified actual SEK", "verified premium SEK"]));
    expect(panels.premium.detail?.cols).toEqual(expect.arrayContaining(["verified actual SEK", "verified premium SEK"]));
  });

  it("keeps the actual-baseline series at zero for a default-attributed row while premium stays real", () => {
    insertTrace({ outcome: "pass", delegatorModelId: null, defaultDelegatorModelId: "claude-fable-5" });
    const daily = queryDailySavings(getDb(), 1, Date.now(), 10);
    expect(daily[0]!.defaultDelegatorCalls).toBe(1);
    expect(daily[0]!.stampedDelegatorCalls).toBe(0);

    const panels = buildSavingsTimeseriesPanels(daily, 1);
    // A defaulted attribution must never show up as measured actual savings...
    expect(panels.actual.points[0]!.y).toBe(0);
    // ...but the premium baseline (unaffected by delegator attribution) is unchanged.
    expect(panels.premium.points[0]!.y).toBe(60);
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
