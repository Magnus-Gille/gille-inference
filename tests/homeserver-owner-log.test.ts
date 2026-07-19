import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

/**
 * OWNER-ONLY full request log suite. Mirrors the portal/mcp-test harness: a controllable stub
 * upstream (non-streaming AND SSE-streaming, chosen by the request's `stream` flag), keystore-
 * only mode (keys minted before startGateway so the gateway does not bootstrap implicit-admin),
 * and an ephemeral port.
 *
 * Asserts the privacy guard end-to-end:
 *   • an OWNER-key chat request → exactly one owner_request_log row with the prompt + completion
 *   • a GUEST-key chat request → ZERO rows (NO content logged, ever)
 *   • HOMESERVER_OWNER_REQUEST_LOG=off → no row even for an owner
 *   • a STREAMING owner request → the row's completion equals the assembled streamed text
 *   • an MCP `ask` owner request → logged with route='mcp'
 */

let upstream: Server;
let upstreamPort = 0;

const NONSTREAM_COMPLETION = "OWNER-VISIBLE NON-STREAM COMPLETION";
const STREAM_PIECES = ["Hello", ", ", "streamed", " ", "world"];

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The trusted-catalogue canonicalizer refreshes the resident model list in the background via
    // a GET to the model-admin endpoint. Answer it cleanly so the detached refresh resolves fast
    // (rather than hanging the connection until its abort timeout).
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], models: [], running: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { stream?: boolean };
      if (body.stream === true) {
        // Emit a minimal OpenAI-style SSE stream: one delta per content piece, then a terminal
        // usage frame, then [DONE].
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const piece of STREAM_PIECES) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: NONSTREAM_COMPLETION } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
      );
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    })
  );
}

// Bound after dynamic import in beforeAll.
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let getOwnerLog: typeof import("../src/homeserver/owner-log.js").getOwnerLog;

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

let ownerKey = "";
let guestKey = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-owner-log-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  process.env["HOMESERVER_OWNER_REQUEST_LOG"] = "on"; // explicit default-on for this suite
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;
  const ol = await import("../src/homeserver/owner-log.js");
  getOwnerLog = ol.getOwnerLog;
  // Trigger idempotent schema creation up front so the raw COUNT() probes below see the table
  // even before the first owner request writes to it.
  getOwnerLog(1);

  ownerKey = mintKey({ alias: "ol-owner", tier: "owner" }, DEFAULTS).plaintextKey;
  guestKey = mintKey({ alias: "ol-guest", tier: "guest" }, DEFAULTS).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

/** Count owner_request_log rows whose serialized messages contain a marker string. */
function rowsWithMarker(marker: string): number {
  const r = getDb()
    .prepare("SELECT COUNT(*) AS n FROM owner_request_log WHERE messages_json LIKE @m")
    .get({ m: `%${marker}%` }) as { n: number };
  return r.n;
}

async function chat(key: string, marker: string, stream = false): Promise<Response> {
  return fetch(url("/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "m1",
      stream,
      messages: [{ role: "user", content: marker }],
    }),
  });
}

// ─── Owner non-streaming chat → exactly one row with prompt + completion ─────────────

describe("owner non-streaming chat is fully logged", () => {
  it("records exactly one row containing the prompt messages AND the completion", async () => {
    const marker = "OWNER_NONSTREAM_MARKER_PROMPT";
    expect(rowsWithMarker(marker)).toBe(0);

    const res = await chat(ownerKey, marker, false);
    expect(res.status).toBe(200);

    expect(rowsWithMarker(marker)).toBe(1);
    const row = getOwnerLog(50).find((e) => e.messagesJson.includes(marker))!;
    expect(row).toBeDefined();
    expect(row.alias).toBe("ol-owner");
    expect(row.route).toBe("chat");
    expect(row.model).toBe("m1");
    // The prompt messages are captured verbatim.
    expect(row.messagesJson).toContain(marker);
    // The FULL completion text is captured.
    expect(row.completion).toBe(NONSTREAM_COMPLETION);
    expect(row.promptTokens).toBe(5);
    expect(row.completionTokens).toBe(5);
  });
});

// ─── Guest chat → ZERO rows (never content-logged) ────────────────────────────────────

