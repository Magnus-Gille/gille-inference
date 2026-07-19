#!/usr/bin/env bash
# Reproduce the pinned Achilles / GLM-5.2 M5 baseline and cache sweep.
#
# This is an original orchestration harness. It does not contain Achilles source or model weights.
# See docs/achilles-glm52-m5-reproduction.md for prerequisites and interpretation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ACHILLES_BIN="${ACHILLES_BIN:-/opt/achilles/bin/achilles-arena}"
GLM52_DIR="${GLM52_DIR:-/srv/models/glm52-achilles/UD-Q2_K_XL}"
LLAMA_SWAP_ORIGIN="${LLAMA_SWAP_ORIGIN:-http://127.0.0.1:8091}"
ACHILLES_PROBE_PATH="${ACHILLES_PROBE_PATH:-/opt/achilles/models/glm52-probes-d3.bin}"
MANIFEST="${REPO_DIR}/docs/achilles-glm52-ud-q2-k-xl.sha256"
MODEL="${GLM52_DIR}/GLM-5.2-UD-Q2_K_XL-00001-of-00007.gguf"
LOG_DIR="${REPO_DIR}/data/achilles-glm52"

MODE="${1:-}"
if [[ -n "${MODE}" ]]; then
  shift
fi

BUDGET_GIB=20
BUDGETS="20,60,90"
ACK_LIVE_TRAFFIC=0
DRY_RUN=0

# The expert arena is not the whole host-memory cost. The Vulkan dense skeleton, TTM/GTT
# allocations, page tables, llama/ggml workspace, and production services need substantial memory
# outside the nominal expert budget. A 100 GiB arena on the 122 GiB Linux-visible M5 reached a
# host-level OOM at ~99 GiB arena RSS despite MemoryMax=116G. Keep an empirical 28 GiB host reserve:
# it admits the measured-safe 90 GiB point and rejects that unsafe 100 GiB point before launch.
HOST_HEADROOM_GIB=28

# The base path uses model-router weights for gate-ahead plan hints. The separate
# probe-baseline mode loads the trained delta-3 linear predictor through --probe.
# Both paths feed plan_hint into the same plan-aware LRU evictor.
EVICTION_POLICY=lru

usage() {
  cat <<'EOF'
Usage:
  scripts/achilles-glm52-m5.sh verify
  scripts/achilles-glm52-m5.sh baseline [--budget-gib N] [--ack-live-traffic-risk] [--dry-run]
  scripts/achilles-glm52-m5.sh probe-baseline [--budget-gib N] [--ack-live-traffic-risk] [--dry-run]
  scripts/achilles-glm52-m5.sh quality  [--budget-gib N] [--ack-live-traffic-risk] [--dry-run]
  scripts/achilles-glm52-m5.sh sweep    [--budgets A,B,...] [--ack-live-traffic-risk] [--dry-run]

Environment:
  ACHILLES_BIN       Native achilles-arena binary
  ACHILLES_PROBE_PATH Trained delta-3 probe blob used by probe-baseline
  GLM52_DIR          Directory containing all seven pinned GGUF shards
  LLAMA_SWAP_ORIGIN  llama-swap loopback origin (default http://127.0.0.1:8091)

The acknowledgement is required when home-gateway.service is active because ordinary gateway
traffic does not acquire the heavy-job GPU lease and can contaminate a measurement.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

require_positive_integer() {
  local value="$1"
  local label="$2"
  [[ "${value}" =~ ^[1-9][0-9]*$ ]] || die "${label} must be a positive integer, got '${value}'"
}

if [[ "${MODE}" != "__inner" ]]; then
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --budget-gib)
        [[ $# -ge 2 ]] || die "--budget-gib requires a value"
        BUDGET_GIB="$2"
        shift 2
        ;;
      --budgets)
        [[ $# -ge 2 ]] || die "--budgets requires a comma-separated value"
        BUDGETS="$2"
        shift 2
        ;;
      --ack-live-traffic-risk)
        ACK_LIVE_TRAFFIC=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown argument: $1"
        ;;
    esac
  done
fi

case "${MODE}" in
  verify|baseline|probe-baseline|quality|sweep) ;;
  -h|--help|"")
    usage
    exit 0
    ;;
  __inner) ;;
  *) die "unknown mode: ${MODE}" ;;
esac

