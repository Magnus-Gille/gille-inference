import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { resetConfig } from "../src/homeserver/config.js";
import { NARROWER_SCOPES, mintKey, type KeyDefaults, type KeyScope } from "../src/homeserver/keystore.js";
import { startGateway } from "../src/homeserver/gateway.js";

/**
 * INFER-152 N2: the declared narrowing order must match what the running gateway grants. For every
 * allowed narrowing (from -> to), everything the narrowed scope can reach must also be reachable
 * with the original scope. "Reachable" = the gateway does not answer 401/403 (an authorization
 * decision) for the route; the request body is deliberately invalid so nothing is executed.
 */

const DEFAULTS: KeyDefaults = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const SCOPES: KeyScope[] = ["admin", "agent", "inference", "monitor"];

interface Probe { name: string; method: "GET" | "POST"; path: string; body?: unknown }
const ROUTES: Probe[] = [
  { name: "GET /healthz", method: "GET", path: "/healthz" },
  { name: "GET /metrics", method: "GET", path: "/metrics" },
  { name: "GET /ledger", method: "GET", path: "/ledger" },
  { name: "GET /models", method: "GET", path: "/models" },
  { name: "GET /models/residency", method: "GET", path: "/models/residency" },
  { name: "GET /ops/summary", method: "GET", path: "/ops/summary" },
  { name: "GET /portal/me", method: "GET", path: "/portal/me" },
  { name: "GET /admin/keys", method: "GET", path: "/admin/keys" },
  { name: "POST /admin/keys", method: "POST", path: "/admin/keys", body: {} },
  { name: "POST /delegate", method: "POST", path: "/delegate", body: {} },
  { name: "POST /v1/chat/completions", method: "POST", path: "/v1/chat/completions", body: {} },
  { name: "POST /v1/embeddings", method: "POST", path: "/v1/embeddings", body: {} },
];
const MCP_TOOLS_LIST = { jsonrpc: "2.0", id: 1, method: "tools/list" };

let stop: (() => Promise<void>) | null = null;
let port = 0;
const keys = new Map<KeyScope, string>();
const reach = new Map<KeyScope, Set<string>>();

async function call(token: string, probe: Probe): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${probe.path}`, {
    method: probe.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    ...(probe.method === "POST" ? { body: JSON.stringify(probe.body ?? {}) } : {}),
  });
}

async function mcpTools(token: string): Promise<{ status: number; tools: string[] }> {
  const res = await call(token, { name: "mcp", method: "POST", path: "/mcp", body: MCP_TOOLS_LIST });
  if (res.status !== 200) return { status: res.status, tools: [] };
  const text = await res.text();
  const jsonLine = text.trim().startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
  const parsed = JSON.parse(jsonLine) as { result?: { tools?: Array<{ name: string }> } };
  return { status: 200, tools: (parsed.result?.tools ?? []).map((t) => t.name) };
}

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-scope-reach-")), "test.db"));
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  // Dead local port: any request that passes authorization fails fast and never reaches a model.
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:9/v1";
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // All four scopes on the SAME tier so only the scope varies.
  for (const scope of SCOPES) {
    keys.set(scope, mintKey({ alias: `reach-${scope}`, tier: "owner", scope }, DEFAULTS).plaintextKey);
  }
  resetConfig();
  const handle = await startGateway();
  port = handle.port;
  stop = handle.stop;
  for (const scope of SCOPES) {
    const reached = new Set<string>();
    for (const probe of ROUTES) {
      const status = (await call(keys.get(scope)!, probe)).status;
      if (status !== 401 && status !== 403) reached.add(probe.name);
    }
    const mcp = await mcpTools(keys.get(scope)!);
    if (mcp.status !== 401 && mcp.status !== 403) reached.add("POST /mcp");
    for (const tool of mcp.tools) reached.add(`mcp tool ${tool}`);
    reach.set(scope, reached);
  }
});

afterAll(async () => {
  if (stop) await stop();
  vi.restoreAllMocks();
  resetConfig();
});

describe("scope narrowing order matches gateway grants (INFER-152)", () => {
  it("sanity: the probe table distinguishes the scopes", () => {
    expect(reach.get("admin")!.has("GET /admin/keys")).toBe(true);
    expect(reach.get("agent")!.has("GET /admin/keys")).toBe(false);
    expect(reach.get("monitor")!.has("GET /ledger")).toBe(true);
    expect(reach.get("inference")!.has("GET /ledger")).toBe(false);
    expect(reach.get("agent")!.has("GET /ledger")).toBe(false);
    expect([...reach.get("agent")!].some((r) => r.startsWith("mcp tool "))).toBe(true);
    expect(reach.get("agent")!.has("mcp tool ask")).toBe(true);
  });

  const narrowings = SCOPES.flatMap((from) => NARROWER_SCOPES[from].map((to) => [from, to] as const));

  it.each(narrowings)("%s -> %s never reaches anything the original cannot", (from, to) => {
    const extra = [...reach.get(to)!].filter((r) => !reach.get(from)!.has(r));
    expect(extra).toEqual([]);
  });

  it("the unlisted pairs really are not narrowings: each would reach something new", () => {
    for (const from of SCOPES) {
      for (const to of SCOPES) {
        if (from === to || NARROWER_SCOPES[from].includes(to)) continue;
        const extra = [...reach.get(to)!].filter((r) => !reach.get(from)!.has(r));
        // Excluded pairs must NOT be provably subsets, otherwise the order is needlessly strict.
        // (inference -> monitor and agent -> monitor gain /ledger-style reads.)
        if (from === "agent" && to === "monitor") expect(extra).toContain("GET /ledger");
        if (from === "inference" && to === "monitor") expect(extra).toContain("GET /ledger");
        if (to === "admin") expect(extra.length).toBeGreaterThan(0);
      }
    }
  });
});
