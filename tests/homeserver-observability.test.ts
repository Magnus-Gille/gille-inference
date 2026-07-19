import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

/**
 * End-to-end observability suite. Drives the live gateway against a controllable upstream and
 * asserts the four data-layer pieces over the REAL request lifecycle:
 *   1. durable content-blind request_log (one row/request, no content, owner & guest)
 *   2. TTFT capture (streaming → positive ttft_ms + histogram; non-streaming → null)
 *   3. in-flight concurrency gauge (up while in-flight, back to 0 after release)
 *   4. trusted-catalogue canonicalizer (empty-allow-list owner + known model → id, not 'none';
 *      arbitrary/secret string → 'unknown', never the raw string)
 *
 * The upstream advertises a single resident model "m1" via /v1/models so the catalogue can
 * validate empty-allow-list (owner) requests.
 */

let upstream: Server;
let upstreamPort = 0;
let mockMode: "ok" | "sse" | "stall" | "sse-split" = "ok";
let releaseStall: (() => void) | null = null;

const RESIDENT_MODEL = "m1";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The catalogue source: GET /v1/models. llama-swap shape (data:[{id,...}]).
    if (req.method === "GET" && req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: RESIDENT_MODEL, object: "model" }] }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/running")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [{ model: RESIDENT_MODEL, state: "ready", cmd: "-c 4096" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { stream?: boolean };
      if (mockMode === "stall") {
        await new Promise<void>((resolve) => {
          releaseStall = resolve;
        });
      }
      if (mockMode === "sse-split") {
        // M4 regression: emit the FIRST content frame split across two separate TCP writes,
        // with a flush gap so the gateway receives two distinct `data` events. Neither half is
        // valid JSON on its own — TTFT must still fire on the reassembled frame (line buffer).
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const firstFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`;
        const splitAt = Math.floor(firstFrame.length / 2);
        res.write(firstFrame.slice(0, splitAt)); // partial — invalid JSON alone
        await new Promise((r) => setTimeout(r, 20));
        res.write(firstFrame.slice(splitAt)); // completes the frame
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (body.stream === true || mockMode === "sse") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`);
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
          choices: [{ message: { role: "assistant", content: "ok" } }],
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

