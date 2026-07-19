/**
 * TDD suite for routing-table-diff.ts — the semantic diff + capability-regression alarm
 * for docs/m5-routing.json regeneration (issue #151).
 *
 * Written BEFORE the implementation (red→green). Incident (2026-07-04, #150): during routing-table
 * adoption, reason-hard silently regressed delegate-local → escalate-frontier because its probe
 * evidence was lost from disk. The generator failed SAFE but also failed SILENT — a downgrade of a
 * measured capability must be an alerted event requiring explicit acknowledgment, and "evidence
 * expected but missing" must be distinguished from "genuinely never probed".
 */
import { describe, it, expect } from "vitest";
import {
  diffRoutingTables,
  formatRoutingDiff,
  verdictRank,
  type DiffableRoutingTable,
} from "../src/homeserver/routing-table-diff.js";

// ── Helpers ─────────────────────────────────────────────────────────────────────

function table(routing: DiffableRoutingTable["routing"]): DiffableRoutingTable {
  return { routing, generatedAt: "2026-07-04T00:00:00.000Z" };
}

const LOCAL_80B = { model: "qwen3-coder-next-80b", verdict: "delegate-local", attempts: 20 };
const LOCAL_MELLUM = { model: "mellum", verdict: "delegate-local", attempts: 12 };
const PENDING_HOLE = { model: null, verdict: "escalate-frontier", attempts: 0 };

// ── verdictRank ─────────────────────────────────────────────────────────────────

describe("verdictRank — capability ordering", () => {
  it("orders delegate-local > explore > escalate-frontier", () => {
    expect(verdictRank({ model: "m", verdict: "delegate-local" })).toBe(2);
    expect(verdictRank({ model: "m", verdict: "explore" })).toBe(1);
    expect(verdictRank({ model: null, verdict: "escalate-frontier" })).toBe(0);
  });

  it("a null/blank/missing model ranks as frontier regardless of the verdict string (drift safety)", () => {
    expect(verdictRank({ model: null, verdict: "delegate-local" })).toBe(0);
    expect(verdictRank({ model: "  ", verdict: "delegate-local" })).toBe(0);
    expect(verdictRank({ verdict: "delegate-local" })).toBe(0);
  });

  it("an unrecognized verdict with a real model ranks as explore-level (conservative middle)", () => {
    expect(verdictRank({ model: "m", verdict: "viable-ish" })).toBe(1);
  });
});

// ── The incident: lost evidence must surface as a MISSING-EVIDENCE downgrade ───────

describe("diffRoutingTables — the reason-hard incident (evidence expected but MISSING)", () => {
  it("flags delegate-local → pending-hole as a downgrade WITH evidenceMissing", () => {
    // Exactly the #150 incident: the adopted table routes reason-hard locally on probe evidence;
    // regeneration finds NO evidence (attempts 0) and would quietly emit escalate-frontier.
    const diff = diffRoutingTables(
      table({ "reason-hard": LOCAL_80B }),
      table({ "reason-hard": PENDING_HOLE })
    );
    expect(diff.downgrades).toHaveLength(1);
    const d = diff.downgrades[0]!;
    expect(d.taskType).toBe("reason-hard");
    expect(d.kind).toBe("downgrade");
    expect(d.evidenceMissing).toBe(true);
    expect(diff.missingEvidence).toHaveLength(1);
  });

  it("a task type REMOVED from the table is a downgrade with evidenceMissing", () => {
    const diff = diffRoutingTables(table({ "reason-hard": LOCAL_80B }), table({}));
    expect(diff.downgrades).toHaveLength(1);
    expect(diff.downgrades[0]?.kind).toBe("removed");
    expect(diff.downgrades[0]?.evidenceMissing).toBe(true);
  });

  it("distinguishes a MEASURED regression (evidence present, model failed) from missing evidence", () => {
    const diff = diffRoutingTables(
      table({ sql: { model: "qwen3-coder-next-80b", verdict: "explore", attempts: 6 } }),
      table({ sql: { model: null, verdict: "escalate-frontier", attempts: 9 } })
    );
    expect(diff.downgrades).toHaveLength(1);
    expect(diff.downgrades[0]?.evidenceMissing).toBe(false);
    expect(diff.missingEvidence).toHaveLength(0);
  });

  it("flags PARTIAL evidence loss as missing too (attempts shrank below the adopted level)", () => {
    // Self-review finding (PR #153): a truncated re-import can leave SOME attempts (e.g. 4 of 20)
    // — below minSamples the generator emits escalate-frontier with attempts>0. That is still the
    // missing-evidence class (restore it!), not a measured capability loss.
    const diff = diffRoutingTables(
      table({ "reason-hard": LOCAL_80B }), // attempts: 20
      table({ "reason-hard": { model: null, verdict: "escalate-frontier", attempts: 4 } })
    );
    expect(diff.downgrades).toHaveLength(1);
    expect(diff.downgrades[0]?.evidenceMissing).toBe(true);
  });

  it("a genuinely never-probed type (frontier hole in BOTH tables) is quiet — no downgrade", () => {
    const diff = diffRoutingTables(
      table({ "code-edit": PENDING_HOLE }),
      table({ "code-edit": PENDING_HOLE })
    );
    expect(diff.downgrades).toHaveLength(0);
    expect(diff.changes.filter((c) => c.kind !== "unchanged")).toHaveLength(0);
  });
});

