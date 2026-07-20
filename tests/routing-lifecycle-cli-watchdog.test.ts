/**
 * routing-lifecycle-cli.ts `watch` command + quarantine-gate wiring (issue #47) — subprocess
 * acceptance coverage mirroring routing-lifecycle-cli.test.ts's own harness against a seeded temp
 * ledger. Covers what the unit-level adoption-watchdog.test.ts cannot: that the CLI actually WIRES
 * the pure quarantine gate into `review`/`adopt`, and that a genuine `adopt` success queues a
 * durable watchdog record.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { initDb } from "../src/db.js";
import { recordDelegation } from "../src/homeserver/ledger.js";
import { loadConfig } from "../src/homeserver/config.js";
import { contentDigest } from "../src/homeserver/evidence-identity.js";
import { loadWatchdogState, watchdogPaths, type QuarantineState } from "../src/homeserver/adoption-watchdog.js";

const REPO_ROOT = resolve(__dirname, "..");
const SCRIPT = join(REPO_ROOT, "scripts", "routing-lifecycle-cli.ts");
const TSX = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

let dir: string;
let dbPath: string;
let dataDir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-watchdog-test-"));
  dbPath = join(dir, "eval.db");
  dataDir = join(dir, "data");
  mkdirSync(dataDir, { recursive: true });

  initDb(dbPath);
  for (let i = 0; i < 5; i++) {
    recordDelegation({ taskType: "classify", modelId: "mellum", prompt: `classify probe ${i}`, outcome: "pass", verifier: "tsGate", source: "test-seed" });
  }
});

function baseEnv(extra: Record<string, string> = {}) {
  return {
    ...process.env,
    EVAL_DB_PATH: dbPath,
    HOMESERVER_BACKEND: "llamaswap",
    LMSTUDIO_BASE_URL: "http://127.0.0.1:1/v1",
    ...extra,
  };
}

function runCli(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX, SCRIPT, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 120_000,
    env: baseEnv(env),
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * ASYNC variant, required whenever the CLI subprocess must talk to an in-process fake HTTP server
 * (the `adopt`-succeeds test below): `spawnSync` blocks this process's ENTIRE event loop until the
 * child exits, so an in-process `http.Server` can never accept/answer the child's request — the
 * child hangs on its (timeout-less) reload fetch until spawnSync's own timeout kills it. Plain
 * `spawn` keeps this process's event loop running, so the in-process server can actually respond.
 */
