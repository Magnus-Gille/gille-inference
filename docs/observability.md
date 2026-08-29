# Observability & privacy (M5 inference gateway)

The gateway's observability layer is **content-blind and pseudonymous by design**. It lets the
operator answer fleet questions — *how many distinct users, how concurrent, time-to-first-token,
throughput, outcomes* — **without ever storing any non-owner prompt or response content**.

There are four data sinks. Three are metadata-only; one (the owner-log) is the single place content
can live, and it is strictly owner-only.

## 1. `request_log` (SQLite) — durable, metadata-only, for EVERYONE

`src/homeserver/request-log.ts`. One row per request, written best-effort from **both** the HTTP
path (`gateway.ts`) and the MCP path (`mcp.ts`). A write failure can never fail, slow, or alter a
request (every insert is wrapped in try/catch).

**Stored (metadata only):**

| column | meaning |
|---|---|
| `id` | request id (PK) |
| `ts` | epoch ms |
| `alias` | **the pseudonym** — the per-key alias (e.g. `alice`), the identity of record |
| `tier` | `owner` \| `guest` \| null |
| `key_hash` | sha256 of the minted key (nullable) — for the **owner's own** joins; never the raw key |
| `model` | canonical model id, or `none`/`unknown` (never a raw user string) |
| `route`, `status`, `outcome`, `error_class` | request shape + result |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | usage counts |
| `queue_wait_ms`, `ttft_ms`, `total_ms`, `admission` | timing + admission outcome |

**Never stored:** prompt text, response text, message content, message arrays, bearer tokens, IP
addresses. There is **no content column at all** — the schema (and the `requestLogColumns()`
allow-list it is built from) makes content capture impossible by construction, and a test asserts
no `prompt`/`response`/`messages`/`completion`/`content`/`body`/`text` column can ever exist.

**Identity is the pseudonym `alias`** (per-key, operator-chosen). `key_hash` is an optional hash the
owner can use to join their own rows; the raw plaintext key is never stored anywhere.

Gate: `HOMESERVER_REQUEST_LOG` (`on` | `off`, default `on`).

### MCP `ask` writes TWO rows — transport `/mcp` vs inference `/mcp/ask`

A single MCP `ask` tools/call produces **two** distinct request_log rows, separated by `route`:

| `route` | written by | meaning |
|---|---|---|
| `/mcp` | gateway `handleRequest` finally | the **transport** row — the JSON-RPC POST envelope (always HTTP 200 for a well-formed call, even when the `ask` itself failed) |
| `/mcp/ask` | `runChatCompletion` | the **inference** row — the actual model call, carrying the real outcome (`ok` / `rate_limited` / `busy` / `error`), token usage, and the canonical model label |

The two routes mean the rows are **unambiguous and never conflated**: count MCP inference activity
via `route = '/mcp/ask'` (not `/mcp`), so the transport envelope does not inflate inference counts.
**Every** `ask` attempt writes exactly one `/mcp/ask` row — including pre-admission refusals
(model-not-allowed, credits/quota exhausted → `rate_limited`, admission reject → `busy`), which also
increment the matching `/metrics` counter (`homeserver_rate_limited_total{surface="quota"}` /
`homeserver_admission_rejections_total{lane}`). A failed `ask` is therefore never hidden behind the
transport's HTTP 200.

```sql
-- MCP inference outcomes (NOT the transport envelope)
SELECT outcome, COUNT(*) FROM request_log WHERE route = '/mcp/ask' GROUP BY outcome;
```

Example owner queries:

```sql
-- distinct users in the last 24h
SELECT COUNT(DISTINCT alias) FROM request_log WHERE ts > (strftime('%s','now')-86400)*1000;
-- p50/p95 time-to-first-token per model (streaming)
SELECT model, COUNT(*) , AVG(ttft_ms) FROM request_log WHERE ttft_ms IS NOT NULL GROUP BY model;
-- outcomes breakdown
SELECT outcome, COUNT(*) FROM request_log GROUP BY outcome;
```

## 2. `/metrics` (Prometheus) — aggregate, content-blind, NO per-user labels

`src/homeserver/metrics.ts`. Counters/histograms/gauges only; labels are restricted to low-
cardinality, content-blind values (`model`, `outcome`, `tier`, `direction`, `lane`, `surface`).
**No per-user labels** — the per-user dimension lives in the SQLite `request_log` (queryable by the
owner), deliberately never in Prometheus.

New series in this layer:

- `homeserver_ttft_seconds{model}` — time-to-first-token histogram (streaming requests only).
- `homeserver_inflight_requests` / `homeserver_inflight_by_lane{lane}` — current in-flight gauge,
  driven by admission acquire/release.
- `homeserver_poison_clear_total{model,outcome}` — recurrent-model unloads triggered by an abrupt
  client disconnect (the Qwen3-Next `?????` resilience fix; `outcome` = `ok`|`failed`). A rising
  `failed` count means the box could not self-heal a dirty recurrent model and may need a manual
  restart. See `docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md`.

## 3. `adoption_evidence` (SQLite) — declared M5-agent adoption, content-blind

`src/homeserver/adoption-evidence.ts`. This is a narrow, opt-in observation written by the
owner-agent MCP tool `record_adoption_evidence` (or `m5 adoption report`). It exists because a
healthy gateway/request count does **not** prove that eligible implementation work actually used
M5 rather than silently falling back to a frontier model.

Every report has only these closed, low-cardinality fields:

| field | allowed values / meaning |
|---|---|
| `harness` | `claude`, `codex_cli`, `codex_app`, `pi`, `direct_cli`, `evaluation_runner` |
| `execution_mode` | `ask`, `code_loop`, `delegate` |
| `traffic_purpose` | `organic`, `evaluation`, `synthetic` |
| `result` | `completed`, `refused`, `failed`, `not_attempted` |
| `deterministic_check` | `pass`, `fail`, `not_run` |
| `reviewer_usefulness` | `pass`, `partial`, `redo`, `wrong`, `not_reported` |
| `fallback_reason` | closed reason enum, including **separate** `m5_tool_missing` and `m5_auth_unavailable` |
| `eligible_opportunities` | non-negative L1-declared count; `0` means the denominator was unknown, never inferred from raw call volume |

The closed cross-field contract is:

- `completed` uses `fallback_reason=none`.
- `failed` uses a non-`none` fallback and may retain an observed deterministic-check or reviewer
  outcome. This is how an unreachable attempt with a separately verified fallback, or a metered
  but unusable partial review, remains visible.
- `refused` and `not_attempted` use a non-`none` fallback with
  `deterministic_check=not_run` and `reviewer_usefulness=not_reported`, because no local result was
  available to assess.

**Never stored or accepted:** prompt/output text, file paths, repository names, aliases, key hashes,
user/session IDs, free-text notes, or caller-provided timestamps. The writer rejects unknown fields
before storage. It has no event ID or precise timestamp: the server derives only a UTC calendar day
for the rolling-week query. Accepted and rejected authenticated report calls deliberately suppress
the normal per-request access/request/owner logs, so this table cannot be correlated to a principal
or an exact transport time. This makes the reporting tool a deliberate narrow audit blind spot;
it is bounded by a transient per-key rate limit and a 25-row server-day cap. Rejections expose only
the stable content-free reason codes `invalid_report`, `principal_rate_limited`,
`daily_capacity_reached`, or `storage_unavailable`; they never echo input or expose a credential,
principal, request, database, or path detail. `daily_capacity_reached` is an expected non-fatal
outcome: the inference result remains valid, the telemetry row is dropped, and callers should not
retry until the next UTC day. Other rejection reasons remain hard tool errors so malformed or
unavailable telemetry is visible.

An `invalid_report` response also carries one fixed content-blind diagnostic: `invalid_shape`,
`unknown_field`, `invalid_field` plus a known schema field, or `invalid_invariant` plus one of the
documented fixed invariant codes. Unknown caller keys are never returned, because a key could
itself contain a path, identity, or task text.

The weekly Heimdall poster (`scripts/post-m5-adoption-panel.ts`) has four separate panels:

- **MEASURED — organic M5 agent adoption:** only `traffic_purpose=organic`, by harness.
- **MEASURED — organic M5 agent adoption by harness:** closed, content-free per-harness rows
  alongside the fleet total.
- **MEASURED — organic M5 fallback reasons:** closed aggregate counts, including tool/auth gaps.
- **LAB — evaluation and synthetic M5 evidence:** formal evaluation/probe traffic, never added to
  the primary organic panel.

Use the maturity labels literally:

- **MEASURED** means a number came from submitted reports; an empty panel is not evidence of zero
  eligible work.
- **ENFORCED** means the schema rejects content/high-cardinality fields and the primary query
  filters out evaluation/synthetic traffic.
- **SHADOW** means adoption measurement itself does not route, block, or authorize work. It cannot
  prove quality, production autonomy, cost savings, or a routing policy change.

The initial review is deliberately not a raw-call target: by **2026-08-28**, review whether at
least **20 known organic eligible opportunities** have been reported and whether useful completions
(`pass` or `partial`, without a deterministic-check failure) are at least **60% of attempted
delegations**. Reconsider the measure and the adoption path then; do not optimize the number of
reports.

## 4. `owner_request_log` (SQLite) — the ONLY content sink, owner-only

`src/homeserver/owner-log.ts`. This is the **only** place request/response content is captured, and
it is captured **only** for the operator's own real, deliberately-minted owner keys. The guard is:

```
tier === "owner" && keyHash !== null
```

which excludes implicit-admin and legacy static admins (both `keyHash === null`) and **never** logs
guests. Gate: `HOMESERVER_OWNER_REQUEST_LOG` (`on` | `off`, default `on`). The observability layer
does not change this guard or widen content capture.

## Trusted-catalogue model labels

For empty-allow-list (owner/admin) keys, the model label is validated against a short-TTL cache of
**resident** model ids (the trusted backend catalogue). A known model is recorded with its id; an
unknown/arbitrary string collapses to `unknown` — a raw, user-controlled model string is never used
as a metric label or a log value. The catalogue is read synchronously and refreshed in the
background, so it never blocks the request hot path.

## Retention & rotation

`request_log` and `owner_request_log` are unbounded by default. Suggested operator hygiene:

- **`request_log` (metadata):** keep ~90 days; it is small and content-blind. Prune with e.g.
  `DELETE FROM request_log WHERE ts < (strftime('%s','now')-90*86400)*1000;` on a cron/`VACUUM`.
- **`owner_request_log` (content):** the most sensitive table — keep the shortest window you find
  useful (e.g. 30 days) or set `HOMESERVER_OWNER_REQUEST_LOG=off` if you don't need content capture.
  Prune by `ts` and `VACUUM`.
- **`adoption_evidence` (content-blind):** the canonical retention registry enforces its
  predeclared 90-day trial window; it has no per-user value to join.
- Back up the eval DB (`EVAL_DB_PATH`, default `./data/eval.db`) like any private dataset; it
  contains your own content in `owner_request_log`.
