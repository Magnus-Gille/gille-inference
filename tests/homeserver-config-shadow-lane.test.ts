import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

const KEYS = [
  "HOMESERVER_SHADOW_LANE",
  "HOMESERVER_SHADOW_LANE_MODEL",
  "HOMESERVER_SHADOW_LANE_TASK_TYPES",
  "HOMESERVER_SHADOW_LANE_MAX_TOKENS",
  "HOMESERVER_SHADOW_LANE_TIMEOUT_MS",
  "HOMESERVER_SHADOW_LANE_AGREEMENT",
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key]!;
  }
  resetConfig();
});

describe("shadow-lane config loader (#234)", () => {
  it("is inert by default", () => {
    expect(loadConfig().shadowLane).toEqual({
      mode: "off",
      model: "",
      taskTypes: [],
      maxTokens: 0,
      timeoutMs: 120_000,
      agreementThreshold: 0.7,
    });
  });

  it("enables only for the exact value on and parses candidate scope", () => {
    process.env["HOMESERVER_SHADOW_LANE"] = "on";
    process.env["HOMESERVER_SHADOW_LANE_MODEL"] = "qwen3-coder-next-80b";
    process.env["HOMESERVER_SHADOW_LANE_TASK_TYPES"] = "code-review, code-edit";
    process.env["HOMESERVER_SHADOW_LANE_MAX_TOKENS"] = "4096";
    process.env["HOMESERVER_SHADOW_LANE_TIMEOUT_MS"] = "60000";
    process.env["HOMESERVER_SHADOW_LANE_AGREEMENT"] = "0.8";
    resetConfig();

    expect(loadConfig().shadowLane).toEqual({
      mode: "on",
      model: "qwen3-coder-next-80b",
      taskTypes: ["code-review", "code-edit"],
      maxTokens: 4096,
      timeoutMs: 60_000,
      agreementThreshold: 0.8,
    });

    process.env["HOMESERVER_SHADOW_LANE"] = "true";
    resetConfig();
    expect(loadConfig().shadowLane.mode).toBe("off");
  });

  it("clamps evidence-sensitive numeric settings to safe ranges", () => {
    process.env["HOMESERVER_SHADOW_LANE_MAX_TOKENS"] = "-5";
    process.env["HOMESERVER_SHADOW_LANE_TIMEOUT_MS"] = "0";
    process.env["HOMESERVER_SHADOW_LANE_AGREEMENT"] = "5";
    resetConfig();
    expect(loadConfig().shadowLane.maxTokens).toBe(0);
    expect(loadConfig().shadowLane.timeoutMs).toBe(1);
    expect(loadConfig().shadowLane.agreementThreshold).toBe(1);

    process.env["HOMESERVER_SHADOW_LANE_AGREEMENT"] = "-2";
    resetConfig();
    expect(loadConfig().shadowLane.agreementThreshold).toBe(0);
  });
});
