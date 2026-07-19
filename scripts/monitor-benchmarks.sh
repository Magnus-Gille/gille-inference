#!/usr/bin/env bash
# Monitor benchmark progress every 15 minutes. Restart stalled jobs.
# Usage: nohup bash scripts/monitor-benchmarks.sh &
# Logs to /tmp/benchmark-monitor.log

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${GILLE_INFERENCE_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
DB="$REPO/data/eval.db"
LOG="/tmp/benchmark-monitor.log"
CHECK_INTERVAL=900  # 15 minutes

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

check_and_restart() {
  log "=== Periodic check ==="

  # ─── 1. Check cloud-new-models runner ────────────────────────────────────
  CLOUD_PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM runs WHERE batch_id='cloud-new-models' AND model_id='qwen/qwen3.5-35b-a3b' AND status='pending'")
  log "cloud-new-models pending: $CLOUD_PENDING"

  if [[ "$CLOUD_PENDING" -gt 0 ]]; then
    # Check if runner is alive
    if ! pgrep -f "batch cloud-new-models" > /dev/null 2>&1; then
      log "Runner for cloud-new-models is dead. Restarting..."
      cd "$REPO" || return 1
      npx tsx src/runner/index.ts --batch cloud-new-models --models "qwen/qwen3.5-35b-a3b" --tasks all --resume >> /tmp/cloud-new-models-runner.log 2>&1 &
      log "Restarted cloud-new-models runner (PID $!)"
    else
      log "cloud-new-models runner is alive"
    fi
  else
    log "cloud-new-models: all done"
  fi

  # ─── 2. Check laptop-overnight-v2 local runner ──────────────────────────
  LOCAL_PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM runs WHERE batch_id='laptop-overnight-v2' AND model_id='google/gemma-4-26b-a4b-it' AND status='pending'")
  log "laptop-overnight-v2 gemma4-26b pending: $LOCAL_PENDING"

  if [[ "$LOCAL_PENDING" -gt 0 ]]; then
    if ! pgrep -f "batch laptop-overnight-v2" > /dev/null 2>&1; then
      log "Runner for laptop-overnight-v2 is dead. Restarting..."
      cd "$REPO" || return 1
      npx tsx src/runner/index.ts --batch laptop-overnight-v2 --provider local --models "google/gemma-4-26b-a4b-it" --model-map "google/gemma-4-26b-a4b-it=gemma4:26b" --tasks all --resume --skip-preflight --concurrency 1 >> /tmp/laptop-overnight-v2-runner.log 2>&1 &
      log "Restarted laptop-overnight-v2 runner (PID $!)"
    else
      log "laptop-overnight-v2 runner is alive"
    fi
  else
    log "laptop-overnight-v2: all done"
  fi

  # ─── 3. Check for unjudged completed runs ────────────────────────────────
  for BATCH in laptop-overnight-v2 m4air-mlx-on cloud-new-models cloud-qwen35; do
    UNJUDGED=$(sqlite3 "$DB" "
      SELECT COUNT(*)
      FROM runs r
      LEFT JOIN judge_records j ON j.run_id = r.id
      WHERE r.batch_id='$BATCH' AND r.status='completed' AND j.id IS NULL
    ")
    if [[ "$UNJUDGED" -gt 0 ]]; then
      # Check if a judge is already running for this batch
      if ! pgrep -f "judge.*--batch $BATCH" > /dev/null 2>&1; then
        log "$BATCH: $UNJUDGED unjudged runs. Starting judge..."
        cd "$REPO" || return 1
        npx tsx src/judge/index.ts --batch "$BATCH" --judge both >> "/tmp/judge-$BATCH.log" 2>&1 &
        log "Started judge for $BATCH (PID $!)"
      else
        log "$BATCH: $UNJUDGED unjudged, judge already running"
      fi
    else
      log "$BATCH: fully judged"
    fi
  done

  # ─── 4. Summary ──────────────────────────────────────────────────────────
  TOTAL_PENDING=$(sqlite3 "$DB" "SELECT COUNT(*) FROM runs WHERE status='pending' AND batch_id IN ('cloud-new-models','laptop-overnight-v2')")
  TOTAL_UNJUDGED=$(sqlite3 "$DB" "
    SELECT COUNT(DISTINCT r.id)
    FROM runs r
    LEFT JOIN judge_records j ON j.run_id = r.id
    WHERE r.status='completed' AND j.id IS NULL
    AND r.batch_id IN ('laptop-overnight-v2','m4air-mlx-on','cloud-new-models','cloud-qwen35')
  ")
  log "Summary: $TOTAL_PENDING pending runs, $TOTAL_UNJUDGED unjudged runs"

  if [[ "$TOTAL_PENDING" -eq 0 && "$TOTAL_UNJUDGED" -eq 0 ]]; then
    log "ALL DONE. Nothing left to run or judge. Monitor exiting."
    exit 0
  fi
}

# ─── Main loop ─────────────────────────────────────────────────────────────────

log "Monitor started. Checking every ${CHECK_INTERVAL}s."
check_and_restart  # run immediately on start

while true; do
  sleep "$CHECK_INTERVAL"
  check_and_restart
done
