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

The real run acquires the repository-owned exclusive maintenance window: the isolated gateway
identity takes the shared GPU lease, fences owner and guest inference, drains admitted work, and
captures stable llama-swap residency before the evaluator can unload or launch anything. The
opaque release token remains in memory and only this run can close its window. Missing or rejected
maintenance authorization fails before evaluation. The evaluator reserves the final 320 seconds
of the server-owned TTL for cancellation and residency restoration; probe work is aborted before
that deadline rather than being allowed to outlive the lease.

```bash
# Resolve M5_MAINTENANCE_KEY from the approved private operator credential source first.
npx tsx scripts/evaluate-model.ts \
  --model-id meta-models/Muse-Glimmer-30B-GGUF \
  --gguf /home/magnus/models/muse-glimmer-30b/muse-glimmer-30B-kquant-dynamic.gguf \
  --quant KQ_DYNAMIC
```

The evaluator requires llama-swap's unload request to succeed and `/running` to prove empty before
it starts a loopback-only ephemeral llama-server. It runs the deterministic probe battery
sequentially, appends one content-blind registry row, restores the pre-run resident model when one
was ready, and only then releases the exclusive window. Spawn failures, termination signals, and
TTL cancellation follow the same cleanup path. The maintenance credential is stripped from the
llama-server child environment. The evaluator does not move, delete, register, or promote the
artifact. A `winner` is evidence for review, not a roster command.

## Evidence and routing

`GET /portal/model-evals.json` exposes the latest content-blind rows for the portal. The routing
generator may consume a sufficiently fresh manual evaluation when the capability ledger is thin;
unknown or weak evidence still escalates to the frontier. Any live roster change requires the
separate owner-reviewed roster workflow.
