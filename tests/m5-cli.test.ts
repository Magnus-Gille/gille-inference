import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { main } from "../client/m5.mjs";

const SECRET = "hs_cli_secret-never-print";
const PUBLIC_URL = "https://public.private-locator.invalid";
const PRIVATE_URL = "http://private.private-locator.invalid:8080";

function sink() {
  let value = "";
  return {
    stream: {
      write(chunk: string) {
        value += chunk;
        return true;
      },
    },
    text: () => value,
  };
}

function configLoader() {
  return {
    version: 1,
    profiles: {
      codex: {
        publicGatewayUrl: PUBLIC_URL,
        privateGatewayUrl: PRIVATE_URL,
      },
    },
  };
}

describe("m5 command surface", () => {
  it("requires an explicit profile before credential lookup", async () => {
    let keychainCalls = 0;
    const output = sink();
    const error = sink();
    const exitCode = await main(["models"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: {
        resolve: async () => {
          keychainCalls += 1;
          return SECRET;
        },
      },
    });

    expect(exitCode).toBe(1);
    expect(keychainCalls).toBe(0);
    expect(JSON.parse(error.text())).toMatchObject({
      error: { code: "profile_required" },
    });
    expect(output.text()).toBe("");
  });

  it("prints structured models JSON and never the internally resolved credential", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "models"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("error");
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [
                {
                  type: "text",
                  text: "Models available to you:\n- mellum — very fast",
                },
              ],
              isError: false,
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({
      models: [{ id: "mellum", description: "very fast" }],
    });
    expect(error.text()).toBe("");
    expect(`${output.text()}${error.text()}`).not.toContain(SECRET);
  });

  it("allows HTTP only when the configured private endpoint is selected explicitly", async () => {
    const output = sink();
    const error = sink();
    const seen: string[] = [];
    const exitCode = await main(["--profile", "codex", "--private", "models"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: { resolve: async () => SECRET },
      fetch: async (input, init) => {
        seen.push(String(input));
        expect(init?.redirect).toBe("error");
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "No models are available to this key." }],
              isError: false,
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(seen).toEqual([`${PRIVATE_URL}/mcp`]);
    expect(error.text()).toBe("");
  });

  it("accepts ask input only as bounded JSON stdin", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "ask"], {
      input: Readable.from(['{"model":"mellum","prompt":"classify"}']),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: "small" }],
              isError: false,
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({ model: "mellum", text: "small" });
    expect(error.text()).toBe("");
  });

  it("submits a content-free adoption report through MCP without exposing the credential", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "adoption", "report"], {
      input: Readable.from(['{"harness":"codex_cli","execution_mode":"code_loop","traffic_purpose":"organic","result":"not_attempted","deterministic_check":"not_run","reviewer_usefulness":"not_reported","fallback_reason":"m5_auth_unavailable","eligible_opportunities":1}']),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
        expect(request.params.name).toBe("record_adoption_evidence");
        expect(request.params.arguments).not.toHaveProperty("prompt");
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { content: [{ type: "text", text: "accepted" }], isError: false, structuredContent: { accepted: true } },
        }), { status: 200 });
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({ accepted: true });
    expect(`${output.text()}${error.text()}`).not.toContain(SECRET);
  });

  it("redacts malicious upstream bodies from stdout, stderr, and serialized errors", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "models"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: { resolve: async () => SECRET },
      fetch: async () =>
        new Response(`gateway echoed Bearer ${SECRET} at ${PRIVATE_URL}`, {
          status: 500,
        }),
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toBe("");
    expect(JSON.parse(error.text())).toMatchObject({
      error: { code: "upstream_http_error", http_status: 500 },
    });
    expect(error.text()).not.toContain(SECRET);
    expect(error.text()).not.toContain(PRIVATE_URL);
  });

  it("does not claim CLI-side sandbox enforcement", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["help"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toMatchObject({
      security_boundary: expect.stringMatching(/gateway sandbox.*authoritative/i),
    });
    expect(output.text()).not.toContain("CLI enforces");
    expect(error.text()).toBe("");
  });
});
