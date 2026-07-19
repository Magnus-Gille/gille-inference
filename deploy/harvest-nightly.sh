#!/usr/bin/env bash
#
# Nightly HARVEST: turn REAL delegation traffic into REAL capability evidence.
#
# For each recent (prompt, answer) pair in owner_request_log, a CALIBRATED local judge (gpt-oss-120b
# — response_format {json_object} makes it reliable + it grades every model incl. qwen-coder's own;
# see docs/harvest-judge-calibration-2026-07-06.md) grades whether the local model's answer
# accomplished the task, and the verdict lands in the capability ledger. This closes the loop
# the audit found open: the Claude->M5 mcp-ask channel records everything `unverified`, so real usage
# never moved routing. Everything is LOCAL (owner's own consented content, judged on-box — nothing
# leaves the machine) and free; wrapped in the GPU lease (#88) so the judge run can't thrash a live
# owner session. Rationale: src/homeserver/harvest.ts, docs, and ~/.claude/CLAUDE.md.
#
# SAFETY — default MODE=shadow writes outcome='unverified' rows (ZERO routing impact) so you can
# inspect the judge on your real traffic first. When it looks trustworthy, flip to real verdicts with
# ONE env change (no script edit):   HARVEST_MODE=on  (and, for a judgment-quality type like
# code-review, also add `llm-judge:<judge>` to HOMESERVER_TRUSTED_JUDGMENT_VERIFIERS — #168).
# In mode=on, broad `other` catch-all rows are EXCLUDED from verdict writing by default (a bucket of
# unrelated prompts can't teach routing; HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES="" disables). The
# judge token budget defaults to 4000 (gpt-oss is a REASONING model — the old 600 starved it into
# "empty judge completion" judge-errs; HARVEST_JUDGE_MAX_TOKENS overrides, starved calls retry doubled).
# Multi-turn rows send the judge a bounded transcript of the conversation's other turns (#197;
# since #216 that includes the assistant's post-ask [tool] activity, and the task is the last
# GENUINE user turn — a tool result no longer poses as it). It used to grade only the last user
# turn and falsely failed conversation-shaped answers; HARVEST_JUDGE_CONTEXT_CHARS overrides the
# 24000-char budget, 0 restores last-turn-only.
#
# Verdicts are stamped with the grading-policy epoch (#217). After a judge/interpretation policy
# bump, run scripts/harvest-verdicts.ts ONCE manually with --rejudge-existing (gpu-run-wrapped) to
# supersede+regrade stale-epoch rows — the nightly deliberately never rejudges on its own.
#
# Track:  grep -E "=====|graded|ledger writes" /srv/gille-inference/data/harvest-trend.log
# Suggested cron (after gate-chat-replay's 03:00, before nothing GPU-heavy):
#   30 4 * * *  /home/inference/harvest-nightly.sh
#
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/local/bin
REPO=/srv/gille-inference
LOG="$REPO/data/harvest-trend.log"
MODE="${HARVEST_MODE:-shadow}"
JUDGE="${HARVEST_JUDGE:-gpt-oss-120b}"
N="${HARVEST_N:-40}"
cd "$REPO" || exit 1
# The judge call needs the local llama-swap endpoint. systemd loads .env for the gateway, but a bare
# cron env does not inherit it — so pull just the one var we need from .env (no full-source, which
# would shell-evaluate other values). EVAL_DB_PATH defaults to ./data/eval.db, correct from $REPO.
# Codex retro (#213 follow-up): the documented HARVEST_* .env knobs were previously ignored here —
# a serving-window change or the context kill switch set in .env silently no-oped under cron.
# Pull an explicit allow-list of harvest knobs from .env. Semantics (codex review of the first
# version): PRESENCE wins over content — an ambient var that is set-but-empty still beats .env;
# an `.env` line with an empty RHS is exported as empty (it must disable the default, not silently
# fall back to it); one matching pair of surrounding dotenv quotes is stripped without eval.
# --- env-allowlist start ---
for _v in LMSTUDIO_BASE_URL HARVEST_JUDGE_CONTEXT_CHARS HARVEST_JUDGE_CTX_WINDOW \
          HARVEST_JUDGE_MAX_TOKENS HARVEST_JUDGE_CHARS_PER_TOKEN HARVEST_CALL_TIMEOUT_MS \
          HOMESERVER_HARVEST_EXCLUDED_TASK_TYPES; do
  if declare -p "$_v" >/dev/null 2>&1; then
    # presence test compatible with bash 3.2 (macOS) — [[ -v ]] needs 4.2+
    export "$_v=${!_v}"
    continue
  fi
  _line="$(grep -E "^${_v}=" "$REPO/.env" 2>/dev/null | head -1)"
  if [ -n "$_line" ]; then
    _val="${_line#*=}"
    case "$_val" in
      '"'*'"') _val="${_val#\"}"; _val="${_val%\"}" ;;
      "'"*"'") _val="${_val#\'}"; _val="${_val%\'}" ;;
    esac
    export "$_v=$_val"
  fi
done
# --- env-allowlist end ---
{
  echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) mode=$MODE judge=$JUDGE n=$N recent=24h ====="
  npx tsx src/homeserver/cli.ts gpu run --model "$JUDGE" --eta 30m --purpose harvest-nightly \
    -- npx tsx scripts/harvest-verdicts.ts --mode "$MODE" --judge-model "$JUDGE" --n "$N" --recent 24h \
    2>&1 | grep -vE "punycode|trace-deprecation"
  if [ -f /home/inference/.heimdall-push.env ]; then
    # Best-effort status panel on /services/m5-inference: shows GO / HARVEST_MORE / HOLD and the
    # counts behind it. Plain HTTP after the GPU-leased harvest; never affects harvest success.
    set -a
    . /home/inference/.heimdall-push.env
    set +a
    npx tsx scripts/post-harvest-decision-panel.ts --db data/eval.db --harvest-log "$LOG" \
      2>&1 | grep -vE "punycode|trace-deprecation" || true
  else
    echo "[harvest-panel] ~/.heimdall-push.env missing — skipping Heimdall push"
  fi
  echo
} >> "$LOG" 2>&1
