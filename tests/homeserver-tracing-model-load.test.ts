import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let loadModel: typeof import("../src/homeserver/llamaswap-admin.js").loadModel;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;
let runWithSyntheticTraceForTests: typeof import("../src/homeserver/tracing.js").runWithSyntheticTraceForTests;
let flushTracingForTests: typeof import("../src/homeserver/tracing.js").flushTracingForTests;
let setTracingTestHooks: typeof import("../src/homeserver/tracing.js").setTracingTestHooks;
let resetTracingTestHooks: typeof import("../src/homeserver/tracing.js").resetTracingTestHooks;

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
});
