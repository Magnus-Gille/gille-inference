import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

/**
 * Config-loader coverage for HOMESERVER_BACKEND (#146). llama-swap is the only backend that
 * still gets production traffic — lmstudio is deprecated — so an env omission (fresh deploy,
 * restore from backup) must land on llamaswap, not silently reactivate the deprecated adapter.
 */

const KEY = "HOMESERVER_BACKEND";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  delete process.env[KEY];
  resetConfig();
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  resetConfig();
});

describe("HOMESERVER_BACKEND config loader", () => {
  it("defaults backend to llamaswap when the env var is UNSET", () => {
    expect(loadConfig().backend).toBe("llamaswap");
  });

  it("honours an explicit lmstudio override (deprecated, kept one release)", () => {
    process.env[KEY] = "lmstudio";
    resetConfig();
    expect(loadConfig().backend).toBe("lmstudio");
  });

  it("honours an explicit llamaswap override", () => {
    process.env[KEY] = "llamaswap";
    resetConfig();
    expect(loadConfig().backend).toBe("llamaswap");
  });

  it("falls back to llamaswap on an unrecognized value", () => {
    process.env[KEY] = "bogus";
    resetConfig();
    expect(loadConfig().backend).toBe("llamaswap");
  });
});
