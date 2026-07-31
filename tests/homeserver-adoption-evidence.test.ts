import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "../src/db.js";
import {
  ADOPTION_EVIDENCE_COLUMNS,
  ensureAdoptionEvidenceSchema,
  parseAdoptionEvidence,
  recordAdoptionEvidence,
} from "../src/homeserver/adoption-evidence.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-adoption-evidence-test-"));
  initDb(join(dir, "test.db"));
  ensureAdoptionEvidenceSchema();
});

beforeEach(() => {
  getDb().prepare("DELETE FROM adoption_evidence").run();
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

  it("rejects content, paths, identity claims, and unbounded labels at ingress", () => {
    for (const forbidden of [
      { ...organicPass, prompt: "summarise a private document" },
      { ...organicPass, response: "private result" },
      { ...organicPass, repository: "Magnus-Gille/private-repo" },
      { ...organicPass, path: "/Users/magnus/private/file.ts" },
      { ...organicPass, reporter_id: "session-2026-07-31-abc" },
      { ...organicPass, harness: "a dynamically generated harness" },
    ]) {
      expect(parseAdoptionEvidence(forbidden)).toEqual({ ok: false });
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

  it("requires content-free usefulness and check fields to agree with the execution result", () => {
    expect(parseAdoptionEvidence({ ...organicPass, result: "failed", reviewer_usefulness: "wrong" })).toEqual({ ok: false });
    expect(parseAdoptionEvidence({ ...organicPass, result: "failed", deterministic_check: "fail", reviewer_usefulness: "not_reported", fallback_reason: "m5_unreachable" })).toEqual({ ok: false });
    expect(parseAdoptionEvidence({ ...organicPass, result: "completed", fallback_reason: "m5_busy" })).toEqual({ ok: false });
    expect(parseAdoptionEvidence({ ...organicPass, result: "not_attempted", deterministic_check: "not_run", reviewer_usefulness: "not_reported", fallback_reason: "none" })).toEqual({ ok: false });
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
});