verify_shards() {
  [[ -d "${GLM52_DIR}" ]] || die "model directory not found: ${GLM52_DIR}"
  command -v sha256sum >/dev/null || die "sha256sum is required"
  if find "${GLM52_DIR}" -maxdepth 1 -name '*.aria2' -print -quit | grep -q .; then
    die "partial .aria2 downloads remain in ${GLM52_DIR}"
  fi
  echo "Verifying pinned GLM-5.2 shards (this reads about 237 GiB)..."
  (
    cd "${GLM52_DIR}"
    sha256sum -c "${MANIFEST}"
  )
}

host_memory_gib() {
  awk '/^MemTotal:/ { printf "%d\n", $2 / 1024 / 1024 }' /proc/meminfo
}

ttm_limit_gib() {
  local pages_file=/sys/module/ttm/parameters/pages_limit
  if [[ ! -r "${pages_file}" ]]; then
    echo 0
    return
  fi
  local page_size
  page_size="$(getconf PAGESIZE)"
  awk -v page_size="${page_size}" '{ printf "%d\n", $1 * page_size / 1024 / 1024 / 1024 }' "${pages_file}"
}

running_is_empty() {
  grep -Eq '"running"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' <<< "$1"
}

preflight_run() {
  local budget="$1"
  local run_mode="$2"
  require_positive_integer "${budget}" "budget"

  [[ "$(uname -s)" == "Linux" ]] || die "inference runs require Linux"
  [[ -x "${ACHILLES_BIN}" ]] || die "Achilles binary is not executable: ${ACHILLES_BIN}"
  [[ -f "${MODEL}" ]] || die "first model shard not found: ${MODEL}"
  if [[ "${run_mode}" == "probe-baseline" ]]; then
    [[ -s "${ACHILLES_PROBE_PATH}" ]] || die "trained probe not found: ${ACHILLES_PROBE_PATH}"
  fi
  if find "${GLM52_DIR}" -maxdepth 1 -name '*.aria2' -print -quit | grep -q .; then
    die "partial .aria2 downloads remain in ${GLM52_DIR}"
  fi
  command -v systemd-run >/dev/null || die "systemd-run is required"
  command -v timeout >/dev/null || die "timeout is required"
  command -v curl >/dev/null || die "curl is required"
  command -v npx >/dev/null || die "npx is required"
  case "${LLAMA_SWAP_ORIGIN}" in
    http://127.0.0.1:*|http://localhost:*) ;;
    *) die "LLAMA_SWAP_ORIGIN must be an HTTP loopback URL, got ${LLAMA_SWAP_ORIGIN}" ;;
  esac

  local total_gib
  total_gib="$(host_memory_gib)"
  local required_gib=$((budget + HOST_HEADROOM_GIB))
  if (( total_gib < required_gib )); then
    die "${budget} GiB arena requires at least ${required_gib} GiB host RAM (${HOST_HEADROOM_GIB} GiB reserved for GPU/runtime/service overhead); found ${total_gib} GiB"
  fi

  if (( budget >= 60 )); then
    local ttm_gib
    ttm_gib="$(ttm_limit_gib)"
    if (( ttm_gib < 90 )); then
      die "large-cache runs require at least a 90 GiB TTM limit; found ${ttm_gib} GiB"
    fi
  fi

  if systemctl is-active --quiet home-gateway.service && (( ACK_LIVE_TRAFFIC == 0 )); then
    die "home-gateway.service is active; pass --ack-live-traffic-risk or use a maintenance window"
  fi
}

print_command() {
  printf 'DRY-RUN:'
  printf ' %q' "$@"
  printf '\n'
}

