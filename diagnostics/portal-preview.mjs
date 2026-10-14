#!/usr/bin/env node

// Local visual fixture for the candidate portal. It serves the checked-in portal.html verbatim
// and synthetic, content-free responses; it never reads gateway config, credentials, or databases.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const portalPath = resolve(here, "../src/homeserver/portal.html");
const portalHtml = await readFile(portalPath, "utf8");
const validStates = new Set(["normal", "missing", "error"]);
const normalStats = { total_tokens: 4567, total_requests: 123, since: Date.UTC(2026, 9, 1) };
const normalEvals = {
  models: [{ id: "synthetic-preview-model", quant: "Q4_K_M", sizeGB: 18, passRate: 0.82,
    tokPerSec: 31, verdict: "winner", served: false }],
};

function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function makeServer(state) {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/" || path === "/portal") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "permissions-policy": "geolocation=(), camera=(), microphone=()",
      });
      res.end(portalHtml);
      return;
    }
    if (path === "/portal/stats") {
      if (state === "error") return json(res, 503, { error: "synthetic preview outage" });
      return json(res, 200, state === "normal" ? normalStats : {});
    }
    if (path === "/portal/model-evals.json") {
      if (state === "error") return json(res, 503, { error: "synthetic preview outage" });
      return json(res, 200, state === "normal" ? normalEvals : { models: [] });
    }
    if (path === "/portal/me") {
      // No key is embedded in this fixture. If a visitor enters anything, return only synthetic
      // owner metadata so the page behavior can be inspected without contacting a real gateway.
      if (req.headers.authorization !== "Bearer synthetic-preview-key") {
        return json(res, 401, { error: { code: "invalid_api_key" } });
      }
      return json(res, 200, {
        alias: "synthetic-preview-owner", tier: "owner", scope: "agent", models: [],
        creditLimit: 10000, creditsUsed: 1250,
        gateway: { revision: "0".repeat(40), client_version: "0.0.0", result_contract: "synthetic-preview" },
        inferenceObservation: state === "normal"
          ? { source: "request_log", scope: "m5_global", status: "observed", lastSuccessfulAt: "2026-10-08T12:34:56.000Z" }
          : { source: "request_log", scope: "m5_global", status: state === "missing" ? "none" : "unavailable", lastSuccessfulAt: null },
      });
    }
    if (path === "/portal/redeem") return json(res, 503, { error: { code: "preview_only" } });
    if (path === "/portal/feedback") return json(res, 503, { error: { code: "preview_only" } });
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("not found");
  });
}

async function listen(server, port) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

async function check() {
  for (const state of validStates) {
    const server = makeServer(state);
    const port = await listen(server, 0);
    const base = `http://127.0.0.1:${port}`;
    try {
      const page = await fetch(`${base}/portal`);
      if (page.status !== 200 || await page.text() !== portalHtml) throw new Error(`${state}: candidate /portal HTML mismatch`);
      const stats = await fetch(`${base}/portal/stats`);
      const evals = await fetch(`${base}/portal/model-evals.json`);
      if (state === "error") {
        if (stats.status !== 503 || evals.status !== 503) throw new Error("error: expected both synthetic endpoints to return 503");
      } else {
        if (stats.status !== 200 || evals.status !== 200) throw new Error(`${state}: expected synthetic endpoints to return 200`);
        const statsBody = await stats.json();
        const evalsBody = await evals.json();
        if (state === "normal" && (statsBody.total_requests !== 123 || evalsBody.models?.[0]?.id !== "synthetic-preview-model")) {
          throw new Error("normal: expected visible synthetic stats and evaluation");
        }
        if (state === "missing" && (Object.keys(statsBody).length !== 0 || evalsBody.models?.length !== 0)) {
          throw new Error("missing: expected empty stats and evaluations");
        }
      }
      console.log(`${state}: /portal 200, stats ${stats.status}, model-evals ${evals.status}`);
    } finally {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  }
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
  await check();
} else {
  const stateIndex = args.indexOf("--state");
  const portIndex = args.indexOf("--port");
  const state = stateIndex < 0 ? "normal" : args[stateIndex + 1];
  const port = portIndex < 0 ? 4173 : Number(args[portIndex + 1]);
  if (!validStates.has(state)) throw new Error("--state must be normal, missing, or error");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be an integer from 0 to 65535");
  const server = makeServer(state);
  const boundPort = await listen(server, port);
  console.log(`Synthetic ${state} preview: http://127.0.0.1:${boundPort}/portal`);
  process.once("SIGINT", () => server.close(() => process.exit(0)));
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}
