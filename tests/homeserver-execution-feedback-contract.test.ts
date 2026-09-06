import { describe, expect, it } from "vitest";
import {
  EXECUTION_FEEDBACK_EPOCH,
  EXECUTION_FEEDBACK_VALUES,
  EXECUTION_TRAFFIC_PURPOSES,
  parseExecutionFeedback,
  parseExecutionTrafficPurpose,
} from "../src/homeserver/execution-feedback-contract.js";

describe("execution feedback contract", () => {
  it("exposes the closed enums and epoch", () => {
    expect(EXECUTION_TRAFFIC_PURPOSES).toEqual(["organic", "evaluation", "synthetic"]);
    expect(EXECUTION_FEEDBACK_VALUES).toEqual(["pass", "partial", "redo", "wrong"]);
    expect(EXECUTION_FEEDBACK_EPOCH).toBe("organic-exact-feedback-v1");
  });

  it("defaults omitted traffic purpose to unknown and accepts only closed values", () => {
    expect(parseExecutionTrafficPurpose(undefined)).toEqual({ ok: true, value: "unknown" });
    for (const value of EXECUTION_TRAFFIC_PURPOSES) {
      expect(parseExecutionTrafficPurpose(value)).toEqual({ ok: true, value });
    }

    for (const value of ["unknown", null, {}, [], 1, "Organic"]) {
      expect(parseExecutionTrafficPurpose(value)).toEqual({ ok: false });
    }
  });

  it("accepts exactly one usefulness field", () => {
    for (const usefulness of EXECUTION_FEEDBACK_VALUES) {
      expect(parseExecutionFeedback({ usefulness })).toEqual({ ok: true, value: usefulness });
    }
  });

  it("rejects malformed shapes without echoing caller data", () => {
    for (const value of [null, [], "pass", 1, true]) {
      expect(parseExecutionFeedback(value)).toEqual({ ok: false, error: "invalid_shape" });
    }

    for (const value of [{}, { usefulness: undefined }, { usefulness: null }, { usefulness: "unknown" }, { usefulness: 1 }]) {
      expect(parseExecutionFeedback(value)).toEqual({ ok: false, error: "invalid_usefulness" });
    }

    const maliciousKey = "prompt_contents_that_must_not_be_echoed";
    const result = parseExecutionFeedback({ usefulness: "pass", [maliciousKey]: "secret text" });
    expect(result).toEqual({ ok: false, error: "unknown_field" });
    expect(JSON.stringify(result)).not.toContain(maliciousKey);
    expect(JSON.stringify(result)).not.toContain("secret text");
  });

  it("does not treat inherited fields as submitted JSON fields", () => {
    const inheritedUsefulness = Object.create({ usefulness: "pass" }) as object;
    expect(parseExecutionFeedback(inheritedUsefulness)).toEqual({ ok: false, error: "invalid_usefulness" });

    const inheritedUnknown = Object.create({ notes: "private notes" }) as Record<string, unknown>;
    inheritedUnknown.usefulness = "pass";
    expect(parseExecutionFeedback(inheritedUnknown)).toEqual({ ok: true, value: "pass" });
  });

  it("rejects own extra fields, including prototype-shaped names", () => {
    for (const value of [
      { usefulness: "pass", notes: "free text" },
      { usefulness: "pass", timestamp: "2026-09-06T00:00:00Z" },
      { usefulness: "pass", identity: "owner@example.test" },
    ]) {
      expect(parseExecutionFeedback(value)).toEqual({ ok: false, error: "unknown_field" });
    }

    const explicitProtoKey = JSON.parse('{"usefulness":"pass","__proto__":"secret"}') as unknown;
    expect(parseExecutionFeedback(explicitProtoKey)).toEqual({ ok: false, error: "unknown_field" });
  });
});