run_inner() {
  local run_mode="$1"
  local budget="$2"
  [[ "${ACHILLES_HARNESS_INNER:-}" == "1" ]] || die "internal mode must run through the GPU-lease wrapper"
  [[ "${run_mode}" == "baseline" || "${run_mode}" == "probe-baseline" || "${run_mode}" == "quality" ]] || die "invalid internal run mode: ${run_mode}"
  require_positive_integer "${budget}" "internal budget"
  local memory_high_gib=$((budget + 12))
  local memory_max_gib=$((budget + 16))
  local n_predict=48
  local prompt='The product of 17 and 19 is'
  local predictor_label="router-weight gate-ahead"
  local predictor_args=()

  if [[ "${run_mode}" == "probe-baseline" ]]; then
    [[ -s "${ACHILLES_PROBE_PATH}" ]] || die "trained probe not found: ${ACHILLES_PROBE_PATH}"
    predictor_label="trained delta-3 probe"
    predictor_args=(--probe "${ACHILLES_PROBE_PATH}")
  fi

  if [[ "${run_mode}" == "quality" ]]; then
    n_predict=16
    prompt='[gMASK]<sop><|system|>Reasoning Effort: Max<|user|>What is 17 multiplied by 19? Respond with only the integer.<|assistant|><think></think>'
  fi

  curl -fsS -X POST "${LLAMA_SWAP_ORIGIN}/api/models/unload"
  echo
  sleep 3

  local running
  running="$(curl -fsS "${LLAMA_SWAP_ORIGIN}/running")"
  running_is_empty "${running}" || die "llama-swap still has a resident model: ${running}"

  echo "Eviction: plan-aware LRU; predictor: ${predictor_label} (--policy ${EVICTION_POLICY}, --delta 3, --fetch 8)"

  local unit="achilles-glm52-${run_mode}-b${budget}-$$"
  systemd-run --user --wait --pipe --collect \
    --unit="${unit}" \
    -p Type=exec \
    -p "MemoryHigh=${memory_high_gib}G" \
    -p "MemoryMax=${memory_max_gib}G" \
    -p MemorySwapMax=2G \
    --quiet \
    env GGML_VK_VISIBLE_DEVICES=0 \
    timeout --signal=TERM --kill-after=60s 45m \
    "${ACHILLES_BIN}" \
      -m "${MODEL}" \
      -p "${prompt}" \
      -c 4096 \
      -n "${n_predict}" \
      -t 16 \
      -ngl 99 \
      -ot 'exps=CPU' \
      --budget-gib "${budget}" \
      --policy "${EVICTION_POLICY}" \
      --delta 3 \
      --fetch 8 \
      --workers 6 \
      "${predictor_args[@]}" \
      --stats

  echo "Post-run memory pressure:"
  cat /proc/pressure/memory
  echo "Post-run llama-swap residency:"
  local post_running
  post_running="$(curl -fsS "${LLAMA_SWAP_ORIGIN}/running")"
  echo "${post_running}"
  echo
  running_is_empty "${post_running}" || die "measurement contaminated by live llama-swap traffic"
}

run_one() {
  local run_mode="$1"
  local budget="$2"
  require_positive_integer "${budget}" "budget"

  local memory_high_gib=$((budget + 12))
  local memory_max_gib=$((budget + 16))
  if (( DRY_RUN == 1 )); then
    if [[ "${run_mode}" == "probe-baseline" ]]; then
      echo "Config: plan-aware LRU with trained delta-3 probe ${ACHILLES_PROBE_PATH}"
    else
      echo "Config: plan-aware LRU with router-weight gate-ahead (--policy ${EVICTION_POLICY}, --delta 3, --fetch 8)"
    fi
    print_command \
      npx tsx "${REPO_DIR}/src/homeserver/cli.ts" gpu run \
      --model glm52-achilles \
      --eta 45m \
      --purpose "Achilles GLM-5.2 ${run_mode} budget=${budget}GiB high=${memory_high_gib}GiB max=${memory_max_gib}GiB" \
      -- env ACHILLES_HARNESS_INNER=1 "${BASH_SOURCE[0]}" __inner "${run_mode}" "${budget}"
    return
  fi

  preflight_run "${budget}" "${run_mode}"

  mkdir -p "${LOG_DIR}"
  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  local log="${LOG_DIR}/${stamp}-${run_mode}-b${budget}.log"

  echo "Writing run log to ${log}"
  (
    cd "${REPO_DIR}"
    npx tsx src/homeserver/cli.ts gpu run \
      --model glm52-achilles \
      --eta 45m \
      --purpose "Achilles GLM-5.2 ${run_mode} budget=${budget}GiB" \
      -- env ACHILLES_HARNESS_INNER=1 "${BASH_SOURCE[0]}" __inner "${run_mode}" "${budget}"
  ) 2>&1 | tee "${log}"
}

if [[ "${MODE}" == "__inner" ]]; then
  [[ $# -eq 2 ]] || die "internal mode requires RUN_MODE and BUDGET"
  run_inner "$1" "$2"
  exit 0
fi

if [[ "${MODE}" == "verify" ]]; then
  verify_shards
  exit 0
fi

if [[ "${MODE}" == "baseline" || "${MODE}" == "probe-baseline" || "${MODE}" == "quality" ]]; then
  run_one "${MODE}" "${BUDGET_GIB}"
  exit 0
fi

IFS=',' read -r -a sweep_budgets <<< "${BUDGETS}"
(( ${#sweep_budgets[@]} > 0 )) || die "--budgets must contain at least one value"
for budget in "${sweep_budgets[@]}"; do
  require_positive_integer "${budget}" "sweep budget"
done
for budget in "${sweep_budgets[@]}"; do
  run_one baseline "${budget}"
done
