import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let loadModel: typeof import("../src/homeserver/llamaswap-admin.js").loadModel;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let runWithSyntheticTraceForTests: typeof import("../src/homeserver/tracing.js").runWithSyntheticTraceForTests;
let flushTracingForTests: typeof import("../src/homeserver/tracing.js").flushTracingForTests;
let setTracingTestHooks: typeof import("../src/homeserver/tracing.js").setTracingTestHooks;
let resetTracingTestHooks: typeof import("../src/homeserver/tracing.js").resetTracingTestHooks;

const HOSTILE_MODEL_KEY = "SECRET_TOKEN_ABC";
const EXPECTED_TRACE_ID = "sha256:8c8cc79f473bb3a1757aff8e77c59b4bc3ec807be4be39ed5ae47c2e7f3acedb";

interface TraceRecordLike {
  kind?: string;
  phase?: string;
  slot_id?: string;
  outcome?: string;
  model_artifact_identity?: string;
}

function traceRecord(record: unknown): TraceRecordLike {
  return record as TraceRecordLike;
}

function expectSafeModelTrace(records: readonly unknown[], spanOutcome: string, readinessOutcome: string): void {
  const joined = JSON.stringify(records);
  expect(joined).not.toContain(HOSTILE_MODEL_KEY);

  const modelLoad = records
    .map(traceRecord)
    .find((record) => record.kind === "trace-span" && record.phase === "model_load");
  expect(modelLoad).toMatchObject({
    outcome: spanOutcome,
    model_artifact_identity: EXPECTED_TRACE_ID,
  });

  const readiness = records
    .map(traceRecord)
    .find((record) => record.kind === "service-observation" && record.slot_id === "model-ready");
  expect(readiness).toMatchObject({
    outcome: readinessOutcome,
    model_artifact_identity: EXPECTED_TRACE_ID,
  });

  const identities = records
    .map(traceRecord)
    .map((record) => record.model_artifact_identity)
    .filter((identity): identity is string => typeof identity === "string");
  expect(identities).toEqual(expect.arrayContaining([EXPECTED_TRACE_ID]));
  expect(identities.every((identity) => /^sha256:[a-f0-9]{64}$/.test(identity))).toBe(true);
}

beforeEach(async () => {
  loadModel = (await import("../src/homeserver/llamaswap-admin.js")).loadModel;
  const cfg = await import("../src/homeserver/config.js");
  const tracing = await import("../src/homeserver/tracing.js");
  resetConfig = cfg.resetConfig;
  runWithSyntheticTraceForTests = tracing.runWithSyntheticTraceForTests;
  flushTracingForTests = tracing.flushTracingForTests;
  setTracingTestHooks = tracing.setTracingTestHooks;
  resetTracingTestHooks = tracing.resetTracingTestHooks;
  resetConfig();
  resetTracingTestHooks();
  process.env["LMSTUDIO_BASE_URL"] = "http://llamaswap.test/v1";
});

afterEach(() => {
  resetTracingTestHooks();
  vi.restoreAllMocks();
  delete process.env["LMSTUDIO_BASE_URL"];
});

