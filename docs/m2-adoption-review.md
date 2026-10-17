# M2 adoption review — 2026-09-08

## Decision

The predeclared review dated **2026-08-28** cannot be reconstructed: its exact
observation bounds and original artifact are unavailable. The two historical
threshold decisions are therefore **unknowable / HOLD**:

1. at least 20 known organic eligible opportunities; and
2. at least 60% useful completions among attempted organic delegations.

This is an honest report outcome and satisfies the historical M2 report
acceptance. It does not establish usefulness for that original window, qualify
M3, promote a lane, or change the overall **shadow** routing state.

## Reproducible retrospective diagnostic

The diagnostic is a separate, post-review observation and does not replace the
missing historical window. Its exact half-open UTC bounds are:

```text
[2026-08-29T00:00:00.000Z, 2026-09-08T00:00:00.000Z)
```

It was captured at `2026-09-08T08:26:38.038Z` from accepted deployed revision
`81ed0dc6b38683626ff5203d286ccd634521de81`. The report contract is
`m2-adoption-review-2026-09-08-v1`; the evidence bundle is
`m5-adoption-evidence-bundle-v1`, version 1. The closed aggregate projection is
published at
[`docs/evidence/m2-adoption-review-2026-09-08.json`](evidence/m2-adoption-review-2026-09-08.json)
with source-artifact SHA-256
`aa79701e5bf9af83576b7c00d588cb3c9baffdb51e4259a54d06ef5f35483289`.

The reproducible read-only command is:

```bash
node --import tsx scripts/export-m5-adoption-evidence.ts \
  --db '<authorized-stable-snapshot>' \
  --from 2026-08-29T00:00:00.000Z \
  --through-exclusive 2026-09-08T00:00:00.000Z \
  --generated-at 2026-09-08T08:26:38.038Z
```

`<authorized-stable-snapshot>` is intentionally a placeholder for the
operator-approved stable database snapshot. No private path is part of this
publication. The recorded database migration/schema version is unknown; none
is inferred here. The compute filter is `m5-admitted-compute-v2`: M5,
admitted, non-`none` model rows on the closed route list
(`/v1/chat/completions`, `/v1/audio/transcriptions`,
`/v1/images/generations`, `image`, `/delegate`, `/mcp/ask`), with the outer
`/mcp` transport excluded. Bounds use integer epoch-millisecond timestamps and
the exact half-open predicate.

## Observed aggregate

Admitted compute had 107,334 source rows and 8,387 rows in the diagnostic
window. The filter admitted 1,317 requests totaling 28,226,716 ms. Day, model,
node, route, and tier count/time reconciliations all matched. There were 97
missing-admission rows, 6,907 `model=none` rows, no malformed timestamps, and
no non-M5 rows. Of the matched compute rows, 295 carry the current filter epoch
and 1,022 have a missing epoch; applicability is therefore
**mixed/ambiguous**.

Adoption evidence had 554 source rows, 215 retained individual rows, and one
overflow aggregate affecting 2026-09-03. Retention is incomplete, per-harness
attribution is unavailable, and the export records zero dropped rows and malformed timestamps. Purpose
denominators remain separate:

| Purpose | Known opportunities | Attempts | Useful | Unassessed attempts |
| --- | ---: | ---: | ---: | ---: |
| Organic | 208 | 197 | 123 | 18 |
| Evaluation | 7 | 7 | 3 | 2 |
| Synthetic | 10 | 10 | 7 | 0 |

The diagnostic organic opportunity count reaches the minimum (`208 >= 20`),
but its useful ratio is **unknowable** because 18 attempted reports lack a
complete usefulness assessment. The observed organic ratio is 123/197 =
62.44%; it is not promoted to a threshold pass. Evaluation and synthetic rows
do not enter the organic denominator. Fallback coverage is recorded as access
6, capacity 9, transport 8, and unknown 26.

There were 5,194 delegation source rows and 460 current-M5 rows in-window; all
460 state classifications reconciled. All 460 lack evidence identity,
reviewer usefulness, and LearningTask binding. The judge context epoch is
`ctx-tools-parts-v1`, with all 460 rows missing it. The exporter classifies
408 rows as having an ungraded verifier. Separately, 403 rows have
`outcome="unverified"`; these count different fields and predicates, and the
aggregate does not establish their overlap. Four infrastructure errors are
recorded. These gaps prevent promotion evidence.

Cost evidence had 1,974 source rows and 403 in-window rows. The 403 linked rows
leave 57 current delegations without a cost row; duplicate links are zero.
Calibration is missing for all 403 rows, 38 price entries are unrecognized, and
calibrated local energy costs and savings remain unknown. Cost calibration is
deferred to [#82](https://github.com/Magnus-Gille/gille-inference/issues/82), outside M2 and the first-canary cost gate; no savings claim is
made.

## Acceptance and follow-up

The diagnostic’s deterministic next action is **`repair_measurement`**. The
measured labels are admitted M5 compute evidence, adoption evidence, and
delegation/cost evidence; lane promotion remains **aspirational**. No maturity
upgrade or routing change is justified.

This report can close #245’s historical report acceptance as an explicit
negative/unknowable HOLD without fresh traffic. Fresh prospective organic
measurement, with a declared window and current client feedback, remains a
separate M3 prerequisite tracked in [#308](https://github.com/Magnus-Gille/gille-inference/issues/308). The conditional September 9–16 window did not start; no replacement is declared by this report. This acceptance supersedes the earlier diagnostic comment’s statement that report closure was not justified, while preserving its historical HOLD and all observed gaps. The public deployment/report receipt is
[issue comment 5582409763](https://github.com/Magnus-Gille/gille-inference/issues/245#issuecomment-5582409763).