function runCliAsync(args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [TSX, SCRIPT, ...args], { cwd: REPO_ROOT, env: baseEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function writeQuarantine(taskType: string, overrides: Partial<QuarantineState["byTaskType"][string]> = {}): void {
  mkdirSync(watchdogPaths(dataDir).root, { recursive: true });
  const state: QuarantineState = {
    schemaVersion: 1,
    byTaskType: {
      [taskType]: {
        taskType,
        quarantinedAt: "2026-07-20T00:00:00.000Z",
        reason: "test breach",
        cooldownUntil: "2099-01-01T00:00:00.000Z", // far future — never elapses unless overridden
        requiredMarginDelta: 0.1,
        baselinePassRateAtQuarantine: 0.9,
        clearedAt: null,
        ...overrides,
      },
    },
  };
  writeFileSync(watchdogPaths(dataDir).quarantinePath, JSON.stringify(state, null, 2), "utf8");
}

describe("routing-lifecycle-cli.ts review — quarantine gate wiring (issue #47)", () => {
  it("surfaces a BLOCKED quarantine for a changed task type and exits non-zero", () => {
    writeQuarantine("classify");
    const tablePath = join(dir, "review-quarantine-table.json"); // absent -> every type is 'added' (changed)
    const r = runCli(["review", "--db", dbPath, "--data-dir", dataDir, "--table", tablePath]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/quarantine \(#47\): BLOCKED/);
    expect(r.stderr).toMatch(/\[axis-quarantined\] classify:/);
  });

  it("does not block a task type with no quarantine record", () => {
    const emptyDataDir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-watchdog-empty-"));
    const tablePath = join(dir, "review-noquarantine-table.json");
    const r = runCli(["review", "--db", dbPath, "--data-dir", emptyDataDir, "--table", tablePath]);
    expect(r.stderr).not.toMatch(/quarantine \(#47\): BLOCKED/);
  });
});

describe("routing-lifecycle-cli.ts adopt — quarantine refuses BEFORE any write (issue #47)", () => {
  it("refuses adoption of a quarantined axis, fail closed, before approveArtifact/adoptRoutingTable ever run", () => {
    const qDataDir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-watchdog-adopt-"));
    mkdirSync(watchdogPaths(qDataDir).root, { recursive: true });
    writeFileSync(
      watchdogPaths(qDataDir).quarantinePath,
      JSON.stringify({
        schemaVersion: 1,
        byTaskType: {
          classify: {
            taskType: "classify",
            quarantinedAt: "2026-07-20T00:00:00.000Z",
            reason: "test breach",
            cooldownUntil: "2099-01-01T00:00:00.000Z",
            requiredMarginDelta: 0.1,
            baselinePassRateAtQuarantine: 0.9,
            clearedAt: null,
          },
        },
      } satisfies QuarantineState),
      "utf8"
    );

    const artifactPath = join(dir, "quarantined-artifact.json");
    const tablePath = join(dir, "adopt-quarantine-table.json"); // must not exist afterward
    writeFileSync(
      artifactPath,
      JSON.stringify({
        schemaVersion: 1,
        candidateHash: "test-candidate-hash-quarantine",
        adoptedHash: null,
        policyEpochHash: "irrelevant-never-reached",
        diff: {
          changes: [{ taskType: "classify", kind: "added", before: null, after: { model: "mellum", verdict: "delegate-local", attempts: 10 }, evidenceMissing: false, detail: "test" }],
          downgrades: [],
        },
        validation: { ok: true, issues: [] },
        calibrationGate: null,
        lineage: [{ taskType: "classify", model: "mellum", verdict: "delegate-local", attempts: 10, organicJudgeDependent: false }],
        candidate: { routing: { classify: { model: "mellum", passRate: 0.5, tokPerSec: null, verdict: "delegate-local", attempts: 10 } }, escalateToFrontier: [] },
      }),
      "utf8"
    );

    const r = runCli([
      "adopt",
      "--db", dbPath,
      "--data-dir", qDataDir,
      "--artifact", artifactPath,
      "--approved-by", "test-operator",
      "--reason", "test adoption",
      "--decision-ref", "grimnir#88",
      "--table", tablePath,
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/adopt refused: quarantined axis\(es\) not yet cleared/);
    expect(r.stderr).toMatch(/\[axis-quarantined\] classify:/);
    // Refused BEFORE any write — the table must not have been created at all.
    expect(() => readFileSync(tablePath, "utf8")).toThrow();
  });
});

describe("routing-lifecycle-cli.ts adopt — a genuine success queues a durable watchdog record (issue #47)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mellum" }] }));
        return;
      }
      if (req.method === "GET" && req.url === "/running") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ running: [] }));
        return;
      }
      if (req.method === "POST" && req.url === "/admin/routing-table/reload") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("OK");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("server did not bind a port");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it("ADOPTED (real reload + real canary against the fake catalogue) queues a pending AdoptionWatchRecord with a captured snapshot", async () => {
    const wDataDir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-watchdog-success-"));
    const tablePath = join(dir, "adopt-success-table.json"); // first-ever adoption — no prior snapshot
    const policyEpochHash = contentDigest(JSON.stringify(loadConfig().policy));
    const artifactPath = join(dir, "adopt-success-artifact.json");
    writeFileSync(
      artifactPath,
      JSON.stringify({
        schemaVersion: 1,
        candidateHash: "test-candidate-hash-success",
        adoptedHash: null,
        policyEpochHash,
        diff: {
          changes: [{ taskType: "classify", kind: "added", before: null, after: { model: "mellum", verdict: "delegate-local", attempts: 10 }, evidenceMissing: false, detail: "test" }],
          downgrades: [],
        },
        validation: { ok: true, issues: [] },
        calibrationGate: null,
        lineage: [{ taskType: "classify", model: "mellum", verdict: "delegate-local", attempts: 10, organicJudgeDependent: false }],
        candidate: { routing: { classify: { model: "mellum", passRate: 0.95, tokPerSec: null, verdict: "delegate-local", attempts: 10 } }, escalateToFrontier: [] },
      }),
      "utf8"
    );

    const gatewayUrl = `http://127.0.0.1:${port}`;
    const r = await runCliAsync(
      [
        "adopt",
        "--db", dbPath,
        "--data-dir", wDataDir,
        "--artifact", artifactPath,
        "--approved-by", "test-operator",
        "--reason", "test adoption",
        "--decision-ref", "grimnir#47",
        "--table", tablePath,
        "--gateway-url", gatewayUrl,
      ],
      { LLAMASWAP_BASE_URL: gatewayUrl, ROUTING_LIFECYCLE_ADMIN_KEY: "test-admin-key" }
    );

    expect(r.stderr).toMatch(/^ADOPTED/m);
    expect(r.stderr).toMatch(/watchdog \(#47\): queued adoption watch record/);
    expect(r.stderr).toMatch(/snapshot none — first-ever adoption/);

    const state = loadWatchdogState(wDataDir);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]?.status).toBe("pending");
    expect(state.records[0]?.changedTaskTypes).toEqual(["classify"]);
    expect(state.records[0]?.snapshotPath).toBeNull(); // first-ever adoption
    expect(state.records[0]?.candidateHash).toBe("test-candidate-hash-success");
  });
});

