/** Pure request and upstream-response validation for POST /v1/embeddings. */

export const EMBEDDING_MODEL_ID = "embeddinggemma-2" as const;

const MAX_RAW_JSON_BYTES = 32 * 1024;
const MAX_INPUT_ITEMS = 16;
const MAX_ITEM_CHARS = 16 * 1024;
const MAX_TOTAL_CHARS = 32 * 1024;
const EMBEDDING_SIZE = 768;

export type EmbeddingDimension = 128 | 256 | 512 | 768;
export type EmbeddingInput = string | string[];

export interface EmbeddingUpstreamBody {
  model: typeof EMBEDDING_MODEL_ID;
  input: EmbeddingInput;
  encoding_format: "float";
}

export interface EmbeddingRequest {
  model: typeof EMBEDDING_MODEL_ID;
  input: EmbeddingInput;
  dimensions: EmbeddingDimension | undefined;
  upstreamBody: EmbeddingUpstreamBody;
}

export class EmbeddingRequestError extends Error {
  constructor(readonly param: string, message: string) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

export class EmbeddingResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingResponseError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function charCount(value: string): number {
  // Array.from counts Unicode code points, which is the useful interpretation of a character
  // limit for a JSON text API (and avoids splitting a surrogate pair in the accounting).
  return Array.from(value).length;
}

function requestError(param: string, message: string): never {
  throw new EmbeddingRequestError(param, message);
}

export function isEmbeddingModel(id: string): boolean {
  return id === EMBEDDING_MODEL_ID;
}

/** Parse and validate a raw JSON body without retaining prompt text in errors. */
export function parseEmbeddingBody(raw: string): EmbeddingRequest {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_RAW_JSON_BYTES) {
    requestError("body", "Request body exceeds the maximum size.");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    requestError("body", "Body must be valid JSON.");
  }
  if (!record(value)) requestError("body", "Body must be a JSON object.");

  const supportedFields = ["model", "input", "dimensions", "encoding_format"];
  if (Object.keys(value).some((key) => !supportedFields.includes(key))) {
    requestError("body", "Only model, input, dimensions, and encoding_format are supported.");
  }

  const model = value["model"];
  if (typeof model !== "string" || model.length === 0) {
    requestError("model", "A model ID is required.");
  }
  if (!isEmbeddingModel(model)) {
    requestError("model", "The requested embedding model is not available.");
  }

  const inputValue = value["input"];
  let input: EmbeddingInput;
  if (typeof inputValue === "string") {
    input = inputValue;
  } else if (Array.isArray(inputValue)) {
    if (inputValue.length < 1 || inputValue.length > MAX_INPUT_ITEMS ||
      inputValue.some((item) => typeof item !== "string")) {
      requestError("input", "Input must be a string or an array of 1 to 16 strings.");
    }
    input = inputValue as string[];
  } else {
    requestError("input", "Input must be a string or an array of 1 to 16 strings.");
  }

  const inputs = typeof input === "string" ? [input] : input;
  if (inputs.some((item) => charCount(item) === 0)) {
    requestError("input", "Input strings must not be empty.");
  }
  if (inputs.some((item) => charCount(item) > MAX_ITEM_CHARS)) {
    requestError("input", "An input string exceeds the maximum length.");
  }
  if (inputs.reduce((total, item) => total + charCount(item), 0) > MAX_TOTAL_CHARS) {
    requestError("input", "The combined input exceeds the maximum length.");
  }

  let dimensions: EmbeddingDimension | undefined;
  if (value["dimensions"] !== undefined) {
    const candidate = value["dimensions"];
    if (candidate !== 128 && candidate !== 256 && candidate !== 512 && candidate !== 768) {
      requestError("dimensions", "Dimensions must be one of 128, 256, 512, or 768.");
    }
    dimensions = candidate;
  }

  if (value["encoding_format"] !== undefined && value["encoding_format"] !== "float") {
    requestError("encoding_format", "Only float encoding is supported.");
  }

  const upstreamBody: EmbeddingUpstreamBody = {
    model: EMBEDDING_MODEL_ID,
    input,
    encoding_format: "float",
  };
  return { model: EMBEDDING_MODEL_ID, input, dimensions, upstreamBody };
}

/** Reserve a conservative prompt-token estimate before contacting the embedding runtime. */
export function embeddingTokenReservation(request: EmbeddingRequest): number {
  const inputs = typeof request.input === "string" ? [request.input] : request.input;
  // Reserve more than a chars/4 estimate: a Unicode-heavy string or task-prefix overhead can
  // tokenize much more densely. One token per UTF-8 byte plus 64 per input is conservative
  // while remaining below the model's 8192-token context ceiling per input.
  const bytes = inputs.reduce((total, item) => total + new TextEncoder().encode(item).byteLength, 0);
  return Math.min(8192 * inputs.length, bytes + 64 * inputs.length);
}

function finiteVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === EMBEDDING_SIZE &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function normalizedPrefix(vector: number[], dimensions: EmbeddingDimension | undefined): number[] {
  const size = dimensions ?? EMBEDDING_SIZE;
  const prefix = vector.slice(0, size);
  let scale = 0;
  for (const item of prefix) scale = Math.max(scale, Math.abs(item));
  if (scale === 0) throw new EmbeddingResponseError("Embedding vector cannot be normalized.");

  let sumSquares = 0;
  for (const item of prefix) {
    const scaled = item / scale;
    sumSquares += scaled * scaled;
  }
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new EmbeddingResponseError("Embedding vector cannot be normalized.");
  }
  return prefix.map((item) => (item / scale) / norm);
}

/** Validate the runtime payload and return an OpenAI-shaped, normalized response. */
export function validateAndShapeEmbeddingResponse(
  payload: unknown,
  request: EmbeddingRequest,
): { body: {
  object: "list";
  data: Array<{ object: "embedding"; embedding: number[]; index: number }>;
  model: typeof EMBEDDING_MODEL_ID;
  usage: { prompt_tokens: number; total_tokens: number };
}; inputTokens: number } {
  if (!record(payload) || payload["object"] !== "list" || !Array.isArray(payload["data"]) ||
    !record(payload["usage"]) || payload["model"] !== EMBEDDING_MODEL_ID) {
    throw new EmbeddingResponseError("Invalid embedding response envelope.");
  }

  const inputs = typeof request.input === "string" ? [request.input] : request.input;
  const data = payload["data"];
  if (data.length !== inputs.length) {
    throw new EmbeddingResponseError("Embedding response count does not match the request.");
  }

  const shapedData: Array<{ object: "embedding"; embedding: number[]; index: number }> = [];
  for (let index = 0; index < data.length; index += 1) {
    const item = data[index];
    if (!record(item) || item["index"] !== index || item["object"] !== "embedding" ||
      !finiteVector(item["embedding"])) {
      throw new EmbeddingResponseError("Invalid embedding vector response.");
    }
    shapedData.push({
      object: "embedding",
      embedding: normalizedPrefix(item["embedding"], request.dimensions),
      index,
    });
  }

  const promptTokens = payload["usage"]["prompt_tokens"];
  if (typeof promptTokens !== "number" || !Number.isSafeInteger(promptTokens) || promptTokens <= 0 ||
    promptTokens > embeddingTokenReservation(request)) {
    throw new EmbeddingResponseError("Invalid embedding token usage.");
  }

  return {
    body: {
      object: "list",
      data: shapedData,
      model: EMBEDDING_MODEL_ID,
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    },
    inputTokens: promptTokens,
  };
}
