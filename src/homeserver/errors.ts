import type { ServerResponse } from "node:http";

/**
 * Uniform OpenAI-shaped error envelope for the gateway.
 *
 * Every error the inference / auth surface returns goes through makeError() so clients
 * (which already speak the OpenAI error shape) get a consistent `{ error: {...} }` body
 * with the right status, headers (Retry-After / X-RateLimit-*), and a canonical message.
 * No more bare `{ error: "string" }`.
 */

export type ErrorCode =
  | "invalid_api_key" // 401
  | "model_not_allowed" // 403
  | "model_not_found" // 400
  | "invalid_request_error" // 400 (generic bad request — bad params)
  | "payload_too_large" // 413 (upload body exceeds the size cap)
  | "route_not_allowed" // 403 (principal not permitted on this route)
  | "not_found" // 404 (no such route / resource)
  | "alias_exists" // 409 (duplicate key alias on mint)
  | "invite_invalid" // 409 (unknown OR already-used invite code — uniform, no enumeration leak)
  | "learning_task_conflict" // 409 (durable task/request/attempt identity is already admitted)
  | "rate_limit_exceeded" // 429
  | "credits_exhausted" // 402 (lifetime credit budget spent)
  | "server_busy" // 503
  | "upstream_unavailable" // 502 (model backend refused / reset the connection)
  | "upstream_timeout" // 504 (model backend timed out — may be loading a model)
  | "internal_error"; // 500 (generic, detail logged server-side only)

export interface OpenAIError {
  error: { message: string; type: string; code: ErrorCode; param: string | null };
}

export interface ErrorEnvelope {
  status: number;
  headers: Record<string, string>;
  body: OpenAIError;
}

interface CodeSpec {
  status: number;
  type: string;
  param: string | null;
  message: string;
}

const SPECS: Record<ErrorCode, CodeSpec> = {
  invalid_api_key: {
    status: 401,
    type: "authentication_error",
    param: null,
    message: "Incorrect API key provided. Check your key or contact the operator.",
  },
  model_not_allowed: {
    status: 403,
    type: "invalid_request_error",
    param: "model",
    message: "Your API key is not permitted to use this model.",
  },
  model_not_found: {
    status: 400,
    type: "invalid_request_error",
    param: "model",
    message: "The model does not exist or is not loaded.",
  },
  invalid_request_error: {
    status: 400,
    type: "invalid_request_error",
    param: null,
    message: "The request is invalid. Check your parameters.",
  },
  payload_too_large: {
    status: 413,
    type: "invalid_request_error",
    param: null,
    message: "The uploaded file is too large.",
  },
  route_not_allowed: {
    status: 403,
    type: "invalid_request_error",
    param: null,
    message: "Your API key is not permitted to use this endpoint.",
  },
  not_found: {
    status: 404,
    type: "invalid_request_error",
    param: null,
    message: "Unknown route or resource.",
  },
  alias_exists: {
    status: 409,
    type: "invalid_request_error",
    param: "alias",
    message: "A key with that alias already exists. Choose a different alias.",
  },
  invite_invalid: {
    // Deliberately uniform across "unknown code" and "already redeemed" so the redeem
    // endpoint cannot be used as a user-enumeration oracle. Never carry a per-case message.
    status: 409,
    type: "invalid_request_error",
    param: null,
    message: "This invite code is invalid or has already been used.",
  },
  learning_task_conflict: {
    status: 409,
    type: "invalid_request_error",
    param: "learningTaskStamp",
    message: "This learning-task request, attempt, or idempotency identity is already admitted.",
  },
  rate_limit_exceeded: {
    status: 429,
    type: "rate_limit_error",
    param: null,
    message: "Rate limit reached. Retry after a moment.",
  },
  credits_exhausted: {
    status: 402,
    type: "insufficient_quota",
    param: null,
    message:
      "Your credit budget is exhausted. Contact the operator for more credits — this cap does not reset.",
  },
  server_busy: {
    status: 503,
    type: "server_error",
    param: null,
    message:
      "The server is busy serving other requests. This is not a problem with your request — please retry after a moment.",
  },
  upstream_unavailable: {
    // The model backend (LM Studio / llama-swap) refused or reset the connection. This is a
    // distinct, honest signal — NOT a generic 500 — so the caller knows the box is up but the
    // backend is down, and that a retry once it recovers is the right move. No Retry-After by
    // default: "down" is not a "wait exactly N seconds" condition.
    status: 502,
    type: "server_error",
    param: null,
    message: "The model backend is unavailable — please retry shortly.",
  },
  upstream_timeout: {
    // The upstream call exceeded the gateway's call timeout. The most common cause is a cold
    // model load (LM Studio swapping a model into VRAM) exceeding the deadline, hence the hint —
    // a short retry usually succeeds once the model is resident. Carries Retry-After (set by the
    // caller from config) so well-behaved clients back off instead of hammering during the load.
    status: 504,
    type: "server_error",
    param: null,
    message:
      "The model backend timed out (it may be loading a model) — please retry in a few seconds.",
  },
  internal_error: {
    status: 500,
    type: "server_error",
    param: null,
    message: "internal error",
  },
};