let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let resetCatalogueCache: typeof import("../src/homeserver/catalogue.js").resetCatalogueCache;
let warmCatalogue: typeof import("../src/homeserver/catalogue.js").warmCatalogue;
let resetMetrics: typeof import("../src/homeserver/metrics.js").resetMetrics;
let renderMetrics: typeof import("../src/homeserver/metrics.js").renderMetrics;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const ADMIN = "obs-admin-static-key";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-obs-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  // Route the gateway at the upstream AND make llama-swap the backend so the catalogue (resident
  // model list) is sourced from the same controllable mock.
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = ADMIN;
  delete process.env["HOMESERVER_API_KEYS"];

  mintKey = (await import("../src/homeserver/keystore.js")).mintKey;
  resetQuotaWindows = (await import("../src/homeserver/quota.js")).resetQuotaWindows;
  const catMod = await import("../src/homeserver/catalogue.js");
  resetCatalogueCache = catMod.resetCatalogueCache;
  warmCatalogue = catMod.warmCatalogue;
  const metricsMod = await import("../src/homeserver/metrics.js");
  resetMetrics = metricsMod.resetMetrics;
  renderMetrics = metricsMod.renderMetrics;

  // Eagerly create the request_log + owner_request_log schemas so the row-count probes that run
  // BEFORE the first request have a table to read.
  (await import("../src/homeserver/request-log.js")).ensureRequestLogSchema();
  // Touch the owner-log once so its table exists (it is created lazily on first write).
  getDb().exec(`CREATE TABLE IF NOT EXISTS owner_request_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, alias TEXT NOT NULL, model TEXT,
    route TEXT NOT NULL, messages_json TEXT NOT NULL, completion TEXT NOT NULL,
    prompt_tokens INTEGER, completion_tokens INTEGER, latency_ms INTEGER, tok_per_sec REAL,
    outcome TEXT NOT NULL)`);

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(async () => {
  mockMode = "ok";
  releaseStall = null;
  resetQuotaWindows();
  resetCatalogueCache();
  // Warm the catalogue against the mock's resident set ("m1") so empty-allow-list owner requests
  // get a per-model label synchronously within the same test.
  await warmCatalogue();
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

async function chat(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url("/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: RESIDENT_MODEL, messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

/** Fire one MCP `ask` tools/call against the live gateway. */
async function mcpAsk(token: string, args: Record<string, unknown>, id = 1): Promise<Response> {
  return fetch(url("/mcp"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask", arguments: args } }),
  });
}

/** request_log rows for a given alias, oldest first — across all routes. */
function rowsForAlias(alias: string): RequestLogDbRow[] {
  return getDb()
    .prepare("SELECT * FROM request_log WHERE alias = @alias ORDER BY ts ASC")
    .all({ alias }) as RequestLogDbRow[];
}

interface RequestLogDbRow {
  id: string;
  alias: string | null;
  tier: string | null;
  key_hash: string | null;
  model: string;
  route: string;
  status: number;
  outcome: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  ttft_ms: number | null;
  total_ms: number;
}

function chatRows(): RequestLogDbRow[] {
  return getDb()
    .prepare("SELECT * FROM request_log WHERE route = '/v1/chat/completions' ORDER BY ts ASC")
    .all() as RequestLogDbRow[];
}

function rowCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM request_log").get() as { n: number }).n;
}

// ─── Piece 1 — durable content-blind request_log ──────────────────────────────────────

describe("request_log — durable & content-blind over the HTTP path", () => {
  it("a chat request writes exactly ONE row, with the canonical model and no content column", async () => {
    const before = rowCount();
    const owner = mintKey({ alias: "rl-owner", tier: "owner" }, DEFAULTS);
    const res = await chat(owner.plaintextKey, {});
    expect(res.status).toBe(200);
    expect(rowCount()).toBe(before + 1);

    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'rl-owner' ORDER BY ts DESC LIMIT 1")
      .get() as RequestLogDbRow;
    expect(row.alias).toBe("rl-owner");
    expect(row.tier).toBe("owner");
    expect(row.model).toBe(RESIDENT_MODEL);
    expect(row.route).toBe("/v1/chat/completions");
    expect(row.status).toBe(200);
    expect(row.outcome).toBe("ok");
    expect(row.total_ms).toBeGreaterThanOrEqual(0);

    // Hard privacy gate: the table has NO content column. The user prompt ("hi") and any
    // completion text must be absent from every column of the row.
    const cols = (getDb().prepare("PRAGMA table_info(request_log)").all() as Array<{ name: string }>).map((c) => c.name.toLowerCase());
    for (const banned of ["prompt", "response", "messages", "completion", "content", "body", "text"]) {
      expect(cols).not.toContain(banned);
    }
  });

  it("a GUEST request writes a metadata row but NO content anywhere", async () => {
    const guest = mintKey({ alias: "rl-guest", tier: "guest" }, DEFAULTS);
    const res = await chat(guest.plaintextKey, { messages: [{ role: "user", content: "GUEST-SECRET-PROMPT-XYZ" }] });
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'rl-guest' ORDER BY ts DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row["tier"]).toBe("guest");
    // The guest's prompt text must not appear in ANY column value of the row.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("GUEST-SECRET-PROMPT-XYZ");

    // And — separately — the owner-content log (owner_request_log) has ZERO guest rows.
    const ownerContentForGuest = (getDb()
      .prepare("SELECT COUNT(*) AS n FROM owner_request_log WHERE alias = 'rl-guest'")
      .get() as { n: number }).n;
    expect(ownerContentForGuest).toBe(0);
  });

  it("the request still succeeds if the request_log insert throws (best-effort)", async () => {
    // Force a duplicate-PK insert by pre-seeding a row whose id collides with the next requestId is
    // not deterministic; instead temporarily break the table so the INSERT throws, and confirm the
    // request still returns 200. We rename the table away, fire a request, then restore it.
    getDb().exec("ALTER TABLE request_log RENAME TO request_log_hidden");
    try {
      const owner = mintKey({ alias: "rl-throws", tier: "owner" }, DEFAULTS);
      const res = await chat(owner.plaintextKey, {});
      // The log write throws internally (no such table) but is swallowed — the request succeeds.
      expect(res.status).toBe(200);
    } finally {
      getDb().exec("DROP TABLE IF EXISTS request_log");
      getDb().exec("ALTER TABLE request_log_hidden RENAME TO request_log");
    }
  });
});

// ─── Piece 2 — TTFT capture ────────────────────────────────────────────────────────────

describe("TTFT capture", () => {
  it("a streamed completion records a positive ttft_ms AND observes the histogram", async () => {
    resetMetrics();
    const owner = mintKey({ alias: "ttft-stream", tier: "owner" }, DEFAULTS);
    const res = await chat(owner.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    await res.text(); // drain the stream so the gateway's tap completes and the row is written

    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'ttft-stream' ORDER BY ts DESC LIMIT 1")
      .get() as RequestLogDbRow;
    expect(row.ttft_ms).not.toBeNull();
    expect(row.ttft_ms!).toBeGreaterThanOrEqual(0);

    // The Prometheus TTFT histogram observed it (model label = the served model).
    const out = renderMetrics();
    expect(out).toContain("homeserver_ttft_seconds");
    expect(out).toMatch(/homeserver_ttft_seconds_count\{model="m1"\}\s+1/);
  });

  it("a NON-streamed completion leaves ttft_ms null", async () => {
    const owner = mintKey({ alias: "ttft-nonstream", tier: "owner" }, DEFAULTS);
    const res = await chat(owner.plaintextKey, {});
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'ttft-nonstream' ORDER BY ts DESC LIMIT 1")
      .get() as RequestLogDbRow;
    expect(row.ttft_ms).toBeNull();
  });

  it("M4: a stream whose first content frame is SPLIT across two TCP chunks still records a positive ttft_ms", async () => {
    // Regression: TTFT detection must line-buffer SSE frames. If it parsed each raw TCP chunk
    // independently, the split first frame would be invalid JSON in both halves → ttft_ms stays
    // null. Driving TTFT from the reassembled SSE line buffer fixes it.
    mockMode = "sse-split";
    const owner = mintKey({ alias: "ttft-split", tier: "owner" }, DEFAULTS);
    const res = await chat(owner.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    await res.text(); // drain so the gateway tap completes and writes the row

    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'ttft-split' ORDER BY ts DESC LIMIT 1")
      .get() as RequestLogDbRow;
    expect(row.ttft_ms).not.toBeNull();
    expect(row.ttft_ms!).toBeGreaterThanOrEqual(0);
  });
});

// ─── Piece 3 — concurrency gauge ───────────────────────────────────────────────────────

describe("in-flight concurrency gauge", () => {
  it("goes up while a request is in-flight and back to 0 after it releases", async () => {
    resetMetrics();
    mockMode = "stall";
    const owner = mintKey({ alias: "gauge-owner", tier: "owner", maxParallel: 2 }, DEFAULTS);

    // Hold a slot: the upstream stalls until we release it.
    const heldP = chat(owner.plaintextKey, {});
    await new Promise((r) => setTimeout(r, 60));

    // While in-flight, the gauge reads 1.
    const during = renderMetrics();
    expect(during).toMatch(/homeserver_inflight_requests\s+1/);
    expect(during).toMatch(/homeserver_inflight_by_lane\{lane="owner"\}\s+1/);

    // Release and let it finish.
    if (releaseStall) releaseStall();
    const held = await heldP;
    expect(held.status).toBe(200);
    await new Promise((r) => setTimeout(r, 30));

    const after = renderMetrics();
    expect(after).toMatch(/homeserver_inflight_requests\s+0/);
  });
});

// ─── Piece 4 — trusted-catalogue canonicalizer ─────────────────────────────────────────

describe("trusted-catalogue canonicalizer (empty allow-list owner key)", () => {
  it("a KNOWN catalogue model is recorded with its id in BOTH /metrics and request_log (not 'none')", async () => {
    resetMetrics();
    const owner = mintKey({ alias: "cat-known", tier: "owner" }, DEFAULTS); // empty allow-list
    const res = await chat(owner.plaintextKey, { model: RESIDENT_MODEL });
    expect(res.status).toBe(200);

    // request_log: the canonical model is the resident id, NOT 'none'.
    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'cat-known' ORDER BY ts DESC LIMIT 1")
      .get() as RequestLogDbRow;
    expect(row.model).toBe(RESIDENT_MODEL);
    expect(row.model).not.toBe("none");

    // /metrics: a series labelled with the resident model exists.
    const out = renderMetrics();
    expect(out).toMatch(/homeserver_requests_total\{[^}]*model="m1"[^}]*\}/);
  });

  it("an arbitrary/secret string → 'unknown', and the raw string NEVER appears in /metrics or request_log", async () => {
    resetMetrics();
    const owner = mintKey({ alias: "cat-secret", tier: "owner" }, DEFAULTS); // empty allow-list
    const secret = "sk-SUPERSECRET-INJECTED-LABEL-9f2a";
    const res = await chat(owner.plaintextKey, { model: secret });
    // The upstream serves it (the mock ignores the model), but the LABEL must be canonicalized away.
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'cat-secret' ORDER BY ts DESC LIMIT 1")
      .get() as RequestLogDbRow;
    expect(row.model).toBe("unknown");

    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secret);

    const out = renderMetrics();
    expect(out).not.toContain(secret);
  });
});

// ─── MCP `ask` path — must mirror the HTTP path's observability exactly ─────────────────

describe("MCP ask — trusted-catalogue model label (M1)", () => {
  it("an open-key ask to a KNOWN catalogue model logs that model id (not 'none') in request_log + /metrics", async () => {
    resetMetrics();
    const owner = mintKey({ alias: "mcp-cat-known", tier: "owner" }, DEFAULTS); // empty allow-list
    const res = await mcpAsk(owner.plaintextKey, { model: RESIDENT_MODEL, prompt: "hi" }, 101);
    expect(res.status).toBe(200);

    // The INFERENCE row (route '/mcp/ask') carries the resident model id, NOT 'none'.
    const infRow = rowsForAlias("mcp-cat-known").find((r) => r.route === "/mcp/ask")!;
    expect(infRow).toBeTruthy();
    expect(infRow.model).toBe(RESIDENT_MODEL);
    expect(infRow.model).not.toBe("none");

    // /metrics: a requests series labelled with the resident model exists.
    const out = renderMetrics();
    expect(out).toMatch(/homeserver_requests_total\{[^}]*model="m1"[^}]*\}/);
  });

  it("an arbitrary/secret model string → 'unknown', never the raw string, in request_log + /metrics", async () => {
    resetMetrics();
    const owner = mintKey({ alias: "mcp-cat-secret", tier: "owner" }, DEFAULTS); // empty allow-list
    const secret = "sk-MCP-SECRET-MODEL-LABEL-7e1b";
    const res = await mcpAsk(owner.plaintextKey, { model: secret, prompt: "hi" }, 102);
    expect(res.status).toBe(200);

    const infRow = rowsForAlias("mcp-cat-secret").find((r) => r.route === "/mcp/ask")!;
    expect(infRow).toBeTruthy();
    expect(infRow.model).toBe("unknown");
    expect(JSON.stringify(infRow)).not.toContain(secret);

    const out = renderMetrics();
    expect(out).not.toContain(secret);
  });
});

