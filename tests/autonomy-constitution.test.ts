import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { microRoutingAdmission } from "../src/homeserver/autonomy-constitution.js";

const root = new URL("../contracts/grimnir-autonomy-v2/", import.meta.url).pathname;
const attestations = join(root, "owner-attestations.json");
describe("ADR-008 micro-routing admission", () => {
  it("refuses the checked-in disarmed v2 registry", () => {
    expect(microRoutingAdmission(join(root, "constitution.json"), join(root, "coverage.json"), attestations)).toEqual({ allowed: false, reason: "coverage-disarmed" });
  });
  it("fails closed when the constitution is unavailable or tampered", () => {
    const dir = mkdtempSync(join(tmpdir(), "constitution-"));
    const bad = join(dir, "bad.json"); writeFileSync(bad, "{}");
    expect(microRoutingAdmission(bad, join(root, "coverage.json"), attestations).allowed).toBe(false);
  });
});
