#!/usr/bin/env bash
#
# post-delegation-savings-panel-nightly.sh — nightly verified delegation-savings panel push.
#
# Reads the content-blind delegation_costs table (read-only SQLite) and pushes two Heimdall
# panels on service m5-inference: verified savings/day and a by-task status rollup. This is
# the standing dashboard view for "how much did the M5 save, after verification?".
#
# NO GPU LEASE: this is a SQLite read + HTTP calls. It does not load a model or contend with
# gateway traffic, so it should run after the normal request/utilization posters without using
# `homeserver gpu run`.
#
# The poster does POST /api/panels and then an authenticated read-back GET /api/panels?service=
# through src/homeserver/heimdall-push.ts. A stale/missing read-back exits non-zero; this wrapper
# keeps cron best-effort and leaves the signal in the log.
#
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/local/bin
REPO=/srv/gille-inference
SCRIPT="$REPO/scripts/post-delegation-savings-panel.ts"
LOG="/home/inference/logs/delegation-savings-panel-$(date -u +%F).log"
DAYS="${DELEGATION_SAVINGS_DAYS:-30}"

mkdir -p "$(dirname "$LOG")"

# No-op before the code is deployed; never fail cron on a target that does not exist yet.
if [ ! -f "$SCRIPT" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $SCRIPT not present yet — skipping (not deployed)" >> "$LOG"
  exit 0
fi

cd "$REPO" || exit 1
{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) days=$DAYS ====="
  if [ -f "$HOME/.heimdall-push.env" ]; then
    set -a; . "$HOME/.heimdall-push.env"; set +a
    npx tsx "$SCRIPT" --days "$DAYS" 2>&1 | grep -vE "punycode|trace-deprecation" || true
  else
    echo "[delegation-savings-panel] ~/.heimdall-push.env missing — skipping Heimdall push"
  fi
  echo
} >> "$LOG" 2>&1