describe("MCP ask — two-row model: transport '/mcp' + inference '/mcp/ask' (M3)", () => {
  it("one successful ask yields exactly ONE '/mcp' transport row and ONE '/mcp/ask' inference row", async () => {
    const owner = mintKey({ alias: "mcp-tworow", tier: "owner" }, DEFAULTS);
    const res = await mcpAsk(owner.plaintextKey, { model: RESIDENT_MODEL, prompt: "hi" }, 103);
    expect(res.status).toBe(200);

    const rows = rowsForAlias("mcp-tworow");
    const transport = rows.filter((r) => r.route === "/mcp");
    const inference = rows.filter((r) => r.route === "/mcp/ask");
    expect(transport.length).toBe(1);
    expect(inference.length).toBe(1);
    // The inference row carries the served model + token usage; the transport row does not.
    expect(inference[0]!.model).toBe(RESIDENT_MODEL);
    expect(inference[0]!.total_tokens).toBe(10);
  });
});

describe("MCP ask — pre-admission failures still log a row + record a metric (M2)", () => {
  it("a quota-exhausted ask writes a '/mcp/ask' rate_limited row AND increments rate_limited{surface=quota}", async () => {
    resetMetrics();
    // dailyTokenBudget = 1: a single ask's estimate (prompt/4 + max_tokens) overflows it → 429.
    const guest = mintKey(
      { alias: "mcp-quota", tier: "guest" },
      { ...DEFAULTS, dailyTokenBudget: 1 }
    );
    const before = rowsForAlias("mcp-quota").length;
    const res = await mcpAsk(guest.plaintextKey, { model: RESIDENT_MODEL, prompt: "this is a long prompt that exceeds the tiny daily budget" }, 104);
    expect(res.status).toBe(200); // JSON-RPC transport is 200; the tool result is isError

    const rows = rowsForAlias("mcp-quota");
    expect(rows.length).toBeGreaterThan(before);
    const infRow = rows.find((r) => r.route === "/mcp/ask")!;
    expect(infRow).toBeTruthy();
    expect(infRow.outcome).toBe("rate_limited");

    const out = renderMetrics();
    expect(out).toMatch(/homeserver_rate_limited_total\{surface="quota"\}/);
  });

  it("an admission-rejected ask writes a '/mcp/ask' busy row AND increments admission_rejections{lane}", async () => {
    resetMetrics();
    mockMode = "stall";
    // maxParallel = 1: hold one ask in-flight, the second hits the per-key cap → AdmissionRejected.
    const guest = mintKey({ alias: "mcp-admit", tier: "guest" }, { ...DEFAULTS, maxParallel: 1 });

    const heldP = mcpAsk(guest.plaintextKey, { model: RESIDENT_MODEL, prompt: "held" }, 105);
    await new Promise((r) => setTimeout(r, 60)); // let the first ask occupy the slot

    const rejected = await mcpAsk(guest.plaintextKey, { model: RESIDENT_MODEL, prompt: "rejected" }, 106);
    expect(rejected.status).toBe(200);
    const rj = (await rejected.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(rj.result.isError).toBe(true);
    expect(rj.result.content[0]!.text).toMatch(/busy/i);

    // The rejected ask logged a '/mcp/ask' busy row + an admission-rejection metric.
    const infRows = rowsForAlias("mcp-admit").filter((r) => r.route === "/mcp/ask");
    const busyRow = infRows.find((r) => r.outcome === "busy");
    expect(busyRow).toBeTruthy();
    expect(busyRow!.admission).toBe("busy");

    const out = renderMetrics();
    expect(out).toMatch(/homeserver_admission_rejections_total\{lane="guest"\}/);

    // Release the held ask.
    if (releaseStall) releaseStall();
    await heldP;
    await new Promise((r) => setTimeout(r, 30));
  });
});
