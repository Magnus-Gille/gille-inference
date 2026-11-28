import { describe, expect, it } from "vitest";
import { createM5Client, M5ClientError } from "../client/m5-client.mjs";
import { createMcpStdioBridge } from "../client/m5-stdio-bridge.mjs";

// INFER-242 mixed-health regression: model discovery succeeds, the
// first `ask` fails at the connector transport before any gateway response, and the prescribed
// identical retry is refused by gateway admission as busy. Each step must name its own layer, and
// the busy refusal must keep the gateway's machine-readable cause and correlation id instead of
// collapsing into a generic tool error.

const SECRET = "hs_mixed_health_secret-never-print";
const LOCATOR = "gateway.invalid";
const BUSY_REQUEST_ID = "5b0c7a2e-3f41-4c8e-9d6a-0e1f2a3b4c5d";

function rpcResult(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** list_models answers; the 1st ask never gets response headers; the 2nd is refused busy. */
function mixedHealthFetch(): typeof globalThis.fetch {
  let askCalls = 0;
  return ((_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
    if (request.params?.name === "list_models") {
      return Promise.resolve(rpcResult(request.id, {
        content: [{ type: "text", text: "No models are available to this key." }],
        isError: false,
      }));
    }
    if (request.params?.name === "ask") {
      askCalls += 1;
      if (askCalls === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${LOCATOR}`)), { once: true });
        });
      }
      return Promise.resolve(rpcResult(request.id, {
        content: [{ type: "text", text: "The server is busy. Retry after 5s." }],
        isError: true,
        _meta: { m5_code: "server_busy", request_id: BUSY_REQUEST_ID, retryable: true, retry_after_seconds: 5 },
      }));
    }
    return Promise.resolve(rpcResult(request.id, { tools: [{ name: "ask", inputSchema: { type: "object" } }] }));
  }) as never;
}

async function mixedHealthClient() {
  return createM5Client({
    gatewayUrl: `https://${LOCATOR}`,
    profile: "codex",
    credentialStore: { resolve: async () => SECRET },
    fetch: mixedHealthFetch(),
    timeoutMs: 1_000,
  });
}

function expectNoLeak(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SECRET);
  expect(serialized).not.toContain(LOCATOR);
}

describe("mixed health: discovery ok, ask connector timeout, retry busy (INFER-242)", () => {
  it("m5 client names each layer and keeps the gateway's busy cause and request id", async () => {
    const client = await mixedHealthClient();
    await expect(client.models()).resolves.toEqual({ models: [] });

    const first = await client.ask({ model: "mellum", prompt: "bounded task" }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(M5ClientError);
    expect(first).toMatchObject({
      code: "timeout",
      diagnosticCode: "connect_timeout",
      failureLayer: "gateway_transport",
      retryable: true,
    });
    // The request never reached the gateway, so there is no gateway request id to report and the
    // client must not invent one.
    expect((first as M5ClientError).toJSON("codex").error).not.toHaveProperty("request_id");
    expectNoLeak((first as M5ClientError).toJSON("codex"));

    const retry = await client.ask({ model: "mellum", prompt: "bounded task" }).catch((e: unknown) => e);
    expect(retry).toBeInstanceOf(M5ClientError);
    expect(retry).toMatchObject({
      code: "server_busy",
      retryable: true,
      retryAfterSeconds: 5,
      requestId: BUSY_REQUEST_ID,
    });
    const retryJson = (retry as M5ClientError).toJSON("codex").error;
    expect(retryJson).toMatchObject({
      code: "server_busy",
      retryable: true,
      retry_after_seconds: 5,
      request_id: BUSY_REQUEST_ID,
    });
    expect(retryJson).not.toHaveProperty("failure_layer", "gateway_transport");
    expectNoLeak(retryJson);
  });

  it("the MCP bridge reports connector_transport first and passes the busy cause through", async () => {
    const bridge = createMcpStdioBridge({ client: await mixedHealthClient(), profile: "codex" });
    const ask = (id: number) => bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "ask", arguments: { model: "mellum", prompt: "bounded task" } },
    }));

    const models = JSON.parse((await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_models", arguments: {} },
    })))!);
    expect(models.result.isError).toBe(false);

    const firstLine = (await ask(2))!;
    const first = JSON.parse(firstLine);
    expect(first.error.code).toBe(-32603);
    expect(first.error.data).toMatchObject({
      m5_code: "timeout",
      diagnostic_code: "connect_timeout",
      failure_layer: "connector_transport",
      retryable: true,
    });
    expect(first.error.data).not.toHaveProperty("request_id");
    expect(first.error.message).toContain("failure_layer=connector_transport");
    expectNoLeak(firstLine);

    const retryLine = (await ask(3))!;
    const retry = JSON.parse(retryLine);
    expect(retry.result.isError).toBe(true);
    expect(retry.result._meta).toMatchObject({
      m5_code: "server_busy",
      request_id: BUSY_REQUEST_ID,
      retryable: true,
      retry_after_seconds: 5,
    });
    expectNoLeak(retryLine);
  });
});
