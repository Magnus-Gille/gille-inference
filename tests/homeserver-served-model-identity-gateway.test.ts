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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
      if (req.method !== "POST") {
        // Catalogue/running probes from the gateway: not under test.
        res.writeHead(404);
        res.end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
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
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let runtimeDir = "";
let aliases: Map<string, Set<string>>;

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
  cfgMod.setConfig({ servedModelAliases: aliases } as never);
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  closeDb();
  rmSync(runtimeDir, { recursive: true, force: true });
});

beforeEach(() => {
  reportedModel = SERVED_PATH;
  omitModel = false;
  resetQuotaWindows();
});

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

async function chat(token: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
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
    const text = await res.text();
    expect(text).not.toContain('"content":"hel"');
    expect(text).not.toContain("/home/operator");
    expect(text).toContain('"code":"upstream_model_mismatch"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    expect(lastLog("sid-unknown")?.outcome).toBe("upstream_model_mismatch");
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
  const run = async (alias: string) => {
    const k = mintKey({ alias, tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const cfg = { ...loadConfig(), servedModelAliases: aliases, lmStudioBaseUrl: `http://127.0.0.1:${upstreamPort}/v1` };
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });
    const r = await runChatCompletion(principalOf(lookupKey(k.plaintextKey)!), cfg, controller, noopInflight, {
      model: ROSTER,
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });
    return { r, k };
  };

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
