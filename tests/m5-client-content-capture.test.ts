import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { createM5Client } from "../client/m5-client.mjs";
import { main } from "../client/m5.mjs";
import { createMcpStdioBridge } from "../client/m5-stdio-bridge.mjs";

/**
 * #487 — the m5 client never sends content under `content_capture:"none"` to a gateway that does
 * not advertise the opt-out for that tool (an older gateway would silently ignore the argument and
 * capture the content), and fails closed when an advertising gateway does not confirm it.
 */

const SECRET = "hs_owner_content_capture_secret";
const CANARY = "CANARY_CLIENT_RESTRICTED_PROMPT";

function rpcResult(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "content-type": "application/json" } });
}

const ASK_STRUCTURED = {
  model: "m1", text: "answer", finish_reason: "stop", truncated: false, metered: true,
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, reasoning_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null },
};

interface Stub {
  calls: string[];
  bodies: string[];
  fetch: (url: unknown, init?: RequestInit) => Promise<Response>;
}

function stub(opts: { advertised: boolean; echo: boolean; startResult?: Record<string, unknown> }): Stub {
  const calls: string[] = [];
  const bodies: string[] = [];
  const capture = opts.advertised ? { content_capture: { type: "string", enum: ["none"] } } : {};
  return {
    calls,
    bodies,
    fetch: async (_url, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const request = JSON.parse(body) as { id: number; method: string; params: { name?: string } };
      calls.push(request.method === "tools/call" ? request.params.name! : request.method);
      if (request.method === "tools/list") {
        return rpcResult(request.id, { tools: [
          { name: "ask", inputSchema: { type: "object", properties: { model: { type: "string" }, ...capture } } },
          { name: "code_loop_start", inputSchema: { type: "object", properties: {
            instruction: { type: "string" }, ...capture,
            caps: { type: "object", properties: { total_wall_s: { type: "integer", minimum: 90, maximum: 900 } } },
          } } },
        ] });
      }
      if (request.params.name === "ask") {
        return rpcResult(request.id, {
          content: [{ type: "text", text: "answer" }], isError: false, structuredContent: ASK_STRUCTURED,
          ...(opts.echo ? { _meta: { content_capture: "suppressed" } } : {}),
        });
      }
      const started = opts.startResult ?? { work_id: "cl-20261020-00000001", status: "running", ...(opts.echo ? { content_capture: "suppressed" } : {}) };
      return rpcResult(request.id, { content: [{ type: "text", text: JSON.stringify(started) }], isError: false, structuredContent: started });
    },
  };
}

async function client(s: Stub) {
  return createM5Client({ gatewayUrl: "https://gateway.invalid", profile: "codex", credentialStore: { resolve: async () => SECRET }, fetch: s.fetch });
}

describe("ask content_capture:'none'", () => {
  it("preflights the live schema, sends the opt-out, and reports the confirmed marker", async () => {
    const s = stub({ advertised: true, echo: true });
    const result = await (await client(s)).ask({ model: "m1", prompt: CANARY, content_capture: "none" });
    expect(result).toMatchObject({ text: "answer", content_capture: "suppressed" });
    expect(s.calls).toEqual(["tools/list", "ask"]);
    expect(JSON.parse(s.bodies[1]!).params.arguments.content_capture).toBe("none");
  });

  it("never sends the prompt to a gateway that does not advertise the opt-out", async () => {
    const s = stub({ advertised: false, echo: false });
    await expect((await client(s)).ask({ model: "m1", prompt: CANARY, content_capture: "none" }))
      .rejects.toMatchObject({ code: "content_capture_unsupported" });
    expect(s.calls).toEqual(["tools/list"]);
    expect(s.bodies.join("\n")).not.toContain(CANARY);
  });

  it("fails closed when the gateway does not confirm suppression", async () => {
    const s = stub({ advertised: true, echo: false });
    await expect((await client(s)).ask({ model: "m1", prompt: CANARY, content_capture: "none" }))
      .rejects.toMatchObject({ code: "content_capture_unconfirmed" });
  });

  it("rejects an unknown value before any network call", async () => {
    const s = stub({ advertised: true, echo: true });
    await expect((await client(s)).ask({ model: "m1", prompt: CANARY, content_capture: "metadata" }))
      .rejects.toMatchObject({ code: "invalid_input" });
    expect(s.calls).toEqual([]);
  });

  it("an ordinary ask is unchanged (no preflight, no marker)", async () => {
    const s = stub({ advertised: true, echo: false });
    const result = await (await client(s)).ask({ model: "m1", prompt: "plain" });
    expect(result).not.toHaveProperty("content_capture");
    expect(s.calls).toEqual(["ask"]);
  });
});

