/**
 * ACCEPTANCE test for issue #151 — regeneration must ALARM on a capability downgrade,
 * never silently adopt it.
 *
 * Written BEFORE the implementation (red→green). This drives the real script
 * (scripts/generate-routing-table.ts) as a subprocess against a seeded temp ledger, reproducing
 * the #150 incident: the currently-adopted table routes reason-hard locally on probe evidence,
 * but that evidence is GONE from the ledger. Current (pre-#151) behavior: the script exits 0 and
 * quietly overwrites the table with escalate-frontier. Required behavior: semantic diff vs the
 * adopted table, loud structured alarm, non-zero exit, NO write — unless --accept-downgrades
 * explicitly acknowledges the regression.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDb } from "../src/db.js";
import { recordDelegation } from "../src/homeserver/ledger.js";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "generate-routing-table.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dir: string;
let dbPath: string;
let dataDir: string;

/** The currently-adopted table: reason-hard measured viable on the 80b (the evidence that will be "lost"). */
function adoptedTable(): string {
  return (
    JSON.stringify(
      {
        _comment: "test fixture — currently adopted table",
        generatedAt: "2026-06-23T00:00:00.000Z",
        routing: {
          classify: { model: "mellum", passRate: 1, tokPerSec: 200, verdict: "delegate-local", attempts: 4 },
          "reason-hard": {
            model: "qwen3-coder-next-80b",
            passRate: 1,
            tokPerSec: 69,
            verdict: "delegate-local",
            attempts: 20,
            note: "viable 20/20 — extra-probes battery 2026-06-23",
          },
        },
        escalateToFrontier: [],
      },
      null,
      2
    ) + "\n"
  );
}

function runScript(args: string[], outPath: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    process.execPath,
    [TSX, SCRIPT, "--db", dbPath, "--data-dir", dataDir, "--out", outPath, ...args],
    { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, EVAL_DB_PATH: dbPath } }
  );
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-guard-test-"));
  dbPath = join(dir, "eval.db");
  dataDir = join(dir, "data");
  mkdirSync(dataDir);

  // Seed the ledger: classify evidence survives, reason-hard evidence is ABSENT (the incident).
  initDb(dbPath);
  for (let i = 0; i < 4; i++) {
    recordDelegation({
      taskType: "classify",
      modelId: "mellum",
      prompt: `classify probe ${i}`,
      outcome: "pass",
      score: 1,
      tokPerSec: 200,
      verifier: "test",
      source: "test-seed",
    });
  }
});

describe("generate-routing-table — capability-regression guard (issue #151)", () => {
  it("RED/GREEN acceptance: lost probe evidence → ALARM + non-zero exit + NO silent overwrite", () => {
    const out = join(dir, "m5-routing-guarded.json");
    writeFileSync(out, adoptedTable(), "utf8");

    const r = runScript([], out);

    // Must fail loudly…
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ROUTING REGRESSION/i);
    expect(r.stderr).toMatch(/reason-hard/);
    expect(r.stderr).toMatch(/MISSING/i); // "expected but missing", not "never probed"
    expect(r.stderr).toMatch(/accept-downgrades/);
    // …with a machine-readable line the calling cron can surface…
    expect(r.stderr).toMatch(/ROUTING_REGRESSION_JSON\s+\{/);
    // …and must NOT have touched the adopted table.
    expect(readFileSync(out, "utf8")).toBe(adoptedTable());
  });

  it("--accept-downgrades acknowledges the regression and writes the new table", () => {
    const out = join(dir, "m5-routing-acked.json");
    writeFileSync(out, adoptedTable(), "utf8");

    const r = runScript(["--accept-downgrades"], out);

    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(out, "utf8")) as {
      generatedAt: string;
      routing: Record<string, { model: string | null; verdict: string }>;
    };
    expect(doc.generatedAt).not.toBe("2026-06-23T00:00:00.000Z");
    expect(doc.routing["reason-hard"]?.model).toBeNull();
    expect(doc.routing["classify"]?.model).toBe("mellum");
    // The acknowledgment is still an alerted event, not a silent one.
    expect(r.stderr).toMatch(/ROUTING REGRESSION/i);
  });

  it("--dry-run with a pending downgrade prints the table + diff but writes nothing and exits non-zero", () => {
    const out = join(dir, "m5-routing-dry.json");
    writeFileSync(out, adoptedTable(), "utf8");

    const r = runScript(["--dry-run"], out);

    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/"routing"/); // table still printed for inspection
    expect(r.stderr).toMatch(/ROUTING REGRESSION/i);
    expect(readFileSync(out, "utf8")).toBe(adoptedTable());
  });

  it("no-regression path: regeneration over intact evidence writes cleanly with exit 0", () => {
    const out = join(dir, "m5-routing-clean.json");
    // Adopted table only claims what the ledger still proves (classify → mellum).
    writeFileSync(
      out,
      JSON.stringify(
        {
          generatedAt: "2026-06-23T00:00:00.000Z",
          routing: {
            classify: { model: "mellum", passRate: 1, tokPerSec: 200, verdict: "delegate-local", attempts: 4 },
          },
          escalateToFrontier: [],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const r = runScript([], out);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/ROUTING REGRESSION/i);
    const doc = JSON.parse(readFileSync(out, "utf8")) as {
      routing: Record<string, { model: string | null }>;
    };
    expect(doc.routing["classify"]?.model).toBe("mellum");
  });

  it("first-ever generation (no adopted table on disk) does not alarm", () => {
    const out = join(dir, "m5-routing-fresh.json");
    expect(existsSync(out)).toBe(false);

    const r = runScript([], out);

    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/ROUTING REGRESSION/i);
    expect(existsSync(out)).toBe(true);
  });

  it("an unreadable/corrupt adopted table is a hard error (cannot prove no regression), not a silent skip", () => {
    const out = join(dir, "m5-routing-corrupt.json");
    writeFileSync(out, "{ not json", "utf8");

    const r = runScript([], out);

    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/corrupt|parse|unreadable/i);
    expect(readFileSync(out, "utf8")).toBe("{ not json");
  });
});
