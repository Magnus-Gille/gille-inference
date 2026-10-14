#!/usr/bin/env node

// Local visual fixture over the actual gateway handler. All gateway state and backend traffic
// live under a task-owned temp directory or a synthetic loopback stub.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(scriptPath), "..");
const args = process.argv.slice(2);
const validStates = new Set(["normal", "missing", "error"]);

function response(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function startSyntheticBackend() {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/running") return response(res, 200, { running: [] });
    if (path === "/v1/models") return response(res, 200, { data: [] });
    return response(res, 404, { error: "synthetic preview backend" });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function writeSyntheticRegistry(path) {
  const row = {
    id: "synthetic-preview-model",
    quant: "Q4_K_M",
    sizeGB: 18,
    evaluatedAt: "2026-10-01T00:00:00.000Z",
    verdict: "winner",
    passRate: 0.82,
    avgTokPerSec: 31,
    served: false,
    scoresByTaskType: {},
  };
  writeFileSync(path, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

async function runGatewayState(state, port, checkOnly) {
  const taskTmp = process.env.TMPDIR || tmpdir();
  const scratch = mkdtempSync(join(taskTmp, `portal-preview-${state}-`));
  const priorCwd = process.cwd();
  const backend = await startSyntheticBackend();
  const backendPort = backend.address().port;
  const databasePath = join(scratch, "preview.sqlite");
  const registryPath = join(scratch, "model-evals.jsonl");
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let gateway;
  let keepOpen = false;

  // Drop inherited environment values before config modules can read them. loadEnv() runs only
  // after chdir into this empty private directory, and all configured endpoints are loopback.
  for (const key of Object.keys(process.env)) {
    if (!["PATH", "HOME", "TMPDIR"].includes(key)) delete process.env[key];
  }
  process.chdir(scratch);
  process.env["HOME"] = home;
  process.env["EVAL_DB_PATH"] = databasePath;
  process.env["SCOUT_REGISTRY"] = state === "normal" ? registryPath : join(scratch, "missing-registry.jsonl");
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = String(port);
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_OWNER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_DELEGATION_COST_LOG"] = "off";
  process.env["HOMESERVER_TRACE_EXPORT"] = "off";
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_GPU_LEASE_DIR"] = join(scratch, "gpu-leases");
  process.env["HOMESERVER_IMAGE_RESULT_DIR"] = join(scratch, "image-results");
  process.env["HOMESERVER_CODE_LOOP_WORKROOT"] = join(scratch, "code-loop");
  process.env["HOMESERVER_FEEDBACK_FILE"] = join(scratch, "feedback.jsonl");
  process.env["HOMESERVER_ROUTING_TABLE_PATH"] = join(scratch, "routing-table.json");
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${backendPort}/v1`;
  process.env["LLAMASWAP_BASE_URL"] = `http://127.0.0.1:${backendPort}`;

  try {
    if (state === "normal") writeSyntheticRegistry(registryPath);
    const [{ initDb, getDb }, requestLog, gatewayModule] = await Promise.all([
      import(join(repoRoot, "src/db.ts")),
      import(join(repoRoot, "src/homeserver/request-log.ts")),
      import(join(repoRoot, "src/homeserver/gateway.ts")),
    ]);
    initDb(databasePath);
    requestLog.ensureRequestLogSchema();
    if (state === "normal") {
      requestLog.recordRequestLog({
        requestId: "synthetic-preview-request",
        alias: null,
        tier: "guest",
        keyHash: null,
        model: "synthetic-preview-model",
        route: "/v1/chat/completions",
        status: 200,
        outcome: "ok",
        errorClass: null,
        promptTokens: 1234,
        completionTokens: 3333,
        totalTokens: 4567,
        queueWaitMs: null,
        ttftMs: null,
        totalMs: 1,
        admission: "admitted",
      });
    }
    requestLog.bustStatsCache();
    gateway = await gatewayModule.startGateway();
    if (state === "error") {
      getDb().exec("DROP TABLE request_log");
      requestLog.bustStatsCache();
    }

    const base = `http://127.0.0.1:${gateway.port}`;
    const page = await fetch(`${base}/portal`);
    const html = await page.text();
    if (page.status !== 200) throw new Error(`${state}: /portal returned ${page.status}`);
    for (const placeholder of ["<!-- EMBEDDING_USES -->", "<!-- EMBEDDING_DESC -->", "<!-- EMBEDDING_MEDIA_EXAMPLE -->"]) {
      if (html.includes(placeholder)) throw new Error(`${state}: gateway renderer left ${placeholder}`);
    }
    if (!html.includes("Text and code vectors") || !html.includes("768, 512, 256 or 128 dimensions")) {
      throw new Error(`${state}: expected gateway-rendered embedding copy was absent`);
    }
    if (page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'") !== true) {
      throw new Error(`${state}: expected the gateway's portal security headers`);
    }

    const statsResponse = await fetch(`${base}/portal/stats`);
    const evalsResponse = await fetch(`${base}/portal/model-evals.json`);
    const stats = await statsResponse.json();
    const evals = await evalsResponse.json();
    if (state === "normal") {
      if (statsResponse.status !== 200 || stats.total_requests !== 1 || stats.total_tokens !== 4567 ||
          evalsResponse.status !== 200 || evals.count !== 1 || evals.models?.[0]?.id !== "synthetic-preview-model") {
        throw new Error("normal: expected synthetic totals and one synthetic evaluation from gateway routes");
      }
    } else if (state === "missing") {
      if (statsResponse.status !== 200 || stats.total_requests !== 0 || stats.total_tokens !== 0 || stats.since !== null ||
          evalsResponse.status !== 200 || evals.count !== 0 || evals.models?.length !== 0) {
        throw new Error("missing: expected empty request log and absent registry through gateway routes");
      }
    } else if (statsResponse.status !== 503 || !stats.error ||
               evalsResponse.status !== 200 || evals.count !== 0 || evals.models?.length !== 0) {
      throw new Error("error: expected gateway stats failure and empty model-evaluation registry");
    }

    console.log(`${state}: actual gateway /portal 200, stats ${statsResponse.status}, model-evals ${evalsResponse.status}`);
    if (!checkOnly) {
      keepOpen = true;
      console.log(`Preview URL: ${base}/portal`);
    }
  } finally {
    if (checkOnly || !keepOpen) {
      if (gateway) await gateway.stop();
      await new Promise((resolve) => backend.close(resolve));
      process.chdir(priorCwd);
      rmSync(scratch, { recursive: true, force: true });
    } else {
      let cleaning = false;
      const cleanup = async () => {
        if (cleaning) return;
        cleaning = true;
        if (gateway) await gateway.stop();
        await new Promise((resolve) => backend.close(resolve));
        rmSync(scratch, { recursive: true, force: true });
        process.exit(0);
      };
      process.once("SIGINT", () => void cleanup());
      process.once("SIGTERM", () => void cleanup());
      console.log(`Fixture state: ${state}; task data: ${scratch}`);
    }
  }
}

function runCheck() {
  const taskTmp = process.env.TMPDIR || tmpdir();
  const parentScratch = mkdtempSync(join(taskTmp, "portal-preview-check-"));
  const home = join(parentScratch, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    for (const state of validStates) {
      const child = spawnSync(process.execPath, ["--import", "tsx", scriptPath, "--check-state", state], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: parentScratch },
        timeout: 30_000,
      });
      if (child.status !== 0) {
        process.stderr.write(child.stderr || child.stdout);
        throw new Error(`${state}: isolated gateway fixture exited ${child.status ?? child.signal}`);
      }
      process.stdout.write(child.stdout);
    }
  } finally {
    rmSync(parentScratch, { recursive: true, force: true });
  }
}

if (args[0] === "--check") {
  runCheck();
} else if (args[0] === "--check-state") {
  const state = args[1];
  if (!validStates.has(state)) throw new Error("--check-state must be normal, missing, or error");
  await runGatewayState(state, 0, true);
} else {
  const stateIndex = args.indexOf("--state");
  const portIndex = args.indexOf("--port");
  const state = stateIndex < 0 ? "normal" : args[stateIndex + 1];
  const port = portIndex < 0 ? 4173 : Number(args[portIndex + 1]);
  if (!validStates.has(state)) throw new Error("--state must be normal, missing, or error");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  // The public preview process must be started from an allowlisted shell environment so that
  // this child never sees caller credentials. --check applies its own explicit env allowlist.
  await runGatewayState(state, port, false);
}
