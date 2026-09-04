import { describe, expect, it } from "vitest";
import { createM5Client, M5ClientError } from "../client/m5-client.mjs";
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
  }).then((client) => createMcpStdioBridge({ client, profile: "codex" }));
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
      // #154 lower bound: the same abort-driven redaction path with a valid timeout.
      { timeoutMs: 1_000 },
    );

    const failed = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":10,"method":"tools/list"}',
    );
    const recovered = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":11,"method":"tools/list"}',
    );

    expect(JSON.parse(failed!)).toMatchObject({
      id: 10,
      error: {
        code: -32603,
        message: expect.stringMatching(/timed out/i),
        data: {
          m5_code: "timeout",
          diagnostic_code: "connect_timeout",
          failure_layer: "connector_transport",
          retryable: true,
          remediation: expect.stringContaining("m5 --profile codex doctor"),
        },
      },
    });
    expect(failed).not.toContain(SECRET);
    expect(JSON.parse(recovered!)).toMatchObject({
      id: 11,
      result: { tools: [] },
    });
  });

  it("retries code_loop_result once with the same work id after a transient transport failure", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const bridge = await makeBridge(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (requests.length === 1) {
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
        });
      }
      return rpcResponse(Number(request.id), {
        content: [{ type: "text", text: "{}" }],
        isError: false,
        structuredContent: {
          status: "cap-exceeded",
          work_id: "cl-terminal",
          diff: "",
          check: { ran: false },
        },
      });
    });
    const message = {
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: { name: "code_loop_result", arguments: { work_id: "cl-terminal" } },
    };

    const response = await bridge.handleLine(JSON.stringify(message));

    expect(requests).toEqual([message, message]);
    expect(JSON.parse(response!)).toMatchObject({
      id: 19,
      result: {
        isError: false,
        structuredContent: { status: "cap-exceeded", work_id: "cl-terminal" },
      },
    });
  });

  it("reports exhausted code_loop_result recovery separately from an unknown or lost result", async () => {
    let calls = 0;
    const bridge = createMcpStdioBridge({
      client: {
        rpc: async () => {
          calls += 1;
          throw new M5ClientError("network_failure", "temporary result fetch failure", {
            diagnosticCode: "connection_reset",
            failureLayer: "gateway_transport",
            retryable: true,
          });
        },
      },
      profile: "codex",
    });

    const response = await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "code_loop_result", arguments: { work_id: "cl-terminal" } },
    }));

    expect(calls).toBe(2);
    expect(JSON.parse(response!)).toMatchObject({
      id: 20,
      error: {
        code: -32603,
        data: {
          m5_code: "network_failure",
          retryable: true,
          result_recovery: {
            status: "retry_exhausted",
            automatic_retries: 1,
            action: "retry_same_work_id",
          },
        },
      },
    });
  });

  it("reports an exhausted automatic retry when the second failure changes category", async () => {
    let calls = 0;
    const bridge = createMcpStdioBridge({
      client: {
        rpc: async () => {
          calls += 1;
          if (calls === 1) {
            throw new M5ClientError("network_failure", "temporary result fetch failure", {
              diagnosticCode: "connection_reset",
              failureLayer: "gateway_transport",
              retryable: true,
            });
          }
          throw new M5ClientError("rejected_credential", "credential rotated", {
            failureLayer: "authentication",
            retryable: false,
          });
        },
      },
      profile: "codex",
    });

    const response = await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: { name: "code_loop_result", arguments: { work_id: "cl-terminal" } },
    }));

    expect(calls).toBe(2);
    expect(JSON.parse(response!)).toMatchObject({
      id: 22,
      error: {
        code: -32603,
        data: {
          m5_code: "rejected_credential",
          retryable: false,
          result_recovery: {
            status: "retry_exhausted",
            automatic_retries: 1,
            action: "follow_error_remediation",
          },
        },
      },
    });
  });

  it("does not retry a non-retryable first code_loop_result failure", async () => {
    let calls = 0;
    const bridge = createMcpStdioBridge({
      client: {
        rpc: async () => {
          calls += 1;
          throw new M5ClientError("rejected_credential", "credential rejected", {
            failureLayer: "authentication",
            retryable: false,
          });
        },
      },
      profile: "codex",
    });

    const response = await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: { name: "code_loop_result", arguments: { work_id: "cl-terminal" } },
    }));

    expect(calls).toBe(1);
    const parsed = JSON.parse(response!);
    expect(parsed).toMatchObject({
      id: 23,
      error: {
        code: -32603,
        data: { m5_code: "rejected_credential", retryable: false },
      },
    });
    expect(parsed.error.data).not.toHaveProperty("result_recovery");
  });

  it.each([
    {
      label: "unknown",
      payload: { error: "unknown work_id", work_id: "cl-terminal" },
    },
    {
      label: "lost",
      payload: {
        status: "cap-exceeded",
        work_id: "cl-terminal",
        error: "terminal result unavailable after restart",
      },
    },
  ])("does not transport-retry a structured $label result", async ({ payload }) => {
    let calls = 0;
    const bridge = await makeBridge(async (_input, init) => {
      calls += 1;
      const request = JSON.parse(String(init?.body)) as { id: number };
      return rpcResponse(request.id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        isError: true,
        structuredContent: payload,
      });
    });

    const response = await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "code_loop_result", arguments: { work_id: "cl-terminal" } },
    }));

    expect(calls).toBe(1);
    expect(JSON.parse(response!)).toMatchObject({
      id: 21,
      result: { isError: true, structuredContent: payload },
    });
  });

  it.each([
    ["dns_failure", "ENOTFOUND"],
    ["dns_failure", "EAI_AGAIN"],
    ["connection_refused", "ECONNREFUSED"],
    ["route_unreachable", "ENETUNREACH"],
    ["tls_failure", "CERT_HAS_EXPIRED"],
  ])("returns a redacted connector-layer %s diagnostic", async (diagnosticCode, causeCode) => {
    const bridge = await makeBridge(async () => {
      throw Object.assign(new TypeError(`fetch failed ${SECRET}`), {
        cause: Object.assign(new Error(`transport failed at https://private.invalid/${SECRET}`), {
          code: causeCode,
        }),
      });
    });

    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"ask","arguments":{"model":"mellum","prompt":"bounded"}}}',
    );
    const parsed = JSON.parse(response!);
    expect(parsed).toMatchObject({
      id: 15,
      error: {
        code: -32603,
        data: {
          m5_code: "network_failure",
          diagnostic_code: diagnosticCode,
          failure_layer: "connector_transport",
          retryable: true,
          remediation: expect.stringContaining("m5 --profile codex doctor"),
        },
      },
    });
    expect(response).not.toContain(SECRET);
    expect(response).not.toContain("private.invalid");
  });

  it("bounds malformed cyclic cause traversal and returns the residual category", async () => {
    const cyclic = Object.assign(new TypeError("fetch failed"), { code: "UNKNOWN_TRANSPORT" }) as Error & {
      cause?: unknown;
    };
    cyclic.cause = cyclic;
    const bridge = await makeBridge(async () => { throw cyclic; });
    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":18,"method":"tools/list"}',
    );
    expect(JSON.parse(response!)).toMatchObject({
      error: {
        data: {
          m5_code: "network_failure",
          diagnostic_code: "network_failure",
          failure_layer: "connector_transport",
        },
      },
    });
  });

  it("makes an adoption-report outage explicitly recoverable without echoing its payload", async () => {
    const bridge = await makeBridge(async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("unreachable"), { code: "ENETUNREACH" }),
      });
    });
    const report = {
      harness: "codex_app",
      execution_mode: "ask",
      traffic_purpose: "organic",
      result: "failed",
      deterministic_check: "not_run",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_unreachable",
      eligible_opportunities: 7,
    };
    const response = await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: { name: "record_adoption_evidence", arguments: report },
    }));
    const parsed = JSON.parse(response!);
    expect(parsed).toMatchObject({
      error: {
        data: {
          m5_code: "network_failure",
          diagnostic_code: "route_unreachable",
          failure_layer: "connector_transport",
          retryable: true,
          evidence_recovery: { status: "not_recorded", action: "retry_same_tool_call" },
        },
      },
    });
    expect(response).not.toContain("codex_app");
    expect(response).not.toContain("eligible_opportunities");
  });

  it("distinguishes gateway health failures from connector transport failures", async () => {
    const bridge = await makeBridge(async () => new Response("", { status: 503 }));
    const response = await bridge.handleLine(
      '{"jsonrpc":"2.0","id":17,"method":"tools/list"}',
    );
    expect(JSON.parse(response!)).toMatchObject({
      error: {
        data: {
          m5_code: "upstream_http_error",
          diagnostic_code: "gateway_http_error",
          failure_layer: "gateway_health",
          http_status: 503,
          retryable: true,
        },
      },
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

  it.each(["missing_credential", "rejected_credential"])(
    "preserves the M5 %s category and canonical redacted remediation",
    async (code) => {
      const bridge = createMcpStdioBridge({
        client: {
          rpc: async () => {
            throw new M5ClientError(
              code,
              `gateway rejected Bearer ${SECRET}`,
              { remediation: `Run curl https://unsafe.invalid/${SECRET}` },
            );
          },
        },
        profile: "codex",
      });

      const response = await bridge.handleLine(
        '{"jsonrpc":"2.0","id":14,"method":"tools/list"}',
      );
      const parsed = JSON.parse(response!);
      expect(parsed).toMatchObject({
        id: 14,
        error: {
          code: -32603,
          data: {
            m5_code: code,
            remediation: expect.stringContaining("Keychain recovery/rotation"),
          },
        },
      });
      expect(parsed.error.message).toContain("m5 --profile codex doctor");
      expect(response).not.toContain(SECRET);
      expect(response).not.toContain("unsafe.invalid");
    },
  );

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
