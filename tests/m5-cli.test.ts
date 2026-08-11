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
  it("prints deploy environment shell without resolving the profile credential", async () => {
    const output = sink();
    const error = sink();
    let credentialLookups = 0;
    let networkCalls = 0;
    const exitCode = await main(["--profile", "codex", "deploy-env"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: {
        resolve: async () => {
          credentialLookups += 1;
          return SECRET;
        },
      },
      fetch: async () => {
        networkCalls += 1;
        throw new Error("deploy-env must not perform network I/O");
      },
    });

    expect(exitCode).toBe(0);
    expect(credentialLookups).toBe(0);
    expect(networkCalls).toBe(0);
    expect(output.text()).toBe([
      'eval "$(m5-auth --env --tailnet)"',
      'export HOMESERVER_OWNER_KEY="$M5_API_KEY"',
      "unset M5_API_KEY",
      'export DEPLOY_HEALTH_TAILNET_URL="${M5_GATEWAY_URL%/}/healthz"',
      'export DEPLOY_CAPABILITY_URL="${M5_GATEWAY_URL%/}/v1/capabilities/learning-task"',
      `export DEPLOY_PUBLIC_HTTP_URL='http://public.private-locator.invalid'`,
      `export DEPLOY_PUBLIC_HTTPS_URL='${PUBLIC_URL}'`,
      "",
    ].join("\n"));
    expect(error.text()).toBe("");
    expect(output.text()).not.toContain(SECRET);
  });

  it("emits only shell-quoted validated public origins for deploy-env", async () => {
    const output = sink();
    const error = sink();
    const injection = `path'$(printf unsafe)`;
    const exitCode = await main(["--profile", "codex", "deploy-env"], {
      input: Readable.from([]),
      output: output.stream,
      error: error.stream,
      configLoader: () => ({
        version: 1,
        profiles: {
          codex: {
            publicGatewayUrl: `https://public.private-locator.invalid:8443/${injection}`,
          },
        },
      }),
      credentialStore: {
        resolve: async () => {
          throw new Error(SECRET);
        },
      },
    });

    expect(exitCode).toBe(0);
    expect(output.text()).toContain(
      "export DEPLOY_PUBLIC_HTTP_URL='http://public.private-locator.invalid:8443'",
    );
    expect(output.text()).toContain(
      "export DEPLOY_PUBLIC_HTTPS_URL='https://public.private-locator.invalid:8443'",
    );
    expect(`${output.text()}${error.text()}`).not.toContain(injection);
    expect(`${output.text()}${error.text()}`).not.toContain(SECRET);
  });

  it("rejects --private for deploy-env before credential lookup", async () => {
    const output = sink();
    const error = sink();
    let credentialLookups = 0;
    const exitCode = await main(
      ["--profile", "codex", "--private", "--public", "deploy-env"],
      {
        input: Readable.from([]),
        output: output.stream,
        error: error.stream,
        configLoader,
        credentialStore: {
          resolve: async () => {
            credentialLookups += 1;
            return SECRET;
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(credentialLookups).toBe(0);
    expect(output.text()).toBe("");
    expect(JSON.parse(error.text())).toMatchObject({
      error: { code: "invalid_args", message: expect.stringContaining("--private") },
    });
    expect(error.text()).not.toContain(SECRET);
  });

  it("runs provision through an injected secret-safe provisioner and prints only doctor output", async () => {
    const output = sink();
    const error = sink();
    const provisionerCalls: unknown[] = [];
    const exitCode = await main([
      "--profile", "pi", "--public-gateway-url", "https://public.private-locator.invalid", "--m5-host", "magnus@m5", "provision",
    ], {
      input: Readable.from([]), output: output.stream, error: error.stream,
      provisioner: async (options: unknown) => {
        provisionerCalls.push(options);
        return { profileConfig: { publicGatewayUrl: PUBLIC_URL } };
      },
      credentialStore: { resolve: async () => SECRET },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/portal/me")) return new Response(JSON.stringify({ alias: "pi-agent", tier: "owner", scope: "agent" }));
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: ["list_models", "ask", "code_loop_start", "code_loop_status", "code_loop_result", "record_adoption_evidence"].map((name) => ({ name, inputSchema: { type: "object" } })) } }));
      },
    });
    expect(exitCode).toBe(0);
    expect(provisionerCalls).toHaveLength(1);
    expect(JSON.parse(output.text())).toMatchObject({ status: "healthy", profile: "pi" });
    expect(`${output.text()}${error.text()}`).not.toContain(SECRET);
  });

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

  it("rejects provisioning-only flags on ordinary client commands", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "--m5-host", "m5", "models"], {
      input: Readable.from([]), output: output.stream, error: error.stream, configLoader,
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(error.text())).toMatchObject({ error: { code: "invalid_args" } });
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

  it("preserves structured ask.files discovery in models output", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "models"], {
      input: Readable.from([]),
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
              content: [
                {
                  type: "text",
                  text:
                    "Models available to you:\n- mellum — very fast\n\n" +
                    "Current ask.files capability:\n" +
                    "files_enabled: false\n" +
                    "files_reason: owner_tier_required\n" +
                    "resolved_root_count: null",
                },
              ],
              isError: false,
              structuredContent: {
                models: [{ id: "mellum", description: "very fast" }],
                ask_capabilities: {
                  files_enabled: false,
                  files_reason: "owner_tier_required",
                  resolved_root_count: null,
                },
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({
      models: [{ id: "mellum", description: "very fast" }],
      ask_capabilities: {
        files_enabled: false,
        files_reason: "owner_tier_required",
        resolved_root_count: null,
      },
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
    expect(JSON.parse(output.text())).toEqual({
      model: "mellum",
      text: "small",
      finish_reason: null,
      truncated: null,
      metered: true,
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        reasoning_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });
    expect(error.text()).toBe("");
  });

  it("returns structured truncation metadata for ask instead of failing hard", async () => {
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
              content: [
                {
                  type: "text",
                  text: "The model response was truncated (finish_reason=length). Retry with a higher max_tokens.",
                },
              ],
              isError: true,
              structuredContent: {
                model: "mellum",
                text: "partial",
                finish_reason: "length",
                truncated: true,
                metered: true,
                usage: {
                  prompt_tokens: 11,
                  completion_tokens: 22,
                  total_tokens: 33,
                  reasoning_tokens: 7,
                  cache_creation_input_tokens: null,
                  cache_read_input_tokens: 5,
                },
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({
      model: "mellum",
      text: "partial",
      finish_reason: "length",
      truncated: true,
      metered: true,
      usage: {
        prompt_tokens: 11,
        completion_tokens: 22,
        total_tokens: 33,
        reasoning_tokens: 7,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 5,
      },
    });
    expect(error.text()).toBe("");
  });

  it("derives truncated=true from finish_reason=length when the server omits the explicit flag", async () => {
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
              content: [
                {
                  type: "text",
                  text: "WARNING: truncated. Partial response follows.\n\npartial",
                },
              ],
              isError: true,
              structuredContent: {
                model: "mellum",
                text: "partial",
                finish_reason: "length",
                usage: null,
                metered: true,
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({
      model: "mellum",
      text: "partial",
      finish_reason: "length",
      truncated: true,
      metered: true,
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        reasoning_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });
    expect(error.text()).toBe("");
  });

  it("keeps null usage content-blind on successful structured ask results", async () => {
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
              structuredContent: {
                model: "mellum",
                text: "small",
                finish_reason: "stop",
                truncated: false,
                usage: null,
                metered: true,
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({
      model: "mellum",
      text: "small",
      finish_reason: "stop",
      truncated: false,
      metered: true,
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        reasoning_tokens: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    });
    expect(error.text()).toBe("");
  });

  it("nulls malformed usage counters instead of trusting negative or fractional values", async () => {
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
              structuredContent: {
                model: "mellum",
                text: "small",
                finish_reason: "stop",
                truncated: false,
                usage: {
                  prompt_tokens: -1,
                  completion_tokens: 2.5,
                  total_tokens: 3.5,
                  reasoning_tokens: -4,
                  cache_creation_input_tokens: 1,
                  cache_read_input_tokens: 0,
                },
                metered: true,
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.text())).toEqual({
      model: "mellum",
      text: "small",
      finish_reason: "stop",
      truncated: false,
      metered: true,
      usage: {
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        reasoning_tokens: null,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 0,
      },
    });
    expect(error.text()).toBe("");
  });

  it("falls through malformed structured ask errors to the real tool_error text", async () => {
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
              content: [{ type: "text", text: "owner-tier only" }],
              isError: true,
              structuredContent: {
                model: 7,
                usage: "bad",
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toBe("");
    expect(JSON.parse(error.text())).toMatchObject({
      error: {
        code: "tool_error",
        message: "owner-tier only",
      },
    });
  });

  it("treats non-length structured ask errors as real tool errors, preserving exit 1", async () => {
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
              content: [{ type: "text", text: "ordinary structured error" }],
              isError: true,
              structuredContent: {
                model: "mellum",
                text: "partial",
                finish_reason: "stop",
                truncated: true,
                usage: null,
                metered: true,
              },
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toBe("");
    expect(JSON.parse(error.text())).toMatchObject({
      error: {
        code: "tool_error",
        message: "ordinary structured error",
      },
    });
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

  it("surfaces a stable redacted gateway rejection reason for a valid completed ask", async () => {
    const output = sink();
    const error = sink();
    const exitCode = await main(["--profile", "codex", "adoption", "report"], {
      input: Readable.from(['{"harness":"codex_cli","execution_mode":"ask","traffic_purpose":"organic","result":"completed","deterministic_check":"pass","reviewer_usefulness":"partial","fallback_reason":"none","eligible_opportunities":1}']),
      output: output.stream,
      error: error.stream,
      configLoader,
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            content: [{ type: "text", text: "Adoption report was not accepted (daily_capacity_reached)." }],
            isError: true,
            structuredContent: { accepted: false, reason: "daily_capacity_reached" },
          },
        }), { status: 200 });
      },
    });

    expect(exitCode).toBe(1);
    expect(output.text()).toBe("");
    expect(JSON.parse(error.text())).toMatchObject({
      error: {
        code: "tool_error",
        message: expect.stringContaining("daily_capacity_reached"),
      },
    });
    expect(error.text()).not.toContain(SECRET);
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
