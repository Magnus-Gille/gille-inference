import type { HomeserverConfig } from "./config.js";

/**
 * Pure parse + validation for POST /v1/images/generations. No I/O — modelled on quota.ts /
 * admission.ts (pure functions + a dedicated *.test.ts) so the request contract can be exhaustively
 * unit-tested without booting the gateway.
 *
 * The three advertised image model ids each map to a TIER. The fast tier is served SYNCHRONOUSLY
 * (the gateway blocks on the sidecar like the audio path); balanced/high are ASYNC job submissions.
 */

export type ImageTier = "fast" | "balanced" | "high";

/** Advertised model id → tier. These ids are what /v1/models lists and clients must send. */
export const IMAGE_MODELS: Readonly<Record<string, ImageTier>> = {
  "image-fast": "fast",
  "image-balanced": "balanced",
  "image-high": "high",
};

/** The model ids advertised on /v1/models (in stable order). */
export const IMAGE_MODEL_IDS: string[] = ["image-fast", "image-balanced", "image-high"];

export interface ParsedImageRequest {
  /** Canonical advertised model id (image-fast|image-balanced|image-high). */
  model: string;
  tier: ImageTier;
  /** fast → synchronous; balanced|high → async job. */
  sync: boolean;
  prompt: string;
  n: number;
  size: string;
  /** Only b64_json is supported (no static host for url delivery yet). */
  responseFormat: "b64_json";
}

export interface ImageRequestError {
  error: {
    /** OpenAI error class — drives the envelope + HTTP status the gateway sends. */
    class: "invalid_request_error" | "model_not_allowed";
    status: number;
    param: string | null;
    message: string;
  };
}

export function isImageRequestError(
  v: ParsedImageRequest | ImageRequestError
): v is ImageRequestError {
  return (v as ImageRequestError).error !== undefined;
}

function bad(param: string | null, message: string): ImageRequestError {
  return { error: { class: "invalid_request_error", status: 400, param, message } };
}

/**
 * Validate a raw JSON body against the image-generation contract and the key's allow-list.
 *
 *   • prompt   — required non-empty string, ≤ cfg.imagePromptMaxChars.
 *   • model    — required; must be one of the advertised image-* ids, else 400.
 *   • allow-list — empty = all; otherwise the model must be listed, else 403 model_not_allowed.
 *   • n        — optional; a positive integer, CLAMPED to [1, cfg.imageMaxN]. Non-int/≤0 → 400.
 *   • size     — optional; must be a member of cfg.imageSizes, else 400. Defaults to imageDefaultSize.
 *   • response_format — optional; only "b64_json" (default). "url" or anything else → 400.
 */
export function parseImageRequest(
  raw: unknown,
  cfg: HomeserverConfig,
  allowList: string[]
): ParsedImageRequest | ImageRequestError {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return bad(null, "Request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  // prompt
  if (typeof body["prompt"] !== "string" || body["prompt"].length === 0) {
    return bad("prompt", "Missing required field 'prompt'.");
  }
  const prompt = body["prompt"];
  if (prompt.length > cfg.imagePromptMaxChars) {
    return bad("prompt", `'prompt' exceeds the maximum length of ${cfg.imagePromptMaxChars} characters.`);
  }

  // model
  if (typeof body["model"] !== "string" || body["model"].length === 0) {
    return bad("model", "Missing required field 'model'.");
  }
  const model = body["model"];
  const tier = IMAGE_MODELS[model];
  if (tier === undefined) {
    return bad("model", `Unknown image model '${model}'. Valid models: ${IMAGE_MODEL_IDS.join(", ")}.`);
  }

  // allow-list (empty = all). Mirrors the chat / audio convention.
  if (allowList.length > 0 && !allowList.includes(model)) {
    return {
      error: {
        class: "model_not_allowed",
        status: 403,
        param: "model",
        message: `Your API key is not permitted to use model '${model}'.`,
      },
    };
  }

  // n — positive integer, clamped to [1, imageMaxN].
  let n = 1;
  if (body["n"] !== undefined) {
    const rawN = body["n"];
    if (typeof rawN !== "number" || !Number.isInteger(rawN) || rawN < 1) {
      return bad("n", "'n' must be a positive integer.");
    }
    n = Math.min(rawN, cfg.imageMaxN);
  }

  // size — must be an allowed value.
  let size = cfg.imageDefaultSize;
  if (body["size"] !== undefined) {
    if (typeof body["size"] !== "string" || !cfg.imageSizes.includes(body["size"])) {
      return bad("size", `'size' must be one of: ${cfg.imageSizes.join(", ")}.`);
    }
    size = body["size"];
  }

  // response_format — only b64_json supported.
  if (body["response_format"] !== undefined) {
    if (body["response_format"] === "url") {
      return bad("response_format", "response_format 'url' is not supported; use 'b64_json'.");
    }
    if (body["response_format"] !== "b64_json") {
      return bad("response_format", "response_format must be 'b64_json'.");
    }
  }

  return { model, tier, sync: tier === "fast", prompt, n, size, responseFormat: "b64_json" };
}
