import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

const keys = ["HOMESERVER_EMBEDDING_MODELS", "HOMESERVER_EMBEDDING_BASE_URL"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of keys) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of keys) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

describe("embedding sidecar configuration", () => {
  it("keeps embeddings disabled without an explicit model", () => {
    expect(loadConfig().embeddingModels).toEqual([]);
  });

  it("accepts the reviewed model on loopback and normalizes a trailing slash", () => {
    process.env.HOMESERVER_EMBEDDING_MODELS = "embeddinggemma-2";
    process.env.HOMESERVER_EMBEDDING_BASE_URL = "http://127.0.0.1:8107/v1/";
    expect(loadConfig().embeddingBaseUrl).toBe("http://127.0.0.1:8107/v1");
  });

  it.each([
    "https://127.0.0.1:8107/v1",
    "http://localhost:8107/v1",
    "http://127.0.0.1:8107/admin",
    "http://127.0.0.1:8107/v1?x=1",
    "http://127.0.0.1:8107/v1?",
    "http://127.0.0.1:8107/v1#",
    "http://user:pass@127.0.0.1:8107/v1",
  ])("rejects a nonconforming sidecar URL: %s", (url) => {
    process.env.HOMESERVER_EMBEDDING_MODELS = "embeddinggemma-2";
    process.env.HOMESERVER_EMBEDDING_BASE_URL = url;
    expect(() => loadConfig()).toThrow(/HOMESERVER_EMBEDDING_BASE_URL/);
  });
});
