#!/usr/bin/env node
// Content-free route monitor: tools/call(list_models) exercises the authenticated
// MCP bridge without loading a model or recording prompt/response content.
import { pathToFileURL } from "node:url";

function checkedOrigin(value, publicRoute = false) {
  if (typeof value !== "string" || !value) throw new Error("monitor route is not configured");
  const url = new URL(value);
  if ((publicRoute ? url.protocol !== "https:" : !["http:", "https:"].includes(url.protocol)) ||
      url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("monitor route must be an HTTP(S) origin");
  }
  return url.origin;
}

export async function probeMcpTool(origin, key, fetchImpl = globalThis.fetch, publicRoute = false) {
  const base = checkedOrigin(origin, publicRoute);
  if (typeof key !== "string" || !key) throw new Error("monitor credential is not configured");
  try {
    const response = await fetchImpl(`${base}/mcp`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "list_models", arguments: {} },
      }),
    });
    if (!response.ok) return `http_${response.status}`;
    let body;
    try {
      body = await response.json();
    } catch {
      return "mcp_error";
    }
    return body?.jsonrpc === "2.0" && body?.id === 1 &&
      body?.result?.isError === false && Array.isArray(body.result.content)
      ? "ok" : "mcp_error";
  } catch {
    return "transport_error";
  }
}

export async function monitorMcp({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  // Fail configuration before touching either route. Never return origins or credentials.
  checkedOrigin(env.M5_PROBE_PUBLIC_URL, true);
  checkedOrigin(env.M5_PROBE_PRIVATE_URL);
  if (!env.M5_PROBE_KEY) throw new Error("monitor credential is not configured");
  return {
    public: await probeMcpTool(env.M5_PROBE_PUBLIC_URL, env.M5_PROBE_KEY, fetchImpl, true),
    private: await probeMcpTool(env.M5_PROBE_PRIVATE_URL, env.M5_PROBE_KEY, fetchImpl),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await monitorMcp();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.public !== "ok" || result.private !== "ok") process.exitCode = 1;
  } catch {
    process.stderr.write("MCP monitor configuration invalid\n");
    process.exitCode = 2;
  }
}
