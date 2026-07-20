/**
 * Subprocess acceptance coverage for scripts/routing-lifecycle-cli.ts's `review` subcommand
 * (issue #7) — the IO composition root wiring the pure routing-lifecycle.ts logic to the ledger,
 * the filesystem, and the served-model catalogue. Mirrors generate-routing-table-guard.test.ts's
 * subprocess harness against a seeded temp ledger.
 *
 * The CLI's serving-catalogue probe (model-admin.ts's listModels()) has nothing real to reach in
 * this test environment, so `review` exercises the genuine fail-CLOSED path (AC: "never silently
 * keep a stale model id when the catalogue is unavailable") — that is the realistic, desired
 * behavior being pinned here, not a workaround.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation } from "../src/homeserver/ledger.js";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "routing-lifecycle-cli.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-test-"));
  dbPath = join(dir, "eval.db");
  mkdirSync(join(dir, "data"));

  initDb(dbPath);
  for (let i = 0; i < 5; i++) {
    recordDelegation({
      taskType: "classify",
      modelId: "mellum",
      prompt: `classify probe ${i}`,
      outcome: "pass",
      verifier: "tsGate",
      source: "test-seed",
    });
  }
});

function runReview(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, "review", "--db", dbPath, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, EVAL_DB_PATH: dbPath, HOMESERVER_BACKEND: "llamaswap", LMSTUDIO_BASE_URL: "http://127.0.0.1:1/v1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("routing-lifecycle-cli.ts review (issue #7)", () => {
  it("produces a machine-readable artifact and exits non-zero when the catalogue is unreachable (fail closed)", () => {
    const r = runReview([]);
    expect(r.status).not.toBe(0); // never a silent pass with an unreachable catalogue
    const artifact = JSON.parse(r.stdout) as {
      schemaVersion: number;
      validation: { ok: boolean; issues: Array<{ code: string }> };
      candidateHash: string;
      humanDiff: string;
      lineage: unknown[];
    };
    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.validation.ok).toBe(false);
    expect(artifact.validation.issues.some((i) => i.code === "model-unavailable")).toBe(true);
    expect(typeof artifact.candidateHash).toBe("string");
    expect(Array.isArray(artifact.lineage)).toBe(true);
    expect(r.stderr).toMatch(/validation: REFUSED/);
  });

  it("writes the artifact to --out as well as stdout", () => {
    const out = join(dir, "artifact.json");
    const r = runReview(["--out", out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/wrote review artifact/);
  });

  it("rejects a malformed --calibration-gate file with a clear error, not a crash traceback dump", () => {
    const badGate = join(dir, "bad-gate.json");
    writeFileSync(badGate, JSON.stringify({ not: "a gate" }), "utf8");
    const r = runReview(["--calibration-gate", badGate]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not a recognisable CalibrationGateDecision/);
  });
});
