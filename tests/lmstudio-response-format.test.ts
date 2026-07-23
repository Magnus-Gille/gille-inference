/**
 * Issues #166 and #60 — runLmStudioInference forwards structured-output controls and preserves
 * terminal completion semantics from the llama.cpp OpenAI endpoint.
 *
 * The OpenAI SDK is mocked so we can assert the exact params handed to chat.completions.create:
 *   - when opts.responseFormat is set → it appears as `response_format` on the create call;
 *   - when it is absent → NO `response_format` key is sent (unconstrained decoding is preserved).
 * Written BEFORE the implementation (red→green).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** A minimal OpenAI-streaming async-iterable: one content chunk + a terminal usage chunk. */
function makeStream(text: string, finishReason: string | null = "stop", completionTokens = 3) {
  return (async function* () {
    yield { choices: [{ delta: { content: text } }] };
    yield {
      choices: [{ delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 5, completion_tokens: completionTokens },
    };
  })();
}

beforeEach(() => {
  vi.resetModules();
});

async function runWith(
  opts: Record<string, unknown>,
  stream: AsyncIterable<unknown> = makeStream("hello")
) {
  const createMock = vi.fn().mockResolvedValue(stream);
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

  it.each([
    ["empty", ""],
    ["partial", "F-2"],
  ])(
    "fails closed on a token-limit finish instead of accepting %s content",
    async (_label, content) => {
      const { res } = await runWith({}, makeStream(content, "length", 64));

      expect(res).toMatchObject({
        ok: false,
        finishReason: "length",
        truncated: true,
        promptTokens: 5,
        completionTokens: 64,
      });
      if (!res.ok) {
        expect(res.error).toContain("finish_reason=length");
        expect(res.error).toContain(`visible_content_chars=${content.length}`);
      }
    }
  );

  it("keeps a complete stop response successful and exposes its finish reason", async () => {
    const { res } = await runWith({}, makeStream("complete", "stop", 7));

    expect(res).toMatchObject({
      ok: true,
      response: "complete",
      finishReason: "stop",
      truncated: false,
      completionTokens: 7,
    });
  });
});