// ── Other change kinds ──────────────────────────────────────────────────────────

describe("diffRoutingTables — change classification", () => {
  it("delegate-local → explore is a downgrade (capability confidence dropped)", () => {
    const diff = diffRoutingTables(
      table({ rewrite: LOCAL_80B }),
      table({ rewrite: { model: "qwen3-coder-next-80b", verdict: "explore", attempts: 8 } })
    );
    expect(diff.downgrades).toHaveLength(1);
    expect(diff.downgrades[0]?.evidenceMissing).toBe(false);
  });

  it("escalate-frontier → delegate-local is an upgrade, not alarmed", () => {
    const diff = diffRoutingTables(table({ sql: PENDING_HOLE }), table({ sql: LOCAL_80B }));
    expect(diff.downgrades).toHaveLength(0);
    expect(diff.changes.find((c) => c.taskType === "sql")?.kind).toBe("upgrade");
  });

  it("a lateral model change at equal verdict is model-change, not a downgrade", () => {
    const diff = diffRoutingTables(
      table({ classify: LOCAL_MELLUM }),
      table({ classify: { model: "qwen36-a3b", verdict: "delegate-local", attempts: 5 } })
    );
    expect(diff.downgrades).toHaveLength(0);
    expect(diff.changes.find((c) => c.taskType === "classify")?.kind).toBe("model-change");
  });

  it("a brand-new task type is added, not alarmed", () => {
    const diff = diffRoutingTables(table({}), table({ "reason-date": LOCAL_MELLUM }));
    expect(diff.downgrades).toHaveLength(0);
    expect(diff.changes.find((c) => c.taskType === "reason-date")?.kind).toBe("added");
  });

  it("covers every task type from BOTH tables exactly once, sorted", () => {
    const diff = diffRoutingTables(
      table({ a: LOCAL_MELLUM, b: PENDING_HOLE }),
      table({ b: PENDING_HOLE, c: LOCAL_80B })
    );
    expect(diff.changes.map((c) => c.taskType)).toEqual(["a", "b", "c"]);
  });

  it("tolerates a hand-edited legacy table with no attempts field", () => {
    const diff = diffRoutingTables(
      table({ "reason-hard": { model: "qwen3-coder-next-80b", verdict: "delegate-local" } }),
      table({ "reason-hard": PENDING_HOLE })
    );
    expect(diff.downgrades).toHaveLength(1);
    expect(diff.downgrades[0]?.evidenceMissing).toBe(true);
  });
});

// ── Human-readable report ────────────────────────────────────────────────────────

describe("formatRoutingDiff", () => {
  it("names the downgraded type, both routes, and marks missing evidence loudly", () => {
    const diff = diffRoutingTables(
      table({ "reason-hard": LOCAL_80B }),
      table({ "reason-hard": PENDING_HOLE })
    );
    const text = formatRoutingDiff(diff);
    expect(text).toMatch(/reason-hard/);
    expect(text).toMatch(/delegate-local/);
    expect(text).toMatch(/escalate-frontier/);
    expect(text).toMatch(/MISSING/i);
    expect(text).toMatch(/DOWNGRADE/i);
  });

  it("says 'no semantic changes' when the tables are routing-equivalent", () => {
    const diff = diffRoutingTables(table({ a: LOCAL_MELLUM }), table({ a: LOCAL_MELLUM }));
    expect(formatRoutingDiff(diff)).toMatch(/no semantic (routing )?changes/i);
  });
});
