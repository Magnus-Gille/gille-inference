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

  it("documents the pi service key with the same env-var reference syntax as the example", () => {
    const exampleRaw = readFileSync(`${repoRoot}/deploy/pi-models.json.example`, "utf8");
    const config = JSON.parse(exampleRaw) as {
      providers: Record<string, { apiKey: string }>;
    };
    const apiKeyRef = config.providers["inference-local"]?.apiKey;
    expect(apiKeyRef).toBeDefined();

    const readme = readFileSync(`${repoRoot}/src/homeserver/README.md`, "utf8");

    // The README's inline reference to the config field must quote the exact env-var
    // reference used in deploy/pi-models.json.example (issue #15: the README previously
    // described the literal string "HS_API_KEY" — missing the leading "$" that pi actually
    // requires to resolve it as an environment-variable reference at spawn).
    expect(readme).toContain(`apiKey:"${apiKeyRef}"`);

    // Guard against regressing to the bare (non-"$"-prefixed) quoted form anywhere in the doc.
    expect(readme).not.toContain('"HS_API_KEY"');
  });
});
