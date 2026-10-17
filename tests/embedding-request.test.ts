import { describe, expect, it } from "vitest";
import {
  EMBEDDING_MODEL_ID,
  EmbeddingRequestError,
  EmbeddingResponseError,
  embeddingTokenReservation,
  isEmbeddingModel,
  parseEmbeddingBody,
  validateAndShapeEmbeddingResponse,
} from "../src/homeserver/embedding-request.js";

function request(input: unknown, extra: Record<string, unknown> = {}) {
  return parseEmbeddingBody(JSON.stringify({ model: EMBEDDING_MODEL_ID, input, ...extra }));
}

function wavSample(): string {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(2, 40);
  return bytes.toString("base64");
}

function upstreamResponse(requested: ReturnType<typeof request>, data = requested.input instanceof Array
  ? requested.input.map((_, index) => ({ object: "embedding", index, embedding: Array(768).fill(1) }))
  : [{ object: "embedding", index: 0, embedding: Array(768).fill(1) }]) {
  return {
    object: "list",
    model: EMBEDDING_MODEL_ID,
    data,
    usage: { prompt_tokens: 7 },
  };
}

describe("embedding request contract", () => {
  it("accepts one string and builds a float-only upstream body", () => {
    const parsed = request("hello", { dimensions: 256, user: "sdk-user" });
    expect(parsed).toMatchObject({
      model: EMBEDDING_MODEL_ID,
      input: "hello",
      user: "sdk-user",
      encodingFormat: "float",
      dimensions: 256,
      upstreamBody: { model: EMBEDDING_MODEL_ID, input: "hello", encoding_format: "float" },
    });
    expect(parsed.upstreamBody).not.toHaveProperty("dimensions");
    expect(parsed.upstreamBody).not.toHaveProperty("user");
  });

  it("accepts 1 to 16 text inputs and reserves a conservative byte-based token bound", () => {
    const parsed = request(["a", "bc"]);
    expect(parsed.input).toEqual(["a", "bc"]);
    expect(embeddingTokenReservation(parsed)).toBe(131);
    expect(embeddingTokenReservation(request("a".repeat(4_001)))).toBe(4_065);
  });

  it("gates and meters a bounded typed audio input without forwarding SDK-only fields", () => {
    const input = [{ content: [{ type: "input_audio", input_audio: { data: wavSample(), format: "wav" } }] }];
    const raw = JSON.stringify({ model: EMBEDDING_MODEL_ID, input, user: "private-user", dimensions: 256 });
    expect(() => parseEmbeddingBody(raw)).toThrow(EmbeddingRequestError);
    const parsed = parseEmbeddingBody(raw, true);
    expect(parsed.hasMedia).toBe(true);
    expect(parsed.upstreamBody.input).toEqual([{ content: [{
      type: "input_audio", input_audio: { data: wavSample() },
    }] }]);
    expect(parsed.upstreamBody).not.toHaveProperty("user");
    expect(parsed.upstreamBody).not.toHaveProperty("dimensions");
    expect(embeddingTokenReservation(parsed)).toBe(8192);
  });

  it.each([
    ["wrong model", { model: "other", input: "safe" }],
    ["empty body", {}],
    ["empty input", { model: EMBEDDING_MODEL_ID, input: "" }],
    ["multimedia input", { model: EMBEDDING_MODEL_ID, input: [{ type: "text", text: "safe" }] }],
    ["too many inputs", { model: EMBEDDING_MODEL_ID, input: Array(17).fill("x") }],
    ["invalid dimensions", { model: EMBEDDING_MODEL_ID, input: "safe", dimensions: 129 }],
    ["invalid encoding", { model: EMBEDDING_MODEL_ID, input: "safe", encoding_format: "binary" }],
    ["invalid user type", { model: EMBEDDING_MODEL_ID, input: "safe", user: 42 }],
    ["empty user", { model: EMBEDDING_MODEL_ID, input: "safe", user: "" }],
    ["long user", { model: EMBEDDING_MODEL_ID, input: "safe", user: "x".repeat(257) }],
    ["unknown field", { model: EMBEDDING_MODEL_ID, input: "safe", temperature: 0 }],
  ])("rejects %s without exposing input text", (_name, body) => {
    const serialized = JSON.stringify(body);
    expect(() => parseEmbeddingBody(serialized)).toThrow(EmbeddingRequestError);
    try {
      parseEmbeddingBody(serialized);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("safe");
    }
  });

  it("rejects raw JSON above 32 KiB and text above per-item or total limits", () => {
    expect(() => parseEmbeddingBody(JSON.stringify({ model: EMBEDDING_MODEL_ID, input: "x".repeat(40_000) })))
      .toThrow(EmbeddingRequestError);
    expect(() => request("x".repeat(16_385))).toThrow(EmbeddingRequestError);
    // Three individually valid strings can still exceed the aggregate input cap (the raw-body
    // cap is checked first for this large JSON representation).
    expect(() => request(["x".repeat(11_000), "y".repeat(11_000), "z".repeat(11_000)])).toThrow(EmbeddingRequestError);
  });
});

