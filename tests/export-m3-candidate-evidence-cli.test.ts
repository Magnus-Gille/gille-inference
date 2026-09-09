import Database from "better-sqlite3";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../scripts/export-m3-candidate-evidence.js";
import type { CandidateEvidenceReport } from "../src/homeserver/candidate-evidence-report.js";

describe("m3 candidate evidence export CLI", () => {
  it("requires explicit bounds and capture time", () => {
    expect(() => parseArgs(["--db", "/tmp/x", "--from", "a", "--through-exclusive", "b"])).toThrow();
  });
  it("rejects duplicate flags and missing flag values", () => {
    expect(() => parseArgs(["--db"])).toThrow("--db requires a value");
    expect(() => parseArgs(["--db", "/tmp/x", "--from"])).toThrow("--from requires a value");
    expect(() => parseArgs(["--db", "/tmp/x", "--from", "a", "--through-exclusive", "b", "--generated-at"])).toThrow("--generated-at requires a value");
    expect(() => parseArgs(["--db", "/tmp/x", "--db", "/tmp/y", "--from", "a", "--through-exclusive", "b", "--generated-at", "c"])).toThrow("--db may only be specified once");
  });
  it("emits JSON and does not expose driver errors", () => {
    let stdout = ""; let stderr = "";
    expect(main(["--db", "/missing/private/path", "--from", "2026-09-01T00:00:00.000Z", "--through-exclusive", "2026-09-02T00:00:00.000Z", "--generated-at", "2026-09-09T12:00:00.000Z"], { writeStdout: (v) => { stdout += v; }, writeStderr: (v) => { stderr += v; } })).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("[m5-candidate-evidence] unavailable: cannot open read-only database\n");
  });
  it("buffers JSON until read-only close succeeds and sanitizes close errors", () => {
    let stdout = ""; let stderr = "";
    const report = { contract: "m5-candidate-evidence-v1", version: 1 } as CandidateEvidenceReport;
    const db = {} as never;
    expect(main(["--db", "/private/sentinel/source.db", "--from", "2026-09-01T00:00:00.000Z", "--through-exclusive", "2026-09-02T00:00:00.000Z", "--generated-at", "2026-09-09T12:00:00.000Z"], {
      openReadOnlyDb: () => db,
      buildReport: () => report,
      closeReadOnlyDb: () => { throw new Error("close failed /private/sentinel"); },
      writeStdout: (value) => { stdout += value; },
      writeStderr: (value) => { stderr += value; },
    })).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("[m5-candidate-evidence] unavailable: cannot close read-only database\n");
  });
  it("exports a real read-only snapshot without changing source bytes or echoing sentinels", () => {
    const directory = mkdtempSync(join(tmpdir(), "m3-candidate-cli-"));
    const dbPath = join(directory, "source.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE delegations (id TEXT, ts TEXT, node_id TEXT, model_id TEXT, task_type TEXT, outcome TEXT, shadow INTEGER, superseded_at TEXT, evidence_identity_hash TEXT)");
    db.prepare("INSERT INTO delegations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("secret-ledger-id", "2026-09-01T12:00:00.000Z", "m5", "secret-model-alias", "private-task", "pass", 0, null, null);
    db.close();
    const before = readFileSync(dbPath);
    let stdout = ""; let stderr = "";
    const status = main(["--db", dbPath, "--from", "2026-09-01T00:00:00.000Z", "--through-exclusive", "2026-09-02T00:00:00.000Z", "--generated-at", "2026-09-09T12:00:00.000Z"], {
      writeStdout: (value) => { stdout += value; }, writeStderr: (value) => { stderr += value; },
    });
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stdout).not.toContain("secret-ledger-id");
    expect(stdout).not.toContain("secret-model-alias");
    expect(stdout).not.toContain("private-task");
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });
});
