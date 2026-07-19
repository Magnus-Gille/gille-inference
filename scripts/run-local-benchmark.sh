#!/usr/bin/env bash
# Run a local overnight benchmark with correct Ollama settings.
# Usage: bash scripts/run-local-benchmark.sh [--batch <id>] [--models <list>] [--tasks <list>]
#
# Defaults to: batch=laptop-overnight-v2, all 3 non-thinking models, all tasks.
#
# What this script does:
#   1. Sets Ollama benchmarking env vars (single model, no parallelism, pinned memory)
#   2. Restarts Ollama with those settings
#   3. Runs the batch runner with preflight checks
#
# Models in default run:
#   - gemma4:e2b      (Gemma4 2B effective — fast, fits easily in 32GB)
#   - gemma4:26b      (Gemma4 26B MoE, 4B active — quality/speed balance)
#   - glm4:flash      (GLM-4.7-Flash 30B MoE, ~3B active)
#
# All three avoid thinking mode — no Qwen3 or DeepSeek-R1 in this batch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ─── Defaults (override via args) ────────────────────────────────────────────

BATCH_ID="laptop-overnight-v2"
MODELS="google/gemma-4-e2b,google/gemma-4-26b-a4b,z-ai/glm-4.7-flash"
MODEL_MAP="google/gemma-4-e2b=gemma4:e2b,google/gemma-4-26b-a4b=gemma4:26b,z-ai/glm-4.7-flash=glm4:flash"
TASKS="all"

# ─── Parse args ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --batch)   BATCH_ID="$2"; shift 2 ;;
    --models)  MODELS="$2";   shift 2 ;;
    --tasks)   TASKS="$2";    shift 2 ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--batch <id>] [--models <list>] [--tasks <list>]"
      exit 1
      ;;
  esac
done

# ─── Configure Ollama for benchmarking ───────────────────────────────────────
# These settings prevent multiple models from being loaded simultaneously,
# disable parallel request handling, and pin loaded models in memory.

export OLLAMA_MAX_LOADED_MODELS=1   # only one model in GPU memory at a time
export OLLAMA_NUM_PARALLEL=1        # no concurrent requests
export OLLAMA_KEEP_ALIVE=-1         # keep model pinned until explicitly unloaded
export OLLAMA_LOAD_TIMEOUT=600      # 10-min load timeout for large models from SSD

# ─── Restart Ollama with benchmark config ────────────────────────────────────

echo "Stopping any running Ollama instance..."
pkill ollama 2>/dev/null || true
sleep 2

echo "Starting Ollama with benchmark config..."
ollama serve > /tmp/ollama-benchmark.log 2>&1 &
OLLAMA_PID=$!

# Wait for Ollama to be ready
for i in {1..10}; do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "Ollama is up (PID ${OLLAMA_PID})."
    break
  fi
  if [[ $i -eq 10 ]]; then
    echo "ERROR: Ollama failed to start within 10 seconds."
    echo "Check /tmp/ollama-benchmark.log for details."
    exit 1
  fi
  sleep 1
done

# ─── Run the benchmark ────────────────────────────────────────────────────────

cd "${REPO_DIR}"

echo ""
echo "Starting benchmark: batch=${BATCH_ID}"
echo "  Models:  ${MODELS}"
echo "  Tasks:   ${TASKS}"
echo "  Log:     /tmp/ollama-benchmark.log"
echo ""

npx tsx src/runner/index.ts \
  --batch "${BATCH_ID}" \
  --provider local \
  --models "${MODELS}" \
  --model-map "${MODEL_MAP}" \
  --tasks "${TASKS}" \
  --concurrency 1 \
  --resume

echo ""
echo "Benchmark complete. Results in data/eval.db"
echo ""
echo "Quick check:"
echo "  sqlite3 data/eval.db \"SELECT model_id, COUNT(*) as runs, AVG(ttft_ms) as avg_ttft_ms, AVG(tokens_per_second) as avg_tok_s FROM runs WHERE batch_id='${BATCH_ID}' AND status='completed' GROUP BY model_id\""