describe("guest traffic is NEVER content-logged", () => {
  it("a guest-key request produces no owner_request_log row at all", async () => {
    const before = (getDb().prepare("SELECT COUNT(*) AS n FROM owner_request_log").get() as { n: number }).n;
    const marker = "GUEST_MARKER_MUST_NOT_BE_LOGGED";

    const res = await chat(guestKey, marker, false);
    expect(res.status).toBe(200);

    // No row carries the guest's prompt, and the total row count is unchanged.
    expect(rowsWithMarker(marker)).toBe(0);
    const after = (getDb().prepare("SELECT COUNT(*) AS n FROM owner_request_log").get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

// ─── Owner streaming chat → completion assembled from the SSE deltas ──────────────────

describe("owner streaming chat assembles the streamed completion", () => {
  it("the row's completion equals the concatenated streamed delta content", async () => {
    const marker = "OWNER_STREAM_MARKER_PROMPT";
    expect(rowsWithMarker(marker)).toBe(0);

    const res = await chat(ownerKey, marker, true);
    expect(res.status).toBe(200);
    // Drain the stream so the gateway tap finishes and the row is written.
    await res.text();

    // The tap accumulates async; poll briefly until the row lands (best-effort write).
    for (let i = 0; i < 50 && rowsWithMarker(marker) === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(rowsWithMarker(marker)).toBe(1);
    const row = getOwnerLog(50).find((e) => e.messagesJson.includes(marker))!;
    expect(row.route).toBe("chat");
    expect(row.completion).toBe(STREAM_PIECES.join(""));
    expect(row.completionTokens).toBe(5);
  });
});

// ─── Toggle off → no row even for owner ───────────────────────────────────────────────

describe("HOMESERVER_OWNER_REQUEST_LOG=off disables logging", () => {
  let offPort = 0;
  let stopOff: (() => Promise<void>) | null = null;
  let offOwnerKey = "";

  beforeAll(async () => {
    // Spin up a SECOND gateway on the SAME DB with the toggle off (config is cached per import,
    // and the gateway above already cached it on — so use setConfig to flip the live value).
    const cfgMod = await import("../src/homeserver/config.js");
    cfgMod.setConfig({ ownerRequestLog: "off" });

    offOwnerKey = mintKey({ alias: "ol-owner-off", tier: "owner" }, DEFAULTS).plaintextKey;

    const gw = await import("../src/homeserver/gateway.js");
    const handle = await gw.startGateway();
    offPort = handle.port;
    stopOff = handle.stop;
  });

  afterAll(async () => {
    if (stopOff) await stopOff();
    // Restore the on posture for any later work (the suite is otherwise done).
    const cfgMod = await import("../src/homeserver/config.js");
    cfgMod.setConfig({ ownerRequestLog: "on" });
  });

  it("an owner request writes NO row when the toggle is off", async () => {
    const marker = "TOGGLE_OFF_OWNER_MARKER";
    const res = await fetch(`http://127.0.0.1:${offPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${offOwnerKey}` },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: marker }] }),
    });
    expect(res.status).toBe(200);
    expect(rowsWithMarker(marker)).toBe(0);
  });
});

// ─── MCP `ask` owner request → logged with route='mcp' ────────────────────────────────

describe("owner MCP ask is logged", () => {
  it("records an owner_request_log row with route='mcp'", async () => {
    const marker = "OWNER_MCP_ASK_MARKER";
    expect(rowsWithMarker(marker)).toBe(0);

    const res = await fetch(url("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask", arguments: { model: "m1", prompt: marker } },
      }),
    });
    expect(res.status).toBe(200);

    expect(rowsWithMarker(marker)).toBe(1);
    const row = getOwnerLog(50).find((e) => e.messagesJson.includes(marker))!;
    expect(row.route).toBe("mcp");
    expect(row.alias).toBe("ol-owner");
    expect(row.completion).toBe(NONSTREAM_COMPLETION);
  });

  it("a guest MCP ask produces NO row", async () => {
    const marker = "GUEST_MCP_ASK_MARKER";
    const res = await fetch(url("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guestKey}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ask", arguments: { model: "m1", prompt: marker } },
      }),
    });
    expect(res.status).toBe(200);
    expect(rowsWithMarker(marker)).toBe(0);
  });
});
