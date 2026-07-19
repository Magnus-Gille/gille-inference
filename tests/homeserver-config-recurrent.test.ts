import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

/**
 * Config-loader coverage for the recurrent poison-clear knobs. These verify the LOADER logic —
 * especially the "unset → default" vs "set empty → disable" distinction in config.ts, which the
 * gateway/unit tests do not exercise (they pass an explicit allow-list / a hardcoded constant).
 */

const KEYS = [
  "HOMESERVER_RECURRENT_MODEL_IDS",
  "HOMESERVER_POISON_CLEAR_COOLDOWN_MS",
  "HOMESERVER_DEGENERACY_RUN_THRESHOLD",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetConfig();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  resetConfig();
});

describe("recurrent poison-clear config loader", () => {
  it("defaults recurrentModelIds to the known recurrent model when the env var is UNSET", () => {
    expect(loadConfig().recurrentModelIds).toEqual(["qwen3-coder-next-80b"]);
  });

  it("DISABLES the feature (empty list) when the env var is set to an empty string", () => {
    process.env["HOMESERVER_RECURRENT_MODEL_IDS"] = "";
    resetConfig();
    expect(loadConfig().recurrentModelIds).toEqual([]);
  });

  it("parses a CSV override into a trimmed id list", () => {
    process.env["HOMESERVER_RECURRENT_MODEL_IDS"] = "model-a, model-b ,model-c";
    resetConfig();
    expect(loadConfig().recurrentModelIds).toEqual(["model-a", "model-b", "model-c"]);
  });

  it("defaults the poison-clear cooldown to 60000 ms (above the 80B cold-load time)", () => {
    expect(loadConfig().poisonClearCooldownMs).toBe(60_000);
  });

  it("honours a poison-clear cooldown override", () => {
    process.env["HOMESERVER_POISON_CLEAR_COOLDOWN_MS"] = "5000";
    resetConfig();
    expect(loadConfig().poisonClearCooldownMs).toBe(5000);
  });

  it("defaults the degeneracy-watchdog run threshold to 400 when UNSET", () => {
    expect(loadConfig().degeneracyRunThreshold).toBe(400);
  });

  it("honours a degeneracy-watchdog threshold override", () => {
    process.env["HOMESERVER_DEGENERACY_RUN_THRESHOLD"] = "120";
    resetConfig();
    expect(loadConfig().degeneracyRunThreshold).toBe(120);
  });

  it("DISABLES the watchdog when the threshold is set to 0", () => {
    process.env["HOMESERVER_DEGENERACY_RUN_THRESHOLD"] = "0";
    resetConfig();
    expect(loadConfig().degeneracyRunThreshold).toBe(0);
  });
});
