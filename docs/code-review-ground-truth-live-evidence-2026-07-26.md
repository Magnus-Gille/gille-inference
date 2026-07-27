# Code-review ground-truth live evidence — 2026-07-26

Issue: #13.  Status: **trusted-verifier adoption rejected; no routing change proposed.**

## Observed run

One bounded, single-repeat run of the committed probe battery completed against the model that
was serving at the time.  It ran under the shared GPU lease and wrote one append-only
`live-served-model` audit record.  The record is bound to server-observed artifact and
serving-configuration digests before and after the battery; neither digest nor the serving command
is reproduced here.

| Field | Observed value |
| --- | ---: |
| Timestamp | 2026-07-26T02:39:37.523Z |
| Probe battery | `2026.07.20-1` / corpus `f4284272894602b1` |
| Total probes | 74 |
| Errors | 0 |
| Empty outputs | 0 |
| Truncations | 0 |
| Finish reasons | 74 `stop` |
| Seeded defects / true positives | 34 / 7 |
| Reported findings | 7 |
| Clean controls / confabulated controls | 6 / 0 |
| Recall | 20.6% |
| Precision | 100% |
| Clean-control confabulation | 0% |

The sufficient statistics were recomputed independently from the retained per-probe results, not
copied from the aggregate: 18 review probes, 34 expected findings, 7 true positives, 7 reported
findings, 6 clean controls, zero clean-control accusations, zero errors, zero empty outputs, zero
truncations, and 74 `stop` finish reasons.

## Lane decision

The configured unattended-review gates require recall at least 50%, precision at least 75%, and
clean-control confabulation no more than 25%; serving diagnostics each must remain below their
configured 20% limits.  This run meets the precision, clean-control, and diagnostic thresholds but
fails recall (20.6% < 50%).  The correct decision is therefore **hold / frontier escalation**, not
local code-review service.

`reviewGroundTruth` is deliberately **not** added to the trusted judgment-verifier allow-list.
The live allow-list was verified empty at the time of the decision.  This is a rejection of the
candidate lane under its observed evidence, not a claim that the deterministic corpus is invalid.
A later run may be reconsidered only with new evidence and a separately reviewed policy/routing
change.

## Exclusion and routing safety

Existing legacy structural and opaque rows remain in the ledger for auditability, but they cannot
earn a code-review verdict while the trusted allow-list is empty.  The executable checks in
`tests/homeserver-verdict-hygiene-whitelist.test.ts` prove that `predicate`, `matches`, and
`nonEmpty` rows are retained yet contribute zero verdict attempts for code review; the same tests
show that only an explicitly allow-listed verifier can change that result.  The incumbent audit is
advisory evidence and does not itself alter the routing table.

No routing proposal, adoption, canary, restart, or rollback was performed: adoption would be
unsafe with the observed recall and must remain a separate reviewed routing diff if future evidence
qualifies.  The rollback for this evidence-only activity is simply no routing action to undo; the
append-only audit row is retained as evidence rather than deleted.
