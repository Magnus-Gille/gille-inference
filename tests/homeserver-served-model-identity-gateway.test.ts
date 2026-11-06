/**
 * INFER-343 — canonical served-model identity on the direct relay (HTTP + MCP).
 *
 * Reproduces the reported mismatch with a SYNTHETIC upstream (no live traffic): llama-server
 * (behind llama-swap) reports its own model name/path in `model` when it runs without an explicit
 * `--alias`, and the gateway used to forward that body/stream verbatim, so a caller that asked for
 * the roster ID got a different `model` back with HTTP 200.
 *
 * Contract under test: requested roster ID or an operator-declared alias of THAT roster ID
 * (rewritten to the roster ID) is success; absent `model` passes through unchanged; anything else
 * fails closed with the named `upstream_model_mismatch`, billed zero, with no served identity
 * leaked into the response.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../src/db.js";
import { getRequestLog } from "../src/homeserver/request-log.js";
import { runChatCompletion } from "../src/homeserver/mcp.js";
import { AdmissionController } from "../src/homeserver/admission.js";
import { loadConfig } from "../src/homeserver/config.js";

const ROSTER = "qwen3-30b-instruct";
// A private-looking path standing in for what llama-server reports without --alias.
const SERVED_PATH = "/home/operator/private/models/Qwen3-30B-A3B-Instruct-2507-Q4_K_M.gguf";
const OTHER_ROSTER_PATH = "/home/operator/private/models/some-other-model.gguf";
const UNKNOWN_PATH = "/home/operator/private/models/never-declared.gguf";

const unloadedIds: string[] = [];
// When set, the SSE branch writes exactly these raw strings (spaced by 10 ms) instead of the default.
let ssePlan: ((model: unknown) => string[]) | null = null;
let reportedModel: unknown = SERVED_PATH;
let omitModel = false;
let upstream: Server;
let upstreamPort = 0;

function withModel(frame: Record<string, unknown>): Record<string, unknown> {
  return omitModel ? frame : { ...frame, model: reportedModel };
}

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/v1/models") {
        // Warms the trusted catalogue: ROSTER is a real roster ID (the llama-swap model key).
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: ROSTER, object: "model" }, { id: "some-other-model", object: "model" }] }));
        return;
      }
      if (req.method === "GET" && url === "/running") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ running: [] }));
        return;
      }
      if (req.method === "POST" && url.startsWith("/api/models/unload/")) {
        unloadedIds.push(decodeURIComponent(url.slice("/api/models/unload/".length)));
        res.writeHead(200);
        res.end("OK");
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
      if (body.stream === true && ssePlan !== null) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const parts = ssePlan(reportedModel);
        parts.forEach((part, i) => setTimeout(() => {
          if (res.destroyed || res.writableEnded) return;
          res.write(part);
          if (i === parts.length - 1) res.end();
        }, 10 * (i + 1)));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const f1 = `data: ${JSON.stringify(withModel({ id: "c1", choices: [{ delta: { role: "assistant", content: "hel" } }] }))}\n\n`;
        const f2 = `data: ${JSON.stringify(withModel({ id: "c1", choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }))}\n\n`;
        const f3 = `data: ${JSON.stringify(withModel({ id: "c1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))}\n\n`;
        // Split the second frame mid-JSON across two writes to exercise reassembly.
        res.write(f1);
        setTimeout(() => res.write(f2.slice(0, 30)), 10);
        setTimeout(() => {
          res.write(f2.slice(30));
          res.write(f3);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 30);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          withModel({
            id: "cmpl-1",
            choices: [{ index: 0, message: { role: "assistant", content: "{\"ok\":true}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }),
        ),
      );
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    }),
  );
}

let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let gatewayPort = 0; // enforce
let shadowPort = 0;
let offPort = 0;
const stops: Array<() => Promise<void>> = [];
let runtimeDir = "";
let aliases: Map<string, Set<string>>;
let renderMetrics: () => string;
let mcpRun: (alias: string, mode?: "enforce" | "shadow" | "off", model?: string) => Promise<{
  r: Awaited<ReturnType<typeof runChatCompletion>>;
  k: { plaintextKey: string };
}>;
const SHADOW_METRIC = "homeserver_served_model_mismatch_shadow_total";

beforeAll(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), "hs-identity-test-"));
  initDb(join(runtimeDir, "test.db"));
  await startUpstream();
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_FEEDBACK_FILE"] = join(runtimeDir, "feedback.jsonl");
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_CALL_TIMEOUT_MS"] = "2000";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "admin-static-key";

  const ks = await import("../src/homeserver/keystore.js");
  const q = await import("../src/homeserver/quota.js");
  const cfgMod = await import("../src/homeserver/config.js");
  const gw = await import("../src/homeserver/gateway.js");
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  resetQuotaWindows = q.resetQuotaWindows;
  aliases = new Map([
    [ROSTER, new Set([SERVED_PATH])],
    ["some-other-model", new Set([OTHER_ROSTER_PATH])],
  ]);
  // Explicit, operator-declared roster -> served-identity pairs (config.servedModelAliases).
  const start = async (mode: "enforce" | "shadow" | "off"): Promise<number> => {
    cfgMod.setConfig({ servedModelAliases: aliases, servedModelIdentity: mode, recurrentModelIds: [ROSTER], poisonClearCooldownMs: 1 } as never);
    const handle = await gw.startGateway();
    stops.push(handle.stop);
    return handle.port;
  };
  gatewayPort = await start("enforce");
  shadowPort = await start("shadow");
  offPort = await start("off");
  renderMetrics = (await import("../src/homeserver/metrics.js")).renderMetrics;
  // The roster ID must be in the trusted catalogue for identity checks to apply (canonical ID).
  expect((await (await import("../src/homeserver/catalogue.js")).warmCatalogue()).has(ROSTER)).toBe(true);
});

afterAll(async () => {
  for (const stop of stops) await stop();
  await new Promise<void>((r) => upstream.close(() => r()));
  closeDb();
  rmSync(runtimeDir, { recursive: true, force: true });
});

beforeEach(() => {
  reportedModel = SERVED_PATH;
  omitModel = false;
  ssePlan = null;
  resetQuotaWindows();
});

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

async function chat(token: string, extra: Record<string, unknown> = {}, port = gatewayPort): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      model: ROSTER,
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "r", schema: { type: "object" } } },
      ...extra,
    }),
  });
}

function lastLog(alias: string): { outcome: string; status: number; errorClass: string | null } | null {
  const row = getRequestLog(200).find((r) => r.alias === alias);
  return row ? { outcome: row.outcome, status: row.status, errorClass: row.errorClass } : null;
}

function expectNoServedIdentityLeak(): void {
  const rows = JSON.stringify(getRequestLog(500));
  for (const needle of [SERVED_PATH, UNKNOWN_PATH, OTHER_ROSTER_PATH, "/home/operator"]) {
    expect(rows).not.toContain(needle);
    expect(renderMetrics()).not.toContain(needle);
  }
}

function sseModels(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => (JSON.parse(l.slice(6)) as { model?: unknown }).model);
}

describe("INFER-343 direct non-streaming identity", () => {
  it("a declared alias of the requested roster ID yields the canonical roster ID", async () => {
    const k = mintKey({ alias: "id-alias", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(k.plaintextKey);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { model: string; id: string; choices: unknown[]; usage: { total_tokens: number } };
    expect(j.model).toBe(ROSTER);
    expect(j.id).toBe("cmpl-1");
    expect(j.usage.total_tokens).toBe(10);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBeGreaterThan(0);
  });

  it("an exact roster-ID response is forwarded unchanged", async () => {
    reportedModel = ROSTER;
    const k = mintKey({ alias: "id-exact", tier: "guest" }, DEFAULTS);
    const j = (await (await chat(k.plaintextKey)).json()) as { model: string };
    expect(j.model).toBe(ROSTER);
  });

  it("an undeclared served identity fails closed with a named error, billed zero, no leak", async () => {
    reportedModel = UNKNOWN_PATH;
    const k = mintKey({ alias: "id-unknown", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(k.plaintextKey);
    expect(res.status).toBe(502);
    const text = await res.text();
    const j = JSON.parse(text) as { error: { code: string; type: string; param: string } };
    expect(j.error.code).toBe("upstream_model_mismatch");
    expect(j.error.type).toBe("server_error");
    expect(j.error.param).toBe("model");
    expect(text).not.toContain("/home/operator");
    expect(text).not.toContain(".gguf");
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    const log = lastLog("id-unknown");
    expect(log).toEqual({ outcome: "upstream_model_mismatch", status: 502, errorClass: "upstream_model_mismatch" });
  });

  it("an alias declared for a DIFFERENT roster ID is not accepted (no cross-model relabel)", async () => {
    reportedModel = OTHER_ROSTER_PATH;
    const k = mintKey({ alias: "id-cross", tier: "guest" }, DEFAULTS);
    const res = await chat(k.plaintextKey);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("upstream_model_mismatch");
  });

  it("a non-string or empty model is a mismatch", async () => {
    const k = mintKey({ alias: "id-garbage", tier: "guest" }, DEFAULTS);
    for (const bad of ["", 42, ["x"], {}]) {
      reportedModel = bad;
      expect((await chat(k.plaintextKey)).status).toBe(502);
    }
  });

  it("an absent model (provenance unavailable) is forwarded unchanged and never invented", async () => {
    omitModel = true;
    const k = mintKey({ alias: "id-absent", tier: "guest" }, DEFAULTS);
    const res = await chat(k.plaintextKey);
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object)).not.toContain("model");
  });
});

describe("INFER-343 direct streaming identity", () => {
  it("rewrites the model of EVERY SSE chunk for a declared alias", async () => {
    const k = mintKey({ alias: "sid-alias", tier: "guest" }, DEFAULTS);
    const res = await chat(k.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(sseModels(text)).toEqual([ROSTER, ROSTER, ROSTER]);
    expect(text).not.toContain("/home/operator");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text).toContain('"content":"hel"');
    expect(text).toContain('"content":"lo"');
  });

  it("an undeclared served identity yields no content frame, a terminal named error frame, billed zero", async () => {
    reportedModel = UNKNOWN_PATH;
    const k = mintKey({ alias: "sid-unknown", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(k.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"content":"hel"');
    expect(text).not.toContain("/home/operator");
    expect(text).toContain('"code":"upstream_model_mismatch"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    expect(lastLog("sid-unknown")).toEqual({ outcome: "upstream_model_mismatch", status: 200, errorClass: "upstream_model_mismatch" });
    expectNoServedIdentityLeak();
    // N2: the gateway aborted the upstream itself; a recurrent model must be poison-cleared.
    await vi.waitFor(() => expect(unloadedIds).toContain(ROSTER));
  });

  it("frames without a model are forwarded unchanged", async () => {
    omitModel = true;
    const k = mintKey({ alias: "sid-absent", tier: "guest" }, DEFAULTS);
    const text = await (await chat(k.plaintextKey, { stream: true })).text();
    expect(sseModels(text)).toEqual([undefined, undefined, undefined]);
    expect(text).toContain('"content":"hel"');
  });
});

describe("INFER-343 MCP ask identity", () => {
  const noopInflight = { inc: () => {}, dec: () => {}, current: () => 0 };
  function principalOf(rec: NonNullable<ReturnType<typeof lookupKey>>) {
    return {
      alias: rec.alias,
      tier: rec.tier,
      modelAllowList: rec.modelAllowList,
      limits: { rpm: rec.rpm, tpm: rec.tpm, dailyTokenBudget: rec.dailyTokenBudget },
      maxParallel: rec.maxParallel,
      keyHash: rec.keyHash,
      creditLimit: rec.creditLimit,
    };
  }
  const run = async (alias: string, mode: "enforce" | "shadow" | "off" = "enforce", model = ROSTER) => {
    const k = mintKey({ alias, tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const cfg = { ...loadConfig(), servedModelAliases: aliases, servedModelIdentity: mode, lmStudioBaseUrl: `http://127.0.0.1:${upstreamPort}/v1` };
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });
    const r = await runChatCompletion(principalOf(lookupKey(k.plaintextKey)!), cfg, controller, noopInflight, {
      model,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });
    return { r, k };
  };
  mcpRun = run;

  it("accepts a declared alias", async () => {
    const { r } = await run("mcp-id-alias");
    expect(r.ok).toBe(true);
  });

  it("rejects an undeclared served identity, billed zero, without echoing it", async () => {
    reportedModel = UNKNOWN_PATH;
    const { r, k } = await run("mcp-id-unknown");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("upstream_error");
      expect(r.traceErrorClass).toBe("upstream_model_mismatch");
      expect(r.message).not.toContain("/home/operator");
    }
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("accepts an absent model", async () => {
    omitModel = true;
    expect((await run("mcp-id-absent")).r.ok).toBe(true);
  });
});

describe("INFER-343 shadow mode (default rollout)", () => {
  const metricCount = (): number =>
    renderMetrics().split("\n").filter((l) => l.startsWith(SHADOW_METRIC + "{")).reduce((n, l) => n + Number(l.split(" ").pop()), 0);

  it("non-streaming: a declared alias is still rewritten", async () => {
    const k = mintKey({ alias: "sh-alias", tier: "guest" }, DEFAULTS);
    const j = (await (await chat(k.plaintextKey, {}, shadowPort)).json()) as { model: string };
    expect(j.model).toBe(ROSTER);
  });

  it("non-streaming: a mismatch passes through UNCHANGED, is billed, and is counted content-free", async () => {
    reportedModel = UNKNOWN_PATH;
    const k = mintKey({ alias: "sh-unknown", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const before = metricCount();
    const res = await chat(k.plaintextKey, {}, shadowPort);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe(UNKNOWN_PATH);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBeGreaterThan(0);
    expect(lastLog("sh-unknown")?.outcome).toBe("ok");
    expect(metricCount()).toBe(before + 1);
    expect(renderMetrics()).not.toContain("/home/operator");
  });

  it("streaming: alias rewritten in every frame; a mismatch streams through unchanged and is counted once", async () => {
    const k = mintKey({ alias: "sh-sid", tier: "guest" }, DEFAULTS);
    expect(sseModels(await (await chat(k.plaintextKey, { stream: true }, shadowPort)).text())).toEqual([ROSTER, ROSTER, ROSTER]);
    reportedModel = UNKNOWN_PATH;
    const before = metricCount();
    // Fresh key: the billed-amount assertion must not be satisfied by the earlier request.
    const fresh = mintKey({ alias: "sh-sid-mismatch", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(fresh.plaintextKey)!.creditsUsed).toBe(0);
    const text = await (await chat(fresh.plaintextKey, { stream: true }, shadowPort)).text();
    expect(sseModels(text)).toEqual([UNKNOWN_PATH, UNKNOWN_PATH, UNKNOWN_PATH]);
    expect(text).toContain('"content":"hel"');
    expect(text).not.toContain("upstream_model_mismatch");
    expect(metricCount()).toBe(before + 1);
    expect(lookupKey(fresh.plaintextKey)!.creditsUsed).toBeGreaterThan(0);
  });

  it("MCP ask: mismatch succeeds (billed) and is counted", async () => {
    reportedModel = UNKNOWN_PATH;
    const before = metricCount();
    const { r, k } = await mcpRun("mcp-sh-unknown", "shadow");
    expect(r.ok).toBe(true);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBeGreaterThan(0);
    expect(metricCount()).toBe(before + 1);
  });
});

describe("INFER-343 off mode", () => {
  it("does no inspection or rewrite on any path", async () => {
    const k = mintKey({ alias: "off-k", tier: "guest" }, DEFAULTS);
    const before = renderMetrics();
    expect(((await (await chat(k.plaintextKey, {}, offPort)).json()) as { model: string }).model).toBe(SERVED_PATH);
    expect(sseModels(await (await chat(k.plaintextKey, { stream: true }, offPort)).text())).toEqual([SERVED_PATH, SERVED_PATH, SERVED_PATH]);
    reportedModel = UNKNOWN_PATH;
    const res = await chat(k.plaintextKey, {}, offPort);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { model: string }).model).toBe(UNKNOWN_PATH);
    expect(renderMetrics().split("\n").filter((l) => l.startsWith(SHADOW_METRIC + "{"))).toEqual(
      before.split("\n").filter((l) => l.startsWith(SHADOW_METRIC + "{")),
    );
  });

  it("MCP ask: mismatch succeeds", async () => {
    reportedModel = UNKNOWN_PATH;
    expect((await mcpRun("mcp-off-unknown", "off")).r.ok).toBe(true);
  });
});

describe("INFER-343 canonical roster ID (B1)", () => {
  const metricCount = (): number =>
    renderMetrics().split("\n").filter((l) => l.startsWith(SHADOW_METRIC + "{")).reduce((n, l) => n + Number(l.split(" ").pop()), 0);

  it("canonicalization only ever yields the requested roster ID or the unknown sentinel", async () => {
    const { canonicalizeModelTrusted } = await import("../src/homeserver/catalogue.js");
    expect(canonicalizeModelTrusted(ROSTER, [])).toBe(ROSTER);
    for (const spelling of ["Qwen3-30B-Instruct", ` ${ROSTER}`, "qwen3-30b", "qwen3-30b-instruct\u0000"]) {
      expect(canonicalizeModelTrusted(spelling, [])).toBe("unknown");
    }
  });

  it("a non-canonical spelling is not a roster ID: no check, no rewrite, no false shadow count", async () => {
    const k = mintKey({ alias: "canon-spell", tier: "guest" }, DEFAULTS);
    const before = metricCount();
    // Backend correctly reports the roster ID for a differently-spelled request: accepted.
    reportedModel = ROSTER;
    for (const port of [gatewayPort, shadowPort]) {
      const res = await chat(k.plaintextKey, { model: "Qwen3-30B-Instruct" }, port);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { model: string }).model).toBe(ROSTER);
    }
    // The raw spelling is never used as the identity: a declared alias is not rewritten for it,
    // and nothing is rejected or counted (we cannot vouch for what was requested).
    reportedModel = SERVED_PATH;
    for (const port of [gatewayPort, shadowPort]) {
      const res = await chat(k.plaintextKey, { model: "Qwen3-30B-Instruct" }, port);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { model: string }).model).toBe(SERVED_PATH);
    }
    expect(metricCount()).toBe(before);
  });

  it("MCP uses the same canonical ID: a non-roster spelling is unchecked and never counted", async () => {
    const before = metricCount();
    reportedModel = ROSTER;
    expect((await mcpRun("mcp-spell-ok", "enforce", "Qwen3-30B-Instruct")).r.ok).toBe(true);
    reportedModel = UNKNOWN_PATH;
    expect((await mcpRun("mcp-spell-mm", "shadow", "Qwen3-30B-Instruct")).r.ok).toBe(true);
    expect(metricCount()).toBe(before);
  });

  it("the canonical roster ID still verifies, rewrites declared aliases and labels the metric", async () => {
    const k = mintKey({ alias: "canon-ok", tier: "guest" }, DEFAULTS);
    reportedModel = ROSTER;
    expect(((await (await chat(k.plaintextKey)).json()) as { model: string }).model).toBe(ROSTER);
    reportedModel = SERVED_PATH;
    expect(((await (await chat(k.plaintextKey)).json()) as { model: string }).model).toBe(ROSTER);
    reportedModel = UNKNOWN_PATH;
    await chat(k.plaintextKey, {}, shadowPort);
    expect(renderMetrics()).toContain(`${SHADOW_METRIC}{model="${ROSTER}"}`);
  });
});

describe("INFER-343 streaming edge cases (enforce)", () => {
  const event = (model: unknown, content: string): string =>
    `data: ${JSON.stringify({ id: "c", model, choices: [{ delta: { content } }] })}\n\n`;

  it("mismatch on a LATER frame: partial content, then the named error frame, billed 0", async () => {
    ssePlan = () => [event(ROSTER, "part"), event(UNKNOWN_PATH, "LEAK"), "data: [DONE]\n\n"];
    const k = mintKey({ alias: "later-mm", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(k.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content":"part"');
    expect(text).not.toContain("LEAK");
    expect(text).toContain('"code":"upstream_model_mismatch"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    expect(lastLog("later-mm")).toEqual({ outcome: "upstream_model_mismatch", status: 200, errorClass: "upstream_model_mismatch" });
    expectNoServedIdentityLeak();
  });

  it("an unparsable JSON-looking frame that mentions model is unverifiable and fails closed", async () => {
    ssePlan = () => ['data: {"model": "oops", broken\n\n', "data: [DONE]\n\n"];
    const k = mintKey({ alias: "unparsable", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const text = await (await chat(k.plaintextKey, { stream: true })).text();
    expect(text).toContain('"code":"upstream_model_mismatch"');
    expect(text).not.toContain("oops");
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("CRLF / no-space framing is verified and rewritten end to end", async () => {
    ssePlan = (m) => [`data:${JSON.stringify({ model: m, choices: [{ delta: { content: "x" } }] })}\r\n\r\n`, "data: [DONE]\r\n\r\n"];
    const k = mintKey({ alias: "crlf", tier: "guest" }, DEFAULTS);
    const text = await (await chat(k.plaintextKey, { stream: true })).text();
    expect(text).toContain(`"model":"${ROSTER}"`);
    expect(text).not.toContain("/home/operator");
  });

  it("shadow counts an unverifiable frame once and passes it through", async () => {
    ssePlan = () => ['data: {"model": "oops", broken\n\n', "data: [DONE]\n\n"];
    const k = mintKey({ alias: "unparsable-sh", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const metricBefore = renderMetrics().split("\n").filter((l) => l.startsWith(SHADOW_METRIC + "{")).join("");
    const text = await (await chat(k.plaintextKey, { stream: true }, shadowPort)).text();
    expect(text).toContain("oops");
    expect(renderMetrics().split("\n").filter((l) => l.startsWith(SHADOW_METRIC + "{")).join("")).not.toBe(metricBefore);
  });
});
