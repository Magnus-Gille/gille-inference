/**
 * TDD for T3 — wiring the evidence-based routing table into the orchestrator (default-off flag).
 *
 * The routing decision is a small pure function `routeViaTable()` so it is testable without mocking
 * the inference/backend modules. delegate() is a thin wrapper that acts on it. We also assert ONE
 * end-to-end behaviour with no network: flag ON + a gap type (sql) escalates to frontier BEFORE any
 * local-model resolution (so no getLoaded / no inference call is made).
 */
import { describe, it, expect, afterEach } from "vitest";
import { routeViaTable, delegate } from "../src/homeserver/orchestrator.js";
import { resetConfig, setConfig } from "../src/homeserver/config.js";
import { loadRoutingTable } from "../src/homeserver/routing-table.js";

// The table is GENERATED (#148/#149): the set of gap types changes as evidence accrues (sql was
// upgraded to a local explore route in #149). Derive a live gap type instead of pinning one.
const GAP_TYPE = loadRoutingTable().escalateToFrontier[0]!;
if (!GAP_TYPE) {
  // Explicit signal beats a confusing routeViaTable(undefined) mismatch downstream.
  throw new Error("docs/m5-routing.json has no escalateToFrontier types — update these tests to cover the all-local case");
}

describe("routeViaTable — pure routing-table decision", () => {
  it("flag OFF → always fallthrough (behaviour-preserving), even for a gap type", () => {
    expect(routeViaTable("sql", { enabled: false })).toEqual({ kind: "fallthrough" });
    expect(routeViaTable("reason-math", { enabled: false })).toEqual({ kind: "fallthrough" });
  });

  it("flag ON + a gap type → escalate to frontier", () => {
    expect(routeViaTable(GAP_TYPE, { enabled: true })).toEqual({ kind: "escalate" });
  });

  it("flag ON + a 80b-routed type (reason-math) → local on qwen3-coder-next-80b", () => {
    expect(routeViaTable("reason-math", { enabled: true })).toEqual({
      kind: "local",
      modelId: "qwen3-coder-next-80b",
    });
  });

  it("flag ON + a mellum-routed type (code-implement) → local on mellum", () => {
    expect(routeViaTable("code-implement", { enabled: true })).toEqual({
      kind: "local",
      modelId: "mellum",
    });
  });

  it("flag ON + an explicit task.modelId override → fallthrough (the override wins, even for sql)", () => {
    expect(routeViaTable("sql", { enabled: true, explicitModelId: "mellum" })).toEqual({
      kind: "fallthrough",
    });
    expect(routeViaTable("reason-math", { enabled: true, explicitModelId: "mellum" })).toEqual({
      kind: "fallthrough",
    });
  });

  it("flag ON + an UNKNOWN type (not in the table, e.g. 'other') → fallthrough", () => {
    expect(routeViaTable("other", { enabled: true })).toEqual({ kind: "fallthrough" });
  });
});

describe("delegate() — routing-table escalation (no network)", () => {
  afterEach(() => resetConfig());

  it("flag ON + a gap type (no frontierModelId, no modelId) → escalates to frontier without a local call", async () => {
    setConfig({ useRoutingTable: "on" });
    // No frontierModelId → callFrontier is a no-op (no OpenRouter call); no modelId → the routing
    // table decides BEFORE currentModel(), so getLoaded() is never reached (no backend hit).
    const outcome = await delegate({ taskType: GAP_TYPE, prompt: "a task of the characterized gap type" });
    expect(outcome.delegated).toBe(false);
    expect(outcome.escalate).toBe(true);
    expect(outcome.taskType).toBe(GAP_TYPE);
    expect(outcome.decisionReason.toLowerCase()).toContain("routing-table");
    // No local model was attempted.
    expect(outcome.modelId).toBe("(frontier)");
  });
  // (Flag-OFF behaviour-preservation is covered by routeViaTable(enabled:false)→fallthrough above
  //  and the full existing suite, without paying a real getLoaded() network timeout here.)
});
