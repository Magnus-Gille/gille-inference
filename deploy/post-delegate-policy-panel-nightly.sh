#!/usr/bin/env bash
#
# post-delegate-policy-panel-nightly.sh — nightly delegate-policy shadow dashboard push.
#
# Reads the content-blind delegation_costs table (read-only SQLite) and pushes three Heimdall
# panels on service m5-inference: shadow readiness status, dataset-growth timeseries, and a
# by-lane table. This is the standing view for "is the delegate-policy evidence growing, and
# what would enforce do?"
#
# NO GPU LEASE: this is a SQLite read + HTTP calls. It does not load a model or contend with
# gateway traffic.
#
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/local/bin
REPO=/srv/gille-inference
SCRIPT="$REPO/scripts/post-delegate-policy-panel.ts"
LOG="/home/inference/logs/delegate-policy-panel-$(date -u +%F).log"
DAYS="${DELEGATE_POLICY_PANEL_DAYS:-30}"

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
    echo "[delegate-policy-panel] ~/.heimdall-push.env missing — skipping Heimdall push"
  fi
  echo
} >> "$LOG" 2>&1
