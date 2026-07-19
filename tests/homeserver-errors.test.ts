import { describe, it, expect } from "vitest";
import { makeError, classifyUpstreamError, type ErrorCode } from "../src/homeserver/errors.js";

describe("error envelope", () => {
  it("server_busy: mandated message, type server_error, Retry-After header", () => {
    const env = makeError("server_busy", { retryAfterSeconds: 3 });
    expect(env.status).toBe(503);
    expect(env.body.error.type).toBe("server_error");
    expect(env.body.error.code).toBe("server_busy");
    expect(env.body.error.param).toBeNull();
    expect(env.body.error.message).toContain("not a problem with your request");
    expect(env.headers["Retry-After"]).toBe("3");
  });

  it("rate_limit_exceeded: sets X-RateLimit-* and Retry-After", () => {
    const env = makeError("rate_limit_exceeded", {
      retryAfterSeconds: 7,
      rateLimit: { limit: 60, remaining: 0, resetSeconds: 12 },
    });
    expect(env.status).toBe(429);
    expect(env.body.error.type).toBe("rate_limit_error");
    expect(env.headers["Retry-After"]).toBe("7");
    expect(env.headers["X-RateLimit-Limit"]).toBe("60");
    expect(env.headers["X-RateLimit-Remaining"]).toBe("0");
    expect(env.headers["X-RateLimit-Reset"]).toBe("12");
  });

  it("upstream_unavailable: 502 server_error, generic retry-shortly message", () => {
    const env = makeError("upstream_unavailable");
    expect(env.status).toBe(502);
    expect(env.body.error.type).toBe("server_error");
    expect(env.body.error.code).toBe("upstream_unavailable");
    expect(env.body.error.param).toBeNull();
    expect(env.body.error.message).toMatch(/backend.*unavailable/i);
    // No Retry-After on a 502 by default (the backend being down is not a "wait N seconds" signal).
    expect(env.headers["Retry-After"]).toBeUndefined();
  });

  it("upstream_timeout: 504 server_error WITH a Retry-After header and a 'loading' hint", () => {
    const env = makeError("upstream_timeout", { retryAfterSeconds: 5 });
    expect(env.status).toBe(504);
    expect(env.body.error.type).toBe("server_error");
    expect(env.body.error.code).toBe("upstream_timeout");
    expect(env.body.error.param).toBeNull();
    expect(env.body.error.message).toMatch(/timed out/i);
    expect(env.body.error.message).toMatch(/loading/i);
    expect(env.headers["Retry-After"]).toBe("5");
  });

  it("each code maps to the right status and a complete 4-field error body", () => {
    const expected: Record<ErrorCode, number> = {
      invalid_api_key: 401,
      model_not_allowed: 403,
      model_not_found: 400,
      invalid_request_error: 400,
      route_not_allowed: 403,
      not_found: 404,
      alias_exists: 409,
      invite_invalid: 409,
      rate_limit_exceeded: 429,
      credits_exhausted: 402,
      server_busy: 503,
      internal_error: 500,
      upstream_unavailable: 502,
      upstream_timeout: 504,
    };
    for (const code of Object.keys(expected) as ErrorCode[]) {
      const env = makeError(code);
      expect(env.status).toBe(expected[code]);
      // All four fields present
      expect(env.body.error).toHaveProperty("message");
      expect(env.body.error).toHaveProperty("type");
      expect(env.body.error).toHaveProperty("code");
      expect(env.body.error).toHaveProperty("param");
      expect(typeof env.body.error.message).toBe("string");
      expect(env.body.error.code).toBe(code);
    }
  });

  it("model_not_allowed / model_not_found set param 'model'", () => {
    expect(makeError("model_not_allowed").body.error.param).toBe("model");
    expect(makeError("model_not_found").body.error.param).toBe("model");
  });

  it("invalid_api_key is authentication_error 401", () => {
    const env = makeError("invalid_api_key");
    expect(env.status).toBe(401);
    expect(env.body.error.type).toBe("authentication_error");
  });

  it("classifyUpstreamError: an AbortSignal.timeout rejection → upstream_timeout", () => {
    const e = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(classifyUpstreamError(e)).toBe("upstream_timeout");
    // Manual-abort flavour (older Node / AbortController.abort()) is also a timeout-class signal.
    const e2 = new DOMException("This operation was aborted", "AbortError");
    expect(classifyUpstreamError(e2)).toBe("upstream_timeout");
  });

  it("classifyUpstreamError: a fetch TypeError (ECONNREFUSED / reset) → upstream_unavailable", () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(classifyUpstreamError(refused)).toBe("upstream_unavailable");
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(classifyUpstreamError(reset)).toBe("upstream_unavailable");
    // A bare fetch TypeError with no cause code is still a connection-class failure.
    expect(classifyUpstreamError(new TypeError("fetch failed"))).toBe("upstream_unavailable");
  });

  it("classifyUpstreamError: UND_ERR_CONNECT_TIMEOUT → upstream_unavailable (M1: failed TCP connect = backend unreachable, not a slow response)", () => {
    // A failed TCP connection attempt is upstream_unavailable (502), NOT upstream_timeout (504).
    // The backend was unreachable — we never sent a request, so there is no "timeout" of a
    // pending response. UND_ERR_CONNECT_TIMEOUT is in CONNECTION_CODES; the early-return that
    // mapped it to upstream_timeout was a bug (M1 fix).
    const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    expect(classifyUpstreamError(e)).toBe("upstream_unavailable");
  });

  it("classifyUpstreamError: TimeoutError / AbortError still → upstream_timeout (AbortSignal.timeout fired)", () => {
    // Timeout from the gateway's own AbortSignal deadline remains upstream_timeout (504) — the
    // connection was established but the backend was too slow to respond.
    const te = new DOMException("timed out", "TimeoutError");
    expect(classifyUpstreamError(te)).toBe("upstream_timeout");
    const ae = new DOMException("aborted", "AbortError");
    expect(classifyUpstreamError(ae)).toBe("upstream_timeout");
  });

  it("classifyUpstreamError: an unrelated error is NOT classified (→ null, falls through to 500)", () => {
    expect(classifyUpstreamError(new Error("some logic bug"))).toBeNull();
    expect(classifyUpstreamError("not even an error")).toBeNull();
  });

  it("message override is honoured and model id can be interpolated", () => {
    const env = makeError("model_not_allowed", {
      message: "Your API key is not permitted to use model 'm2'.",
    });
    expect(env.body.error.message).toContain("m2");
  });
});
