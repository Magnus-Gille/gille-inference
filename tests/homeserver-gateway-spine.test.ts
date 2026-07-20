import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getDb, initDb } from "../src/db.js";

// The gateway reads config from env at startGateway() time. We must set env BEFORE
// importing config/gateway, and isolate the DB before any keystore call. Tests drive a
// mock "LM Studio" upstream whose behaviour (stall / capture body / 404) is controllable.

let upstream: Server;
let upstreamPort = 0;
let mockMode: "ok" | "stall" | "notfound" | "sse" | "error500" | "nonjson" | "reset" = "ok";
let lastUpstreamBody = "";
let upstreamInferenceRequestCount = 0;
let releaseStall: (() => void) | null = null;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      if (req.url?.endsWith("/chat/completions")) upstreamInferenceRequestCount += 1;
      lastUpstreamBody = Buffer.concat(chunks).toString("utf-8");
      if (mockMode === "notfound") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model not found" } }));
        return;
      }
      if (mockMode === "error500") {
        // An upstream failure AFTER a successful 200-route lookup (i.e. not a 404). Carries a
        // usage frame in the body to prove the gateway does NOT read it on a non-2xx (Fix #1).
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" }, usage: { total_tokens: 9999 } }));
        return;
      }
      if (mockMode === "reset") {
        // Abruptly destroy the socket so the gateway's fetch() rejects (timeout / connection
        // reset / stream error) AFTER admission — exercises C2 (no billing on a failed call).
        req.socket.destroy();
        return;
      }
      if (mockMode === "nonjson") {
        // A 2xx with a non-JSON body — no usage frame is readable (Fix #1).
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not json at all");
        return;
      }
      if (mockMode === "sse") {
        // Emit a tiny SSE stream ending with a usage frame + [DONE].
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"x","choices":[{"delta":{"content":"he"}}]}\n\n');
        res.write('data: {"id":"x","choices":[{"delta":{"content":"llo"}}]}\n\n');
        res.write('data: {"id":"x","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      if (mockMode === "stall") {
        await new Promise<void>((resolve) => {
          releaseStall = resolve;
        });
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
  return new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => {
    upstreamPort = (upstream.address() as { port: number }).port;
    resolve();
  }));
}