describe("embedding upstream response validation", () => {
  it("normalizes a requested prefix and returns OpenAI usage shape", () => {
    const parsed = request("hello", { dimensions: 128 });
    const vector = Array(768).fill(0);
    vector[0] = 3;
    vector[1] = 4;
    const result = validateAndShapeEmbeddingResponse({
      ...upstreamResponse(parsed),
      data: [{ object: "embedding", index: 0, embedding: vector }],
    }, parsed);
    expect(result.inputTokens).toBe(7);
    expect(result.body.model).toBe(EMBEDDING_MODEL_ID);
    expect(result.body.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
    expect(result.body.data[0]?.embedding).toHaveLength(128);
    expect(result.body.data[0]?.embedding.slice(0, 2)).toEqual([0.6, 0.8]);
  });

  it("normalizes the full 768-vector response when dimensions are omitted", () => {
    const parsed = request("hello");
    const vector = Array(768).fill(0);
    vector[0] = 3;
    vector[1] = 4;
    const result = validateAndShapeEmbeddingResponse({
      ...upstreamResponse(parsed),
      data: [{ object: "embedding", index: 0, embedding: vector }],
    }, parsed);
    expect(result.body.data[0]?.embedding).toHaveLength(768);
    expect(result.body.data[0]?.embedding.slice(0, 2)).toEqual([0.6, 0.8]);
  });

  it("encodes the normalized, truncated vector as little-endian Float32 base64", () => {
    const parsed = request("hello", { dimensions: 128, encoding_format: "base64" });
    const vector = Array(768).fill(0);
    vector[0] = 3;
    vector[1] = 4;
    const result = validateAndShapeEmbeddingResponse({
      ...upstreamResponse(parsed),
      data: [{ object: "embedding", index: 0, embedding: vector }],
    }, parsed);
    const encoded = result.body.data[0]?.embedding;
    expect(typeof encoded).toBe("string");
    const bytes = Buffer.from(encoded as string, "base64");
    expect(bytes).toHaveLength(128 * Float32Array.BYTES_PER_ELEMENT);
    const decoded = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(decoded.getFloat32(0, true)).toBeCloseTo(0.6);
    expect(decoded.getFloat32(4, true)).toBeCloseTo(0.8);
    expect(decoded.getFloat32(8, true)).toBe(0);
  });

  it.each([
    ["malformed vector", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), data: [{ object: "embedding", index: 0, embedding: [1] }] })],
    ["NaN vector", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), data: [{ object: "embedding", index: 0, embedding: Object.assign(Array(768).fill(1), { 0: Number.NaN }) }] })],
    ["wrong count", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), data: [] })],
    ["wrong index", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), data: [{ object: "embedding", index: 1, embedding: Array(768).fill(1) }] })],
    ["wrong model", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), model: "other" })],
    ["invalid usage", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), usage: { prompt_tokens: 0 } })],
    ["usage exceeds reservation", (parsed: ReturnType<typeof request>) => ({ ...upstreamResponse(parsed), usage: { prompt_tokens: 70 } })],
  ])("rejects %s", (_name, makePayload) => {
    const parsed = request("safe");
    expect(() => validateAndShapeEmbeddingResponse(makePayload(parsed), parsed)).toThrow(EmbeddingResponseError);
  });

  it("requires an object list envelope and rejects a zero prefix norm", () => {
    const parsed = request("safe", { dimensions: 128 });
    expect(() => validateAndShapeEmbeddingResponse({ data: [], model: EMBEDDING_MODEL_ID, usage: { prompt_tokens: 1 } }, parsed))
      .toThrow(EmbeddingResponseError);
    expect(() => validateAndShapeEmbeddingResponse({
      ...upstreamResponse(parsed),
      data: [{ object: "embedding", index: 0, embedding: Array(768).fill(0) }],
    }, parsed)).toThrow(EmbeddingResponseError);
  });
});

describe("embedding model identity", () => {
  it("accepts only the exact advertised model", () => {
    expect(isEmbeddingModel(EMBEDDING_MODEL_ID)).toBe(true);
    expect(isEmbeddingModel("embeddinggemma-2-preview")).toBe(false);
  });
});
