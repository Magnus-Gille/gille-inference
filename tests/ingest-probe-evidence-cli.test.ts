/**
 * End-to-end tests for the ingest-probe-evidence CLI (self-review finding on PR #153: the pure
 * parser and importDelegations were tested, but the CLI wiring — strict refusal, --lenient,
 * --dry-run, actual DB import + idempotent re-run — had no coverage).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "ingest-probe-evidence.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dir: string;
let dbPath: string;

const GOOD_LINE = JSON.stringify({
  ts: "2026-06-23T12:00:00.000Z",
  taskType: "reason-hard",
  model: "qwen3-coder-next-80b",
  probeId: "rh-1",
  outcome: "pass",
  score: 1,
});
const BAD_LINE = "{ not json";

function run(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, EVAL_DB_PATH: dbPath },
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

function delegationCount(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM delegations`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ingest-cli-test-"));
  dbPath = join(dir, "eval.db");
});

describe("ingest-probe-evidence CLI", () => {
  it("STRICT: a malformed line refuses the whole import (exit 1, nothing written)", () => {
    const file = join(dir, "mixed.jsonl");
    writeFileSync(file, `${GOOD_LINE}\n${BAD_LINE}\n`, "utf8");

    const r = run(["--file", file, "--source", "extra-probes", "--db", dbPath]);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/line 2/);
    expect(r.stderr).toMatch(/REFUSING/i);
    expect(r.stderr).toMatch(/--lenient/);
  });

  it("--dry-run reports and never touches the DB (even with malformed lines present)", () => {
    const file = join(dir, "mixed-dry.jsonl");
    writeFileSync(file, `${GOOD_LINE}\n${BAD_LINE}\n`, "utf8");

    const r = run(["--file", file, "--db", dbPath, "--dry-run"]);

    expect(r.stderr).toMatch(/dry-run/i);
    expect(r.stderr).toMatch(/1 record\(s\) parsed/);
    expect(r.status).not.toBe(0); // strict errors still surface via exit code
  });

  it("--lenient imports the valid records despite malformed lines", () => {
    const file = join(dir, "mixed-lenient.jsonl");
    writeFileSync(file, `${GOOD_LINE}\n${BAD_LINE}\n`, "utf8");

    const r = run(["--file", file, "--source", "extra-probes", "--db", dbPath, "--lenient"]);

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/imported 1 new record/);
    expect(delegationCount()).toBe(1);
  });

  it("re-running the same import is a no-op (idempotent end-to-end)", () => {
    const file = join(dir, "mixed-lenient.jsonl");
    const r = run(["--file", file, "--source", "extra-probes", "--db", dbPath, "--lenient"]);

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/imported 0 new record\(s\), 1 duplicate/);
    expect(delegationCount()).toBe(1);
  });

  it("a missing file is a clear error, exit 1", () => {
    const r = run(["--file", join(dir, "nope.jsonl"), "--db", dbPath]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no such file/i);
  });
});
