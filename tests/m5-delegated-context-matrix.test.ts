import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("M5 delegated-context matrix", () => {
  it("has a complete, evidence-backed and secret-free support declaration", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/check-m5-delegated-contexts.mjs"],
      { encoding: "utf8" },
    );

    expect(output).toContain("M5 delegated-context matrix check passed");
    expect(output).toContain("4 contexts");
  });
});
