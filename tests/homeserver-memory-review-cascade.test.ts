import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

const GIB = 1024 ** 3;
const MELLUM_MODEL = "mellum";
const GPT_MODEL = "gpt-oss-120b";
const QWEN_MODEL = "qwen35-122b-a10b";
const SOURCE = "L1|const id = req.id;\nL2|db.exec(`SELECT * FROM users WHERE id=${id}`);";
const CANDIDATE = JSON.stringify({ findings: [{
  id: "f1",
  severity: "high",
  lineIds: ["L2"],
  evidence: "db.exec(`SELECT * FROM users WHERE id=${id}`);",
  claim: "SQL injection",
}] });
const DECISION = JSON.stringify({ adjudications: [{
  findingId: "f1",
  decision: "confirm",
  rationale: "Interpolation reaches db.exec.",
}] });

let upstream: Server;
let upstreamPort = 0;
let backendModels: string[] = [];
let activeBackendCalls = 0;
let maxConcurrentBackendCalls = 0;
let logs: Record<string, unknown>[] = [];
let cascadeAggregates: Record<string, unknown>[] = [];
let ownerKey = "";
let ownerCounter = 0;
let holdBackground = false;
let heldBackground = false;
let firstBackgroundStarted: Promise<void> = Promise.resolve();
let resolveFirstBackgroundStarted: (() => void) | null = null;
let releaseHeldBackground: (() => void) | null = null;

function memorySnapshot() {
  return {
    ok: true as const,
    memory: {
      memTotalBytes: 100 * GIB,
      memAvailableBytes: 10 * GIB,
      cmaFreeBytes: null,
      gttUsedBytes: null,
      gttTotalBytes: null,
    },
  };
}

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/running" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (path === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        model?: string;
        messages?: Array<{ content?: string }>;
      };
      const foreground = body.messages?.some((message) => message.content === "foreground request") === true;
      backendModels.push(body.model ?? "");
      activeBackendCalls++;
      maxConcurrentBackendCalls = Math.max(maxConcurrentBackendCalls, activeBackendCalls);
      const responseFinished = { value: false };
      const releaseIfClosed = () => {
        if (!responseFinished.value) releaseHeldBackground?.();
      };
      res.once("close", releaseIfClosed);
      if (!foreground && holdBackground && !heldBackground) {
        heldBackground = true;
        resolveFirstBackgroundStarted?.();
        await new Promise<void>((resolve) => { releaseHeldBackground = resolve; });
      }
      const response = body.model === QWEN_MODEL ? DECISION : CANDIDATE;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "cascade-test", choices: [{ delta: { content: response } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "cascade-test", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`);
      responseFinished.value = true;
      res.end("data: [DONE]\n\n");
      activeBackendCalls--;
    });
  });
  return new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => {
    upstreamPort = (upstream.address() as { port: number }).port;
    resolve();
  }));
}

async function withGateway(
  env: Record<string, string>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const keys = [...new Set([
    "HOMESERVER_REVIEW_CASCADE",
    "HOMESERVER_REVIEW_CASCADE_GPT_MODEL",
    "HOMESERVER_REVIEW_CASCADE_QWEN_MODEL",
    "HOMESERVER_REVIEW_CASCADE_TASK_TYPES",
    "HOMESERVER_HOST_MEMORY_ADMISSION",
    "HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB",
    "HOMESERVER_HOST_MEMORY_RESERVE_GIB",
    "HOMESERVER_ROUTING_TABLE_PATH",
    "HOMESERVER_USE_ROUTING_TABLE",
    ...Object.keys(env),
  ])];
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  vi.resetModules();
  const metricsModule = await import("../src/homeserver/metrics.js");
  const recordAggregate = metricsModule.recordReviewCascade;
  const aggregateSpy = vi.spyOn(metricsModule, "recordReviewCascade").mockImplementation((row) => {
    cascadeAggregates.push(row as unknown as Record<string, unknown>);
    recordAggregate(row);
  });
  const gateway = await import("../src/homeserver/gateway.js");
  const keystore = await import("../src/homeserver/keystore.js");
  ownerKey = keystore.mintKey({ alias: `cascade-memory-${ownerCounter++}`, tier: "owner", scope: "admin" }, {
    rpm: 1000,
    tpm: 1_000_000,
    dailyTokenBudget: 0,
    maxParallel: 1,
  }).plaintextKey;
  const handle = await gateway.startGateway({
    hostMemoryAdmissionDependencies: {
      getRunning: async () => [],
      readMemory: async () => memorySnapshot(),
      log: (record) => logs.push(record),
    },
  });
  try {
    await fn(handle.port);
  } finally {
    await handle.stop();
    aggregateSpy.mockRestore();
    for (const key of keys) delete process.env[key];
  }
}

async function delegate(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/delegate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ taskType: "code-review", maxTokens: 16, prompt: SOURCE }),
  });
}

async function metrics(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/metrics`, {
    headers: { authorization: `Bearer ${ownerKey}` },
  })).text();
}

async function recentLedger(port: number): Promise<Array<Record<string, unknown>>> {
  const body = await (await fetch(`http://127.0.0.1:${port}/ledger?includeShadow=1`, {
    headers: { authorization: `Bearer ${ownerKey}` },
  })).json() as { recent?: Array<Record<string, unknown>> };
  return body.recent ?? [];
}

async function chat(port: number): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ model: MELLUM_MODEL, messages: [{ role: "user", content: "foreground request" }], max_tokens: 8 }),
  });
}

