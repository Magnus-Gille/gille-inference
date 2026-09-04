# Manual model-evaluation runbook

The former weekly discovery and automatic-promotion jobs are retired. Model evaluation is now an
explicit operator action against an already-staged local GGUF. The run records evidence in the
historical `data/model-scout-registry.jsonl` path so existing rows remain readable; it never changes
the live llama-swap roster.

## Dry run

```bash
npx tsx scripts/evaluate-model.ts \
  --evaluation-id manual-eval-muse-glimmer-20260904-01 \
  --model-id meta-models/Muse-Glimmer-30B-GGUF \
  --gguf /home/magnus/models/muse-glimmer-30b/muse-glimmer-30B-kquant-dynamic.gguf \
  --quant KQ_DYNAMIC \
  --dry-run
```

The artifact must be a regular GGUF below `MODELS_DIR` (default `/home/magnus/models`). The
operator supplies the durable model id and a non-secret, opaque `--evaluation-id` (8–128 safe
identifier characters). Reuse that identity only when retrying the same logical evaluation. An
exact durable retry is a no-op; reuse with different evidence fails closed instead of creating a
duplicate. There is no Hugging Face discovery, candidate ranking, or download step.

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
  --evaluation-id manual-eval-muse-glimmer-20260904-01 \
  --model-id meta-models/Muse-Glimmer-30B-GGUF \
  --gguf /home/magnus/models/muse-glimmer-30b/muse-glimmer-30B-kquant-dynamic.gguf \
  --quant KQ_DYNAMIC
```

Before it opens the maintenance window or loads a model, the evaluator proves that the configured
registry can be opened and atomically replaced by its effective identity. A failure names only the
registry operation, path, and errno class. The deploy tool prepares that exact file at mode `0600`
and its immediate parent at `0700` for the unprivileged deployment/evaluation identity; it never
recursively changes `data/`. `scripts/deploy-gateway.sh verify` repeats a read-only appendability
check and reports the effective uid without touching the roster or loading a model.

The atomic writer holds `model-scout-registry.jsonl.lock` only for the synchronous commit. An
unclean process death can leave that lock behind; preflight and deploy verification then fail
before any GPU work and name the exact lock path. After proving that no evaluator process or
maintenance window is active, remove only that stale lock and rerun the read-only deploy verifier.

The evaluator requires llama-swap's unload request to succeed and `/running` to prove empty before
it starts a loopback-only ephemeral llama-server. It runs the deterministic probe battery
sequentially, commits one content-blind registry row using lock + fsync + atomic rename, restores the pre-run resident model when one
was ready, and only then releases the exclusive window. Spawn failures, termination signals, and
TTL cancellation follow the same cleanup path. The maintenance credential is stripped from the
llama-server child environment. The evaluator does not move, delete, register, or promote the
artifact. A `winner` is evidence for review, not a roster command.

## Evidence and routing

`GET /portal/model-evals.json` exposes the latest content-blind rows for the portal. The routing
generator may consume a sufficiently fresh manual evaluation when the capability ledger is thin;
unknown or weak evidence still escalates to the frontier. Any live roster change requires the
separate owner-reviewed roster workflow.
