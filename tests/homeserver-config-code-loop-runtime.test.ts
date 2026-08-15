import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

const KEYS = [
  "HOMESERVER_CODE_LOOP_PI_BIN",
  "HOMESERVER_CODE_LOOP_PI_AGENT_DIR",
  "HOMESERVER_CODE_LOOP_RUNTIME_PI_BIN",
  "HOMESERVER_CODE_LOOP_RUNTIME_PI_AGENT_DIR",
  "HOMESERVER_CODE_LOOP_RUNTIME_NODE_MODULES_DIR",
  "HOMESERVER_CODE_LOOP_WORKROOT",
  "HOMESERVER_CODE_LOOP_RUNTIME_WORKROOT",
] as const;

const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  resetConfig();
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  resetConfig();
});

describe("isolated code-loop runtime path overrides", () => {
  it("prefers dedicated runtime paths over legacy paths from the secret environment file", () => {
    process.env["HOMESERVER_CODE_LOOP_PI_BIN"] = "/home/owner/.local/bin/pi";
    process.env["HOMESERVER_CODE_LOOP_PI_AGENT_DIR"] = "/home/owner/.pi-code-loop";
    process.env["HOMESERVER_CODE_LOOP_RUNTIME_PI_BIN"] = "/var/lib/gille-inference/gille-gateway/.local/bin/pi";
    process.env["HOMESERVER_CODE_LOOP_RUNTIME_PI_AGENT_DIR"] = "/var/lib/gille-inference/gille-gateway/.pi-code-loop";
    process.env["HOMESERVER_CODE_LOOP_RUNTIME_NODE_MODULES_DIR"] = "/var/lib/gille-inference/gateway/node_modules";
    process.env["HOMESERVER_CODE_LOOP_WORKROOT"] = "/home/owner/deploy/data/code-loop-work";
    process.env["HOMESERVER_CODE_LOOP_RUNTIME_WORKROOT"] = "/var/lib/gille-inference/gateway/data/code-loop-work";
    resetConfig();

    const cfg = loadConfig();
    expect(cfg.codeLoopPiBin).toBe("/var/lib/gille-inference/gille-gateway/.local/bin/pi");
    expect(cfg.codeLoopPiAgentDir).toBe("/var/lib/gille-inference/gille-gateway/.pi-code-loop");
    expect(cfg.codeLoopNodeModulesDir).toBe("/var/lib/gille-inference/gateway/node_modules");
    expect(cfg.codeLoopWorkroot).toBe("/var/lib/gille-inference/gateway/data/code-loop-work");
  });

  it("retains the public configuration variables when no isolation override is present", () => {
    process.env["HOMESERVER_CODE_LOOP_PI_BIN"] = "/opt/pi/bin/pi";
    process.env["HOMESERVER_CODE_LOOP_PI_AGENT_DIR"] = "/opt/pi/agent";
    process.env["HOMESERVER_CODE_LOOP_WORKROOT"] = "/opt/pi/work";
    resetConfig();

    const cfg = loadConfig();
    expect(cfg.codeLoopPiBin).toBe("/opt/pi/bin/pi");
    expect(cfg.codeLoopPiAgentDir).toBe("/opt/pi/agent");
    expect(cfg.codeLoopNodeModulesDir).toBe("");
    expect(cfg.codeLoopWorkroot).toBe("/opt/pi/work");
  });
});
