# Gate D corpus revisions

Gate D fixtures are deterministic, model-free graded, and append-only once used for evidence.

| revision | tasks | authored | purpose |
|---|---:|---|---|
| `gate-d-r1` | 01–10 | 2026-06-24 | Original harness comparison battery. |
| `gate-d-r2` | 01–14 | 2026-07-14 | Adds four fresh, model-unseen prompt-learning holdouts (#250). |

The `gate-d-r1` task tree is pinned by Git tree object
`5ab301a9cfd63debf37d9edd1823514f692dc872`. Tasks 01–10 must remain byte-identical so the
June evidence stays reproducible. `verify-fixtures.sh` checks the pinned commit/tree and refuses
any tracked or untracked drift below those ten task directories.

The reachable commit anchor is the public-history root
`9fbfddf6f1b6a46e4a39ad5f6df4ecfa4d5bf606`. It replaces the original private-history anchor
`d2d2541dd01519ddf50a9bbba8903d02fcea5284`, which was intentionally omitted during the public
history cutover. Both anchors resolve tasks 01–10 to the same content-addressed tree above; the
tree hash remains the immutable corpus identity, while the public commit makes strict verification
possible in a clean public clone.

Revision 2 only appends tasks 11–14:

- Cache-path containment and invalid-key rejection.
- Cross-file CLI formatter export/import integration.
- Test-file type correctness plus implementation behavior.
- Shared multi-file validation with a hidden oracle and protected callers.

## Holdout consumption contract

The machine-readable contract is [`corpus.json`](./corpus.json). Routine `run.sh all`, `sweep.sh`,
and `scripts/gate-d-code-loop.py` enumerate only `gate-d-r1`; they never glob `tasks/*`. Selecting
`gate-d-r2` requires the conspicuous `GATE_D_INCLUDE_HOLDOUT=1` environment opt-in, or
`--include-holdout` for the Python code-loop runner. An explicit task 11–14 selection is also
refused without that opt-in.

Every result row records `corpusRevision`, `taskRevision`, and `holdout`. Resume counts and
scoreboards filter by the active corpus revision; legacy rows without a revision are interpreted
as `gate-d-r1`, never as r2. The code-loop acceptance contracts are fixed at >=9/10 for r1 and
>=13/14 for the explicitly selected r2 corpus.

All revision-2 seeds and solutions are committed before Hugin selects experiment holdouts. Hugin
owns later matched execution and promotion; authoring and model-free fixture verification do not
run a model or judge.
