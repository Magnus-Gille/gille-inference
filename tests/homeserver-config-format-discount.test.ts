import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, resetConfig } from "../src/homeserver/config.js";

/**
 * Config-loader coverage for the #233 format-only-evidence discount knobs. Verifies the LOADER
 * semantics that ledger.ts's evidenceWeight() relies on: the flag defaults off (behaviour-
 * preserving), the task-type list follows the same "unset → default, empty → disable" convention
 * as HOMESERVER_JUDGMENT_QUALITY_TASK_TYPES, and the weight is clamped to [0,1] — an operator
 * mistake (a value >1 or negative) must never push successRate outside [0,1] (Codex review finding
 * on PR #237: HOMESERVER_FORMAT_DISCOUNT_WEIGHT was unbounded).
 */

const KEYS = [
  "HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE",
  "HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES",
  "HOMESERVER_FORMAT_DISCOUNT_WEIGHT",
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

describe("format-only-evidence discount config loader (#233)", () => {
  it("defaults discountFormatOnlyEvidence to false (behaviour-preserving) when unset", () => {
    expect(loadConfig().policy.discountFormatOnlyEvidence).toBe(false);
  });

  it("turns on only for the exact string 'on'", () => {
    process.env["HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE"] = "on";
    resetConfig();
    expect(loadConfig().policy.discountFormatOnlyEvidence).toBe(true);

    process.env["HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE"] = "true";
    resetConfig();
    expect(loadConfig().policy.discountFormatOnlyEvidence).toBe(false);
  });

  it("defaults formatOnlyDiscountTaskTypes to classify/qa-factual/triage/claim-verify when unset", () => {
    expect(loadConfig().policy.formatOnlyDiscountTaskTypes).toEqual([
      "classify",
      "qa-factual",
      "triage",
      "claim-verify",
    ]);
  });

  it("stays EMPTY when set to an empty string (disables the discount for every type)", () => {
    process.env["HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES"] = "";
    resetConfig();
    expect(loadConfig().policy.formatOnlyDiscountTaskTypes).toEqual([]);
  });

  it("parses a CSV override", () => {
    process.env["HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES"] = "classify, triage";
    resetConfig();
    expect(loadConfig().policy.formatOnlyDiscountTaskTypes).toEqual(["classify", "triage"]);
  });

  it("defaults formatOnlyDiscountWeight to 0.5 when unset", () => {
    expect(loadConfig().policy.formatOnlyDiscountWeight).toBe(0.5);
  });

  it("accepts an in-range override", () => {
    process.env["HOMESERVER_FORMAT_DISCOUNT_WEIGHT"] = "0.25";
    resetConfig();
    expect(loadConfig().policy.formatOnlyDiscountWeight).toBe(0.25);
  });

  it("clamps a value above 1 down to 1", () => {
    process.env["HOMESERVER_FORMAT_DISCOUNT_WEIGHT"] = "5";
    resetConfig();
    expect(loadConfig().policy.formatOnlyDiscountWeight).toBe(1);
  });

  it("clamps a negative value up to 0", () => {
    process.env["HOMESERVER_FORMAT_DISCOUNT_WEIGHT"] = "-1";
    resetConfig();
    expect(loadConfig().policy.formatOnlyDiscountWeight).toBe(0);
  });

  it("falls back to the default for a non-numeric value", () => {
    process.env["HOMESERVER_FORMAT_DISCOUNT_WEIGHT"] = "not-a-number";
    resetConfig();
    expect(loadConfig().policy.formatOnlyDiscountWeight).toBe(0.5);
  });
});
