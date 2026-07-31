import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  M5_CLIENT_VERSION,
  M5ClientError,
  createKeychainCredentialStore,
  createM5Client,
  diagnoseProfile,
  validateProfileConfig,
} from "../client/m5-client.mjs";

const SECRET = "hs_owner_this-must-never-escape";
const PROFILE = {
  publicGatewayUrl: "https://public.invalid",
  privateGatewayUrl: "http://private.invalid:8080",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function rpcResult(id: string | number, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function tools(names: string[]): unknown {
  return {
    tools: names.map((name) => ({ name, inputSchema: { type: "object" } })),
  };
}

const REQUIRED_TOOLS = [
  "list_models",
  "ask",
  "code_loop_start",
  "code_loop_status",
  "code_loop_result",
];

describe("profile-based Keychain resolution", () => {
  it("uses independently revocable profile accounts and never puts the bearer in argv or env", async () => {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    const execFile = vi.fn(
      (
        file: string,
        args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        calls.push({ file, args, options });
        callback(null, `${SECRET}\n`, "");
      },
    );
    const store = createKeychainCredentialStore({ execFile });

    await expect(store.resolve("claude")).resolves.toBe(SECRET);
    await expect(store.resolve("codex")).resolves.toBe(SECRET);

    expect(calls.map((call) => call.args)).toEqual([
      ["find-generic-password", "-s", "gille-inference", "-a", "gateway-agent-claude", "-w"],
      ["find-generic-password", "-s", "gille-inference", "-a", "gateway-agent-codex", "-w"],
    ]);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(calls.every((call) => !("env" in call.options))).toBe(true);
    expect(calls.every((call) => call.options.timeout === 5_000)).toBe(true);
  });

  it("redacts subprocess failures and distinguishes missing, timeout, and unavailable", async () => {
    const store = createKeychainCredentialStore({
      execFile: (_file, _args, _options, callback) => {
        const error = Object.assign(new Error(`security failed: ${SECRET}`), {
          code: 44,
          stderr: `not found ${SECRET}`,
        });
        callback(error, "", error.stderr);
      },
    });

    await expect(store.resolve("codex")).rejects.toMatchObject({
      name: "M5ClientError",
      code: "missing_credential",
    });
    try {
      await store.resolve("codex");
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }

    const timedOut = createKeychainCredentialStore({
      timeoutMs: 7,
      execFile: (_file, _args, options, callback) => {
        expect(options.timeout).toBe(7);
        callback(
          Object.assign(new Error(`timed out ${SECRET}`), {
            killed: true,
            signal: "SIGTERM",
          }),
          "",
          SECRET,
        );
      },
    });
    await expect(timedOut.resolve("codex")).rejects.toMatchObject({
      code: "credential_timeout",
    });

    const unavailable = createKeychainCredentialStore({
      execFile: (_file, _args, _options, callback) => {
        callback(
          Object.assign(new Error(`spawn failed ${SECRET}`), { code: "ENOENT" }),
          "",
          SECRET,
        );
      },
    });
    await expect(unavailable.resolve("codex")).rejects.toMatchObject({
      code: "credential_unavailable",
    });
  });

  it("rejects credential material in client configuration", () => {
    for (const unsafe of [
      { ...PROFILE, key: SECRET },
      { ...PROFILE, token: SECRET },
      { ...PROFILE, authorization: `Bearer ${SECRET}` },
    ]) {
      expect(() => validateProfileConfig(unsafe)).toThrowError(/credential material/i);
    }
    expect(() =>
      validateProfileConfig({
        ...PROFILE,
        publicGatewayUrl: `https://public.invalid/?token=${SECRET}`,
      }),
    ).toThrowError(/query parameters/i);
    expect(() =>
      validateProfileConfig({
        ...PROFILE,
        publicGatewayUrl: "http://public.invalid",
      }),
    ).toThrowError(/HTTPS/i);
    expect(
      validateProfileConfig({
        ...PROFILE,
        privateGatewayUrl: "http://private.invalid:8080",
      }).privateGatewayUrl,
    ).toBe("http://private.invalid:8080");

    for (const extra of [
      { apiKey: SECRET },
      { api_key: SECRET },
      { accessToken: SECRET },
      { password: SECRET },
      { headers: { authorization: `Bearer ${SECRET}` } },
      { unexpected: "value" },
    ]) {
      expect(() =>
        validateProfileConfig({ ...PROFILE, ...extra }),
      ).toThrowError(/only.*publicGatewayUrl.*privateGatewayUrl/i);
    }
  });

  it("keeps the executable version synchronized with the npm package", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../client/package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(M5_CLIENT_VERSION).toBe(pkg.version);
  });
});

describe("secret-safe M5 client", () => {
  it("always targets the fixed /mcp path and keeps the bearer internal", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid/base-is-forbidden",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return rpcResult(1, tools(["list_models"]));
      },
    });

    await client.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://gateway.invalid/mcp");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect((requests[0]?.init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${SECRET}`,
    );
    expect(JSON.stringify(client)).not.toContain(SECRET);
  });

  it("redacts upstream bodies, bearer echoes, and malformed response details", async () => {
    const cases = [
      new Response(`upstream leaked ${SECRET}`, { status: 502 }),
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: `Bearer ${SECRET}` },
      }),
      new Response(`{ malformed ${SECRET}`, { status: 200 }),
    ];

    for (const response of cases) {
      const client = await createM5Client({
        gatewayUrl: "https://gateway.invalid",
        profile: "codex",
        credentialStore: { resolve: async () => SECRET },
        fetch: async () => response.clone(),
      });
      try {
        await client.tool("list_models", {});
        throw new Error("expected failure");
      } catch (error) {
        expect(String(error)).not.toContain(SECRET);
        expect(JSON.stringify(error)).not.toContain(SECRET);
      }
    }
  });

  it("keeps the request timeout active while consuming the response body", async () => {
    let attempts = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      timeoutMs: 5,
      fetch: async (_input, init) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            status: 200,
            headers: new Headers(),
            text: () =>
              new Promise<string>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  reject(new DOMException("body aborted", "AbortError"));
                });
              }),
          } as Response;
        }
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, tools([]));
      },
    });

    await expect(
      client.rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).rejects.toMatchObject({ code: "timeout" });
    await expect(
      client.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ).resolves.toMatchObject({ id: 2, result: { tools: [] } });
  });

  it("maps models and ask into structured JSON without forking MCP semantics", async () => {
    const seen: unknown[] = [];
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          params?: { name?: string };
        };
        seen.push(request);
        if (request.params?.name === "list_models") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "Models available to you:\n- mellum — fast" }],
            isError: false,
          });
        }
        return rpcResult(request.id, {
          content: [{ type: "text", text: "answer" }],
          isError: false,
        });
      },
    });

    await expect(client.models()).resolves.toEqual({
      models: [{ id: "mellum", description: "fast" }],
    });
    await expect(client.ask({ model: "mellum", prompt: "bounded task" })).resolves.toEqual({
      model: "mellum",
      text: "answer",
    });
    expect(JSON.stringify(seen)).toContain('"name":"list_models"');
    expect(JSON.stringify(seen)).toContain('"name":"ask"');
  });

  it("runs the async code path to a validated diff/result without applying it locally", async () => {
    const names: string[] = [];
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      sleep: async () => {},
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          params: { name: string };
        };
        names.push(request.params.name);
        if (request.params.name === "code_loop_start") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "{}" }],
            isError: false,
            structuredContent: { ok: true, work_id: "cl-1", status: "running" },
          });
        }
        if (request.params.name === "code_loop_status") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "{}" }],
            isError: false,
            structuredContent: { status: "completed", work_id: "cl-1" },
          });
        }
        return rpcResult(request.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
          structuredContent: {
            status: "completed",
            work_id: "cl-1",
            diff: "diff --git a/a.ts b/a.ts\n+safe\n",
            diff_truncated: false,
            changed_files: ["a.ts"],
            protected_violations: [],
            summary: "changed",
            detail: "",
            check: { ran: true, exit_code: 0, output_tail: "ok" },
            usage: {
              turns: 1,
              wall_ms: 2,
              prompt_tokens: 3,
              completion_tokens: 4,
            },
          },
        });
      },
    });

    const result = await client.codeRun({
      instruction: "edit the seed only",
      files: [{ path: "a.ts", content: "old\n" }],
      check_cmd: "npm test",
      wait: { timeout_ms: 100, poll_ms: 1 },
    });

    expect(names).toEqual([
      "code_loop_start",
      "code_loop_status",
      "code_loop_result",
    ]);
    expect(result).toMatchObject({
      status: "completed",
      diff: expect.stringContaining("+safe"),
      check: { ran: true, exit_code: 0 },
    });
    expect(result).not.toHaveProperty("applied");
  });

  it("fails closed when a terminal code result does not carry diff and verification evidence", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
          structuredContent: { status: "completed", work_id: "cl-1" },
        });
      },
    });

    await expect(client.codeResult("cl-1")).rejects.toMatchObject({
      code: "invalid_code_result",
    });
  });
});

