import { describe, it, expect } from "vitest";
import { normalizedVerifierName } from "../src/homeserver/ledger.js";

describe("normalizedVerifierName", () => {
  it("collapses fully ungraded sentinel combinations to null", () => {
    expect(normalizedVerifierName(null)).toBeNull();
    expect(normalizedVerifierName(" none + NONE(ungraded) ")).toBeNull();
  });

  it("preserves spelling for non-null mixed-case verifier names after trimming", () => {
    expect(normalizedVerifierName("  JSONVALID + Exact({\"ok\":true})  "))
      .toBe("JSONVALID + Exact({\"ok\":true})");
  });
});
