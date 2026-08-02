import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

const KEYS = ["HOMESERVER_TRACE_RELEASE", "HOMESERVER_TRACE_INSTANCE_ID"] as const;
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
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

describe("content-blind tracing identity config", () => {
  it("accepts bounded deployment tokens", () => {
    process.env["HOMESERVER_TRACE_RELEASE"] = "git-f42d8b0";
    process.env["HOMESERVER_TRACE_INSTANCE_ID"] = "gateway-test-1";
    resetConfig();

    expect(loadConfig().tracing).toMatchObject({
      release: "git-f42d8b0",
      instanceId: "gateway-test-1",
    });
  });

  it.each([
    ["secret-shaped", "SECRET_TOKEN_ABC", "dev", "unknown"],
    ["URL", "https://collector.example/path?token=secret", "dev", "unknown"],
    ["space", "gateway instance", "dev", "unknown"],
    ["oversized", "x".repeat(65), "dev", "unknown"],
  ])("replaces %s values with safe defaults without exposing the raw input", (_label, value, release, instanceId) => {
    process.env["HOMESERVER_TRACE_RELEASE"] = value;
    process.env["HOMESERVER_TRACE_INSTANCE_ID"] = value;
    resetConfig();

    const tracing = loadConfig().tracing;
    expect(tracing.release).toBe(release);
    expect(tracing.instanceId).toBe(instanceId);
    expect(JSON.stringify(tracing)).not.toContain(value);
  });
});
