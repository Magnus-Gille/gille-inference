# Delegation Cost Accounting

The goal is to make local M5 delegation financially auditable without weakening the quality gate.

## What Gets Measured

Each `/delegate` result, and each owner MCP `ask` telemetry row, can write a content-blind row to
`delegation_costs`. The row stores:

- task type, local model, optional delegator model (with its provenance — see
  [Delegator model provenance](#delegator-model-provenance)), fallback model, and premium baseline
  model
- prompt/completion token counts
- local marginal and amortized cost estimates
- estimated baseline cloud cost
- verified savings and potential savings
- verification status

It does not store prompt text or model output.

## Savings Rule

Verified savings is zero unless the local attempt has `outcome = "pass"`.

Unverified or partial output may show potential savings, but that is not booked as verified savings.
Failed local attempts and policy escalations book zero verified and zero potential savings.

## Baselines

Two baselines are tracked:

- `delegatorModelId`: the actual cloud model that delegated a `/delegate` task, supplied per
  request or via `HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID`. MCP `ask` callers use the
  `delegator_model_id` argument, with `delegatorModelId` accepted as a JSON alias.
- `premiumBaselineModelId`: the fixed high-end baseline, default `claude-fable-5`

Every catalog price records its first-party vendor URL, verification date, and expiry date. After an
entry expires, the gateway treats it as unpriced rather than letting an old tariff continue to book
a confident savings figure. Models with no first-party per-token tariff (for example a local
open-weight model), or an ambiguous id that cannot be mapped to a vendor model without guessing,
are explicitly marked unavailable. Both unavailable and missing/stale models record a
`missing-price:<model>` note and savings for that baseline remains zero.

`findUnpricedDelegatorModels()` reports the distinct delegator ids already present in
`delegation_costs` whose catalog status is `missing`, `stale`, or `unavailable`, together with only
their row counts and first/last timestamps. It is content-blind and exists so a newly used model
does not remain an unexplained zero in the savings ledger.

## Delegator model provenance

`delegator_model` alone does not say how trustworthy it is: a value can come from the caller
(strong evidence) or from the configured default (weaker — nobody actually confirmed it). Every row
also carries `delegator_model_source`:

- `"stamped"` — the caller supplied `delegatorModelId` directly (the `/delegate` request field, or
  MCP `ask`'s `delegator_model_id`/`delegatorModelId` argument). The strongest evidence available.
- `"default"` — no caller value was supplied; the row was attributed to
  `HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID` instead. Real, but not a caller confirmation.
- `NULL` — neither a caller value nor a default was available. `delegator_model` is also `NULL` and
  the row's `notes` include `missing-delegator-model`.

**A defaulted attribution is never counted as `verified_savings_actual_usd`, even when the local
attempt verified `pass`.** Only a `"stamped"` row can contribute to that column — it is the number
the savings panel presents as a *measured displacement*. A `"default"` row still gets an honest
`actual_baseline_cost_usd` estimate and can contribute to `potential_savings_actual_usd` (the
already-weaker "not yet booked as measured" bucket), and its `notes` record
`delegator-model-defaulted:<model>` plus, when the local attempt otherwise verified,
`actual-savings-not-measured-default-attribution`, so the reason is legible from the row alone —
never guess-worthy from a bare number.

This distinction exists because #83 found `delegator_model` empty in roughly half of production
rows (and empty in the large majority of *verified*, savings-eligible rows), while
`HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID` was completely unset — so setting that env var without this
distinction would have let an operational default silently be reported as a measured cloud-spend
displacement the moment it was turned on.

## Env Knobs

- `HOMESERVER_DELEGATION_COST_LOG=on|off` (default `on`)
- `HOMESERVER_DEFAULT_DELEGATOR_MODEL_ID`
- `HOMESERVER_PREMIUM_BASELINE_MODEL_ID` (default `claude-fable-5`)
- `HOMESERVER_M5_MARGINAL_USD_PER_MTOK` (default `0`)
- `HOMESERVER_M5_AMORTIZED_USD_PER_MTOK` (default `0`)
- `HOMESERVER_USD_TO_SEK` (default `10.5`)

The default local costs are zero until calibrated. Set the two M5 USD/MTok knobs when electricity
and amortized hardware allocation are ready to book.

## Dashboard

Push Heimdall panels from the box:

```bash
tsx scripts/post-delegation-savings-panel.ts --days 30
```

Dry-run the exact envelopes:

```bash
tsx scripts/post-delegation-savings-panel.ts --dry-run --days 30
```

Panels (pushed together, in one run — see `buildSavingsTimeseriesPanels` in
`scripts/post-delegation-savings-panel.ts`, which returns both timeseries panels from a single call
so the premium figure can never be published without its actual-baseline counterpart):

- `delegation-savings-actual`: daily verified SEK savings versus the **actual** delegator baseline
  (caller-stamped `delegator_model` only — see [provenance](#delegator-model-provenance) above).
  This is the honest, measured-displacement series; it reads zero until real callers stamp who
  delegated a priced model.
- `delegation-savings`: daily verified SEK savings versus the premium baseline — a deliberately
  optimistic upper bound, never presented on its own.
- `delegation-savings-by-task`: task-type table with verified, unverified, failed, and escalated rows

Both timeseries panels' detail tables also carry `stamped delegator` / `default delegator` call
counts and both SEK figures side by side, so either panel is auditable even viewed in isolation.
