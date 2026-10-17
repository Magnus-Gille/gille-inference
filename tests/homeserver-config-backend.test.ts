import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

/**
 * Config-loader coverage for HOMESERVER_BACKEND (#146). llama-swap is the only backend that
 * still gets production traffic — lmstudio is deprecated — so an env omission (fresh deploy,
 * restore from backup) must land on llamaswap, not silently reactivate the deprecated adapter.
 */

const KEY = "HOMESERVER_BACKEND";
const STARTUP_EXCLUSIVE_KEY = "HOMESERVER_STARTUP_EXCLUSIVE_UNTIL";
let saved: string | undefined;
let savedStartupExclusive: string | undefined;

beforeEach(() => {
  saved = process.env[KEY];
  savedStartupExclusive = process.env[STARTUP_EXCLUSIVE_KEY];
  delete process.env[KEY];
  delete process.env[STARTUP_EXCLUSIVE_KEY];
  resetConfig();
});

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  if (savedStartupExclusive === undefined) delete process.env[STARTUP_EXCLUSIVE_KEY];
  else process.env[STARTUP_EXCLUSIVE_KEY] = savedStartupExclusive;
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

  it("leaves the startup exclusive fence absent when the env var is unset", () => {
    const cfg = loadConfig() as Record<string, unknown>;
    expect(cfg["startupExclusiveUntilMs"]).toBeUndefined();
  });

  it("parses a canonical UTC startup exclusive timestamp to epoch milliseconds", () => {
    const timestamp = new Date(Date.now() + 5 * 60_000).toISOString();
    process.env[STARTUP_EXCLUSIVE_KEY] = timestamp;
    resetConfig();
    const cfg = loadConfig() as Record<string, unknown>;
    expect(cfg["startupExclusiveUntilMs"]).toBe(Date.parse(timestamp));
  });

  it("accepts an expired canonical timestamp for an inactive fence", () => {
    const timestamp = "2020-01-02T03:04:05.006Z";
    process.env[STARTUP_EXCLUSIVE_KEY] = timestamp;
    resetConfig();
    const cfg = loadConfig() as Record<string, unknown>;
    expect(cfg["startupExclusiveUntilMs"]).toBe(Date.parse(timestamp));
  });

  it.each([
    "2026-01-02T03:04:05Z", // missing milliseconds: not toISOString() exact
    "2026-01-02T03:04:05.000+00:00", // equivalent offset form: not canonical UTC
    "not-a-timestamp",
  ])("rejects malformed startup exclusive timestamp %s", (timestamp) => {
    process.env[STARTUP_EXCLUSIVE_KEY] = timestamp;
    resetConfig();
    expect(() => loadConfig()).toThrow(/HOMESERVER_STARTUP_EXCLUSIVE_UNTIL/);
  });

  it("rejects a canonical timestamp more than 30 minutes in the future", () => {
    process.env[STARTUP_EXCLUSIVE_KEY] = new Date(Date.now() + 31 * 60_000).toISOString();
    resetConfig();
    expect(() => loadConfig()).toThrow(/HOMESERVER_STARTUP_EXCLUSIVE_UNTIL/);
  });
});
