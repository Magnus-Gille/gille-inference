/**
 * Issue #166 — JSON-shaped task types are declaratively marked so the delegate path can
 * grammar-constrain their output (prevents gpt-oss-120b's harmony/PEG 500).
 *
 * `taskTypeEmitsJson` is the pure signal `resolveResponseFormat` keys off. These tests pin WHICH task
 * types are JSON-shaped (triage — the workload that produced 27/120 harmony 500s in #164 — and
 * source-distill) and that prose types are NOT, so a future taxonomy edit can't silently change which
 * tasks get constrained decoding.
 */
import { describe, it, expect } from "vitest";
import { TASK_TYPES, taskTypeEmitsJson, isKnownTaskType } from "../src/homeserver/taxonomy.js";

describe("taskTypeEmitsJson — JSON-shaped task-type signal (#166)", () => {
  it("is true for the structured-JSON task types", () => {
    expect(taskTypeEmitsJson("triage")).toBe(true);
    expect(taskTypeEmitsJson("source-distill")).toBe(true);
  });

  it("is false for prose / free-text task types", () => {
    expect(taskTypeEmitsJson("qa-factual")).toBe(false);
    expect(taskTypeEmitsJson("code-implement")).toBe(false);
    expect(taskTypeEmitsJson("summarize")).toBe(false);
    expect(taskTypeEmitsJson("synthesis")).toBe(false);
    expect(taskTypeEmitsJson("other")).toBe(false);
  });

  it("is false for an unknown task type", () => {
    expect(taskTypeEmitsJson("does-not-exist")).toBe(false);
    expect(taskTypeEmitsJson("")).toBe(false);
  });

  it("every jsonOutput-marked type is a known task type (no typo drift)", () => {
    for (const t of TASK_TYPES) {
      if (t.jsonOutput) expect(isKnownTaskType(t.id)).toBe(true);
    }
  });

  it("the marker and the helper agree for every task type", () => {
    for (const t of TASK_TYPES) {
      expect(taskTypeEmitsJson(t.id)).toBe(Boolean(t.jsonOutput));
    }
  });
});
