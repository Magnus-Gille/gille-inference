import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("published client package", () => {
  it("ships the exact 1.3.4 client surface and license", () => {
    const output = execFileSync(process.execPath, ["scripts/verify-client-package.mjs"], {
      encoding: "utf8",
    });

    expect(output).toContain("client package release gate passed: gille-inference@1.3.4");
  }, 30_000);
});
