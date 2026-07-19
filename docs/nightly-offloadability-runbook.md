# Nightly offloadability gate — runbook (Job C)

The third box-side self-improvement cron job (alongside Job A / Model Scout and Job B /
Research Sweep — see `docs/weekly-model-scout-runbook.md`), and the oldest one — live since
2026-06-26 — but the only one that was never given its own runbook or a CLAUDE.md mention as
"scheduled infra." This closes that gap; no code or cron behavior changes.

Every night, replays a sample of real owner chat/ask traffic through the disagreement gate's
secondary model (OFFLINE, read-only on the DB — no ledger writes, no live routing change) to
measure how often the gate WOULD have fired, i.e. how much of real usage looks safely
offloadable. Pushes the trend to Heimdall.

## Pieces (in this repo)

- `scripts/gate-chat-replay.ts` — the replay itself. Samples rows from `owner_request_log`,
  re-runs each prompt through the configured secondary model (`qwen3-30b-instruct` in
  production), scores disagreement vs. the response that was ACTUALLY served, and reports a
  fire-rate. `--n 60 --recent 24h` (production flags) scopes to the last day's traffic;
  `--trend-jsonl <path>` appends one structured record per run to a trend spine instead of just
  printing a one-off summary.
- `scripts/post-offloadability-panel.ts` — reads the trend spine and POSTs a Heimdall
  timeseries + by-model detail-table panel (`POST /api/panels`, Bearer `HEIMDALL_FLEET_TOKEN`,
  best-effort — a failure here never blocks or invalidates the replay itself). After the POST it
  does an authenticated **read-back** (`GET /api/panels?service=m5-inference`) to confirm the panel
  is actually stored/visible — a POST 200 alone only means "accepted" (heimdall#102: panels landed
  in an invisible drawer while every POST returned 200). A lost/stale panel logs `READ-BACK FAILED`
  and exits the poster non-zero; the wrapper still swallows that (best-effort), so the signal is in
  the log, not the cron exit status.

## Box prerequisites (one-time)

- `~/.heimdall-push.env` (mode 600) exporting `HEIMDALL_PANELS_URL` + `HEIMDALL_FLEET_TOKEN`
  (same file Job A/B use).
- A real owner-tier API key already exists in the live keystore for the replay to have
  `owner_request_log` rows to sample from — this is just live traffic, no separate provisioning.

## On-box wrapper — `~/gate-chat-replay-nightly.sh`

Verbatim from the box (2026-07-01) — this file lives directly in `/home/inference/`, NOT inside
`/srv/gille-inference/`, so it is genuinely not part of the repo's rsync deploy tree;
this doc + the block below is its tracked record. If it ever changes on the box, re-copy it
here so drift stays visible instead of silent — same discipline as
`deploy/llama-swap-config.yaml` for the llama-swap config.

```bash
#!/usr/bin/env bash
#
# Nightly offloadability trend over REAL chat/ask traffic, via gate-chat-replay (PR #96),
# wrapped in the GPU lease (#88) so the secondary-model run cannot thrash a live owner session.
# READ-ONLY on the DB, no frontier spend. Ops glue (not in git); rationale in
# docs/cascade-gate-experiment-design.md and ~/.claude/CLAUDE.md.
#
# After the replay, pushes the trend to Heimdall as a typed panel (gille-inference #102):
#   gate-chat-replay --trend-jsonl  appends a structured record per run;
#   post-offloadability-panel       POSTs the series to Heimdall /api/panels (best-effort).
# The push is plain HTTP (no GPU) and runs OUTSIDE the lease; a failure never blocks the replay.
#
# Each run appends a dated summary to data/gate-chat-replay-trend.log; track with:
#   grep -E "=====|fire-rate" /srv/gille-inference/data/gate-chat-replay-trend.log
#
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/local/bin
REPO=/srv/gille-inference
LOG="$REPO/data/gate-chat-replay-trend.log"
TREND="$REPO/data/gate-chat-replay-trend.jsonl"
cd "$REPO" || exit 1
{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  npx tsx src/homeserver/cli.ts gpu run --model gate-chat-replay --eta 30m --purpose gate-chat-replay-nightly \
    -- npx tsx scripts/gate-chat-replay.ts --n 60 --recent 24h --trend-jsonl "$TREND" 2>&1 | grep -vE "punycode|trace-deprecation"
  if [ -f "$HOME/.heimdall-push.env" ]; then
    set -a; . "$HOME/.heimdall-push.env"; set +a
    npx tsx scripts/post-offloadability-panel.ts --trend-jsonl "$TREND" 2>&1 | grep -vE "punycode|trace-deprecation" || true
  else
    echo "[post-panel] ~/.heimdall-push.env missing — skipping Heimdall push"
  fi
  echo
} >> "$LOG" 2>&1
```

`chmod +x ~/gate-chat-replay-nightly.sh`.

## Cron (on the box)

Off-peak, ahead of the two weekly jobs (which run Sundays only):

```cron
# Nightly offloadability trend — every night, 03:00 UTC (≈04:00-05:00 CEST)
0 3 * * * /home/inference/gate-chat-replay-nightly.sh
```

## First-run / smoke test

```bash
# From the deploy dir on the box — dry, no GPU lease, no Heimdall push, prints to stdout:
cd /srv/gille-inference && npx tsx scripts/gate-chat-replay.ts --n 10 --recent 24h
# Panels dry-run (prints the Heimdall envelope without POSTing):
npx tsx scripts/post-offloadability-panel.ts --trend-jsonl data/gate-chat-replay-trend.jsonl --dry-run
```

Track results without re-running anything: `grep -E "=====|fire-rate" data/gate-chat-replay-trend.log`.

## Safety notes

- **Read-only, no ledger writes, no routing change.** This replays SAVED responses from
  `owner_request_log` through a second model purely for scoring — it never re-serves the
  original prompt live, never touches `delegations`, and cannot affect what any real request
  gets served.
- **GPU-lease wrapped** (`gpu run --model gate-chat-replay --eta 30m`) so the secondary-model
  load/run sequences against other heavy jobs instead of thrashing the serial GPU mid-run.
- **Heimdall push is best-effort and OUTSIDE the lease** — plain HTTP, no GPU touch, and a
  failure (missing `~/.heimdall-push.env`, network hiccup) is logged and swallowed, never blocks
  or invalidates the replay's own log entry.
- **`--recent 24h` windowing** means each night's run only samples the last day of traffic —
  the trend accumulates a real day-over-day fire-rate series, not an all-time blend that would
  dilute a recent regression or improvement.
