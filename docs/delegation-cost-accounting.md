# Delegation Cost Accounting

The goal is to make local M5 delegation financially auditable without weakening the quality gate.

## What Gets Measured

Each `/delegate` result, and each owner MCP `ask` telemetry row, can write a content-blind row to
`delegation_costs`. The row stores:

- task type, local model, optional delegator model, fallback model, and premium baseline model
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

If a model has no known price, the trace records a `missing-price:<model>` note and savings for that
baseline remains zero.

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

Panels:

- `delegation-savings`: daily verified SEK savings versus the premium baseline
- `delegation-savings-by-task`: task-type table with verified, unverified, failed, and escalated rows
