/**
 * TDD test suite for routing-table.ts — the typed loader for docs/m5-routing.json.
 *
 * Written BEFORE the implementation (red→green). The routing table is the evidence-based
 * task_type → model map produced by the M5 cartography. Its key job for Gate B is to let us
 * compute ROUTING accuracy (does a prompt reach the right MODEL?) rather than raw top-1
 * task-type accuracy — the two diverge whenever distinct task types share a route
 * (e.g. regex / unit-test-gen / code-implement all → mellum), which is the whole point.
 */
import { describe, it, expect } from "vitest";
import {
  loadRoutingTable,
  routingTarget,
  FRONTIER,
  UNKNOWN_ROUTE,
  type RoutingTable,
} from "../src/homeserver/routing-table.js";

describe("loadRoutingTable", () => {
  it("reads the real docs/m5-routing.json and exposes the routing map", () => {
    const table = loadRoutingTable();
    expect(table.routing["code-implement"]?.model).toBe("mellum");
    expect(table.routing["reason-math"]?.model).toBe("qwen3-coder-next-80b");
    // The table is now GENERATED (#148/#149), so WHICH types escalate changes with the evidence —
    // don't pin a specific type; pin the invariant: every escalation type is a null-model route.
    expect(table.escalateToFrontier.length).toBeGreaterThan(0);
    for (const gap of table.escalateToFrontier) {
      expect(table.routing[gap]?.model ?? null).toBeNull();
    }
  });
});

describe("routingTarget", () => {
  it("maps a local task type to its serving model id", () => {
    expect(routingTarget("code-implement")).toBe("mellum");
    expect(routingTarget("reason-math")).toBe("qwen3-coder-next-80b");
  });

  it("ROUTING-EQUIVALENCE: regex and unit-test-gen route to the SAME model as code-implement", () => {
    // This is the crux of the Gate-B reframe: mellum classifying the `isZip`/`isEven`
    // cartography probes as code-implement is NOT a misroute — all three share a route.
    const ci = routingTarget("code-implement");
    expect(routingTarget("regex")).toBe(ci);
    expect(routingTarget("unit-test-gen")).toBe(ci);
  });

  it("maps an escalation type to the FRONTIER sentinel (model: null / verdict)", () => {
    // Derive the gap type from the (generated) table instead of pinning one — the set of
    // escalation types changes as evidence accrues (e.g. sql was upgraded to explore in #149).
    const gap = loadRoutingTable().escalateToFrontier[0]!;
    expect(routingTarget(gap)).toBe(FRONTIER);
  });

  it("a math/rewrite type does NOT collapse to the mellum cluster (a genuine cross-model boundary)", () => {
    // reason-math and rewrite go to the 80b — so misclassifying them as a mellum type IS a
    // real routing error (math sent to mellum, which fails math). routingTarget must keep them distinct.
    expect(routingTarget("reason-math")).not.toBe(routingTarget("code-implement"));
    expect(routingTarget("rewrite")).not.toBe(routingTarget("code-implement"));
  });

  it("returns UNKNOWN_ROUTE for a task type absent from the table (e.g. 'other')", () => {
    expect(routingTarget("other")).toBe(UNKNOWN_ROUTE);
    expect(routingTarget("definitely-not-a-type")).toBe(UNKNOWN_ROUTE);
  });

  it("accepts an injected table for deterministic testing", () => {
    const fake: RoutingTable = {
      routing: {
        alpha: { model: "m-a", passRate: 1, tokPerSec: 1, verdict: "delegate-local" },
        beta: { model: null, passRate: 0.5, tokPerSec: null, verdict: "escalate-frontier" },
        gamma: { model: "m-g", passRate: 0.6, tokPerSec: 1, verdict: "explore" },
      },
      escalateToFrontier: ["beta"],
    };
    expect(routingTarget("alpha", fake)).toBe("m-a");
    expect(routingTarget("beta", fake)).toBe(FRONTIER);
    // "explore" verdict is still a LOCAL route (lower confidence), so it maps to its model.
    expect(routingTarget("gamma", fake)).toBe("m-g");
    expect(routingTarget("missing", fake)).toBe(UNKNOWN_ROUTE);
  });

  it("treats a null model as FRONTIER even if escalateToFrontier omits it (defense in depth)", () => {
    const fake: RoutingTable = {
      routing: { orphan: { model: null, passRate: 0.4, tokPerSec: null, verdict: "delegate-local" } },
      escalateToFrontier: [],
    };
    expect(routingTarget("orphan", fake)).toBe(FRONTIER);
  });

  it("treats an EMPTY or whitespace-only model as FRONTIER (config-drift safety — no valid local id)", () => {
    // A hand-edited m5-routing.json with `"model": ""` (or all-whitespace) names no real model;
    // routingTarget must escalate, not emit a blank id that would later flow into an inference call.
    const fake = {
      routing: {
        blank: { model: "", passRate: 1, tokPerSec: 1, verdict: "delegate-local" },
        spaces: { model: "   ", passRate: 1, tokPerSec: 1, verdict: "delegate-local" },
      },
      escalateToFrontier: [],
    } as unknown as RoutingTable;
    expect(routingTarget("blank", fake)).toBe(FRONTIER);
    expect(routingTarget("spaces", fake)).toBe(FRONTIER);
  });

  it("treats a MISSING model key as FRONTIER (config-drift safety — never return undefined)", () => {
    // A hand-edited m5-routing.json that drops or misspells `model` on an entry leaves
    // entry.model === undefined. routingTarget must escalate (FRONTIER), not leak a
    // non-string `undefined` from its `: string` contract. This is the exact drift Gate B guards.
    const fake = {
      routing: { dropped: { passRate: 1, tokPerSec: 1, verdict: "delegate-local" } },
      escalateToFrontier: [],
    } as unknown as RoutingTable;
    expect(routingTarget("dropped", fake)).toBe(FRONTIER);
  });

  it("returns UNKNOWN_ROUTE for prototype-named task types absent from the table (no inherited-property leak)", () => {
    // #155 made resolveTaskType() preserve arbitrary caller-supplied task types verbatim, so a
    // caller can now send a taskType that collides with a JS prototype property name. A plain
    // `t.routing[taskType]` lookup would resolve "__proto__"/"constructor"/"toString"/… to an
    // INHERITED object/function (truthy, but with model===undefined) and wrongly escalate to
    // FRONTIER. An absent type — prototype-named or not — must fall through to UNKNOWN_ROUTE so
    // routeViaTable() resolves it the normal way, per routingTarget's documented contract.
    const fake: RoutingTable = {
      routing: { alpha: { model: "m-a", passRate: 1, tokPerSec: 1, verdict: "delegate-local" } },
      escalateToFrontier: [],
    };
    for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
      expect(routingTarget(key, fake)).toBe(UNKNOWN_ROUTE);
    }
    // a genuine own-property route still resolves normally (guard doesn't over-reach)
    expect(routingTarget("alpha", fake)).toBe("m-a");
  });
});
