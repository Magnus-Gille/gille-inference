# Weekly Research Sweep — runbook (Job B)

Each week the box researches *how to run smarter models faster on itself* — EN + Chinese sources
on Strix Halo / llama.cpp-Vulkan / quantization / speculative decoding / MoE / long-context — using
its OWN local inference (the deep-research harness on local models, no frontier tokens), synthesizes
a "stuff we should try" proposal list, and publishes it to Heimdall.

## Pieces (in this repo)

| File | Role |
|---|---|
| `scripts/weekly-research-sweep.ts` | orchestrator: per-query deep-research (local brain) → local synthesis → `proposals.json` + markdown |
| `src/homeserver/research-proposals.ts` | `ResearchProposal` type + tolerant `parseProposals` |
| `scripts/post-research-sweep-panel.ts` | push the `research-proposals` table panel to Heimdall |
| `src/homeserver/deep-research-cli.ts` | (existing) the headless research harness it drives |

## Box prerequisite (one-time) — a live search + reader

The deep-research CLI is deployed but the box currently has **no working live search/reader**
(SearXNG `:8888` down; `trafilatura`/`ddgs` not installed). Establish one path:

```bash
ssh m5 'pip install --user ddgs'        # free, no API key; scripts/ddgs_search.py already wraps it
# then in /srv/gille-inference/.env on the box:
#   SEARCH_PROVIDER=ddgs
#   READER_PROVIDER=jina        # https://r.jina.ai — HTTP, no install (trafilatura would need one)
```

Verify: `ssh m5 'cd /srv/gille-inference && RESEARCH_GATEWAY_URL=http://127.0.0.1:8091/v1 \
  npx tsx src/homeserver/deep-research-cli.ts run --query "llama.cpp speculative decoding 2026" \
  --depth quick --brain local'` should write `data/research/<slug>/report.md`.

## Local brain (no frontier spend)

`--brain local` (default) keeps plan + distill + synth on-box. Endpoint = llama-swap `:8091`
directly (no gateway auth). Models: planner/synth = `qwen3-coder-next-80b`, distill = `mellum`.
NEVER pass `--brain hybrid` here.

## On-box wrapper — `~/weekly-research-sweep.sh`

```bash
#!/usr/bin/env bash
set -uo pipefail
cd /srv/gille-inference || exit 1
set -a; . /home/inference/.heimdall-push.env; set +a
LOG=/home/inference/logs/research-sweep-$(date -u +%F).log
mkdir -p /home/inference/logs

# Local-inference research + synthesis, GPU-leased (issue #88).
RESEARCH_GATEWAY_URL=http://127.0.0.1:8091/v1 \
SEARCH_PROVIDER=ddgs READER_PROVIDER=jina \
RESEARCH_SWEEP_MAX_QUERIES=6 \
  npx tsx src/homeserver/cli.ts gpu run --model research-sweep --eta 120m --purpose research-sweep -- \
    npx tsx scripts/weekly-research-sweep.ts >>"$LOG" 2>&1

# Publish proposals to Heimdall (plain HTTP). Best-effort.
npx tsx scripts/post-research-sweep-panel.ts >>"$LOG" 2>&1 || true

# Surface the full write-up on Heimdall /read via the mimir inbox sync chain.
# (frontmatter-free, lowercase-kebab filename — required by Heimdall read-docs.js)
DATED=$(ls -1t data/research-sweep/m5-research-sweep-*.md 2>/dev/null | head -1)
if [ -n "${DATED:-}" ]; then
  rsync -a "$DATED" "$MIMIR_INBOX_HOST:$MIMIR_INBOX_DIR/reading/$(basename "$DATED")" || true
fi
```

> Set `MIMIR_INBOX_HOST` / `MIMIR_INBOX_DIR` in `~/.heimdall-push.env` to the mimir inbox sync
> target (the same chain research-spike uses: inbox → mimir daemon → `~/mimir/reading/` → Heimdall
> `/read`). Confirm the exact host/path against the live mimir deployment before enabling the rsync
> line — the Heimdall **panel** is the guaranteed surface; the /read sync is best-effort depth.

## Cron (on the box)

```cron
# Weekly research sweep — Sundays 06:00 UTC (after the 04:00 model scout; both off-peak)
0 6 * * 0 /home/inference/weekly-research-sweep.sh
```

## Smoke test

```bash
ssh m5 'cd /srv/gille-inference && npx tsx scripts/weekly-research-sweep.ts --dry-run'   # prints the query set
ssh m5 'cd /srv/gille-inference && npx tsx scripts/post-research-sweep-panel.ts --dry-run --in data/research-sweep/proposals.json'
```

The query set is bilingual and **rotates by ISO week** (`RESEARCH_SWEEP_MAX_QUERIES` per run) so all
themes get covered over a few weeks rather than every theme every week.
