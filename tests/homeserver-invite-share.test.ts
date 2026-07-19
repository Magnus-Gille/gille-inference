import { describe, it, expect } from "vitest";
import { shareBlock } from "../src/homeserver/cli.js";

describe("shareBlock", () => {
  const BASE = "https://inference.example.com";
  const CODE = "inv_abc123XYZ";
  const NAME = "alice";

  it("contains the base URL", () => {
    const block = shareBlock(NAME, CODE, 10_000_000, BASE);
    expect(block).toContain(BASE);
  });

  it("contains the friend name", () => {
    const block = shareBlock(NAME, CODE, 10_000_000, BASE);
    expect(block).toContain(NAME);
  });

  it("contains the formatted credit count (comma-separated)", () => {
    const block = shareBlock(NAME, CODE, 10_000_000, BASE);
    expect(block).toContain("10,000,000");
  });

  it("contains the redeem instruction", () => {
    const block = shareBlock(NAME, CODE, 10_000_000, BASE);
    expect(block).toContain("Have an invite code?");
    expect(block).toContain("Create my key");
  });

  it("contains the invite code itself", () => {
    const block = shareBlock(NAME, CODE, 10_000_000, BASE);
    expect(block).toContain(CODE);
  });

  it("does NOT contain anything that looks like a raw secret beyond the passed code", () => {
    // The block should only contain the code we explicitly passed — not any
    // other bearer-token-shaped value (hs_guest_* / hs_owner_* prefixes).
    const block = shareBlock(NAME, CODE, 10_000_000, BASE);
    expect(block).not.toMatch(/hs_guest_/);
    expect(block).not.toMatch(/hs_owner_/);
  });

  it("shows 'unlimited' when credits = 0", () => {
    const block = shareBlock(NAME, CODE, 0, BASE);
    expect(block).toContain("unlimited");
    expect(block).not.toContain("0 tokens");
  });

  it("strips trailing slash from baseUrl", () => {
    const block = shareBlock(NAME, CODE, 5_000, "https://inference.example.com/");
    expect(block).not.toContain("inference.example.com//");
    expect(block).toContain("https://inference.example.com");
  });

  it("uses the passed code in a labeled 'Code:' line", () => {
    const block = shareBlock(NAME, CODE, 1_000, BASE);
    expect(block).toMatch(/Code:\s+inv_abc123XYZ/);
  });
});
