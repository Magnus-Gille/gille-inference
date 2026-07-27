/**
 * Issue #87 — a successful JSON route must never turn an absent value into an
 * HTTP 2xx response with no bytes.  Keep this pure: the HTTP routes share the
 * same serialization boundary, so no model, key, or admission fixture is needed.
 */
import { describe, expect, it } from "vitest";
import { serializeJsonResponse } from "../src/homeserver/gateway.js";

describe("serializeJsonResponse", () => {
  it("turns an unserializable top-level response into a structured non-2xx failure", () => {
    const response = serializeJsonResponse(undefined);
    expect(response.status).toBe(500);
    expect(response.payload).not.toBe("");
    expect(JSON.parse(response.payload)).toEqual({
      error: {
        code: "internal_error",
        message: "internal error",
        type: "server_error",
        param: null,
      },
    });
  });

  it("preserves a concrete delegate outcome as a successful JSON payload", () => {
    expect(serializeJsonResponse({ delegated: false, escalate: true, decisionReason: "policy" })).toEqual({
      status: 200,
      payload: '{"delegated":false,"escalate":true,"decisionReason":"policy"}',
    });
  });
});
