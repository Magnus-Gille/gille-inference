import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import {
  getModelAggregates,
  getModelAggregatesWithAgreement,
} from "../src/analysis/stats.js";
import type { JudgeScores } from "../src/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GOOD: JudgeScores = {
  correctness: "good",
  completeness: "good",
  quality: "good",
};

let seq = 0;
function insertJudgedRun(
  db: Database.Database,
  batchId: string,
  taskId: string,
  modelId: string
): void {
  const runId = `run-${++seq}`;
  db.prepare(
    `INSERT INTO runs (id, batch_id, task_id, model_id, status, prompt, completion_tokens, cost_usd, created_at)
     VALUES (?, ?, ?, ?, 'completed', 'p', 100, 0, '2026-01-01T00:00:00Z')`
  ).run(runId, batchId, taskId, modelId);
  db.prepare(
    `INSERT INTO judge_records (id, run_id, judge_model, scores, rationale, created_at)
     VALUES (?, ?, 'openai/o4-mini', ?, 'r', '2026-01-01T00:00:00Z')`
  ).run(`jr-${seq}`, runId, JSON.stringify(GOOD));
}

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "stats-cat-test-"));
  return initDb(join(dir, "test.db"));
}

// ─── Regression: issue #1 ───────────────────────────────────────────────────
// "all delegated-work tasks are incorrectly categorized as non-coding".
// A delegated CODING task must land under its real category, never non-coding.

describe("task category classification (issue #1)", () => {
  it("places a delegated coding task under simple-coding, NOT non-coding", () => {
    const db = freshDb();
    insertJudgedRun(db, "b1", "delegated-code-001", "m/a");

    const [agg] = getModelAggregates(db, "b1");
    expect(agg).toBeDefined();
    expect(agg!.scoresByCategory["simple-coding"]).toHaveLength(1);
    expect(agg!.scoresByCategory["non-coding"]).toBeUndefined();
  });

  it("does NOT silently bucket an unregistered task_id as non-coding", () => {
    const db = freshDb();
    insertJudgedRun(db, "b2", "totally-unregistered-999", "m/a");

    const [agg] = getModelAggregates(db, "b2");
    expect(agg).toBeDefined();
    // The defect: unknown task_ids defaulted to "non-coding", silently
    // poisoning that bucket. They must land in an explicit "unknown" bucket.
    expect(agg!.scoresByCategory["non-coding"]).toBeUndefined();
    expect(agg!.scoresByCategory["unknown"]).toHaveLength(1);
  });

  it("getModelAggregatesWithAgreement applies the same classification", () => {
    const db = freshDb();
    insertJudgedRun(db, "b3", "delegated-code-001", "m/a");
    insertJudgedRun(db, "b3", "totally-unregistered-999", "m/a");

    const [agg] = getModelAggregatesWithAgreement(db, "b3");
    expect(agg).toBeDefined();
    expect(agg!.avgScoreByCategory["simple-coding"]).toBeDefined();
    expect(agg!.avgScoreByCategory["unknown"]).toBeDefined();
    expect(agg!.avgScoreByCategory["non-coding"]).toBeUndefined();
  });
});