describe("m5 doctor diagnostic distinctions", () => {
  async function diagnose({
    credential = SECRET,
    publicIdentity = { alias: "codex-agent", tier: "owner", scope: "agent" },
    privateIdentity = publicIdentity,
    publicTools = REQUIRED_TOOLS,
    privateTools = publicTools,
    rejectStatus,
    networkError,
  }: {
    credential?: string | null;
    publicIdentity?: Record<string, unknown>;
    privateIdentity?: Record<string, unknown>;
    publicTools?: string[];
    privateTools?: string[];
    rejectStatus?: number;
    networkError?: Error;
  } = {}) {
    return diagnoseProfile({
      profile: "codex",
      profileConfig: PROFILE,
      credentialStore: {
        resolve: async () => {
          if (credential === null) {
            throw new M5ClientError("missing_credential", "missing");
          }
          return credential;
        },
      },
      fetch: async (input, init) => {
        if (networkError) throw networkError;
        const url = String(input);
        const isPrivate = url.startsWith(PROFILE.privateGatewayUrl);
        if (url.endsWith("/portal/me")) {
          if (rejectStatus) return new Response("", { status: rejectStatus });
          return jsonResponse(isPrivate ? privateIdentity : publicIdentity);
        }
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, tools(isPrivate ? privateTools : publicTools));
      },
    });
  }

  it("distinguishes missing credential", async () => {
    await expect(diagnose({ credential: null })).resolves.toMatchObject({
      status: "missing_credential",
    });
  });

  it.each([
    ["credential_timeout", "credential_timeout"],
    ["credential_unavailable", "credential_unavailable"],
  ])("distinguishes %s from a missing item", async (code, status) => {
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig: PROFILE,
      credentialStore: {
        resolve: async () => {
          throw new M5ClientError(code, `must redact ${SECRET}`);
        },
      },
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(result).toMatchObject({ status, credential: "unavailable" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("distinguishes a rejected credential", async () => {
    await expect(diagnose({ rejectStatus: 401 })).resolves.toMatchObject({
      status: "rejected_credential",
    });
  });

  it("distinguishes DNS/network failure without exposing locator values", async () => {
    const result = await diagnose({
      networkError: Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET}`), {
        code: "ENOTFOUND",
      }),
    });
    expect(result).toMatchObject({ status: "network_failure" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(PROFILE.privateGatewayUrl);
  });

  it("distinguishes wrong credential scope", async () => {
    await expect(
      diagnose({
        publicIdentity: { alias: "wrong", tier: "owner", scope: "inference" },
      }),
    ).resolves.toMatchObject({ status: "wrong_scope" });
  });

  it("distinguishes missing MCP tools", async () => {
    await expect(diagnose({ publicTools: ["list_models", "ask"] })).resolves.toMatchObject({
      status: "missing_tools",
      missing_tools: ["code_loop_start", "code_loop_status", "code_loop_result"],
    });
  });

  it("distinguishes public/private path drift", async () => {
    await expect(
      diagnose({
        privateIdentity: { alias: "other", tier: "owner", scope: "agent" },
      }),
    ).resolves.toMatchObject({ status: "path_parity_failed" });
  });

  it("reports healthy without tokens or endpoint locator values", async () => {
    const result = await diagnose();
    expect(result).toMatchObject({
      status: "healthy",
      profile: "codex",
      endpoints: { public: "healthy", private: "healthy" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PROFILE.publicGatewayUrl);
    expect(serialized).not.toContain(PROFILE.privateGatewayUrl);
  });
});
