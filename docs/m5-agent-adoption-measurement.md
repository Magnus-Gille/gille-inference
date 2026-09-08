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

`result=completed` means M5 returned a local result. It may still have a deterministic check fail or a reviewer judgment of `partial`, `redo`, or `wrong`. `result=refused` and `not_attempted` require `deterministic_check=not_run`, `reviewer_usefulness=not_reported`, and a non-`none` fallback reason. Failed attempts also require a non-`none` fallback, but may carry an observed check or reviewer outcome.

If the L1 knows a batch denominator, enter it once on the relevant decision report. Use `0` when it does not know the denominator; do not infer eligibility from gateway requests. Reports must not be split or duplicated simply to improve the rate.

## Weekly dashboard

Run the read-only panel poster weekly from the deployment environment after its normal evidence collection:

```bash
tsx scripts/post-m5-adoption-panel.ts --days 7
```

It publishes four Heimdall panels:

| panel | status | interpretation |
|---|---|---|
| `m5-adoption-organic` | **MEASURED** | organic declared opportunities/attempts/useful completions/check pass rate by harness; evaluation and synthetic traffic are **ENFORCED** out |
| `m5-adoption-organic-by-harness` | **MEASURED** | the same organic measures as closed, low-cardinality rows by harness; no caller, task, request, or repository identifier |
| `m5-adoption-fallbacks` | **MEASURED** | organic closed fallback counts, including missing M5 tool/auth |
| `m5-adoption-lab` | **LAB** | formal evaluation and synthetic probe evidence, separate from user/agent adoption |

All four panels are **SHADOW** with respect to routing: they do not enable a route, prevent a frontier escalation, establish cost savings, or authorize autonomous action.

The report call itself is deliberately a privacy blind spot in the normal MCP telemetry: accepted
and rejected reports from an authenticated owner-agent suppress per-request access, request, and
owner logging. A retained report leaves only its coarse `recorded_day` row. After 25 individual
rows on a server day, later valid reports are aggregated in `adoption_evidence_overflow_v2` by
closed harness/execution-mode/purpose/result/check/usefulness/fallback enums. Repeated reports
increment counters in the same daily bucket; no principal, request, content, or precise time is
stored. Both aggregate tables retain 90 days. The legacy overflow table remains unchanged and is
read alongside the new table, without backfilling missing harness or mode values. This preserves
new failure, recovery, and usefulness evidence after the individual-row cap without inventing
historical attribution.

The acknowledgement reports `retained`, `aggregated`, or `dropped`, whether telemetry was
recorded, and that inference availability is unaffected. `telemetry_daily_cap` means the report was
coalesced: do not retry only this telemetry write until the next UTC day; `ask`, `code_loop`, model
access, and owner inference remain available. A transient `telemetry_rate_limited`, invalid report,
or storage failure is a dropped hard error. All responses remain content-free. New aggregates preserve every reported dimension. Dashboard
windows containing legacy aggregates or malformed attribution remain **INCOMPLETE**. A complete
retention window only establishes that submitted dimensions survived; it does not establish that
all opportunities were reported, judgments were supplied, or promotion requirements were met.

`completed` reports use `fallback_reason=none`. `failed` reports use a non-`none` fallback and may
retain an observed deterministic-check or reviewer outcome, including `redo` for a metered but
unusable partial result. `refused` and `not_attempted` have no assessable local result, so they use
`deterministic_check=not_run`, `reviewer_usefulness=not_reported`, and a non-`none` fallback.
Rejected `invalid_report` calls include only a fixed diagnostic code and, when safe, a known schema
field or fixed invariant code; unknown caller keys are never echoed.

## Predeclared review

On **2026-08-28**, assess the initial trial against both conditions:

1. At least 20 known organic eligible opportunities were reported.
2. At least 60% of attempted organic delegations were useful completions (`pass` or `partial`, and not a deterministic-check failure).

The decision is whether to improve the agent path, the measurement contract, or the routing policy; it is not a mandate to increase raw M5 call volume.

## Measurement repair and the next trial (#245)

The evidence bundle v2 distinguishes individual reports, legacy aggregates, and attributed v2
aggregates. Historical missing dimensions and assessments remain unknown. Descriptive useful
completions follow the predeclared definition above; a completed report with a reviewer pass or
partial but no deterministic check remains unassessed for threshold acceptance and promotion.
Unknown assessments require measurement repair, rather than an inferred successful review.

Before starting a new declared UTC-day window, verify the installed client preserves execution
feedback handles, submit explicit judgments through the same profile, and verify an exported
fixture or isolated probe retains attribution beyond the 25-row cap. Use `traffic_purpose=organic`
only for actual eligible work. Follow [the execution-feedback contract](execution-feedback.md);
its exact execution feedback is separate from coarse adoption reports and the reviewer ledger.
Do not copy one signal into another or infer judgments from successful execution. Declare the
window and review date before collection; preserve the initial trial verdict as unknown/HOLD.

Readers predating this repair do not consume the v2 overflow table. A reader rollback therefore
requires explicitly marking coverage unknown for affected windows; it must not present the
remaining individual rows as the complete population.
