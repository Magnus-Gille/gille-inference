import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createM5Client, M5ClientError } from "../client/m5-client.mjs";
import { runBuild } from "../client/m5-build.mjs";
import { createMcpStdioBridge } from "../client/m5-stdio-bridge.mjs";

const SECRET = "hs_diag_secret-never-print";
const BUSY = "There is not enough host memory to start the model 'mellum' right now. Retry after 30s.";
const UNAVAILABLE =
  "Memory admission cannot approve starting the model 'mellum' (budget_unknown). Retrying will not help until the operator fixes it.";

function rpcResult(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function refusingFetch(text: string, isError = true): typeof globalThis.fetch {
  return (async (_input: unknown, init: { body?: unknown }) => {
    const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
    if (request.params?.name === "ask") {
      return rpcResult(request.id, { content: [{ type: "text", text }], isError });
    }
    return rpcResult(request.id, { tools: [{ name: "ask", inputSchema: { type: "object" } }] });
  }) as never;
}

async function askRefusal(text: string) {
  const client = await createM5Client({
    gatewayUrl: "https://gateway.invalid",
    profile: "codex",
    credentialStore: { resolve: async () => SECRET },
    fetch: refusingFetch(text),
  });
  return client.ask({ model: "mellum", prompt: "bounded task" });
}

describe("gateway-supplied cause in _meta is preferred over the sentence (#357)", () => {
  function metaFetch(text: string, meta: unknown): typeof globalThis.fetch {
    return (async (_input: unknown, init: { body?: unknown }) => {
      const request = JSON.parse(String(init?.body)) as { id: number; params?: { name?: string } };
      if (request.params?.name === "ask") {
        return rpcResult(request.id, { content: [{ type: "text", text }], isError: true, _meta: meta });
      }
      return rpcResult(request.id, { tools: [{ name: "ask", inputSchema: { type: "object" } }] });
    }) as never;
  }
  async function askWith(text: string, meta: unknown) {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: metaFetch(text, meta),
    });
    return client.ask({ model: "mellum", prompt: "bounded task" }).catch((e) => e);
  }

  it("classifies by the code even when the wording is not the known sentence", async () => {
    const error = await askWith("Reworded: no room for that model at the moment.", {
      m5_code: "insufficient_memory", retryable: true, retry_after_seconds: 45,
    });
    expect(error).toMatchObject({ code: "insufficient_memory", retryable: true, retryAfterSeconds: 45 });
    expect(error.message).toBe("Reworded: no room for that model at the moment.");
  });

  it("takes retryability from the gateway and ignores a malformed delay", async () => {
    const error = await askWith("Reworded: the operator has to fix this.", {
      m5_code: "memory_admission_unavailable", retryable: false, retry_after_seconds: "soon",
    });
    expect(error).toMatchObject({ code: "memory_admission_unavailable", retryable: false });
    expect(error.toJSON().error).not.toHaveProperty("retry_after_seconds");
  });

  it("does not let _meta rename codes the client does not map yet", async () => {
    for (const meta of [{ m5_code: "server_busy", retryable: true }, { m5_code: "made_up" }, "nope", null]) {
      const error = await askWith("The server is busy. Retry after 5s.", meta);
      expect(error).toMatchObject({ code: "tool_error" });
    }
  });
});

describe("host-memory admission refusals on ask (#357)", () => {
  it("names insufficient_memory as retryable with the gateway's delay", async () => {
    const error = await askRefusal(BUSY).catch((e) => e);
    expect(error).toBeInstanceOf(M5ClientError);
    expect(error).toMatchObject({ code: "insufficient_memory", retryable: true, retryAfterSeconds: 30 });
    expect(error.toJSON().error).toMatchObject({
      code: "insufficient_memory",
      retryable: true,
      retry_after_seconds: 30,
    });
    expect(error.message).toMatch(/Retry after 30s/);
  });

  it("names memory_admission_unavailable as not retryable with no delay", async () => {
    const error = await askRefusal(UNAVAILABLE).catch((e) => e);
    expect(error).toMatchObject({ code: "memory_admission_unavailable", retryable: false });
    expect(error.toJSON().error).not.toHaveProperty("retry_after_seconds");
    expect(error.message).toMatch(/Retrying will not help/);
  });

  it("keeps unknown and look-alike refusals as plain tool_error", async () => {
    for (const text of [
      "The server is busy. Retry after 5s.",
      "owner-tier only. There is not enough host memory to start the model 'x' right now. Retry after 5s.",
    ]) {
      const error = await askRefusal(text).catch((e) => e);
      expect(error).toMatchObject({ code: "tool_error", message: text });
      expect(error).not.toHaveProperty("retryable");
    }
  });
});

