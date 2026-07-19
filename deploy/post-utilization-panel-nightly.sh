#!/usr/bin/env bash
#
# post-utilization-panel-nightly.sh — nightly M5 box-utilization panel push (Heimdall).
#
# Reads the content-blind request_log (read-only SQLite) and pushes two panels — requests/day
# timeseries + a 7-day per-model rollup table — to Heimdall on service m5-inference, so organic
# ask/MCP adoption is a standing dashboard trend instead of something you have to go dig a log
# file for. See scripts/post-utilization-panel.ts for the aggregation + envelope logic.
#
# NO GPU LEASE: this is a plain SQLite read + HTTP calls — no model load/swap, so unlike
# gate-chat-replay-nightly.sh (docs/nightly-offloadability-runbook.md) it does not need
# `homeserver gpu run` sequencing.
#
# Per push, the poster now does POST /api/panels THEN an authenticated read-back
# GET /api/panels?service=m5-inference to prove the panel is actually stored/visible — a POST 200
# alone only means "accepted" (heimdall#102: panels landed in an invisible drawer while every POST
# returned 200). A lost/stale panel logs `READ-BACK FAILED …` and makes the poster exit non-zero;
# this wrapper still swallows that exit (best-effort — a Heimdall outage must not fail the cron),
# so the signal lives in the log, not the cron exit status.
#
# This file is TRACKED in the repo (deploy/) but is NOT part of the rsync deploy tree that syncs
# INTO /srv/gille-inference (see CLAUDE.md's rsync --exclude list) — copy it to the box
# once as a cron target, e.g.:
#   scp deploy/post-utilization-panel-nightly.sh m5:/home/inference/post-utilization-panel-nightly.sh
#   ssh m5 chmod +x /home/inference/post-utilization-panel-nightly.sh
# Re-copy it whenever this file changes here — same discipline as gate-chat-replay-nightly.sh and
# deploy/llama-swap-config.yaml: the tracked copy is the record, drift should never be silent.
#
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/local/bin
REPO=/srv/gille-inference
SCRIPT="$REPO/scripts/post-utilization-panel.ts"
LOG="/home/inference/logs/utilization-panel-$(date -u +%F).log"

mkdir -p "$(dirname "$LOG")"

# No-op before this change is deployed (the rsync in CLAUDE.md's "Deploying to the live M5"
# section) — never fail cron on a target that doesn't exist yet.
if [ ! -f "$SCRIPT" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $SCRIPT not present yet — skipping (not deployed)" >> "$LOG"
  exit 0
fi

cd "$REPO" || exit 1
{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  if [ -f "$HOME/.heimdall-push.env" ]; then
    set -a; . "$HOME/.heimdall-push.env"; set +a
    npx tsx "$SCRIPT" 2>&1 | grep -vE "punycode|trace-deprecation" || true
  else
    echo "[utilization-panel] ~/.heimdall-push.env missing — skipping Heimdall push"
  fi
  echo
} >> "$LOG" 2>&1