export interface MakeErrorOptions {
  message?: string;
  param?: string | null;
  retryAfterSeconds?: number;
  rateLimit?: { limit: number; remaining: number; resetSeconds: number };
}

/**
 * Build the canonical envelope for a code. Defaults are taken from the spec table; the
 * caller may override message/param and attach Retry-After / rate-limit headers.
 */
export function makeError(code: ErrorCode, opts: MakeErrorOptions = {}): ErrorEnvelope {
  const spec = SPECS[code];
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (opts.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(opts.retryAfterSeconds);
  }
  if (opts.rateLimit) {
    headers["X-RateLimit-Limit"] = String(opts.rateLimit.limit);
    headers["X-RateLimit-Remaining"] = String(opts.rateLimit.remaining);
    headers["X-RateLimit-Reset"] = String(opts.rateLimit.resetSeconds);
  }

  return {
    status: spec.status,
    headers,
    body: {
      error: {
        message: opts.message ?? spec.message,
        type: spec.type,
        code,
        param: opts.param !== undefined ? opts.param : spec.param,
      },
    },
  };
}

/**
 * Classify a thrown error from an upstream `fetch()` to the model backend into the matching
 * graceful-degradation error code, or null if it is NOT a recognised upstream connection /
 * timeout failure (caller then falls through to a generic 500 / internal_error).
 *
 *   • A timeout (the gateway's AbortSignal.timeout fired) surfaces as a DOMException with
 *     name "TimeoutError" (Node 18+) or "AbortError" (manual abort / older runtimes) →
 *     upstream_timeout. This ALSO covers a cold model-load that exceeds the call timeout.
 *   • A connection refusal / reset surfaces as a fetch TypeError, usually with cause.code of
 *     ECONNREFUSED / ECONNRESET / ECONNABORTED / EPIPE / UND_ERR_SOCKET / UND_ERR_CONNECT_TIMEOUT
 *     → upstream_unavailable. UND_ERR_CONNECT_TIMEOUT is a FAILED TCP connect (backend unreachable),
 *     NOT a slow response — it belongs here, NOT in the AbortSignal timeout bucket.
 *     A bare fetch TypeError ("fetch failed") with no cause is still treated as a connection
 *     failure (it is what an unreachable backend produces).
 *
 * Deliberately conservative: anything that is not clearly an upstream connection/timeout failure
 * returns null so a genuine logic bug is not masked as a friendly 502/504 (it stays a 500 with
 * the detail logged server-side).
 */
export function classifyUpstreamError(err: unknown): "upstream_unavailable" | "upstream_timeout" | null {
  if (typeof err !== "object" || err === null) return null;

  const name = (err as { name?: unknown }).name;
  if (name === "TimeoutError" || name === "AbortError") return "upstream_timeout";

  // A fetch() network failure is a TypeError. Match it whether or not a cause code is present.
  if (err instanceof TypeError) {
    const code = (err as { cause?: { code?: unknown } }).cause?.code;
    const CONNECTION_CODES = new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ECONNABORTED",
      "EPIPE",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "UND_ERR_SOCKET",
      // UND_ERR_CONNECT_TIMEOUT: the TCP connect attempt itself timed out — the backend is
      // unreachable (502 upstream_unavailable), NOT a slow response (504 upstream_timeout).
      // A failed connection establishment means we never sent a request at all.
      "UND_ERR_CONNECT_TIMEOUT",
    ]);
    if (code === undefined || (typeof code === "string" && CONNECTION_CODES.has(code))) {
      return "upstream_unavailable";
    }
  }
  return null;
}

/** Write an ErrorEnvelope to a ServerResponse, applying all envelope headers. */
export function sendError(res: ServerResponse, env: ErrorEnvelope): void {
  res.writeHead(env.status, env.headers);
  res.end(JSON.stringify(env.body));
}