describe("model-load tracing", () => {
  it("emits model-load failure and readiness records without exposing upstream detail", async () => {
    setTracingTestHooks({ captureExports: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/running")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ running: [] }),
          } as Response;
        }
        if (url.endsWith("/v1/chat/completions")) {
          return {
            ok: false,
            status: 503,
            text: async () => "http://private-upstream.example/internal failure SECRET",
          } as Response;
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const result = await runWithSyntheticTraceForTests(
      {
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
        taskType: "delegation",
        lane: "default",
        exportEnabled: true,
      },
      async () => loadModel("m1"),
      { outcome: "error", errorClass: "upstream_unavailable" },
    );

    expect(result.ok).toBe(false);
    const records = await flushTracingForTests();
    const modelLoad = records.find((record) =>
      (record as { kind?: string; phase?: string }).kind === "trace-span"
      && (record as { phase?: string }).phase === "model_load"
    ) as { outcome?: string; error_class?: string } | undefined;
    const joined = JSON.stringify(records);
    expect(modelLoad).toMatchObject({ outcome: "error", error_class: "upstream_unavailable" });
    expect(joined).toContain("model_load");
    expect(joined).toContain("model-ready");
    expect(joined).toContain("failed");
    expect(joined).not.toContain("private-upstream.example");
    expect(joined).not.toContain("SECRET");
  });

  it("hashes a hostile key on the already-loaded success path", async () => {
    setTracingTestHooks({ captureExports: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/running")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ running: [{ model: HOSTILE_MODEL_KEY, state: "ready" }] }),
          } as Response;
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const result = await runWithSyntheticTraceForTests(
      { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01", exportEnabled: true },
      async () => loadModel(HOSTILE_MODEL_KEY),
    );

    expect(result).toMatchObject({ ok: true, modelKey: HOSTILE_MODEL_KEY, identifier: HOSTILE_MODEL_KEY });
    expect(result.message).toBe("already loaded");
    expectSafeModelTrace(await flushTracingForTests(), "ok", "ok");
  });

  it("hashes a hostile key on warm-up success while preserving routing and the response", async () => {
    setTracingTestHooks({ captureExports: true });
    let chatBody: { model?: string } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/running")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ running: [] }),
          } as Response;
        }
        if (url.endsWith("/v1/chat/completions")) {
          chatBody = JSON.parse(String(init?.body)) as { model?: string };
          return { ok: true, status: 200 } as Response;
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const result = await runWithSyntheticTraceForTests(
      { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01", exportEnabled: true },
      async () => loadModel(HOSTILE_MODEL_KEY),
    );

    expect(chatBody).toMatchObject({ model: HOSTILE_MODEL_KEY });
    expect(result).toMatchObject({ ok: true, modelKey: HOSTILE_MODEL_KEY, identifier: HOSTILE_MODEL_KEY });
    expect(result.message).toBe("loaded");
    expectSafeModelTrace(await flushTracingForTests(), "ok", "ok");
  });

  it("hashes a hostile key on the upstream-error path while preserving the API error response", async () => {
    setTracingTestHooks({ captureExports: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/running")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ running: [] }),
          } as Response;
        }
        if (url.endsWith("/v1/chat/completions")) {
          return {
            ok: false,
            status: 503,
            text: async () => `backend rejected ${HOSTILE_MODEL_KEY}`,
          } as Response;
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const result = await runWithSyntheticTraceForTests(
      { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01", exportEnabled: true },
      async () => loadModel(HOSTILE_MODEL_KEY),
    );

    expect(result).toMatchObject({
      ok: false,
      modelKey: HOSTILE_MODEL_KEY,
      identifier: HOSTILE_MODEL_KEY,
      message: `backend rejected ${HOSTILE_MODEL_KEY}`,
    });
    expectSafeModelTrace(await flushTracingForTests(), "error", "failed");
  });

  it("hashes a hostile key on the caught-exception path while keeping the exception response unchanged", async () => {
    setTracingTestHooks({ captureExports: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/running")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ running: [] }),
          } as Response;
        }
        if (url.endsWith("/v1/chat/completions")) {
          throw new Error(`socket failed for ${HOSTILE_MODEL_KEY}`);
        }
        throw new Error(`unexpected url ${url}`);
      }),
    );

    const result = await runWithSyntheticTraceForTests(
      { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01", exportEnabled: true },
      async () => loadModel(HOSTILE_MODEL_KEY),
    );

    expect(result).toMatchObject({
      ok: false,
      modelKey: HOSTILE_MODEL_KEY,
      identifier: HOSTILE_MODEL_KEY,
      message: `socket failed for ${HOSTILE_MODEL_KEY}`,
    });
    expectSafeModelTrace(await flushTracingForTests(), "error", "failed");
  });
});
