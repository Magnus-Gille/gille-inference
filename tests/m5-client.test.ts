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
const MAX_BLIND_CONTEXT_ROOTS = 128;

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
  "record_adoption_evidence",
];

describe("profile-based Keychain resolution", () => {
  it.each(["missing_credential", "rejected_credential"])(
    "forces canonical remediation for %s before JSON serialization",
    (code) => {
      const error = new M5ClientError(code, `credential failure ${SECRET}`, {
        remediation: `Use this unsafe locator and bearer: https://evil.invalid/${SECRET}`,
      });
      expect(error.toJSON()).toEqual({
        error: {
          code,
          message: "credential failure [REDACTED]",
          remediation: expect.stringContaining("m5 doctor"),
        },
      });
      expect(JSON.stringify(error.toJSON())).not.toContain("evil.invalid");
      expect(JSON.stringify(error.toJSON())).not.toContain(SECRET);
    },
  );

  it.each(["missing_credential", "rejected_credential"])(
    "keeps the constructor profile when JSON.stringify supplies a property key for %s",
    (code) => {
      const error = new M5ClientError(code, "credential failure", { profile: "codex" });
      const serialized = JSON.parse(JSON.stringify(error));
      expect(serialized).toMatchObject({
        error: {
          code,
          remediation: expect.stringContaining("m5 --profile codex doctor"),
        },
      });
      expect(error.toJSON("ignored-property-key")).toMatchObject({
        error: { remediation: expect.stringContaining("m5 --profile codex doctor") },
      });
    },
  );

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

  it("reports the switched profile account as missing with a canonical doctor remediation", async () => {
    let account: string | undefined;
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig: PROFILE,
      credentialStore: createKeychainCredentialStore({
        execFile: (_file, args, _options, callback) => {
          account = args[4];
          callback(Object.assign(new Error(`missing ${SECRET}`), { code: 44 }), "", "");
        },
      }),
      fetch: async () => {
        throw new Error("doctor must not probe without a profile credential");
      },
    });
    expect(account).toBe("gateway-agent-codex");
    expect(result).toMatchObject({
      status: "missing_credential",
      auth_layer: "profile_keychain",
      remediation: expect.stringContaining("m5 --profile codex doctor"),
      endpoints: { public: "not_checked", private: "not_checked" },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
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
      // #154 lower bound: the same abort-during-body path with a valid explicit timeout.
      timeoutMs: 1_000,
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

  // #154: bounded ask timeouts. Omission keeps the exact 30,000 ms default; an explicit
  // 1,000–600,000 ms bound reaches the single-request AbortSignal; anything else fails at
  // the library boundary before credential resolution or network access.
  describe("ask timeout bounds (#154)", () => {
    function healthyAskFetch(resolveAfterMs: number) {
      return async (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve(
              rpcResult(1, {
                content: [{ type: "text", text: "slow but healthy" }],
                isError: false,
                structuredContent: {
                  model: "mellum",
                  text: "slow but healthy",
                  finish_reason: "stop",
                  truncated: false,
                  metered: true,
                  usage: {
                    prompt_tokens: 11,
                    completion_tokens: 4,
                    total_tokens: 15,
                    reasoning_tokens: null,
                    cache_creation_input_tokens: null,
                    cache_read_input_tokens: null,
                  },
                },
              }),
            );
          }, resolveAfterMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("request aborted", "AbortError"));
          });
        });
    }

    it("omission preserves the exact 30,000 ms default", async () => {
      vi.useFakeTimers();
      try {
        const client = await createM5Client({
          gatewayUrl: "https://gateway.invalid",
          profile: "codex",
          credentialStore: { resolve: async () => SECRET },
          fetch: async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => {
                reject(new DOMException("request aborted", "AbortError"));
              });
            }),
        });
        let settled = false;
        const pending = client.ask({ model: "mellum", prompt: "classify" });
        pending.then(
          () => { settled = true; },
          () => { settled = true; },
        );
        await vi.advanceTimersByTimeAsync(29_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).rejects.toMatchObject({ code: "timeout" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("timeoutMs 90,000 allows a healthy ask that completes past 30 seconds", async () => {
      vi.useFakeTimers();
      try {
        const client = await createM5Client({
          gatewayUrl: "https://gateway.invalid",
          profile: "codex",
          credentialStore: { resolve: async () => SECRET },
          timeoutMs: 90_000,
          fetch: healthyAskFetch(45_000),
        });
        const pending = client.ask({ model: "mellum", prompt: "classify" });
        await vi.advanceTimersByTimeAsync(45_000);
        await expect(pending).resolves.toMatchObject({
          model: "mellum",
          text: "slow but healthy",
          usage: expect.objectContaining({ prompt_tokens: 11, completion_tokens: 4 }),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("the same slow ask fails with the structured timeout error at a lower bound", async () => {
      vi.useFakeTimers();
      try {
        const client = await createM5Client({
          gatewayUrl: "https://gateway.invalid",
          profile: "codex",
          credentialStore: { resolve: async () => SECRET },
          timeoutMs: 1_000,
          fetch: healthyAskFetch(2_000),
        });
        const pending = client.ask({ model: "mellum", prompt: "classify" });
        // Attach the assertion before advancing: the abort rejects mid-advance, and a
        // handler attached only afterwards would flag an unhandled rejection.
        const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
        await vi.advanceTimersByTimeAsync(2_000);
        await assertion;
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([0, 999, 600_001, 1.5, Number.NaN, "90000", null])(
      "rejects library timeoutMs %s before credential resolution or network access",
      async (timeoutMs) => {
        let credentialLookups = 0;
        let networkCalls = 0;
        await expect(
          createM5Client({
            gatewayUrl: "https://gateway.invalid",
            profile: "codex",
            credentialStore: {
              resolve: async () => {
                credentialLookups += 1;
                return SECRET;
              },
            },
            timeoutMs: timeoutMs as number,
            fetch: async () => {
              networkCalls += 1;
              throw new Error("must not reach the network");
            },
          }),
        ).rejects.toMatchObject({ name: "M5ClientError" });
        expect(credentialLookups).toBe(0);
        expect(networkCalls).toBe(0);
      },
    );
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
          structuredContent: {
            model: "mellum",
            text: "answer",
            finish_reason: "stop",
            truncated: false,
            metered: true,
            usage: {
              prompt_tokens: 11,
              completion_tokens: 4,
              total_tokens: 15,
              reasoning_tokens: 2,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: 3,
            },
          },
        });
      },
    });

    await expect(client.models()).resolves.toEqual({
      models: [{ id: "mellum", description: "fast" }],
    });
    await expect(client.ask({ model: "mellum", prompt: "bounded task" })).resolves.toEqual({
      model: "mellum",
      text: "answer",
      finish_reason: "stop",
      truncated: false,
      metered: true,
      usage: {
        prompt_tokens: 11,
        completion_tokens: 4,
        total_tokens: 15,
        reasoning_tokens: 2,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 3,
      },
    });
    expect(JSON.stringify(seen)).toContain('"name":"list_models"');
    expect(JSON.stringify(seen)).toContain('"name":"ask"');
  });

  const validCapabilities = [
    {
      name: "enabled owner capability",
      value: { files_enabled: true, files_reason: "enabled", resolved_root_count: 2 },
    },
    {
      name: "guest-safe owner-tier gate",
      value: { files_enabled: false, files_reason: "owner_tier_required", resolved_root_count: null },
    },
    {
      name: "unconfigured root state",
      value: { files_enabled: false, files_reason: "unconfigured", resolved_root_count: 0 },
    },
    {
      name: "configured but unresolved roots",
      value: { files_enabled: false, files_reason: "no_resolved_roots", resolved_root_count: 0 },
    },
  ] as const;

  it.each(validCapabilities)(
    "accepts coherent enriched list_models structuredContent without breaking model discovery: $name",
    async ({ value }) => {
      const client = await createM5Client({
        gatewayUrl: "https://gateway.invalid",
        profile: "codex",
        credentialStore: { resolve: async () => SECRET },
        fetch: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as {
            id: number;
            params?: { name?: string };
          };
          if (request.params?.name !== "list_models") {
            throw new Error("unexpected tool");
          }
          return rpcResult(request.id, {
            content: [{ type: "text", text: "Models available to you:\n- mellum — fast" }],
            isError: false,
            structuredContent: {
              models: [{ id: "mellum", description: "fast" }],
              ask_capabilities: value,
            },
          });
        },
      });

      await expect(client.models()).resolves.toEqual({
        models: [{ id: "mellum", description: "fast" }],
        ask_capabilities: value,
      });
    },
  );

  it("parses the current list_models text fallback without inventing capability pseudo-models", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          params?: { name?: string };
        };
        if (request.params?.name !== "list_models") {
          throw new Error("unexpected tool");
        }
        return rpcResult(request.id, {
          content: [{
            type: "text",
            text:
              "Models available to you:\n" +
              "- mellum — fast\n" +
              "- vibethinker-3b — verifiable math, code, and STEM reasoning\n\n" +
              "Current ask.files capability:\n" +
              "files_enabled: false\n" +
              "files_reason: owner_tier_required\n" +
              "resolved_root_count: null",
          }],
          isError: false,
        });
      },
    });

    await expect(client.models()).resolves.toEqual({
      models: [
        { id: "mellum", description: "fast" },
        { id: "vibethinker-3b", description: "verifiable math, code, and STEM reasoning" },
      ],
    });
  });

  it("preserves an empty catalogue when the current text fallback includes capability lines", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          params?: { name?: string };
        };
        if (request.params?.name !== "list_models") {
          throw new Error("unexpected tool");
        }
        return rpcResult(request.id, {
          content: [{
            type: "text",
            text:
              "No models are available to this key.\n\n" +
              "Current ask.files capability:\n" +
              "files_enabled: false\n" +
              "files_reason: unconfigured\n" +
              "resolved_root_count: 0",
          }],
          isError: false,
        });
      },
    });

    await expect(client.models()).resolves.toEqual({ models: [] });
  });

  const malformedCapabilities: Array<{ name: string; value: unknown }> = [
    {
      name: "wrong files_enabled type",
      value: { files_enabled: "false", files_reason: "owner_tier_required", resolved_root_count: null },
    },
    {
      name: "unknown reason string",
      value: { files_enabled: false, files_reason: "disabled", resolved_root_count: null },
    },
    {
      name: "unsafe integer count",
      value: { files_enabled: true, files_reason: "enabled", resolved_root_count: MAX_BLIND_CONTEXT_ROOTS + 1 },
    },
    {
      name: "negative root count",
      value: { files_enabled: false, files_reason: "owner_tier_required", resolved_root_count: -1 },
    },
    {
      name: "enabled with zero roots",
      value: { files_enabled: true, files_reason: "enabled", resolved_root_count: 0 },
    },
    {
      name: "enabled with disabled reason",
      value: { files_enabled: true, files_reason: "unconfigured", resolved_root_count: 1 },
    },
    {
      name: "disabled with enabled reason and zero roots",
      value: { files_enabled: false, files_reason: "enabled", resolved_root_count: 0 },
    },
    {
      name: "owner-tier-required with disclosed count",
      value: { files_enabled: false, files_reason: "owner_tier_required", resolved_root_count: 0 },
    },
    {
      name: "unconfigured with null count",
      value: { files_enabled: false, files_reason: "unconfigured", resolved_root_count: null },
    },
    {
      name: "no_resolved_roots with null count",
      value: { files_enabled: false, files_reason: "no_resolved_roots", resolved_root_count: null },
    },
    {
      name: "missing reason field",
      value: { files_enabled: false, resolved_root_count: null },
    },
    {
      name: "unexpected extra key",
      value: { files_enabled: false, files_reason: "unconfigured", resolved_root_count: 0, extra: true },
    },
  ];

  it.each(malformedCapabilities)(
    "rejects malformed ask_capabilities structured metadata instead of silently ignoring it: $name",
    async ({ value }) => {
      const client = await createM5Client({
        gatewayUrl: "https://gateway.invalid",
        profile: "codex",
        credentialStore: { resolve: async () => SECRET },
        fetch: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as {
            id: number;
            params?: { name?: string };
          };
          if (request.params?.name !== "list_models") {
            throw new Error("unexpected tool");
          }
          return rpcResult(request.id, {
            content: [{ type: "text", text: "Models available to you:\n- mellum — fast" }],
            isError: false,
            structuredContent: {
              models: [{ id: "mellum", description: "fast" }],
              ask_capabilities: value,
            },
          });
        },
      });

      await expect(client.models()).rejects.toMatchObject({
        code: "malformed_mcp",
      });
    },
  );

  const malformedStructuredPayloads: Array<{ name: string; value: unknown }> = [
    {
      name: "non-object structured payload",
      value: "nope",
    },
    {
      name: "models is not an array",
      value: {
        models: "nope",
        ask_capabilities: validCapabilities[0].value,
      },
    },
    {
      name: "model entry has an unexpected key",
      value: {
        models: [{ id: "mellum", description: "fast", extra: true }],
        ask_capabilities: validCapabilities[0].value,
      },
    },
    {
      name: "top-level payload has an unexpected key",
      value: {
        models: [{ id: "mellum", description: "fast" }],
        ask_capabilities: validCapabilities[0].value,
        extra: true,
      },
    },
    {
      name: "structured payload omits ask_capabilities",
      value: {
        models: [{ id: "mellum", description: "fast" }],
      },
    },
  ];

  it.each(malformedStructuredPayloads)(
    "fails closed when structuredContent is present but malformed: $name",
    async ({ value }) => {
      const client = await createM5Client({
        gatewayUrl: "https://gateway.invalid",
        profile: "codex",
        credentialStore: { resolve: async () => SECRET },
        fetch: async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as {
            id: number;
            params?: { name?: string };
          };
          if (request.params?.name !== "list_models") {
            throw new Error("unexpected tool");
          }
          return rpcResult(request.id, {
            content: [{ type: "text", text: "Models available to you:\n- mellum — fast" }],
            isError: false,
            structuredContent: value,
          });
        },
      });

      await expect(client.models()).rejects.toMatchObject({
        code: "malformed_mcp",
      });
    },
  );

  it("returns structured truncation metadata instead of collapsing a token-limited ask into plain text", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "ask") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "The model response was truncated. Please retry." }],
            isError: true,
            structuredContent: {
              model: "mellum",
              text: "F-2",
              finish_reason: "length",
              truncated: true,
              metered: true,
              usage: {
                prompt_tokens: 5,
                completion_tokens: 64,
                total_tokens: 69,
                reasoning_tokens: 17,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: 9,
              },
            },
          });
        }
        return rpcResult(request.id, tools(["ask"]));
      },
    });

    await expect(client.ask({ model: "mellum", prompt: "bounded task" })).resolves.toEqual({
      model: "mellum",
      text: "F-2",
      finish_reason: "length",
      truncated: true,
      metered: true,
      usage: {
        prompt_tokens: 5,
        completion_tokens: 64,
        total_tokens: 69,
        reasoning_tokens: 17,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: 9,
      },
    });
  });

  it("derives truncation from finish_reason=length when the structured payload omits the explicit flag", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "ask") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "WARNING: truncated. Partial response follows.\n\nF-2" }],
            isError: true,
            structuredContent: {
              model: "mellum",
              text: "F-2",
              finish_reason: "length",
              usage: null,
              metered: true,
            },
          });
        }
        return rpcResult(request.id, tools(["ask"]));
      },
    });

    await expect(client.ask({ model: "mellum", prompt: "bounded task" })).resolves.toEqual({
      model: "mellum",
      text: "F-2",
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
  });

  it("falls through malformed structured ask errors to tool_error instead of masking them as malformed_mcp", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "ask") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "owner-tier only" }],
            isError: true,
            structuredContent: {
              model: 7,
              usage: "bad",
            },
          });
        }
        return rpcResult(request.id, tools(["ask"]));
      },
    });

    await expect(client.ask({ model: "mellum", prompt: "bounded task" })).rejects.toMatchObject({
      code: "tool_error",
      message: "owner-tier only",
    });
  });

  it("treats non-length structured ask errors as ordinary tool errors", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "ask") {
          return rpcResult(request.id, {
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
          });
        }
        return rpcResult(request.id, tools(["ask"]));
      },
    });

    await expect(client.ask({ model: "mellum", prompt: "bounded task" })).rejects.toMatchObject({
      code: "tool_error",
      message: "ordinary structured error",
    });
  });

  it("rejects content or unknown fields in an adoption report before Keychain resolution or fetch", async () => {
    let credentialResolutions = 0;
    let fetches = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: {
        resolve: async () => {
          credentialResolutions += 1;
          return SECRET;
        },
      },
      fetch: async () => {
        fetches += 1;
        throw new Error("must not fetch");
      },
    });

    const validReport = {
      harness: "codex_cli",
      execution_mode: "code_loop",
      traffic_purpose: "organic",
      result: "completed",
      deterministic_check: "pass",
      reviewer_usefulness: "pass",
      fallback_reason: "none",
      eligible_opportunities: 1,
    };
    for (const forbidden of [
      { ...validReport, prompt: "never send this" },
      { ...validReport, path: "/private/never-send" },
      { ...validReport, repository: "private/never-send" },
    ]) {
      await expect(client.reportAdoption(forbidden)).rejects.toMatchObject({ code: "invalid_adoption_report" });
    }
    expect(credentialResolutions).toBe(0);
    expect(fetches).toBe(0);
  });

  it("accepts observed outcomes for failed reports but rejects invalid result combinations", async () => {
    let fetches = 0;
    const requests: Array<{ params?: { name?: string; arguments?: unknown } }> = [];
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        fetches += 1;
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          params?: { name?: string; arguments?: unknown };
        };
        requests.push(request);
        return rpcResult(request.id, {
          content: [{ type: "text", text: "accepted" }],
          isError: false,
          structuredContent: { accepted: true },
        });
      },
    });
    const validFailure = {
      harness: "codex_cli",
      execution_mode: "code_loop",
      traffic_purpose: "organic",
      result: "failed",
      deterministic_check: "fail",
      reviewer_usefulness: "redo",
      fallback_reason: "local_result_unusable",
      eligible_opportunities: 1,
    };

    await expect(client.reportAdoption(validFailure)).resolves.toEqual({ accepted: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      params: { name: "record_adoption_evidence", arguments: validFailure },
    });

    for (const invalid of [
      { ...validFailure, result: "refused" },
      { ...validFailure, fallback_reason: "none" },
    ]) {
      await expect(client.reportAdoption(invalid)).rejects.toMatchObject({ code: "invalid_adoption_report" });
    }
    expect(fetches).toBe(1);
  });

  it("preserves retained and aggregated telemetry acknowledgements without implying inference limits", async () => {
    const reports = [
      {
        accepted: true,
        telemetry_recorded: true,
        retention: "retained",
        inference_availability: "unaffected",
      },
      {
        accepted: true,
        telemetry_recorded: true,
        retention: "aggregated",
        inference_availability: "unaffected",
        reason: "telemetry_daily_cap",
        retry_telemetry: "next_utc_day",
      },
    ];
    let call = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "telemetry acknowledgement" }],
          isError: false,
          structuredContent: reports[call++],
        });
      },
    });
    const report = {
      harness: "codex_cli",
      execution_mode: "ask",
      traffic_purpose: "organic",
      result: "completed",
      deterministic_check: "pass",
      reviewer_usefulness: "partial",
      fallback_reason: "none",
      eligible_opportunities: 1,
    };

    await expect(client.reportAdoption(report)).resolves.toEqual(reports[0]);
    await expect(client.reportAdoption(report)).resolves.toEqual(reports[1]);
  });

  it("preserves valid invalid-report diagnostics and rejects malformed or out-of-scope diagnostics", async () => {
    const acknowledgements = [
      {
        accepted: false,
        telemetry_recorded: false,
        retention: "dropped",
        inference_availability: "unaffected",
        reason: "invalid_report",
        diagnostic: { code: "invalid_field", field: "harness" },
      },
      {
        accepted: false,
        telemetry_recorded: false,
        retention: "dropped",
        inference_availability: "unaffected",
        reason: "invalid_report",
        diagnostic: { code: "invalid_field", field: "prompt" },
      },
      {
        accepted: false,
        telemetry_recorded: false,
        retention: "dropped",
        inference_availability: "unaffected",
        reason: "invalid_report",
        diagnostic: { code: "invalid_invariant", invariant: "not_a_real_invariant" },
      },
      {
        accepted: false,
        telemetry_recorded: false,
        retention: "dropped",
        inference_availability: "unaffected",
        reason: "storage_unavailable",
        diagnostic: { code: "unknown_field" },
      },
      {
        accepted: false,
        telemetry_recorded: false,
        retention: "dropped",
        inference_availability: "unaffected",
        reason: "invalid_report",
        diagnostic: { code: "invalid_shape", field: "harness" },
      },
    ];
    let call = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "adoption acknowledgement" }],
          isError: true,
          structuredContent: acknowledgements[call++],
        });
      },
    });
    const report = {
      harness: "codex_cli",
      execution_mode: "ask",
      traffic_purpose: "organic",
      result: "completed",
      deterministic_check: "pass",
      reviewer_usefulness: "partial",
      fallback_reason: "none",
      eligible_opportunities: 1,
    };

    await expect(client.reportAdoption(report)).resolves.toEqual(acknowledgements[0]);
    for (let index = 1; index < acknowledgements.length; index += 1) {
      await expect(client.reportAdoption(report)).rejects.toMatchObject({ code: "invalid_adoption_report" });
    }
  });

  it("normalizes legacy daily capacity and accepts scoped dropped telemetry acknowledgements", async () => {
    const acknowledgements = [
      { accepted: false, reason: "daily_capacity_reached" },
      {
        accepted: false,
        telemetry_recorded: false,
        retention: "dropped",
        reason: "telemetry_rate_limited",
      },
    ];
    let call = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "telemetry acknowledgement" }],
          // A rolling-upgrade gateway may still mark a telemetry-only refusal as an MCP error.
          isError: call === 1,
          structuredContent: acknowledgements[call++],
        });
      },
    });
    const report = {
      harness: "codex_cli",
      execution_mode: "code_loop",
      traffic_purpose: "organic",
      result: "not_attempted",
      deterministic_check: "not_run",
      reviewer_usefulness: "not_reported",
      fallback_reason: "m5_auth_unavailable",
      eligible_opportunities: 1,
    };

    await expect(client.reportAdoption(report)).resolves.toEqual({
      accepted: false,
      telemetry_recorded: false,
      retention: "dropped",
      inference_availability: "unaffected",
      reason: "telemetry_daily_cap",
      retry_telemetry: "next_utc_day",
    });
    await expect(client.reportAdoption(report)).resolves.toEqual(acknowledgements[1]);
  });

  it("normalizes legacy rate-limit and storage refusals, including old MCP errors, to dropped telemetry", async () => {
    const legacyAcknowledgements = [
      { accepted: false, reason: "principal_rate_limited" },
      { accepted: false, reason: "storage_unavailable" },
    ];
    let call = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "Adoption telemetry was not recorded." }],
          // Older gateways used the MCP tool-error flag for telemetry-only refusals.
          isError: call === 0,
          structuredContent: legacyAcknowledgements[call++],
        });
      },
    });
    const report = {
      harness: "codex_cli",
      execution_mode: "ask",
      traffic_purpose: "organic",
      result: "completed",
      deterministic_check: "pass",
      reviewer_usefulness: "partial",
      fallback_reason: "none",
      eligible_opportunities: 1,
    };

    await expect(client.reportAdoption(report)).resolves.toEqual({
      accepted: false,
      telemetry_recorded: false,
      retention: "dropped",
      inference_availability: "unaffected",
      reason: "telemetry_rate_limited",
    });
    await expect(client.reportAdoption(report)).resolves.toEqual({
      accepted: false,
      telemetry_recorded: false,
      retention: "dropped",
      inference_availability: "unaffected",
      reason: "storage_unavailable",
    });
  });

  it("retries a transient Keychain failure on the same long-lived client", async () => {
    let credentialResolutions = 0;
    let fetches = 0;
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: {
        resolve: async () => {
          credentialResolutions += 1;
          if (credentialResolutions === 1) {
            throw new M5ClientError("credential_timeout", "temporary Keychain timeout");
          }
          return SECRET;
        },
      },
      fetch: async (_input, init) => {
        fetches += 1;
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "Models available to you:\n- mellum — fast" }],
          isError: false,
        });
      },
    });

    await expect(client.models()).rejects.toMatchObject({ code: "credential_timeout" });
    await expect(client.models()).resolves.toEqual({
      models: [{ id: "mellum", description: "fast" }],
    });
    expect(credentialResolutions).toBe(2);
    expect(fetches).toBe(1);
  });

  function currentTerminalCodeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      status: "completed",
      completion_state: "complete",
      work_id: "cl-1",
      diff: "",
      diff_truncated: false,
      changed_files: [],
      scope_violations: [],
      protected_violations: [],
      summary: "",
      detail: "",
      check: { ran: false, exit_code: null, output_tail: "", skip_reason: "not-requested" },
      schema_grounding: { schema_version: 1, state: "not-requested", checks: [] },
      usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
      execution: {
        harness_version: "code-loop-pi-2026-09-05-v9",
        effective_caps: { turns: 24 },
        capabilities: { result_scope: "writable-v1", completion_accounting: "bounded-turns-v1" },
      },
      ...overrides,
    };
  }

  async function expectClientRejectsCodeResult(result: Record<string, unknown>): Promise<void> {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
          structuredContent: result,
        });
      },
    });
    await expect(client.codeResult("cl-1")).rejects.toMatchObject({ code: "invalid_code_result" });
  }

  it.each([
    ["missing schema_grounding", () => {
      const result = currentTerminalCodeResult();
      delete result.schema_grounding;
      return result;
    }],
    ["null schema_grounding", () => currentTerminalCodeResult({ schema_grounding: null })],
    ["malformed schema_grounding", () => currentTerminalCodeResult({ schema_grounding: { schema_version: 1, state: "failed", checks: "bad" } })],
    ["missing grounding checks", () => currentTerminalCodeResult({ schema_grounding: { schema_version: 1, state: "failed" } })],
    ["empty passed checks", () => currentTerminalCodeResult({ schema_grounding: { schema_version: 1, state: "passed", checks: [] } })],
    ["duplicate names", () => currentTerminalCodeResult({
      schema_grounding: {
        schema_version: 1,
        state: "failed",
        checks: [
          { name: "same", ran: true, exit_code: 1, output_tail: "first" },
          { name: "same", ran: true, exit_code: 2, output_tail: "second" },
        ],
      },
    })],
    ["invalid name", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "Upper", ran: true, exit_code: 1, output_tail: "failed" }] },
    })],
    ["oversized output tail", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "x".repeat(4097) }] },
    })],
    ["missing check output tail", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 1 }] },
    })],
    ["negative exit code", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: -1, output_tail: "failed" }] },
    })],
    ["exit code above 255", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 256, output_tail: "failed" }] },
    })],
    ["non-integer exit code", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 1.5, output_tail: "failed" }] },
    })],
    ["failed state with all checks passing", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 0, output_tail: "ok" }] },
    })],
    ["skipped state with a ran check", () => currentTerminalCodeResult({
      schema_grounding: { schema_version: 1, state: "skipped", checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "failed" }] },
    })],
    ["failed state disclosing a diff", () => currentTerminalCodeResult({
      diff: "disclosed diff",
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "failed" }] },
    })],
    ["failed state disclosing a summary", () => currentTerminalCodeResult({
      summary: "disclosed summary",
      schema_grounding: { schema_version: 1, state: "failed", checks: [{ name: "a", ran: true, exit_code: 1, output_tail: "failed" }] },
    })],
    ["skipped state disclosing a diff", () => currentTerminalCodeResult({
      diff: "disclosed diff",
      schema_grounding: { schema_version: 1, state: "skipped", checks: [{ name: "a", ran: false, exit_code: null, output_tail: "" }] },
    })],
    ["skipped state disclosing a summary", () => currentTerminalCodeResult({
      summary: "disclosed summary",
      schema_grounding: { schema_version: 1, state: "skipped", checks: [{ name: "a", ran: false, exit_code: null, output_tail: "" }] },
    })],
  ])("rejects terminal result with %s", async (_label, makeResult) => {
    await expectClientRejectsCodeResult(makeResult());
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
            completion_state: "complete",
            work_id: "cl-1",
            diff: "diff --git a/a.ts b/a.ts\n+safe\n",
            diff_truncated: false,
            changed_files: ["a.ts"],
            scope_violations: [],
            protected_violations: [],
            execution: {
              harness_version: "code-loop-pi-2026-09-05-v9",
              effective_caps: { turns: 24 },
              capabilities: { result_scope: "writable-v1", completion_accounting: "bounded-turns-v1" },
            },
            summary: "changed",
            detail: "",
            check: { ran: true, exit_code: 0, output_tail: "ok", skip_reason: null },
            schema_grounding: { schema_version: 1, state: "not-requested", checks: [] },
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

  it("fails closed on a pre-scope-contract terminal result even when it carries a diff", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
          structuredContent: {
            status: "completed",
            work_id: "cl-1",
            diff: "diff --git a/a.ts b/a.ts\n+unbounded\n",
            changed_files: ["a.ts"],
            protected_violations: [],
            check: { ran: true, exit_code: 0, output_tail: "ok" },
            execution: {
              harness_version: "code-loop-pi-2026-07-14-v6",
              capabilities: { agent_checks: "pi-bash-events-v3" },
            },
          },
        });
      },
    });

    await expect(client.codeResult("cl-1")).rejects.toMatchObject({
      code: "invalid_code_result",
    });
  });

  it("fails closed on a v7 result without bounded completion accounting", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
          structuredContent: {
            status: "cap-exceeded",
            completion_state: "unfinished",
            work_id: "cl-1",
            diff: "",
            changed_files: [],
            scope_violations: [],
            protected_violations: [],
            check: { ran: false, exit_code: null, output_tail: "", skip_reason: "engine-failure" },
            usage: { turns: 25 },
            execution: {
              harness_version: "code-loop-pi-2026-09-04-v7",
              effective_caps: { turns: 24 },
              capabilities: { result_scope: "writable-v1" },
            },
          },
        });
      },
    });

    await expect(client.codeResult("cl-1")).rejects.toMatchObject({ code: "invalid_code_result" });
  });

  it("fails closed when v8 reports turn usage beyond its effective cap", async () => {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { id: number };
        return rpcResult(request.id, {
          content: [{ type: "text", text: "{}" }],
          isError: false,
          structuredContent: {
            status: "cap-exceeded",
            completion_state: "unfinished",
            work_id: "cl-1",
            diff: "",
            changed_files: [],
            scope_violations: [],
            protected_violations: [],
            check: { ran: false, exit_code: null, output_tail: "", skip_reason: "engine-failure" },
            usage: { turns: 25 },
            execution: {
              harness_version: "code-loop-pi-2026-09-04-v8",
              effective_caps: { turns: 24 },
              capabilities: {
                result_scope: "writable-v1",
                completion_accounting: "bounded-turns-v1",
              },
            },
          },
        });
      },
    });

    await expect(client.codeResult("cl-1")).rejects.toMatchObject({ code: "invalid_code_result" });
  });
});

