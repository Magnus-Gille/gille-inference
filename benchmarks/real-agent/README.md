# Real-repository agent benchmark

This corpus measures completed useful coding work per minute on immutable snapshots from this
repository's real history. It complements Gate D's small deterministic fixtures; it does not
replace them.

## Contract

- `corpus.json` preregisters the source repository, full base/reference commits, sparse seed paths,
  owner-authored instruction, exact writable paths, hidden oracle files, and deterministic checks.
- The runner creates a new temp Git root from `git archive` of the base commit. Benchmark/oracle
  files from the current checkout are therefore absent while the model works.
- Changed paths are captured before the hidden oracle is installed. Any non-preregistered path
  makes the run fail.
- Raw Pi NDJSON and stderr are mode 0600 inside the throwaway directory and are deleted by default.
  The durable JSONL row contains counts, timings, check hashes, immutable revisions, and exit
  classes—not prompts, model text, tool arguments, tool output, or changed paths.
- `modelTurnMs` is a harness-observed turn span, not pure GPU inference. `assistantStreamMs`
  excludes TTFT. Both retain explicit coverage counts.

## Security boundary

Direct Pi print mode is isolated by a fresh temp Git root and Git ceiling, but it is not OS-caged.
Use this runner only with owner-authored public seed content and no secrets. A live run therefore
requires the explicit `--ack-uncaged-pi` flag. Private/sensitive tasks require the existing caged
`code_loop` path or a future model-selectable caged evaluation executor.

The hidden oracle is local trusted code. A model must never receive it through the instruction,
seed, raw log, or follow-up feedback during a scored run.

## Validate and run

Validation is offline and checks schema, full Git objects, seed paths, reference changes, and
oracle presence:

```bash
npm run benchmark:real-agent -- --validate
```

For an authenticated laptop run, load the canonical environment without printing the credential,
then execute one model/task at a time:

```bash
eval "$(m5-auth --env --tailnet)"
npm run benchmark:real-agent -- \
  --task pi-telemetry-contract \
  --model qwen36-a3b \
  --out benchmarks/results/strix-real-r1.jsonl \
  --ack-uncaged-pi
```

Keep the default 900-second cap unless the preregistered experiment states otherwise. Do not run
models concurrently: the Strix GPU is a serial shared resource, and normal gateway admission must
remain in force. `--keep-work` is for bounded diagnosis only because it retains raw content.
