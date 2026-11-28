#!/usr/bin/env bash
# Derived from code-battle gate-d-r3/at-stop.sh (CBATTLE-14, main 88b1a8e, sha256 of the source
# file b7c33b7a9328700edc60aa873aba3ea7912e820c8460d5e0bf2c8050379de57e). Apart from this header,
# the only changes are whole lines ending in "# INFER-521-local"; drop them and the rest is
# byte-identical to the source (a test checks this). It is vendored rather than run from the
# external task root because the runner executes only code it ships: the corpus manifest pins task
# directories, not this script. Re-copy it when the corpus changes it (INFER-521).
# Local change: a check that hits AT_STOP_CAP_S is unmeasured, not red: exit 3 with no output, so
# the runner records null instead of a false detectableFailureAtStop (Codex review of INFER-521).
# Grader-derived verification metric (CBATTLE-14 §3, DECISIONS.md D7).
# Usage: at-stop.sh <TASKDIR> <WORKDIR>   (run BEFORE check.sh, which stages the hidden oracle)
#
# Re-runs the checks the agent itself had available, on the workspace as the agent left it:
# `tsc --noEmit -p tsconfig.json` and, when the task ships visible tests, `tsx --test test/*.test.ts`
# (the seed's `npm test`). Prints one content-blind JSON object:
#   {"atStopTypecheck":"passed|failed","atStopVisibleTests":"passed|failed|none",
#    "detectableFailureAtStop":true|false}
# detectableFailureAtStop = the run ended while a check available to the agent was red. Combined with
# check.sh's verdict it separates "never noticed" from "task/test gap" (green checks, hidden oracle red).
#
# Trust boundary (Codex review on PR #14): the workspace is candidate-controlled, so this script never
# runs its package.json scripts or its node_modules. It calls fixed toolchain binaries
# (AT_STOP_TOOLCHAIN, default: where WORKDIR/node_modules points) on a scratch copy of WORKDIR, so the
# checks cannot change the workspace check.sh grades next. The visible tests still execute candidate
# code, as any test run must: callers that hold secrets (the Harbor verifier) run this script as an
# unprivileged user that cannot read the hidden oracle. Exits 0 unless its own inputs are bad.
set -u
TASKDIR="${1:?usage: at-stop.sh <TASKDIR> <WORKDIR>}"
WORK="${2:?usage: at-stop.sh <TASKDIR> <WORKDIR>}"
[ -f "$TASKDIR/meta.json" ] && [ -d "$WORK" ] || { echo "at-stop: bad arguments" >&2; exit 2; }
TC="${AT_STOP_TOOLCHAIN:-$(readlink -f "$WORK/node_modules" 2>/dev/null || true)}"
[ -n "$TC" ] && [ -x "$TC/.bin/tsc" ] && [ -x "$TC/.bin/tsx" ] \
  || { echo "at-stop: no toolchain with tsc and tsx (set AT_STOP_TOOLCHAIN)" >&2; exit 2; }
VISIBLE="$(python3 -c "import json,sys;print(1 if json.load(open(sys.argv[1])).get('visibleTests') else 0)" "$TASKDIR/meta.json")" \
  || { echo "at-stop: unreadable meta.json" >&2; exit 2; }
CAP="${AT_STOP_CAP_S:-120}"
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
run_capped(){ if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$CAP" "$@"; else "$@"; fi; }
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/at-stop.XXXXXX")" || { echo "at-stop: mktemp failed" >&2; exit 2; }
trap 'rm -rf "$SCRATCH"' EXIT
COPY="$SCRATCH/work"
mkdir "$COPY"
# Copy everything but node_modules (dotfiles included), then give the copy the trusted toolchain.
( cd "$WORK" && find . -mindepth 1 -maxdepth 1 ! -name node_modules -exec cp -R {} "$COPY/" \; ) 2>/dev/null
ln -s "$TC" "$COPY/node_modules"
tc="failed"
( cd "$COPY" && run_capped "$TC/.bin/tsc" --noEmit -p tsconfig.json ) >/dev/null 2>&1 && tc="passed"
_rc=$?; case "$_rc" in 124|137) exit 3;; esac  # INFER-521-local
vt="none"
if [ "$VISIBLE" = 1 ]; then
  vt="failed"
  ( cd "$COPY" && shopt -s nullglob && files=(test/*.test.ts) && [ "${#files[@]}" -gt 0 ] \
      && run_capped "$TC/.bin/tsx" --test "${files[@]}" ) >/dev/null 2>&1 && vt="passed"
  _rc=$?; case "$_rc" in 124|137) exit 3;; esac  # INFER-521-local
fi
det=false
{ [ "$tc" = failed ] || [ "$vt" = failed ]; } && det=true
printf '{"atStopTypecheck":"%s","atStopVisibleTests":"%s","detectableFailureAtStop":%s}\n' "$tc" "$vt" "$det"
