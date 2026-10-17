import { describe, expect, it } from "vitest";
import { handleMcpPost } from "../src/homeserver/mcp.js";
import { parseMcpEnvelope } from "../src/homeserver/mcp-envelope.js";

function response() {
  let statusCode: number | undefined;
  let headers: Record<string, string> | undefined;
  let body = "";
  return {
    res: {
      writeHead(status: number, nextHeaders?: Record<string, string>) {
        statusCode = status;
        headers = nextHeaders;
      },
      end(chunk?: string) {
        body = chunk ?? "";
      },
    } as never,
    read() {
      return { statusCode, headers, body };
    },
  };
}

describe("MCP envelope parser", () => {
  it("distinguishes parse failures from invalid top-level shapes", () => {
    expect(parseMcpEnvelope("{" )).toEqual({ ok: false, kind: "parse" });
    for (const raw of ["null", "[]", "1", "\"text\"", "{}", "{\"jsonrpc\":\"1.0\",\"method\":\"ping\"}", "{\"jsonrpc\":\"2.0\",\"method\":7}"]) {
      expect(parseMcpEnvelope(raw)).toEqual({ ok: false, kind: "invalid" });
    }
  });

  it("keeps the permissive JSON-RPC id shape unchanged", () => {
    expect(parseMcpEnvelope(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 0 }))).toEqual({
      ok: true,
      message: { jsonrpc: "2.0", method: "ping", id: 0 },
    });
    expect(parseMcpEnvelope(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: "" }))).toEqual({
      ok: true,
      message: { jsonrpc: "2.0", method: "ping", id: "" },
    });
    expect(parseMcpEnvelope(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: { unusual: true } }))).toEqual({
      ok: true,
      message: { jsonrpc: "2.0", method: "ping", id: { unusual: true } },
    });
  });
});

describe("MCP transport envelope characterization", () => {
  it.each(["null", "[]", "1", "\"text\"", "{\"jsonrpc\":\"1.0\",\"method\":\"ping\"}", "{\"jsonrpc\":\"2.0\",\"method\":7}", "{\"jsonrpc\":\"2.0\",\"method\":7,\"id\":\"supplied\"}"])(
    "returns a null-id invalid request for %s",
    async (raw) => {
      const capture = response();
      await handleMcpPost(raw, capture.res, undefined as never);
      expect(capture.read().statusCode).toBe(200);
      expect(JSON.parse(capture.read().body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    },
  );

  it("returns parse error for malformed JSON", async () => {
    const capture = response();
    await handleMcpPost("{", capture.res, undefined as never);
    expect(JSON.parse(capture.read().body)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  });

  it.each([undefined, null])("accepts %s id as a notification with an empty 202 response", async (id) => {
    const capture = response();
    await handleMcpPost(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", ...(id === undefined ? {} : { id }) }), capture.res, undefined as never);
    expect(capture.read()).toMatchObject({ statusCode: 202, body: "" });
  });

  it("classifies unsupported notifications as bad requests while preserving 202 and no body", async () => {
    const capture = response();
    const result = await handleMcpPost(JSON.stringify({ jsonrpc: "2.0", method: "unsupported" }), capture.res, undefined as never);
    expect(capture.read()).toMatchObject({ statusCode: 202, body: "" });
    expect(result).toEqual({ trace: { traceOutcome: "bad_request", traceErrorClass: "invalid_request_error" } });
  });

  it.each([0, ""])("keeps falsy id %j as a request", async (id) => {
    const capture = response();
    await handleMcpPost(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id, params: null }), capture.res, undefined as never);
    expect(JSON.parse(capture.read().body)).toEqual({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Unknown tool ''." }], isError: true } });
  });

  it("keeps unusual JSON ids accepted by the existing runtime", async () => {
    const capture = response();
    await handleMcpPost(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: { unusual: true } }), capture.res, undefined as never);
    expect(JSON.parse(capture.read().body)).toEqual({ jsonrpc: "2.0", id: { unusual: true }, result: {} });
  });

  it.each([undefined, null, 7, "params"])("keeps missing, null, and primitive tools/call params as an unknown tool", async (params) => {
    const capture = response();
    await handleMcpPost(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1, ...(params === undefined ? {} : { params }) }), capture.res, undefined as never);
    expect(JSON.parse(capture.read().body)).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Unknown tool ''." }], isError: true } });
  });
});
