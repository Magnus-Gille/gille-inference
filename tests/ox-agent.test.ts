import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPiArgs,
  childEnvironment,
  locateSubagentExtension,
  parseOxAgentArgs,
  prepareRuntimeConfig,
  profilePaths,
  runPi,
  startCredentialProxy,
} from "../scripts/ox-agent.js";

describe("ox-agent argument contract", () => {
  it("defaults to a bounded read-only max-effort run", () => {
    expect(parseOxAgentArgs(["inspect auth"])).toEqual({
      mode: "readonly",
      thinking: "max",
      timeoutSeconds: 600,
      outputMode: "text",
      dryRun: false,
      prompt: "inspect auth",
    });
  });

  it("accepts the three native Nous effort levels and explicit write mode", () => {
    for (const thinking of ["low", "high", "max"] as const) {
      expect(parseOxAgentArgs(["--write", "--thinking", thinking, "--timeout", "42", "do work"])).toMatchObject({
        mode: "write",
        thinking,
        timeoutSeconds: 42,
        prompt: "do work",
      });
    }
  });

  it("rejects unsupported effort levels and unsafe timeout bounds", () => {
    expect(() => parseOxAgentArgs(["--thinking", "medium", "x"])).toThrow(/low, high, or max/);
    expect(() => parseOxAgentArgs(["--timeout", "9", "x"])).toThrow(/10 to 3600/);
    expect(() => parseOxAgentArgs(["--timeout", "3601", "x"])).toThrow(/10 to 3600/);
  });
});

