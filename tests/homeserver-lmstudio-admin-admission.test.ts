import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HostMemoryAdmissionError } from "../src/homeserver/host-memory-admission.js";

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock, spawn: spawnMock }));

let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let lmstudio: typeof import("../src/homeserver/lmstudio-admin.js");
const originalFetch = globalThis.fetch;

function refusal(): HostMemoryAdmissionError {
  return new HostMemoryAdmissionError({
    code: "insufficient_memory",
    message: "blocked by test admission",
    retryAfterSeconds: 9,
    reason: "insufficient_memory",
  });
}

function modelsResponse(contextLength: number | null): Response {
  return new Response(
    JSON.stringify({
      models: [
        {
          type: "llm",
          key: "llama3.2:8b",
          display_name: "llama3.2:8b",
          loaded_instances:
            contextLength === null ? [] : [{ id: "instance-1", config: { context_length: contextLength } }],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeAll(async () => {
  const config = await import("../src/homeserver/config.js");
  setConfig = config.setConfig;
  lmstudio = await import("../src/homeserver/lmstudio-admin.js");
  setConfig({ backend: "lmstudio", lmStudioRestUrl: "http://127.0.0.1:1/api/v1" });
});

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation((_file: string, _args: string[], _options: unknown, callback: Function) => {
    callback(null, { stdout: "loaded successfully in 1s", stderr: "" });
  });
  globalThis.fetch = vi.fn(async () => modelsResponse(null));
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("LM Studio model-start admission", () => {
  it("propagates typed refusal before lms load executes", async () => {
    const error = refusal();

    await expect(
      lmstudio.loadModel("llama3.2:8b", {
        beforeModelStart: async (_model, options) => {
          expect(options).toEqual({ forceStart: true });
          throw error;
        },
      }),
    ).rejects.toBe(error);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("refuses an insufficient-context reload before unloading the current instance", async () => {
    globalThis.fetch = vi.fn(async () => modelsResponse(4096));
    const error = refusal();
    const hook = vi.fn(async () => {
      throw error;
    });

    await expect(lmstudio.ensureLoaded("llama3.2:8b", 32768, { beforeModelStart: hook })).rejects.toBe(error);
    expect(hook).toHaveBeenCalledWith("llama3.2:8b", { forceStart: true });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps a sufficient loaded context as a hook-free no-op", async () => {
    globalThis.fetch = vi.fn(async () => modelsResponse(32768));
    const hook = vi.fn(async () => undefined);

    const result = await lmstudio.ensureLoaded("llama3.2:8b", 32768, { beforeModelStart: hook });
    expect(result.message).toContain("already loaded");
    expect(hook).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("preserves the legacy direct load seam when no hook is supplied", async () => {
    const result = await lmstudio.loadModel("llama3.2:8b");
    expect(result.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledOnce();
  });
});
