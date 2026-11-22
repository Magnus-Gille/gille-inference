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

## External corpora (`gate-d-r3`, INFER-521)

`gate-d-r3` is not in this repository and never will be: a sealed holdout in a public repository
is not sealed. code-battle's `gate-d-r3` generator (CBATTLE-14) materializes it in exact Gate D task
format, plus a `corpus-manifest.json` that pins each task directory's content digest. The runners
read it from an external root:

```bash
export GATE_D_TASKS_ROOT=/path/outside/this/checkout/r3-validation
bash gate-d/run.sh --list-tasks                 # validation tasks from the manifest
bash gate-d/run.sh pi all                       # or ARMS="pi" bash gate-d/sweep.sh
GATE_D_INCLUDE_HOLDOUT=1 bash gate-d/run.sh pi all   # sealed tasks only, for a declared final run
python3 scripts/gate-d-code-loop.py --tasks-root "$GATE_D_TASKS_ROOT" --list-tasks
```

Contract:

- **Location.** The root, after resolving symlinks, may neither lie inside this checkout nor
  contain it, and the work root may neither lie inside the task root nor contain it. Its path may
  not contain quotes, backslashes, `$`, backticks or control characters, because `check.sh` and
  `at-stop.sh` interpolate task paths into Python one-liners.
- **Integrity.** Each task directory's digest (sha256 over the component-wise sorted
  `relpath\0sha256(file)\n` entries, identical to the generator's `tree_digest`) must equal the
  manifest's `digest` before the arm, after the arm, and after grading. A mismatch, an added or
  removed file, or any symlink or special file aborts with exit 9 and no row. This replaces the
  `git status` guard, which cannot see outside the checkout; the committed-fixture guard still runs.
  `run.sh` pins the manifest's own sha256 when it starts (a sweep pins it once for every run), and
  every check parses only those bytes, so rewriting a task together with its manifest digest also
  aborts. The post-run checks must reproduce the pre-run identity exactly. Empty directories and file
  modes are outside the digest, as in the generator. There is no automatic restore for an external
  root: regenerate it (`generate.py --check-manifest` shows drift).
- **Sealing.** A task is sealed when its `meta.json` says `holdout: true` or the manifest's split is
  `sealed`. Sealed tasks need `GATE_D_INCLUDE_HOLDOUT=1` (code-loop: `--include-holdout`), are left
  out of `all` without it, and are refused by name.
- **Identity.** Rows take `corpusRevision`, `holdout`, `family`, `split` and `trap` from the
  digest-verified `meta.json`, and record the manifest digest as `taskRevision`. The external
  revision may not reuse a committed one (`gate-d-r1`, `gate-d-r2`). Resume and summaries key on
  revision and digest, so a regenerated task never counts toward its predecessor.
- **Verification fields.** External rows always carry `atStopTypecheck`, `atStopVisibleTests` and
  `detectableFailureAtStop` from `at-stop.sh` (run after the arm, before `check.sh` stages the hidden
  oracle), and the pi-transcript fields `verificationClass`, `typecheckRuns`, `testRuns`,
  `typecheckAfterLastEdit`, `testsAfterLastEdit`, `lastTypecheckOutcome`, `lastTestOutcome`,
  `stoppedWithFailingCheck`, `ambiguousCheckOutcomes`, `firstEditTurn`, `lastEditTurn` and `edits`.
  `null` means not measured for the at-stop fields (a failed, timed-out or off-schema script, which
  also prints a warning). For the transcript fields use `verificationSchema`: it names the classifier
  when the fields were measured and is `null` otherwise (non-pi arms), because some of those fields
  are legitimately `null` when measured (no check ran, no edit). at-stop runs on a throwaway copy of
  the work dir, so neither metric can change pass/fail. r1/r2 rows are unchanged.
- **Code-loop runner.** `scripts/gate-d-code-loop.py --tasks-root` applies the same enumeration,
  sealing, digest and identity rules (manifest read once, held in memory) and records the at-stop
  fields, but no transcript fields. It grades inside the checkout as before, since its arm runs
  remotely; it now links `node_modules` into the grading dir, which `check.sh`'s G0-toolchain gate
  requires.

Both scripts that produce those fields are pinned copies in this repository (`gate-d/at-stop.sh`,
`scripts/pi-verification-telemetry.ts`) rather than code loaded from the task root, because the
manifest pins task directories, not scripts. Re-copy them when CBATTLE-14 changes the originals.
