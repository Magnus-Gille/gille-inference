#!/usr/bin/env bash
# Gate D arm runner — drives a harness arm against the box model on one task, then grades it.
# Usage: run.sh <arm> <task-id|all>     arm ∈ { pi | aider | opencode | qwen-code }
#        run.sh --print-workroot        (debug: print WORKROOT and exit — no box/model needed)
#        run.sh --list-tasks            (default r1; set GATE_D_INCLUDE_HOLDOUT=1 for r2)
#
# Per run: copy the task seed → an isolated work dir → invoke the arm (with a wall-clock cap)
# → check.sh grades deterministically → append a JSONL row to data/gate-d-results.jsonl.
#
# NEEDS THE BOX (drives pi/aider/opencode/qwen-code against a served model, e.g.
# qwen3-coder-next-80b, over the gateway at inference.example.com).
# Required env: GW (gateway /v1 base), GW_KEY (a REAL per-key gateway token — the box 401s on a
# dummy). Optional: MODEL (default qwen3-coder-next-80b), CAP_S (wall-clock cap, default 600).
set -u
set -o pipefail
# Never let an inherited Git override aim this runner's git calls (fixture guard, prompt lookup) at
# another repository; the work dirs get their own git roots below.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
      GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE
unset CDPATH   # a relative CDPATH makes `cd` print, corrupting $(cd ... && pwd)
ROOT="$(cd "$(dirname "$0")" && pwd -P)"
REPO_ROOT="$(cd "$ROOT/.." && pwd -P)"
. "$ROOT/prompt-identity.sh"   # gd_git (isolated runner-owned Git) and the prompt resolver

# ── Work-dir isolation (#172) ────────────────────────────────────────────────────────────────
# Work dirs used to live under gate-d/.work/ — INSIDE this checkout. A nested `git init` there
# was meant to contain a harness arm's edits, but the pi arm's path resolution still reached the
# OUTER repo's git root from inside that nested dir and wrote the SOLUTION directly onto the
# pristine seed (gate-d/tasks/.../repo/src/sum.ts) plus a stray file at the wrong path
# (gate-d/src/sum.ts) — silent, permanent fixture corruption. Merely being a subdirectory of the
# checkout was never a reliable boundary for every harness's root-detection heuristic.
#
# Fix: put WORKROOT under the system temp dir instead, so there is no ancestor .git / package.json
# / tsconfig.json / etc. for any tool to discover by walking up — the escape hatch doesn't exist,
# regardless of the exact mechanism a given harness uses to find its "project root". The
# WORKROOT-outside-the-repo case check below is a hard assertion of that property, not just a
# default (a misconfigured GATE_D_WORKROOT/TMPDIR pointing back inside the repo refuses to run).
WORKROOT="${GATE_D_WORKROOT:-${TMPDIR:-/tmp}/gate-d-work}"
# Absolute and physical, so a relative TMPDIR/GATE_D_WORKROOT or a symlink cannot slip past the
# inside-the-repo check below.
WORKROOT="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$WORKROOT")" || exit 3
if [ "${1:-}" = "--print-workroot" ]; then echo "$WORKROOT"; exit 0; fi
# Compare directory identities, not spellings: on a case-insensitive volume a differently
# capitalized path can name a directory inside the checkout. Walk from the nearest existing
# ancestor of WORKROOT up to / and refuse if any of them is the checkout itself.
if ! python3 - "$WORKROOT" "$REPO_ROOT" <<'PY'
import os, sys
path, repo = sys.argv[1], os.stat(sys.argv[2])
while not os.path.exists(path):
    path = os.path.dirname(path)
while True:
    st = os.stat(path)
    if (st.st_dev, st.st_ino) == (repo.st_dev, repo.st_ino):
        sys.exit(1)
    parent = os.path.dirname(path)
    if parent == path:
        sys.exit(0)
    path = parent
PY
then
  echo "error: WORKROOT ($WORKROOT) resolves INSIDE the repo ($REPO_ROOT) — refusing to run (#172)." >&2
  echo "       set TMPDIR or GATE_D_WORKROOT to a path outside the checkout." >&2
  exit 3
fi
mkdir -p "$WORKROOT"

