# Exact execution feedback (#243)

This contract describes the narrow, content-blind usefulness signal for a completed
owner-visible execution. It is separate from the coarse `adoption_evidence` table and from
the reviewer-usefulness overlay. It is advisory reporting data only: recording a judgment never
authorizes, routes, blocks, or promotes a model.

## Bind a handle only after execution

The server creates one opaque UUID `feedbackHandle` for a completed owner-visible result. The
binding is to the exact delegation ledger row and to the authenticated minted owner key hash and
alias that ran it. A handle is not a transferable capability; clients do not choose it, its
ledger row, its principal, or its purpose. A handle is not an acknowledgement: server-produced or
retrievable output does not mean that the caller has supplied a usefulness judgment.

The purpose is fixed before execution:

| Surface | Request field | Successful owner result |
| --- | --- | --- |
| HTTP `POST /delegate` | `trafficPurpose`: `organic`, `evaluation`, or `synthetic` (optional) | `feedbackHandle` |
| MCP `ask` | `traffic_purpose`: `organic`, `evaluation`, or `synthetic` (optional) | `structuredContent.feedback_handle` |
| MCP `code_loop_start` → `code_loop_result` | `traffic_purpose`: `organic`, `evaluation`, or `synthetic` (optional) | `result.feedback_handle` |

Omission is retained as `unknown`; an invalid purpose is rejected before execution. Guest,
static, monitor, and otherwise non-minted-owner callers never receive a handle. A handle is
created only for a non-shadow, current, non-superseded, non-error ledger row with output that is
actually available to the owner caller: delegate output must be nonempty and non-truncated; ask
output must be nonempty and non-truncated; code-loop output must be a completed, retrievable
terminal result.

Code-loop completion is asynchronous. Its prepared binding starts unavailable (`available=0`)
and is published only after the trusted durable result write, or after trusted recovery observes
that result. If durable publication fails, the result remains authoritative and the binding stays
excluded until recovery can publish it. Prepared/unavailable rows are therefore not reportable
completed executions.

If the terminal result file itself fails to persist, its prepared binding remains unavailable
and the in-memory response omits the handle. Recovery can publish that binding only if it finds
the authoritative terminal file with the handle; otherwise the row stays excluded, not completed.

## Submit one usefulness judgment

The same minted owner agent/admin key that ran the execution submits:

```http
PUT /execution-feedback/{feedbackHandle}
Content-Type: application/json

{"usefulness":"pass"}
```

`usefulness` is exactly one of `pass`, `partial`, `redo`, or `wrong`; the request body has no
other fields. The first valid judgment returns `201`. Repeating the same judgment returns `200`
and is idempotent. A different judgment for an already judged handle returns `409` (`conflict`),
and an ineligible row (unknown/evaluation/synthetic purpose, stale epoch, unavailable async
binding, shadow/superseded/error execution) returns `409` (`ineligible`). An unknown, malformed,
or another minted owner's handle returns `404`; a caller outside the minted owner agent/admin
scope (including guest, static, monitor, or inference scope) returns `403`. Invalid JSON, content
type, or usefulness shape returns `400`; bodies larger than 1,024 bytes return `413`.

The handle, ledger ID, key hash, alias, prompts, outputs, notes, and per-execution timestamps are never part of
the report export. Conflict handling retains only a counter; it does not retain submitted content.

## Content-blind report

`buildExecutionFeedbackReport(db, {since, until})` produces contract
`execution-feedback-report-v1` for the explicit canonical ISO UTC half-open window
`[since, until)`. Both bounds must be strict UTC (`Z`), finite, and ordered. The denominator is
one joined `execution_feedback` row per newly instrumented, current eligible organic completed
execution—not coarse adoption opportunities, raw calls, historical exposures, or synthetic tests.

Rows are closed buckets of `model × task × source × surface`, using the canonical model/task/source
allowlists shared conceptually with the adoption-evidence bundle. Each row contains `completed`,
`assessed`, `missing`, `pass`, `partial`, `redo`, `wrong`, and `coverage` (null when the bucket
denominator is zero). Unknown or unrecognised stored dimensions are bucketed to fixed
`unknown`/`other` values; arbitrary database strings are never emitted. Evaluation, synthetic,
unknown-purpose, wrong-epoch, and ineligible rows are kept only in separate closed exclusion
counts and never inflate the organic denominator.

If either required table or a required column is absent, the report is explicitly
`availability: "unavailable"` with a reason and null aggregate counts/coverage. An empty but
available organic dataset reports zero counts with null coverage. The builder is read-only: it
does not create tables, migrate, or silently turn unavailable data into a zero claim.

Export a private JSON report with explicit bounds:

```sh
tsx scripts/export-execution-feedback.ts \
  --db /path/to/eval.db \
  --since 2026-09-01T00:00:00.000Z \
  --until 2026-09-08T00:00:00.000Z
```

Omit `--db` to use `EVAL_DB_PATH` (or its `./data/eval.db` default). The exporter opens the
database through the read-only snapshot helper and writes the aggregate JSON to stdout. Missing
schema is a successful unavailable report; an unreadable/missing database or invalid bounds is
refused. This report is a newly instrumented organic signal, not proof that all historical
executions or exposures were caller-visible, and synthetic/evaluation tests are lab evidence
rather than production usefulness.
