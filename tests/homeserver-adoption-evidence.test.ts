import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "../src/db.js";
import {
  ADOPTION_EVIDENCE_OVERFLOW_COLUMNS,
  ADOPTION_EVIDENCE_COLUMNS,
  ADOPTION_CHECK_OUTCOMES,
  ADOPTION_HARNESSES,
  ADOPTION_TRAFFIC_PURPOSES,
  ADOPTION_USEFULNESS,
  MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY,
  ensureAdoptionEvidenceSchema,
  parseAdoptionEvidence,
  recordAdoptionEvidence,
  recordAdoptionEvidenceWithOutcome,
} from "../src/homeserver/adoption-evidence.js";
import { isAdoptionEvidenceToolCall } from "../src/homeserver/mcp.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-adoption-evidence-test-"));
  initDb(join(dir, "test.db"));
  ensureAdoptionEvidenceSchema();
});

beforeEach(() => {
  getDb().prepare("DELETE FROM adoption_evidence").run();
  getDb().prepare("DELETE FROM adoption_evidence_overflow").run();
});

const organicPass = {
  harness: "codex_cli",
  execution_mode: "code_loop",
  traffic_purpose: "organic",
  result: "completed",
  deterministic_check: "pass",
  reviewer_usefulness: "pass",
  fallback_reason: "none",
  eligible_opportunities: 1,
};