CORPUS_TOOL="$ROOT/gate_d_corpus.py"
if [ "${1:-}" = "--list-tasks" ]; then python3 "$CORPUS_TOOL" tasks; exit $?; fi
CORPUS_REVISION="$(python3 "$CORPUS_TOOL" revision)" || exit 3
TASK_IDS="$(python3 "$CORPUS_TOOL" tasks)" || exit 3

ARM="${1:?usage: run.sh <pi|aider|opencode|qwen-code> <task-id|all>}"
SEL="${2:?usage: run.sh <pi|aider|opencode|qwen-code> <task-id|all>}"
if [ "$SEL" != "all" ] && ! python3 "$CORPUS_TOOL" contains "$SEL"; then
  if [ -f "$ROOT/tasks/$SEL/meta.json" ]; then
    echo "error: task '$SEL' is not in $CORPUS_REVISION; holdouts require GATE_D_INCLUDE_HOLDOUT=1" >&2
  else
    echo "error: unknown Gate D task '$SEL'" >&2
  fi
  exit 3
fi
MODEL="${MODEL:-qwen3-coder-next-80b}"
GW="${GW:-https://inference.example.com/v1}"
CAP_S="${CAP_S:-600}"
: "${GW_KEY:?set GW_KEY to a real gateway token (mint via bin/invite)}"
# Portable wall-clock cap: GNU coreutils ships `timeout` on Linux (the box) and `gtimeout`
# on macOS via Homebrew. Resolve whichever exists so the same script runs on either host.
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
[ -n "$TIMEOUT_BIN" ] || { echo "error: need GNU 'timeout' (Linux) or 'gtimeout' (macOS: brew install coreutils) on PATH" >&2; exit 3; }
OUT="${GATE_D_OUT:-$REPO_ROOT/data/gate-d-results.jsonl}"; mkdir -p "$(dirname "$OUT")"
# Optional pi-only system-prompt variant (INFER-519). GATE_D_PI_APPEND_SYSTEM names a committed file
# under gate-d/prompts/; see prompt-identity.sh. Its blob is snapshotted once from HEAD into a
# private runner-owned file, which pi reads by absolute path (pi treats the flag's value as text OR
# an existing file name, so a path is the only unambiguous form). Every row records the name and the
# sha256 of exactly those bytes, and the snapshot is re-verified after each arm run, so variant runs
# never pool silently with baseline runs. Unset = the baseline (promptVariant "none").
if [ -n "${GATE_D_PI_APPEND_SYSTEM:-}" ] && [ "$ARM" != "pi" ]; then
  echo "error: GATE_D_PI_APPEND_SYSTEM is supported for the pi arm only" >&2; exit 3
