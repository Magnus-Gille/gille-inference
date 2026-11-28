import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * INFER-525: `ask_batch` runs several independent ask tasks in one MCP call, through the exact
 * single-ask path, with bounded concurrency and per-task failure isolation.
 */

let upstream: Server;
let upstreamHits = 0;
let inflight = 0;
let maxInflight = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
const keys: Record<string, string> = {};
let blindFile = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ask-batch-"));
  initDb(join(dir, "test.db"));
  const root = join(dir, "blind");
  mkdirSync(root);
  blindFile = join(root, "note.txt");
  writeFileSync(blindFile, "BATCH-FILE-CANARY");

  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mellum", object: "model" }, { id: "other", object: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamHits++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: Array<{ content: string }> };
      const user = body.messages[body.messages.length - 1]!.content;
      setTimeout(() => {
        inflight--;
        if (user.includes("UPSTREAM-FAIL")) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "boom" } }));
          return;
        }
        const echo = /TASK-(\d+)/.exec(user)?.[0] ?? "none";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: `ANSWER ${echo}${user.includes("BATCH-FILE-CANARY") ? " WITH-FILE" : ""}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }));
      }, 30);
    });
  });
  const upstreamPort = await new Promise<number>((resolve) => upstream.listen(0, "127.0.0.1", () =>
    resolve((upstream.address() as { port: number }).port)));

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "8";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"] = root;
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  const keystore = await import("../src/homeserver/keystore.js");
  const mint = (alias: string, tier: "owner" | "guest", scope: string, maxParallel: number, models: string[] = []) =>
    keystore.mintKey({ alias, tier, scope: scope as never, maxParallel, modelAllowList: models },
      { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel }).plaintextKey;
  keys["ask"] = mint("batch-ask", "owner", "ask", 2, ["mellum"]);
  keys["wide"] = mint("batch-wide", "owner", "agent", 8);
  keys["serial"] = mint("batch-serial", "owner", "agent", 1);
  keys["guest"] = mint("batch-guest", "guest", "inference", 2);

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
const batch = (key: string, args: Record<string, unknown>) => rpc(key, "tools/call", { name: "ask_batch", arguments: args });
const task = (n: number, extra: Record<string, unknown> = {}) => ({ model: "mellum", prompt: `TASK-${n}`, ...extra });

describe("ask_batch", () => {
  it("is advertised to an ask-scope key with the ask arguments as its item schema", async () => {
    const tools = (await rpc(keys["ask"]!, "tools/list")).result.tools as Array<{ name: string; inputSchema: any }>;
    const def = tools.find((t) => t.name === "ask_batch")!;
    const ask = tools.find((t) => t.name === "ask")!;
    expect(def.inputSchema.properties.tasks.items).toEqual(ask.inputSchema);
    expect(def.inputSchema.properties.tasks.maxItems).toBe(16);
  });

  it("returns every result in input order", async () => {
    const body = await batch(keys["ask"]!, { tasks: [task(0), task(1), task(2), task(3), task(4)] });
    expect(body.result.isError).toBe(false);
    const sc = body.result.structuredContent;
    expect(sc.succeeded).toBe(5);
    expect(sc.failed).toBe(0);
    expect(sc.results.map((r: any) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(sc.results.map((r: any) => r.text)).toEqual([0, 1, 2, 3, 4].map((n) => `ANSWER TASK-${n}`));
    expect(sc.results[0]).toMatchObject({ ok: true, model: "mellum", finish_reason: "stop", error: null });
    expect(body.result.content[0].text).toContain("===== TASK 3 (mellum) ok =====\nANSWER TASK-3");
  });

  it("isolates failures: validation, model grant and upstream errors do not abort other tasks", async () => {
    const before = upstreamHits;
    const body = await batch(keys["ask"]!, {
      tasks: [task(0), { prompt: "no model" }, task(2, { model: "other" }), task(3, { prompt: "UPSTREAM-FAIL" }), "not-an-object", task(5)],
    });
    expect(body.result.isError).toBe(false);
    const r = body.result.structuredContent.results;
    expect(r.map((e: any) => e.ok)).toEqual([true, false, false, false, false, true]);
    expect(r[2].error.m5_code).toBe("model_not_allowed");
    expect(r[3].error).not.toBeNull();
    expect(r[5].text).toBe("ANSWER TASK-5");
    expect(body.result.structuredContent).toMatchObject({ succeeded: 2, failed: 4 });
    // Only the tasks that passed validation and the model grant reached the backend.
    expect(upstreamHits - before).toBeGreaterThanOrEqual(3);
    expect(upstreamHits - before).toBeLessThanOrEqual(4);
  });

  it("is an error only when every task failed", async () => {
    const body = await batch(keys["ask"]!, { tasks: [{ prompt: "x" }, task(1, { model: "other" })] });
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent).toMatchObject({ succeeded: 0, failed: 2 });
  });

  it.each([
    ["no tasks", {}],
    ["empty tasks", { tasks: [] }],
    ["17 tasks", { tasks: Array.from({ length: 17 }, (_, n) => task(n)) }],
    ["tasks not an array", { tasks: task(0) }],
    ["unknown argument", { tasks: [task(0)], model: "mellum" }],
    ["bad content_capture", { tasks: [task(0)], content_capture: "all" }],
  ])("refuses %s before any backend call", async (_label, args) => {
    const before = upstreamHits;
    const body = await batch(keys["ask"]!, args);
    expect(body.result.isError).toBe(true);
    expect(upstreamHits).toBe(before);
  });

  it("never runs more tasks at once than the key's max_parallel", async () => {
    maxInflight = 0;
    await batch(keys["serial"]!, { tasks: [task(0), task(1), task(2), task(3)] });
    expect(maxInflight).toBe(1);
    maxInflight = 0;
    await batch(keys["ask"]!, { tasks: [task(0), task(1), task(2), task(3), task(4), task(5)] });
    expect(maxInflight).toBeLessThanOrEqual(2);
  });

  it("caps concurrency at 4 even for a wider key", async () => {
    maxInflight = 0;
    const body = await batch(keys["wide"]!, { tasks: Array.from({ length: 10 }, (_, n) => task(n)) });
    expect(body.result.structuredContent.succeeded).toBe(10);
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(maxInflight).toBeGreaterThan(1);
  });

  it("keeps per-task file authority: an owner agent key may attach, an ungranted ask key and a guest may not", async () => {
    const owner = await batch(keys["wide"]!, { tasks: [task(0, { files: [blindFile] })] });
    expect(owner.result.structuredContent.results[0].text).toBe("ANSWER TASK-0 WITH-FILE");
    const before = upstreamHits;
    const ask = await batch(keys["ask"]!, { tasks: [task(0, { files: [blindFile] })] });
    expect(ask.result.structuredContent.results[0]).toMatchObject({ ok: false });
    const guest = await batch(keys["guest"]!, { tasks: [task(0, { files: [blindFile] })] });
    expect(guest.result.structuredContent.results[0].error.message).toMatch(/owner-tier/);
    expect(upstreamHits).toBe(before);
    expect(JSON.stringify(ask)).not.toContain("BATCH-FILE-CANARY");
  });
});
