import { describe, expect, it } from "vitest";
import { shouldCaptureOwnerContent } from "../src/homeserver/owner-log.js";

describe("full owner-content logging eligibility", () => {
  it.each([
    ["on", "owner", "minted-key-hash", true],
    ["off", "owner", "minted-key-hash", false],
    ["on", "owner", null, false],
    ["off", "owner", null, false],
    ["on", "guest", "minted-key-hash", false],
    ["off", "guest", "minted-key-hash", false],
    ["on", "guest", null, false],
    ["off", "guest", null, false],
  ] as const)("mode=%s tier=%s keyHash=%s permits capture=%s", (mode, tier, keyHash, expected) => {
    expect(shouldCaptureOwnerContent(mode, { tier, keyHash })).toBe(expected);
  });
});