fi
resolve_prompt_variant "$REPO_ROOT" || exit 3
PROMPT_FILE=""; PROMPT_DIR=""
if [ -n "$PROMPT_BLOB" ]; then
  # Absolute, physical parent: pi runs from the task dir, and pi treats a missing relative path
  # as literal prompt text.
  PROMPT_PARENT="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" \
    || { echo "error: cannot resolve the temp directory ${TMPDIR:-/tmp}" >&2; exit 3; }
  PROMPT_DIR="$(mktemp -d "$PROMPT_PARENT/gd-prompt.XXXXXXXX")" || exit 3
  case "$PROMPT_DIR" in /*) ;; *) echo "error: prompt snapshot dir is not absolute: $PROMPT_DIR" >&2; exit 3 ;; esac
  trap 'rm -rf "$PROMPT_DIR"' EXIT
  snapshot_prompt_variant "$REPO_ROOT" "$PROMPT_DIR" || exit 3
fi
# Fixture-corruption guard (#172 belt-and-suspenders): gate-d/tasks/ must always be pristine and
# gate-d/src/ must never exist. Checked once per task in run_one(), right after the arm runs — if
# either is dirty, something still escaped its work dir; restore from HEAD and abort loudly rather
# than let corruption silently persist. Skipped outside a git checkout (nothing to escape to — the
# box runtime dir is an rsync target, not a checkout, per the incident writeup above).
# A .git entry means this IS a checkout: if Git cannot read it (for example a shared checkout that
# relied on a safe.directory entry in the now-ignored global config), abort instead of silently
# skipping the guard.
IN_GIT_CHECKOUT=0
if [ -e "$REPO_ROOT/.git" ] || [ -L "$REPO_ROOT/.git" ]; then
  probe_out=""
  if ! probe_out="$(gd_git -C "$REPO_ROOT" rev-parse --is-inside-work-tree 2>&1)" \
     || [ "$probe_out" != "true" ] \
     || ! probe_out="$(gd_git -C "$REPO_ROOT" status --porcelain -- gate-d/tasks 2>&1 >/dev/null)"; then
    echo "error: $REPO_ROOT has a .git entry but Git cannot read it, so the fixture-corruption guard cannot run:" >&2
    echo "$probe_out" >&2
    exit 3
  fi
  IN_GIT_CHECKOUT=1
elif gd_git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  IN_GIT_CHECKOUT=1
fi
# Prints the porcelain status of the fixtures; returns non-zero if Git cannot produce it.
fixture_dirty(){ gd_git -C "$REPO_ROOT" status --porcelain -- gate-d/tasks gate-d/src; }
metaget(){ python3 -c "import json;v=json.load(open('$1')).get('$2','');print(str(v).lower() if isinstance(v,bool) else v)"; }
metalist(){ python3 -c "import json;print(' '.join(json.load(open('$1')).get('$2',[])))"; }

run_one() {
  local T="$1" id task_revision holdout; id=$(basename "$T")
  task_revision="$(metaget "$T/meta.json" corpusRevision)"; task_revision="${task_revision:-gate-d-r1}"
  holdout="$(metaget "$T/meta.json" holdout)"; holdout="${holdout:-false}"
  if [ "$IN_GIT_CHECKOUT" = 1 ]; then
    local dirty_before
    if ! dirty_before="$(fixture_dirty)"; then
      echo "FATAL[$ARM/$id]: git status failed, so the fixture-corruption guard cannot run" >&2
      exit 9
    fi
    if [ -n "$dirty_before" ]; then
      echo "FATAL[$ARM/$id]: gate-d/tasks or gate-d/src was already dirty before this run:" >&2
      echo "$dirty_before" >&2
      echo "Refusing to run because the post-run corruption guard may restore only changes made by this run." >&2
      echo "Commit, stash, or remove those fixture edits first." >&2
      exit 9
    fi
  fi
  local instr; instr="$(cat "$T/INSTRUCTION.md")"
  local edit read; edit=$(metalist "$T/meta.json" edit); read=$(metalist "$T/meta.json" read)
  # aider --file/--read args: guard empties so an empty list doesn't emit a dangling flag that
  # swallows the next option (an empty `read` made `--read` eat `--message` → 2s arm-error, task 05).
  local fileargs="" readargs=""
  [ -n "$edit" ] && fileargs=$(printf -- '--file %s ' $edit)
  [ -n "$read" ] && readargs=$(printf -- '--read %s ' $read)
  # The expected seed: in a checkout, the committed task tree (path, mode and blob, so ignored or
  # stray files in the live directory are caught); in a plain deployment, the task's file list.
  # Records are compared NUL-delimited (ls-tree -z, find -print0), because Git quotes paths that
  # contain quotes, backslashes or control characters even with core.quotePath=false (INFER-520).
  # NUL cannot live in a shell variable, so the expected and actual lists go through files.
  local seed_expected_f seed_actual_f
  seed_expected_f="$(mktemp "${TMPDIR:-/tmp}/gd-seed-exp.XXXXXXXX")" || { echo "FATAL[$ARM/$id]: mktemp failed" >&2; exit 3; }
  seed_actual_f="$(mktemp "${TMPDIR:-/tmp}/gd-seed-act.XXXXXXXX")" || { rm -f "$seed_expected_f"; echo "FATAL[$ARM/$id]: mktemp failed" >&2; exit 3; }
  # No sed -z (BSD sed lacks it): the checkout branch lists the task tree relative to itself, and
  # the plain branch strips "./" with python3.
  trap 'rm -f "$seed_expected_f" "$seed_actual_f"; exit 130' INT TERM
  if [ "$IN_GIT_CHECKOUT" = 1 ]; then
    if ! gd_git -C "$REPO_ROOT" ls-tree -r -z "HEAD:gate-d/tasks/$id/repo" > "$seed_actual_f" \
       || [ ! -s "$seed_actual_f" ] \
       || ! LC_ALL=C sort -z "$seed_actual_f" > "$seed_expected_f"; then
      rm -f "$seed_expected_f" "$seed_actual_f"; trap - INT TERM
      echo "FATAL[$ARM/$id]: could not read the committed task tree; refusing to run the arm." >&2; exit 3
    fi
  else
    if ! (cd "$T/repo" && find . \( -type f -o -type l \) -print0) > "$seed_actual_f" \
       || ! python3 -c '
import sys
recs = [r[2:] if r.startswith(b"./") else r for r in open(sys.argv[1], "rb").read().split(b"\0") if r]
recs.sort()
open(sys.argv[2], "wb").write(b"".join(r + b"\0" for r in recs))
' "$seed_actual_f" "$seed_expected_f" \
       || [ ! -s "$seed_expected_f" ]; then
      rm -f "$seed_expected_f" "$seed_actual_f"; trap - INT TERM
      echo "FATAL[$ARM/$id]: could not enumerate $T/repo; refusing to run the arm." >&2; exit 3
    fi
  fi
  local W
  W=$(mktemp -d "$WORKROOT/${id}-${ARM}-XXXX") || { rm -f "$seed_expected_f" "$seed_actual_f"; echo "FATAL[$ARM/$id]: mktemp failed" >&2; exit 3; }
  # -R, not -r: BSD cp (macOS) can dereference a symlink fixture under -r; -R keeps it a symlink.
  if ! cp -R "$T/repo/." "$W/"; then
    echo "FATAL[$ARM/$id]: could not copy the task seed; refusing to run the arm." >&2
    rm -rf "$W" "$seed_expected_f" "$seed_actual_f"; trap - INT TERM; exit 3
  fi
  # node_modules symlink: WORKROOT now lives OUTSIDE the repo (#172), so there's no ancestor dir
  # left for `npx --no-install` to climb into. Link the real node_modules in directly — check.sh's
  # tsc/tsx invocations keep resolving exactly as before, just via one hop instead of an upward walk.
  if ! ln -s "$REPO_ROOT/node_modules" "$W/node_modules"; then
    echo "FATAL[$ARM/$id]: could not link node_modules; refusing to run the arm." >&2
    rm -rf "$W" "$seed_expected_f" "$seed_actual_f"; trap - INT TERM; exit 3
  fi
  # Make the work dir its OWN git root, so aider/opencode/pi's git-based root-detection sees $W —
  # not this checkout — as the repo. Gives aider the committed HEAD baseline it diffs against
  # (--no-auto-commit leaves the arm's net edit in the working tree for check.sh's diff-vs-seed).
  # Every seed step must succeed, and the seed commit must hold exactly the expected task files
  # (plus the node_modules link), or the arm would run without the baseline it is graded against.
  # `add -f` for node_modules: a seed's own .gitignore may list it (INFER-520).
  local seed_ok=1
  if ! gd_git init -q --template= "$W" \
     || ! gd_git -C "$W" add -A \
     || ! gd_git -C "$W" add -f -- node_modules \
     || ! gd_git -C "$W" -c user.email=gate-d@local -c user.name=gate-d commit -q -m seed >/dev/null \
     || ! gd_git -C "$W" ls-tree -r -z HEAD > "$seed_actual_f"; then
    seed_ok=0
  else
    # Drop the node_modules link record, then (outside a checkout) the mode/type/blob prefix.
    if ! python3 - "$seed_actual_f" "$IN_GIT_CHECKOUT" <<'PY'
import re, sys
path, in_git = sys.argv[1], sys.argv[2] == "1"
recs = open(path, "rb").read().split(b"\0")
recs = [r for r in recs if r]
link = [r for r in recs if re.fullmatch(rb"120000 blob [0-9a-f]+\tnode_modules", r)]
if len(link) != 1:
    sys.exit(1)
recs = [r for r in recs if r is not link[0]]
if not in_git:
    recs = [r.split(b"\t", 1)[1] for r in recs]
recs.sort()
open(path, "wb").write(b"".join(r + b"\0" for r in recs))
PY
    then seed_ok=0; fi
  fi
  if [ "$seed_ok" != 1 ] || ! cmp -s "$seed_expected_f" "$seed_actual_f"; then
    echo "FATAL[$ARM/$id]: could not create the seed commit in $W; refusing to run the arm." >&2
    rm -rf "$W" "$seed_expected_f" "$seed_actual_f"; trap - INT TERM
    exit 3
  fi
  rm -f "$seed_expected_f" "$seed_actual_f"; trap - INT TERM
  local t0 t1 status="ran"
  t0=$(date +%s)
  case "$ARM" in
    pi)
      # native tool-calling; provider must exist in ~/.pi/agent/models.json. Defaults to the
      # box gateway ('inference-gille'); override PI_PROVIDER to target a local runtime — e.g.
      # PI_PROVIDER=ollama for an on-laptop edge eval (RQ3). pi operates on its CWD (no --dir).
      # #172 belt-and-suspenders: clear any inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE and set
      # a ceiling so git-based root discovery — this arm's or anything it shells out to — cannot
      # climb past $WORKROOT, on top of $W already living outside the repo entirely.
      ( cd "$W" \
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE \
          && export GIT_CEILING_DIRECTORIES="$WORKROOT" \
          && HS_API_KEY="$GW_KEY" "$TIMEOUT_BIN" "$CAP_S" pi --provider "${PI_PROVIDER:-inference-gille}" --model "$MODEL" \
             --no-session --print --mode json ${PROMPT_FILE:+--append-system-prompt "$PROMPT_FILE"} "$instr" </dev/null 2>"$W/.arm.stderr.log" \
             | "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/scripts/pi-benchmark-telemetry.ts" \
                 --log "$W/.arm.log" --summary "$W/.arm-telemetry.json" ) || status="arm-error"
      ;;
    aider)
      ( cd "$W" \
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE \
          && export GIT_CEILING_DIRECTORIES="$WORKROOT" \
          && OPENAI_API_BASE="$GW" OPENAI_API_KEY="$GW_KEY" "$TIMEOUT_BIN" "$CAP_S" \
             aider --model "openai/$MODEL" --edit-format diff \
             --model-settings-file "$ROOT/aider-model-settings.yml" \
             --model-metadata-file "$ROOT/aider-model-metadata.json" \
             --no-auto-commit --yes --no-gitignore \
             $fileargs $readargs \
             --message "$instr" </dev/null >"$W/.arm.log" 2>&1 ) || status="arm-error"
      ;;
    opencode)
      # provider 'homebox' must exist in opencode.json (see docs/gate-de-evaluation-plan.md)
      ( cd "$W" \
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE \
          && export GIT_CEILING_DIRECTORIES="$WORKROOT" \
          && HOMEBOX_API_KEY="$GW_KEY" "$TIMEOUT_BIN" "$CAP_S" opencode run -m "homebox/$MODEL" \
             --dir "$W" --format json "$instr" </dev/null >"$W/.arm.log" 2>&1 ) || status="arm-error"
      ;;
    qwen-code)
      # qwen (v0.21.15+) has no --dir/--cwd flag — it operates on process.cwd(), so cd into $W
      # exactly like the pi arm. --yolo auto-approves edits/shell; never combine it with
      # --approval-mode (mutually exclusive, the CLI errors). Custom OpenAI-compatible endpoint via
      # OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL, plus -m explicitly. --max-tool-calls is a
      # defensive inner bound only — the outer `timeout`/CAP_S remains the real wall-clock cap.
      ( cd "$W" \
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE \
          && export GIT_CEILING_DIRECTORIES="$WORKROOT" \
          && OPENAI_API_KEY="$GW_KEY" OPENAI_BASE_URL="$GW" OPENAI_MODEL="$MODEL" "$TIMEOUT_BIN" "$CAP_S" \
             qwen -m "$MODEL" --yolo --max-tool-calls 100 "$instr" </dev/null >"$W/.arm.log" 2>&1 ) || status="arm-error"
      ;;
    *) echo "unknown arm: $ARM"; rm -rf "$W"; exit 2;;
  esac
  # Fixture-corruption guard (#172 belt-and-suspenders) — see IN_GIT_CHECKOUT comment above.
  if [ "$IN_GIT_CHECKOUT" = 1 ]; then
    local dirty
    if ! dirty="$(fixture_dirty)"; then
      echo "FATAL[$ARM/$id]: git status failed after the run, so fixture corruption cannot be ruled out; no row written" >&2
      rm -rf "$W"
      exit 9
    fi
    if [ -n "$dirty" ]; then
      echo "FATAL[$ARM/$id]: gate-d/tasks or gate-d/src changed on disk during this run:" >&2
      echo "$dirty" >&2
      gd_git -C "$REPO_ROOT" checkout -q -- gate-d/tasks 2>/dev/null
      gd_git -C "$REPO_ROOT" clean -fdq -- gate-d/tasks gate-d/src 2>/dev/null
      echo "Restored gate-d/ fixtures from HEAD and aborting (#172) — corruption must never silently persist." >&2
      echo "(If you're mid-edit of a fixture yourself, commit first and re-run.)" >&2
      rm -rf "$W"
      exit 9
    fi
  fi
  if ! verify_prompt_snapshot; then
    echo "FATAL[$ARM/$id]: the prompt snapshot changed during the run; no row written" >&2
    rm -rf "$W"; exit 3
  fi
  t1=$(date +%s)
  # Oracle-peek transcript + detection (pure observation — never affects pass/fail or any
  # check.sh gate, and never touches gate-d/tasks). Every arm already captures its own combined
  # stdout+stderr into $W/.arm.log (pi additionally splits stderr into $W/.arm.stderr.log because
  # its stdout is a live NDJSON stream consumed by the telemetry parser — mixing streams there
  # would corrupt that parse). Concatenating those already-captured files after the run gives the
  # same "combined stdout+stderr" content the telemetry piping already relies on, without adding a
  # live tee to the pi pipe (the one arm where that would risk breaking telemetry parsing).
  # $TRANSCRIPT lives in $WORKROOT — the WORK DIR'S PARENT, never inside $W. Note that being
  # outside $W is NOT by itself sufficient: see the unpredictable-name requirement below.
  # The transcript path MUST NOT be predictable from inside $W. An earlier revision used the
  # sibling path "$W.transcript", which the arm can compute from its own cwd: planting a symlink
  # (or FIFO) there turns the `: >` truncation below into an out-of-work-dir clobber primitive —
  # and it fires AFTER the fixture dirty-check above has already declared the tree clean, so it
  # evades exactly the isolation guarantee #172 exists to enforce. `mktemp` creates the file
  # O_EXCL with an unguessable suffix, so a pre-planted path is never followed.
  local TRANSCRIPT=""
  TRANSCRIPT="$(mktemp "$WORKROOT/transcript-XXXXXXXX" 2>/dev/null)" || TRANSCRIPT=""
  if [ -n "$TRANSCRIPT" ]; then
    [ -f "$W/.arm.log" ] && cat "$W/.arm.log" >>"$TRANSCRIPT" 2>/dev/null
    [ -f "$W/.arm.stderr.log" ] && cat "$W/.arm.stderr.log" >>"$TRANSCRIPT" 2>/dev/null
  fi
  # Scanning is delegated to gate-d/peek-scan.py, which reads from the PRISTINE task dir (never the
  # work dir). `solution/` and `oracle/` live outside $W, so the thing worth detecting is ACCESS,
  # not similarity — an early version matched reference-solution *code* and fired on 30/30
  # legitimate passing runs, because a correct implementation IS the reference solution at this task
  # scale. The leak signals are now graderPathInTranscript (a protected path was referenced),
  # hiddenOracleMarkerInTranscript (arbitrary author-chosen literals, two-hit + high-specificity
  # threshold), and solutionMarkerInTranscript (the "REFERENCE SOLUTION" banner). Discriminating
  # power is pinned by positive AND negative controls in tests/gate-d-peek-scan.test.ts.
  # oracleContent/oracleCmd hits are NORMAL on visible-oracle tasks (the harness is meant to read
  # and satisfy the oracle) and are retained only for cross-arm comparability.
  # Fails OPEN: any scanner error yields '{}' so a graded run is never broken by observation.
  local PEEK_JSON
  PEEK_JSON="$(python3 "$ROOT/peek-scan.py" "$T" "$TRANSCRIPT" 2>/dev/null)" || PEEK_JSON=""
  [ -n "$PEEK_JSON" ] || PEEK_JSON="{}"
  local pass="false" exitclass="$status"
  if bash "$ROOT/check.sh" "$T" "$W" >"$W/.check.log" 2>&1; then pass="true"; exitclass="pass"
  elif [ "$status" = "arm-error" ]; then exitclass="arm-error"
  else
    # Extract the gate id from the `FAIL[G3-tsc]: ...` line (check.sh prints `--- tsc ---`
    # headers BEFORE it, so head -1 would grab the wrong line).
    exitclass="$(grep -m1 -oE 'FAIL\[[^]]+\]' "$W/.check.log" | sed 's/^FAIL\[//; s/\]$//')"
    [ -n "$exitclass" ] || exitclass="check-fail"
  fi
  # Emit the result row via env vars (not shell-interpolation into the Python source): the prior
  # form injected the bash bareword `true`/`false` as a Python name → NameError, dropping the row.
  GD_ARM="$ARM" GD_MODEL="$MODEL" GD_TASK="$id" GD_PASS="$pass" GD_EXIT="$exitclass" GD_WALL="$((t1-t0))" \
    GD_CORPUS_REVISION="$CORPUS_REVISION" GD_TASK_REVISION="$task_revision" GD_HOLDOUT="$holdout" \
    GD_TELEMETRY="$([ "$ARM" = pi ] && printf %s "$W/.arm-telemetry.json")" \
    GD_PEEK="$PEEK_JSON" GD_PROMPT_VARIANT="$PROMPT_VARIANT" GD_PROMPT_SHA="$PROMPT_SHA" \
    python3 -c "import json,os
row={'arm':os.environ['GD_ARM'],'model':os.environ['GD_MODEL'],'task':os.environ['GD_TASK'],'corpusRevision':os.environ['GD_CORPUS_REVISION'],'taskRevision':os.environ['GD_TASK_REVISION'],'holdout':os.environ['GD_HOLDOUT']=='true','pass':os.environ['GD_PASS']=='true','exitClass':os.environ['GD_EXIT'],'wallS':int(os.environ['GD_WALL'])}
keys=('turns','toolCalls','promptTokens','completionTokens','modelTurnMs','timedModelTurns','assistantStreamMs','timedAssistantMessages','unparseableLines')
telemetry={k:None for k in keys}
p=os.environ.get('GD_TELEMETRY','')
if p and os.path.isfile(p) and not os.path.islink(p):
    try: raw=json.load(open(p))
    except Exception: raw={}
    if isinstance(raw,dict):
        for k in keys:
            v=raw.get(k)
            if isinstance(v,(int,float)) and not isinstance(v,bool): telemetry[k]=v
row.update(telemetry)
peek=json.loads(os.environ.get('GD_PEEK') or '{}')
row.update({k:bool(v) for k,v in peek.items() if k not in row})
row['promptVariant']=os.environ['GD_PROMPT_VARIANT']; row['promptSha256']=os.environ['GD_PROMPT_SHA'] or None
print(json.dumps(row))" >>"$OUT"
  local row_status=$?
  if [ "$row_status" -eq 0 ]; then
    echo "[$ARM/$MODEL/$CORPUS_REVISION] $id → $exitclass (${pass}, $((t1-t0))s)"
  else
    echo "FATAL[$ARM/$id]: could not append the result row to $OUT (status $row_status)" >&2
  fi
  # KEEP_WORK=1 preserves the work dir (+ .arm logs, telemetry, .check.log, and the oracle-peek
  # transcript) for diagnosis.
  if [ -n "${KEEP_WORK:-}" ]; then
    echo "  [kept] $W${TRANSCRIPT:+ (+ transcript: $TRANSCRIPT)}"
  else
    rm -rf "$W"
    [ -n "$TRANSCRIPT" ] && rm -f "$TRANSCRIPT"
  fi
  # A lost row must never look like success: the sweep would otherwise read an older row.
  [ "$row_status" -eq 0 ] || exit 4
}

if [ "$SEL" = "all" ]; then
  for id in $TASK_IDS; do run_one "$ROOT/tasks/$id"; done
else
  run_one "$ROOT/tasks/$SEL"
fi
