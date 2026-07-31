# M5 agent-adoption measurement

This is the implementation contract for [issue #136](https://github.com/Magnus-Gille/gille-inference/issues/136). It measures whether ordinary agent work actually reaches M5 without collecting task content.

## What is measured

One owner-agent report represents one observed M5 opportunity/result and contains only a fixed harness, execution mode, traffic purpose, result, deterministic-check outcome, reviewer usefulness, fallback reason, and known eligible-opportunity count. There is no task title, prompt, response, path, repository, user/session identifier, free-text note, event ID, or precise timestamp. The server adds only the UTC calendar day needed for the rolling weekly aggregate.

For an agent credential, submit the content-free report through the secret-safe client:

```bash
printf '%s' '{
  "harness":"codex_cli",
  "execution_mode":"code_loop",
  "traffic_purpose":"organic",
  "result":"not_attempted",
  "deterministic_check":"not_run",
  "reviewer_usefulness":"not_reported",
  "fallback_reason":"m5_auth_unavailable",
  "eligible_opportunities":1
}' | m5 --profile codex adoption report
```

The profile resolves its bearer credential internally from Keychain; do not put a token in the JSON, command line, environment, or report. `m5_tool_missing` and `m5_auth_unavailable` are intentionally different values: both reveal invisible frontier fallback without pretending M5 ran.

`result=completed` means M5 returned a local result. It may still have a deterministic check fail or a reviewer judgment of `partial`, `redo`, or `wrong`. `result=refused`, `failed`, and `not_attempted` require `deterministic_check=not_run`, `reviewer_usefulness=not_reported`, and a non-`none` fallback reason.

If the L1 knows a batch denominator, enter it once on the relevant decision report. Use `0` when it does not know the denominator; do not infer eligibility from gateway requests. Reports must not be split or duplicated simply to improve the rate.

## Weekly dashboard

Run the read-only panel poster weekly from the deployment environment after its normal evidence collection:

```bash
tsx scripts/post-m5-adoption-panel.ts --days 7
```

It publishes three Heimdall panels:

| panel | status | interpretation |
|---|---|---|
| `m5-adoption-organic` | **MEASURED** | organic declared opportunities/attempts/useful completions/check pass rate by harness; evaluation and synthetic traffic are **ENFORCED** out |
| `m5-adoption-fallbacks` | **MEASURED** | organic closed fallback counts, including missing M5 tool/auth |
| `m5-adoption-lab` | **LAB** | formal evaluation and synthetic probe evidence, separate from user/agent adoption |

All three panels are **SHADOW** with respect to routing: they do not enable a route, prevent a frontier escalation, establish cost savings, or authorize autonomous action.

## Predeclared review

On **2026-08-28**, assess the initial trial against both conditions:

1. At least 20 known organic eligible opportunities were reported.
2. At least 60% of attempted organic delegations were useful completions (`pass` or `partial`, and not a deterministic-check failure).

The decision is whether to improve the agent path, the measurement contract, or the routing policy; it is not a mandate to increase raw M5 call volume.
