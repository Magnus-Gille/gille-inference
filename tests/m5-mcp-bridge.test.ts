import { describe, expect, it } from "vitest";
import { createM5Client } from "../client/m5-client.mjs";
import { createMcpStdioBridge } from "../client/m5-stdio-bridge.mjs";

const SECRET = "hs_bridge_secret-never-print";

function rpcResponse(id: number, result: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeBridge(
  fetch: typeof globalThis.fetch,
  options: { timeoutMs?: number } = {},
) {
  return createM5Client({
    gatewayUrl: "https://gateway.invalid",
    profile: "codex",
    credentialStore: { resolve: async () => SECRET },
    fetch,
    timeoutMs: options.timeoutMs,
  }).then((client) => createMcpStdioBridge({ client }));
}

describe("m5 stdio MCP conformance", () => {
  it("covers initialize, tools/list, tools/call, and notifications with session continuity", async () => {
    const seen: Array<{
      url: string;
      request: Record<string, unknown>;
      headers: Record<string, string>;
    }> = [];
    const bridge = await makeBridge(async (input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id?: number;
        method: string;
      };
      seen.push({
        url: String(input),
        request,
        headers: init?.headers as Record<string, string>,
      });
      if (request.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      if (request.method === "initialize") {
        return rpcResponse(
          request.id!,
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "m5-local-models", version: "1.0.0" },
          },
          { "mcp-session-id": "session-1" },
        );
      }
      if (request.method === "tools/list") {
        return rpcResponse(request.id!, {
          tools: [{ name: "ask", inputSchema: { type: "object" } }],
        });
      }
      return rpcResponse(request.id!, {
        content: [{ type: "text", text: "local answer" }],
        isError: false,
      });
    });

    const initialize = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
    );
    const notification = await bridge.handleLine(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    );
    const list = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    );
    const call = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"model":"mellum","prompt":"hi"}}}',
    );

    expect(JSON.parse(initialize!)).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });
    expect(notification).toBeNull();
    expect(JSON.parse(list!)).toMatchObject({
      id: 2,
      result: { tools: [{ name: "ask" }] },
    });
    expect(JSON.parse(call!)).toMatchObject({
      id: 3,
      result: { content: [{ text: "local answer" }], isError: false },
    });
    expect(seen.every((entry) => entry.url === "https://gateway.invalid/mcp")).toBe(true);
    expect(seen.slice(1).every((entry) => entry.headers["mcp-session-id"] === "session-1")).toBe(
      true,
    );
    expect(JSON.stringify([initialize, list, call])).not.toContain(SECRET);
  });

  it("handles 202/no-body notifications and rejects no-body request responses", async () => {
    const bridge = await makeBridge(async () => new Response(null, { status: 202 }));

    await expect(
      bridge.handleLine('{"jsonrpc":"2.0","method":"notifications/progress"}'),
    ).resolves.toBeNull();
    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":5,"method":"tools/list"}',
    );
    expect(JSON.parse(response!)).toMatchObject({
      id: 5,
      error: { code: -32603, message: expect.stringMatching(/empty response/i) },
    });
  });

  it("returns local parse/shape errors without sending malformed JSON-RPC upstream", async () => {
    let calls = 0;
    const bridge = await makeBridge(async () => {
      calls += 1;
      throw new Error("must not be called");
    });

    expect(JSON.parse((await bridge.handleLine("{nope"))!)).toMatchObject({
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(
      JSON.parse((await bridge.handleLine('{"jsonrpc":"1.0","id":1,"method":"x"}'))!),
    ).toMatchObject({
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(calls).toBe(0);
  });

  it("redacts timeouts and upstream failures, then reconnects on the next message", async () => {
    let attempt = 0;
    const bridge = await makeBridge(
      async (_input, init) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error(`request timed out with Bearer ${SECRET}`));
            });
          });
        }
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResponse(request.id, { tools: [] });
      },
      { timeoutMs: 5 },
    );

    const failed = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":10,"method":"tools/list"}',
    );
    const recovered = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":11,"method":"tools/list"}',
    );

    expect(JSON.parse(failed!)).toMatchObject({
      id: 10,
      error: { code: -32603, message: expect.stringMatching(/timed out/i) },
    });
    expect(failed).not.toContain(SECRET);
    expect(JSON.parse(recovered!)).toMatchObject({
      id: 11,
      result: { tools: [] },
    });
  });

  it("reconnects once without a stale HTTP MCP session", async () => {
    const sessions: Array<string | undefined> = [];
    let calls = 0;
    const bridge = await makeBridge(async (_input, init) => {
      calls += 1;
      const headers = init?.headers as Record<string, string>;
      sessions.push(headers["mcp-session-id"]);
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      if (calls === 1) {
        return rpcResponse(request.id, { protocolVersion: "2025-06-18" }, {
          "mcp-session-id": "stale-session",
        });
      }
      if (calls === 2) return new Response(null, { status: 404 });
      return rpcResponse(request.id, { tools: [] });
    });

    await bridge.handleLine('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    const recovered = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    );

    expect(sessions).toEqual([undefined, "stale-session", undefined]);
    expect(JSON.parse(recovered!)).toMatchObject({
      id: 2,
      result: { tools: [] },
    });
  });

  it("redacts malformed upstream JSON-RPC error messages before stdout", async () => {
    const bridge = await makeBridge(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32000, message: `upstream echoed ${SECRET}` },
        }),
        { status: 200 },
      ),
    );

    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    );
    expect(response).not.toContain(SECRET);
    expect(response).toContain("[REDACTED]");
  });

  it("rejects a mismatched upstream response id as malformed JSON-RPC", async () => {
    const bridge = await makeBridge(async () => rpcResponse(999, { tools: [] }));

    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":12,"method":"tools/list"}',
    );
    expect(JSON.parse(response!)).toMatchObject({
      id: 12,
      error: { code: -32603, message: expect.stringMatching(/malformed JSON-RPC/i) },
    });
  });

  it.each([
    {},
    { code: "-32000", message: "wrong code type" },
    { code: -32000.5, message: "fractional code" },
    { code: -32000, message: 42 },
  ])("rejects malformed upstream JSON-RPC error envelope %#", async (error) => {
    const bridge = await makeBridge(async () =>
      new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 13, error }),
        { status: 200 },
      ),
    );

    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":13,"method":"tools/list"}',
    );
    expect(JSON.parse(response!)).toMatchObject({
      id: 13,
      error: { code: -32603, message: expect.stringMatching(/malformed JSON-RPC/i) },
    });
  });
});
