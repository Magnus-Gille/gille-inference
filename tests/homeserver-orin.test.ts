import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

let probeOrin: typeof import("../src/homeserver/nodes.js").probeOrin;
let runOrinInference: typeof import("../src/homeserver/nodes.js").runOrinInference;
let orinAllowsTask: typeof import("../src/homeserver/nodes.js").orinAllowsTask;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let recordDelegation: typeof import("../src/homeserver/ledger.js").recordDelegation;
let getVerdict: typeof import("../src/homeserver/ledger.js").getVerdict;
let ensureLedgerSchema: typeof import("../src/homeserver/ledger.js").ensureLedgerSchema;
let lastChatBody: Record<string, unknown> | null;

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-orin-")), "test.db"));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b" }] }), { status: 200 });
    if (url.endsWith("/api/chat")) {
      lastChatBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { content: "OK" }, prompt_eval_count: 3, eval_count: 1 }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }));
  const cfg = await import("../src/homeserver/config.js");
  const nodes = await import("../src/homeserver/nodes.js");
  const ledger = await import("../src/homeserver/ledger.js");
  setConfig = cfg.setConfig; resetConfig = cfg.resetConfig;
  probeOrin = nodes.probeOrin; runOrinInference = nodes.runOrinInference; orinAllowsTask = nodes.orinAllowsTask;
  recordDelegation = ledger.recordDelegation; getVerdict = ledger.getVerdict; ensureLedgerSchema = ledger.ensureLedgerSchema;
});

afterAll(() => { resetConfig(); vi.unstubAllGlobals(); });

beforeEach(() => {
  lastChatBody = null;
  resetConfig();
  setConfig({ orin: { url: "http://orin.test", model: "qwen2.5-coder:3b", eligibleTaskTypes: ["extract"], healthTimeoutMs: 500 } });
  ensureLedgerSchema();
  getDb().exec("DELETE FROM delegations");
});

describe("Orin backend contract", () => {
  it("discovers the configured inventory and runs only the configured small model", async () => {
    await expect(probeOrin()).resolves.toMatchObject({ id: "orin", configured: true, ok: true, modelAvailable: true });
    expect(orinAllowsTask("extract")).toBe(true);
    expect(orinAllowsTask("sql")).toBe(false);
    await expect(runOrinInference("qwen2.5-coder:3b", "reply", { maxTokens: 16, temperature: 0 })).resolves.toMatchObject({ ok: true, response: "OK", promptTokens: 3, completionTokens: 1 });
    await expect(runOrinInference("too-large:4b", "reply", { maxTokens: 16, temperature: 0 })).resolves.toEqual({ ok: false, error: "orin unavailable or model not allowed" });
  });

  it("forwards the complete sampler profile to Ollama", async () => {
    await runOrinInference("qwen2.5-coder:3b", "reply", {
      maxTokens: 16,
      temperature: 1,
      topP: 0.95,
      topK: 0,
      minP: 0,
    });
    expect(lastChatBody).toMatchObject({
      options: { num_predict: 16, temperature: 1, top_p: 0.95, top_k: 0, min_p: 0 },
    });
  });

  it("keeps capability evidence separate by actual node even for the same model id", () => {
    recordDelegation({ nodeId: "orin", taskType: "extract", modelId: "qwen2.5-coder:3b", prompt: "x", outcome: "pass" });
    expect(getVerdict("extract", "qwen2.5-coder:3b", { minSamples: 1, maxSamples: 2, maxFails: 2, viableThreshold: 0.7, marginalThreshold: 0.4, explorationRate: 0, judgmentQualityTaskTypes: [], trustedVerifiersForJudgment: [] }, "orin").passes).toBe(1);
    expect(getVerdict("extract", "qwen2.5-coder:3b", { minSamples: 1, maxSamples: 2, maxFails: 2, viableThreshold: 0.7, marginalThreshold: 0.4, explorationRate: 0, judgmentQualityTaskTypes: [], trustedVerifiersForJudgment: [] }, "m5").attempts).toBe(0);
  });
});
