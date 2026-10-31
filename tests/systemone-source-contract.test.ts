import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("pins the exact native adapter shipped by the decision-model release contract", () => {
  const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url));
  const digest = createHash("sha256").update(read("scripts/systemone-native-server.py")).digest("hex");
  expect(read("deploy/specs/bespoke-nimble-9b.yaml").toString()).toContain(`Adapter SHA256: ${digest}`);
  expect(read("docs/systemone-customer-access.md").toString()).toContain(`adapter SHA256 \`${digest}\``);
});
