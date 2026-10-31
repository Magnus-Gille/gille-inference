# Customer System One decision models

## Selection and evidence (2026-10-07)

The first customer decision model was Cloudflare Clef-flash, under the ID `clef-flash`.
Cloudflare publishes Apache-2.0 weights and reports strong results on several typed-decision
benchmarks, including 98.76% BFCL case-exact and 93.11% API-Bank accuracy, but weaker results on
some others (65.58% When2Call and 66.77% CLINC150+OOS macro-F1). These are *publisher-reported*
figures, not M5 quality measurements or a promise of calibration on customer data.
The [Cloudflare announcement](https://blog.cloudflare.com/clef-decision-models/) gives the
evaluation details. The [official model card](https://huggingface.co/Cloudflare/clef-flash)
states the license and architecture. The
[ggml-org GGUF conversion](https://huggingface.co/ggml-org/Clef-Flash-GGUF) has more than 17,000
reported downloads in its latest-month counter and supplies a 9.66 GB Q8_0 file with
[SHA256 `d7c352fa…2f1f1`](https://huggingface.co/ggml-org/Clef-Flash-GGUF/blob/4a192915ef971886004b5b13294f2b4c7a7fc39d/Clef-Flash-Q8_0.gguf)
at immutable repository revision `4a192915ef971886004b5b13294f2b4c7a7fc39d`.
Download count indicates interest, not quality. Q8_0 quality and latency on M5 remain unmeasured.

Datagate's existing local candidate is [Bespoke Nimble 9B](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B),
release v3-12026. Its weights and isolated native PyTorch/ROCm experiment are retained on M5;
it is not in the active llama-swap customer catalogue. Datagate's local model selection pins the
Apache-2.0 model package and records the crucial distinction between the current release and
older published benchmark weights. Bespoke's [public repository](https://github.com/bespokelabsai/nimble)
reports 74.8% macro agreement over 3,880 human-labelled examples for an *older* checkpoint,
against 76.0% for Jev. Datagate's local tests remain exploratory and do not establish customer
quality. The current release has no independently
verified Swedish quality or calibration and needs its own durable serving adapter, GPU admission
integration, and per-customer billing path. Keep it as the second candidate for a separate
qualification; having weights on M5 does not make it customer-ready. The follow-on proposal below
keeps that qualification boundary explicit.

Datagate also used the already-served `qwen3-30b-instruct` as an ordinary chat model in
structured-prompt experiments. It is a distinct, existing M5 model, not a trained System One
decider. Customer access to it uses `/v1/chat/completions` and ordinary credits. An unrestricted
customer key already has chat access; an exact batch of restricted customer keys can receive this
ID through `/admin/keys/chat-grants` after live key inventory and review.

Perplexity's 27B decider was initially deferred because its
[model card](https://huggingface.co/perplexity-ai/pplx-decider-v1-27b) calls for about 49 GiB of
weights plus working memory and documents CUDA inference. That is a much larger, unverified load
on the M5's serial GPU. It is now a second proposed follow-on candidate, alongside Nimble, pending
the same isolated M5 comparison on customer-like tasks. Neither candidate is customer-available
until its native adapter, measured memory/latency, representative quality checks, and rollback
path have passed the release gate below.

## Proposed follow-on models (pending M5 evaluation)

These are the two additions covered by the follow-on release work. They are public, reviewable
contracts only; neither entry is a live customer entitlement until the host evaluation and
production roster transaction succeed.

| Customer model ID | Immutable upstream identity | License and serving note |
|---|---|---|
| `bespoke-nimble-9b` | [`bespokelabs/Bespoke-Nimble-9B`](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B), revision `bd792f44ec8e265be861bfcdf4e05967ffe0e858` (release `v3-12026`); adapter SHA256 `1d902afdc030428487aeb0b51cf4bb3ba67d5ea54c3226c0c4a435ff90242747` | Apache-2.0. Native Python/ROCm adapter; the public spec is a placeholder and does not prove M5 readiness. |
| `pplx-decider-v1-27b` | [`perplexity-ai/pplx-decider-v1-27b`](https://huggingface.co/perplexity-ai/pplx-decider-v1-27b), revision `5117a6c7fe73b19308dc1a6b0fb529a40c2ecad4` | Apache-2.0. Preserve the model's readout and decision temperature in the native adapter; its approximately 49 GiB BF16 weights plus working memory require a measured M5 check. |

Both IDs use the typed `/v1/systemone` contract. After a successful promotion, an existing
customer key must receive an explicit grant for the exact ID through the atomic grant operation;
the call then consumes that key's ordinary lifetime credits and existing rate quotas. A public
spec, enabled setting, or source checkout alone does not grant access or establish availability.

## Customer contract

- `POST /v1/systemone` uses the existing bearer key, an explicit System One grant, credit cap, rate quota,
  owner-preempting GPU admission, and host-memory admission. The endpoint is disabled until
  `HOMESERVER_SYSTEMONE_MODELS` contains the exact promoted decision-model ID on the gateway. A guest key must
  explicitly have that ID in `systemOneModelAllowList` (or the legacy ordinary
  `modelAllowList`). An empty guest ordinary allow-list grants ordinary chat models but not
  decision models. Granting a decision model to such a key leaves ordinary chat access intact.
  Owner keys with an empty ordinary allow-list can run release checks before guest access is granted.
- Request: `model`, a text or JSON-object `state`, and 1–16 named `questions`. Each question has
  `type` (`noul`, `choice`, or `score`) and `instructions`; `choice` needs a criteria object with
  2–26 named options. Each option key must match `^[A-Za-z0-9_-]{1,64}$`, and each option
  description must be a string or `null`. `score` needs 2–10 ordered labels. The gateway accepts
  at most 256 KiB (262,144 bytes) of UTF-8 request JSON, including state, questions and formatting.
  This is a transport-size bound, not a token allowance. Nimble checks every complete prompt against
  its tokenizer-specific input bound before scoring. The default bound is 8,192 tokens:
  Clef reserves one shared 8,192-token prompt, while Nimble and Decider reserve one bound per
  question. Nimble alone accepts optional `input_token_limit`, a positive safe integer from
  1 through 8,192 (default 8,192). JSON bytes cannot be converted to tokens with a fixed ratio.
  Exceeding the byte cap returns `413 payload_too_large` before inference; a body within that cap
  can still exceed the backend context and be rejected upstream. This change does not increase
  runtime context or establish a publisher maximum.
  Images, streaming, `keep_alive`, and arbitrary runtime parameters
  are not enabled in this release.
- Response: compatible typed `answers` and `usage` from the selected decision adapter. Credits
  charge successful billable input usage; rejected or failed calls charge zero. A decision model
  is not a chat model: `/v1/chat/completions` and MCP `ask` reject it.
- Admission reserves the model's maximum input allowance before inference and reconciles only a
  successful response. Clef reserves one shared 8,192-token prompt; Nimble and Decider reserve
  `question_count × input_token_limit` (or `question_count × 8,192` when omitted). The separate
  16-question schema cap does not change these reservations. Thus eight default Nimble questions
  reserve 65,536 tokens and can fail with `400 request_exceeds_quota` under a 60,000-token TPM
  limit; a bound such as 2,048 can fit if every complete prompt fits it. The native Nimble and
  Decider adapters must publish and enforce their own measured input bounds before customer
  activation; an upstream response above the reviewed bound is rejected.
- `/v1/models` and `/models` list a decision model only after it is in the llama-swap roster and the key can
  use it. A known decision model stays out of chat, MCP `ask`, delegation and model discovery
  even if its enablement setting is removed while it remains in the roster. MCP `list_models`
  remains a list of chat models for the MCP `ask` tool.
- The gateway never records guest state/questions/answers in the owner content log. Existing
  request telemetry is content-blind and uses only the configured model ID.

## Billing, failure and retry contract

Nimble native responses report exact `usage.input_tokens` as the sum of the question-prompt token
counts. When present, `shared_prefix_tokens` is the longest common token prefix across those
question prompts and `billable_input_tokens` must equal:

```text
input_tokens - (question_count - 1) * shared_prefix_tokens
```

Per-key TPM/daily resource-quota admission reserves the conservative maximum, then reconciles to exact compute usage; the
shared-prefix value changes lifetime credit billing only. It is not a compute-savings claim.
Legacy adapters that omit the metadata bill the raw input count, and Decider remains raw-input
billing. A malformed or inconsistent usage response is rejected and charged zero.

An upstream native context rejection is sanitized to `400 context_length_exceeded`; temporary
backend unavailability is `503 server_busy` with `Retry-After`; a timeout is `504
upstream_timeout` with retry guidance. Clients may retry retryable failures with bounded jitter,
but must not retry `402 credits_exhausted` and must not automatically replay a request whose
response outcome is unknown. The pre-admission maximum-reservation refusal is
`400 request_exceeds_quota`; a later temporary TPM/daily quota hit is the ordinary
`429 rate_limit_exceeded` response with its retry/reset guidance. All failed requests
charge zero credits.

The reservation is intentionally conservative: a maximum reservation can produce `402
credits_exhausted` even while a dashboard displays a positive remaining balance. The dashboard's
credit balance includes reservations and never resets; its quota snapshot is advisory and may
change before admission.

### Context qualification recipe

Before claiming a configured context works, run one small, one near-limit, and one above-limit
prompt through the full typed endpoint. For Clef the reviewed release template pins `ctx=8192`,
`batch=8192`, and `ubatch=8192`; include a prompt above 2,048 tokens in the check.
This recipe proves neither live availability nor an increased context by itself: verify the
authenticated `/v1/models` response, runtime, memory/OOM state, and rollback separately.

## Manual credit top-ups

Credit renewal is a manual operator action. There is no automatic reset or payment flow. An
admin-only `POST /admin/keys/credits/topup` accepts exactly:

```json
{"alias":"customer-alias","amount":10000,"requestId":"topup-2026-10-31-01"}
```

`amount` is a positive safe integer and `requestId` is the idempotency key. The operation applies
only to an active, capped key outside staged rotation; it changes only the lifetime cap and
preserves the key, used counter, quotas, expiry and scope. A durable receipt is returned without
the plaintext key. Repeating the same request ID with the same terms returns the original receipt;
different terms return `409 credit_topup_conflict`. Live changes remain a separate operator
approval and are not implied by this documentation.

The source contract exposes configured model entries with `qualification:
configured_not_measured`, and `/portal/me` exposes only models that are both enabled and allowed
for the authenticated key. Neither a source checkout, an enabled setting, nor a public model
spec is proof of actual production availability; require the authenticated model-list check and
release evidence.

For a yes/no probability, use a `noul` question such as
`"questions":{"urgent":{"type":"noul","instructions":"Does this need immediate attention?"}}`.
Read its probability from `answers.urgent.noul`.

Choice example:

```bash
cat > choice.json <<'JSON'
{
  "model": "clef-flash",
  "state": "The customer was charged twice for the same order.",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Which team should handle this request?",
      "criteria": {
        "billing": "Payments, charges and refunds",
        "support": "Technical product problems"
      }
    }
  }
}
JSON

curl https://inference.example.com/v1/systemone \
  --data-binary @choice.json \
  -H @- <<EOF
Authorization: Bearer ${HS_KEY}
Content-Type: application/json
EOF
```

The header heredoc keeps the bearer value on standard input rather than in the command arguments;
set `HS_KEY` in the shell first. A choice response has the selected option in
`answers.route.choice`, matching `answers.route.probabilities` for every criteria key, and a
`answers.route.confidence` value. Example response (probabilities and token counts vary):

```json
{
  "answers": {
    "route": {
      "type": "choice",
      "choice": "billing",
      "probabilities": {"billing": 0.9, "support": 0.1},
      "confidence": 0.8
    }
  },
  "usage": {"input_tokens": 123, "output_tokens": 0}
}
```

Common `400` errors are a criteria array instead of an object, fewer than 2 or more than 26
options, invalid ASCII option keys, non-string/non-null descriptions, empty instructions, or
unsupported fields. A `400 invalid_request_error` is request syntax/schema validation; another
`400` code such as `model_not_found` has a different cause. A `502` means the gateway could not
return a valid upstream decision; the status alone does not prove that the request JSON caused the
failure.

## Release gate

Clef processes all questions and the state in one physical batch. Its serving template therefore
pins both `batch: 8192` (`-b`) and `ubatch: 8192` (`-ub`), alongside `ctx: 8192`.
In [llama.cpp's context initialization](https://github.com/ggml-org/llama.cpp/blob/d81235049384534c167caea52b85a694f6103d14/src/llama-context.cpp#L248-L250),
the physical batch is capped by the logical batch. Setting only `-ub 8192` can leave the
effective limit at the runtime's default logical batch size (2048 in this pinned version).
The JSON body cap does not override this runtime limit. Verify the effective batch values and
a prompt above 2048 tokens before claiming the full configured context is usable. Include
memory/OOM and service-health checks; changing either batch setting requires a separately
approved roster update and rollback. A merged template does not change an existing live entry.

The public [`deploy/specs/clef-flash.yaml`](../deploy/specs/clef-flash.yaml) is a reviewable
template. Resolve its artifact and runtime paths in the private operations ticket; do not copy
live paths or service state into this public repository. Verify the downloaded GGUF checksum and
the pinned Hub revision: the upstream conversion changed on 2026-10-05, so a download from
`main` is not an immutable artifact identity. The selected revision includes the updated GGUF
metadata; this release remains text-only and does not use its separate vision projector. Then
build a complete isolated llama.cpp runtime from a pinned release with Clef and
`/v1/systemone` support (v0.6.0 or later). The
[llama-swap v262 release](https://github.com/mostlygeek/llama-swap/releases/tag/v262) adds the
required JSON route. Check the actual installed versions before any switch; older runtimes may
return 404 or fail to load this model.

Append the exact reviewed ID to `HOMESERVER_SYSTEMONE_MODELS` on the gateway while retaining
Clef and every previously promoted decision model **before** adding that model to the
llama-swap roster. At that stage the endpoint cannot succeed because the model is not served, and
chat/delegation paths exclude its ID regardless of this setting. Existing unscoped guest keys
cannot use or discover Clef after the roster addition. Then use the
[roster procedure](../deploy/README.md#deploying-llama-swap-roster-changes) with a
reviewed maximum of 13 served entries for the already completed Clef transaction. The current
roster baseline is 13 entries. For the proposed native follow-on sequence, promote
`bespoke-nimble-9b` with `PROMOTE_MAX_SERVED=14`, verify and restore as required, then promote
`pplx-decider-v1-27b` with `PROMOTE_MAX_SERVED=15`; keep the transactions separate. The native
spec's warm-up must exercise the typed `/v1/systemone` adapter, and the host evaluation must prove
the runtime before any customer grant.
Before customer access, verify a text-only owner call, a disposable test guest key
restricted to the exact candidate ID, rejection of an unscoped guest key, a different model and malformed schema, exact credit
usage, `/v1/models` visibility, a short representative quality set, host memory and OOM state,
and restoration of the preexisting model service. Revoke the test key and grant existing customer
keys through the atomic `POST /admin/keys/systemone-grants` operation only after those checks
pass. Use an exact reviewed alias list; the operation leaves existing credentials, chat access,
quotas, credit caps, expiry, and use counters intact. Record measured cold/warm latency and keep
publisher benchmarks separate from M5 observations.
Declare a measured budget for each promoted model in `HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB` before
enabling host-memory enforcement; an unknown budget must remain a refusal, not a guess.

For the proposed native entries, resolve the placeholder paths in
[`deploy/specs/bespoke-nimble-9b.yaml`](../deploy/specs/bespoke-nimble-9b.yaml) and
[`deploy/specs/pplx-decider-v1-27b.yaml`](../deploy/specs/pplx-decider-v1-27b.yaml) only in the
private operations record. Build an offline Python/ROCm environment from audited, pinned sources;
verify the exact upstream revisions, Nimble adapter checksum, Decider readout and temperature,
BF16 execution, measured host/GPU memory, cold/warm latency, and typed response shape. The public
specs are intentionally not deployable as written and do not establish that either model is live.

The gateway deploy follows [Live deployment](../deploy/README.md#live-deployment-authoritative):
an accepted full 40-character release SHA, `scripts/deploy-gateway.sh deploy <sha>`, and
`scripts/deploy-gateway.sh verify`. The runtime/roster switch and production gateway deploy are
separate sensitive mutations with exact target, revision, verification, and rollback approval.
Do not advertise customer availability until the authenticated external route and rollback
checks pass.
