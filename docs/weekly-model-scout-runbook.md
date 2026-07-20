# Weekly Model Scout — runbook (Job A)

The scout discovers trending HuggingFace GGUF models that fit the box, benchmarks each on an
**ephemeral throwaway llama-server** (the live gateway/llama-swap is never touched during testing),
and **auto-serves clear winners** by editing `/etc/llama-swap/config.yaml` + restarting llama-swap.
Results publish to Heimdall (`/services/m5-inference`) and to the portal's "New model evaluations".

## Pieces (in this repo)

| File | Role |
|---|---|
| `src/homeserver/hf-trending.ts` | HF trending API client + `pickQuant` (fits the 64 GB VRAM) |
| `src/homeserver/probe-runner.ts` | reusable probe battery executor (any OpenAI endpoint) |
| `src/homeserver/model-registry.ts` | durable JSONL registry (`data/model-scout-registry.jsonl`) |
| `src/homeserver/model-evals-portal.ts` | shapes the registry for the portal JSON route |
| `scripts/weekly-model-scout.ts` | orchestrator: discover → download → ephemeral serve → probe → verdict |
| `scripts/promote-model.ts` | transactional auto-serve of a winner (backup → edit → restart → health → rollback) |
| `scripts/post-model-scout-panels.ts` | push `model-evals` (table) + `models-evaluated` (timeseries) to Heimdall |

## Production-shaped ground truth and auto-serve gates (#158)

The weekly battery includes two committed, deterministic corpora:

- 18 stratified synthetic concierge cases (6 ready, 6 clarify, 6 answer), using a frozen
  decision prompt, representative memory/reply-context layout, and strict JSON semantics.
- 12 annotated mutant diffs with 34 seeded defects plus 6 clean controls. These are scored locally
  from stable line ids, yielding seeded-bug recall, finding precision, and clean-control
  confabulation without an LLM judge.

The registry also persists HTTP/verifier errors, empty assistant outputs, truncations, and the full
`finish_reason` distribution. `promote-model.ts` recomputes the gates from the durable counts and
holds a winner for manual review when evidence is missing or any default threshold trips:

| Environment override | Default | Auto-serve requirement |
|---|---:|---|
| `SCOUT_MAX_ERROR_RATE` | 0.20 | error rate must be below 20% |
| `SCOUT_MAX_EMPTY_OUTPUT_RATE` | 0.20 | empty-output rate must be below 20% |
| `SCOUT_MAX_TRUNCATION_RATE` | 0.20 | `finish_reason=length` rate must be below 20% |
| `SCOUT_MIN_REVIEW_RECALL` | 0.50 | seeded-bug recall must be at least 50% |
| `SCOUT_MIN_REVIEW_PRECISION` | 0.75 | finding precision must be at least 75% |
| `SCOUT_MAX_REVIEW_CLEAN_CONFABULATION_RATE` | 0.25 | clean-control confabulation must be at most 25% |

These lane-specific checks are separate from the aggregate scout pass rate: a model cannot make up
for missing seeded bugs by passing unrelated probes.

## Corpus/probe versioning + serving-config gate (#12)

`src/homeserver/corpus-version.ts` exports `PROBE_BATTERY_VERSION` (a human-bumped label) and
`computeCorpusFingerprint()` (a sha256 content hash over every probe's id/taskType/prompt/
systemPrompt/verifierName/maxTokens/reviewExpectedFindings). `probes.ts` re-exports both alongside
`CORPUS_FINGERPRINT`, computed from its OWN `PROBES` array so the two can never drift apart.
`weekly-model-scout.ts` stamps `probeBatteryVersion` + `corpusFingerprint` on every registry row —
so a row is traceable to the EXACT corpus that produced it, not just "some" battery.
`tests/corpus-version.test.ts` pins the current fingerprint (mirroring `GATE_D_STRICT_PIN`):
changing the corpus on purpose means updating `PROBE_BATTERY_VERSION` and the pinned test value in
the same change.

