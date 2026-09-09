# Offline M3 qualification report

`qualify-m3.ts` evaluates a supplied M3 evidence snapshot without contacting the
gateway or collecting new evidence. The evaluator is pure: it relies on the evidence
attestations in the input, so this report does not independently prove that a collector,
runtime, model, or verifier produced them.

Run it against an explicit JSON file:

```bash
npx tsx scripts/qualify-m3.ts --input ./qualification-input.json
```

The command prints one JSON object containing `inputSha256` (the SHA-256 of the input
bytes) and `report` (the result for the selected contract). `--help` prints the usage
line. The input is limited to 1 MiB. Usage, read, size, JSON, schema, and evaluator
failures use fixed stderr codes and produce no report on stdout.

For the strict v1 contract, `analysisVerdict` is an evidence review result. `GO` means that the supplied
candidate and reviewed thresholds cleared the evaluator's checks; it does not enable a
route. `enablingDecision` remains `null`, including for `GO`. Unknown or unproven values
hold the required gates; optional non-organic buckets may remain unknown. Missing evidence
is not treated as zero or as a passing value.

## Explicit first-canary contract with cost unassessed

The original `m5-m3-qualification-v1` / version `1` contract remains strict: cost
measurement, calibration, coverage and reviewed cost limits are required. Its API and
output semantics are unchanged.

