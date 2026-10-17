import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../src/db.js";

let testDir: string;
let openedDb: ReturnType<typeof initDb> | null = null;

function testDbPath(): string {
  return join(testDir, "eval.db");
}

beforeEach(() => {
  // Every test (and every worker) gets a distinct database. Never use the repository's
  // gitignored data/ tree for test state: it can contain private production evidence.
  testDir = mkdtempSync(join(tmpdir(), "gille-db-test-"));
  openedDb = null;
});

afterEach(() => {
  closeDb();
  if (openedDb?.open) openedDb.close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("initDb", () => {
  it("creates the database file and tables", () => {
    const db = initDb(testDbPath());
    openedDb = db;

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
    const db = initDb(testDbPath());
    openedDb = db;

    const row = db.pragma("journal_mode") as { journal_mode: string }[];
    expect(row[0]?.journal_mode).toBe("wal");

    db.close();
  });

  it("runs table has UNIQUE constraint on (batch_id, task_id, model_id)", () => {
    const db = initDb(testDbPath());
    openedDb = db;

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
    const db1 = initDb(testDbPath());
    openedDb = db1;
    db1.close();
    const db2 = initDb(testDbPath());
    openedDb = db2;
    db2.close();
  });
});
