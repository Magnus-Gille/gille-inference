import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "../src/db.js";
import { ensureAdoptionEvidenceSchema, parseAdoptionEvidence, recordAdoptionEvidence } from "../src/homeserver/adoption-evidence.js";
import {
  INITIAL_ADOPTION_TARGET,
  buildAdoptionPanels,
  queryLabAdoptionByPurpose,
  queryOrganicAdoptionByHarness,
} from "../scripts/post-m5-adoption-panel.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-m5-adoption-panel-test-"));
  initDb(join(dir, "test.db"));
  ensureAdoptionEvidenceSchema();
});

beforeEach(() => getDb().prepare("DELETE FROM adoption_evidence").run());

function report(overrides: Record<string, unknown> = {}): void {
  const parsed = parseAdoptionEvidence({
    harness: "codex_cli",
    execution_mode: "code_loop",
    traffic_purpose: "organic",
    result: "completed",
    deterministic_check: "pass",
    reviewer_usefulness: "pass",
    fallback_reason: "none",
    eligible_opportunities: 1,
    ...overrides,
  });
  if (!parsed.ok) throw new Error("invalid test adoption report");
  recordAdoptionEvidence(parsed.value);
}

describe("post-m5-adoption-panel (#136)", () => {
  it("keeps primary organic counts separate from formal evaluation and synthetic probes", () => {
    report();
    report({ traffic_purpose: "evaluation", harness: "evaluation_runner", execution_mode: "delegate", eligible_opportunities: 9 });
    report({ traffic_purpose: "synthetic", result: "not_attempted", deterministic_check: "not_run", reviewer_usefulness: "not_reported", fallback_reason: "m5_tool_missing" });

    const organic = queryOrganicAdoptionByHarness(getDb(), 7, Date.now());
    expect(organic).toEqual([expect.objectContaining({
      harness: "codex_cli",
      eligibleOpportunities: 1,
      attemptedDelegations: 1,
      usefulCompletions: 1,
      deterministicChecks: 1,
      deterministicCheckPasses: 1,
    })]);
    const lab = queryLabAdoptionByPurpose(getDb(), 7, Date.now());
    expect(lab).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "evaluation", reports: 1, eligibleOpportunities: 9 }),
      expect.objectContaining({ purpose: "synthetic", reports: 1 }),
    ]));
  });

  it("reports M5 tool and auth fallbacks as separate, content-free reason counts", () => {
    report();
    report({ result: "not_attempted", deterministic_check: "not_run", reviewer_usefulness: "not_reported", fallback_reason: "m5_tool_missing" });
    report({ result: "not_attempted", deterministic_check: "not_run", reviewer_usefulness: "not_reported", fallback_reason: "m5_auth_unavailable" });
    const organic = queryOrganicAdoptionByHarness(getDb(), 7, Date.now());
    expect(organic).toEqual([expect.objectContaining({
      harness: "codex_cli",
      reports: 3,
      eligibleOpportunities: 3,
      attemptedDelegations: 1,
      completed: 1,
      usefulCompletions: 1,
      deterministicChecks: 1,
      deterministicCheckPasses: 1,
      fallbackCounts: expect.objectContaining({
        none: 1,
        m5_tool_missing: 1,
        m5_auth_unavailable: 1,
      }),
    })]);
    const panels = buildAdoptionPanels(organic, queryLabAdoptionByPurpose(getDb(), 7, Date.now()), 7);
    const fallbacks = panels.fallbacks.rows;
    expect(fallbacks).toEqual(expect.arrayContaining([
      { reason: "m5_tool_missing", reports: 1 },
      { reason: "m5_auth_unavailable", reports: 1 },
    ]));
  });

  it("labels observed numbers as measured, collection separation as enforced, and routing as shadow only", () => {
    const panels = buildAdoptionPanels(queryOrganicAdoptionByHarness(getDb(), 7, Date.now()), [], 7);
    expect(panels.organic.label).toContain("MEASURED");
    expect(panels.organic.message).toContain("ENFORCED");
    expect(panels.organic.message).toContain("SHADOW");
    expect(panels.organic.detail?.cols).toEqual(["metric", "value"]);
    expect(panels.fallbacks.cols).toEqual(["reason", "reports"]);
    expect(panels.lab.cols).toEqual(["purpose", "reports", "known eligible opportunities", "attempted delegations", "completed"]);
  });

  it("predeclares a usefulness target and review date instead of optimizing raw call volume", () => {
    expect(INITIAL_ADOPTION_TARGET).toEqual({
      minKnownOrganicEligibleOpportunities: 20,
      minUsefulCompletionRate: 0.6,
      reviewDate: "2026-08-28",
    });
    const panels = buildAdoptionPanels(queryOrganicAdoptionByHarness(getDb(), 7, Date.now()), [], 7);
    expect(JSON.stringify(panels.organic.detail)).toContain("2026-08-28");
    expect(JSON.stringify(panels.organic.detail)).toContain("20");
  });
});
