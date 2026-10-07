# Customer System One decision model: Clef-flash

## Selection and evidence (2026-10-07)

Serve **one** new decision model first: Cloudflare Clef-flash, under the ID `clef-flash`.
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
qualification; having weights on M5 does not make it customer-ready.

Do not add Perplexity's 27B decider in this first change. Its
[model card](https://huggingface.co/perplexity-ai/pplx-decider-v1-27b) calls for about 49 GiB of
weights plus working memory and documents CUDA inference. That is a much larger, unverified load
on the M5's serial GPU. A second model needs a separate M5 comparison on customer-like tasks.

## Customer contract

- `POST /v1/systemone` uses the existing bearer key, model allow-list, credit cap, rate quota,
  owner-preempting GPU admission, and host-memory admission. The endpoint is disabled until
  `HOMESERVER_SYSTEMONE_MODELS=clef-flash` is set on a llama-swap gateway. A guest key must
  explicitly list `clef-flash`; an empty guest allow-list grants ordinary chat models but not
  decision models. Owner keys can run release checks before guest access is granted.
- Request: `model`, a text or JSON-object `state`, and 1–16 named `questions`. Each question has
  `type` (`noul`, `choice`, or `score`) and `instructions`; `choice` needs 2–26 named criteria,
  `score` needs 2–10 ordered labels. The gateway accepts at most 8 KiB of request JSON. Images,
  streaming, `keep_alive`, and arbitrary runtime parameters are not enabled in this release.
- Response: compatible typed `answers` and `usage` from llama.cpp. Credits charge the upstream
  `usage.input_tokens` on successful calls; rejected or failed calls charge zero. A decision
  model is not a chat model: `/v1/chat/completions` and MCP `ask` reject it.
- Admission reserves Clef's full 8,192-token shared context, then reconciles to exact successful
  usage. An upstream response above that bound is rejected. Other decision models need their own
  context accounting before customer activation.
- `/v1/models` and `/models` list a decision model only after it is in the llama-swap roster and the key can
  use it. A known decision model stays out of chat, MCP `ask`, delegation and model discovery
  even if its enablement setting is removed while it remains in the roster. MCP `list_models`
  remains a list of chat models for the MCP `ask` tool.
- The gateway never records guest state/questions/answers in the owner content log. Existing
  request telemetry is content-blind and uses only the configured model ID.

Example:

```bash
curl https://inference.example.com/v1/systemone \
  -H "Authorization: Bearer $HS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"clef-flash","state":"Checkout is down for all customers.","questions":{"urgent":{"type":"noul","instructions":"Does this need immediate attention?"}}}'
```

## Release gate

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

Set `HOMESERVER_SYSTEMONE_MODELS=clef-flash` on the gateway **before** adding Clef-flash to the
llama-swap roster. At that stage the endpoint cannot succeed because the model is not served, and
chat/delegation paths exclude its ID regardless of this setting. Existing unscoped guest keys
cannot use or discover Clef after the roster addition. Then use the
[roster procedure](../deploy/README.md#deploying-llama-swap-roster-changes) with a
reviewed maximum of 13 served entries. The existing promoter's warm-up is selected by the
spec's `api: systemone` and validates the same response shape and usage as the customer API.
Before customer access, verify a text-only owner call, a disposable test guest key
restricted to `clef-flash`, rejection of an unscoped guest key, a different model and malformed schema, exact credit
usage, `/v1/models` visibility, a short representative quality set, host memory and OOM state,
and restoration of the preexisting model service. Revoke the test key and grant customer keys
only after those checks pass. Record measured cold/warm latency and keep
publisher benchmarks separate from M5 observations.
Declare a measured `clef-flash` budget in `HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB` before
enabling host-memory enforcement; an unknown budget must remain a refusal, not a guess.

The gateway deploy follows [Live deployment](../deploy/README.md#live-deployment-authoritative):
an accepted full 40-character release SHA, `scripts/deploy-gateway.sh deploy <sha>`, and
`scripts/deploy-gateway.sh verify`. The runtime/roster switch and production gateway deploy are
separate sensitive mutations with exact target, revision, verification, and rollback approval.
Do not advertise customer availability until the authenticated external route and rollback
checks pass.
