import { describe, it, expect } from "vitest";
import {
  parseImageRequest,
  isImageRequestError,
  IMAGE_MODELS,
  IMAGE_MODEL_IDS,
} from "../src/homeserver/image-request.js";
import type { HomeserverConfig } from "../src/homeserver/config.js";

/**
 * Pure-validator tests for parseImageRequest. No I/O — exercises model/tier resolution, the n/size
 * clamps + rejections, the allow-list (403), and the prompt/response_format guards.
 */

const cfg = {
  imagePromptMaxChars: 100,
  imageMaxN: 4,
  imageSizes: ["512x512", "1024x1024"],
  imageDefaultSize: "1024x1024",
} as unknown as HomeserverConfig;

function ok(raw: unknown, allow: string[] = []) {
  const r = parseImageRequest(raw, cfg, allow);
  if (isImageRequestError(r)) throw new Error(`expected ok, got error: ${r.error.message}`);
  return r;
}
function err(raw: unknown, allow: string[] = []) {
  const r = parseImageRequest(raw, cfg, allow);
  if (!isImageRequestError(r)) throw new Error("expected an error");
  return r.error;
}

describe("parseImageRequest — model + tier resolution", () => {
  it("resolves each advertised id to its tier and sync flag", () => {
    expect(ok({ prompt: "a", model: "image-fast" })).toMatchObject({ tier: "fast", sync: true });
    expect(ok({ prompt: "a", model: "image-balanced" })).toMatchObject({ tier: "balanced", sync: false });
    expect(ok({ prompt: "a", model: "image-high" })).toMatchObject({ tier: "high", sync: false });
  });

  it("the advertised ids and the map agree", () => {
    expect(IMAGE_MODEL_IDS.every((id) => id in IMAGE_MODELS)).toBe(true);
    expect(Object.keys(IMAGE_MODELS).sort()).toEqual([...IMAGE_MODEL_IDS].sort());
  });

  it("rejects an unknown model with 400", () => {
    const e = err({ prompt: "a", model: "dall-e-3" });
    expect(e.status).toBe(400);
    expect(e.class).toBe("invalid_request_error");
    expect(e.param).toBe("model");
  });

  it("rejects a missing model / prompt", () => {
    expect(err({ prompt: "a" }).param).toBe("model");
    expect(err({ model: "image-fast" }).param).toBe("prompt");
    expect(err({ prompt: "", model: "image-fast" }).param).toBe("prompt");
  });
});

describe("parseImageRequest — allow-list (403)", () => {
  it("empty allow-list permits any image model", () => {
    expect(isImageRequestError(parseImageRequest({ prompt: "a", model: "image-high" }, cfg, []))).toBe(false);
  });
  it("a non-empty allow-list that excludes the model yields 403 model_not_allowed", () => {
    const e = err({ prompt: "a", model: "image-high" }, ["image-fast"]);
    expect(e.status).toBe(403);
    expect(e.class).toBe("model_not_allowed");
  });
  it("a non-empty allow-list that includes the model passes", () => {
    expect(ok({ prompt: "a", model: "image-fast" }, ["image-fast"]).model).toBe("image-fast");
  });
});

describe("parseImageRequest — n / size / response_format", () => {
  it("defaults n=1 and clamps n to imageMaxN", () => {
    expect(ok({ prompt: "a", model: "image-fast" }).n).toBe(1);
    expect(ok({ prompt: "a", model: "image-fast", n: 2 }).n).toBe(2);
    expect(ok({ prompt: "a", model: "image-fast", n: 99 }).n).toBe(cfg.imageMaxN);
  });
  it("rejects non-integer / non-positive n", () => {
    expect(err({ prompt: "a", model: "image-fast", n: 0 }).param).toBe("n");
    expect(err({ prompt: "a", model: "image-fast", n: 1.5 }).param).toBe("n");
    expect(err({ prompt: "a", model: "image-fast", n: -3 }).param).toBe("n");
    expect(err({ prompt: "a", model: "image-fast", n: "2" }).param).toBe("n");
  });
  it("defaults size and rejects an out-of-list size", () => {
    expect(ok({ prompt: "a", model: "image-fast" }).size).toBe("1024x1024");
    expect(ok({ prompt: "a", model: "image-fast", size: "512x512" }).size).toBe("512x512");
    expect(err({ prompt: "a", model: "image-fast", size: "256x256" }).param).toBe("size");
  });
  it("accepts b64_json (default) and rejects url / other", () => {
    expect(ok({ prompt: "a", model: "image-fast" }).responseFormat).toBe("b64_json");
    expect(ok({ prompt: "a", model: "image-fast", response_format: "b64_json" }).responseFormat).toBe("b64_json");
    expect(err({ prompt: "a", model: "image-fast", response_format: "url" }).param).toBe("response_format");
    expect(err({ prompt: "a", model: "image-fast", response_format: "png" }).param).toBe("response_format");
  });
  it("rejects an over-long prompt", () => {
    expect(err({ prompt: "x".repeat(101), model: "image-fast" }).param).toBe("prompt");
  });
  it("rejects a non-object body", () => {
    expect(err(null).param).toBe(null);
    expect(err("nope").param).toBe(null);
    expect(err([]).param).toBe(null);
  });
});