Each row that actually ran probes also carries an `evalServingConfig` (`ctx`, `repeats`, `ngl`,
`flashAttn`) — the exact ephemeral serving parameters used to produce its evidence. A row missing
this (a legacy row, a hand-written row, or any writer that skips the bookkeeping) is held for
manual review by `scout-gate.ts`'s `servingConfigFlags` (`missing-serving-config`), the same
fail-closed treatment as the missing-review-ground-truth fallback — "passed the battery" and "will
behave the same way once served" are only the same claim when the tested configuration is known.

`promote-model.ts` also validates that recomputed review recall/precision/clean-confabulation are
finite numbers in `[0,1]` before trusting them (`invalid-review-ground-truth`) — a malformed or
hand-written row can no longer slip past a `<`/`>` comparison that a `NaN` would silently fail.

## Memory budget (ground truth)

Box = 128 GB unified = **64 GB GPU VRAM** carve-out + 61 GB system. With `-ngl 99` the whole model
lives in VRAM, so `MEM_BUDGET_GB=58` (default) leaves KV-cache headroom under the 64 GB ceiling.
`gpt-oss-120b` (60 GB) already serves right under it. "Borderline-large" runs may set `MEM_BUDGET_GB=62`.

## Box prerequisites (one-time)

- `aria2c` (present), `/opt/llama.cpp/build/bin/llama-server` (present), models dir
  `/srv/models` (present). Scratch dir `/srv/models/scratch` is created on first run.
- `~/.heimdall-push.env` (mode 600) must export `HEIMDALL_PANELS_URL` + `HEIMDALL_FLEET_TOKEN`
  (already present — same file the offloadability nightly uses).
- Promotion runs `sudo systemctl restart llama-swap` — ensure the `inference` service user may run that
  without an interactive password (it already does for the nightly stack).
