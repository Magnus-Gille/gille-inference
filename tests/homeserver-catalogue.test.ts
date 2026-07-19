import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Trusted-catalogue canonicalizer unit tests.
 *
 * The catalogue is a short-TTL cache of resident model ids fetched from model-admin (the trusted
 * source). canonicalizeModelTrusted() is SYNCHRONOUS — it reads the current cache and kicks a
 * background refresh; it NEVER blocks the request on a model-list round-trip. warmCatalogue()
 * awaits a refresh (used at startup / in tests). It uses the cache so empty-allow-list
 * (owner/admin) keys keep a per-model metric label for KNOWN models, while NEVER letting a raw user
 * string become a label/log value: an unknown/secret string → "unknown", never the raw text.
 */

// model-admin is the catalogue source — mock listModels so the test controls the resident set.
const listModelsMock = vi.fn();
vi.mock("../src/homeserver/model-admin.js", () => ({
  listModels: () => listModelsMock(),
}));

let canonicalizeModelTrusted: typeof import("../src/homeserver/catalogue.js").canonicalizeModelTrusted;
let warmCatalogue: typeof import("../src/homeserver/catalogue.js").warmCatalogue;
let getTrustedCatalogue: typeof import("../src/homeserver/catalogue.js").getTrustedCatalogue;
let resetCatalogueCache: typeof import("../src/homeserver/catalogue.js").resetCatalogueCache;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import("../src/homeserver/catalogue.js");
  canonicalizeModelTrusted = mod.canonicalizeModelTrusted;
  warmCatalogue = mod.warmCatalogue;
  getTrustedCatalogue = mod.getTrustedCatalogue;
  resetCatalogueCache = mod.resetCatalogueCache;
  resetCatalogueCache();
});

describe("trusted catalogue", () => {
  it("warmCatalogue populates the cache and getTrustedCatalogue reads it synchronously", async () => {
    listModelsMock.mockResolvedValue([{ key: "qwen3-coder-80b" }, { key: "gemma-3-27b" }]);
    await warmCatalogue();
    const cat = getTrustedCatalogue();
    expect(cat.has("qwen3-coder-80b")).toBe(true);
    expect(cat.has("gemma-3-27b")).toBe(true);
  });

  it("a warm cache is not re-fetched within the TTL (background refresh is throttled)", async () => {
    listModelsMock.mockResolvedValue([{ key: "m1" }]);
    await warmCatalogue();
    const callsAfterWarm = listModelsMock.mock.calls.length;
    // Synchronous reads within the TTL must not trigger another fetch.
    getTrustedCatalogue();
    getTrustedCatalogue();
    expect(listModelsMock.mock.calls.length).toBe(callsAfterWarm);
  });

  it("warmCatalogue tolerates a fetch failure (keeps prior cache, never throws)", async () => {
    listModelsMock.mockResolvedValueOnce([{ key: "m1" }]);
    await warmCatalogue();
    expect(getTrustedCatalogue().has("m1")).toBe(true);
    // A subsequent failed refresh must not wipe the good cache.
    listModelsMock.mockRejectedValueOnce(new Error("backend down"));
    await warmCatalogue();
    expect(getTrustedCatalogue().has("m1")).toBe(true);
  });
});

describe("canonicalizeModelTrusted — empty allow-list (owner/admin)", () => {
  it("a request to a KNOWN catalogue model is recorded with that id, NOT 'none'", async () => {
    listModelsMock.mockResolvedValue([{ key: "qwen3-coder-80b" }]);
    await warmCatalogue();
    expect(canonicalizeModelTrusted("qwen3-coder-80b", [])).toBe("qwen3-coder-80b");
  });

  it("an arbitrary/secret string → 'unknown', NEVER the raw string", async () => {
    listModelsMock.mockResolvedValue([{ key: "qwen3-coder-80b" }]);
    await warmCatalogue();
    const secret = "sk-SUPERSECRET-INJECTED-9f2a";
    const result = canonicalizeModelTrusted(secret, []);
    expect(result).toBe("unknown");
    expect(result).not.toBe(secret);
  });

  it("a null / empty model → null (non-inference route, mapped to 'none' downstream)", async () => {
    listModelsMock.mockResolvedValue([{ key: "qwen3-coder-80b" }]);
    await warmCatalogue();
    expect(canonicalizeModelTrusted(null, [])).toBeNull();
    expect(canonicalizeModelTrusted("   ", [])).toBeNull();
  });

  it("a cold cache (no warm yet) yields 'unknown' and never the raw string — content-blind", () => {
    // No warmCatalogue() call: the cache is empty. canonicalizeModelTrusted must NOT block and
    // must NOT echo the raw string — it returns "unknown" and kicks a background refresh.
    const result = canonicalizeModelTrusted("some-real-model", []);
    expect(result).toBe("unknown");
  });
});

describe("canonicalizeModelTrusted — non-empty allow-list (scoped key)", () => {
  it("keeps existing allow-list behaviour: an allowed model passes through, no catalogue fetch", () => {
    const result = canonicalizeModelTrusted("m1", ["m1", "m2"]);
    expect(result).toBe("m1");
    // The scoped path is purely synchronous against the allow-list — no catalogue fetch.
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it("a disallowed model → 'unknown', never the raw string (even if it is resident)", async () => {
    listModelsMock.mockResolvedValue([{ key: "secret-resident" }]);
    await warmCatalogue();
    const result = canonicalizeModelTrusted("secret-resident", ["m1"]);
    // Not on the key's allow-list → must not be labelled with its id.
    expect(result).toBe("unknown");
  });
});