[#304](https://github.com/Magnus-Gille/gille-inference/issues/304) adds the separate
`m5-m3-first-canary-v2` / version `2` contract. It requires `mode: "cost-unassessed"`
and `costDeferral: { "reason": "no-wall-energy-measurement", "followUp": "issue-82" }`.
The reason must be a sanitized token. This implements the owner's deferral of
[#82](https://github.com/Magnus-Gille/gille-inference/issues/82) for the first canary.

| Contract | Cost input | Decision meaning |
| --- | --- | --- |
| v1 strict qualification | Measured cost and reviewed cost thresholds | `analysisVerdict: "GO"` means all supplied qualification gates passed; activation remains separate. |
| v2 first canary | Explicitly unavailable cost; no cost thresholds | `canaryEligibility: "ELIGIBLE"` means exactly one candidate passed the non-cost gates and all global checks. Full `analysisVerdict` remains `"HOLD"`. |

For v2, keep every reviewed non-cost threshold and omit `maxCostPerAcceptedUsd` and
`maxLocalToBaselineRatio`; supplying either cost threshold is rejected. Every candidate
must still contain `cost`, including sanitized `localProvenance` and `baselineProvenance`
tokens. Its four signals (`localCostPerAcceptedUsd`, `baselineCostPerAcceptedUsd`,
`calibrated`, `exactOneCostCoverage`) must each be exactly
`{ "status": "unknown", "reason": "not-measured" }`, or use status `"unproven"`,
with a sanitized reason token. Measured signals, missing fields, or extra value/sample
fields are rejected. This narrow mode cannot hide contradictory measurements; use v1
when assessing measured cost.

The v2 result explicitly reports `costAssessment: "unassessed"` and the deferral.
`selectedCanaryCandidate` identifies the sole eligible candidate, or is `null` on HOLD.
`selectedCandidate` and `enablingDecision` remain `null`. Candidate diagnostics are scoped
to this first-canary contract; they are not economic qualification. No zero costs,
power estimates or savings are inferred.

All non-cost gates remain: reviewed thresholds fixed before the observation window,
fresh immutable identity and policy bindings, organic sample and feedback denominators,
trusted behavioral verifier, quality, errors, latency, availability, authority/data
compatibility, and tested safety controls. An eligible offline report still requires
[#287](https://github.com/Magnus-Gille/gille-inference/issues/287) canary integration and
[#288](https://github.com/Magnus-Gille/gille-inference/issues/288) operational approval.
Historical HOLD records remain unchanged. Fixtures demonstrate software behavior only.

The same CLI selects the evaluator from the explicit contract/version; no default flag
relaxes v1. This **TEST-only readiness input** deliberately yields HOLD, not a production
qualification receipt:

```json
{
  "contract": "m5-m3-first-canary-v2",
  "version": 2,
  "mode": "cost-unassessed",
  "costDeferral": { "reason": "no-wall-energy-measurement", "followUp": "issue-82" },
  "evaluation": { "asOf": "2026-09-03T00:00:00.000Z" },
  "window": { "start": "2026-09-01T00:00:00.000Z", "end": "2026-09-02T00:00:00.000Z" },
  "snapshot": { "sha256": "", "immutable": false, "observedAt": "2026-09-02T00:00:00.000Z" },
  "thresholds": null,
  "candidates": []
}
```

## Strict v1 readiness input

This is a runnable readiness illustration, not captured production evidence:

```json
{
  "contract": "m5-m3-qualification-v1",
  "version": 1,
  "evaluation": { "asOf": "2026-09-03T00:00:00.000Z" },
  "window": {
    "start": "2026-09-01T00:00:00.000Z",
    "end": "2026-09-02T00:00:00.000Z"
  },
  "snapshot": {
    "sha256": "",
    "immutable": false,
    "observedAt": "2026-09-02T00:00:00.000Z"
  },
  "thresholds": null,
  "candidates": []
}
```

It produces `HOLD` because the snapshot digest is missing, `immutable` is false, thresholds
are absent, and no candidate evidence is supplied. It is a readiness illustration, not a
qualification receipt or captured production evidence.

Thresholds are input evidence. Any `GO` input must carry explicit, reviewed, versioned
thresholds; reviewers may predeclare thresholds for a **TEST-only** qualification. This
repository does not invent task thresholds or provide production defaults through this
report. A passing offline report still requires the separately reviewed canary contract,
integration, and operational decision.

The input contract is intentionally explicit:

| Input | Required evidence or binding |
| --- | --- |
| Thresholds | Reviewed, versioned values, including the accepted canonical task IDs and the expected full policy stamp. |
| Candidate identity | Candidate key plus immutable `sha256:` IDs for evidence, artifact, runtime, and verifier; every purpose bucket declares `candidateBound`, and organic evidence must be bound for `GO`. |
| Organic denominators | `attempts` is the denominator for quality, error rate, p90 latency, and feedback coverage; `opportunities` is the busy-rate denominator; `pass` is the accepted-cost denominator. |
| Signal provenance | A measured signal needs a sample size, sanitized source reference, and `independently-verified` provenance. `operator-attested` evidence cannot clear a required measured gate. |
| Purpose buckets | Each candidate supplies `organic`, `evaluation`, `synthetic`, and `unknown`; only organic evidence is used for the qualification gates, while optional non-organic buckets may remain unknown. |
| Authority and data | `nonJudgmentLane`, `dataClass`, and `destinationClass` must describe a compatible closed authority/data path. |

Identifiers and source references must already be sanitized before they enter this JSON.
`snapshot.sha256` can identify the exported bytes, and candidate hashes identify supplied
artifacts; none of these hashes independently verifies an attestation. Keep the report and
input hash with the review record without including private paths, addresses, raw prompts,
or secret content.

This CLI is an analysis tool and does not make the operational decision; see the current
[M3 qualification decision record](m3-qualification-decision-2026-09-08.md). A `HOLD` can
close the analysis portion of #286 when recorded and reviewed, while M3 remains `HOLD` until
candidate-bound evidence and the required operational evidence and policy gaps are resolved.
For the readiness input above, the #85/M3 decision remains `HOLD`; no current qualification
matrix is claimed.

This work supports the bounded sequence in [#85](https://github.com/Magnus-Gille/gille-inference/issues/85):
qualification in [#286](https://github.com/Magnus-Gille/gille-inference/issues/286) precedes
the canary integration in [#287](https://github.com/Magnus-Gille/gille-inference/issues/287).
