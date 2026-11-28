import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { linkSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * INFER-524: an ask-scope key may attach blind-context files ONLY with an explicit per-key grant,
 * and only under granted roots that lie inside HOMESERVER_BLIND_CONTEXT_ROOTS. Secret-looking paths
 * and private-key content are refused for every caller.
 */

let upstream: Server;
let upstreamHits = 0;
let lastUpstreamBody = "";
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let keystore: typeof import("../src/homeserver/keystore.js");
const keys: Record<string, string> = {};
const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
let globalRoot = "";
let repoA = "";
let repoB = "";
let outside = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ask-files-"));
  initDb(join(dir, "test.db"));
  globalRoot = join(dir, "blind");
  repoA = join(globalRoot, "repo-a");
  repoB = join(globalRoot, "repo-b");
  outside = join(dir, "outside");
  for (const d of [globalRoot, repoA, repoB, outside, join(repoA, "src"), join(repoA, ".git"), join(repoA, "data")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repoA, "src", "main.ts"), "REPO-A-CANARY");
  writeFileSync(join(repoB, "notes.md"), "REPO-B-CANARY");
  writeFileSync(join(outside, "passwd"), "OUTSIDE-CANARY");
  writeFileSync(join(repoA, ".env"), "TOKEN=SECRET-CANARY");
  writeFileSync(join(repoA, ".git", "config"), "[remote] url=https://user:SECRET-CANARY@x");
  writeFileSync(join(repoA, "data", "notes.txt"), "STATE-CANARY");
  writeFileSync(join(repoA, "deploy.pem"), "SECRET-CANARY");
  writeFileSync(join(repoA, "src", "aws-credentials"), "SECRET-CANARY");
  writeFileSync(join(repoA, "src", "prod.tfstate"), "SECRET-CANARY");
  writeFileSync(join(repoA, "src", "fixture.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-CANARY\n");
  symlinkSync(join(outside, "passwd"), join(repoA, "src", "escape.txt"));
  writeFileSync(join(repoA, "src", "token.txt"), "auth = ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n");
  writeFileSync(join(repoA, ".env-production"), "SECRET-CANARY");
  linkSync(join(repoA, ".env"), join(repoA, "src", "innocent.txt"));
  mkdirSync(join(globalRoot, "mirror", ".git"), { recursive: true });
  writeFileSync(join(globalRoot, "mirror", ".git", "config"), "SECRET-CANARY");
  mkdirSync(join(globalRoot, "real-1"));
  mkdirSync(join(globalRoot, "real-2"));
  writeFileSync(join(globalRoot, "real-1", "a.txt"), "REAL-1");
  writeFileSync(join(globalRoot, "real-2", "a.txt"), "REAL-2-CANARY");
  symlinkSync(join(globalRoot, "real-1"), join(globalRoot, "current"));
  symlinkSync(repoB, join(repoA, "link-to-b"));

  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mellum", object: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamHits++;
      lastUpstreamBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "STUBBED COMPLETION" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
    });
  });
  const upstreamPort = await new Promise<number>((resolve) => upstream.listen(0, "127.0.0.1", () =>
    resolve((upstream.address() as { port: number }).port)));

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"] = globalRoot;
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  keystore = await import("../src/homeserver/keystore.js");
  const mint = (alias: string, tier: "owner" | "guest", scope: string) =>
    keystore.mintKey({ alias, tier, scope: scope as never }, DEFAULTS).plaintextKey;
  keys["granted"] = mint("ask-granted", "owner", "ask");
  keys["ungranted"] = mint("ask-ungranted", "owner", "ask");
  keys["escaping"] = mint("ask-escaping", "owner", "ask");
  keys["agent"] = mint("agent-owner", "owner", "agent");
  keys["guest"] = mint("guest-inference", "guest", "inference");
  keys["gitgrant"] = mint("ask-gitgrant", "owner", "ask");
  keys["moving"] = mint("ask-moving", "owner", "ask");
  keystore.setKeyFileRoots("ask-granted", [repoA]);
  keystore.setKeyFileRoots("ask-escaping", [outside]);
  keystore.setKeyFileRoots("ask-gitgrant", [join(globalRoot, "mirror", ".git")]);
  keystore.setKeyFileRoots("ask-moving", [join(globalRoot, "current")]);

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  delete process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"];
  delete process.env["HOMESERVER_REQUEST_LOG"];
});

async function rpc(key: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  expect(res.status).toBe(200);
  return res.json();
}
const ask = (key: string, files: string[]) =>
  rpc(key, "tools/call", { name: "ask", arguments: { model: "mellum", prompt: "summarize", files } });