- **`~/.scout-maintenance.env` (mode 600, optional but strongly recommended)** must export
  `SCOUT_MAINTENANCE_KEY` — a dedicated owner-tier gateway key used ONLY to toggle bench/
  maintenance mode (#105) around the ephemeral test window, so guests get an honest 503 instead
  of silently VRAM-contended service. Provision it once, on the box (never printed, piped
  straight into the file — same pattern as the harness-key rotation recipe in
  `~/.claude/CLAUDE.md`):
  ```bash
  cd /srv/gille-inference && npx tsx src/homeserver/cli.ts keys mint \
      --alias scout-maintenance --tier owner --models none --rpm 30 --tpm 1000 --daily 100 \
      2>/dev/null | grep -oE "hs_owner_[A-Za-z0-9_-]+" | head -1 \
    | { IFS= read -r K; [ -n "$K" ] && printf 'SCOUT_MAINTENANCE_KEY=%s\n' "$K" \
        > ~/.scout-maintenance.env && chmod 600 ~/.scout-maintenance.env \
        && echo "provisioned len=${#K}" || echo "MINT FAILED — file unchanged"; }
  ```
  `--models none` + tight `--rpm`/`--tpm`/`--daily` mean this key is useless for real inference
  even if it ever leaked — it can only reach admin routes (owner tier ⇒ `isAdmin`), and
  `/admin/maintenance` is the only admin route this wrapper calls. This is genuinely optional:
  `weekly-model-scout.ts` runs exactly as before (with the pre-existing off-peak + lease +
  port-free-check mitigations only) if the file/key is absent — it logs a line and moves on,
  never fails the run.

## Deploy

From a clean `main` working copy on the laptop (the documented rsync flow):

```bash
rsync -az --no-perms --omit-dir-times \
  --exclude .git --exclude node_modules --exclude data --exclude .env \
  --exclude '*.log' --exclude debate --exclude .claude --exclude dist \
  ./ m5:/srv/gille-inference/
ssh m5 'sudo systemctl restart home-gateway'   # ONLY needed for the new /portal/model-evals.json route + portal.html
```

(The gateway restart is required this once because `portal.html` is cached in memory and a new
route was added. Subsequent scout runs need NO restart — the portal section is data-driven.)

## On-box wrapper — `~/weekly-model-scout.sh`

```bash
#!/usr/bin/env bash
# Weekly model scout — discover/test trending HF models, auto-serve winners, publish.
set -uo pipefail
cd /srv/gille-inference || exit 1
set -a; . /home/inference/.heimdall-push.env; set +a   # HEIMDALL_PANELS_URL + _FLEET_TOKEN
[ -f /home/inference/.scout-maintenance.env ] && { set -a; . /home/inference/.scout-maintenance.env; set +a; }  # SCOUT_MAINTENANCE_KEY (#105, optional)

LOG=/home/inference/logs/model-scout-$(date -u +%F).log
mkdir -p /home/inference/logs

# Heavy GPU work sequences on the serial-GPU lease (issue #88). "Borderline-large" budget.
MEM_BUDGET_GB=62 SCOUT_MAX_CANDIDATES=2 \
  npx tsx src/homeserver/cli.ts gpu run --model model-scout --eta 90m --purpose model-scout -- \
    npx tsx scripts/weekly-model-scout.ts >>"$LOG" 2>&1

# Auto-serve the winner (also GPU-leased: restart + warm-up touch the GPU).
npx tsx src/homeserver/cli.ts gpu run --model model-scout --eta 10m --purpose promote -- \
  npx tsx scripts/promote-model.ts >>"$LOG" 2>&1

# Publish to Heimdall (plain HTTP — no GPU). Best-effort.
npx tsx scripts/post-model-scout-panels.ts >>"$LOG" 2>&1 || true
```

`chmod +x ~/weekly-model-scout.sh`.

## Cron (on the box)

Off-peak, staggered from the 03:00 UTC offloadability nightly and the 06:00 research sweep:

```cron
# Weekly model scout — Sundays 04:00 UTC (≈05:00–06:00 CEST, low usage)
0 4 * * 0 /home/inference/weekly-model-scout.sh
```

## First-run / smoke test

```bash
# Discovery only — no download/serve/promote:
ssh m5 'cd /srv/gille-inference && npx tsx scripts/weekly-model-scout.ts --dry-run'
# Promotion dry-run (prints the config block it WOULD add):
ssh m5 'cd /srv/gille-inference && npx tsx scripts/promote-model.ts --dry-run'
# Panels dry-run (prints the Heimdall envelopes):
ssh m5 'cd /srv/gille-inference && npx tsx scripts/post-model-scout-panels.ts --dry-run'
```

## Safety notes

- **Ephemeral isolation (and its one caveat):** testing spins up its own `llama-server` on `:9099`
  and benchmarks against it directly — the live config is never edited during a test. Before launch
  the scout POSTs `/api/models/unload` to llama-swap (`SCOUT_UNLOAD_FIRST=1`) so the test has the
  64 GB VRAM; this **does briefly evict llama-swap's resident model** (live serving cold-starts on
  the next request). The scout also aborts a candidate if `:9099` is already occupied (stale server).
  Caveat: the `gpu run` lease sequences batch jobs but does **not** gate live gateway traffic, so a
  request arriving mid-test could cold-load a second model and contend for VRAM. **#105 closes the
  gap when `SCOUT_MAINTENANCE_KEY` is provisioned** (see "Box prerequisites" above):
  `weekly-model-scout.ts` engages bench/maintenance mode (`POST /admin/maintenance`) around the
  whole candidate-evaluation loop — new GUEST requests get an honest 503 with a Retry-After
  instead of silently degraded VRAM-contended service; OWNER traffic is never blocked. The toggle
  carries a `ttlSeconds` auto-expiry safety net (`SCOUT_MAINTENANCE_TTL_S`, default 7200s) so a
  scout process that dies mid-run (crash, OOM, SIGKILL) can't leave guests locked out forever —
  it self-heals on the gateway side even with no further calls. Without the key configured, the
  original off-peak + lease + port-free-check mitigations still apply unchanged.
- **Promotion is transactional:** timestamped `config.yaml.bak.<ts>` → append entry → restart →
  health-check (`/v1/models` + 1-token warm-up) → **rollback + restart on any failure**. Never
  leaves llama-swap down; never auto-serves more than one model per run; refuses to grow the served
  set past `PROMOTE_MAX_SERVED` (default 12).
- **Portal sync:** the "New model evaluations" card is data-driven via `GET /portal/model-evals.json`
  — it refreshes without a gateway restart. The hand-maintained "What's running" table is NOT
  auto-updated; when a winner is promoted, update that table by hand on the next portal edit.
