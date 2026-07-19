#!/usr/bin/env bash
# Gate D sweep — run ARMS × TASKS × SEEDS through run.sh, sequentially. Resumable + corruption-safe.
#
# Usage (same env as run.sh — GW/GW_KEY required; the box 401s on a dummy key):
#   export GW=https://inference.example.com/v1 GW_KEY=<real-key> MODEL=qwen3-coder-next-80b
#   ARMS="aider pi" SEEDS=1 CAP_S=360 bash gate-d/sweep.sh
#
# Knobs: ARMS (default "aider pi"), SEEDS (default 1), CAP_S (per-run wall cap, default 600),
# GATE_D_OUT (default data/gate-d-results.jsonl).
# Holdouts are excluded by default; set GATE_D_INCLUDE_HOLDOUT=1 explicitly to select r2.
#
# RESUMABLE: counts existing rows per (arm,model,task) in the output JSONL and runs only the
# shortfall — safe to re-launch after an interruption; already-done triples are skipped.
#
# SEQUENTIAL, NEVER PARALLEL: the box GPU is serial (admission maxParallel=1); concurrent arms
# would contend and 503. NEVER kill a run mid-stream — see CORRUPTION SAFETY below.
#
# CORRUPTION SAFETY: an abrupt mid-stream disconnect (a gtimeout-kill at CAP_S, or a manual kill)
# can put this box's qwen3-coder-next-80b into a persistent degenerate "?????" state that poisons
# every later request (documented in docs/gate-d-execution-findings-2026-06-24.md). Clean
# completions do NOT corrupt it. So after any run that ends in `arm-error` (the timeout/kill class),
# this script resets the model — a `mellum` request swaps the 80b out, then a fresh request warms
# it — guaranteeing the next task starts on a clean model and bounding any window where a live user
# could hit the degenerate model.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
cd "$REPO_ROOT" || exit 3
CORPUS_TOOL="$ROOT/gate_d_corpus.py"
if [ "${1:-}" = "--list-tasks" ]; then python3 "$CORPUS_TOOL" tasks; exit $?; fi
CORPUS_REVISION="$(python3 "$CORPUS_TOOL" revision)" || exit 3
TASKS="$(python3 "$CORPUS_TOOL" tasks)" || exit 3
: "${GW:=https://inference.example.com/v1}"
: "${GW_KEY:?set GW_KEY to a real gateway token (mint via bin/invite)}"
: "${MODEL:=qwen3-coder-next-80b}"
export GW GW_KEY MODEL
ARMS="${ARMS:-aider pi}"
SEEDS="${SEEDS:-1}"
export CAP_S="${CAP_S:-600}"
OUT="${GATE_D_OUT:-$REPO_ROOT/data/gate-d-results.jsonl}"; mkdir -p "$(dirname "$OUT")"
export GATE_D_OUT="$OUT"
LOG="${GATE_D_LOG:-$REPO_ROOT/data/gate-d-sweep.log}"

count_rows() {
  [ -f "$OUT" ] || { echo 0; return; }
  GD_A="$1" GD_M="$2" GD_T="$3" GD_R="$CORPUS_REVISION" GD_OUT="$OUT" python3 -c "import json,os
a=os.environ['GD_A'];m=os.environ['GD_M'];t=os.environ['GD_T'];rev=os.environ['GD_R'];n=0
for l in open(os.environ['GD_OUT']):
    try: r=json.loads(l)
    except: continue
    rowrev=r.get('corpusRevision','gate-d-r1')
    if rowrev==rev and r.get('arm')==a and r.get('model')==m and r.get('task')==t: n+=1
print(n)"
}
last_exit() { [ -f "$OUT" ] && tail -1 "$OUT" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('exitClass',''))
except: print('')" 2>/dev/null || echo ""; }
reset_model() {
  echo "    [reset] swap out + warm fresh 80b ($(date +%T))" | tee -a "$LOG"
  curl -s -m 60  -H "Authorization: Bearer $GW_KEY" -H "Content-Type: application/json" "$GW/chat/completions" \
    -d '{"model":"mellum","messages":[{"role":"user","content":"hi"}],"max_tokens":3}' >/dev/null 2>&1 || true
  curl -s -m 120 -H "Authorization: Bearer $GW_KEY" -H "Content-Type: application/json" "$GW/chat/completions" \
    -d '{"model":"'"$MODEL"'","messages":[{"role":"user","content":"reply ok"}],"max_tokens":5}' >/dev/null 2>&1 || true
}

echo "=== SWEEP start $(date) | corpus=$CORPUS_REVISION arms=[$ARMS] seeds=$SEEDS cap=${CAP_S}s model=$MODEL ===" | tee -a "$LOG"
for arm in $ARMS; do
  for t in $TASKS; do
    have=$(count_rows "$arm" "$MODEL" "$t"); need=$(( SEEDS - have ))
    if [ "$need" -le 0 ]; then echo "[skip] $arm/$MODEL/$t (have $have ≥ $SEEDS)" | tee -a "$LOG"; continue; fi
    for i in $(seq 1 "$need"); do
      echo "[run ] $arm/$MODEL/$t (seed $((have+i))/$SEEDS) $(date +%T)" | tee -a "$LOG"
      bash "$ROOT/run.sh" "$arm" "$t" 2>&1 | tee -a "$LOG"
      [ "$(last_exit)" = "arm-error" ] && reset_model
    done
  done
done
echo "=== SWEEP done $(date) ===" | tee -a "$LOG"
GD_R="$CORPUS_REVISION" GD_TASKS="$TASKS" GD_OUT="$OUT" python3 -c "import json,collections,os
rev=os.environ['GD_R']; allowed=set(os.environ['GD_TASKS'].split())
c=collections.Counter(); p=collections.Counter()
for l in open(os.environ['GD_OUT']):
    try: r=json.loads(l)
    except: continue
    if r.get('corpusRevision','gate-d-r1') != rev or r.get('task') not in allowed: continue
    k=(r.get('arm'),r.get('model'))
    c[k]+=1; p[k]+= 1 if r.get('pass') else 0
for arm,model in sorted(c): print(f'{rev} {arm}/{model}: {p[(arm,model)]}/{c[(arm,model)]} pass')" | tee -a "$LOG"
