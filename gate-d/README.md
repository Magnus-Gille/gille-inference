# Gate D — agentic-coding task battery

Deterministic, model-free-graded coding tasks for the OSS-harness × local-model evaluation
(see `docs/gate-de-evaluation-plan.md`). Each task is a tiny self-contained repo with a
**stub** that fails a committed **oracle**; a harness arm (pi / aider / opencode driving a
box model) must edit the source until the oracle passes. **No model is in the grading path.**

## Layout

```
gate-d/
  check.sh                 # the verifier — gates G1..G5 (run from a graded work dir)
  run.sh                   # arm runner: copy seed → invoke arm → check → append JSONL (NEEDS THE BOX)
  verify-fixtures.sh       # build-time self-test: every fixture seed=RED, reference solution=GREEN
  aider-model-settings.yml # aider per-model knobs (diff format + 1800s timeout for slow MoE)
  aider-model-metadata.json# aider context/cost metadata for the box models
  tasks/<id>/
    meta.json              # difficulty, edit[]/read[] scope, oracleFiles[], oracleCmd, structural, budgets
    INSTRUCTION.md         # the prompt handed to the harness
    repo/                  # the pristine seed (stub src + RED oracle + tsconfig)
    solution/              # reference solution — used ONLY to self-verify the oracle (never shown to a harness)
```

### check.sh gates (all must pass = task complete)
- **G1** oracle files byte-identical to the seed (anti-cheat — the harness must not edit the oracle)
- **G2** at least one declared `edit` target changed vs the seed (real work happened)
- **G3** `tsc --noEmit` clean (the tsGate)
- **G4** the oracle script exits 0 (the assertions hold)
- **G5** the task-specific structural assertion (e.g. task 03: `index.ts` imports `distance` from `./geo`)

## Verify the battery (no box, no model)

```bash
bash gate-d/verify-fixtures.sh
# ✓ each task: seed RED, reference solution GREEN  → grading is sound
```
Work dirs live under `$TMPDIR/gate-d-work/` — deliberately **outside** this checkout (#172: a
work dir merely nested inside the repo let the `pi` arm's path resolution escape to the outer
git root and overwrite a committed fixture in place). A `node_modules` symlink back to the repo
keeps tsc/tsx resolving normally from there.

## Run an arm (NEEDS THE BOX)

Prereqs: a real gateway key (`bin/invite`), and the harness pointed at the box —
- **pi:** add the `inference-gille` provider to `~/.pi/agent/models.json` (see the plan doc)
- **aider:** uses `OPENAI_API_BASE`/`OPENAI_API_KEY` + the YAML/JSON config here
- **opencode:** add the `homebox` provider to `opencode.json` (see the plan doc)

```bash
export GW=https://inference.example.com/v1 GW_KEY=<real-key> MODEL=qwen3-coder-next-80b CAP_S=600
bash gate-d/run.sh pi all          # arm A7
bash gate-d/run.sh aider 03-impl-fn-across-2-files
bash gate-d/run.sh opencode all    # arm A5
# `all` means pinned r1 (01–10). This conspicuous opt-in consumes the fresh r2 holdouts:
GATE_D_INCLUDE_HOLDOUT=1 bash gate-d/run.sh pi all
# → rows include corpusRevision, taskRevision, and holdout
# Sweep console output is tee'd here by default; override for an isolated experiment log:
GATE_D_LOG=/tmp/gate-d-r2.log GATE_D_INCLUDE_HOLDOUT=1 bash gate-d/sweep.sh
```

## Status

**All 14 tasks built + verified** — `verify-fixtures.sh` is **79/79** (14 tasks seed-RED → reference-GREEN, + 65 anti-cheat regressions), plus pinned-commit/tree, revision-enumeration, and work-dir-isolation checks. The append-only corpus history and holdout-consumption rules are in [`CORPUS.md`](./CORPUS.md):

