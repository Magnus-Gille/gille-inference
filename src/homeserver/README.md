# M5 home-inference gateway and capability engine

The production serving, micro-routing, verification, and evidence spine for the **BosGame M5 /
Strix Halo 128GB** box. It serves local models behind authenticated OpenAI and MCP surfaces, protects
one serial GPU, and records admissible delegation evidence so the system learns what each
node/model can and cannot do.

The production backend is llama-swap/llama-server. LM Studio support is deprecated compatibility
code. Canonical system purpose and the L1/Hugin/M5 boundary are in
[`../../docs/architecture.md`](../../docs/architecture.md).

## The idea in one paragraph

The L1 Conductor normally runs outside this subsystem and may call it directly or through Hugin.
For a verified delegated task, the micro-broker classifies it, consults the **capability ledger** to decide
whether the local model is worth trying, calls the local model if so, **verifies the
output deterministically** (no cloud judge needed), records the graded outcome, and
tells the caller whether to **escalate** to a frontier model. Over time the ledger
accumulates a verdict per `(node, task_type, model)` — `viable` / `marginal` / `not_viable` /
`unknown` — which is exactly the data RQ5–RQ7 need.

## Components

| File | Role |
|---|---|
| `config.ts` | Env-driven config: LM Studio URL, gateway host/port, API keys, routing policy. |
| `lmstudio-admin.ts` | **DEPRECATED (#146)** — no production traffic (llama-swap is the default backend). Kept one release. Programmatic model control via the `lms` CLI + REST: list / load / unload / download / `ensureLoaded(minCtx)`. |
| `ledger.ts` | The capability ledger. Records delegations; computes verdicts; `shouldDelegate()` policy. |
| `taxonomy.ts` | Task-type list + heuristic classifier. |
| `verifier.ts` | Deterministic verifiers (exact / contains / regex / numeric / JSON / maxlen / predicate) + a TypeScript compile-and-run gate. |
| `verifier-registry.ts` | `buildVerifier(spec)` — construct a deterministic verifier from an untrusted JSON spec (allow-list, never arbitrary code). Lets `/delegate` HTTP callers attach a grader so the ledger learns (#14). |
| `orchestrator.ts` | `delegate()` — classify → policy → local call → verify → (disagreement-gate) → record → escalate. |
| `disagreement-gate.ts` | Cross-model disagreement as an instance-level escalation gate. On the UNVERIFIED path, a second cheap local model's answer is compared to the primary's; disagreement → escalate. The signal that beats self-confidence on real sub-tasks (AUROC 0.986 vs 0.807; `docs/cascade-gate-experiment-design.md`). Default-off; `shadow` mode records the signal without changing routing. |
| `gateway.ts` | Authenticated HTTP endpoint (LAN-bindable). Proxy + orchestrate + admin + ledger + MCP. |
| `mcp.ts` | MCP Streamable-HTTP transport (`POST /mcp`): `list_models` + `ask` tools, sharing the metered chat path (`runChatCompletion`) and the key's allow-list. `ask` enforces OWNER-TIER on its optional `files` param (blind-context delegation, issue #128) before expanding it via `blind-context.ts`. |
| `blind-context.ts` | Blind-context delegation (issue #128) — pure, DI-friendly path-safety module: expands an allow-listed `files` list into delimited context blocks. realpath-before-prefix-check (symlink + `..` traversal safe), per-file/total byte caps, null-byte binary heuristic. No principal/tier awareness by design (enforced by the caller, `mcp.ts`). |
| `cli.ts` + `probes.ts` | Driver + the verifier-backed experiment battery. |
| ~~`improve-loop.ts` + `improve-proposer.ts` + `vcs.ts`~~ | **RETIRED (#146)** — the overnight propose→apply→score→keep/revert loop and its `improve` CLI command. Zero production runs ever; `code-loop.ts` (see below) is the shipped, accepted self-improvement mechanism. |
| `gpu-lease.ts` | **GPU lease** (issue #88): concurrent heavy batch jobs SEQUENCE against the serial GPU instead of thrashing it with model swaps. Mutual exclusion is enforced by an OS-atomic `mkdir` lock (`.holder/`); per-waiter ticket files provide near-FIFO fairness + a queryable "who holds / who's waiting + ETA" view (pure `selectHolder()`). Crash-safe (heartbeat + stale-reclaim; a stolen lease fires `onLeaseLost`). `acquireGpuLease`/`release`/`gpuLeaseStatus`, driven by the `gpu` CLI command. |
| `deep-research-*.ts` | **Deep-research harness** (`docs/deep-research-harness-design.md`): a bounded `plan→search→read→distill→verify→gap→synth→cite` pipeline of single model calls with deterministic glue. `deep-research-types.ts` (DI ports), `deep-research-config.ts` (env), `citation-verifier.ts` (deterministic trust anchor: claim→span **and** report-sentence→cited-source verification), `search-provider.ts` (SearXNG/Brave + breaker), `reader.ts` (Trafilatura/Jina + SSRF blocklist), `deep-research.ts` (pipeline), `deep-research-cli.ts` (`run` entry). Local-first, pluggable hybrid brain. |

## The learning / back-off policy

Per `(task_type, model)` the ledger tallies pass / partial / fail / error and derives a
verdict (thresholds are configurable in `config.ts`):

- **`unknown`** — fewer than `minSamples` (default 3) attempts. Keep delegating to learn.
- **`viable`** — success rate ≥ `viableThreshold` (0.7). Keep delegating.
- **`marginal`** — between `marginalThreshold` (0.4) and viable. Keep sampling up to the cap.
- **`not_viable`** — either `maxFails` (3) failures with zero passes (fast strike-out), or
  a low rate after enough samples. **Once frozen, stop delegating and escalate** — except
  an occasional `explorationRate` (10%) re-probe to catch a model that has since improved.

Infra errors (connection refused / 5xx) are **excluded** from the verdict — they say
nothing about the model. Empty/truncated/timeout outputs **do** count (they reflect the
budget-ceiling and self-verification-spiral failure modes from the project's findings).

This is the "don't re-delegate a failing task type more than needed to learn" rule:
clear failures strike out in 3 attempts; ambiguous ones are bounded by `maxSamples` (8).

## Production delegate policy

The optional `delegate-policy.ts` gate is stricter than the learning policy above. The
learning policy may delegate `unknown` lanes to gather evidence; production delegation should
only auto-call local inference for certified lanes: exact `(task_type, model, verifier)` evidence
with enough verified samples, high pass/partial rate, low capability-error rate, and bounded p90
latency. `HOMESERVER_DELEGATE_POLICY=shadow` computes and logs `allow|shadow|deny` without changing
routing; `enforce` escalates before local inference unless the lane is `allow`. Learning sources
such as probes/harvest/backfills bypass this production gate so evidence collection still works.

## Usage

```bash
# Fix/raise the active model's context (the admin path; safe to re-run)
tsx src/homeserver/cli.ts ensure-ctx --ctx 32768

# List models on disk + which is loaded
tsx src/homeserver/cli.ts models

# Run the experiment battery through the orchestrator (slow — exercises the local model)
tsx src/homeserver/cli.ts probe --all
tsx src/homeserver/cli.ts probe --type code-implement   # just one type
tsx src/homeserver/cli.ts probe --id code-slugify        # one probe

# See what the system has learned
tsx src/homeserver/cli.ts ledger

# One-off delegation
tsx src/homeserver/cli.ts delegate --type extract --prompt "Return only the year in: released in 1998"

# Mint / list / revoke per-key credentials (the plaintext is shown ONCE)
tsx src/homeserver/cli.ts keys mint --alias laptop --tier owner
tsx src/homeserver/cli.ts keys mint --alias guest1 --tier guest --models qwen3-coder --rpm 30 --daily 200000
tsx src/homeserver/cli.ts keys list
tsx src/homeserver/cli.ts keys revoke --alias guest1

# Rotate a leaked/refreshed key in ONE step (#99): revokes the active key for the name and mints a
# fresh one, inheriting its tier + limits. Do NOT `revoke A` then `mint A` — `alias` is the PRIMARY
# KEY, so the revoked row keeps owning the name and the re-mint fails (a naive pipeline then clobbers
# the stored token with an empty value). --tier is only needed for a brand-new name.
tsx src/homeserver/cli.ts keys rotate --alias laptop

# Self-service invite (one-time code → friend self-issues their own key via the portal)
# --credits is a LIFETIME, non-resetting token cap (0 = unlimited); the code is shown ONCE.
tsx src/homeserver/cli.ts keys invite --credits 500000 --tier guest --model qwen3-coder --alias-prefix alice

# Easy owner shortcut (from anywhere on the box):
bin/invite alice              # 10M token lifetime cap, all models
bin/invite alice 1000000      # 1M token cap
bin/invite alice 1000000 qwen3-coder-next-80b   # restrict to one model

# Start the authenticated gateway
tsx src/homeserver/cli.ts serve
```

### Minting invites (owner-only, CLI-only)

**Invite minting is a local CLI operation only. There is no network/HTTP endpoint that
mints invites — friends can only redeem codes, never create them. This is the security
model: only someone with shell access to this box can mint a code.**

The short command (from the repo root, or any CWD — the script resolves its own path):

```bash
bin/invite <friend-name> [credits] [model]
```

| Argument | Default | Notes |
|---|---|---|
| `friend-name` | (required) | Used as the invite alias-prefix, e.g. `alice` |
| `credits` | `10000000` | Lifetime, non-resetting token cap (0 = unlimited) |
| `model` | (none) | Restrict to one model ID; omit for all-models access |

**Examples:**

```bash
bin/invite alice                              # 10M tokens, all models
bin/invite bob 1000000                        # 1M tokens, all models
bin/invite carol 1000000 qwen3-coder-next-80b # 1M tokens, one model only
```

After the command prints the invite code (shown **once only**), it also prints a
ready-to-copy "Share with <name>:" block: the public URL, redemption instructions,
formatted credit amount, and a pointer to the portal docs. Send that block to your
friend — they visit `https://inference.example.com`, paste the code, and get their key
without you having to do anything else.

The underlying full command (for automation or unusual flags):

```bash
NODE_OPTIONS=--no-deprecation tsx src/homeserver/cli.ts \
  keys invite --credits N --tier guest --alias-prefix NAME [--model M]
```

### Gateway API

| Method + path | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | Liveness + loaded models (for the router/uptime checks). |
| `GET /` · `GET /portal` | none | Serves the self-service portal page (HTML; `nosniff` + restrictive CSP + `no-store`). Per-IP throttled. |
| `POST /portal/redeem` | none (the **code** is the credential) | `{code}` → `200 {key, alias, model, models, creditLimit}` (`Cache-Control: no-store`). Trades a one-time invite code for a freshly minted key. Uniform `409 invite_invalid` for an unknown **or** already-used code (identical body — no enumeration oracle); `400` for a missing code. Per-IP throttled (`HOMESERVER_REDEEM_RPM`, default 10 / 10 min) → `429`. |
| `GET /portal/me` | user | The dashboard's data source → `{alias, tier, models, creditLimit, creditsUsed, rpm, tpm}` (`Cache-Control: no-store`). |
| `GET /portal/stats` | none | **PUBLIC, content-blind grand aggregate** powering the portal's "Served so far" card → `200 {total_tokens, total_requests, since}` (`Cache-Control: public, max-age=30`). Summed from the **durable** `request_log` (survives restarts — the honest "served so far"), NOT the in-memory Prometheus counters. Exposes ONLY fleet-wide totals — never any per-user / per-key / per-alias / per-model / content dimension. Per-IP throttled (shares the redeem window). Deliberately distinct from authed `/metrics`. |
| `GET /portal/model-evals.json` | none | **PUBLIC, content-blind** feed powering the portal's "New model evaluations" card → `200 {generatedAt, count, models: [{id, quant, sizeGB, passRate, tokPerSec, verdict, served, evaluatedAt}]}` (`Cache-Control: public, max-age=300`). Reads the weekly Model Scout's registry (`model-registry.ts`, `docs/weekly-model-scout-runbook.md`) — no prompts, no request content, just per-model benchmark verdicts. A read failure degrades to an empty `{count:0, models:[]}` rather than an error. Per-IP throttled (shares the redeem window). |
| `POST /v1/chat/completions` | user | OpenAI-compatible proxy to LM Studio/llama.cpp. `temperature`, `top_p`, and llama.cpp extensions `top_k`/`min_p` pass through. `max_tokens` uses the fleet cap unless an exact model has a higher configured ceiling. Refused with `402 credits_exhausted` when the key's lifetime credit budget is spent. |
| `GET /v1/capabilities/learning-task` | user | **LearningTaskContract v1 preflight.** Returns the closed four-feature capability advertisement, `service:gille-inference` identity, exact observation/expiry clocks, and an opaque advertisement ID bound to the current process/configuration epoch (`Cache-Control: private, max-age=900`). Hugin must carry this exact fresh response for every new stamped `/delegate` or `code_loop_start` claim; stale, downgraded, cross-principal, or cross-epoch new claims fail closed. Exact authenticated durable admission recovery remains available after expiry/restart without executing new work. |
| `POST /v1/audio/transcriptions` | user | **OpenAI Whisper-compatible speech-to-text.** Multipart `file` (required) + `model` / `language` / `response_format` / `temperature` / `prompt`. Forwards the audio to whisper-server (`HOMESERVER_WHISPER_URL`, default `http://127.0.0.1:8092`) `POST /inference`, always requesting `verbose_json` so the backend's top-level `duration` is available. **Metered by audio-seconds with RESERVE→RECONCILE billing (mirrors the chat path):** before transcribing, the worst case `ceil(HOMESERVER_AUDIO_MAX_SECONDS) * HOMESERVER_AUDIO_CREDITS_PER_SECOND` is reserved **atomically** against the lifetime credit cap — insufficient budget ⇒ `402 credits_exhausted` and **no transcription** (closes the TOCTOU + overdraft). After the backend returns, a **valid** `duration` (finite, `0 < d ≤ audioMaxSeconds`) reconciles **down** to `ceil(duration) * rate`; a **missing / 0 / non-finite / over-cap** duration on a 2xx is a backend FAULT and is charged the **clamped worst case** (never 0). Enforces per-key **RPM/TPM/daily** quota → `429` + `Retry-After` (no rate-limit bypass). Upload hardened: a declared `Content-Length` over `HOMESERVER_AUDIO_MAX_BYTES` (default 32 MiB) is rejected **`413 payload_too_large`** before buffering; an idle/socket read timeout (`HOMESERVER_AUDIO_READ_IDLE_MS`, default 30 s) drops slow-loris clients. `400` for a missing file or an out-of-range `temperature` (must be in `[0,1]`); `502/504` on backend unavailable/timeout (full refund — charge 0). Returns the client's `response_format` (`json` → `{text}`, `verbose_json` → full object, `text` → plain body). Content-blind: the transcript is **never** in request_log / metrics; owner-logged **only** under the owner guard (`tier===owner && keyHash!==null`). |
| `POST /v1/images/generations` | user | **OpenAI-compatible text→image.** Three advertised models, each a tier: `image-fast` (synchronous → `200 {created, data:[{b64_json}]}`), `image-balanced` + `image-high` (asynchronous → `202 {id:"imgjob_…", status:"queued", …}`). **Inert** unless `HOMESERVER_IMAGE_URL` is set (else `404`). **Metered like the audio path:** worst-case `n × per-image credits` reserved up-front (`402` on overdraft, before any work), `n` image-units against the per-key quota (`429`), both reconciled to the **delivered** count; **full refund** on failure/timeout/cancel. A dedicated **single-slot diffusion worker** acquires the shared admission slot only around the sidecar dispatch (owner chat can still preempt; an honest guest at cap gets `503`). `403 model_not_allowed` off the allow-list; `502/504` on sidecar fault. Content-blind: the prompt + bytes are **never** in `image_jobs` / request_log / metrics; owner-logged **only** under the owner guard. Forwards to an sd-server-style sidecar (`HOMESERVER_IMAGE_URL`, e.g. `http://127.0.0.1:8093`) `POST /v1/images/generations`. |
| `GET /v1/images/generations/jobs/{id}` | user | Poll an async job (scoped to the creator; bare `404` otherwise). `succeeded` returns `data:[{b64_json}]` until the result TTL sweeps it (`expired`). |
| `DELETE /v1/images/generations/jobs/{id}` | user | Cancel + refund a job, **idempotent**; scoped to the creator. |
| `POST /mcp` | user | **MCP Streamable-HTTP transport** (JSON-RPC 2.0). Exposes the local models to an MCP client (Claude Code) as tools — `list_models` + `ask` (all keys) and, for a real **owner** key only, `code_loop_start` / `code_loop_status` / `code_loop_result` (invisible + byte-identical unknown-tool error to non-owners, #116). `ask` runs through the **same metered path** as `/v1/chat/completions` (credit reserve → quota → admission → reconcile) and the **same model allow-list**; it accepts optional `delegator_model_id` for savings accounting and an **OWNER-ONLY** optional `files` array (blind-context delegation, issue #128). `GET /mcp` → `405`. See *MCP transport* + *code_loop* below. |
| `POST /delegate` | **owner** | Orchestrated path: `{prompt, taskType?, systemPrompt?, maxTokens?, modelId?, temperature?, topP?, topK?, minP?, frontierModelId?, delegatorModelId?, premiumBaselineModelId?, verifier?, responseFormat?, learningTaskStamp?}`. A stamp opts the real Hugin inference lane into v1, requires explicit matching `taskType`, and returns `learningTaskGatewayEcho`; unstamped traffic remains legacy/ineligible. Sampling controls are validated and threaded to the local call. `modelId`/`frontierModelId` pin the local model + optional frontier fallback; `verifier` grades output so the ledger learns; `responseFormat` optionally grammar-constrains decode. Guest → `403 route_not_allowed`. See `docs/gateway-api-contract.md`. |
| `POST /admin/task-exposures/lookup` | **minted owner** | Content-blind batch freshness lookup for the automatic evaluation factory. Accepts 1–100 exact `trim-utf8-sha256-v1` task fingerprints and returns seen/unknown plus first/last time, lane/model/harness metadata, and an explicit coverage window. Never returns raw task text. Guest, monitor, and identity-less static admins → `403`; `Cache-Control: no-store`. See `docs/task-exposure-contract.md`. |
| `GET /models` | user | Models on disk + loaded. |
| `GET /ledger` | **admin or monitor** | The learning report + recent delegations (`recent[]` rows carry `id`, #227). Read-only monitors (e.g. Heimdall) via `HOMESERVER_MONITOR_API_KEYS`. |
| `GET /ledger/{id}` | **admin or monitor** | The single evidence row for a `ledgerId` (`recordDelegation`'s return value, echoed by `POST /delegate` as `costTrace.delegationId`) — the join target so a caller can retrieve its exact row without timestamp matching (#227). Stamped delegate rows add the exact non-null `evidenceIdentityHash`, `learningTaskBinding:"bound"`, server admission id, and immutable `taskInstanceId` / `attemptId`; legacy rows expose an explicit `legacy` + null binding (#61). Same auth as `GET /ledger`; unknown id → bare `404 not_found`. |
| `GET /metrics` | any valid key | Prometheus text 0.0.4 — counts, latency, token usage. Aggregated by model/outcome/tier. Never records content or per-user identifiers. |
| `POST /admin/models/load` | **admin** | `{modelKey, contextLength?, parallel?, gpu?, ttlSeconds?}`. |
| `POST /admin/models/unload` | **admin** | `{modelKey?}` (omit to unload all). |
| `POST /admin/models/download` | **admin** | `{modelKey, wait?}`. |
| `POST /admin/keys` | **admin** | Mint a key: `{alias, tier, modelAllowList?, rpm?, tpm?, dailyTokenBudget?, maxParallel?, creditLimit?, ttlSeconds?}` → `201 {plaintextKey, record}` (plaintext returned **only here**). |
| `GET /admin/keys` | **admin** | List keys as `ApiKeyPublic` (no hashes). |
| `DELETE /admin/keys/:alias` | **admin** | Soft-revoke a key → `200 {revoked:true}` or `404`. Malformed percent-encoding in `:alias` → `400 invalid_request_error` rather than a 500; route metrics/logs are always labelled the templated `/admin/keys/:alias`, never the raw request path (incl. the non-admin `403` case) (#229). |
| `GET /admin/maintenance` | **admin** | Current bench/maintenance state → `{maintenance, inflight, ownerQueued, maxInflight}`. |
| `POST /admin/maintenance` | **admin** | Toggle bench/maintenance mode: `{on: true\|false, ttlSeconds?: number}` → same status body. While **on**, guest admission is refused (`503` + `Retry-After`) and owner traffic flows unaffected. `ttlSeconds` (only meaningful with `on:true`; ignored when `on:false`) auto-expires the mode past the deadline even if nobody ever calls `{on:false}` — a crash-safety net for unattended jobs (#105). |

**Credits vs. daily budget.** `creditLimit` is a **lifetime, non-resetting** total-token cap
(0 = unlimited) — when `creditsUsed >= creditLimit` the key is refused with `402
credits_exhausted`. This is distinct from `dailyTokenBudget`, which resets at UTC midnight.
Invites bake in a `creditLimit` and carry it onto the key at redemption. Invite codes are
stored as **sha256 hashes only** (plaintext shown once), redemption is **strictly one-time**,
and the redeem path uses a uniform error so it cannot be used to probe which codes exist.

Auth is `Authorization: Bearer <key>`. **Safety default:** the gateway refuses to bind a
non-loopback host when no API keys are configured (no legacy keys **and** no minted keys) —
you cannot accidentally expose an unauthenticated endpoint to the LAN.

For non-owner tenants that should use ordinary gateway/MCP inference surfaces, mint a
named guest-tier key and treat the alias as the tenant identity. Example:

```bash
tsx src/homeserver/cli.ts keys mint --alias codex-cli --tier guest --models qwen3-coder --rpm 30 --daily 200000
```

`POST /delegate` is still owner-only; tenant validation runs that need that route should
use a named owner-tier key rather than the shared static owner key. `GET /ledger` exposes
the alias as `recent[].keyAlias` for gateway/MCP delegation rows, so auditors can verify
which tenant key produced a routing verdict without exposing the bearer token or key hash.
Legacy static keys appear as `static:*`; probe, CLI, and imported evidence rows keep
`keyAlias: null`.

**Privacy guarantee for `/metrics`:** the endpoint exposes only aggregate counts, durations,
and coarse labels (`model`, `outcome`, `tier`, `direction`, `lane`, `surface`). It never
records request/response content, key aliases or hashes, IP addresses, or any other PII.
Any key (owner or guest) may read the metrics; they reveal operational health, not per-user data.

### MCP transport (offload sub-tasks from Claude Code)

`POST /mcp` speaks the **MCP Streamable-HTTP** transport (hand-rolled JSON-RPC 2.0, one
message per POST — no SDK dependency; the surface is tiny). A friend on Claude Code adds the
box in **one command**:

```bash
claude mcp add --transport http local-llm https://inference.example.com/mcp \
  --header "Authorization: Bearer hs_..."
```

Claude can then offload self-contained sub-tasks (code gen / refactor, drafting,
classification, summarization, short reasoning) to the local models **as tools** — keeping the
data on the box and saving frontier tokens. It **reuses the same bearer key** as the rest of
the gateway, so the same **credit metering** (`reserveCredits`/`reconcileCredits`) and
**model allow-list** apply: the `ask` tool runs through the shared `runChatCompletion` helper
(`mcp.ts`) — the identical reserve → quota → admission → upstream → reconcile spine as
`/v1/chat/completions`, no self-HTTP-call, no duplicated billing logic.

| JSON-RPC method | Result |
|---|---|
| `initialize` | `{protocolVersion:"2025-06-18", capabilities:{tools:{}}, serverInfo:{name:"m5-local-models", version:"1.0.0"}}` + an `Mcp-Session-Id` response header (we are stateless — never required back). |
| `notifications/initialized` | `202 Accepted`, empty body. |
| `ping` | `{}`. |
| `tools/list` | the two tool defs (below). |
| `tools/call` | `{content:[{type:"text", text}], isError}`. |
| unknown / malformed | JSON-RPC `-32601` / `-32700` / `-32600` error (HTTP 200). |

**Tools** (both scoped to the key's allow-list):

- `list_models` — lists the model ids THIS key may use, each with a one-line strength hint.
- `ask` — `{model, prompt, system?, max_tokens?, temperature?, top_p?, top_k?, min_p?, delegator_model_id?, files?}` → runs a completion on the chosen
  local model and returns the text. A model outside the key's allow-list, an exhausted credit
  budget, a quota hit, or a busy box all map to `isError:true` with a clear message (never a
  thrown JSON-RPC fault). `max_tokens` uses the same fleet/per-model ceiling as raw chat.
  `delegator_model_id` is optional telemetry: owner/cloud-agent callers should set it to the
  cloud brain that delegated the task so the content-blind savings ledger can estimate actual
  cloud spend avoided. It is not forwarded to the local model.

#### Blind-context delegation (`files`, issue #128) — OWNER-TIER ONLY

`ask` accepts an optional `files: string[]` of **absolute paths on the box**. When present, the
gateway expands each file **server-side** into a clearly-delimited context block and prepends it
to the user message — so a cloud caller (Claude Code) can orchestrate over local data **it never
ingests**: only the box reads the file, the local model sees its content, and the frontier caller
sees only the model's answer text.

- **Owner-tier only, enforced in `mcp.ts`** — the earliest point in the request that has both the
  resolved principal tier and the tool-specific `files` argument. A **guest** key supplying
  `files` gets an explicit `isError:true` result (never silently ignored, never a no-op).
- **Disabled by default.** `HOMESERVER_BLIND_CONTEXT_ROOTS` (colon-separated absolute directories)
  is empty unless configured — with no roots, ANY `files` request errors with an actionable
  message. There is no way for an unset env var to silently widen into "everything is allowed."
- **Path safety** (`blind-context.ts`, the pure/unit-tested trust anchor): every input path (and
  every configured root) is resolved via `realpath` — which fully resolves symlinks AND collapses
  `..` segments — **before** the allow-list containment check runs. This closes both classic `../`
  traversal and a symlink planted inside an allowed root that points outside it. The read itself
  is TOCTOU-hardened: the canonical path is opened `O_NOFOLLOW|O_NONBLOCK`, verified + size-checked
  via `fstat` **on the open descriptor**, and read through that same descriptor — a final path
  component swapped to a symlink after the `realpath` check is rejected, and stat/read always
  describe the same inode. Relative entries in `HOMESERVER_BLIND_CONTEXT_ROOTS` are **dropped** (a
  CWD-dependent allowlist is a misconfiguration; fail-safe toward disabled). Non-files
  (directories, sockets), unreadable, and missing paths are each rejected with a distinct message.
- **Caps:** `HOMESERVER_BLIND_CONTEXT_MAX_FILE_BYTES` (default 256 KiB) per file,
  `HOMESERVER_BLIND_CONTEXT_MAX_TOTAL_BYTES` (default 1 MiB) across all files in one call — both
  re-checked against the **actual bytes read** (a file that grows mid-request cannot slip past the
  pre-read `fstat` check) — plus a hard cap of **64 files per request** (`MAX_FILES_PER_REQUEST`;
  the byte caps meter raw content only, so the count cap bounds the un-metered delimiter/path
  header overhead). A file that fails a null-byte binary heuristic (documented simplification, not
  full UTF-8 validation) is rejected rather than injected.
- **Injection format:** each file becomes `===== FILE: <path> =====\n<content>\n===== END FILE
  =====`, all blocks prepended to the prompt behind a one-line preamble noting they were attached
  server-side. **Prompt injection via attached content is an accepted, documented gap:** content is
  injected **verbatim** — a file that itself contains the delimiters (or adversarial instructions)
  can steer how the local model reads the blocks, and no in-band escaping is robust against a
  model. Treat attached files as untrusted model *input*, never trusted instructions; the guards
  above protect the *filesystem* boundary, not the model's interpretation of the content.
- **Content-blind logging is unaffected:** file paths and content NEVER reach the durable
  content-blind `request_log` (it has no such column by construction — see `request-log.ts`).
  They DO reach the owner-only full-content log (`owner-log.ts`) and the capability-ledger prompt
  excerpt (`ledger.ts`), exactly like the rest of an owner's own `ask` content already does — this
  is not a new exposure, since `files` is itself owner-tier-only.
**Owner-only tools** (`code_loop_start` / `code_loop_status` / `code_loop_result`, issue #116)
appear in `tools/list` **only** for a real minted **owner** key (`tier === "owner" && keyHash
!== null` — the exact `owner_request_log` guard; legacy static / implicit-admin are excluded).
A non-owner never sees them, and a direct `tools/call` on one returns the **byte-identical
unknown-tool error** a nonexistent tool would (invisible, not merely forbidden). See
*code_loop* below. The owner-visible `code_loop_start` description carries the stable pre-paid
advertisement `contract[harness=code-loop-pi-2026-07-14-v6;agent_checks=pi-bash-events-v3;schema=3;max_attempts=1000]`.

### code_loop — owner-only sandboxed agentic coding (#116)

An **async** job that wraps a **pi** subprocess (`@mariozechner/pi-coding-agent`, native
tool-calling: read/edit/write/bash) driving the local coding model inside an **OS cage**,
pointed back at the gateway's own `/v1`. The caller seeds a throwaway sandbox with inline
files; the deliverable is a **git diff vs the seed commit** — the box never mutates a live
checkout. Every loop turn transits the gateway spine (admission, `owner_request_log`,
poison-clear, the degeneracy watchdog), so it is the Claude→local **agentic-delegation
dataset** (RQ6/RQ7) with zero new logging code. Off by default (`HOMESERVER_CODE_LOOP=off`).

- `code_loop_start` — `{client_run_id?, learning_task_stamp?, instruction, files:[{path,content}], check_cmd?, protected?, task_type?, caps?}`
  → returns `{work_id, status, client_run_id, request_fingerprint, recovered, learning_task_gateway_echo?, capabilities}`
  immediately, or a structured refusal (`disabled` / `busy` / `maintenance` /
  `lease-unavailable` / `cage-unavailable` / `invalid-request` / `conflict` /
  `admission-recovery`). Optional
  `client_run_id` activates `client-run-id-v1`: an exclusive durable binding to the canonical
  request digest is committed before execution; same id+request recovers the original
  state/result across response loss/restart, and same id+different request conflicts. Recovery is
  checked before the single-flight busy gate. A separate content-blind SQLite singleton serializes
  paid execution across overlapping gateway processes and transactionally reclaims dead owners.
  During PID-only schema migration, a dead owner is reclaimed, a live owner is upgraded to sampled
  boot/start identity, and an unavailable identity probe preserves the row as unknown/busy; rolling
  overlap can never delete a live legacy lease. Omission
  remains non-idempotent for submission, but receives a server-only durable identity so restart
  recovery and the 24 h source-retention deadline are trusted for every run.
  `files` required (≤64 / ≤2 MB, relative paths). `caps` clamped to `wall_s ≤ 900`,
  `turns ≤ 40`, `completion_tokens ≤ 120000` (defaults 480 / 24 / 60000). An optional
  `caps.edit_deadline_turn` must be a positive integer no greater than effective `turns`; when
  present, the versioned policy requires the first completed `edit`/`write` tool call by that
  overall agent turn and otherwise terminates as `cap-exceeded` / `failure_kind:edit-deadline`.
  Omitting it preserves the original instruction and harness behavior. `check_cmd` is owner-authored,
  run in the sandbox **inside the same cage** post-loop (120 s cap).
  A `learning_task_stamp` opts into the accepted Grimnir LearningTaskContract v1. It requires the
  exact fresh response from authenticated `GET /v1/capabilities/learning-task`, a minted-key alias
  matching `expected_transport_principal_id`, `client_run_id === idempotency_key`, and a matching
  effective task type. The gateway validates the closed provenance/config/reference shape before
  admission and binds the full stamp plus observed (possibly wrapped) `instruction` in the durable
  request fingerprint; it does not mistake Hugin's logical raw-input hash for the transmitted
  Hugin-envelope bytes. It returns an exact, principal-bound `learning_task_gateway_echo` only
  after cage/GPU admission is durable. Exact retries recover the original echo unchanged; a crash
  between shared admission and work-record publication returns the distinct `admission-recovery`
  refusal plus that echo and never replays execution. The exact durable lookup precedes current
  epoch/freshness validation, mutable cap policy, and every transient execution gate; durable-run
  recovery also compares the complete persisted echo stamp with the incoming stamp. Only new
  claims require the current epoch/cap policy and proceed through transient gates. Altered,
  downgraded, or cross-caller requests still fail closed. Unstamped legacy starts keep both the
  existing behavior and
  their pre-feature durable request fingerprints. A shared SQLite guard also prevents a new
  idempotency key, request ID, client ID, or surface from re-admitting the same principal-bound task
  attempt. Clock validation deliberately has zero skew tolerance in v1; keep hosts synchronized and
  fetch a fresh preflight after a clock refusal. Guard records have no TTL until gille-inference #3
  defines delivery accounting and lifecycle/compaction. The actual Hugin one-shot lane is stamped
  `/delegate`; its #240 real serializer fixture is byte-pinned and consumed by this repo's tests.
- `code_loop_status` — `{work_id}` → `{status, usage}`.
- `code_loop_result` — `{work_id}` → the git diff (≤200 KB + `diff_truncated`), `changed_files`,
  `protected_violations`, pi's `summary`, the `check` result, `usage`, immutable effective
  `execution`, content-blind `telemetry`, and immutable agent-side `agent_checks`. The latter is
  derived only from real pi bash tool start/end events and exposes normalized check kind, command
  fingerprint, relative timing, order, status, and observed exit code—never command text, paths,
  stdout/stderr, prompt, source, or secrets. Pi-success events honestly carry `exit_code:null`;
  failed events use only pi's anchored process-generated exit suffix. State is `none` only when no
  check exists and event coverage is complete; unparseable NDJSON, refused check-shaped shell
  commands (including grouped/wrapped invocations), uncorrelated bash events, or absent engine telemetry produce `unobservable`/`partial`
  plus a content-blind coverage-loss count, regardless of model prose. Shell forms that can mask a
  failed check exit (`||`, pipelines, backgrounding, command tails, or multiple checks) are not
  promoted to check evidence. Attempts are capped at 1,000; dropped overflow increments coverage
  loss so the state becomes `partial`. It is distinct from the gateway-owned post-loop `check`.
  Telemetry reports first-edit turn/time only after a
  matching successful pi `tool_execution_end`; git changes without that event are `diff-only` and
  never receive invented timing. Inspect/edit/check phases are separate, with `phase_ms.check`
  covering the M5-side `check_cmd` only. Re-fetchable until the non-overlapping periodic 24 h TTL
  sweep reclaims the sandbox and compacts the source-bearing durable result from the trusted
  caller-or-server run record (never mutable sandbox metadata). A recordless/meta-less `cl-*`
  directory left before durable claim is reclaimed only after TTL from its non-symlink directory
  mtime. Cached results from an older/incompatible evidence contract fail closed as
  `terminal-unavailable` instead of being stamped with current capabilities.
  `status ∈ completed | cap-exceeded | degenerate |
  arm-error | orphaned` — there is deliberately **no** `pass` status; `completed` +
  `check.exit_code === 0` is the only pass signal.

**The OS cage (Phase-1 ship gate).** pi's `bash` and `check_cmd` (which imports model-edited
source — RCE by construction) run as the gateway uid, which owns `.env` + `data/eval.db`. Both
run inside a cage composed of THREE mechanisms, each **verified enforced on the box** (2026-07-02):

- `systemd-run --user --scope` — **resource** caps only: `MemoryMax=8G` + `TasksMax=256` bound
  the subprocess tree (the OOM lesson). **NOTE:** systemd `IPAddressDeny` is a **no-op in a
  `--user` scope on this box** (the unprivileged user manager can't install the cgroup BPF egress
  firewall — it's silently accepted but not enforced; a `/bin/true` primitive test can't reveal
  this). So egress is **not** enforced by systemd here.
- `pasta -T <forwardPort>` (passt) — **network**: runs the child in a fresh user+net namespace
  with **no general outbound route** (all egress blocked) and forwards **only one loopback port**
  to the host loopback, where a per-run relay bridges to the real gateway. The caged pi's *only*
  reachable destination is the gateway callback. The relay is a **path-allowlisted HTTP forwarder**
  (not a raw byte-pipe): since the service key is owner-tier, it forwards **only**
  `POST /v1/chat/completions`, `GET /v1/models`, and `GET /healthz` — every other path (incl.
  `/admin/*`) → `403 code_loop relay: path not allowed` without contacting the gateway
  (`homeserver_code_loop_relay_denied_total`), so a prompt-injected pi can't reach an admin route.
- `bwrap --share-net` — **filesystem**: shares pasta's restricted netns (never `--unshare-net`),
  a tmpfs over `$HOME` (hides all secrets/eval.db/ssh), read-only toolchain + `node_modules`,
  read-write bind of the sandbox only.

The design never *claims* confinement — it **tests** it: the cage self-test runs the confinement
probe inside the exact cage argv (with the relay up) at provisioning **and every job start**, and
asserts secrets unreadable, a write to the read-only toolchain denied, external egress blocked,
and the gateway reachable (HTTP 200). With `HOMESERVER_CODE_LOOP_CONFINEMENT=required` (default) a
failing probe refuses the job with `cage-unavailable`.

**Box provisioning runbook** (one-time; details in `docs/agentic-code-tool-design.md` §3):

1. Pin-install pi **outside the rsync root** (verify the current published package first — it
   is `@mariozechner/pi-coding-agent`, NOT `@mariozechner/pi`, which is an unrelated tool):
   `npm install -g @mariozechner/pi-coding-agent@0.70.2` (prefix `-g` = `~/.local` → binary
   `~/.local/bin/pi`). Set `HOMESERVER_CODE_LOOP_PI_BIN` to that path.
2. `PI_CODING_AGENT_DIR` (e.g. `~/.pi-code-loop`) containing only `models.json` — copy
   `deploy/pi-models.json.example`. `baseUrl` **MUST be the in-cage loopback forward**
   `http://127.0.0.1:<HOMESERVER_CODE_LOOP_FORWARD_PORT>/v1` (default `http://127.0.0.1:18080/v1`),
   NOT the tailnet IP (the cage blocks it) — pasta forwards that loopback port to the host relay
   that bridges to the real gateway. `apiKey:"HS_API_KEY"` is an env-var reference the harness
   fills at spawn. Set `HOMESERVER_CODE_LOOP_PI_AGENT_DIR` to that dir.
3. Mint the service key with a **fresh timestamped alias**:
   `keys mint --alias code-loop-$(date +%Y%m%d-%H%M%S) --tier owner` allow-listed to
   `qwen3-coder-next-80b` with TPM/daily quotas → `.env` as `HOMESERVER_CODE_LOOP_API_KEY`.
   The key must be a **real keystore owner key** (non-null `keyHash`) — that is what makes
   `owner_request_log` fire per turn. Never write the key value into `models.json`.
4. `apt install bubblewrap passt` (bwrap + pasta), then run the **cage self-test ship gate**.
   The gateway binds the tailnet IP, so target it explicitly:
   `HOMESERVER_HOST=<tailnet-ip> tsx src/homeserver/cli.ts code-loop cage-test`
   (or `... code-loop cage-test --gateway-url http://<tailnet-ip>:8080`) → must print
   `cage self-test: PASS`.
5. Set `HOMESERVER_CODE_LOOP=on` and restart the gateway.

### Per-key auth, quota & admission (the gateway spine)

Every inference request resolves to a **principal** — either a minted key (primary) or a
legacy static key (`HOMESERVER_API_KEYS` → guest, `HOMESERVER_ADMIN_API_KEYS` → owner).
Minted keys are stored as **sha256 hashes only** (plaintext is returned once at mint time
and never persisted); lookup is timing-safe. Each request then passes the spine:

1. **Model allow-list** — a key with a non-empty `modelAllowList` requesting any other
   model gets `403 model_not_allowed`.
2. **`max_tokens` cap** — every request's `max_tokens` is clamped to
   `min(request, HOMESERVER_PER_REQUEST_MAX_TOKENS)` before proxying.
3. **Quota** — per-key sliding-window RPM/TPM (60s) + a persisted daily token budget.
   Over-budget → `429 rate_limit_exceeded` with `Retry-After` + `X-RateLimit-*`.
4. **Admission (two lanes)** — a single GPU-slot budget (`HOMESERVER_MAX_INFLIGHT`) is
   shared. When the box is at capacity: **guest** requests get an immediate, honest
   `503 server_busy`; **owner** requests *queue* up to `HOMESERVER_OWNER_QUEUE_MAX_MS`
   for a slot to free (owner preempts guest under contention). A per-key `maxParallel`
   in-flight cap stops one key monopolizing the box.
5. **Bench / maintenance mode (#108, TTL safety net #105)** — `POST /admin/maintenance {on:true}`
   (or boot with `HOMESERVER_MAINTENANCE_MODE=on`) makes the gateway refuse **guest** admission
   with `503` + `Retry-After: HOMESERVER_MAINTENANCE_RETRY_AFTER_S` while a heavy batch /
   benchmarking job reserves the box; **owner** traffic is never blocked by it, and
   already-admitted requests run to completion. Toggle off with `{on:false}`. An owner key
   is admin-tier, so a heavy job can flip it itself:
   `curl -X POST http://<m5>:8080/admin/maintenance -H "Authorization: Bearer $(m5-auth)" -d '{"on":true}'`.
   Optionally pass `{"on":true,"ttlSeconds":7200}` — the mode then self-expires past the deadline
   even if the job dies uncleanly (crash/OOM/SIGKILL) before it can call `{on:false}`, so guests
   can never be locked out forever with no recovery path. The weekly Model Scout uses this around
   its ephemeral candidate-evaluation window (`docs/weekly-model-scout-runbook.md`).

Every auth / inference error uses a uniform OpenAI-shaped envelope:
`{ error: { message, type, code, param } }` with the right status (401/403/400/429/503)
and `Retry-After` / `X-RateLimit-*` headers where applicable.

## CLI (`hs`) — friend-facing command-line client

`client/hs.mjs` is a self-contained Node ESM script (Node 18+, zero external deps) that
friends can drop on their `$PATH` to talk to the gateway without writing curl or an SDK.

**Install:** copy or `curl` the file and `chmod +x`.

**Main commands:**

| Command | What it does |
|---|---|
| `hs redeem <inv_code>` | Trade a one-time invite code for a key; stores `~/.config/hs/config.json`. |
| `hs models` | List model IDs your key may use (`GET /v1/models`). |
| `hs ask [-m <model>] <prompt...>` | Stream a chat completion to stdout (`POST /v1/chat/completions`). |
| `hs usage` | Show tier, models, and credit usage (`GET /portal/me`). |

Everything is the OpenAI API + portal under the hood; the `hs` wrapper just handles auth,
SSE stream parsing, and config persistence.

## Coordinating heavy GPU jobs — `gpu` (issue #88)

The box serves **one model at a time** (serial GPU via llama-swap). Two concurrent heavy owner
jobs targeting *different* models thrash the GPU — every request cold-swaps the loaded model,
degrading both. The gateway's owner-preempts-guest admission can't help (both are owner tier) and
experiment scripts hit llama-swap `:8091` directly, bypassing the gateway. The `gpu` CLI is a
cooperative **FIFO lease** so heavy batch jobs *sequence* instead of colliding:

```bash
# Wrap any heavy run — acquire the GPU (waiting FIFO if busy), run, release on exit (even on crash):
tsx src/homeserver/cli.ts gpu run --model qwen3-coder-next-80b --eta 20m --purpose cascade \
  -- tsx scripts/cascade-gate-experiment.ts

# See who holds the GPU and who's queued (+ ETA):
tsx src/homeserver/cli.ts gpu status
```

- **FIFO + mutual exclusion:** one job holds the GPU; later jobs wait their turn and print their
  queue position + the holder's purpose/ETA. No starvation (order is by enqueue time).
- **Crash-safe / self-expiring:** the lease releases on exit *and* on `SIGINT`/`SIGTERM`; a job
  that dies hard stops heartbeating and its ticket is reclaimed after `HOMESERVER_GPU_LEASE_STALE_MS`.
- This **replaces** the box-local `run-cascade.sh` "polite wait-for-idle" stopgap. Wrap the heavy
  experiment runners (`cascade-gate-experiment.ts`, `m5-cartography.ts`, the `dr-*`/`frames-*`
  batteries, `gate-e-bench.ts`) in `gpu run` when another owner session may be live on the box.
- It is **advisory** — only jobs that opt in via `gpu run` are coordinated. A job that hits
  llama-swap directly without wrapping still bypasses it.

## Environment variables

```
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1   # LM Studio OpenAI-compat base (also used as llama-swap base when HOMESERVER_BACKEND=llamaswap, strip /v1)
HOMESERVER_BACKEND=llamaswap                  # Model-admin backend: "llamaswap" (default, #146) | "lmstudio" (DEPRECATED — kept one release)
HOMESERVER_USE_ROUTING_TABLE=off              # "on" → orchestrator uses docs/m5-routing.json (routing-table.ts) to pick the model per task type + escalate gap types (sql) to frontier. Default "off" (loaded-model + ledger). Explicit task.modelId always wins. Pairs best with HOMESERVER_BACKEND=llamaswap (hot-swaps the routed model in); on the deprecated lmstudio backend a routed-but-not-resident model fails SAFE — the local call errors and escalates to frontier (never a wrong answer, just an extra escalation). Owner-tier /delegate path only.
HOMESERVER_SHADOW_LANE=off                    # "on" → after a no-local-attempt frontier escalation, run a lowest-priority M5 candidate in the background and store shadow-flagged candidate evidence. Never returned to the caller; excluded from normal ledger rollups.
HOMESERVER_SHADOW_LANE_MODEL=                  # Explicit local candidate model. Empty falls back to the currently loaded model.
HOMESERVER_SHADOW_LANE_TASK_TYPES=             # Optional comma-separated allow-list; empty shadows every escalated task type.
HOMESERVER_SHADOW_LANE_MAX_TOKENS=0            # 0 inherits the task budget; positive values cap it deliberately.
HOMESERVER_SHADOW_LANE_TIMEOUT_MS=120000       # Background call wall-clock ceiling.
HOMESERVER_SHADOW_LANE_AGREEMENT=0.7           # Pass threshold when grading against a returned frontier answer (candidate evidence only).
HOMESERVER_DELEGATE_POLICY=off                # Production lane gate: off (default, behaviour-preserving) | shadow (compute/log allow|shadow|deny, do not change routing) | enforce (only certified verifier-backed lanes call local inference; shadow/deny escalates).
HOMESERVER_DELEGATE_POLICY_MIN_SAMPLES=10     # exact task_type+model+verifier evidence floor before production allow
HOMESERVER_DELEGATE_POLICY_MIN_SUCCESS=0.95   # default pass/partial success threshold for production allow
HOMESERVER_DELEGATE_POLICY_LOW_RISK_SUCCESS=0.9  # lower threshold for low-risk draft lanes (rewrite/summarize/translate)
HOMESERVER_DELEGATE_POLICY_MAX_ERROR_RATE=0.05   # max capability-error rate (infra errors excluded)
HOMESERVER_DELEGATE_POLICY_MAX_P90_LATENCY_MS=30000  # max lane p90 latency for production allow
HOMESERVER_DISAGREEMENT_GATE=off              # Cross-model disagreement escalation gate (disagreement-gate.ts). "off" (default, behaviour-preserving) | "shadow" (run the 2nd model + RECORD the disagreement in the ledger, but do NOT change routing — the "validate in the live ledger before default" path) | "on" (run + escalate on disagreement). Only fires on the UNVERIFIED delegation path (a deterministic verifier verdict is trusted instead). NOTE: on a serial-GPU box this forces a primary→secondary model swap per gated task — validate the swap cost in "shadow" before "on".
HOMESERVER_DISAGREEMENT_GATE_MODEL=qwen3-coder-next-80b  # the 2nd local model the gate compares against the primary (must differ from the primary; a model can't disagree with itself)
HOMESERVER_DISAGREEMENT_GATE_THRESHOLD=0.3    # disagreementScore ≥ this → escalate. 0.3 reproduces the validated ~10.5% operating point (catch 100% of frontier-divergent cases)
HOMESERVER_GPU_LEASE_DIR=./data/gpu-leases    # FIFO GPU-lease directory (gpu-lease.ts, issue #88) — one ticket file per heavy batch job `gpu run` serializes. Gitignored.
HOMESERVER_GPU_LEASE_STALE_MS=30000           # heartbeat-staleness window: a job that stops heartbeating for longer is reclaimed (a dead job never holds the GPU forever). Must exceed the 5s heartbeat.
LLAMASWAP_BASE_URL=http://127.0.0.1:8080      # llama-swap origin (overrides the /v1 strip of LMSTUDIO_BASE_URL); only read when backend=llamaswap
HOMESERVER_HOST=127.0.0.1                     # set 0.0.0.0 to serve the LAN
HOMESERVER_PORT=8080
HOMESERVER_API_KEYS=key1,key2                 # bearer tokens for normal endpoints
HOMESERVER_ADMIN_API_KEYS=adminkey            # bearer tokens for /admin/* (model mgmt)
HOMESERVER_MONITOR_API_KEYS=monitorkey        # read-only monitor keys — GET /healthz,/ledger,/ledger/{id},/metrics,/models only
HOMESERVER_MIN_CONTEXT=32768                  # context floor the orchestrator enforces
HOMESERVER_MAX_TOKENS=12288                   # default per-call token budget
HOMESERVER_CALL_TIMEOUT_MS=600000             # per-call wall-clock guard (spiral cap)
HOMESERVER_AUTO_JSON_RESPONSE_FORMAT=on       # JSON-shaped task types (taxonomy jsonOutput: triage, source-distill) delegate with response_format {type:json_object} → llama.cpp grammar-constrained decoding → prevents gpt-oss-120b's harmony/PEG 500 (#166). "off" disables (backend that ignores response_format). An explicit task/HTTP responseFormat always wins.
HOMESERVER_DELEGATION_COST_LOG=on             # content-blind delegation_costs writes for /delegate + owner MCP ask. Verified savings is zero unless outcome=pass.
HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID=        # optional default actual cloud brain baseline; /delegate delegatorModelId overrides per call
HOMESERVER_PREMIUM_BASELINE_MODEL_ID=claude-fable-5  # fixed high-end baseline for premium savings
HOMESERVER_M5_MARGINAL_USD_PER_MTOK=0         # local marginal cost allocation per 1M local tokens; 0 until calibrated
HOMESERVER_M5_AMORTIZED_USD_PER_MTOK=0        # hardware amortization allocation per 1M local tokens; 0 until calibrated
HOMESERVER_USD_TO_SEK=10.5                    # dashboard conversion for savings panels
HOMESERVER_MAX_INFLIGHT=2                      # GPU slot budget (concurrent requests)
HOMESERVER_OWNER_QUEUE_MAX_MS=5000            # how long an owner may queue for a slot
HOMESERVER_BUSY_RETRY_AFTER_S=2               # Retry-After on a guest 503 at capacity
HOMESERVER_MAINTENANCE_MODE=off               # boot in bench/maintenance mode (guests refused) — #108
HOMESERVER_MAINTENANCE_RETRY_AFTER_S=30       # Retry-After on a guest 503 caused by maintenance mode
HOMESERVER_PER_REQUEST_MAX_TOKENS=12288       # fleet default and ordinary-model cap
HOMESERVER_MODEL_MAX_TOKENS=vibethinker-3b=32768 # exact-model explicit-request ceilings; empty disables
HOMESERVER_RECURRENT_MODEL_IDS=qwen3-coder-next-80b  # recurrent models that poison-clear (unload) on abrupt disconnect; "" disables. Default qwen3-coder-next-80b.
HOMESERVER_POISON_CLEAR_COOLDOWN_MS=60000     # ≤1 recurrent-model unload per window (recovery-latency dial; see docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md)
HOMESERVER_DEGENERACY_RUN_THRESHOLD=400       # Fix #2 silent backstop: ≥N consecutive identical non-ws chars in a recurrent model's SSE stream → abort + poison-clear (the no-disconnect "?????" case). 0 disables.
HOMESERVER_KEY_DEFAULT_RPM=60                 # default requests/min for a new key
HOMESERVER_KEY_DEFAULT_TPM=60000             # default tokens/min for a new key
HOMESERVER_KEY_DEFAULT_DAILY_TOKENS=0        # default daily token budget (0 = unlimited)
HOMESERVER_KEY_DEFAULT_MAX_PARALLEL=1        # default per-key in-flight cap
HOMESERVER_WHISPER_URL=http://127.0.0.1:8092 # speech-to-text backend (POST /inference); for /v1/audio/transcriptions
HOMESERVER_AUDIO_CREDITS_PER_SECOND=50       # credits per second of audio: cost = ceil(duration) * this
HOMESERVER_AUDIO_DEFAULT_LANGUAGE=auto       # language forwarded to whisper-server when client omits it
HOMESERVER_AUDIO_MAX_SECONDS=1800            # worst-case billable audio length; drives the up-front credit reservation + the over-cap duration clamp
HOMESERVER_AUDIO_MAX_BYTES=33554432          # max transcription upload size (bytes); over-cap Content-Length ⇒ 413 before buffering (default 32 MiB)
HOMESERVER_AUDIO_READ_IDLE_MS=30000          # idle/socket read timeout (ms) on the audio upload — drops slow-loris clients
HOMESERVER_IMAGE_URL=                         # text→image sidecar (POST /v1/images/generations). EMPTY = image surface INERT (404, no image-* advertised, no worker)
HOMESERVER_IMAGE_MAX_N=4                      # max images per request (n); clamped
HOMESERVER_IMAGE_PROMPT_MAX_CHARS=2000        # max prompt length for image generation
HOMESERVER_IMAGE_SIZES=512x512,768x768,1024x1024  # allowed sizes; HOMESERVER_IMAGE_DEFAULT_SIZE=1024x1024
HOMESERVER_IMAGE_GPU_SLOTS=1                  # concurrent diffusion jobs (only 1 supported today)
HOMESERVER_IMAGE_JOB_TIMEOUT_MS=300000        # per-job wall-clock ceiling (5 min)
HOMESERVER_IMAGE_RESULT_DIR=./data/image-results  # async result buffer (gitignored); HOMESERVER_IMAGE_RESULT_TTL_MS=3600000
HOMESERVER_IMAGE_CREDITS_PER_IMAGE_{FAST,BALANCED,HIGH}=5000,20000,60000  # per-image credit price by tier
HOMESERVER_IMAGE_MODEL_{FAST,BALANCED,HIGH}=sdxl-turbo,sd3.5-large-turbo,flux.1-schnell  # sidecar model id per tier
HOMESERVER_BLIND_CONTEXT_ROOTS=                # colon-separated absolute dirs the OWNER-ONLY MCP `ask` `files` param may read from. EMPTY (default) = feature DISABLED — any `files` request errors. See "Blind-context delegation" under MCP transport.
HOMESERVER_BLIND_CONTEXT_MAX_FILE_BYTES=262144     # per-file byte cap (default 256 KiB)
HOMESERVER_BLIND_CONTEXT_MAX_TOTAL_BYTES=1048576   # cumulative byte cap across all files in one `ask` call (default 1 MiB)
# policy knobs: HOMESERVER_POLICY_{MIN_SAMPLES,MAX_SAMPLES,MAX_FAILS,VIABLE,MARGINAL,EXPLORATION}
HOMESERVER_JUDGMENT_QUALITY_TASK_TYPES=code-review  # csv of JUDGMENT-QUALITY task types (#156): selects WHICH task types are graded under the verdict-hygiene whitelist below. Unset → default (code-review); set to empty to disable (those types then use ordinary verdict math).
HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS=              # csv of verifiers TRUSTED to grade judgment-quality output (#168 WHITELIST, supersedes #156's blacklist). For a judgment-quality task type a ledger row counts toward the verdict ONLY IF its verifier base-name is in this set — so an opaque/non-adversarial pass (`predicate`, `matches`, `nonEmpty`) can never manufacture a false viable/not_viable. DEFAULT EMPTY (unset AND empty both → []): with no verifier trusted yet, code-review resolves to `unknown` → escalate-frontier (honest). Add #158's ground-truth code-review verifier here to give code-review a real local verdict.
HOMESERVER_DISCOUNT_FORMAT_ONLY_EVIDENCE=off   # #233: "on" discounts format-only-verified passes/partials (mechanical-format verifier: jsonValid, nonEmpty, containsAll, …) when computing successRate for judgment-flavored task types — see verifier-classification.ts's classifyVerifierKind. Default off = fully behaviour-preserving (a format-only pass counts as full evidence exactly as before).
HOMESERVER_FORMAT_DISCOUNT_TASK_TYPES=classify,qa-factual,triage,claim-verify  # csv of task types the discount above applies to when enabled. Unset → this default; set to empty to disable for every type (equivalent to leaving the discount off).
HOMESERVER_FORMAT_DISCOUNT_WEIGHT=0.5          # weight in [0,1] applied to a format-only-verified pass/partial's contribution to successRate when the discount is active. Clamped to [0,1] at load time.
# ── code_loop — owner-only sandboxed agentic coding tool (#116) ──
HOMESERVER_CODE_LOOP=off                       # master switch. off (default) → the MCP tools are visible to owners but code_loop_start returns `disabled`. on → runs.
HOMESERVER_CODE_LOOP_PI_BIN=                   # abs path to the pinned pi binary (vendor install OUTSIDE the rsync root, e.g. ~/.local/bin/pi)
HOMESERVER_CODE_LOOP_API_KEY=                  # the minted OWNER-tier service key pi calls back with (allow-listed to the 80b). Real keystore key → owner_request_log fires per turn. Never in models.json.
HOMESERVER_CODE_LOOP_PI_AGENT_DIR=             # PI_CODING_AGENT_DIR — holds models.json (see deploy/pi-models.json.example; baseUrl = the loopback forward, NOT the tailnet IP) AND pi's own auth.json credential store; the cage binds ONLY <dir>/models.json (auth.json stays hidden in-cage)
HOMESERVER_CODE_LOOP_WORKROOT=./data/code-loop-work  # throwaway sandbox root (under ./data so rsync never touches it; under the deploy dir so check_cmd's `npx --no-install` walk-up resolves node_modules)
HOMESERVER_CODE_LOOP_MODEL=qwen3-coder-next-80b      # the single loop model (allow-listed on the service key)
HOMESERVER_CODE_LOOP_CONFINEMENT=required      # required (default) → a failing cage self-test refuses the job (cage-unavailable). off → NO cage (offline unit tests ONLY; never on the box). Needs bwrap + pasta (passt) installed.
HOMESERVER_CODE_LOOP_FORWARD_PORT=18080        # loopback port pasta forwards (in-cage) to the host relay → gateway; the caged pi's ONLY reachable destination. Must match the baseUrl port in models.json.
HOMESERVER_CODE_LOOP_WALL_S=480                # default wall-clock cap (s); HOMESERVER_CODE_LOOP_WALL_S_MAX=900 hard max
HOMESERVER_CODE_LOOP_TURNS=24                  # default turn cap; HOMESERVER_CODE_LOOP_TURNS_MAX=40 hard max
HOMESERVER_CODE_LOOP_TOKENS=60000             # default completion-token cap; HOMESERVER_CODE_LOOP_TOKENS_MAX=120000 hard max
EVAL_DB_PATH=./data/eval.db                   # ledger + api_keys live in the shared SQLite DB

# ── deep-research harness (deep-research-config.ts; full set also in the design doc) ──
SEARCH_PROVIDER=searxng                        # searxng | brave | tavily | ddgs (Docker-free, no key)
SEARCH_FALLBACK_PROVIDER=brave                 # provider used when the primary's breaker trips
DDGS_PYTHON=python3                            # interpreter that runs the ddgs helper
DDGS_SCRIPT=scripts/ddgs_search.py             # ddgs helper; a RELATIVE path resolves against the repo root (cwd-independent)
RESEARCH_CITATION_THRESHOLD=0.8                # distilled-claim → source span match threshold
RESEARCH_REPORT_SENTENCE_THRESHOLD=0.45        # report-sentence → cited-source support threshold (Phase-2; calibrated on the live dogfood)
# ── synthesis quality (2026-06-21 study; all default-off so behavior is preserved) ──
RESEARCH_SYNTH_STRATEGY=oneshot                # oneshot | reground (grounding-repair: synth→verify→re-ground unsupported sentences). reground is the VALIDATED citation win — recommend ON for research.
RESEARCH_SYNTH_REPAIR_ROUNDS=1                 # max reground repair passes (each = 1 synth call)
RESEARCH_SYNTH_ATOMIC=false                    # one-claim-per-sentence prompt. Maxes the grounding METRIC but the judge rates it worse (choppy/shallow) — a citation-vs-readability trade-off, default OFF
RESEARCH_PLANNER_TEMP=0  RESEARCH_DISTILL_TEMP=0  RESEARCH_SYNTH_TEMP=0          # per-role temperature (raise >0 for reasoning MoEs, which degenerate-loop at 0)
RESEARCH_PLANNER_MIN_TOKENS=0  RESEARCH_DISTILL_MIN_TOKENS=0  RESEARCH_SYNTH_MIN_TOKENS=0  # per-role max_tokens floor (raise to ~16-24k for a reasoning synth so it doesn't blank mid-reasoning)
```

## LM Studio settings that block the intended behaviour (FLAGGED)

1. **Context length is per-instance and split across `parallel` slots.** The box arrived
   loaded at `context_length: 4096` with `parallel: 4` → effectively **1024 tokens/slot**,
   far too small for agentic delegation (reasoning alone needs ≥12k). Fix:
   `ensure-ctx` reloads at `parallel: 1` and the full 32768 window. On the 128GB box this
   can go much higher.
2. **LM Studio's own server ignores its API key** — there is no real auth on `:1234`.
   That is why this scaffold puts an authenticated gateway in front of it; never expose
   `:1234` directly to the LAN.
3. **"Serve on Local Network" + JIT loading.** To reach LM Studio from the box's LAN you
   must enable *Serve on Local Network* in LM Studio (or run the gateway on the same host
   and bind it to `0.0.0.0`). Disable JIT/idle-evict, or set a generous TTL, so a model is
   not evicted mid-orchestration.
4. **Greedy `temperature: 0` triggers degenerate repetition** on MoE/reasoning models.
   The inference client already applies the sampler floor (`temp 0.6, top_p 0.95, top_k 20`).

## Deploying to the BosGame box (later)

This module is intentionally self-contained and reuses only `../db.ts` and `../env.ts`.
To run it on the box: install LM Studio (or `llama-server`), point `LMSTUDIO_BASE_URL`
at it, set `HOMESERVER_HOST=0.0.0.0` + API keys, and run `tsx src/homeserver/cli.ts serve`
under a process supervisor (launchd/systemd). A future v2 can split this into its own
package with a real `llama-server` backend (per the deep-research Tier-A recommendation).
