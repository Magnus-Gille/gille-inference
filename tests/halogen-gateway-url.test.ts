import { describe, expect, it } from "vitest";

import { parseGatewayBaseUrl } from "../src/homeserver/halogen-gateway-url.js";

const LOCAL = ["127.0.0.1", "198.51.100.23"];

describe("parseGatewayBaseUrl", () => {
  it.each([
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://198.51.100.23:8080",
    "http://mybox:8080",
  ])("accepts %s when local", (url) => {
    const local = url.includes("mybox") ? [...LOCAL, "mybox"] : LOCAL;
    expect(parseGatewayBaseUrl(url, local)).toBe(url);
  });

  it.each([
    ["path", "http://127.0.0.1:8080/admin"],
    ["credentials", "http://user:pass@127.0.0.1:8080"],
    ["missing scheme", "127.0.0.1:8080"],
    ["https", "https://127.0.0.1:8080"],
    ["missing port", "http://127.0.0.1"],
    ["bad port", "http://127.0.0.1:99999"],
    ["empty", ""],
  ])("rejects a URL with %s", (_name, url) => {
    expect(() => parseGatewayBaseUrl(url, LOCAL)).toThrow();
  });

  it("rejects a non-local host without network access", () => {
    expect(() => parseGatewayBaseUrl("http://203.0.113.7:8080", LOCAL)).toThrow(/not this box/);
  });
});