describe("INFER-524 discovery", () => {
  it("an ungranted ask key keeps today's discovery and schema", async () => {
    const list = await rpc(keys["ungranted"]!, "tools/call", { name: "list_models", arguments: {} });
    expect(list.result.structuredContent.ask_capabilities).toEqual({ files_enabled: false, files_reason: "owner_tier_required", resolved_root_count: null });
    const tools = (await rpc(keys["ungranted"]!, "tools/list")).result.tools;
    expect(tools.find((t: any) => t.name === "ask").inputSchema.properties).not.toHaveProperty("files");
  });

  it("a granted ask key sees files enabled with its own root count and the files input", async () => {
    const list = await rpc(keys["granted"]!, "tools/call", { name: "list_models", arguments: {} });
    expect(list.result.structuredContent.ask_capabilities).toEqual({ files_enabled: true, files_reason: "enabled", resolved_root_count: 1 });
    expect(JSON.stringify(list.result)).not.toContain(repoA);
    const tools = (await rpc(keys["granted"]!, "tools/list")).result.tools;
    expect(tools.find((t: any) => t.name === "ask").inputSchema.properties).toHaveProperty("files");
  });

  it("a grant outside the server's roots never widens it", async () => {
    const list = await rpc(keys["escaping"]!, "tools/call", { name: "list_models", arguments: {} });
    expect(list.result.structuredContent.ask_capabilities).toEqual({ files_enabled: false, files_reason: "no_resolved_roots", resolved_root_count: 0 });
    const before = upstreamHits;
    const body = await ask(keys["escaping"]!, [join(outside, "passwd")]);
    expect(body.result.isError).toBe(true);
    expect(upstreamHits).toBe(before);
  });
});

describe("INFER-524 enforcement", () => {
  it("a granted ask key reads a file under its root", async () => {
    const before = upstreamHits;
    const body = await ask(keys["granted"]!, [join(repoA, "src", "main.ts")]);
    expect(body.result.isError).toBe(false);
    expect(upstreamHits).toBe(before + 1);
    expect(lastUpstreamBody).toContain("REPO-A-CANARY");
  });

  it("an ungranted ask key is still refused before any file handling", async () => {
    const before = upstreamHits;
    const body = await ask(keys["ungranted"]!, [join(repoA, "src", "main.ts")]);
    expect(body.result.isError).toBe(true);
    expect(upstreamHits).toBe(before);
  });

  it.each([
    ["inside the server root but outside the key root", () => join(repoB, "notes.md"), /granted to this key/],
    ["a symlink escaping the server root", () => join(repoA, "src", "escape.txt"), /granted to this key/],
    ["a directory symlink into a sibling repo", () => join(repoA, "link-to-b", "notes.md"), /granted to this key/],
    ["a .. traversal", () => `${repoA}/../repo-b/notes.md`, /granted to this key/],
    [".env", () => join(repoA, ".env"), /never attached/],
    [".git internals", () => join(repoA, ".git", "config"), /never attached/],
    ["a data/ state directory", () => join(repoA, "data", "notes.txt"), /never attached/],
    ["a .pem file", () => join(repoA, "deploy.pem"), /never attached/],
    ["a *-credentials file", () => join(repoA, "src", "aws-credentials"), /never attached/],
    ["terraform state", () => join(repoA, "src", "prod.tfstate"), /never attached/],
    ["private-key content", () => join(repoA, "src", "fixture.txt"), /private key or credential token/],
    ["a bearer token in content", () => join(repoA, "src", "token.txt"), /private key or credential token/],
    [".env-production", () => join(repoA, ".env-production"), /never attached/],
    ["a hard link to a secret", () => join(repoA, "src", "innocent.txt"), /hard link/],
    ["a nonexistent path (same message as outside)", () => join(repoA, "src", "missing.txt"), /not an attachable file/],
    ["a nonexistent path outside the root", () => join(outside, "missing.txt"), /not an attachable file/],,
  ])("refuses %s without an upstream call", async (_label, path, message) => {
    const before = upstreamHits;
    const body = await ask(keys["granted"]!, [path()]);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(message);
    expect(JSON.stringify(body)).not.toMatch(/CANARY/);
    expect(upstreamHits).toBe(before);
  });

  it("the secret denylist also applies to an agent-scope owner key with global roots", async () => {
    const ok = await ask(keys["agent"]!, [join(repoB, "notes.md")]);
    expect(ok.result.isError).toBe(false);
    const before = upstreamHits;
    const denied = await ask(keys["agent"]!, [join(repoA, ".env")]);
    expect(denied.result.isError).toBe(true);
    expect(upstreamHits).toBe(before);
  });

  it("a guest key supplying files is still rejected", async () => {
    const body = await ask(keys["guest"]!, [join(repoA, "src", "main.ts")]);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/owner-tier/);
  });
});

