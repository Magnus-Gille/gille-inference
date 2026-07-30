import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

const keys = [
  "HOMESERVER_REVIEW_CASCADE",
  "HOMESERVER_REVIEW_CASCADE_GPT_MODEL",
  "HOMESERVER_REVIEW_CASCADE_QWEN_MODEL",
  "HOMESERVER_REVIEW_CASCADE_TASK_TYPES",
  "HOMESERVER_REVIEW_CASCADE_MAX_TOKENS",
  "HOMESERVER_REVIEW_CASCADE_TIMEOUT_MS",
] as const;
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
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  resetConfig();
});

describe("#132 review cascade config", () => {
  it("is disabled by default and has no enforce setting", () => {
    expect(loadConfig().reviewCascadeShadow).toMatchObject({ mode: "off", taskTypes: ["code-review"] });
  });

  it("accepts only explicit shadow and bounds budgets", () => {
    process.env["HOMESERVER_REVIEW_CASCADE"] = "shadow";
    process.env["HOMESERVER_REVIEW_CASCADE_GPT_MODEL"] = "gpt-oss-120b";
    process.env["HOMESERVER_REVIEW_CASCADE_QWEN_MODEL"] = "qwen35-122b-a10b";
    process.env["HOMESERVER_REVIEW_CASCADE_TASK_TYPES"] = "code-review";
    process.env["HOMESERVER_REVIEW_CASCADE_MAX_TOKENS"] = "0";
    process.env["HOMESERVER_REVIEW_CASCADE_TIMEOUT_MS"] = "0";
    resetConfig();
    expect(loadConfig().reviewCascadeShadow).toEqual({
      mode: "shadow", gptModel: "gpt-oss-120b", qwenModel: "qwen35-122b-a10b",
      taskTypes: ["code-review"], maxTokens: 1, timeoutMs: 1,
    });
    process.env["HOMESERVER_REVIEW_CASCADE"] = "enforce";
    resetConfig();
    expect(loadConfig().reviewCascadeShadow.mode).toBe("off");
  });
});