The AST gates resolve lexical binding identities rather than trusting matching names. Their
execution counts are guaranteed lower bounds: unknown branches, possibly empty iterables, dead
closures, and skipped runners cannot manufacture credit. Imported-result and validation
provenance also fails closed through unknown calls and transforms, while explicitly modelled
value-preserving transforms, containers, and imported-function dispatch remain accepted. The CSV
contract is evaluated on the real selected flag path, not an unrelated existential return; static
container selection and mutated property stores likewise preserve only the value actually returned
or validated.

| # | task | diff | what it exercises |
|---|---|---|---|
| 01 | make-failing-test-pass | E | implement a stub to pass an oracle |
| 02 | fix-bug-test-catches | E | fix a bug (radix/throw guards) |
| 03 | impl-fn-across-2-files | M | cross-file: `index.ts` must import `distance` from `./geo` |
| 04 | add-cli-flag | M | `--json` flag end-to-end (cli.ts + format.ts) |
| 05 | tdd-write-test-then-impl | M | write tests **then** impl; graded by a HIDDEN oracle |
| 06 | fix-off-by-one | E | off-by-one in a paginator |
| 07 | refactor-extract-fn | M | extract a `subtotal` helper; behaviour preserved (structural-RED, not oracle-RED) |
| 08 | add-validation-guard | M | add throw-guards before mutation |
| 09 | rename-across-files | H | rename a symbol across 4 files (no `widget` left, `gadget` present) |
| 10 | fix-shared-util-regression | H | fix a shared util; 2 sibling oracles must stay green |
| 11 | node-path-containment | M | path containment + invalid cache-key rejection (hidden oracle) |
| 12 | add-csv-cli-format | M | cross-file CLI formatter export/import integration |
| 13 | type-safe-slug-tests | M | test-file type correctness + implementation behaviour (hidden oracle) |
| 14 | shared-handle-validation | H | multi-file validation/shared utility with protected callers + hidden oracle |

Two `meta.json` knobs beyond the basics: `hiddenOracle` (05, 11, 13, 14 — staged at grade time so
the model cannot edit or inspect the protected oracle) and `seedOracleRed: false` (07 — the seed is
RED via the *structural* gate, its oracle is green).

### Executed 2026-06-24 — `qwen3-coder-next-80b`, ×1 seed (see `docs/gate-d-execution-findings-2026-06-24.md`)

**pi (A7) 10/10 · aider-`diff` (A1) 6/10 → Gate D PASSES on the pi arm.** All runs 5–93 s, no
timeouts. aider's 4 misses are genuine capability errors (wrong-fix/typecheck/partial-rename), not
edit-format failures; pi's read→edit→run loop solved all four. Two operational lessons baked into
the harness: `run.sh` now git-inits each work dir (else arms escape to the parent repo and corrupt
the **seed**), and **never kill a run mid-stream** — abrupt disconnects degenerate the box's 80b
into `?????` (use `sweep.sh`, which resets the model after any `arm-error`).

## Sweep all arms (resumable, corruption-safe)

`run.sh` runs one (arm, task); `sweep.sh` runs the matrix — resumable (skips done
arm/model/task triples) and safe (sequential; resets the 80b after any timeout/kill):

```bash
export GW=https://inference.example.com/v1 GW_KEY=<real-key> MODEL=qwen3-coder-next-80b
ARMS="aider pi" SEEDS=1 CAP_S=360 bash gate-d/sweep.sh   # → data/gate-d-results.jsonl + data/gate-d-sweep.log
```

Both runners default to `gate-d-r1`. Set `GATE_D_INCLUDE_HOLDOUT=1` only for a declared r2 run.
Resume counts and summaries are scoped by `corpusRevision`, so historical r1 evidence cannot enter
an r2 scoreboard.

Use `GATE_D_OUT` for clean head-to-head model comparisons so historical rows do not suppress a
different model's runs:

```bash
GATE_D_OUT="$PWD/data/gate-d-ornith-20260707.jsonl" MODEL=ornith SEEDS=3 ARMS=pi bash gate-d/sweep.sh
```
