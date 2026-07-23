# Home-server Gateway — JSON API Contract

**Status:** stable reference for the BosGame M5 home-server gateway.
**Audience:** Hugin's macro-router (the M5 runtime/executor), Heimdall's inference-observability collector, and any LAN client.
**Source of truth:** `src/homeserver/gateway.ts` (routing), `src/homeserver/learning-task-contract.ts` (LearningTaskContract preflight/stamp/echo), `src/homeserver/ledger.ts` (`/ledger`), `src/homeserver/model-admin.ts` (`/models`, `/admin/*` backend facade — routes to `llamaswap-admin.ts`, the default, or the deprecated `lmstudio-admin.ts` per `HOMESERVER_BACKEND`, #146), `src/homeserver/errors.ts` (envelopes). This doc is derived from those files — if they change, update this doc in the same PR.

Per **ADR-004** (`docs/adr-004-m5-routing-ownership.md`): Hugin owns *macro*-routing (which node), the home-server gateway owns *micro*-routing + external admission, `ledger.ts` is the single capability KB (read via `/ledger`), and nightly local sub-tasks route through `/delegate`.

---

## Base & transport

- **Base URL:** `http://<m5-host>:8080`. The gateway binds via `HOMESERVER_HOST` (default `127.0.0.1`) and `HOMESERVER_PORT` (default `8080`). On the M5 this is the single runtime entry Hugin macro-routes to. (Clients such as Hugin's executor point at it via their own `HOMESERVER_GATEWAY_URL` — that is a client-side var, *not* read by the gateway.)
- **Bind / implicit-admin:** the gateway freezes its implicit-admin posture once at startup from the actual bind host (`isImplicitAdminAllowed`). Implicit admin (no-token bootstrap) requires **all** of: a loopback bind, zero `HOMESERVER_API_KEYS`, zero `HOMESERVER_ADMIN_API_KEYS`, and zero active keystore keys at startup. If any key exists, every request must authenticate. For LAN/external use, configure keys.
- **Content type:** `application/json` for all bodies and responses (except `/v1/chat/completions` streaming, which is `text/event-stream`).

## Auth model

Per-key Bearer tokens (`Authorization: Bearer <key>`), hashed in the keystore, each with a tier and an allow-list:

| Tier | Meaning |
|------|---------|
| `owner` | Full access incl. `/delegate` and `/admin/*`. Preempts guests for the serial GPU. |
| `guest` | Inference only (`/v1/chat/completions`, `/models`). Guest → `/delegate` returns `403 route_not_allowed`; guest → `/admin/*` returns `403 route_not_allowed` (requireAdmin relabelled it in PR #39 — a route-permission failure, not a model-allow-list violation); guest → `/ledger` (and `/ledger/{id}`) also returns `403 route_not_allowed` (admin/monitor only, #7). |

Quotas (sliding-window RPM/TPM + daily budget) are enforced per key → `429`. Owner-preempts-guest admission for the serial GPU → `503` + `Retry-After`.

## Error envelope (OpenAI-shaped)

**Every inference and auth error path** uses an `errors.ts` envelope so OpenAI-SDK clients parse them natively:

```json
{ "error": { "message": "<human text>", "type": "<error_type>", "code": "<machine_code>", "param": "<field|null>" } }
```

A few **protocol/admin** endpoints intentionally keep their own structured shapes: `/admin/models/{load,unload,download}` return the backend `{ ok, message, … }` result (raw backend detail stays server-side), `GET /mcp` returns a JSON-RPC-style `405`, and `/portal/stats` returns a minimal `{ error: { code, message } }`. These are not part of the OpenAI inference surface.

| HTTP | Typical `code` | Cause |
|------|----------------|-------|
| 400 | `invalid_request_error`, `model_not_found` | Missing/invalid body field; **malformed JSON body**; unknown model; **malformed percent-encoding in a decoded path segment** (`/ledger/{id}`, `/v1/images/generations/jobs/{id}`, `/admin/keys/{alias}`) — a decode failure is a client-input error, not a missing resource, so it 400s rather than 404ing or 500ing (#229) |
| 401 | `invalid_api_key` | Missing/unknown Bearer key |
| 403 | `route_not_allowed` (guest → `/delegate`, `/admin/*`, `/ledger`), `model_not_allowed` (a key's model allow-list on chat) | Tier/route or model not permitted |
| 404 | `not_found` | Unknown route / no such resource |
| 409 | `learning_task_conflict` | A stamped request reuses an admitted idempotency, task-attempt, or request identity |
| 413 | `payload_too_large` | Request body exceeds the size cap |
| 429 | quota codes | RPM/TPM/daily budget exceeded |
| 502 | `upstream_unavailable` | Model backend refused/reset the connection, OR returned a **non-404 error** (its status + body are normalized, never echoed — they can carry internal detail) |
| 503 | `server_busy` (admission) | Owner preempted the serial GPU; client should retry after `Retry-After` seconds |
| 504 | `upstream_timeout` | Backend exceeded the call timeout (often a cold model load); carries `Retry-After` |
| 500 | `internal_error` | Uniform envelope; raw detail (SQLite/stack) is logged server-side, never leaked |

Mid-stream failures (`stream:true`) cannot change the already-sent `200`; the gateway emits a terminal `data: {"error":{…,"code":"upstream_error"}}` frame then `data: [DONE]` so clients detect truncation. A **client disconnect** mid-call aborts the upstream generation (the GPU is freed) and is billed `0` — recorded as the content-blind `client_closed` outcome. See `docs/errors.md` for the full user-facing table.

---

## Endpoints

| Method | Path | Tier | Purpose |
|--------|------|------|---------|
| GET | `/healthz` | none | Liveness for routers/uptime checks |
| GET | `/models` | any | Capability discovery (what's on disk + loaded) |
| GET | `/v1/capabilities/learning-task` | owner or guest | LearningTaskContract v1 preflight for Hugin's stamped task handoff |
| GET | `/ledger` | admin or monitor | Capability KB — per-(task_type,model) verdicts + recent delegations |
| GET | `/ledger/{id}` | admin or monitor | Single evidence row for a `ledgerId` (join target, #227) |
| POST | `/v1/chat/completions` | any | Raw OpenAI-compatible inference (micro-routed to LM Studio) |
| POST | `/delegate` | owner | Ledger-gated one-shot delegation (record; verify only if a verifier is configured) |
| POST | `/admin/models/load` | owner | Load a model (modelKey **syntax** validated) |
| POST | `/admin/models/unload` | owner | Unload one/all models |
| POST | `/admin/models/download` | owner | Download a model (fire-and-forget; modelKey **syntax** validated) |

### GET `/healthz`

Unauthenticated minimal liveness. **Response 200:** `{ "ok": true }`. (Access logging for this route is off by default; toggle with `accessLogHealthz`.)

### GET `/models`

**Response 200:** `{ "models": ModelInfo[] }`, listing every model on disk annotated with load state.

```ts
interface ModelInfo {
  key: string;              // canonical model key (use as `model` in chat/completions)
  type: "llm" | "embedding" | string;
  displayName: string;
  architecture?: string;
  quantization?: string;    // e.g. "Q4_K_M"
  bitsPerWeight?: number;
  sizeBytes?: number;
  paramsString?: string | null;  // e.g. "7B"
  maxContextLength?: number;
  vision?: boolean;
  toolUse?: boolean;        // trained_for_tool_use
  loaded: boolean;          // currently resident
  loadedContext?: number | null;  // context length of the loaded instance
}
```

```json
{ "models": [ { "key": "qwen3-coder", "type": "llm", "displayName": "Qwen3-Coder 7B",
  "quantization": "Q4_K_M", "bitsPerWeight": 4.5, "sizeBytes": 4831838208, "paramsString": "7B",
  "maxContextLength": 131072, "vision": false, "toolUse": true, "loaded": true, "loadedContext": 32768 } ] }
```

### GET `/v1/capabilities/learning-task`

Authenticated, content-blind preflight for the accepted Grimnir LearningTaskContract v1. The
closed response advertises contract version `grimnir.learning-task/v1`, schema revision `1`, the
four required features, the fixed service identity `service:gille-inference`, and exact
`advertised_at` / `expires_at` observation clocks. Responses are private-cacheable for at most
15 minutes.

`advertisement_id` is an opaque HMAC binding over the exact response and the running gateway's
private capability epoch. A restart rotates that epoch, so a response cached from an older
process/configuration is rejected even if its wall-clock expiry has not elapsed. The gateway
accepts a **new** stamped task only when the response is from the current epoch, remains fresh,
and its version, schema, and feature set match exactly. An exact authenticated recovery of an
already-durable admission is the deliberate exception: it returns the original echo without
creating or executing new work.

```json
{
  "advertisement_id": "opaque:<uuid-v4>",
  "endpoint": "/v1/capabilities/learning-task",
  "protocol_version": "learning-task-preflight/v1",
  "advertised_at": "<RFC3339 UTC>",
  "expires_at": "<RFC3339 UTC, no more than 15 minutes later>",
  "authenticated_principal_id": "service:gille-inference",
  "authentication": "service-auth",
  "capabilities": {
    "contract_version": "grimnir.learning-task/v1",
    "schema_revision": 1,
    "features": [
      "hugin-request-stamp-v1",
      "gateway-echo-v1",
      "three-stage-prompt-provenance-v1",
      "reproducible-serving-digests-v1"
    ]
  }
}
```

Hugin sends the exact preflight pair in either `code_loop_start.learning_task_stamp` or the actual
one-shot inference lane, `POST /delegate`'s `learningTaskStamp`. Code-loop starts additionally bind
`idempotency_key` to `client_run_id`; stamped `/delegate` requires an explicit `taskType`. Both bind
the stamped task type to the effective gateway task type and `expected_transport_principal_id` to
the authenticated minted-key alias. Stale advertisements, partial/unknown features, caller
mismatches, malformed identity/config references, and replay under a changed durable request fail
closed before model execution. After the surface's GPU admission, the
start response contains `learning_task_gateway_echo`: the exact stamp, actual principal and
authentication, admission/request IDs and clock, current capabilities, and the normative JCS
principal-binding digest. That echo is durable and is returned unchanged on an exact idempotent
recovery, including after restart. The recovered start co-returns the terminal `result.execution`
when available, binding the same durable `work_id` to the effective model, harness, caps, and
capabilities; unstamped legacy starts remain unchanged. The HTTP response spells the same field
`learningTaskGatewayEcho` to match `/delegate`'s existing camel-case JSON API.

Every stamped surface also claims one shared SQLite admission identity before model execution.
The durable uniqueness boundaries are `(authenticated principal, idempotency_key)`,
`(authenticated principal, task_instance_id, attempt_id)`, and `(authenticated principal,
request_id)`. The natural attempt/request keys deliberately omit caller-supplied `client_id`, so
changing that string cannot evade replay protection; `client_id` is nevertheless retained and must
match on an exact identity. The table stores only the closed stamp/echo and request digest, never
raw or rendered prompt content. An exact `/delegate` retry returns `200` with the stored echo,
`outcome:"error"`, and `learningTaskAdmission:{recovered:true,outcomeAvailable:false}` without
another model call: Hugin can preserve the admission join, but v1 does not pretend the unavailable
original delegation result was recovered. The durable claim is the conservative "execution may
have begun" boundary: once it exists, a later delegate/ledger exception never deletes it, because
that exception can occur after inference. A mutated identity returns `409 learning_task_conflict`.
`code_loop_start` normally recovers an exact previous durable result/echo before the shared guard.
If a crash left the shared admission but not the work record, it instead returns the distinct
`admission-recovery` refusal with the stored echo; changed identities remain `conflict`. This
authenticated, fingerprint-exact lookup runs before current epoch/freshness validation and before
current mutable code-loop cap policy, credit, quota, busy, cage, or GPU gates. Durable-run recovery
also requires the persisted echo's complete request stamp to equal the incoming stamp. Only an
identity absent from the durable guard proceeds as a new claim through current validation and
transient gates.

Clock validation deliberately allows **zero skew** in v1: request, advertisement, stamp, admission,
and expiry timestamps must be monotonically ordered, and an advertisement is stale at its exact
`expires_at`. Hugin and the gateway therefore require synchronized host clocks and should fetch a
fresh preflight/retry after any clock-order refusal. No tolerance is applied because accepting
future or expired stamps would weaken the durable evidence boundary.

Admission records are currently retained durably without a local TTL so replay protection cannot
silently expire. Delivery accounting, outcome retention, and the eventual explicit lifecycle /
compaction policy belong to gille-inference #3; this contract does not pre-empt that policy.

The actual `code_loop_start.instruction` is bound alongside the full stamp in the durable request
fingerprint. It is not compared to `raw_fingerprint`: the contract intentionally defines that hash
over Hugin's pre-orchestration logical input, while the transmitted instruction may be Hugin's
post-context/system envelope. Hugin remains authoritative for resolving and validating those typed
source documents; the gateway must not collapse the two prompt stages.

The checked-in compatibility fixtures are emitted by Hugin #240's real `/delegate` serializer.
The producer metadata fixture is byte-pinned by SHA-256 and the exact serialized request is parsed
and exercised by gille-inference, so origin identities, the wrapper/raw distinction, and the
accepted Grimnir schema fail tests on cross-repository drift.

### GET `/ledger`

The capability knowledge base. **Response 200:** `{ "report": LedgerReportRow[], "recent": RecentDelegation[] }` (`recent` capped at 20, newest first).

```ts
interface LedgerReportRow {
  taskType: string;
  modelId: string;
  verdict: "unknown" | "viable" | "marginal" | "not_viable";
  attempts: number; passes: number; partials: number; fails: number; errors: number;
  successRate: number;     // 0..1
  frozen: boolean;         // freeze-on-failure latch
  mechanicalFormatAttempts: number; // #233: of `attempts`, how many passed/partialled on a mechanical-format verifier
  recommendation: "delegate-local" | "explore" | "escalate-frontier";
  avgLatencyMs: number | null;
  avgTokPerSec: number | null;
  unverifiedShare: number;  // #233: unverified rows / ALL rows for this cell, 0..1
  formatOnlyShare: number;  // #233: mechanicalFormatAttempts / attempts, 0..1 (0 when attempts is 0)
}
interface RecentDelegation {
  id: string;               // primary key — the same value recordDelegation() returns as ledgerId
  ts: string;              // ISO8601
  taskType: string; modelId: string;
  outcome: string;         // pass | partial | fail | error | unverified
  score: number | null;
  latencyMs: number | null;
  verifier: string | null;
  verifierKind: "mechanical-format" | "truth-oriented" | "ungraded"; // #233: derived from `verifier`
  source: string | null;
  keyAlias: string | null; // authenticated gateway/MCP alias; never a token or key hash
}

interface DelegationById extends RecentDelegation {
  evidenceIdentityHash: string | null;
  learningTaskBinding: "bound" | "legacy" | "invalid";
  learningTaskAdmissionId: string | null;
  taskInstanceId: string | null;
  attemptId: string | null;
}
```

**#233 — format-verified vs truth-verified evidence.** `verifier-classification.ts`'s
`classifyVerifierKind()` labels each verifier `mechanical-format` (shape/pattern/fixed-value checks:
`jsonValid`, `nonEmpty`, `matches`, `containsAll`, `containsNone`, `exact`, `answerIs`, `numeric`,
`maxLength`) or `truth-oriented` (execution-based ground truth or model-judge checks: `tsGate`,
`sqlExec`, `llm-judge:<model>`, and any unrecognised verifier by conservative default) or `ungraded`
(no verifier ran). A high `formatOnlyShare` on a judgment-flavored task type (classify, qa-factual,
triage, claim-verify) means the headline pass rate is weaker evidence than it looks — the row only
proved the output had the right SHAPE, not that it was correct. `PolicyConfig.discountFormatOnlyEvidence`
(env `HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE=on`, default off) discounts format-only passes/partials
by `formatOnlyDiscountWeight` (default 0.5) when computing `successRate` for the configured task types
(`formatOnlyDiscountTaskTypes`, default classify/qa-factual/triage/claim-verify) — in both `getVerdict()`
and `getLaneEvidence()` (the production-routing evidence path).

**Recommendation derivation** (so the macro-router can mirror it): `viable` → `delegate-local`; `frozen` and (`not_viable` | `marginal`) → `escalate-frontier`; otherwise → `explore`.

For tenant onboarding, mint named keys and use the alias as the audit identity. Guest-tier
keys are the standard default for ordinary inference/MCP surfaces; owner-only surfaces such
as `POST /delegate` require a named owner-tier key if a tenant validation run must exercise
that route. `recent[].keyAlias` is nullable for CLI/probe/imported evidence and for legacy
rows created before the alias column existed.

### GET `/ledger/{id}` (#227)

Resolves a single `ledgerId` — `recordDelegation()`'s return value, echoed by `POST /delegate` as
`costTrace.delegationId` — back to its exact evidence row, so a caller holding a `ledgerId` never
has to fall back to timestamp matching against `recent[]`. Same auth gate as `GET /ledger`
(admin or monitor).

**Response 200:** a single `DelegationById` (see above), including `id`. For a stamped
`POST /delegate` row, `learningTaskBinding:"bound"` means the ledger write resolved the exact
server-generated admission id inside the same SQLite transaction, verified the authenticated
principal and complete admitted stamp, and copied the authoritative `taskInstanceId` / `attemptId`
pair into the row. `evidenceIdentityHash` is the exact non-null evidence identity for that row.
Consumers must compare all four identities (`taskInstanceId`, `attemptId`, `modelId`, `taskType`)
plus `evidenceIdentityHash` before treating the result as eligible joined evidence.

Unstamped and pre-migration rows return `learningTaskBinding:"legacy"` with all three binding
fields explicitly `null`; they cannot be mistaken for eligible stamped evidence. A mechanically
inconsistent partially-populated historical/corrupt row returns `learningTaskBinding:"invalid"`
and must also fail closed. New bound writes reject an unknown admission id, a non-delegate
admission, a different authenticated principal, a cross-task/cross-attempt stamp, a missing
evidence identity, or evidence fields inconsistent with the admitted stamp before inserting any
ledger row. The response remains content-blind: it adds no prompt, output, credential, or private
payload bytes.

**Errors:** unknown `id` → bare `404 not_found` (no enumeration oracle); non-admin/non-monitor key
→ `403 route_not_allowed`; malformed percent-encoding in `{id}` (e.g. a bare `%`) →
`400 invalid_request_error` rather than a 500 (#229).

### POST `/v1/chat/completions`

OpenAI-compatible passthrough to LM Studio (micro-routed). `model` must be in the key's allow-list. Supports `stream: true` (SSE; the terminal frame carries `usage`).

Sampling controls (`temperature`, `top_p`, plus llama.cpp extensions `top_k` and `min_p`) pass through. `max_tokens` is clamped to the fleet-wide ceiling, except exact models configured in `HOMESERVER_MODEL_MAX_TOKENS` may explicitly request their higher ceiling; omitting `max_tokens` always keeps the conservative fleet default.

**Response 200 (non-streaming):** standard OpenAI chat-completion body (`id`, `object`, `created`, `model`, `choices[].message`, `usage{prompt_tokens, completion_tokens, total_tokens}`).

**Errors:** unknown model → `400 model_not_found` (`param: "model"`); `max_tokens <= 0` → `400 invalid_request_error` (`param: "max_tokens"`).

### POST `/v1/images/generations`

OpenAI-compatible text→image. **Inert** unless the box sets `HOMESERVER_IMAGE_URL` (else `404 not_found`). Three advertised models, each a tier: `image-fast` (synchronous), `image-balanced` and `image-high` (asynchronous jobs). `model` must be in the key's allow-list (empty = all).

**Request:** `{ "prompt": string, "model": "image-fast"|"image-balanced"|"image-high", "n"?: number, "size"?: string, "response_format"?: "b64_json" }`.
- `prompt` required (≤ `HOMESERVER_IMAGE_PROMPT_MAX_CHARS`) → else `400` (`param: "prompt"`).
- unknown `model` → `400` (`param: "model"`); not in allow-list → `403 model_not_allowed`.
- `n` clamped to `[1, HOMESERVER_IMAGE_MAX_N]`; non-int/≤0 → `400` (`param: "n"`).
- `size` must be in `HOMESERVER_IMAGE_SIZES` → else `400` (`param: "size"`).
- `response_format: "url"` is not supported → `400` (`param: "response_format"`); only `b64_json`.

**Metering:** worst-case `n × per-image credits` reserved up-front (402 on overdraft, BEFORE any work); `n` image-units charged against the per-key quota (429 on exceed); both reconciled to the **delivered** count; full refund on failure/timeout/cancel.

**Response — fast tier (synchronous) 200:** `{ "created": number, "data": [{ "b64_json": string }, ...] }`.

**Response — balanced/high tier (asynchronous) 202:** `{ "id": "imgjob_…", "status": "queued", "model": string, "n": number, "created": number, "expires_at": number }`. Errors: `502 upstream_unavailable` / `504 upstream_timeout` on a sidecar fault; `503 server_busy` if the single diffusion slot can't be acquired.

### GET `/v1/images/generations/jobs/{id}`

Poll an async job. **Scoped to the creator** — a non-owner or unknown id returns a bare `404` (no enumeration oracle). Body: `{ id, status: "queued"|"running"|"succeeded"|"failed"|"cancelled"|"expired", model, n, created, expires_at, error?: { code }, data?: [{ b64_json }] }` (`data` present only while `succeeded` and un-expired). Malformed percent-encoding in `{id}` → `400 invalid_request_error` rather than a 500 (#229).

### DELETE `/v1/images/generations/jobs/{id}`

Cancel + refund a job, **idempotent**. Scoped to the creator (`404` otherwise). Body: `{ id, status }`. Malformed percent-encoding in `{id}` → `400 invalid_request_error` rather than a 500 (#229).

### POST `/delegate` (owner only)

Ledger-gated one-shot delegation: classify task type → consult ledger → run a local model → record a ledger row. The handler accepts `modelId` (pin the local model), `frontierModelId` (run a frontier-fallback arm via OpenRouter), and a `verifier` **spec** that attaches a deterministic pass/fail grader — so a delegated run produces a real ledger verdict (`pass`/`fail`) instead of `unverified`, which is what lets the ledger actually *learn* from nightly traffic (#14, ADR-004).

**Request:** `{ "prompt": string, "taskType"?: string, "systemPrompt"?: string, "maxTokens"?: number, "modelId"?: string, "temperature"?: number, "topP"?: number, "topK"?: number, "minP"?: number, "frontierModelId"?: string, "delegatorModelId"?: string, "premiumBaselineModelId"?: string, "verifier"?: VerifierSpec, "responseFormat"?: ResponseFormat, "learningTaskStamp"?: HuginRequestStamp }`. Sampling ranges are `temperature ∈ [0,2]`, `topP/minP ∈ [0,1]`, and integer `topK ≥ 0` (`0` disables llama.cpp's top-k cutoff).
- On the M5 `/delegate` path, the established reasoning-model safety floor maps an accepted
  `temperature: 0` to `0.6`; raw OpenAI chat and MCP `ask` forward an explicit zero unchanged.
- `prompt` required → else `400 invalid_request_error` (`param: "prompt"`).
- `modelId` / `frontierModelId` / `delegatorModelId` / `premiumBaselineModelId` must be strings
  when supplied → else `400` (`param` names the bad field).
- `verifier` is an allow-list of parameterised verifiers (never arbitrary code; see `verifier-registry.ts`); a malformed spec → `400` (`param: "verifier"`):

  | `type` | params | passes when |
  |--------|--------|-------------|
  | `nonEmpty` | `minLen?` (default 1) | output length ≥ `minLen` |
  | `answerIs` | `expected` (string), `ci?` (default true) | output contains `expected` |
  | `exact` | `expected` (string), `ci?` | normalized output equals `expected` |
  | `containsAll` | `subs` (string[]), `ci?` | every substring present (partial score otherwise) |
  | `matches` | `pattern` (string), `flags?` | regex matches output |
  | `numeric` | `expected` (number), `tol?` | last number in output within `tol` |
  | `maxLength` | `max` (number), `min?` | output length in `[min, max]` |
  | `jsonValid` | — | output parses as JSON |

  Example: `{ "prompt": "What is 6*7?", "delegatorModelId": "claude-sonnet-5", "verifier": { "type": "numeric", "expected": 42 } }`.

**Response 200 — `DelegationOutcome`:**
```ts
interface DelegationOutcome {
  delegated: boolean; escalate: boolean;
  taskType: string; modelId: string; decisionReason: string;
  outcome?: "pass" | "partial" | "fail" | "error" | "unverified";
  score?: number | null;
  output?: string;
  metrics?: { latencyMs: number; ttftMs: number; promptTokens: number; completionTokens: number; tokPerSec: number };
  verifierNotes?: string; ledgerId?: string;
  finishReason?: string | null;
  truncated?: boolean;
  frontierOutput?: string; frontierModelId?: string; frontierError?: string;
  costTrace?: {
    costStatus: "verified" | "unverified" | "failed" | "escalated" | "not_applicable";
    delegatorModel: string | null;
    premiumBaselineModel: string;
    actualBaselineCostUsd: number | null;
    premiumBaselineCostUsd: number | null;
    m5MarginalCostUsd: number;
    m5AmortizedCostUsd: number;
    verifiedSavingsActualUsd: number;
    verifiedSavingsPremiumUsd: number;
    potentialSavingsActualUsd: number;
    potentialSavingsPremiumUsd: number;
    notes: string[];
  };
  learningTaskGatewayEcho?: LearningTaskGatewayEcho;
}
```

When the local backend terminates with `finish_reason: "length"`, `/delegate` fails closed:
`outcome` is `error`, `truncated` is `true`, `finishReason` is `"length"`, and no partial output is
passed to the verifier or returned as `output`. The ledger row records
`error_class = "truncated"` plus best-effort token/timing diagnostics, and normal frontier
escalation remains available. A clean backend finish may expose its terminal reason with
`truncated: false`; backends without a terminal-reason signal omit both fields.

Supplying `learningTaskStamp` opts this real Hugin inference path into LearningTaskContract v1 and
requires an explicit matching `taskType`. The gateway validates the fresh preflight and actual
authenticated principal before admission, then claims the shared durable replay guard and returns
the exact principal-bound `learningTaskGatewayEcho`. Once a stamped `/delegate` admission is
durably claimed, it survives every downstream exception because inference may already have begun.
An exact retry returns the retained echo and an explicit unavailable-outcome error without starting
another model run. Omitting the stamp preserves the legacy API and response shape, but that call is
explicitly ineligible for joined learning-task evidence.

`costTrace.verifiedSavings*` is zero unless the local verifier returns `pass`; see
`docs/delegation-cost-accounting.md` for the accounting rules and env knobs.

### POST `/admin/models/{load,unload,download}` (owner only)

- **load** — body `{ modelKey: string, contextLength?, parallel?, gpu?: "max"|"off"|"0".."1", ttlSeconds? }` → `LoadResult { ok, modelKey, identifier, contextLength?, durationMs, message }` (200 ok / 500 fail; missing `modelKey` → `400 invalid_request_error`, `param: "modelKey"`).
- **unload** — body `{ modelKey?: string }` (omit → unload all) → `{ ok, message }`.
- **download** — body `{ modelKey: string, wait?: boolean }` → `{ ok, started, message }` (fire-and-forget unless `wait:true`). `modelKey` is **syntax**-validated (charset; no leading `-`/`/`; no `..`; ≤200 chars) to block flag/path injection — this is **not** per-key model-allow-list enforcement: an owner key may load/download any syntactically valid key.

> **Model-swap ownership (ADR-004 / PR #10):** the gateway does **not** own model swapping at inference time — `llama-swap` does. `/admin/models/*` is explicit operator control, not the per-request hot-swap path.

---

## How Hugin's macro-router uses this

1. **Liveness:** `GET /healthz` before routing to the M5 node.
2. **Capability check:** `GET /ledger` (verdict per task_type) + `GET /models` (loaded/vision/tool-use) decide *whether* the M5 can take a sub-task. `delegate-local` → send it; `escalate-frontier` → keep it on a frontier model; `explore` → send a probe.
3. **Dispatch:**
   - **Ledger-gated sub-tasks** (nightly local work, verifiable one-shots) → stamped `POST /delegate` (owner key). Attach the current preflight and stamp plus a `verifier` spec (and optionally `modelId`/`frontierModelId`) so the run is joinable and records a real `pass`/`fail` verdict; pass `delegatorModelId` so savings are estimated against the actual cloud brain. An unstamped call remains a legacy compatibility path and is not eligible for joined learning-task evidence. Omit the verifier and the run records `unverified`; a later trusted grade becomes capability evidence only through the gateway/repo's defined evidence-import path. Hugin may retain its operational outcome, but must not create a competing capability ledger. Verified savings stays zero until trusted evidence lands.
   - **Raw inference** (chat, streaming, agent inner loops) → `POST /v1/chat/completions`.
4. **Backpressure:** honor `429` (quota) and `503` + `Retry-After` (owner preemption) — surface as a route-elsewhere or retry signal, never a hard error to the user.

Interactive L1/client access does not require Hugin. Authorized clients may use the raw OpenAI or
MCP surfaces directly when they already own the surrounding lifecycle. Hugin is the path for
durable, macro-routed tasks, not a mandatory inference proxy.
