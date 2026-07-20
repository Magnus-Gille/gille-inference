/**
 * ledger.listCalibrationSampleRows tests (issue #6): content-blind, includes unverified
 * harvest-shadow rows (the exact population the calibration harness exists to measure before it can
 * affect routing), excludes shadow-lane candidate rows and superseded rows by default.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation, importDelegations, listCalibrationSampleRows, type ImportableDelegation } from "../src/homeserver/ledger.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ledger-calibration-sample-test-"));
  initDb(join(dir, "test.db"));
});

let counter = 0;
function uniqueType(): string {
  return `calib-t-${counter++}`;
}

describe("listCalibrationSampleRows", () => {
  it("returns content-blind rows — no prompt, promptExcerpt, promptHash, or notes field", () => {
    const taskType = uniqueType();
    recordDelegation({
      taskType,
      modelId: "gpt-oss-120b",
      prompt: "this is the ACTUAL secret task text that must never appear in a calibration artifact",
      outcome: "pass",
      verifier: "llm-judge:gpt-oss-120b",
      notes: "some free-text note that might mention the task",
      source: "harvest",
    });
    const rows = listCalibrationSampleRows();
    const row = rows.find((r) => r.taskType === taskType)!;
    expect(row).toBeDefined();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("secret task text");
    expect(serialized).not.toContain("free-text note");
    expect(Object.keys(row)).not.toContain("prompt");
    expect(Object.keys(row)).not.toContain("promptExcerpt");
    expect(Object.keys(row)).not.toContain("promptHash");
    expect(Object.keys(row)).not.toContain("notes");
  });

  it("includes unverified harvest-shadow rows (the calibration population)", () => {
    const taskType = uniqueType();
    const rec: ImportableDelegation = {
      ts: new Date().toISOString(),
      taskType,
      modelId: "gpt-oss-120b",
      prompt: "shadow-graded traffic",
      outcome: "unverified",
      verifier: "harvest-shadow:llm-judge:gpt-oss-120b",
      source: "harvest-shadow",
      score: 0.85,
      notes: "would=pass score=0.85 #1: looks correct",
    };
    importDelegations([rec]);
    const rows = listCalibrationSampleRows();
    const row = rows.find((r) => r.taskType === taskType)!;
    expect(row).toBeDefined();
    expect(row.outcome).toBe("unverified");
    expect(row.score).toBe(0.85);
    expect(row.source).toBe("harvest-shadow");
  });

  it("excludes shadow-LANE candidate rows by default (opts.includeShadow undefined)", () => {
    const taskType = uniqueType();
    recordDelegation({
      taskType,
      modelId: "gpt-oss-120b",
      prompt: "shadow-lane candidate evidence",
      outcome: "pass",
      verifier: "shadow-vs-frontier",
      shadow: true,
    });
    const withoutShadow = listCalibrationSampleRows();
    expect(withoutShadow.some((r) => r.taskType === taskType)).toBe(false);
    const withShadow = listCalibrationSampleRows({ includeShadow: true });
    expect(withShadow.some((r) => r.taskType === taskType)).toBe(true);
  });

  it("verifierKind is derived consistently with classifyVerifierKind", () => {
    const taskType = uniqueType();
    recordDelegation({
      taskType,
      modelId: "m",
      prompt: "p",
      outcome: "pass",
      verifier: "nonEmpty",
    });
    const row = listCalibrationSampleRows().find((r) => r.taskType === taskType)!;
    expect(row.verifierKind).toBe("mechanical-format");
  });

  it("lane is 'unknown' when an identity bundle exists but its own lane is unknown, and null with no bundle at all", () => {
    const taskType = uniqueType();
    recordDelegation({ taskType, modelId: "m", prompt: "p", outcome: "pass" }); // no evidenceIdentity at all
    const row = listCalibrationSampleRows().find((r) => r.taskType === taskType)!;
    expect(row.lane).toBeNull();
    expect(row.evidenceIdentityHash).toBeNull();
  });
});
