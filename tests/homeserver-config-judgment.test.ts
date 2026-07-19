import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

/**
 * Config-loader coverage for the #168 trusted-verifier whitelist knob. Verifies the LOADER
 * semantics that getVerdict's admissibility filter relies on: `HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS`
 * must yield an EMPTY set when unset AND when set to "" (empty is the intended honest default), and
 * must parse a CSV into a trimmed name list. The verdict-hygiene unit tests pass explicit
 * PolicyConfig objects, so without this a config-loader regression would go uncaught.
 */

const KEYS = ["HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS", "HOMESERVER_JUDGMENT_QUALITY_TASK_TYPES"];
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

describe("trusted-judgment-verifier whitelist config loader (#168)", () => {
  it("defaults trustedVerifiersForJudgment to an EMPTY set when the env var is UNSET", () => {
    expect(loadConfig().policy.trustedVerifiersForJudgment).toEqual([]);
  });

  it("stays EMPTY when the env var is set to an empty string (empty IS the intended default)", () => {
    process.env["HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS"] = "";
    resetConfig();
    expect(loadConfig().policy.trustedVerifiersForJudgment).toEqual([]);
  });

  it("parses a CSV override into a trimmed verifier-name list", () => {
    process.env["HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS"] = "gtReview, reviewGrader ,codeReviewGT";
    resetConfig();
    expect(loadConfig().policy.trustedVerifiersForJudgment).toEqual([
      "gtReview",
      "reviewGrader",
      "codeReviewGT",
    ]);
  });

  it("keeps judgmentQualityTaskTypes defaulting to code-review, independent of the whitelist knob", () => {
    process.env["HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS"] = "gtReview";
    resetConfig();
    const p = loadConfig().policy;
    expect(p.judgmentQualityTaskTypes).toEqual(["code-review"]);
    expect(p.trustedVerifiersForJudgment).toEqual(["gtReview"]);
  });
});
