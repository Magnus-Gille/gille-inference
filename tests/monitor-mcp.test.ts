import { describe, expect, it } from "vitest";
import { monitorMcp, probeMcpTool } from "../scripts/monitor-mcp.mjs";

const env = {
  M5_PROBE_PUBLIC_URL: "https://public.invalid",
  M5_PROBE_PRIVATE_URL: "http://private.invalid:8080",
  M5_PROBE_KEY: "secret-must-not-escape",
};

describe("authenticated MCP route monitor", () => {
  it("exercises tools/call on both routes without inference or logged content", async () => {
    const calls: string[] = [];
    const result = await monitorMcp({ env, fetchImpl: async (url, init) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ method: "tools/call", params: { name: "list_models", arguments: {} } });
      expect(init?.redirect).toBe("error");
      calls.push(String(url));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: false, content: [] } }));
    } });
    expect(result).toEqual({ public: "ok", private: "ok" });
    expect(calls).toEqual(["https://public.invalid/mcp", "http://private.invalid:8080/mcp"]);
    expect(JSON.stringify(result)).not.toContain(env.M5_PROBE_KEY);
  });

  it("distinguishes public 530, private timeout, and misleading catalogue envelopes", async () => {
    const result = await monitorMcp({ env, fetchImpl: async (url) => {
      if (String(url).startsWith("https:")) return new Response("error code: 1033", { status: 530 });
      throw new Error("private locator and secret-must-not-escape");
    } });
    expect(result).toEqual({ public: "http_530", private: "transport_error" });
    expect(await probeMcpTool(env.M5_PROBE_PUBLIC_URL, env.M5_PROBE_KEY, async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [] } }))
    )).toBe("mcp_error");
  });

  it("rejects malformed route configuration before any request", async () => {
    let calls = 0;
    await expect(monitorMcp({ env: { ...env, M5_PROBE_PRIVATE_URL: "http://user:pass@private.invalid" },
      fetchImpl: async () => { calls += 1; throw new Error("unexpected"); },
    })).rejects.toThrow(/origin/);
    expect(calls).toBe(0);
    await expect(monitorMcp({ env: { ...env, M5_PROBE_PUBLIC_URL: "http://public.invalid" },
      fetchImpl: async () => { calls += 1; throw new Error("unexpected"); },
    })).rejects.toThrow(/origin/);
    expect(calls).toBe(0);
  });
});
