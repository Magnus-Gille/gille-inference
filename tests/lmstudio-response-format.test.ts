/**
 * Issue #166 — runLmStudioInference forwards the structured-output `response_format` to the
 * llama.cpp OpenAI endpoint (the mechanical enabler for grammar-constrained decoding).
 *
 * The OpenAI SDK is mocked so we can assert the exact params handed to chat.completions.create:
 *   - when opts.responseFormat is set → it appears as `response_format` on the create call;
 *   - when it is absent → NO `response_format` key is sent (unconstrained decoding is preserved).
 * Written BEFORE the implementation (red→green).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** A minimal OpenAI-streaming async-iterable: one content chunk + a usage chunk. */
function makeStream(text: string) {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } };
  })();
}

beforeEach(() => {
  vi.resetModules();
});

async function runWith(opts: Record<string, unknown>) {
  const createMock = vi.fn().mockResolvedValue(makeStream("hello"));
  vi.doMock("openai", () => ({
    default: vi.fn().mockImplementation(() => ({
      chat: { completions: { create: createMock } },
    })),
  }));
  const { runLmStudioInference } = await import("../src/runner/lmstudio-client.js");
  const res = await runLmStudioInference("gpt-oss-120b", "triage this", opts);
  const params = createMock.mock.calls[0]![0] as Record<string, unknown>;
  return { res, params, createMock };
}

describe("runLmStudioInference — response_format forwarding (#166)", () => {
  it("forwards an explicit sampler profile including min_p=0", async () => {
    const { params } = await runWith({ temperature: 1, topP: 0.95, topK: 0, minP: 0 });
    expect(params).toMatchObject({ temperature: 1, top_p: 0.95, top_k: 0, min_p: 0 });
  });

  it("forwards a json_object response_format to the create call", async () => {
    const { res, params } = await runWith({ responseFormat: { type: "json_object" } });
    expect(res.ok).toBe(true);
    expect(params["response_format"]).toEqual({ type: "json_object" });
  });

  it("forwards a full json_schema response_format verbatim", async () => {
    const schema = {
      type: "json_schema",
      json_schema: { name: "verdict", schema: { type: "object" }, strict: true },
    };
    const { params } = await runWith({ responseFormat: schema });
    expect(params["response_format"]).toEqual(schema);
  });

  it("sends NO response_format key when the option is absent", async () => {
    const { res, params } = await runWith({});
    expect(res.ok).toBe(true);
    expect(params).not.toHaveProperty("response_format");
  });
});
