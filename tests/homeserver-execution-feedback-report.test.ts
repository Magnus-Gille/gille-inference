import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb, initDb } from "../src/db.js";
import { recordDelegation } from "../src/homeserver/ledger.js";
import { bindExecutionFeedback } from "../src/homeserver/execution-feedback.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildExecutionFeedbackReport,
  EXECUTION_FEEDBACK_REPORT_CONTRACT,
} from "../src/homeserver/execution-feedback-report.js";
import { EXECUTION_FEEDBACK_EPOCH } from "../src/homeserver/execution-feedback-contract.js";

const SINCE = "2026-09-01T00:00:00.000Z";
const UNTIL = "2026-09-02T00:00:00.000Z";

function dbWithSchema(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE delegations (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, task_type TEXT NOT NULL, node_id TEXT NOT NULL,
      model_id TEXT NOT NULL, outcome TEXT NOT NULL, source TEXT, shadow INTEGER NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE execution_feedback (
      handle TEXT PRIMARY KEY, ledger_id TEXT UNIQUE, principal_hash TEXT, surface TEXT NOT NULL,
      traffic_purpose TEXT NOT NULL, epoch TEXT NOT NULL, usefulness TEXT, conflict_count INTEGER NOT NULL,
      available INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

function insertDelegation(db: Database.Database, id: string, overrides: Record<string, unknown> = {}): void {
  const row = {
    ts: "2026-09-01T12:00:00.000Z", task_type: "code-edit", node_id: "m5", model_id: "mellum",
    outcome: "ok", source: "mcp", shadow: 0, superseded_at: null, ...overrides,
  };
  db.prepare("INSERT INTO delegations (id, ts, task_type, node_id, model_id, outcome, source, shadow, superseded_at) VALUES (@id, @ts, @task_type, @node_id, @model_id, @outcome, @source, @shadow, @superseded_at)").run({ id, ...row });
}

function insertFeedback(db: Database.Database, handle: string, ledgerId: string, overrides: Record<string, unknown> = {}): void {
  const row = {
    surface: "ask", traffic_purpose: "organic", epoch: EXECUTION_FEEDBACK_EPOCH,
    usefulness: null, conflict_count: 0, ...overrides,
  };
  db.prepare("INSERT INTO execution_feedback (handle, ledger_id, principal_hash, surface, traffic_purpose, epoch, usefulness, conflict_count) VALUES (@handle, @ledgerId, @principalHash, @surface, @traffic_purpose, @epoch, @usefulness, @conflict_count)").run({
    handle, ledgerId, principalHash: "sha256:owner-only", ...row,
  });
}

describe("execution feedback report", () => {
  it("uses completed feedback joins as the denominator and applies current organic/epoch filters", () => {
    const db = dbWithSchema();
    insertDelegation(db, "eligible-pass");
    insertFeedback(db, "opaque-pass", "eligible-pass", { usefulness: "pass" });
    insertDelegation(db, "eligible-missing");
    insertFeedback(db, "opaque-missing", "eligible-missing");

    insertDelegation(db, "shadow", { shadow: 1 });
    insertFeedback(db, "opaque-shadow", "shadow", { usefulness: "wrong" });
    insertDelegation(db, "superseded", { superseded_at: "2026-09-01T13:00:00.000Z" });
    insertFeedback(db, "opaque-superseded", "superseded", { usefulness: "redo" });
    insertDelegation(db, "other-node", { node_id: "orin" });
    insertFeedback(db, "opaque-other-node", "other-node", { usefulness: "partial" });
    insertDelegation(db, "failed", { outcome: "error" });
    insertFeedback(db, "opaque-failed", "failed", { usefulness: "wrong" });
    insertDelegation(db, "pending-durable");
    insertFeedback(db, "opaque-pending", "pending-durable");
    db.prepare("UPDATE execution_feedback SET available = 0 WHERE handle = ?").run("opaque-pending");

    insertDelegation(db, "evaluation");
    insertFeedback(db, "opaque-evaluation", "evaluation", { traffic_purpose: "evaluation" });
    insertDelegation(db, "synthetic");
    insertFeedback(db, "opaque-synthetic", "synthetic", { traffic_purpose: "synthetic" });
    insertDelegation(db, "unknown-purpose");
    insertFeedback(db, "opaque-unknown", "unknown-purpose", { traffic_purpose: "unknown" });
    insertDelegation(db, "old-epoch");
    insertFeedback(db, "opaque-old-epoch", "old-epoch", { epoch: "old-epoch" });
    insertDelegation(db, "outside-window", { ts: "2026-09-02T00:00:00.000Z" });
    insertFeedback(db, "opaque-outside", "outside-window", { usefulness: "pass" });

    const report = buildExecutionFeedbackReport(db, { since: SINCE, until: UNTIL });
    expect(report).toMatchObject({
      contract: EXECUTION_FEEDBACK_REPORT_CONTRACT,
      epoch: EXECUTION_FEEDBACK_EPOCH,
      availability: "available",
      completed: 2, assessed: 1, missing: 1, coverage: 0.5,
      excluded: { evaluation: 1, synthetic: 1, unknown: 1, epoch: 1, ineligible: 5 },
    });
    expect(report.rows).toEqual([{
      model: "mellum", task: "code-edit", source: "mcp", surface: "ask",
      completed: 2, assessed: 1, missing: 1, pass: 1, partial: 0, redo: 0, wrong: 0, coverage: 0.5,
    }]);
  });

  it("preserves the supported qwen36-a3b model as an exact closed bucket", () => {
    const db = dbWithSchema();
    insertDelegation(db, "qwen36-completed", { model_id: "qwen36-a3b" });
    insertFeedback(db, "opaque-qwen36", "qwen36-completed", { usefulness: "pass" });

    const report = buildExecutionFeedbackReport(db, { since: SINCE, until: UNTIL });
    expect(report.rows).toContainEqual({
      model: "qwen36-a3b", task: "code-edit", source: "mcp", surface: "ask",
      completed: 1, assessed: 1, missing: 0, pass: 1, partial: 0, redo: 0, wrong: 0, coverage: 1,
    });
    expect(report.rows.some((row) => row.model === "other")).toBe(false);
  });

  it("joins a real recordDelegation timestamp through an owner-visible feedback binding", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "execution-feedback-report-integration-")), "test.db");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    try {
      initDb(dbPath);
      const owner = { keyHash: "sha256:integration-owner", alias: "integration-owner" };
      const ledgerId = recordDelegation({
        taskType: "summarize",
        modelId: "mellum",
        prompt: "owner-visible integration output",
        outcome: "unverified",
        source: "mcp-ask",
        keyAlias: owner.alias,
      });
      expect(getDb().prepare("SELECT ts FROM delegations WHERE id = ?").get(ledgerId))
        .toEqual({ ts: "2026-09-01T12:00:00.000Z" });

      const handle = bindExecutionFeedback({
        ledgerId,
        owner,
        surface: "ask",
        trafficPurpose: "organic",
        outputAvailable: true,
      });
      expect(handle).toMatch(/^[0-9a-f-]{36}$/);

      const report = buildExecutionFeedbackReport(getDb(), { since: SINCE, until: UNTIL });
      expect(report).toMatchObject({
        availability: "available",
        completed: 1,
        assessed: 0,
        missing: 1,
        coverage: 0,
      });
      expect(report.rows).toEqual([{
        model: "mellum", task: "summarize", source: "mcp-ask", surface: "ask",
        completed: 1, assessed: 0, missing: 1, pass: 0, partial: 0, redo: 0, wrong: 0, coverage: 0,
      }]);
    } finally {
      closeDb();
      vi.useRealTimers();
    }
  });

  it("keeps every exported dimension closed and does not echo identity or content-shaped values", () => {
    const db = dbWithSchema();
    insertDelegation(db, "secret-ledger", {
      task_type: "prompt contains private/path", model_id: "attacker/model", source: "secret://repo/private",
    });
    insertFeedback(db, "secret-handle", "secret-ledger", {
      surface: "surface-with-prompt", principal_hash: "owner@example.test", usefulness: "not-a-valid-judgment",
    });

    const report = buildExecutionFeedbackReport(db, { since: SINCE, until: UNTIL });
    expect(report.rows).toEqual([{
      model: "other", task: "other", source: "other", surface: "unknown",
      completed: 1, assessed: 0, missing: 1, pass: 0, partial: 0, redo: 0, wrong: 0, coverage: 0,
    }]);
    const serialized = JSON.stringify(report);
    for (const secret of ["secret-ledger", "secret-handle", "owner@example.test", "private/path", "attacker/model", "secret://repo/private", "surface-with-prompt"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("fails closed for absent or incomplete tables instead of claiming zero evidence", () => {
    const empty = new Database(":memory:");
    expect(buildExecutionFeedbackReport(empty, { since: SINCE, until: UNTIL })).toMatchObject({
      availability: "unavailable", unavailableReason: "missing_table", completed: null, coverage: null, excluded: null,
    });

    const incomplete = new Database(":memory:");
    incomplete.exec("CREATE TABLE delegations (id TEXT, ts TEXT, node_id TEXT, shadow INTEGER, superseded_at TEXT, outcome TEXT, model_id TEXT, task_type TEXT); CREATE TABLE execution_feedback (ledger_id TEXT, surface TEXT, traffic_purpose TEXT, epoch TEXT, usefulness TEXT);");
    expect(buildExecutionFeedbackReport(incomplete, { since: SINCE, until: UNTIL })).toMatchObject({
      availability: "unavailable", unavailableReason: "missing_column", completed: null, coverage: null,
    });
  });

  it("returns null coverage for an empty eligible window and rejects non-canonical bounds", () => {
    const db = dbWithSchema();
    const report = buildExecutionFeedbackReport(db, { since: SINCE, until: UNTIL });
    expect(report.rows).toEqual([]);
    expect(report).toMatchObject({ availability: "available", completed: 0, assessed: 0, missing: 0, coverage: null });
    expect(() => buildExecutionFeedbackReport(db, { since: "2026-09-01T00:00:00+00:00", until: UNTIL })).toThrow();
    expect(() => buildExecutionFeedbackReport(db, { since: UNTIL, until: SINCE })).toThrow();
  });
});
