import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { EXECUTION_FEEDBACK_EPOCH } from "../src/homeserver/execution-feedback-contract.js";
import {
  EXECUTION_FEEDBACK_REPORT_CONTRACT,
  type ExecutionFeedbackReport,
} from "../src/homeserver/execution-feedback-report.js";
import {
  main as exportMain,
  parseArgs as parseExportArgs,
} from "../scripts/export-execution-feedback.js";

const SINCE = "2026-08-01T00:00:00.000Z";
const UNTIL = "2026-08-03T00:00:00.000Z";

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), "gille-execution-feedback-export-test-"));
}

function createIncompleteDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec("CREATE TABLE sentinel (value TEXT NOT NULL)");
  return db;
}

function createFeedbackDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE delegations (
      id TEXT PRIMARY KEY,
      ts TEXT NOT NULL,
      task_type TEXT NOT NULL,
      node_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      source TEXT NOT NULL,
      shadow INTEGER NOT NULL DEFAULT 0,
      superseded_at TEXT
    );
    CREATE TABLE execution_feedback (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      traffic_purpose TEXT NOT NULL,
      epoch TEXT NOT NULL,
      usefulness TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      principal_hash TEXT,
      handle TEXT,
      note TEXT
    );
  `);
  db.prepare(`
    INSERT INTO delegations
      (id, ts, task_type, node_id, model_id, outcome, source, shadow, superseded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "ledger-secret-id",
    "2026-08-01T10:00:00.000Z",
    "code-edit",
    "m5",
    "mellum",
    "completed",
    "gateway",
    0,
    null,
  );
  db.prepare(`
    INSERT INTO execution_feedback
      (id, ledger_id, surface, traffic_purpose, epoch, usefulness, available, principal_hash, handle, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "feedback-secret-id",
    "ledger-secret-id",
    "ask",
    "organic",
    EXECUTION_FEEDBACK_EPOCH,
    "pass",
    1,
    "sha256:principal-secret",
    "owner-handle-secret",
    "prompt and response secret",
  );
  return db;
}

describe("export-execution-feedback CLI", () => {
  it("requires explicit since and until bounds", () => {
    expect(() => parseExportArgs([])).toThrow(/--since is required/);
    expect(() => parseExportArgs(["--since", SINCE])).toThrow(/--until is required/);
    expect(() => parseExportArgs(["--until", UNTIL])).toThrow(/--since is required/);
    expect(parseExportArgs(
      ["--since", SINCE, "--until", UNTIL],
      { EVAL_DB_PATH: "/authoritative/eval.db" },
    )).toEqual({ dbPath: "/authoritative/eval.db", since: SINCE, until: UNTIL });
  });

  it("does not reflect unknown options or builder exception details", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const fakeDb = {} as Database.Database;
    const secret = "SQLITE_SECRET /private/operator/feedback.db prompt bytes";

    const unknownOptionExit = exportMain(
      ["--unknown", secret],
      { writeStdout: (text) => output.push(text), writeStderr: (text) => errors.push(text) },
    );
    expect(unknownOptionExit).toBe(2);
    expect(output).toEqual([]);
    expect(errors).toEqual(["[execution-feedback] unknown option\n"]);

    output.length = 0;
    errors.length = 0;
    const builderExit = exportMain(
      ["--db", "/private/operator/feedback.db", "--since", SINCE, "--until", UNTIL],
      {
        openReadOnlyDb: () => fakeDb,
        closeReadOnlyDb: () => undefined,
        buildReport: () => { throw new Error(secret); },
        writeStdout: (text) => output.push(text),
        writeStderr: (text) => errors.push(text),
      },
    );
    expect(builderExit).toBe(2);
    expect(output).toEqual([]);
    expect(errors).toEqual(["[execution-feedback] export refused: invalid bounds or unreadable schema\n"]);
    expect(errors.join("")).not.toContain(secret);
  });

  it("passes only the explicit window to the builder and emits its closed JSON", () => {
    const output: string[] = [];
    const errors: string[] = [];
    const fakeDb = {} as Database.Database;
    const report: ExecutionFeedbackReport = {
      contract: EXECUTION_FEEDBACK_REPORT_CONTRACT,
      epoch: EXECUTION_FEEDBACK_EPOCH,
      window: { since: SINCE, until: UNTIL },
      availability: "available",
      rows: [],
      completed: 0,
      assessed: 0,
      missing: 0,
      coverage: 0,
      excluded: { evaluation: 0, synthetic: 0, unknown: 0, epoch: 0, ineligible: 0 },
    };
    let seenBounds: unknown;
    let closed = false;
    const exitCode = exportMain(
      ["--db", "/private/operator/eval.db", "--since", SINCE, "--until", UNTIL],
      {
        openReadOnlyDb: () => fakeDb,
        closeReadOnlyDb: () => { closed = true; },
        buildReport: (_db, bounds) => {
          seenBounds = bounds;
          return report;
        },
        writeStdout: (text) => output.push(text),
        writeStderr: (text) => errors.push(text),
      },
    );

    expect(exitCode).toBe(0);
    expect(seenBounds).toEqual({ since: SINCE, until: UNTIL });
    expect(JSON.parse(output.join(""))).toEqual(report);
    expect(output.join(""), "machine-readable output must not contain a path").not.toContain("/private/operator");
    expect(errors).toEqual([]);
    expect(closed).toBe(true);
  });

  it("reports an unavailable database without creating it", () => {
    const root = temporaryRoot();
    const dbPath = join(root, "missing.db");
    const output: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = exportMain(
        ["--db", dbPath, "--since", SINCE, "--until", UNTIL],
        { writeStdout: (text) => output.push(text), writeStderr: (text) => errors.push(text) },
      );
      expect(exitCode).toBe(2);
      expect(output).toEqual([]);
      expect(errors.join(""), "missing DB must be explicit, not an empty report")
        .toContain("unavailable: cannot open read-only database");
      expect(errors.join("")).not.toContain(dbPath);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns a successful unavailable report for missing schema without migrating or zeroing nulls", () => {
    const root = temporaryRoot();
    const dbPath = join(root, "incomplete.db");
    const db = createIncompleteDb(dbPath);
    db.close();
    const before = readFileSync(dbPath);
    const output: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = exportMain(
        ["--db", dbPath, "--since", SINCE, "--until", UNTIL],
        { writeStdout: (text) => output.push(text), writeStderr: (text) => errors.push(text) },
      );
      const report = JSON.parse(output.join("")) as Record<string, unknown>;
      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(report).toMatchObject({
        availability: "unavailable",
        unavailableReason: "missing_table",
        completed: null,
        assessed: null,
        missing: null,
        coverage: null,
        excluded: null,
        rows: [],
      });
      expect(JSON.stringify(report)).not.toContain('"completed": 0');
      expect(readFileSync(dbPath)).toEqual(before);
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports malformed SQLite as unavailable without reflecting file details", () => {
    const root = temporaryRoot();
    const dbPath = join(root, "malformed.db");
    const secret = "not a sqlite database: prompt bytes and SQL details";
    writeFileSync(dbPath, secret);
    const before = readFileSync(dbPath);
    const output: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = exportMain(
        ["--db", dbPath, "--since", SINCE, "--until", UNTIL],
        { writeStdout: (text) => output.push(text), writeStderr: (text) => errors.push(text) },
      );
      expect(exitCode).toBe(2);
      expect(output).toEqual([]);
      expect(errors).toEqual(["[execution-feedback] export refused: invalid bounds or unreadable schema\n"]);
      expect(errors.join("")).not.toContain(dbPath);
      expect(errors.join("")).not.toContain(secret);
      expect(readFileSync(dbPath)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports aggregate feedback only, excluding identity and content fields", () => {
    const root = temporaryRoot();
    const dbPath = join(root, "feedback.db");
    const db = createFeedbackDb(dbPath);
    db.close();
    const output: string[] = [];
    const errors: string[] = [];

    try {
      const exitCode = exportMain(
        ["--db", dbPath, "--since", SINCE, "--until", UNTIL],
        { writeStdout: (text) => output.push(text), writeStderr: (text) => errors.push(text) },
      );
      const serialized = output.join("");
      const report = JSON.parse(serialized) as Record<string, unknown>;
      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(report).toMatchObject({ availability: "available", completed: 1, assessed: 1, missing: 0 });
      expect(serialized).not.toContain("ledger-secret-id");
      expect(serialized).not.toContain("feedback-secret-id");
      expect(serialized).not.toContain("principal-secret");
      expect(serialized).not.toContain("owner-handle-secret");
      expect(serialized).not.toContain("prompt and response secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