describe("code run content_capture:'none'", () => {
  const input = { instruction: CANARY, files: [{ path: "a.txt", content: CANARY }], content_capture: "none", wait: false };

  it("preflights once (also covering total_wall_s) and returns the confirmed start", async () => {
    const s = stub({ advertised: true, echo: true });
    const started = await (await client(s)).codeRun({ ...input, caps: { total_wall_s: 180 } });
    expect(started).toMatchObject({ work_id: "cl-20261020-00000001", content_capture: "suppressed" });
    expect(s.calls).toEqual(["tools/list", "code_loop_start"]);
  });

  it("never dispatches seed content to a gateway that does not advertise the opt-out", async () => {
    const s = stub({ advertised: false, echo: false });
    await expect((await client(s)).codeRun(input)).rejects.toMatchObject({ code: "content_capture_unsupported" });
    expect(s.calls).toEqual(["tools/list"]);
    expect(s.bodies.join("\n")).not.toContain(CANARY);
  });

  it("fails closed when an accepted start is not confirmed as suppressed", async () => {
    const s = stub({ advertised: true, echo: false });
    await expect((await client(s)).codeRun(input)).rejects.toMatchObject({ code: "content_capture_unconfirmed" });
  });

  it("returns a structured refusal unchanged", async () => {
    const refusal = { refusal: "content-capture-unsupported", message: "no relay" };
    const s = stub({ advertised: true, echo: false, startResult: refusal });
    await expect((await client(s)).codeRun(input)).resolves.toMatchObject(refusal);
  });
});

describe("m5 CLI --content-capture", () => {
  function sink() {
    let value = "";
    return { stream: { write(chunk: string) { value += chunk; return true; } }, text: () => value };
  }
  const configLoader = () => ({ version: 1, profiles: { codex: { publicGatewayUrl: "https://public.invalid", privateGatewayUrl: "http://private.invalid:8080" } } });

  it("adds content_capture:'none' to a direct ask", async () => {
    const s = stub({ advertised: true, echo: true });
    const output = sink();
    const error = sink();
    const exit = await main(["--profile", "codex", "--content-capture", "none", "ask"], {
      input: Readable.from([JSON.stringify({ model: "m1", prompt: CANARY })]),
      output: output.stream, error: error.stream, configLoader,
      credentialStore: { resolve: async () => SECRET }, fetch: s.fetch,
    });
    expect(error.text()).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({ content_capture: "suppressed" });
    expect(JSON.parse(s.bodies[1]!).params.arguments.content_capture).toBe("none");
  });

  it.each([
    ["an unknown value", ["--profile", "codex", "--content-capture", "full", "ask"]],
    ["a missing value", ["--profile", "codex", "--content-capture"]],
    ["a duplicate", ["--profile", "codex", "--content-capture", "none", "--content-capture", "none", "ask"]],
    ["a command that carries no content", ["--profile", "codex", "--content-capture", "none", "models"]],
  ])("rejects %s before any network access", async (_label, argv) => {
    const s = stub({ advertised: true, echo: true });
    const error = sink();
    const exit = await main(argv, {
      input: Readable.from(["{}"]), output: sink().stream, error: error.stream, configLoader,
      credentialStore: { resolve: async () => SECRET }, fetch: s.fetch,
    });
    expect(exit).toBe(1);
    expect(JSON.parse(error.text()).error.code).toBe("invalid_args");
    expect(s.calls).toEqual([]);
  });
});

