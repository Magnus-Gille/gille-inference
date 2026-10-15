# Reliability diagnostics

This guide describes the owner-facing diagnostics for the M5 gateway. They help distinguish
catalogue reachability, past activity, backend state, and a deliberately requested inference
check. None of these signals alone establishes that a model is generally ready or suitable for a
task.

## Owner client checks

`m5` client 1.5.4 is distributed as a local tarball; it is not an npm release. The default
`m5 --profile codex doctor` checks the configured route's MCP catalogue and transport, plus
content-blind historical evidence when available. It does not call `ask`. Its global
`inference_observation` timestamp means that some owner inference succeeded at that time; it is
not current or route-specific readiness. Missing or disabled history is explicitly unavailable
and does not prove that inference has never succeeded.

To make one live check, explicitly select a route and a model:

```sh
m5 --profile codex --public doctor --probe-inference MODEL
```

Use `--private` instead of `--public` to select the private route. The probe uses only that route;
the other route is reported as `not_checked`. It sends one fixed synthetic prompt, requests at
most 16 output tokens, and has a 30-second bound. The client returns only sanitized probe
metadata, never the answer text. The gateway's existing authenticated-owner logging policy applies.
This is a real `ask`: normal authorization, admission, rate limits, and credits apply. A probe
failure describes that attempt and does not establish a general or lasting model failure. A
truncated answer reports `token_limit_reached`; legacy or unknown completion metadata reports
`completion_unconfirmed`. Neither is upgraded to a successful completed probe.

The default doctor and explicit probe answer different questions:

| Signal | What it establishes | What it does not establish |
| --- | --- | --- |
| Catalogue/transport | The selected route's advertised MCP catalogue and transport checks responded | That inference can complete |
| Historical timestamp | An owner inference success was recorded globally at that time | Current readiness or success on either specific route |
| Explicit inference probe | One bounded synthetic `ask` completed or failed on the selected route | General task quality, future availability, or readiness on the other route |

## Model status through MCP

The additive `model_status` tool accepts one `model` identifier. It reports the backend's
read-only running snapshot for that granted model, its residency as `resident`, `not_resident`,
`unavailable`, or `unknown`, and only the limits configured for the caller. It does not load,
swap, or infer with a model. The result does not contain caller aliases or a key hash. Fields such
as `loadable_now` and `protected` remain `unknown` when the snapshot cannot establish them;
`swap_cost_ms` is `null`. `list_models` keeps its existing schema; use `model_status` for this
runtime observation.

A loading or unloading model has unknown residency; only a ready model is reported resident.

## Temporary model backoff

Three eligible backend failures for the same minted authenticated key and known model within 60 seconds
open a fixed 30-second temporary refusal. During that interval the gateway does not call the
backend or reserve quota or credits for that request. The response uses
`model_temporarily_unavailable`, includes `Retry-After` and an `unavailable_until` timestamp,
and identifies its scope as `key_model`. A different key or model has independent state. Static
and implicit legacy identities do not participate in this per-key guard because their identity
is shared.

This protection does not change ordinary quota rules. RPM counts quota-accepted attempts,
including backend failures; an actual quota refusal is not counted. Token estimates are
reconciled with reported usage. A configured zero RPM blocks requests; zero TPM or daily budget
means unlimited for that dimension.

## Bounded incident window

`GET /ops/incidents?from=EPOCH_MS&to=EPOCH_MS&limit=N` returns retained, content-blind request
metadata for a requested window of at most 24 hours and at most 500 rows. Access requires a real
minted owner-admin key. Agent, guest, monitor, static-admin, and implicit legacy admin access are
denied. The endpoint is read-only and uses a closed projection of existing request metadata; it
does not return key hashes, prompt or answer content, or raw backend errors.

Responses label coverage as `retained_rows_only` and causality as `not_established`. A bounded
result may be marked `truncated`. Disabled logging, a missing table, or an unsupported legacy
schema is reported explicitly. Correlation uses a request UUID and pseudonymous operator aliases;
these fields help compare retained rows but do not establish a cause. Attribute an incident only
when independent evidence proves the cause. Pending host verification is not evidence for a
specific incident cause. Keep raw operator reports private; never copy them into public material.

## Evaluation runbook

For an evaluation batch, make one inference call at a time and prefer an authorized model already
resident on the backend. Check the caller's limits and `model_status` first, respect any
`Retry-After`, and stop after three consecutive failures. Do not create a fake admission queue or
bypass current policy to keep a batch moving. If the caller or batch needs repair, make that
change in its owning repository and resume only after it is corrected. These diagnostics and
synthetic probes do not qualify a model for inference tasks or establish an evaluation result.
