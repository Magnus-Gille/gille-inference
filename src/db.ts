import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ─── Schema ───────────────────────────────────────────────────────────────────

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  prompt            TEXT NOT NULL,
  response          TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  duration_ms       INTEGER,
  cost_usd          REAL,
  provider          TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  completed_at      TEXT,
  UNIQUE(batch_id, task_id, model_id)
);

CREATE TABLE IF NOT EXISTS judge_records (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id),
  judge_model         TEXT NOT NULL,
  scores              TEXT NOT NULL,
  rationale           TEXT NOT NULL,
  flagged_for_review  INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  UNIQUE(run_id, judge_model)
);

CREATE INDEX IF NOT EXISTS idx_runs_batch_id     ON runs(batch_id);
CREATE INDEX IF NOT EXISTS idx_runs_status       ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_model_id     ON runs(model_id);
CREATE INDEX IF NOT EXISTS idx_judge_records_run ON judge_records(run_id);
`;

// ─── Singleton ────────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

/**
 * Open (and initialise) the SQLite database.
 * Creates the data directory and all tables if they do not yet exist.
 * Subsequent calls with no argument return the same instance.
 */
export function initDb(dbPath?: string): Database.Database {
  const resolvedPath = resolve(
    dbPath ?? process.env["EVAL_DB_PATH"] ?? "./data/eval.db"
  );

  // Ensure the parent directory exists
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);

  // Enable WAL for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(DDL);

  // Additive migrations — safe to re-run (throws if column already exists, which we catch)
  for (const migration of [
    'ALTER TABLE runs ADD COLUMN ttft_ms INTEGER',
    'ALTER TABLE runs ADD COLUMN tokens_per_second REAL',
  ]) {
    try {
      db.exec(migration);
    } catch {
      // Column already exists — fine
    }
  }

  // Orchestration runs table (added for full-stack orchestration benchmark)
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_runs (
      id                      TEXT PRIMARY KEY,
      batch_id                TEXT NOT NULL,
      compound_task_id        TEXT NOT NULL,
      strategy_id             TEXT NOT NULL,
      orchestrator_model      TEXT NOT NULL,
      execution_model         TEXT NOT NULL,
      status                  TEXT NOT NULL DEFAULT 'pending',
      final_output            TEXT,
      total_prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      total_completion_tokens INTEGER NOT NULL DEFAULT 0,
      total_duration_ms       INTEGER NOT NULL DEFAULT 0,
      total_cost_usd          REAL NOT NULL DEFAULT 0,
      sub_task_results_json   TEXT,
      error_message           TEXT,
      shadow_run_id           TEXT,
      created_at              TEXT NOT NULL,
      completed_at            TEXT,
      UNIQUE(batch_id, compound_task_id, strategy_id, execution_model)
    );

    CREATE INDEX IF NOT EXISTS idx_orch_runs_batch
      ON orchestration_runs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_orch_runs_strategy
      ON orchestration_runs(strategy_id);
  `);

  _db = db;
  return db;
}

/**
 * Return the existing singleton database instance.
 * Calls initDb() with default settings if not yet initialised.
 */
export function getDb(): Database.Database {
  if (!_db) {
    return initDb();
  }
  return _db;
}