describe("ox-agent credential boundary", () => {
  it("never passes the raw Nous key to Pi or its tool subprocesses", () => {
    const env = childEnvironment(
      { PATH: "/bin", NOUS_API_KEY: "raw-secret", UNRELATED: "kept" },
      "/tmp/runtime-profile",
      "ephemeral-proxy-token",
    );
    expect(env).toMatchObject({
      PATH: "/bin",
      UNRELATED: "kept",
      PI_CODING_AGENT_DIR: "/tmp/runtime-profile",
      OX_PI_PROXY_TOKEN: "ephemeral-proxy-token",
    });
    expect(env).not.toHaveProperty("NOUS_API_KEY");
    expect(JSON.stringify(env)).not.toContain("raw-secret");
  });

  it("materializes a secret-free runtime profile that points only at loopback", () => {
    const source = mkdtempSync(path.join(tmpdir(), "ox-profile-source-"));
    mkdirSync(path.join(source, "agents"));
    writeFileSync(
      path.join(source, "models.json"),
      JSON.stringify({
        providers: {
          nous: {
            baseUrl: "https://inference-api.nousresearch.com/v1",
            apiKey: "$NOUS_API_KEY",
          },
        },
      }),
    );
    writeFileSync(path.join(source, "agents", "scout.md"), "scout");

    const runtime = prepareRuntimeConfig(source, "http://127.0.0.1:43123/v1");
    try {
      const models = readFileSync(path.join(runtime.configDir, "models.json"), "utf8");
      expect(models).toContain("http://127.0.0.1:43123/v1");
      expect(models).toContain("$OX_PI_PROXY_TOKEN");
      expect(models).not.toContain("NOUS_API_KEY");
      expect(models).not.toContain("inference-api.nousresearch.com");
      expect(readFileSync(path.join(runtime.configDir, "agents", "scout.md"), "utf8")).toBe("scout");
    } finally {
      runtime.cleanup();
    }
  });

  it("guards the proxy with an ephemeral token and injects the upstream key server-side", async () => {
    let observedAuthorization: string | undefined;
    const upstream = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream port");

    const proxy = await startCredentialProxy({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "raw-upstream-secret",
    });
    try {
      const rejected = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: "{}",
      });
      expect(rejected.status).toBe(401);

      const accepted = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ ok: true });
      expect(observedAuthorization).toBe("Bearer raw-upstream-secret");
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("aborts the upstream stream when the Pi-side client disconnects", async () => {
    let upstreamClosedResolve: (() => void) | undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      upstreamClosedResolve = resolve;
    });
    const upstream = createServer((_request, response) => {
      response.once("close", () => upstreamClosedResolve?.());
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: partial\n\n");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("missing upstream port");

    const proxy = await startCredentialProxy({
      upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "raw-upstream-secret",
    });
    try {
      const controller = new AbortController();
      const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${proxy.token}`, "content-type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      await response.body?.getReader().read();
      controller.abort();
      await Promise.race([
        upstreamClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error("upstream remained open")), 1_000)),
      ]);
    } finally {
      await proxy.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("kills a stubborn descendant when the top-level Pi process exits on timeout", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ox-process-tree-"));
    const pidFile = path.join(root, "descendant.pid");
    const fixture = path.resolve(import.meta.dirname, "fixtures", "ox-agent-process-tree.mjs");
    const code = await runPi({
      piBinary: process.execPath,
      args: [fixture, pidFile],
      configDir: root,
      proxyToken: "test-token",
      timeoutSeconds: 0.3,
    });
    expect(code).toBe(124);
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* Already gone. */ }
    }
    expect(alive).toBe(false);
  });
});

describe("ox-agent Pi contract", () => {
  it("commits only the native effort map and keeps the worker out of read-only discovery", () => {
    const repository = path.resolve(import.meta.dirname, "..");
    const readonly = path.join(repository, "config", "ox-alpha-pi", "readonly");
    const write = path.join(repository, "config", "ox-alpha-pi", "write");
    const readonlyModels = JSON.parse(readFileSync(path.join(readonly, "models.json"), "utf8"));
    const writeModels = JSON.parse(readFileSync(path.join(write, "models.json"), "utf8"));
    const model = readonlyModels.providers.nous.models[0];

    expect(readonlyModels).toEqual(writeModels);
    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    expect(readonlyModels.providers.nous.apiKey).toBe("$NOUS_API_KEY");
    expect(JSON.stringify(readonlyModels)).not.toContain("sk-nous-");
    expect(readdirSync(path.join(readonly, "agents")).sort()).toEqual([
      "ox-planner.md",
      "ox-reviewer.md",
      "ox-scout.md",
    ]);
    expect(readdirSync(path.join(write, "agents"))).toContain("ox-worker.md");
  });

  it("keeps read-only and write profiles separate", () => {
    const root = "/repo";
    expect(profilePaths(root, "readonly")).toMatchObject({
      configDir: "/repo/config/ox-alpha-pi/readonly",
      tools: "read,grep,find,ls,subagent",
    });
    expect(profilePaths(root, "write")).toMatchObject({
      configDir: "/repo/config/ox-alpha-pi/write",
      tools: "read,bash,edit,write,grep,find,ls,subagent",
    });
  });

  it("builds an ephemeral, non-interactive Pi invocation without putting a key in argv", () => {
    const args = buildPiArgs({
      prompt: "bounded task",
      thinking: "high",
      outputMode: "json",
      extensionPath: "/pi/examples/extensions/subagent/index.ts",
      configDir: "/repo/config/ox-alpha-pi/readonly",
      tools: "read,grep,find,ls,subagent",
    });
    expect(args).toEqual([
      "--provider", "nous",
      "--model", "stealth/ox-alpha",
      "--thinking", "high",
      "--extension", "/pi/examples/extensions/subagent/index.ts",
      "--tools", "read,grep,find,ls,subagent",
      "--no-session",
      "--no-skills",
      "--no-prompt-templates",
      "--no-approve",
      "--mode", "json",
      "--print",
      "bounded task",
    ]);
    expect(args.join(" ")).not.toContain("sk-nous-");
    expect(args).not.toContain("--no-context-files");
  });

  it("locates the extension beside the installed Pi package", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ox-pi-layout-"));
    const cli = path.join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
    const extension = path.join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions", "subagent", "index.ts");
    mkdirSync(path.dirname(cli), { recursive: true });
    mkdirSync(path.dirname(extension), { recursive: true });
    writeFileSync(cli, "");
    writeFileSync(extension, "");
    const bin = path.join(root, "bin", "pi");
    mkdirSync(path.dirname(bin), { recursive: true });
    symlinkSync(path.relative(path.dirname(bin), cli), bin);

    expect(locateSubagentExtension(bin)).toBe(realpathSync(extension));
  });
});
