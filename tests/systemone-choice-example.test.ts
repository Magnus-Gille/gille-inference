import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSystemOneBody, validateSystemOneResponse } from "../src/homeserver/systemone-request.js";

describe("customer-facing choice example", () => {
  it("parses the actual portal request and validates its illustrative response", () => {
    const html = readFileSync(new URL("../src/homeserver/portal.html", import.meta.url), "utf8");
    const raw = html.match(/<pre id="systemone-choice-request">([\s\S]*?)<\/pre>/)?.[1];
    expect(raw, "portal must provide a copyable choice request").toBeDefined();
    expect(Buffer.byteLength(raw!, "utf8")).toBeLessThanOrEqual(8 * 1024);
    const request = parseSystemOneBody(raw!);
    expect(request.body.questions).toHaveProperty("route.type", "choice");
    const response = html.match(/<pre aria-label="Illustrative choice response">([\s\S]*?)<\/pre>/)?.[1];
    expect(response).toBeDefined();
    expect(validateSystemOneResponse(JSON.parse(response!), request)).toBeGreaterThan(0);
  });
});
