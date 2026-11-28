#!/usr/bin/env bash
# Derived from code-battle gate-d-r3/at-stop.sh (CBATTLE-14, commit caae280, sha256 of the source
# file 52c4ed33ff4ab7aa0de88fab69ca40f6d391eab73593b70d644745ace09bc9a2). Apart from this header,
# the only changes are whole lines ending in "# INFER-521-local"; drop them and the rest is
# byte-identical to the source (a test checks this). It is vendored rather than run from the
# external task root because the runner executes only code it ships: the corpus manifest pins task
# directories, not this script. Re-copy it when the corpus changes it (INFER-521).
# Local change: a check that hits AT_STOP_CAP_S is unmeasured, not red: exit 3 with no output, so
# the runner records null instead of a false detectableFailureAtStop (Codex review of INFER-521).
# Grader-derived verification metric (CBATTLE-14 §3, DECISIONS.md D7).
# Usage: at-stop.sh <TASKDIR> <WORKDIR>   (run BEFORE check.sh, which stages the hidden oracle)
#
# Re-runs the checks the agent itself had available, on the workspace exactly as the agent left it:
# `tsc --noEmit -p tsconfig.json` and, when the task ships visible tests, `npm test`. Prints one
# content-blind JSON object:
#   {"atStopTypecheck":"passed|failed","atStopVisibleTests":"passed|failed|none",
#    "detectableFailureAtStop":true|false}
# detectableFailureAtStop = the run ended while a check available to the agent was red. Combined with
# check.sh's verdict it separates "never noticed" from "task/test gap" (green checks, hidden oracle red).
# Never mutates WORKDIR beyond what the checks themselves write; exits 0 unless its own inputs are bad.
set -u
TASKDIR="${1:?usage: at-stop.sh <TASKDIR> <WORKDIR>}"
WORK="${2:?usage: at-stop.sh <TASKDIR> <WORKDIR>}"
[ -f "$TASKDIR/meta.json" ] && [ -d "$WORK" ] || { echo "at-stop: bad arguments" >&2; exit 2; }
CAP="${AT_STOP_CAP_S:-120}"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
run_capped(){ if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$CAP" "$@"; else "$@"; fi; }
tc="failed"
( cd "$WORK" && run_capped npx --no-install tsc --noEmit -p tsconfig.json ) >/dev/null 2>&1 && tc="passed"
_rc=$?; case "$_rc" in 124|137) exit 3;; esac  # INFER-521-local
vt="none"
if python3 -c "import json,sys;sys.exit(0 if json.load(open('$TASKDIR/meta.json')).get('visibleTests') else 1)"; then
  vt="failed"
  ( cd "$WORK" && run_capped npm test --silent ) >/dev/null 2>&1 && vt="passed"
  _rc=$?; case "$_rc" in 124|137) exit 3;; esac  # INFER-521-local
fi
det=false
{ [ "$tc" = failed ] || [ "$vt" = failed ]; } && det=true
printf '{"atStopTypecheck":"%s","atStopVisibleTests":"%s","detectableFailureAtStop":%s}\n' "$tc" "$vt" "$det"
