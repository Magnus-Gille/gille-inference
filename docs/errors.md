# What happens when something breaks — user-facing failure modes

**Status:** reference for the M5 home-server gateway's graceful-degradation behaviour (requirement R6).
**Audience:** external users of `inference.example.com`, client authors, and the "how degradation works" webpage blurb.
**Source of truth:** `src/homeserver/errors.ts` (envelopes + `classifyUpstreamError`), `src/homeserver/gateway.ts` (`handleChatProxy`), `src/homeserver/mcp.ts` (`runChatCompletion`), `client/hs.mjs` (rendering). Update this doc in the same PR if those change.

The design goal: a request that can't be served gets a **clear, distinct, OpenAI-shaped error** — never an opaque `500`, and never a silent hang or a half-answer that looks complete. Every error is the same envelope shape:

```json
{ "error": { "message": "…", "type": "…", "code": "…", "param": null } }
```

so any OpenAI-compatible client (and the bundled `hs` CLI) can read it uniformly.

## Failure modes

| HTTP | `code` | When it happens | What the user sees | Retryable? |
|------|--------|-----------------|--------------------|------------|
| **401** | `invalid_api_key` | Missing / wrong / revoked key | `Auth error: …` | No — fix the key |
| **403** | `model_not_allowed` | Key not permitted for that model (or an admin route) | `Auth error: …` | No — request access / pick an allowed model |
| **403** | `route_not_allowed` | Guest key hitting `/delegate` (owner-only) | `Auth error: …` | No |
| **400** | `model_not_found` | Model doesn't exist / isn't loaded | `Error: The model '…' does not exist or is not loaded.` | No — pick a model from `list_models` / `/v1/models` |
| **400** | `invalid_request_error` | Bad params (e.g. `max_tokens <= 0`) or a **malformed JSON body** | `Error: …` | No — fix the request |
| **404** | `not_found` | Unknown route / no such resource | `Error: …` | No — check the path |
| **413** | `payload_too_large` | Request body exceeds the size cap | `Error: …` | No — shrink the request |
| **402** | `credits_exhausted` | Lifetime credit budget spent (does **not** reset) | `Credits exhausted: …` | No — contact the operator |
| **429** | `rate_limit_exceeded` | RPM / TPM / daily-token budget hit, or public-surface throttle | `Rate limited: … (retry in Ns)` | **Yes** — wait `Retry-After` seconds |
| **503** | `server_busy` | GPU is busy serving others (guest preempted by owner) | `Server busy: … (retry in Ns)` | **Yes** — wait `Retry-After` seconds |
| **502** | `upstream_unavailable` | Model backend (LM Studio / llama-swap) refused/reset the connection — i.e. it's down, **or it returned a non-404 error** (its status + body are normalized to this, never echoed — they could carry internal detail) | `Backend unavailable: …` | **Yes** — retry once it's back up |
| **504** | `upstream_timeout` | Backend exceeded the call timeout — most often a **cold model load** swapping into VRAM | `Backend timeout: … (retry in Ns)` | **Yes** — wait `Retry-After` seconds, then retry |
| **500** | `internal_error` | Unexpected gateway fault | `Error: internal error` | Maybe — report it |

`429`, `503`, and `504` carry a **`Retry-After`** header (seconds); the `hs` CLI shows it as `(retry in Ns)`. `502` carries none by default — "the backend is down" isn't a "wait exactly N seconds" condition; retry once it recovers.

## Mid-stream failure (streaming `stream:true`)

Once a streaming response has started, the HTTP status (`200`) and headers are already on the wire — they **cannot** be changed to an error code. So if the model backend's stream is cut short (the backend crashes or resets mid-generation), the gateway emits a **terminal error frame** before closing, so the client can tell a *truncated* stream from a *clean finish*:

```
data: {"error":{"message":"The model backend stream ended unexpectedly — the response was truncated. Please retry.","type":"server_error","code":"upstream_error"}}

data: [DONE]

```

The `hs` CLI prints whatever partial content arrived, then `Stream truncated: …` on stderr and exits non-zero — the partial answer is never silently presented as complete. Other OpenAI-compatible clients should treat a `data:` frame carrying an `error` object as a failed completion.

This case is recorded in the content-blind request log with `outcome = "stream_failed"` (HTTP `200`, since that's what the client received).

## Billing invariant under failure

A request that does **not** produce a successful completion is **never billed**. On any upstream failure (refused / reset / timeout) or mid-stream abort, the credit reservation and the daily-quota estimate are reconciled to **zero** (the "C2" invariant). Failed calls cost the caller nothing. The same holds if the **client disconnects** mid-call: the gateway aborts the upstream generation (freeing the GPU rather than running it to completion) and bills `0`, recorded as the content-blind `client_closed` outcome.

## Privacy invariant under failure

All of the above is content-blind in the durable request log and `/metrics`: failure outcomes (`upstream_unavailable`, `upstream_timeout`, `stream_failed`, `client_closed`, …) are recorded as **labels only**. No prompt, completion, or per-user content is ever written to the metadata log or Prometheus on a failure path (the owner-only content log is unaffected and remains owner-tier-only).

## MCP `ask` tool

The MCP path (`runChatCompletion`) maps the same upstream failures to a structured tool error (`ok:false`, `code:"upstream_error"`) with a clear message, rather than throwing an unhandled error — so a Claude Code client sees a clean tool failure it can retry, not a transport-level `500`. The same zero-billing invariant applies.