describe("M5 adoption evidence (#136)", () => {
  it("identifies only the exact adoption MCP call for the narrow correlation-log suppression", () => {
    expect(isAdoptionEvidenceToolCall(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "record_adoption_evidence", arguments: { prompt: "rejected before storage" } },
    }))).toBe(true);
    expect(isAdoptionEvidenceToolCall(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask", arguments: {} },
    }))).toBe(false);
    expect(isAdoptionEvidenceToolCall("not-json")).toBe(false);
  });

  it("accepts the closed, content-blind organic evidence shape", () => {
    expect(parseAdoptionEvidence(organicPass)).toEqual({ ok: true, value: expect.objectContaining({
      harness: "codex_cli",
      executionMode: "code_loop",
      trafficPurpose: "organic",
      result: "completed",
      deterministicCheck: "pass",
      reviewerUsefulness: "pass",
      fallbackReason: "none",
      eligibleOpportunities: 1,
    }) });
  });

  it("accepts every documented enum combination relevant to a successful ask", () => {
    let cases = 0;
    for (const harness of ADOPTION_HARNESSES) {
      for (const trafficPurpose of ADOPTION_TRAFFIC_PURPOSES) {
        for (const deterministicCheck of ADOPTION_CHECK_OUTCOMES) {
          for (const reviewerUsefulness of ADOPTION_USEFULNESS) {
            expect(parseAdoptionEvidence({
              harness,
              execution_mode: "ask",
              traffic_purpose: trafficPurpose,
              result: "completed",
              deterministic_check: deterministicCheck,
              reviewer_usefulness: reviewerUsefulness,
              fallback_reason: "none",
              eligible_opportunities: 1,
            })).toMatchObject({ ok: true });
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(270);
  });

  it("rejects content, paths, identity claims, and unbounded labels at ingress", () => {
    for (const forbidden of [
      { ...organicPass, prompt: "summarise a private document" },
      { ...organicPass, response: "private result" },
      { ...organicPass, repository: "Magnus-Gille/private-repo" },
      { ...organicPass, path: "/Users/magnus/private/file.ts" },
      { ...organicPass, reporter_id: "session-2026-07-31-abc" },
      { ...organicPass, harness: "a dynamically generated harness" },
    ]) {
      expect(parseAdoptionEvidence(forbidden)).toMatchObject({ ok: false });
    }
  });

  it("keeps missing M5 tool and auth fallbacks distinct from an attempted local failure", () => {
    const toolMissing = parseAdoptionEvidence({
      ...organicPass,
      result: "not_attempted",
      deterministic_check: "not_run",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_tool_missing",
      eligible_opportunities: 3,
    });
    const authUnavailable = parseAdoptionEvidence({
      ...organicPass,
      result: "not_attempted",
      deterministic_check: "not_run",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_auth_unavailable",
    });
    const attemptedFailure = parseAdoptionEvidence({
      ...organicPass,
      result: "failed",
      deterministic_check: "not_run",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_unreachable",
    });
    expect(toolMissing).toMatchObject({ ok: true, value: { result: "not_attempted", fallbackReason: "m5_tool_missing" } });
    expect(authUnavailable).toMatchObject({ ok: true, value: { result: "not_attempted", fallbackReason: "m5_auth_unavailable" } });
    expect(attemptedFailure).toMatchObject({ ok: true, value: { result: "failed", fallbackReason: "m5_unreachable" } });
  });

  it("accepts failed attempts with observed checks and unusable partial-review outcomes", () => {
    expect(parseAdoptionEvidence({
      ...organicPass,
      execution_mode: "ask",
      result: "failed",
      deterministic_check: "pass",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_unreachable",
    })).toMatchObject({ ok: true, value: { result: "failed", fallbackReason: "m5_unreachable" } });
    expect(parseAdoptionEvidence({
      ...organicPass,
      execution_mode: "ask",
      result: "failed",
      deterministic_check: "pass",
      reviewer_usefulness: "redo",
      fallback_reason: "local_result_unusable",
    })).toMatchObject({ ok: true, value: { result: "failed", reviewerUsefulness: "redo" } });
  });

  it("returns stable content-blind field and invariant diagnostics", () => {
    expect(parseAdoptionEvidence({ ...organicPass, prompt: "never echo this" })).toEqual({
      ok: false,
      error: { code: "unknown_field" },
    });
    expect(parseAdoptionEvidence({ ...organicPass, harness: "invalid" })).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "harness" },
    });
    expect(parseAdoptionEvidence({ ...organicPass, result: "completed", fallback_reason: "m5_busy" })).toEqual({
      ok: false,
      error: { code: "invalid_invariant", invariant: "completed_requires_no_fallback" },
    });
  });

  it("keeps fallback and unobserved-result assessments internally consistent", () => {
    expect(parseAdoptionEvidence({
      ...organicPass,
      result: "failed",
      deterministic_check: "fail",
      reviewer_usefulness: "wrong",
      fallback_reason: "local_result_unusable",
    })).toMatchObject({ ok: true });
    expect(parseAdoptionEvidence({
      ...organicPass,
      result: "refused",
      deterministic_check: "pass",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_refused",
    })).toEqual({
      ok: false,
      error: { code: "invalid_invariant", invariant: "unobserved_result_requires_unobserved_assessment" },
    });
    expect(parseAdoptionEvidence({ ...organicPass, result: "completed", fallback_reason: "m5_busy" })).toEqual({
      ok: false,
      error: { code: "invalid_invariant", invariant: "completed_requires_no_fallback" },
    });
    expect(parseAdoptionEvidence({
      ...organicPass,
      result: "not_attempted",
      deterministic_check: "not_run",
      reviewer_usefulness: "not_reported",
      fallback_reason: "none",
    })).toEqual({
      ok: false,
      error: { code: "invalid_invariant", invariant: "noncompleted_requires_fallback" },
    });
  });

  it("persists only the approved low-cardinality fields", () => {
    const parsed = parseAdoptionEvidence(organicPass);
    if (!parsed.ok) throw new Error("fixture must parse");
    recordAdoptionEvidence(parsed.value);

    const row = getDb().prepare("SELECT * FROM adoption_evidence").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      recorded_day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      harness: "codex_cli",
      execution_mode: "code_loop",
      traffic_purpose: "organic",
      result: "completed",
      deterministic_check: "pass",
      reviewer_usefulness: "pass",
      fallback_reason: "none",
      eligible_opportunities: 1,
    });
    expect(ADOPTION_EVIDENCE_COLUMNS).toEqual([
      "recorded_day",
      "harness",
      "execution_mode",
      "traffic_purpose",
      "result",
      "deterministic_check",
      "reviewer_usefulness",
      "fallback_reason",
      "eligible_opportunities",
    ]);
    expect(ADOPTION_EVIDENCE_COLUMNS.join(" ").toLowerCase()).not.toMatch(/prompt|response|content|path|repo|alias|identity|note|id|timestamp/);
  });

  it("keeps the direct storage boundary closed when an internal runtime caller bypasses TypeScript", () => {
    const parsed = parseAdoptionEvidence(organicPass);
    if (!parsed.ok) throw new Error("fixture must parse");

    expect(() => recordAdoptionEvidence({
      ...parsed.value,
      harness: "unbounded-runtime-label",
    } as unknown as typeof parsed.value)).toThrow("Invalid content-blind adoption report.");
    expect(getDb().prepare("SELECT count(*) AS count FROM adoption_evidence").get()).toEqual({ count: 0 });
  });

  it("caps individual server-day rows and durably aggregates later reports without an event id", () => {
    const parsed = parseAdoptionEvidence(organicPass);
    if (!parsed.ok) throw new Error("fixture must parse");
    const accepted = Array.from({ length: MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY + 1 }, () =>
      recordAdoptionEvidence(parsed.value)
    );
    expect(accepted.filter(Boolean)).toHaveLength(MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY + 1);
    expect(getDb().prepare("SELECT count(*) AS count FROM adoption_evidence").get()).toEqual({
      count: MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY,
    });
    expect(getDb().prepare("SELECT count(*) AS count FROM adoption_evidence_overflow").get()).toEqual({ count: 1 });
    expect(ADOPTION_EVIDENCE_COLUMNS).not.toContain("id");
  });

  it("aggregates post-cap outcomes without letting synthetic successes erase organic failures or usefulness", () => {
    const parsed = parseAdoptionEvidence(organicPass);
    if (!parsed.ok) throw new Error("fixture must parse");
    const syntheticSuccess = { ...parsed.value, trafficPurpose: "synthetic" as const };
    for (let i = 0; i < MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY; i += 1) {
      expect(recordAdoptionEvidenceWithOutcome(syntheticSuccess)).toBe("retained");
    }
    expect(recordAdoptionEvidenceWithOutcome(syntheticSuccess)).toBe("aggregated");

    const organicFailure = {
      ...parsed.value,
      result: "failed" as const,
      deterministicCheck: "fail" as const,
      reviewerUsefulness: "redo" as const,
      fallbackReason: "local_result_unusable" as const,
    };
    const organicRefusal = {
      ...parsed.value,
      result: "refused" as const,
      deterministicCheck: "not_run" as const,
      reviewerUsefulness: "not_reported" as const,
      fallbackReason: "m5_refused" as const,
    };
    expect(recordAdoptionEvidenceWithOutcome(organicFailure)).toBe("aggregated");
    expect(recordAdoptionEvidenceWithOutcome(organicFailure)).toBe("aggregated");
    expect(recordAdoptionEvidenceWithOutcome(organicRefusal)).toBe("aggregated");

    expect(getDb().prepare(
      `SELECT traffic_purpose, result, deterministic_check, reviewer_usefulness, fallback_reason,
              report_count, eligible_opportunities, unknown_opportunity_reports
       FROM adoption_evidence_overflow ORDER BY result`
    ).all()).toEqual([
      {
        traffic_purpose: "synthetic",
        result: "completed",
        deterministic_check: "pass",
        reviewer_usefulness: "pass",
        fallback_reason: "none",
        report_count: 1,
        eligible_opportunities: 1,
        unknown_opportunity_reports: 0,
      },
      {
        traffic_purpose: "organic",
        result: "failed",
        deterministic_check: "fail",
        reviewer_usefulness: "redo",
        fallback_reason: "local_result_unusable",
        report_count: 2,
        eligible_opportunities: 2,
        unknown_opportunity_reports: 0,
      },
      {
        traffic_purpose: "organic",
        result: "refused",
        deterministic_check: "not_run",
        reviewer_usefulness: "not_reported",
        fallback_reason: "m5_refused",
        report_count: 1,
        eligible_opportunities: 1,
        unknown_opportunity_reports: 0,
      },
    ]);
    expect(ADOPTION_EVIDENCE_OVERFLOW_COLUMNS).toEqual([
      "recorded_day",
      "traffic_purpose",
      "result",
      "deterministic_check",
      "reviewer_usefulness",
      "fallback_reason",
      "report_count",
      "eligible_opportunities",
      "unknown_opportunity_reports",
    ]);
    const overflowColumns = getDb().prepare("PRAGMA table_info(adoption_evidence_overflow)").all() as Array<{ name: string }>;
    expect(overflowColumns.map((column) => column.name)).toEqual([...ADOPTION_EVIDENCE_OVERFLOW_COLUMNS]);
    expect(ADOPTION_EVIDENCE_OVERFLOW_COLUMNS.join(" ")).not.toMatch(/harness|execution_mode|prompt|response|path|repository|repo_|alias|identity|note|timestamp/i);
  });

  it("tracks unknown denominators exactly across mixed coalesced overflow reports", () => {
    const parsed = parseAdoptionEvidence(organicPass);
    if (!parsed.ok) throw new Error("fixture must parse");
    for (let i = 0; i < MAX_ADOPTION_EVIDENCE_ROWS_PER_DAY; i += 1) {
      expect(recordAdoptionEvidenceWithOutcome(parsed.value)).toBe("retained");
    }
    expect(recordAdoptionEvidenceWithOutcome({ ...parsed.value, eligibleOpportunities: 0 })).toBe("aggregated");
    expect(recordAdoptionEvidenceWithOutcome({ ...parsed.value, eligibleOpportunities: 7 })).toBe("aggregated");
    expect(getDb().prepare(
      `SELECT report_count, eligible_opportunities, unknown_opportunity_reports
       FROM adoption_evidence_overflow`,
    ).get()).toEqual({ report_count: 2, eligible_opportunities: 7, unknown_opportunity_reports: 1 });
  });
});
