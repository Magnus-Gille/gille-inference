# Candidate evidence diagnostics

The companion candidate-evidence export checks whether stored delegation records can be
reconciled with their identity snapshots and exact execution feedback. It is a read-only
diagnostic for [#306](https://github.com/Magnus-Gille/gille-inference/issues/306), not an
input attestation for the [M3 qualification evaluator](m3-qualification.md).

Run it on an authorized stable database snapshot with explicit UTC bounds and capture time:

```bash
npx tsx scripts/export-m3-candidate-evidence.ts \
  --db ./stable-snapshot.db \
  --from 2026-09-01T00:00:00.000Z \
  --through-exclusive 2026-09-02T00:00:00.000Z \
  --generated-at 2026-09-02T01:00:00.000Z
```

These are illustrative bounds, not a declared production observation window. The CLI
emits JSON to stdout. It does not create or migrate source tables, collect new observations,
contact a model/provider, or change a service. Use the existing authorized operator path to
obtain a stable snapshot; a changing source must not be forced through the reader.

The report uses delegation rows as its reconciliation basis and checks exact feedback and
content-addressed identity snapshot joins. Missing snapshots, hash mismatches, ambiguous joins,
legacy feedback, absent judgments and unknown purpose remain visible. Organic, evaluation,
synthetic and unknown activity remain separate. Failed and unavailable outcomes do not disappear
from diagnostic coverage simply because a completed-feedback report would exclude them.

The envelope is `m5-candidate-evidence-v1`, version 1: M5 names the inference node;
M3 in the command and document names is the delivery milestone. `rows.inWindow` includes every
parseable delegation timestamp inside the half-open interval, across nodes and execution
states; `rows.currentM5` is a separate count of current, non-shadow M5 rows. Identity coverage,
purpose and outcome totals describe this whole diagnostic population. They are not a
candidate-specific quality rate or an intersection of all qualification gates. Malformed
stored timestamps are counted separately because their window membership cannot be established.

`feedback.organic.completed` requires a current, non-shadow M5 row with a recognized
completed outcome (`pass`, `partial`, `fail` or `unverified`, excluding infrastructure
`error`) and exactly one available organic feedback row from the current feedback
epoch. Assessed rows additionally require a recognized usefulness judgment. These counts
do not require resolved candidate identity and must not be used as candidate qualification.

The delegation table is required. Missing snapshot, feedback or cost tables/columns mark the
respective section unavailable while retaining the other diagnostic counts. An unavailable
section's zero counts are not proof of an observed absence; read its availability marker first.
`bindings.artifactDigest` counts stored digest coverage; `bindings.artifactBinding`, `runtime`
and `verifierTrust` retain explicit unknown states.

Only closed aggregate counts and diagnostic reasons leave this export. Raw execution IDs,
feedback handles, task/prompt hashes and content, principal/session identifiers, private paths,
raw policy stamps and arbitrary model labels are not report dimensions.

Stored identity coverage is not immutable artifact attestation. The current serving-command
producer hashes the model path string for `modelArtifact` and the command string for
`configEpoch`; neither proves the bytes loaded for an execution. A serving-configuration
identity also does not prove the runtime binary that executed a task. The current source does
not independently establish verifier trust. Those gaps remain unknown
and the diagnostic qualification verdict remains HOLD; the exporter cannot select or activate a
candidate. Exact cost-row linkage is reported separately from monetary assessment. Power/cost
calibration remains deferred in [#82](https://github.com/Magnus-Gille/gille-inference/issues/82),
with no inferred prices or savings.

Before qualification, the project still needs immutable model/runtime-to-execution binding, trusted
behavioral verification, reviewed non-cost thresholds fixed before observation, and genuine
candidate-bound organic opportunities, attempts and feedback. This diagnostic does not provide
the organic opportunity denominator. Software fixtures prove join and privacy behavior only;
they do not satisfy an organic observation requirement or replace the historical HOLD.

Prospective collection and its fixed observation window are tracked in
[#308](https://github.com/Magnus-Gille/gille-inference/issues/308).