describe("ask memory refusals through the bridge (#357)", () => {
  async function call(text: string, isError = true) {
    const client = await createM5Client({
      gatewayUrl: "https://gateway.invalid",
      profile: "codex",
      credentialStore: { resolve: async () => SECRET },
      fetch: refusingFetch(text, isError),
    });
    const bridge = createMcpStdioBridge({ client, profile: "codex" } as never);
    const line = JSON.stringify({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "ask", arguments: { model: "m", prompt: "p" } },
    });
    return JSON.parse((await bridge.handleLine(line))!);
  }

  it("adds the stable code, retryability and delay for insufficient_memory", async () => {
    const response = await call(BUSY);
    expect(response.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: BUSY }],
      _meta: { m5_code: "insufficient_memory", retryable: true, retry_after_seconds: 30 },
    });
  });

  it("marks memory_admission_unavailable as not retryable", async () => {
    const response = await call(UNAVAILABLE);
    expect(response.result._meta).toEqual({ m5_code: "memory_admission_unavailable", retryable: false });
  });

  it("leaves unknown refusals and successes untouched", async () => {
    expect((await call("The server is busy. Retry after 5s.")).result).not.toHaveProperty("_meta");
    expect((await call("fine", false)).result).not.toHaveProperty("_meta");
  });
});

describe("build_run refusals through the bridge (#357)", () => {
  const bridgeWith = (buildRunner: unknown) => createMcpStdioBridge({
    client: { rpc: async () => ({ jsonrpc: "2.0", id: 1, result: { tools: [] } }) },
    profile: "codex",
    buildConfig: { version: 1, sshTarget: "m5-build" },
    buildRunner,
  } as never);
  const run = async (bridge: { handleLine: (l: string) => Promise<string | null> }, cwd: string, command: string[]) =>
    JSON.parse((await bridge.handleLine(JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "build_run", arguments: { cwd, command } },
    })))!);

  it("returns the real reason and a stable code for a macOS-only command", async () => {
    const response = await run(bridgeWith(runBuild), "/tmp/w", ["xcodebuild", "-version"]);
    expect(response.error.message).toContain("macOS-only job");
    expect(response.error.message).not.toContain("The MCP bridge request failed");
    expect(response.error.data).toMatchObject({ m5_code: "build_macos_only" });
  });

  it("passes a worker failure code and fixed message, never remote text", async () => {
    const root = mkdtempSync(join(tmpdir(), "m5-bridge-build-"));
    try {
      const vcs = (...args: string[]) => spawnSync("git", ["-C", root, ...args]);
      vcs("init", "-q");
      vcs("config", "user.email", "t@example.invalid");
      vcs("config", "user.name", "T");
      writeFileSync(join(root, "a.txt"), "a");
      vcs("add", "a.txt");
      vcs("commit", "-qm", "i");
      const REMOTE = "secret-remote-diagnostic-/home/victim";
      const spawnImpl = () => {
        const c: any = new EventEmitter();
        c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.stdin = { write() {}, end() {} }; c.kill = () => {};
        queueMicrotask(() => {
          c.stdout.emit("data", Buffer.from(JSON.stringify({ type: "error", code: 125, message: REMOTE }) + "\n"));
          c.emit("close", 125);
        });
        return c;
      };
      const response = await run(bridgeWith((o: object) => runBuild({ ...o, spawnImpl } as never)), root, ["true"]);
      expect(response.error.data.m5_code).toBe("build_worker_failure");
      expect(response.error.message).toContain("Build worker infrastructure failure");
      expect(JSON.stringify(response)).not.toContain(REMOTE);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to build_failed for other local build errors", async () => {
    const response = await run(bridgeWith(async () => {
      throw new Error("Pull paths must be distinct safe relative file paths (at most 32).");
    }), "/tmp/w", ["true"]);
    expect(response.error.data.m5_code).toBe("build_failed");
    expect(response.error.message).toContain("Pull paths must be distinct");
  });
});