let startGateway: typeof import("../src/homeserver/gateway.js").startGateway;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let recordCreditUsage: typeof import("../src/homeserver/keystore.js").recordUsage;
let loadConfig: typeof import("../src/homeserver/config.js").loadConfig;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let taskTextFingerprint: typeof import("../src/homeserver/task-exposure.js").taskTextFingerprint;
let taskFingerprintVersion: typeof import("../src/homeserver/task-exposure.js").TASK_FINGERPRINT_VERSION;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-spine-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "1";
  process.env["HOMESERVER_OWNER_QUEUE_MAX_MS"] = "3000";
  process.env["HOMESERVER_BUSY_RETRY_AFTER_S"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  // Bootstrap admin via the legacy static admin key so we can mint store keys over HTTP.
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "admin-static-key";
  process.env["HOMESERVER_API_KEYS"] = "legacy-user-key";

  const gw = await import("../src/homeserver/gateway.js");
  const ks = await import("../src/homeserver/keystore.js");
  const cfgMod = await import("../src/homeserver/config.js");
  const q = await import("../src/homeserver/quota.js");
  const exposure = await import("../src/homeserver/task-exposure.js");
  startGateway = gw.startGateway;
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  recordCreditUsage = ks.recordUsage;
  loadConfig = cfgMod.loadConfig;
  resetQuotaWindows = q.resetQuotaWindows;
  taskTextFingerprint = exposure.taskTextFingerprint;
  taskFingerprintVersion = exposure.TASK_FINGERPRINT_VERSION;

  const handle = await startGateway();
  // startGateway resolves with a stop handle + the bound port (spec: returns control).
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  mockMode = "ok";
  releaseStall = null;
  upstreamInferenceRequestCount = 0;
  resetQuotaWindows();
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

async function chat(token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url("/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

const ADMIN = "admin-static-key";
const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

async function makeStampedDelegateRequest(owner: { plaintextKey: string }): Promise<{
  principalId: string;
  stamp: Record<string, any>;
  requestBody: Record<string, any>;
}> {
  const principalId = lookupKey(owner.plaintextKey)!.alias;
  const preflightResponse = await fetch(url("/v1/capabilities/learning-task"), {
    headers: { authorization: `Bearer ${owner.plaintextKey}` },
  });
  expect(preflightResponse.status).toBe(200);
  const advertisement = await preflightResponse.json() as Record<string, unknown> & {
    advertised_at: string;
    capabilities: unknown;
  };
  const requestFixture = JSON.parse(readFileSync(
    new URL("./fixtures/hugin-learning-task-request-v1.json", import.meta.url),
    "utf8",
  )) as {
    prompt: string;
    taskType: string;
    huginTaskIdentity: Record<string, any>;
    learningTaskStamp: Record<string, any>;
  };
  const stamp = structuredClone(requestFixture.learningTaskStamp);
  const advertisedMs = Date.parse(advertisement.advertised_at);
  stamp.task_instance_id = `task-${randomUUID()}`;
  stamp.attempt_id = "attempt-1";
  stamp.idempotency_key = `opaque:${randomUUID()}`;
  stamp.request_id = `opaque:${randomUUID()}`;
  stamp.expected_transport_principal_id = principalId;
  stamp.source.created_at = new Date(advertisedMs - 3_000).toISOString();
  stamp.source.accepted_at = new Date(advertisedMs - 2_000).toISOString();
  stamp.preflight.request.request_id = `opaque:${randomUUID()}`;
  stamp.preflight.request.requested_at = new Date(advertisedMs - 1_000).toISOString();
  stamp.preflight.response = advertisement;
  stamp.stamped_at = advertisement.advertised_at;
  return {
    principalId,
    stamp,
    requestBody: {
      ...structuredClone(requestFixture),
      modelId: "m1",
      maxTokens: 16,
      learningTaskStamp: stamp,
    },
  };
}

describe("gateway spine — HTTP integration", () => {
  it("recovers stamped /delegate before quota, busy admission, and a rotated gateway epoch", async () => {
    const owner = mintKey({
      alias: `service-hugin-${randomUUID()}`,
      tier: "owner",
      rpm: 1,
      creditLimit: 1_000_000,
    }, DEFAULTS);
    const { principalId, stamp, requestBody } = await makeStampedDelegateRequest(owner);

    const { taskType: _taskType, ...missingTaskTypeBody } = requestBody;
    const missingTaskType = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(missingTaskTypeBody),
    });
    expect(missingTaskType.status).toBe(400);
    expect(await missingTaskType.json()).toMatchObject({
      error: { code: "invalid_request_error", param: "taskType" },
    });
    expect(upstreamInferenceRequestCount).toBe(0);

    const wrongPrincipalBody = structuredClone(requestBody);
    wrongPrincipalBody.learningTaskStamp.expected_transport_principal_id = "service:not-this-caller";
    const wrongPrincipal = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(wrongPrincipalBody),
    });
    expect(wrongPrincipal.status).toBe(400);
    expect(await wrongPrincipal.json()).toMatchObject({
      error: { code: "invalid_request_error", param: "learningTaskStamp" },
    });
    expect(upstreamInferenceRequestCount).toBe(0);

    const first = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      learningTaskGatewayEcho: Record<string, any>;
    };
    expect(firstBody.learningTaskGatewayEcho).toMatchObject({
      echoed_request: stamp,
      authenticated_principal_id: principalId,
      authentication: "gateway-owner-auth",
      capabilities: stamp.contract_request,
    });
    expect(firstBody.learningTaskGatewayEcho.gateway_request_id).toMatch(/^opaque:[0-9a-f-]{36}$/);
    expect(firstBody.learningTaskGatewayEcho.admission_id).toMatch(/^opaque:[0-9a-f-]{36}$/);
    const callsAfterFirstAdmission = upstreamInferenceRequestCount;
    expect(callsAfterFirstAdmission).toBeGreaterThan(0);

    const replay = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      outcome: "error",
      learningTaskAdmission: {
        recovered: true,
        outcomeAvailable: false,
      },
      learningTaskGatewayEcho: firstBody.learningTaskGatewayEcho,
    });
    expect(upstreamInferenceRequestCount).toBe(callsAfterFirstAdmission);

    const freshIdempotency = structuredClone(requestBody);
    freshIdempotency.learningTaskStamp.idempotency_key = `opaque:${randomUUID()}`;
    freshIdempotency.learningTaskStamp.request_id = `opaque:${randomUUID()}`;
    const naturalReplay = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(freshIdempotency),
    });
    expect(naturalReplay.status).toBe(409);
    expect(upstreamInferenceRequestCount).toBe(callsAfterFirstAdmission);

    const clientSubstitution = structuredClone(freshIdempotency);
    clientSubstitution.learningTaskStamp.client_id = "substituted-client";
    clientSubstitution.learningTaskStamp.idempotency_key = `opaque:${randomUUID()}`;
    clientSubstitution.learningTaskStamp.request_id = `opaque:${randomUUID()}`;
    const substituted = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(clientSubstitution),
    });
    expect(substituted.status).toBe(409);
    expect(upstreamInferenceRequestCount).toBe(callsAfterFirstAdmission);

    const requestReplay = structuredClone(requestBody);
    requestReplay.learningTaskStamp.idempotency_key = `opaque:${randomUUID()}`;
    requestReplay.learningTaskStamp.attempt_id = "attempt-2";
    const repeatedRequest = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestReplay),
    });
    expect(repeatedRequest.status).toBe(409);
    expect(upstreamInferenceRequestCount).toBe(callsAfterFirstAdmission);

    // Recovery must not queue behind or acquire the scarce model slot. Hold that slot with a
    // different authenticated owner, then require the stored response-loss echo immediately.
    // Clear the quota window first so this assertion exercises the busy gate independently.
    resetQuotaWindows();
    mockMode = "stall";
    const holder = mintKey({ alias: `delegate-holder-${randomUUID()}`, tier: "owner" }, DEFAULTS);
    const heldRequest = fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${holder.plaintextKey}` },
      body: JSON.stringify({ prompt: "hold the model slot", taskType: "summarize", modelId: "m1" }),
    });
    for (let attempt = 0; attempt < 20 && releaseStall === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releaseStall).not.toBeNull();

    const busyRecoveryPromise = fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    const busyRecoveryWasImmediate = await Promise.race([
      busyRecoveryPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 150)),
    ]);
    releaseStall?.();
    const [heldResponse, busyRecovery] = await Promise.all([heldRequest, busyRecoveryPromise]);
    mockMode = "ok";
    expect(heldResponse.status).toBe(200);
    expect(busyRecoveryWasImmediate).toBe(true);
    expect(busyRecovery.status).toBe(200);
    expect(await busyRecovery.json()).toMatchObject({
      learningTaskAdmission: { recovered: true, outcomeAvailable: false },
      learningTaskGatewayEcho: firstBody.learningTaskGatewayEcho,
    });

    // Exhaust the non-resetting credit cap after the original execution. Recovery is a durable
    // identity read, not a new paid request, so it must still return the stored echo.
    const creditRecord = lookupKey(owner.plaintextKey)!;
    recordCreditUsage(creditRecord.keyHash, creditRecord.creditLimit);
    const creditRecovery = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(creditRecovery.status).toBe(200);
    expect(await creditRecovery.json()).toMatchObject({
      learningTaskAdmission: { recovered: true, outcomeAvailable: false },
      learningTaskGatewayEcho: firstBody.learningTaskGatewayEcho,
    });
    expect(upstreamInferenceRequestCount).toBe(callsAfterFirstAdmission + 1);

    // A real restart rotates the private capability epoch. That invalidates new sends, but an
    // already-admitted exact retry must still recover its original echo without inference.
    await stopGateway?.();
    const restarted = await startGateway();
    gatewayPort = restarted.port;
    stopGateway = restarted.stop;
    const callsBeforeRestartRecovery = upstreamInferenceRequestCount;
    const restartedRecovery = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(restartedRecovery.status).toBe(200);
    expect(await restartedRecovery.json()).toMatchObject({
      learningTaskAdmission: { recovered: true, outcomeAvailable: false },
      learningTaskGatewayEcho: firstBody.learningTaskGatewayEcho,
    });
    expect(upstreamInferenceRequestCount).toBe(callsBeforeRestartRecovery);

    const changedTask = structuredClone(requestBody);
    changedTask.taskType = "extract";
    const changedTaskResponse = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(changedTask),
    });
    expect(changedTaskResponse.status).toBe(409);

    const changedFingerprint = structuredClone(requestBody);
    changedFingerprint.prompt += " substituted";
    const changedFingerprintResponse = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(changedFingerprint),
    });
    expect(changedFingerprintResponse.status).toBe(409);

    const otherOwner = mintKey({ alias: `delegate-recovery-other-${randomUUID()}`, tier: "owner" }, DEFAULTS);
    const changedPrincipalResponse = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${otherOwner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(changedPrincipalResponse.status).toBe(400);
    expect(upstreamInferenceRequestCount).toBe(callsBeforeRestartRecovery);
  });

  it("preserves stamped /delegate admission when ledger persistence throws after inference", async () => {
    const owner = mintKey({ alias: `service-hugin-post-inference-${randomUUID()}`, tier: "owner" }, DEFAULTS);
    const { requestBody } = await makeStampedDelegateRequest(owner);
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    // Initialize the ledger schema before installing a deterministic post-inference failure.
    recordDelegation({ taskType: "test-setup", modelId: "m1", prompt: "setup", outcome: "unverified" });
    getDb().exec(`
      DROP TRIGGER IF EXISTS test_reject_delegate_ledger;
      CREATE TRIGGER test_reject_delegate_ledger
      BEFORE INSERT ON delegations
      BEGIN
        SELECT RAISE(FAIL, 'forced post-inference ledger failure');
      END;
    `);

    const failed = await (async () => {
      try {
        return await fetch(url("/delegate"), {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
          body: JSON.stringify(requestBody),
        });
      } finally {
        getDb().exec("DROP TRIGGER IF EXISTS test_reject_delegate_ledger");
      }
    })();
    expect(failed.status).toBe(500);
    const callsAfterPostInferenceFailure = upstreamInferenceRequestCount;
    expect(callsAfterPostInferenceFailure).toBe(1);

    const retry = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      outcome: "error",
      learningTaskAdmission: { recovered: true, outcomeAvailable: false },
      learningTaskGatewayEcho: { echoed_request: requestBody.learningTaskStamp },
    });
    expect(upstreamInferenceRequestCount).toBe(callsAfterPostInferenceFailure);
  });

  it("key lifecycle E2E: mint guest → auth ok → revoke → 401", async () => {
    const minted = mintKey({ alias: "e2e-guest", tier: "guest" }, DEFAULTS);
    const ok = await chat(minted.plaintextKey, {});
    expect(ok.status).toBe(200);

    const del = await fetch(url("/admin/keys/e2e-guest"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(del.status).toBe(200);

    const after = await chat(minted.plaintextKey, {});
    expect(after.status).toBe(401);
    const j = (await after.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });

  it("admin can mint a key over HTTP and the plaintext appears only there", async () => {
    const res = await fetch(url("/admin/keys"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({ alias: "http-minted", tier: "guest" }),
    });
    expect(res.status).toBe(201);
    const j = (await res.json()) as { plaintextKey: string; record: Record<string, unknown> };
    expect(j.plaintextKey.startsWith("hs_guest_")).toBe(true);
    expect("keyHash" in j.record).toBe(false);

    const list = await fetch(url("/admin/keys"), { headers: { authorization: `Bearer ${ADMIN}` } });
    const lj = (await list.json()) as { keys: Array<Record<string, unknown>> };
    expect(lj.keys.some((k) => k["alias"] === "http-minted")).toBe(true);
    for (const k of lj.keys) expect("keyHash" in k).toBe(false);
  });

  it("model allow-list: requesting a disallowed model → 403 model_not_allowed param model", async () => {
    const minted = mintKey({ alias: "allow-list", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { model: "m2" });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("model_not_allowed");
    expect(j.error.param).toBe("model");
  });

  it("model allow-list: OMITTING model with a non-empty allow-list → 403 (Fix #2 bypass)", async () => {
    const minted = mintKey({ alias: "allow-list-omit", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    // No model field at all — must NOT silently serve whatever is loaded.
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.plaintextKey}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("model_not_allowed");
    expect(j.error.param).toBe("model");
  });

  it("model allow-list: an empty allow-list (owner) MAY omit the model", async () => {
    const owner = mintKey({ alias: "allow-list-owner-omit", tier: "owner" }, DEFAULTS);
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
  });

  it("quota 429: rpm 1 → 2nd request in-window is rate-limited with headers", async () => {
    const minted = mintKey({ alias: "rl", tier: "guest", rpm: 1, tpm: 1_000_000 }, DEFAULTS);
    const first = await chat(minted.plaintextKey, {});
    expect(first.status).toBe(200);
    const second = await chat(minted.plaintextKey, {});
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    expect(second.headers.get("x-ratelimit-limit")).toBeTruthy();
    const j = (await second.json()) as { error: { code: string } };
    expect(j.error.code).toBe("rate_limit_exceeded");
  });

  it("admission 503: guest is rejected while a slot is held; a queued owner succeeds on release", async () => {
    mockMode = "stall";
    // Owner needs maxParallel >= 2 so a second owner request can queue while the first holds the slot.
    const owner = mintKey({ alias: "adm-owner", tier: "owner", maxParallel: 2 }, DEFAULTS);
    const guest = mintKey({ alias: "adm-guest", tier: "guest" }, DEFAULTS);

    // Owner holds the single slot (request stalls in upstream).
    const heldP = chat(owner.plaintextKey, {});
    // Give it a moment to acquire the slot.
    await new Promise((r) => setTimeout(r, 50));

    // Guest gets an immediate, honest 503.
    const busy = await chat(guest.plaintextKey, {});
    expect(busy.status).toBe(503);
    expect(busy.headers.get("retry-after")).toBeTruthy();
    const bj = (await busy.json()) as { error: { code: string; message: string } };
    expect(bj.error.code).toBe("server_busy");
    expect(bj.error.message).toContain("not a problem with your request");

    // A second owner queues, then completes once the first releases.
    const queuedP = chat(owner.plaintextKey, {});
    await new Promise((r) => setTimeout(r, 50));
    if (releaseStall) releaseStall();
    const held = await heldP;
    expect(held.status).toBe(200);
    // Release the second stall (if it has reached upstream) — drain it.
    await new Promise((r) => setTimeout(r, 50));
    if (releaseStall) releaseStall();
    const queued = await queuedP;
    expect(queued.status).toBe(200);
  });

  it("max_tokens cap: a request above the per-request cap is clamped before proxying", async () => {
    const minted = mintKey({ alias: "cap", tier: "guest" }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { max_tokens: 99999 });
    expect(res.status).toBe(200);
    const sent = JSON.parse(lastUpstreamBody) as { max_tokens?: number };
    expect(sent.max_tokens).toBe(256); // HOMESERVER_PER_REQUEST_MAX_TOKENS
  });

  it("VibeThinker may explicitly use its larger model-specific max_tokens ceiling", async () => {
    const minted = mintKey({ alias: "vibe-cap", tier: "guest" }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { model: "vibethinker-3b", max_tokens: 99999 });
    expect(res.status).toBe(200);
    const sent = JSON.parse(lastUpstreamBody) as { max_tokens?: number };
    expect(sent.max_tokens).toBe(32768);
  });

  it("max_tokens floor: max_tokens 0 → 400 invalid_request_error (Fix #3)", async () => {
    const minted = mintKey({ alias: "mt-zero", tier: "guest" }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { max_tokens: 0 });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; type: string; param: string | null } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.param).toBe("max_tokens");
  });

  it("max_tokens floor: a negative max_tokens → 400 (Fix #3)", async () => {
    const minted = mintKey({ alias: "mt-neg", tier: "guest" }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { max_tokens: -5 });
    expect(res.status).toBe(400);
  });

  it("/delegate is owner-only: a guest key → 403 route_not_allowed (Fix #5)", async () => {
    const guest = mintKey({ alias: "del-guest", tier: "guest" }, DEFAULTS);
    const res = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${guest.plaintextKey}` },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("route_not_allowed");
  });

  it("/delegate is owner-only: an owner key is NOT rejected at the route gate (Fix #5)", async () => {
    const owner = mintKey({ alias: "del-owner", tier: "owner" }, DEFAULTS);
    const res = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({}), // no prompt → handler-level 400, NOT a 403 route refusal
    });
    // The owner passes the route gate; the missing-prompt error is a 400 from the handler,
    // proving the owner reached the handler (not a 403 route refusal).
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(400);
  });

  it("a minted owner can look up chat and direct-delegate exposure without raw task text", async () => {
    const chatOwner = mintKey(
      { alias: "task-exposure-chat-owner", tier: "owner", modelAllowList: ["m1"] },
      DEFAULTS
    );
    // /delegate is intentionally restricted to an unscoped owner key because the orchestrator
    // may select a model after admission; pin m1 in the request so the asserted metadata is stable.
    const owner = mintKey({ alias: "task-exposure-owner", tier: "owner" }, DEFAULTS);
    const chatMarker = "EXPOSURE_CHAT_RAW_MARKER_257";
    const legacyOwnerChatMarker = "EXPOSURE_LEGACY_OWNER_CHAT_MARKER_257";
    const delegateMarker = "EXPOSURE_DELEGATE_RAW_MARKER_257";

    const chatResponse = await chat(chatOwner.plaintextKey, {
      messages: [{ role: "user", content: chatMarker }],
    });
    expect(chatResponse.status).toBe(200);
    const legacyOwnerChatResponse = await chat(ADMIN, {
      messages: [{ role: "user", content: legacyOwnerChatMarker }],
    });
    expect(legacyOwnerChatResponse.status).toBe(200);

    const delegateResponse = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({
        prompt: delegateMarker,
        taskType: "extract",
        modelId: "m1",
        maxTokens: 16,
      }),
    });
    expect(delegateResponse.status).toBe(200);

    const chatHash = taskTextFingerprint(chatMarker).sha256;
    const legacyOwnerChatHash = taskTextFingerprint(legacyOwnerChatMarker).sha256;
    const delegateHash = taskTextFingerprint(delegateMarker).sha256;
    const lookup = await fetch(url("/admin/task-exposures/lookup"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({
        fingerprint_version: taskFingerprintVersion,
        fingerprints: [chatHash, legacyOwnerChatHash, delegateHash],
      }),
    });
    expect(lookup.status).toBe(200);
    expect(lookup.headers.get("cache-control")).toBe("no-store");
    const raw = await lookup.text();
    expect(raw).not.toContain(chatMarker);
    expect(raw).not.toContain(legacyOwnerChatMarker);
    expect(raw).not.toContain(delegateMarker);
    const body = JSON.parse(raw) as {
      coverage: { coverage_complete: boolean; historical_backfill_complete: boolean; incomplete_reasons: string[] };
      results: Array<{ fingerprint_sha256: string; seen: boolean; lanes: string[]; model_ids: string[]; harness_ids: string[] }>;
    };
    expect(body.coverage.coverage_complete).toBe(true);
    expect(body.coverage.historical_backfill_complete).toBe(false);
    expect(body.coverage.incomplete_reasons.length).toBeGreaterThan(0);
    expect(body.results.find((row) => row.fingerprint_sha256 === chatHash)).toMatchObject({
      seen: true,
      lanes: ["chat"],
      model_ids: ["m1"],
      harness_ids: ["openai-chat"],
    });
    expect(body.results.find((row) => row.fingerprint_sha256 === legacyOwnerChatHash)).toMatchObject({
      seen: true,
      lanes: ["chat"],
      // The static principal has no trusted per-key catalogue identity, so exposure is retained
      // without inventing model metadata.
      model_ids: [],
      harness_ids: ["openai-chat"],
    });
    expect(body.results.find((row) => row.fingerprint_sha256 === delegateHash)).toMatchObject({
      seen: true,
      lanes: ["delegate"],
      model_ids: ["m1"],
      harness_ids: ["delegate-local"],
    });
  });

  it("finds a stamped Hugin delegate task by its canonical identity, distinct from its rendered prompt (#4)", async () => {
    const owner = mintKey({ alias: `task-exposure-canonical-${randomUUID()}`, tier: "owner" }, DEFAULTS);
    const { requestBody } = await makeStampedDelegateRequest(owner);
    // Grimnir's vendored bc8cf09 "ASCII trim" vector — the fixture's raw_fingerprint.digest was
    // constructed to equal this exact vector (see tests/fixtures/learning-task-contract/PROVENANCE.md).
    const vectors = JSON.parse(readFileSync(
      new URL("./fixtures/learning-task-contract/raw-fingerprint-vectors.json", import.meta.url),
      "utf8",
    )) as Array<{ name: string; input_text: string; expected_sha256: string }>;
    const asciiVector = vectors.find((v) => v.name === "ASCII trim")!;
    expect(requestBody.learningTaskStamp.raw_fingerprint.digest).toBe(asciiVector.expected_sha256);
    // The rendered prompt actually sent to the model is DIFFERENT bytes from the raw logical task
    // the canonical fingerprint identifies — the whole point of AC1.
    expect(requestBody.prompt).not.toBe(asciiVector.input_text);

    const delegateResponse = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(delegateResponse.status).toBe(200);

    const renderedHash = taskTextFingerprint(requestBody.prompt as string).sha256;
    const lookup = await fetch(url("/admin/task-exposures/lookup"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({
        fingerprint_version: taskFingerprintVersion,
        fingerprints: [renderedHash],
        canonical: [{
          fingerprint_sha256: asciiVector.expected_sha256,
          exact_bytes: {
            encoding: "utf-8",
            byte_length: Buffer.byteLength(asciiVector.input_text, "utf8"),
            text: asciiVector.input_text,
          },
        }],
      }),
    });
    expect(lookup.status).toBe(200);
    const body = await lookup.json() as {
      results: Array<{
        fingerprint_sha256: string;
        identity_kind: string;
        seen: boolean;
        unseen_claim_supported: boolean;
        lanes: string[];
      }>;
    };
    expect(body.results.find((r) => r.fingerprint_sha256 === renderedHash)).toMatchObject({
      identity_kind: "rendered-prompt",
      seen: true,
      lanes: ["delegate"],
    });
    // Found via its CANONICAL identity even though its rendered prompt never appeared in this query.
    expect(body.results.find((r) => r.fingerprint_sha256 === asciiVector.expected_sha256)).toMatchObject({
      identity_kind: "canonical-raw",
      seen: true,
      unseen_claim_supported: true,
      lanes: ["delegate"],
    });
  });

  it("#5: a stamped /delegate call binds a real, reconstructable evidence identity to its ledger row", async () => {
    // Production-wiring regression: gateway.ts's handleDelegate threads the SAME admitted stamp
    // that already drives canonicalTaskFingerprintSha256 into orchestrator.delegate() as
    // learningTaskStamp, which binds DelegationRecord.evidenceIdentity on the real write path
    // (previously nothing populated it at all — PR #28 shipped only the pure derivation + storage).
    const owner = mintKey({ alias: `evidence-identity-http-${randomUUID()}`, tier: "owner" }, DEFAULTS);
    const { requestBody } = await makeStampedDelegateRequest(owner);
    // A never-elsewhere-used-in-this-file taskType (still a valid taxonomy enum member — the stamp
    // schema restricts task_type.id to the fixed taxonomy list). This file's shared real ledger DB
    // accumulates evidence across its many "summarize"/"m1" delegate calls, and enough accrued
    // failures freeze that cell to not_viable, which makes shouldDelegate skip the local attempt
    // entirely (no ledgerId at all). A fresh cell keeps this test's verdict "unknown" (always
    // delegate:true) regardless of what order it runs in relative to its siblings.
    requestBody.taskType = "other";
    requestBody.learningTaskStamp.task_type.id = "other";

    const delegateResponse = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify(requestBody),
    });
    expect(delegateResponse.status).toBe(200);
    const delegateResult = await delegateResponse.json() as { ledgerId?: string };
    expect(delegateResult.ledgerId).toBeDefined();

    const { reconstructEvidenceIdentity } = await import("../src/homeserver/ledger.js");
    const row = getDb()
      .prepare(`SELECT evidence_identity_hash, evidence_lane FROM delegations WHERE id = ?`)
      .get(delegateResult.ledgerId) as { evidence_identity_hash: string | null; evidence_lane: string | null };
    expect(row.evidence_identity_hash).not.toBeNull();
    expect(row.evidence_lane).toBe("delegate");

    const snapshot = reconstructEvidenceIdentity(row.evidence_identity_hash!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.bundle.lane).toBe("delegate");
    // The stamp's own mechanically-bound fields (harness/tool-policy/logical-task/rendered-prompt)
    // are real digests, sourced from the admitted LearningTaskContract stamp (AC2 reconstructability).
    expect(snapshot!.bundle.harness).toMatchObject({ kind: "digest", id: "homeserver-executor" });
    expect(snapshot!.bundle.toolPolicy.kind).toBe("digest");
    expect(snapshot!.bundle.logicalTask.kind).toBe("digest");
    expect(snapshot!.bundle.renderedPrompt.kind).toBe("digest");
    expect(snapshot!.bundle.taxonomyVersion).toMatchObject({ kind: "label" });
    // This mock upstream doesn't emulate llama-swap's /running shape, so the served-model fields
    // honestly disclose "not-observed" rather than fabricating a model/config identity — the exact
    // fail-safe behaviour resolveServedModelIdentity is built for.
    expect(snapshot!.bundle.modelArtifact.kind).toBe("unknown");
    expect(snapshot!.bundle.configEpoch.kind).toBe("unknown");
  });

  it("task exposure lookup denies guest and identity-less static admin keys", async () => {
    const guest = mintKey({ alias: "task-exposure-guest", tier: "guest" }, DEFAULTS);
    const requestBody = JSON.stringify({
      fingerprint_version: taskFingerprintVersion,
      fingerprints: [taskTextFingerprint("unknown").sha256],
    });
    for (const token of [guest.plaintextKey, ADMIN]) {
      const response = await fetch(url("/admin/task-exposures/lookup"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: requestBody,
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("route_not_allowed");
    }
  });

  it("task exposure lookup validates the versioned bounded fingerprint contract", async () => {
    const owner = mintKey({ alias: "task-exposure-validation", tier: "owner" }, DEFAULTS);
    const response = await fetch(url("/admin/task-exposures/lookup"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ fingerprint_version: "sha256-v0", fingerprints: ["A".repeat(64)] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; param: string | null } };
    expect(body.error).toMatchObject({ code: "invalid_request_error", param: "fingerprint_version" });
  });

  it("duplicate alias mint → clean 409, no SQLite string in the body (Fix #10)", async () => {
    const make = () =>
      fetch(url("/admin/keys"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
        body: JSON.stringify({ alias: "dup-alias", tier: "guest" }),
      });
    const first = await make();
    expect(first.status).toBe(201);
    const second = await make();
    expect([400, 409]).toContain(second.status);
    const bodyText = await second.text();
    expect(bodyText).not.toMatch(/UNIQUE constraint/i);
    expect(bodyText).not.toMatch(/api_keys/);
    const j = JSON.parse(bodyText) as { error: { code: string } };
    expect(j.error.code).toBe("alias_exists");
  });

  it("stream:true is piped as text/event-stream, bytes passed through (Fix #4/#6)", async () => {
    mockMode = "sse";
    const minted = mintKey({ alias: "streamer", tier: "guest" }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain('"delta"');
    expect(text).toContain("[DONE]");
  });

  it("legacy static keys still authenticate as guest tier", async () => {
    const res = await chat("legacy-user-key", {});
    expect(res.status).toBe(200);
  });

  it("error envelopes are uniform JSON with the 4-field error object", async () => {
    // 401 path
    const unauth = await chat("nope", {});
    expect(unauth.headers.get("content-type")).toContain("application/json");
    const uj = (await unauth.json()) as { error: Record<string, unknown> };
    for (const f of ["message", "type", "code", "param"]) expect(f in uj.error).toBe(true);
  });

  it("admin endpoints reject a non-admin key", async () => {
    const minted = mintKey({ alias: "not-admin", tier: "guest" }, DEFAULTS);
    const res = await fetch(url("/admin/keys"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.plaintextKey}` },
      body: JSON.stringify({ alias: "x", tier: "guest" }),
    });
    expect(res.status).toBe(403);
  });

  // ─── Fix #1 (HIGH-2) — billing integrity: no successful completion ⇒ no charge ────────
  it("a 500 upstream → 502 sanitized envelope, accrues 0 credits, no body leak (#23)", async () => {
    mockMode = "error500";
    const minted = mintKey({ alias: "bill-500", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);

    const res = await chat(minted.plaintextKey, {});
    // #23: a non-404 upstream error is normalized to a static 502 upstream_unavailable envelope
    // (the upstream status + body are NOT forwarded verbatim — they could leak internal detail).
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("boom"); // the upstream error body is not echoed
    const j = JSON.parse(bodyText) as { error: { code: string } };
    expect(j.error.code).toBe("upstream_unavailable");
    // The upstream body even carried a usage frame; it must NOT be billed on a non-2xx.
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("a non-JSON 2xx body charges only the prompt estimate, never effectiveMax", async () => {
    mockMode = "nonjson";
    const minted = mintKey({ alias: "bill-nonjson", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);

    const res = await chat(minted.plaintextKey, {});
    expect(res.status).toBe(200);
    const used = lookupKey(minted.plaintextKey)!.creditsUsed;
    // Prompt estimate is ceil(bodyLen/4) — small; must be well under the 256-token cap and
    // strictly greater than 0 (a successful 2xx still charges the prompt).
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(256);
  });

  // ─── C2 (CRITICAL) — a failed/timeout upstream is NOT billed at the full estimate ─────
  it("C2: an upstream that resets the connection charges 0 credits (no billing on failure)", async () => {
    mockMode = "reset";
    const minted = mintKey({ alias: "c2-reset", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);

    // The gateway's fetch rejects (connection reset) → the request errors. The reservation must be
    // reconciled to ZERO, NOT charged the full estimate (which would be est = prompt + cap ≈ 256+).
    const res = await chat(minted.plaintextKey, {}).catch(() => null);
    // The gateway returns a 5xx (or the socket closes); either way nothing was completed.
    if (res) expect(res.status).toBeGreaterThanOrEqual(500);
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);
  });

  // ─── M1 — a request rejected at admission must NOT consume the daily budget ───────────
  it("M1: a guest 503'd at admission does not burn its daily token budget", async () => {
    mockMode = "stall";
    // Owner holds the single slot. The guest has a daily budget so that double-charging the
    // rejected request's estimate against the daily counter would block its next (real) call.
    const owner = mintKey({ alias: "m1-owner", tier: "owner", maxParallel: 1 }, DEFAULTS);
    const guest = mintKey({ alias: "m1-guest", tier: "guest", dailyTokenBudget: 400 }, DEFAULTS);

    const heldP = chat(owner.plaintextKey, {});
    await new Promise((r) => setTimeout(r, 50));

    // Guest is rejected with 503 (slot busy). Its reserved estimate must be rolled back.
    const busy = await chat(guest.plaintextKey, {});
    expect(busy.status).toBe(503);

    // Release the owner so the slot frees, then switch the upstream back to normal so the guest's
    // real follow-up actually completes (rather than hitting the still-stalled handler).
    if (releaseStall) releaseStall();
    await heldP;
    await new Promise((r) => setTimeout(r, 30));
    mockMode = "ok";

    // The guest's daily budget (400) must be intact: a fresh real request fits (est ≈ prompt +
    // capped completion). Had the 503 burned its estimate, the daily counter would be polluted.
    const real = await chat(guest.plaintextKey, {});
    expect(real.status).toBe(200);
  });

  // ─── #8 — the OpenAI `n` parameter is clamped to a single completion ──────────────────
  it("#8: a request with n=5 is clamped to n=1 before proxying upstream", async () => {
    const minted = mintKey({ alias: "n-clamp", tier: "guest" }, DEFAULTS);
    const res = await chat(minted.plaintextKey, { n: 5 });
    expect(res.status).toBe(200);
    const sent = JSON.parse(lastUpstreamBody) as { n?: number };
    expect(sent.n).toBe(1);
  });

  // ─── #7 — GET /ledger is admin-gated (no guest data exposure) ─────────────────────────
  it("#7: a guest key gets 403 on GET /ledger", async () => {
    const guest = mintKey({ alias: "ledger-guest", tier: "guest" }, DEFAULTS);
    const res = await fetch(url("/ledger"), { headers: { authorization: `Bearer ${guest.plaintextKey}` } });
    expect(res.status).toBe(403);
    // An admin-gate rejection is a ROUTE-permission failure, not a model-allow-list violation.
    // Mislabelling it `model_not_allowed` (the old behaviour) polluted /metrics + request_log —
    // an internal service hitting /ledger with a non-admin key showed up as hundreds of phantom
    // model-allow-list rejections, masking what was actually an auth-scope misconfiguration.
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("route_not_allowed");
  });

  it("#7: an owner/admin key still gets 200 on GET /ledger", async () => {
    const res = await fetch(url("/ledger"), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
  });

  // ─── #227 — id-addressable ledger reads: join a ledgerId back to its evidence row ─────
  it("#227: GET /ledger recent[] rows carry an id", async () => {
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    recordDelegation({ taskType: "ledger-id-recent-test", modelId: "m1", prompt: "x", outcome: "pass" });
    const res = await fetch(url("/ledger"), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recent: Array<{ id?: string; taskType: string }> };
    const row = body.recent.find((r) => r.taskType === "ledger-id-recent-test");
    expect(row).toBeDefined();
    expect(typeof row!.id).toBe("string");
    expect(row!.id!.length).toBeGreaterThan(0);
  });

  // ─── #233 — verifier-kind + unverifiedShare/formatOnlyShare, additive on GET /ledger ──
  it("#233: GET /ledger report[] rows carry unverifiedShare/formatOnlyShare and recent[] rows carry verifierKind, additively", async () => {
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    const taskType = "ledger-233-report-test";
    const modelId = "m233";
    recordDelegation({ taskType, modelId, prompt: "a", outcome: "unverified" });
    recordDelegation({ taskType, modelId, prompt: "b", outcome: "pass", verifier: "jsonValid" });
    recordDelegation({ taskType, modelId, prompt: "c", outcome: "pass", verifier: "sqlExec" });

    const res = await fetch(url("/ledger"), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      report: Array<{
        taskType: string;
        modelId: string;
        verdict: string;
        attempts: number;
        unverifiedShare: number;
        formatOnlyShare: number;
      }>;
      recent: Array<{ taskType: string; verifier: string | null; verifierKind: string }>;
    };

    // Existing fields on report rows are still present — additive, never replaced.
    const row = body.report.find((r) => r.taskType === taskType && r.modelId === modelId);
    expect(row).toBeDefined();
    expect(typeof row!.verdict).toBe("string");
    expect(row!.attempts).toBe(2); // the unverified row is excluded from verdict-relevant attempts
    expect(row!.unverifiedShare).toBeCloseTo(1 / 3, 5);
    expect(row!.formatOnlyShare).toBeCloseTo(0.5, 5); // 1 mechanical-format (jsonValid) / 2 attempts

    const recentRow = body.recent.find((r) => r.taskType === taskType && r.verifier === "sqlExec");
    expect(recentRow).toBeDefined();
    expect(recentRow!.verifierKind).toBe("truth-oriented");
  });

  it("#234: GET /ledger excludes shadow evidence by default and includes it only on explicit opt-in", async () => {
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    const taskType = "ledger-234-shadow-test";
    const modelId = "shadow-candidate";
    recordDelegation({
      taskType,
      modelId,
      prompt: "x",
      outcome: "pass",
      verifier: "shadow-vs-frontier",
      shadow: true,
      source: "shadow",
    });

    const normal = await fetch(url("/ledger"), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(normal.status).toBe(200);
    const normalBody = (await normal.json()) as {
      report: Array<{ taskType: string }>;
      recent: Array<{ taskType: string; shadow: boolean }>;
      includeShadow: boolean;
    };
    expect(normalBody.includeShadow).toBe(false);
    expect(normalBody.report.some((r) => r.taskType === taskType)).toBe(false);
    expect(normalBody.recent.find((r) => r.taskType === taskType)?.shadow).toBe(true);

    const optedIn = await fetch(url("/ledger?includeShadow=1"), {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(optedIn.status).toBe(200);
    const optedInBody = (await optedIn.json()) as {
      report: Array<{ taskType: string; attempts: number }>;
      includeShadow: boolean;
    };
    expect(optedInBody.includeShadow).toBe(true);
    expect(optedInBody.report.find((r) => r.taskType === taskType)?.attempts).toBe(1);
  });

  it("#227: GET /ledger/:id returns the exact evidence row for a ledgerId (owner/admin)", async () => {
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    const id = recordDelegation({
      taskType: "ledger-id-get-test",
      modelId: "m1",
      prompt: "x",
      outcome: "fail",
      verifier: "tsGate",
    });
    const res = await fetch(url(`/ledger/${id}`), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; taskType: string; modelId: string; outcome: string; verifier: string | null };
    expect(body.id).toBe(id);
    expect(body.taskType).toBe("ledger-id-get-test");
    expect(body.modelId).toBe("m1");
    expect(body.outcome).toBe("fail");
    expect(body.verifier).toBe("tsGate");
  });

  it("#227: GET /ledger/:id 404s on an unknown id", async () => {
    const res = await fetch(url("/ledger/no-such-ledger-id"), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("not_found");
  });

  it("#227: GET /ledger/:id is admin-gated, same as GET /ledger (guest → 403)", async () => {
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    const id = recordDelegation({ taskType: "ledger-id-auth-test", modelId: "m1", prompt: "x", outcome: "pass" });
    const guest = mintKey({ alias: "ledger-id-guest", tier: "guest" }, DEFAULTS);
    const res = await fetch(url(`/ledger/${id}`), { headers: { authorization: `Bearer ${guest.plaintextKey}` } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("route_not_allowed");
  });

  // ─── #229 — malformed percent-encoding on decoded path segments must 400, not 500 ─────
  it("#229: GET /ledger/% (malformed percent-encoding) → 400 invalid_request_error, not 500", async () => {
    const res = await fetch(url("/ledger/%"), { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_request_error");
  });

  it("#229: DELETE /admin/keys/% (malformed percent-encoding) → 400 invalid_request_error, not 500", async () => {
    const res = await fetch(url("/admin/keys/%"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_request_error");
  });

  // ─── #15 — All error paths must return the OpenAI-shaped envelope ────────────────────

  it("#15: invalid JSON body for /v1/chat/completions → 400 envelope, not 500", async () => {
    const minted = mintKey({ alias: "bad-json-chat", tier: "guest" }, DEFAULTS);
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.plaintextKey}` },
      body: "this is not valid json{{",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { message: string; type: string; code: string; param: unknown } };
    // Must carry all four envelope fields — not a bare { error: "string" }.
    for (const f of ["message", "type", "code", "param"]) expect(f in j.error).toBe(true);
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("#15: invalid JSON body for /delegate → 400 envelope, not 500", async () => {
    const owner = mintKey({ alias: "bad-json-delegate", tier: "owner" }, DEFAULTS);
    const res = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: "{broken json",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { message: string; type: string; code: string; param: unknown } };
    for (const f of ["message", "type", "code", "param"]) expect(f in j.error).toBe(true);
    expect(j.error.code).toBe("invalid_request_error");
  });

  it("#15: missing 'prompt' on /delegate → 400 envelope with param:prompt", async () => {
    const owner = mintKey({ alias: "no-prompt-del", tier: "owner" }, DEFAULTS);
    const res = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ taskType: "summarize" }), // valid JSON, but no prompt field
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("prompt");
  });

  it("/delegate rejects malformed sampler controls before admission", async () => {
    const owner = mintKey({ alias: "bad-sampler-delegate", tier: "owner" }, DEFAULTS);
    const res = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ prompt: "hi", topK: 1.5 }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { param: string | null } };
    expect(j.error.param).toBe("topK");
  });

  it("#15: missing 'modelKey' on /admin/models/load → 400 envelope with param:modelKey", async () => {
    const res = await fetch(url("/admin/models/load"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({}), // no modelKey
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("modelKey");
  });

  it("#15: missing 'modelKey' on /admin/models/download → 400 envelope with param:modelKey", async () => {
    const res = await fetch(url("/admin/models/download"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
      body: JSON.stringify({}), // no modelKey
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string | null } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("modelKey");
  });

  it("#15: unknown route → 404 not_found envelope (not a bare { error: string })", async () => {
    const minted = mintKey({ alias: "unknown-route", tier: "guest" }, DEFAULTS);
    const res = await fetch(url("/no/such/route/exists"), {
      headers: { authorization: `Bearer ${minted.plaintextKey}` },
    });
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: { message: string; type: string; code: string; param: unknown } };
    for (const f of ["message", "type", "code", "param"]) expect(f in j.error).toBe(true);
    expect(j.error.code).toBe("not_found");
    expect(j.error.type).toBe("invalid_request_error");
    // Message must name the route — not a bare string.
    expect(typeof j.error.message).toBe("string");
    expect((j.error.message as string).length).toBeGreaterThan(0);
  });

  // ─── #23 streaming path — non-404 upstream error → static envelope, no body leak ─────

  it("#23: streaming path: non-404 upstream error → 502 upstream_unavailable envelope, no body leak", async () => {
    mockMode = "error500";
    const minted = mintKey({ alias: "stream-500", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);

    // Explicitly request stream:true — this exercises the streaming-path non-404 guard (#23).
    const res = await chat(minted.plaintextKey, { stream: true });

    // The gateway must normalize the upstream 500 to a 502 upstream_unavailable envelope —
    // NOT forward the upstream status + body verbatim (which would leak internal detail).
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).not.toContain("boom"); // upstream error body must not be echoed
    const j = JSON.parse(bodyText) as { error: { code: string; type: string } };
    for (const f of ["message", "type", "code", "param"]) expect(f in j.error).toBe(true);
    expect(j.error.code).toBe("upstream_unavailable");
    expect(j.error.type).toBe("server_error");

    // Billing invariant: a failed upstream call (no successful completion) must charge 0.
    expect(lookupKey(minted.plaintextKey)!.creditsUsed).toBe(0);
  });
});