describe("stdio MCP bridge content_capture:'none'", () => {
  async function bridge(s: Stub) {
    return createMcpStdioBridge({ client: await client(s), profile: "codex" });
  }
  const call = (name: string, args: Record<string, unknown>) =>
    JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } });

  it("forwards an ask after the schema preflight and passes the confirmed result through", async () => {
    const s = stub({ advertised: true, echo: true });
    const out = JSON.parse((await (await bridge(s)).handleLine(call("ask", { model: "m1", prompt: CANARY, content_capture: "none" })))!);
    expect(out.result._meta.content_capture).toBe("suppressed");
    expect(s.calls).toEqual(["tools/list", "ask"]);
  });

  it("refuses to forward to a gateway that does not advertise the opt-out", async () => {
    const s = stub({ advertised: false, echo: false });
    const out = JSON.parse((await (await bridge(s)).handleLine(call("code_loop_start", { ...{ instruction: CANARY, files: [] }, content_capture: "none" })))!);
    expect(out.error.data.m5_code).toBe("content_capture_unsupported");
    expect(s.calls).toEqual(["tools/list"]);
    expect(s.bodies.join("\n")).not.toContain(CANARY);
  });

  it("turns an unconfirmed success into an error", async () => {
    const s = stub({ advertised: true, echo: false });
    const out = JSON.parse((await (await bridge(s)).handleLine(call("ask", { model: "m1", prompt: CANARY, content_capture: "none" })))!);
    expect(out.error.data.m5_code).toBe("content_capture_unconfirmed");
    expect(JSON.stringify(out)).not.toContain("answer");
  });

  it("rejects an unknown value without any gateway call", async () => {
    const s = stub({ advertised: true, echo: true });
    const out = JSON.parse((await (await bridge(s)).handleLine(call("ask", { model: "m1", prompt: CANARY, content_capture: "partial" })))!);
    expect(out.error.data.m5_code).toBe("invalid_input");
    expect(s.calls).toEqual([]);
  });

  it("leaves an ordinary ask untouched", async () => {
    const s = stub({ advertised: true, echo: false });
    const out = JSON.parse((await (await bridge(s)).handleLine(call("ask", { model: "m1", prompt: "plain" })))!);
    expect(out.result.isError).toBe(false);
    expect(s.calls).toEqual(["ask"]);
  });
});

describe("generic client entry points cannot bypass the guard", () => {
  it("client.tool('ask', …) preflights and refuses an unadvertised gateway", async () => {
    const s = stub({ advertised: false, echo: false });
    await expect((await client(s)).tool("ask", { model: "m1", prompt: CANARY, content_capture: "none" }))
      .rejects.toMatchObject({ code: "content_capture_unsupported" });
    expect(s.calls).toEqual(["tools/list"]);
    expect(s.bodies.join("\n")).not.toContain(CANARY);
  });

  it("client.rpc(tools/call code_loop_start) preflights and requires confirmation", async () => {
    const message = { jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "code_loop_start", arguments: { instruction: CANARY, files: [], content_capture: "none" } } };
    const unsupported = stub({ advertised: false, echo: false });
    await expect((await client(unsupported)).rpc(message)).rejects.toMatchObject({ code: "content_capture_unsupported" });
    expect(unsupported.bodies.join("\n")).not.toContain(CANARY);
    const unconfirmed = stub({ advertised: true, echo: false });
    await expect((await client(unconfirmed)).rpc(message)).rejects.toMatchObject({ code: "content_capture_unconfirmed" });
    const confirmed = stub({ advertised: true, echo: true });
    await expect((await client(confirmed)).rpc(message)).resolves.toMatchObject({ result: { structuredContent: { content_capture: "suppressed" } } });
  });
});
