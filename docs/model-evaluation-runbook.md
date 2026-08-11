# Manual model-evaluation runbook

The former weekly discovery and automatic-promotion jobs are retired. Model evaluation is now an
explicit operator action against an already-staged local GGUF. The run records evidence in the
historical `data/model-scout-registry.jsonl` path so existing rows remain readable; it never changes
the live llama-swap roster.

## Dry run

```bash
npx tsx scripts/evaluate-model.ts \
  --model-id meta-models/Muse-Glimmer-30B-GGUF \
  --gguf /home/magnus/models/muse-glimmer-30b/muse-glimmer-30B-kquant-dynamic.gguf \
  --quant KQ_DYNAMIC \
  --dry-run
```

The artifact must be a regular GGUF below `MODELS_DIR` (default `/home/magnus/models`). The
operator supplies the durable model id; there is no Hugging Face discovery, candidate ranking, or
download step.

## Protected evaluation

The real run must use the shared GPU lease and an owner/admin gateway key that can engage
maintenance mode. The script fails closed before unloading or launching the ephemeral server when
`EVAL_MODEL_REQUIRE_MAINTENANCE=1` (the default) and maintenance cannot be confirmed.

```bash
export EVAL_MODEL_MAINTENANCE_KEY="$(m5-auth)"
npx tsx src/homeserver/cli.ts gpu run --model manual-model-evaluation --eta 90m \
  --purpose manual-model-evaluation -- \
  npx tsx scripts/evaluate-model.ts \
    --model-id meta-models/Muse-Glimmer-30B-GGUF \
    --gguf /home/magnus/models/muse-glimmer-30b/muse-glimmer-30B-kquant-dynamic.gguf \
    --quant KQ_DYNAMIC
```

The evaluator starts a loopback-only ephemeral llama-server, runs the deterministic probe battery
sequentially, and appends one content-blind registry row. It does not move, delete, register, load,
reload, or promote the artifact. A `winner` is evidence for review, not a roster command.

## Evidence and routing

`GET /portal/model-evals.json` exposes the latest content-blind rows for the portal. The routing
generator may consume a sufficiently fresh manual evaluation when the capability ledger is thin;
unknown or weak evidence still escalates to the frontier. Any live roster change requires the
separate owner-reviewed roster workflow.