describe("routing-lifecycle-cli.ts watch --dry-run (issue #47)", () => {
  it("detects a breach from real ledger evidence and reports it without mutating any durable state", () => {
    const wDataDir = mkdtempSync(join(tmpdir(), "routing-lifecycle-cli-watchdog-watch-"));

    // Reuse the OUTER suite's already-initialized `dbPath` rather than a second `initDb(<new path>)`
    // call: ledger.ts's ensureSchema() guards table creation behind a process-wide `_initialised`
    // flag (see routing-lifecycle-cli.test.ts's identical note), so a second init within this same
    // test-file process would silently skip creating the delegations table on a fresh file. Seed a
    // dedicated task type ("watchdog-probe") so these rows never interact with "classify"'s.
    //
    // Seed 10 fresh 'error' rows — recordDelegation always stamps ts=now, so an adoptedAt far in the
    // past puts the ENTIRE baseline window before any of these rows exist (baseline sampleSize 0)
    // while the post-adoption window [adoptedAt, now) contains all of them — a deterministic,
    // real-ledger-backed breach without needing to control row timestamps directly.
    for (let i = 0; i < 10; i++) {
      recordDelegation({ taskType: "watchdog-probe", modelId: "mellum", prompt: `probe ${i}`, outcome: "error", errorClass: "timeout", source: "test-seed" });
    }

    const tablePath = join(dir, "watch-table.json");
    writeFileSync(tablePath, JSON.stringify({ routing: {}, escalateToFrontier: [] }), "utf8");

    // Directly seed the durable watch-state (bypassing `adopt`) — this test's purpose is `watch`'s
    // own evaluate/report wiring, not re-proving `adopt` (covered above).
    mkdirSync(watchdogPaths(wDataDir).root, { recursive: true });
    writeFileSync(
      watchdogPaths(wDataDir).statePath,
      JSON.stringify({
        schemaVersion: 1,
        records: [
          {
            id: "test-record-1",
            adoptedAt: "2020-01-01T00:00:00.000Z",
            candidateHash: "test-hash",
            decisionRef: "grimnir#47",
            approvedBy: "test",
            changedTaskTypes: ["watchdog-probe"],
            snapshotPath: null,
            status: "pending",
            lastEvaluatedAt: null,
          },
        ],
      }),
      "utf8"
    );

    const r = runCli(["watch", "--dry-run", "--db", dbPath, "--data-dir", wDataDir, "--table", tablePath]);

    const report = JSON.parse(r.stdout) as { dryRun: boolean; items: Array<{ evaluation: { verdict: string }; action: string }> };
    expect(report.dryRun).toBe(true);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]?.evaluation.verdict).toBe("breach");
    expect(report.items[0]?.action).toBe("would-revert");
    expect(r.stderr).toMatch(/verdict=breach action=would-revert/);
    expect(r.stderr).toMatch(/\(dry-run — no mutation\)/);

    // Dry-run must not have created events.jsonl/quarantine.json.
    expect(() => readFileSync(watchdogPaths(wDataDir).eventsPath, "utf8")).toThrow();
    expect(() => readFileSync(watchdogPaths(wDataDir).quarantinePath, "utf8")).toThrow();
  });
});
