import { describe, expect, it } from "vitest";
import {
  extractResidencyOutput,
  formatResidencyOutput,
  type ResidencyOutputRow,
} from "../src/homeserver/cli.js";

const diagnostic = {
  model: "qwen-main",
  state: "ready",
  ttlSeconds: 60,
  classification: "ttl_retained" as const,
  activeCount: 3,
  lastUseAtMs: 123,
  expiresAtMs: 456,
};

describe("residency CLI extraction and formatting", () => {
  it("extracts only safe diagnostic and last-use fields", () => {
    const rows = extractResidencyOutput(
      [diagnostic],
      {
        "qwen-main": {
        ts: 123,
          route: "/v1/chat/completions",
          outcome: "ok",
          id: "request-id-must-not-escape",
          keyHash: "hash-must-not-escape",
          prompt: "prompt-must-not-escape",
          response: "response-must-not-escape",
          tokens: 42,
        } as never,
      }
    );

    expect(rows).toEqual<ResidencyOutputRow[]>([
      {
        model: "qwen-main",
        state: "ready",
        ttl: 60,
        classification: "ttl_retained",
        lastUse: {
          ts: 123,
          route: "/v1/chat/completions",
          outcome: "ok",
        },
      },
    ]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "classification",
      "lastUse",
      "model",
      "state",
      "ttl",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/id|hash|token|prompt|response|content|command|proxy|ip|secret/i);
  });

  it("represents absent last use explicitly as null", () => {
    const rows = extractResidencyOutput([{ ...diagnostic, activeCount: 0 }], {});
    expect(rows[0]?.lastUse).toBeNull();
  });

  it("formats JSON and human output from the same safe fields", () => {
    const rows: ResidencyOutputRow[] = [
      {
        model: "qwen-main",
        state: "loading",
        ttl: null,
        classification: "unknown",
        lastUse: null,
      },
    ];
    const json = formatResidencyOutput(rows, true);
    expect(JSON.parse(json)).toEqual(rows);
    expect(formatResidencyOutput(rows)).toContain("MODEL\tSTATE\tTTL\tCLASSIFICATION");
    expect(formatResidencyOutput(rows)).toContain("qwen-main\tloading\tnull\tunknown");
    expect(formatResidencyOutput(rows)).not.toContain("LAST_USE_ALIAS");
    expect(formatResidencyOutput(rows)).not.toMatch(/id|hash|token|prompt|response|content|command|proxy|ip|secret/i);
  });
});