describe("INFER-524 grant lifecycle", () => {
  it("rejects relative roots, guests and unknown aliases", () => {
    expect(() => keystore.setKeyFileRoots("ask-granted", ["relative/path"])).toThrow(/absolute/);
    expect(() => keystore.setKeyFileRoots("guest-inference", [repoA])).toThrow(/owner-tier/);
    expect(() => keystore.setKeyFileRoots("no-such-key", [repoA])).toThrow(/no active key/);
    expect(() => keystore.setKeyFileRoots("agent-owner", [repoA])).toThrow(/only to ask-scope/);
    expect(() => keystore.setKeyFileRoots("ask-granted", [join(repoA, "nope")])).toThrow(/not an existing directory/);
  });

  it("clearing the grant revokes file access immediately", async () => {
    keystore.mintKey({ alias: "ask-temp", tier: "owner", scope: "ask" }, DEFAULTS);
    expect(keystore.setKeyFileRoots("ask-temp", [repoA]).map((r) => r.path)).toEqual([repoA]);
    expect(keystore.getKeyFileRootsByAlias("ask-temp").map((r) => r.path)).toEqual([repoA]);
    expect(keystore.setKeyFileRoots("ask-temp", [])).toEqual([]);
    expect(keystore.getKeyFileRootsByAlias("ask-temp")).toEqual([]);
  });

  it("rotation drops the grant (bound to the credential hash)", () => {
    keystore.mintKey({ alias: "ask-rot", tier: "owner", scope: "ask" }, DEFAULTS);
    keystore.setKeyFileRoots("ask-rot", [repoA]);
    const rotated = keystore.rotateKey("ask-rot", {}, DEFAULTS);
    expect(keystore.getKeyFileRootsByAlias(rotated.newAlias)).toEqual([]);
  });
});

describe("INFER-524 review hardening", () => {
  it("a grant pointing into a denylisted subtree of the server root is ignored", async () => {
    const list = await rpc(keys["gitgrant"]!, "tools/call", { name: "list_models", arguments: {} });
    expect(list.result.structuredContent.ask_capabilities).toMatchObject({ files_enabled: false, files_reason: "no_resolved_roots" });
    const before = upstreamHits;
    const body = await ask(keys["gitgrant"]!, [join(globalRoot, "mirror", ".git", "config")]);
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/CANARY/);
    expect(upstreamHits).toBe(before);
  });

  it("a granted root is bound to its directory identity: a retargeted symlink is dropped", async () => {
    // Granted through the symlink: stored as the canonical real-1 directory.
    const ok = await ask(keys["moving"]!, [join(globalRoot, "real-1", "a.txt")]);
    expect(ok.result.isError).toBe(false);
    // Replace real-1 with a different directory at the same path: identity changes, grant drops.
    // (rename keeps both inodes alive, so the replacement is guaranteed a different identity).
    renameSync(join(globalRoot, "real-1"), join(globalRoot, "old-1"));
    renameSync(join(globalRoot, "real-2"), join(globalRoot, "real-1"));
    const before = upstreamHits;
    const body = await ask(keys["moving"]!, [join(globalRoot, "real-1", "a.txt")]);
    expect(body.result.isError).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/CANARY/);
    expect(upstreamHits).toBe(before);
  });

  it("an ask key whose grant resolves to nothing does not get the files input", async () => {
    const tools = (await rpc(keys["gitgrant"]!, "tools/list")).result.tools;
    expect(tools.find((t: any) => t.name === "ask").inputSchema.properties).not.toHaveProperty("files");
  });
});

describe("INFER-524 descriptor attestation (review H1)", () => {
  it("refuses when the kernel says the open descriptor lies outside the key's roots", async () => {
    const { expandBlindContext, identifyKeyFileRoot } = await import("../src/homeserver/blind-context.js");
    const root = identifyKeyFileRoot(repoA)!;
    const cfg = { roots: [globalRoot], maxFileBytes: 1 << 20, maxTotalBytes: 1 << 20, keyRoots: [root] };
    const file = join(repoA, "src", "main.ts");
    expect(expandBlindContext([file], cfg).ok).toBe(true);
    const swapped = expandBlindContext([file], { ...cfg, descriptorPath: () => join(outside, "passwd") });
    expect(swapped.ok).toBe(false);
    const unattested = expandBlindContext([file], { ...cfg, descriptorPath: () => null });
    expect(unattested.ok).toBe(false);
  });

  it("reads at most the cap plus one byte", async () => {
    const { expandBlindContext } = await import("../src/homeserver/blind-context.js");
    const r = expandBlindContext([join(repoA, "src", "main.ts")], { roots: [globalRoot], maxFileBytes: 4, maxTotalBytes: 1 << 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("file_too_large");
  });
});
