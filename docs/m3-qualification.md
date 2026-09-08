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
bytes) and `report` (the `evaluateM3Qualification` result). `--help` prints the usage
line. The input is limited to 1 MiB. Usage, read, size, JSON, schema, and evaluator
failures use fixed stderr codes and produce no report on stdout.

The report's `analysisVerdict` is an evidence review result. `GO` means that the supplied
candidate and reviewed thresholds cleared the evaluator's checks; it does not enable a
route. `enablingDecision` remains `null`, including for `GO`. Unknown or unproven values
hold the required gates; optional non-organic buckets may remain unknown. Missing evidence
is not treated as zero or as a passing value.

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
