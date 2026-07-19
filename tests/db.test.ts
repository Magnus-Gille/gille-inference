import { describe, it, expect, afterEach } from "vitest";
import { rmSync, existsSync } from "node:fs";
import { initDb } from "../src/db.js";

const TEST_DB = "./data/test-eval.db";

afterEach(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

describe("initDb", () => {
  it("creates the database file and tables", () => {
    const db = initDb(TEST_DB);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const names = tables.map((t) => t.name);
    expect(names).toContain("runs");
    expect(names).toContain("judge_records");

    db.close();
  });

  it("enables WAL journal mode", () => {
    const db = initDb(TEST_DB);

    const row = db.pragma("journal_mode") as { journal_mode: string }[];
    expect(row[0]?.journal_mode).toBe("wal");

    db.close();
  });

  it("runs table has UNIQUE constraint on (batch_id, task_id, model_id)", () => {
    const db = initDb(TEST_DB);

    const insert = db.prepare(
      `INSERT INTO runs (id, batch_id, task_id, model_id, status, prompt, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'prompt', '2025-01-01T00:00:00Z')`
    );

    insert.run("run-1", "batch-1", "task-1", "model-1");

    expect(() =>
      insert.run("run-2", "batch-1", "task-1", "model-1")
    ).toThrow();

    db.close();
  });

  it("is idempotent — calling twice does not throw", () => {
    const db1 = initDb(TEST_DB);
    db1.close();
    const db2 = initDb(TEST_DB);
    db2.close();
  });
});