describe("m5 doctor diagnostic distinctions", () => {
  async function diagnose({
    credential = SECRET,
    publicIdentity = { alias: "codex-agent", tier: "owner", scope: "agent" },
    privateIdentity = publicIdentity,
    publicTools = REQUIRED_TOOLS,
    privateTools = publicTools,
    publicModels = ["mellum"],
    privateModels = publicModels,
    modelDiscoveryFailure,
    rejectStatus,
    networkError,
  }: {
    credential?: string | null;
    publicIdentity?: Record<string, unknown>;
    privateIdentity?: Record<string, unknown>;
    publicTools?: string[];
    privateTools?: string[];
    publicModels?: string[];
    privateModels?: string[];
    modelDiscoveryFailure?: "public" | "private";
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
        if ((request as { params?: { name?: string } }).params?.name === "list_models") {
          const models = isPrivate ? privateModels : publicModels;
          if (modelDiscoveryFailure === (isPrivate ? "private" : "public")) {
            return rpcResult(request.id, {
              content: [{ type: "text", text: "model catalogue unavailable" }],
              isError: true,
            });
          }
          return rpcResult(request.id, {
            content: [{ type: "text", text: `Models available to you:\n${models.map((model) => `- ${model} — test`).join("\n")}` }],
            isError: false,
          });
        }
        return rpcResult(request.id, tools(isPrivate ? privateTools : publicTools));
      },
    });
  }

  it("distinguishes missing credential", async () => {
    const result = await diagnose({ credential: null });
    expect(result).toMatchObject({
      status: "missing_credential",
      auth_layer: "profile_keychain",
      connector: {
        status: "unsupported",
      },
      remediation: expect.stringContaining("m5 --profile codex doctor"),
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
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
      auth_layer: "gateway_credential",
      remediation: expect.stringContaining("Keychain recovery/rotation"),
    });
  });

  it.each([
    ["busy", 503],
    ["timeout", undefined],
    ["unavailable", undefined],
    ["backend failure", undefined],
  ])("classifies list_models %s as model discovery, not inference readiness", async (_label, httpStatus) => {
    const expected = "model_discovery_unavailable";
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig: PROFILE,
      credentialStore: { resolve: async () => SECRET },
      // #154 lower bound: arbitrary to this test (the timeout never fires), kept valid.
      timeoutMs: 1_000,
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/portal/me")) return jsonResponse({ alias: "codex-agent", tier: "owner", scope: "agent" });
        const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "list_models") {
          if (httpStatus !== undefined) return new Response("", { status: httpStatus });
          if (_label === "timeout") throw new M5ClientError("timeout", "timed out");
          if (_label === "unavailable") throw new Error("connection refused");
          return rpcResult(request.id, {
            content: [{ type: "text", text: "backend unavailable" }],
            isError: true,
          });
        }
        return rpcResult(request.id, tools(REQUIRED_TOOLS));
      },
    });
    expect(result).toMatchObject({
      status: expected,
      model_discovery: { public: "unavailable", private: "not_checked" },
      inference: { public: "not_checked", private: "not_checked" },
      endpoints: { public: expected },
    });
    if (httpStatus !== undefined) expect(result).toMatchObject({ http_status: httpStatus });
    expect(result).not.toMatchObject({ status: "rejected_credential" });
  });

  it("does not claim inference readiness when a scoped key can only discover a catalogue", async () => {
    let inferenceCalls = 0;
    const result = await diagnoseProfile({
      profile: "codex",
      profileConfig: PROFILE,
      credentialStore: { resolve: async () => SECRET },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.endsWith("/portal/me")) {
          return jsonResponse({ alias: "scoped-agent", tier: "owner", scope: "agent" });
        }
        const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
        if (request.params?.name === "list_models") {
          return rpcResult(request.id, {
            content: [{ type: "text", text: "Models available to you:\n- mellum — very fast" }],
            isError: false,
          });
        }
        if (request.params?.name === "ask") {
          inferenceCalls += 1;
          return rpcResult(request.id, {
            content: [{ type: "text", text: "backend inference failed" }],
            isError: true,
          });
        }
        return rpcResult(request.id, tools(REQUIRED_TOOLS));
      },
    });

    expect(result).toMatchObject({
      status: "healthy",
      model_discovery: { public: "available", private: "available" },
      inference: { public: "not_checked", private: "not_checked" },
    });
    expect(inferenceCalls).toBe(0);
  });

  it("distinguishes endpoint unavailability without exposing locator values", async () => {
    const result = await diagnose({
      networkError: Object.assign(new Error(`getaddrinfo ENOTFOUND ${SECRET}`), {
        code: "ENOTFOUND",
      }),
    });
    expect(result).toMatchObject({ status: "network_failure", diagnostic_code: "dns_failure" });
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

  it("reports wrong scope even when model discovery fails", async () => {
    await expect(
      diagnose({
        publicIdentity: { alias: "wrong", tier: "owner", scope: "inference" },
        modelDiscoveryFailure: "public",
      }),
    ).resolves.toMatchObject({
      status: "wrong_scope",
      identity: { tier: "owner", scope: "inference" },
      model_discovery: { public: "unavailable", private: "not_checked" },
    });
  });

  it("distinguishes missing MCP tools", async () => {
    await expect(diagnose({ publicTools: ["list_models", "ask"] })).resolves.toMatchObject({
      status: "missing_tools",
      missing_tools: ["code_loop_start", "code_loop_status", "code_loop_result", "record_adoption_evidence"],
    });
  });

  it("reports missing tools even when list_models fails", async () => {
    await expect(
      diagnose({
        publicTools: ["list_models"],
        modelDiscoveryFailure: "public",
      }),
    ).resolves.toMatchObject({
      status: "missing_tools",
      identity: { tier: "owner", scope: "agent" },
      missing_tools: ["ask", "code_loop_start", "code_loop_status", "code_loop_result", "record_adoption_evidence"],
      model_discovery: { public: "unavailable", private: "not_checked" },
    });
  });

  it("distinguishes public/private path drift", async () => {
    await expect(
      diagnose({
        privateIdentity: { alias: "other", tier: "owner", scope: "agent" },
      }),
    ).resolves.toMatchObject({ status: "path_parity_failed" });
  });

  it("compares the model allow-list digest instead of only the model count", async () => {
    const result = await diagnose({
      publicModels: ["mellum"],
      privateModels: ["qwen3-30b-instruct"],
    });
    expect(result).toMatchObject({
      status: "path_parity_failed",
      model_discovery: { public: "available", private: "available" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("mellum");
    expect(serialized).not.toContain("qwen3-30b-instruct");
  });

  it("reports healthy without tokens or endpoint locator values", async () => {
    const result = await diagnose();
    expect(result).toMatchObject({
      status: "healthy",
      profile: "codex",
      model_discovery: { public: "available", private: "available" },
      inference: { public: "not_checked", private: "not_checked" },
      endpoints: { public: "healthy", private: "healthy" },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(PROFILE.publicGatewayUrl);
    expect(serialized).not.toContain(PROFILE.privateGatewayUrl);
  });
});