async function waitForFirstBackgroundStart(): Promise<void> {
  await Promise.race([
    firstBackgroundStarted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("background model did not start")), 2_000)),
  ]);
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-memory-cascade-"));
  process.env["EVAL_DB_PATH"] = join(dir, "test.db");
  initDb(process.env["EVAL_DB_PATH"]);
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1";
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  await startUpstream();
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["LLAMASWAP_BASE_URL"] = `http://127.0.0.1:${upstreamPort}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  backendModels = [];
  activeBackendCalls = 0;
  maxConcurrentBackendCalls = 0;
  logs = [];
  cascadeAggregates = [];
  holdBackground = false;
  heldBackground = false;
  releaseHeldBackground = null;
  firstBackgroundStarted = new Promise((resolve) => { resolveFirstBackgroundStarted = resolve; });
});

const COMMON = {
  HOMESERVER_REVIEW_CASCADE: "shadow",
  HOMESERVER_REVIEW_CASCADE_GPT_MODEL: GPT_MODEL,
  HOMESERVER_REVIEW_CASCADE_QWEN_MODEL: QWEN_MODEL,
  HOMESERVER_REVIEW_CASCADE_TASK_TYPES: "code-review",
  HOMESERVER_USE_ROUTING_TABLE: "on",
  HOMESERVER_HOST_MEMORY_RESERVE_GIB: "1",
  HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB: `${MELLUM_MODEL}=1,${GPT_MODEL}=1,${QWEN_MODEL}=60`,
};

describe("gateway review-cascade model-start admission", () => {
  it("enforce refusal blocks the selected second-stage backend and releases the background slot", async () => {
    await withGateway({ ...COMMON, HOMESERVER_HOST_MEMORY_ADMISSION: "enforce" }, async (port) => {
      expect((await delegate(port)).status).toBe(200);
      const review = await import("../src/homeserver/review-cascade-shadow.js");
      await review.reviewCascadeShadowIdle();

      expect(backendModels).toEqual([GPT_MODEL]);
      expect(logs).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: GPT_MODEL, outcome: "allow", enforced: true }),
        expect.objectContaining({ model: QWEN_MODEL, outcome: "refuse", reason: "insufficient_memory", enforced: true }),
      ]));
      expect(await metrics(port)).toContain('homeserver_review_cascade_runs_total{terminal="skipped"} 1');
      expect(cascadeAggregates).toEqual(expect.arrayContaining([
        expect.objectContaining({ terminal: "skipped", candidateCount: 1 }),
      ]));

      // A leaked background lease would make this second eligible cascade skip as busy.
      expect((await delegate(port)).status).toBe(200);
      await review.reviewCascadeShadowIdle();
      expect(backendModels).toEqual([GPT_MODEL, GPT_MODEL]);
      expect(logs.filter((entry) => entry.event === "host_memory_admission")).toHaveLength(4);
    });
  });

  it("shadow records overbudget refusal while forwarding the same selected model", async () => {
    await withGateway({ ...COMMON, HOMESERVER_HOST_MEMORY_ADMISSION: "shadow" }, async (port) => {
      expect((await delegate(port)).status).toBe(200);
      const review = await import("../src/homeserver/review-cascade-shadow.js");
      await review.reviewCascadeShadowIdle();

      expect(backendModels).toEqual([GPT_MODEL, QWEN_MODEL]);
      expect(logs).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: GPT_MODEL, outcome: "allow", enforced: false }),
        expect.objectContaining({ model: QWEN_MODEL, outcome: "refuse", reason: "insufficient_memory", enforced: false }),
      ]));
      expect(await metrics(port)).toContain('homeserver_review_cascade_runs_total{terminal="completed"} 1');
    });
  });

  it("shares one preemptible background lease between escalation shadow and review cascade", async () => {
    await withGateway({
      ...COMMON,
      HOMESERVER_SHADOW_LANE: "on",
      HOMESERVER_SHADOW_LANE_MODEL: MELLUM_MODEL,
      HOMESERVER_SHADOW_LANE_TASK_TYPES: "code-review",
      HOMESERVER_MAX_INFLIGHT: "1",
      HOMESERVER_HOST_MEMORY_ADMISSION: "shadow",
    }, async (port) => {
      holdBackground = true;
      expect((await delegate(port)).status).toBe(200);
      await waitForFirstBackgroundStart();

      // The first background start is held in the fake SSE upstream. The competing lane must
      // acquire no second model call, and a foreground request must preempt the held background.
      expect(backendModels).toHaveLength(1);
      expect((await chat(port)).status).toBe(200);
      releaseHeldBackground?.();
      const review = await import("../src/homeserver/review-cascade-shadow.js");
      const shadow = await import("../src/homeserver/shadow-lane.js");
      await Promise.all([review.reviewCascadeShadowIdle(), shadow.shadowLaneIdle()]);
      expect(maxConcurrentBackendCalls).toBeLessThanOrEqual(1);
      expect((await recentLedger(port)).some((row) => row.source === "shadow")).toBe(false);

      // Once the foreground preemption released the shared lease, a later background request can
      // run again; it still serializes the two optional background lanes.
      holdBackground = false;
      const beforeLater = backendModels.length;
      expect((await delegate(port)).status).toBe(200);
      await Promise.all([review.reviewCascadeShadowIdle(), shadow.shadowLaneIdle()]);
      expect(backendModels.length).toBeGreaterThan(beforeLater);
      expect(maxConcurrentBackendCalls).toBeLessThanOrEqual(1);
    });
  });
});
