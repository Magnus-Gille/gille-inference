#!/bin/bash
# Overnight orchestrator (v2): finish the Mellum2-12B-A2.5B-Instruct pipeline.
#
# Prereq: `lms get https://huggingface.co/JetBrains/Mellum2-12B-A2.5B-Instruct-GGUF-Q8_0`
# is running/queued in LM Studio's downloader. (The raw `hf download` copy could
# not be registered — LM Studio only indexes models with known provenance, and
# `lms import` hangs in this build. `lms get` is the proven registration path.)
#
# This script: waits for registration -> loads with a fixed API id -> runs the
# full 63-task batch via --provider lmstudio -> Opus-judges it. Idempotent /
# resumable; logs to data/overnight-mellum-instruct/run.log; emits ==== DONE /
# ==== FAIL markers.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${GILLE_INFERENCE_ROOT:-$(cd "${SCRIPT_DIR}/.." && pwd)}"
cd "$REPO" || exit 99
OUTDIR="$REPO/data/overnight-mellum-instruct"
mkdir -p "$OUTDIR"
LOG="$OUTDIR/run.log"

ID="mellum2-12b-a2.5b-instruct"          # forced API id (matches model registry)
BATCH="mellum2-instruct-local"

log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG"; }
fail(){ log "ERROR: $*"; log "==== FAIL"; exit 1; }

log "=================================================================="
log "overnight-mellum-instruct v2 starting (batch=$BATCH)"

# ---- PHASE 1: wait for `lms get` to download + register the model -----------
# Registration is complete when `lms ls` lists a Mellum2 Instruct entry. Cap 3h.
log "=== PHASE 1: waiting for lms get to register the Instruct model ==="
LOADKEY=""
waited=0
while true; do
  line=$(lms ls 2>/dev/null | grep -iE "instruct" | grep -i mellum | head -1)
  if [ -n "$line" ]; then
    LOADKEY=$(echo "$line" | awk '{print $1}')
    log "registered: $line"
    log "load key resolved to: $LOADKEY"
    break
  fi
  if [ "$waited" -ge 10800 ]; then fail "model not registered within 3h"; fi
  sleep 60
  waited=$((waited+60))
done
[ -n "$LOADKEY" ] || fail "could not resolve load key from lms ls"

# ---- PHASE 2: load with a deterministic API id ------------------------------
log "=== PHASE 2: loading $LOADKEY as api-id=$ID ==="
lms server start >>"$LOG" 2>&1 || true
lms unload "$ID" >>"$LOG" 2>&1 || true
lms load "$LOADKEY" --identifier "$ID" -c 32768 --gpu max -y >>"$LOG" 2>&1 \
  || fail "lms load failed for $LOADKEY"

# ---- PHASE 3: verify the API id is serving ----------------------------------
log "=== PHASE 3: verifying $ID is serving on :1234 ==="
ok=0
attempt=1
while [ "$attempt" -le 24 ]; do
  if curl -s --max-time 5 http://localhost:1234/v1/models 2>/dev/null | grep -q "\"$ID\""; then ok=1; break; fi
  sleep 5
  attempt=$((attempt + 1))
done
[ "$ok" = 1 ] || fail "$ID not serving after load"
log "model $ID confirmed serving"

# ---- PHASE 4: run the full 63-task batch ------------------------------------
log "=== PHASE 4: running 63-task batch ($BATCH) via lmstudio ==="
npx tsx src/runner/index.ts --batch "$BATCH" --provider lmstudio \
  --models "$ID" --tasks all >>"$LOG" 2>&1 \
  || fail "runner exited non-zero (batch may be partial; resumable)"
log "batch run finished"

# ---- PHASE 5: Opus judge -----------------------------------------------------
log "=== PHASE 5: Opus-judging $BATCH ==="
npx tsx src/judge/index.ts --batch "$BATCH" --judge opus >>"$LOG" 2>&1 \
  || fail "opus judge exited non-zero (resumable)"
log "opus judge finished"

# ---- summary ----------------------------------------------------------------
log "=== run/judge counts ==="
EVAL_DB_PATH="$REPO/data/eval.db" sqlite3 "$REPO/data/eval.db" \
  "SELECT 'completed', COUNT(*) FROM runs WHERE batch_id='$BATCH' AND status='completed'
   UNION ALL SELECT 'failed', COUNT(*) FROM runs WHERE batch_id='$BATCH' AND status='failed'
   UNION ALL SELECT 'opus_judged', COUNT(DISTINCT r.id) FROM runs r
     JOIN judge_records j ON j.run_id=r.id
     WHERE r.batch_id='$BATCH' AND j.judge_model='anthropic/claude-opus-4-5';" 2>>"$LOG" | tee -a "$LOG"

log "==== DONE"
