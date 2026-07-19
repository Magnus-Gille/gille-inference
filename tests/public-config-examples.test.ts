import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

describe("public configuration examples", () => {
  it("keeps the pi service key as an environment reference", () => {
    const raw = readFileSync(`${repoRoot}/deploy/pi-models.json.example`, "utf8");
    const config = JSON.parse(raw) as {
      providers: Record<string, { baseUrl: string; apiKey: string }>;
    };
    const provider = config.providers["inference-local"];

    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBe("http://127.0.0.1:18080/v1");
    expect(provider?.apiKey).toBe("$HS_API_KEY");
  });
});
