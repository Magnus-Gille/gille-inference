#!/usr/bin/env bash
# Gate D arm runner — drives a harness arm against the box model on one task, then grades it.
# Usage: run.sh <arm> <task-id|all>     arm ∈ { pi | aider | opencode | qwen-code }
#        run.sh --print-workroot        (debug: print WORKROOT and exit — no box/model needed)
#        run.sh --list-tasks            (default r1; set GATE_D_INCLUDE_HOLDOUT=1 for r2)
#
# External task root (INFER-521): GATE_D_TASKS_ROOT=<dir> runs the tasks listed in
# <dir>/corpus-manifest.json (code-battle's gate-d-r3 generator writes it) instead of gate-d/tasks.
# The root must live outside this checkout. Each task directory is digest-checked against the
# manifest before the arm, after the arm and after grading; any mismatch aborts without a row
# (exit 9). Sealed tasks (holdout) need GATE_D_INCLUDE_HOLDOUT=1, as r2 does, and are refused for
# local arms until an OS boundary hides the task root from them (see CORPUS.md). Rows take
# corpusRevision, holdout, family, split and trap from the verified meta.json and record the
# manifest digest as taskRevision, and gain the at-stop and pi verification-telemetry fields.
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
# Validate the supplied spelling before realpath, which collapses "file/.." and so would hide a
# lookup error (ENOTDIR, EACCES) in a component it removes.
WORKROOT_SPELLED="$WORKROOT"
# Absolute and physical, so a relative TMPDIR/GATE_D_WORKROOT or a symlink cannot slip past the
# inside-the-repo check below.
WORKROOT="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$WORKROOT")" || exit 3
if [ "${1:-}" = "--print-workroot" ]; then echo "$WORKROOT"; exit 0; fi
# Compare directory identities, not spellings: on a case-insensitive volume a differently
# capitalized path can name a directory inside the checkout. Walk from the nearest existing
# ancestor of WORKROOT up to / and refuse if any of them is the checkout itself (path-inside.py).
if ! python3 "$ROOT/path-inside.py" "$WORKROOT_SPELLED" "$REPO_ROOT" \
   || ! python3 "$ROOT/path-inside.py" "$WORKROOT" "$REPO_ROOT"; then
  echo "error: WORKROOT ($WORKROOT) resolves INSIDE the repo ($REPO_ROOT), or could not be checked — refusing to run (#172)." >&2
  echo "       set TMPDIR or GATE_D_WORKROOT to a path outside the checkout." >&2
  exit 3
fi
mkdir -p "$WORKROOT"

CORPUS_TOOL="$ROOT/gate_d_corpus.py"
# External task root (INFER-521). The corpus tool vets it (exists, is a directory, does not overlap
# this checkout) and prints its physical path; every later call passes that path explicitly.
EXTERNAL=0; TASKS_DIR="$ROOT/tasks"; MANIFEST_SHA=""
# The corpus tool, aimed at the external root and pinned to one manifest digest when there is one.
# A plain function rather than an argument array: an empty "${arr[@]}" is an unbound-variable error
# under `set -u` in bash < 4.4, which is still macOS's /bin/bash.
gd_corpus(){
  if [ "$EXTERNAL" != 1 ]; then python3 "$CORPUS_TOOL" "$@"
  elif [ -n "$MANIFEST_SHA" ]; then python3 "$CORPUS_TOOL" "$@" --tasks-root "$TASKS_DIR" --expect-manifest-sha "$MANIFEST_SHA"
  else python3 "$CORPUS_TOOL" "$@" --tasks-root "$TASKS_DIR"; fi
}
if [ -n "${GATE_D_TASKS_ROOT+set}" ]; then
  TASKS_DIR="$(python3 "$CORPUS_TOOL" root --tasks-root "$GATE_D_TASKS_ROOT")" || exit 3
  EXTERNAL=1
  # Work dirs stay outside the task root too (#172): an arm must not be able to discover the
  # oracle/ and solution/ siblings of its seed by walking up. Neither may contain the other.
  if ! python3 - "$WORKROOT" "$TASKS_DIR" <<'PY'
import os, sys
def inside(path, root):
    target = os.stat(root)
    while not os.path.exists(path):
        path = os.path.dirname(path)
    while True:
        st = os.stat(path)
        if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
            return True
        parent = os.path.dirname(path)
        if parent == path:
            return False
        path = parent
work, tasks = sys.argv[1], sys.argv[2]
sys.exit(1 if inside(work, tasks) or inside(tasks, work) else 0)
PY
  then
    echo "error: WORKROOT ($WORKROOT) and the external task root ($TASKS_DIR) overlap — refusing to run (#172)." >&2
    exit 3
  fi
  # Pin the manifest once: every later corpus-tool call, including the post-arm and post-grading
  # digest checks, parses exactly these bytes or fails. Without the pin, an arm could rewrite a
  # task AND its manifest digest and still get a row. A sweep passes the digest it enumerated, so a
  # manifest replaced mid-sweep cannot mix revisions either.
  MANIFEST_SHA="${GATE_D_EXPECT_MANIFEST_SHA:-}"
  [ -n "$MANIFEST_SHA" ] || MANIFEST_SHA="$(gd_corpus manifest-sha256)" || exit 3
  if ! gd_corpus revision >/dev/null; then
    echo "error: $TASKS_DIR/corpus-manifest.json changed since the sweep started; refusing to run" >&2
    exit 3
  fi
fi
if [ "${1:-}" = "--list-tasks" ]; then gd_corpus tasks; exit $?; fi
CORPUS_REVISION="$(gd_corpus revision)" || exit 3
TASK_IDS="$(gd_corpus tasks)" || { rc=$?; [ "$rc" = 9 ] || rc=3; exit "$rc"; }  # 9: a task failed its digest check

ARM="${1:?usage: run.sh <pi|aider|opencode|qwen-code> <task-id|all>}"
SEL="${2:?usage: run.sh <pi|aider|opencode|qwen-code> <task-id|all>}"
if [ "$EXTERNAL" = 1 ]; then
  # The tool prints why (unknown, or sealed without the opt-in).
  if [ "$SEL" != "all" ] && ! gd_corpus contains "$SEL"; then exit 3; fi
elif [ "$SEL" != "all" ] && ! python3 "$CORPUS_TOOL" contains "$SEL"; then
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
# check.sh, hardened for external corpora (see gate R3-io below): no code generation from strings
# and no tsx cache in any node process it starts.
# No network either: fetch and WebSocket are globals, reachable without an import or a name the
# R3-io gate bans (Codex review, INFER-521).
GRADING_NODE_OPTIONS="--disallow-code-generation-from-strings --no-experimental-fetch --no-experimental-websocket"
run_check(){
  if [ "$EXTERNAL" = 1 ]; then
    NODE_OPTIONS="$GRADING_NODE_OPTIONS${NODE_OPTIONS:+ $NODE_OPTIONS}" TSX_DISABLE_CACHE=1 \
      bash "$ROOT/check.sh" "$1" "$2" >"$2/.check.log" 2>&1
  else
    bash "$ROOT/check.sh" "$1" "$2" >"$2/.check.log" 2>&1
  fi
}
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
# The committed tree is the expected seed only for committed tasks; an external seed is the
# digest-verified directory itself, enumerated like a plain deployment.
SEED_FROM_GIT="$IN_GIT_CHECKOUT"; [ "$EXTERNAL" = 1 ] && SEED_FROM_GIT=0
metaget(){ python3 -c "import json;v=json.load(open('$1')).get('$2','');print(str(v).lower() if isinstance(v,bool) else v)"; }
metalist(){ python3 -c "import json;print(' '.join(json.load(open('$1')).get('$2',[])))"; }

# External tasks: digest-check the task directory against the manifest (INFER-521). This replaces
# the git-status fixture guard for the external root, which is not a checkout. On success it prints
# the row identity JSON; on any mismatch, missing file, symlink or sealed task without the opt-in it
# fails, and the caller aborts without writing a row, exactly as the fixture guard does.
verify_external(){ gd_corpus verify-task "$1"; }
# Re-verify after the arm or grading: the task must still match the pinned manifest AND yield the
# identity recorded before the run, so the row can never describe content other than what ran.
still_verified(){ local now; now="$(verify_external "$1")" && [ "$now" = "$2" ]; }
EXTERNAL_HINT="Restore the root from the generator (generate.py --check-manifest shows drift) before re-running."

# Runner configuration never reaches an arm: GATE_D_TASKS_ROOT would name the directory that holds
# the oracle/ and solution/ siblings of the seed.
GD_RUNNER_VARS="$(compgen -e | grep '^GATE_D_' | tr '\n' ' ')"

run_one() {
  local T="$1" id task_revision holdout identity=""; id=$(basename "$T")
  if [ "$EXTERNAL" = 1 ]; then
    if ! identity="$(verify_external "$id")"; then
      echo "FATAL[$ARM/$id]: the external task failed its manifest check before the run; no row written" >&2
      echo "$EXTERNAL_HINT" >&2
      exit 9
    fi
    task_revision=""; holdout=""   # taken from $identity when the row is written
    # Sealed tasks never run through a local arm without an OS boundary (Codex review, INFER-521).
    # A local arm runs as the operator, so it could read the task root's oracle/ and solution/ and
    # no digest check can see a read. Nothing here provides that boundary yet, so a sealed run is
    # refused unless the owner explicitly accepts an unisolated one for this invocation.
    if [ "$(printf %s "$identity" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("holdout") is True)')" = True ] \
       && [ "${GATE_D_ACCEPT_UNISOLATED_SEALED:-}" != 1 ]; then
      echo "error: $id is sealed, and a local arm could read the sealed corpus (no OS isolation is available)." >&2
      echo "       Sealed external tasks are refused; set GATE_D_ACCEPT_UNISOLATED_SEALED=1 only on an explicit owner decision (gate-d/CORPUS.md)." >&2
      exit 3
    fi
  else
    task_revision="$(metaget "$T/meta.json" corpusRevision)"; task_revision="${task_revision:-gate-d-r1}"
    holdout="$(metaget "$T/meta.json" holdout)"; holdout="${holdout:-false}"
  fi
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
  if [ "$SEED_FROM_GIT" = 1 ]; then
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
    if ! python3 - "$seed_actual_f" "$SEED_FROM_GIT" <<'PY'
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
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE $GD_RUNNER_VARS \
          && export GIT_CEILING_DIRECTORIES="$WORKROOT" \
          && HS_API_KEY="$GW_KEY" "$TIMEOUT_BIN" "$CAP_S" pi --provider "${PI_PROVIDER:-inference-gille}" --model "$MODEL" \
             --no-session --print --mode json ${PROMPT_FILE:+--append-system-prompt "$PROMPT_FILE"} "$instr" </dev/null 2>"$W/.arm.stderr.log" \
             | ( cd "$REPO_ROOT" && "$REPO_ROOT/node_modules/.bin/tsx" "$REPO_ROOT/scripts/pi-benchmark-telemetry.ts" \
                 --log "$W/.arm.log" --summary "$W/.arm-telemetry.json" ) ) || status="arm-error"
      # The recorder runs from the checkout, not from $W: tsx reads ./tsconfig.json, and an arm that
      # replaces the work dir's tsconfig.json with a FIFO would otherwise hang it (Codex review).
      ;;
    aider)
      ( cd "$W" \
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE $GD_RUNNER_VARS \
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
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE $GD_RUNNER_VARS \
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
          && unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE $GD_RUNNER_VARS \
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
  if [ "$EXTERNAL" = 1 ] && ! still_verified "$id" "$identity"; then
    echo "FATAL[$ARM/$id]: the external task changed on disk during this run; no row written (#172, INFER-521)" >&2
    echo "$EXTERNAL_HINT" >&2
    rm -rf "$W"; exit 9
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
  # External corpora: gate R3-io and the node hardening (code-battle gate-d-r3 io-gate.mjs, see
  # harbor/test.sh there; INFER-521; the copy lives under vendor/, see CORPUS.md). check.sh runs
  # the hidden oracle in the same process as the candidate's modules, so a module that can read
  # files could read the oracle at import time and tailor its answers. io-gate.mjs is a static,
  # non-executing import/identifier allowlist; a row passes only if it AND check.sh pass. A
  # violation is a model outcome (exitClass R3-io); a gate that cannot run (bad arguments, crash, no
  # typescript) is a runner failure (R3-io-error), never scored as incapability and never counted
  # by sweep.sh's resume or summary. It runs FIRST, before any candidate code executes (at-stop's
  # visible tests included; Codex review of INFER-521): a workspace whose modules could reach files,
  # processes or the module loader is never executed. Every node process that then runs candidate
  # code (at-stop and check.sh) runs with code generation from strings disabled, which closes
  # `(() => {}).constructor("…")`, and without the tsx cache. r1/r2 grading is unchanged.
  local io_failed=""
  if [ "$EXTERNAL" = 1 ]; then
    local io_rc=0
    node "$REPO_ROOT/vendor/code-battle-gate-d-r3/io-gate.mjs" "$REPO_ROOT/node_modules" "$T/repo" "$W" >"$W/.check.log" 2>&1 || io_rc=$?
    if [ "$io_rc" -ne 0 ]; then
      if [ "$io_rc" = 1 ] && grep -q '^FAIL\[R3-io\]' "$W/.check.log"; then io_failed="R3-io"
      else
        io_failed="R3-io-error"
        echo "  [warn] $id: the R3-io gate could not run (exit $io_rc); the row is a runner failure, not a model result" >&2
      fi
    fi
  fi
  # Grader-derived verification metric (INFER-521, CBATTLE-14 §3): re-run the checks the agent had
  # (tsc, and tsx --test when the task ships visible tests) on the workspace exactly as the arm left
  # it, BEFORE check.sh stages the hidden oracle. External corpora only, so r1/r2 rows keep their
  # schema. Pure observation: it runs with the arm's Git isolation, its output is whitelisted when
  # the row is built, and any failure, timeout or missing script yields '{}' and never changes
  # pass/fail. at-stop.sh is this repository's pinned copy of the corpus script (see its header).
  # It runs on a throwaway copy of the work dir, so files a candidate's visible tests leave behind
  # cannot reach check.sh: "never changes pass/fail" holds structurally, not by convention.
  # Order (Codex review of INFER-521): first the non-executing scope check, the same write
  # allowlist as check.sh's G0-files gate. A workspace that grading will reject anyway (for example
  # a rewritten package.json test script) is never executed; its at-stop fields stay null. Then the
  # copy runs with a minimal environment: no inherited credentials or tokens, and a throwaway HOME.
  local AT_STOP_JSON="{}" AT_STOP_W="" AT_STOP_HOME="" at_stop_skip="" special_file="" scope_rc=0
  if [ "$EXTERNAL" = 1 ]; then
    python3 "$CORPUS_TOOL" scope-check "$T" --work "$W" 2>/dev/null || scope_rc=$?
    if [ "$scope_rc" = 3 ]; then
      # A FIFO, socket or device in the workspace: neither at-stop nor check.sh may read it, since
      # a read could block outside every timeout. The run fails G0-files without being graded.
      special_file=1
      at_stop_skip="the workspace holds a special file, so it is not graded"
    elif [ -n "$io_failed" ]; then
      at_stop_skip="gate $io_failed failed, so no candidate code is executed"
    elif [ "$scope_rc" != 0 ]; then
      at_stop_skip="out-of-scope changes (grading will reject them)"
    elif [ ! -f "$ROOT/at-stop.sh" ]; then
      at_stop_skip="gate-d/at-stop.sh is missing"
    elif AT_STOP_W="$(mktemp -d "$WORKROOT/${id}-atstop-XXXX")" \
         && AT_STOP_HOME="$(mktemp -d "$WORKROOT/${id}-atstop-home-XXXX")" \
         && cp -R "$W/." "$AT_STOP_W/" && rm -rf "$AT_STOP_W/.git"; then
      # No .git in the copy: R3-io and the scope check never inspect it, so a module placed there
      # could otherwise be imported and executed by the visible tests (Codex review, INFER-521).
      AT_STOP_JSON="$( cd "$AT_STOP_W" && env -i PATH="$PATH" HOME="$AT_STOP_HOME" TMPDIR="$AT_STOP_HOME" \
          LANG="${LANG:-C}" GIT_CEILING_DIRECTORIES="$WORKROOT" AT_STOP_CAP_S="${AT_STOP_CAP_S:-120}" \
          AT_STOP_TOOLCHAIN="$REPO_ROOT/node_modules" TSX_DISABLE_CACHE=1 \
          NODE_OPTIONS="$GRADING_NODE_OPTIONS" \
          "$TIMEOUT_BIN" "${AT_STOP_WALL_S:-300}" bash "$ROOT/at-stop.sh" "$T" "$AT_STOP_W" </dev/null 2>/dev/null )" \
        || AT_STOP_JSON="{}"
    fi
    [ -n "$AT_STOP_W" ] && rm -rf "$AT_STOP_W"
    [ -n "$AT_STOP_HOME" ] && rm -rf "$AT_STOP_HOME"
    [ -n "$AT_STOP_JSON" ] || AT_STOP_JSON="{}"
    if [ "$AT_STOP_JSON" = "{}" ]; then
      echo "  [warn] $id: at-stop fields are null for this row (${at_stop_skip:-at-stop.sh failed, timed out or printed nothing})" >&2
    fi
  fi
  local pass="false" exitclass="$status"
  if [ "$io_failed" = "R3-io-error" ]; then
    # A grader failure wins over the arm status: the row is ungraded whatever the arm did, and
    # sweep.sh both resets the model after it and leaves the seed open (Codex review, INFER-521).
    exitclass="R3-io-error"
  elif [ -n "$special_file" ]; then
    if [ "$status" = "arm-error" ]; then exitclass="arm-error"; else exitclass="G0-files"; fi
  elif [ -n "$io_failed" ]; then
    if [ "$status" = "arm-error" ]; then exitclass="arm-error"; else exitclass="$io_failed"; fi
  elif run_check "$T" "$W"; then pass="true"; exitclass="pass"
  elif [ "$status" = "arm-error" ]; then exitclass="arm-error"
  else
    # Extract the gate id from the `FAIL[G3-tsc]: ...` line (check.sh prints `--- tsc ---`
    # headers BEFORE it, so head -1 would grab the wrong line).
    exitclass="$(grep -m1 -oE 'FAIL\[[^]]+\]' "$W/.check.log" | sed 's/^FAIL\[//; s/\]$//')"
    [ -n "$exitclass" ] || exitclass="check-fail"
  fi
  # Grading reads the task directory (hidden oracle, structural check) and at-stop.sh ran candidate
  # code: re-verify, so a verdict is never recorded against a task that changed underneath it.
  if [ "$EXTERNAL" = 1 ] && ! still_verified "$id" "$identity"; then
    echo "FATAL[$ARM/$id]: the external task changed on disk during grading; no row written (INFER-521)" >&2
    echo "$EXTERNAL_HINT" >&2
    rm -rf "$W"; [ -n "$TRANSCRIPT" ] && rm -f "$TRANSCRIPT"; exit 9
  fi
  # Emit the result row via env vars (not shell-interpolation into the Python source): the prior
  # form injected the bash bareword `true`/`false` as a Python name → NameError, dropping the row.
  GD_ARM="$ARM" GD_MODEL="$MODEL" GD_TASK="$id" GD_PASS="$pass" GD_EXIT="$exitclass" GD_WALL="$((t1-t0))" \
    GD_CORPUS_REVISION="$CORPUS_REVISION" GD_TASK_REVISION="$task_revision" GD_HOLDOUT="$holdout" \
    GD_TELEMETRY="$([ "$ARM" = pi ] && printf %s "$W/.arm-telemetry.json")" \
    GD_PEEK="$PEEK_JSON" GD_PROMPT_VARIANT="$PROMPT_VARIANT" GD_PROMPT_SHA="$PROMPT_SHA" \
    GD_EXTERNAL="$EXTERNAL" GD_IDENTITY="$identity" GD_AT_STOP="$AT_STOP_JSON" \
    python3 -c "import json,os
row={'arm':os.environ['GD_ARM'],'model':os.environ['GD_MODEL'],'task':os.environ['GD_TASK'],'corpusRevision':os.environ['GD_CORPUS_REVISION'],'taskRevision':os.environ['GD_TASK_REVISION'],'holdout':os.environ['GD_HOLDOUT']=='true','pass':os.environ['GD_PASS']=='true','exitClass':os.environ['GD_EXIT'],'wallS':int(os.environ['GD_WALL'])}
keys=('turns','toolCalls','promptTokens','completionTokens','modelTurnMs','timedModelTurns','assistantStreamMs','timedAssistantMessages','unparseableLines')
telemetry={k:None for k in keys}
p=os.environ.get('GD_TELEMETRY',''); raw={}
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
if os.environ.get('GD_EXTERNAL')=='1':
    # INFER-521: identity from the digest-verified meta.json, then the two verification metrics.
    # Every field is present on every external row (null = not measured), and only whitelisted
    # enums, counters and booleans are copied, so the row stays content-blind.
    ident=json.loads(os.environ['GD_IDENTITY'])
    for k in ('corpusRevision','taskRevision','holdout','family','split','trap'): row[k]=ident.get(k)
    def pick(src,spec):
        out={}
        for k,allowed in spec.items():
            v=src.get(k) if isinstance(src,dict) else None
            if allowed is int: ok=isinstance(v,int) and not isinstance(v,bool) and v>=0
            elif allowed is bool: ok=isinstance(v,bool)
            elif allowed=='turn': ok=v is None or (isinstance(v,int) and not isinstance(v,bool) and v>=0)
            else: ok=isinstance(v,str) and v in allowed
            out[k]=v if ok else None
        return out
    try: at=json.loads(os.environ.get('GD_AT_STOP') or '{}')
    except Exception: at={}
    row.update(pick(at,{'atStopTypecheck':('passed','failed'),'atStopVisibleTests':('passed','failed','none'),'detectableFailureAtStop':bool}))
    outcome=('passed','failed','unknown')
    vspec={'verificationClass':('no-edit','never-checked','checked-before-last-edit-only','stopped-on-red','checked-green-after-last-edit','checked-after-last-edit-unknown'),
           'typecheckRuns':int,'testRuns':int,'typecheckAfterLastEdit':bool,'testsAfterLastEdit':bool,
           'lastTypecheckOutcome':outcome,'lastTestOutcome':outcome,'stoppedWithFailingCheck':bool,
           'ambiguousCheckOutcomes':int,'firstEditTurn':'turn','lastEditTurn':'turn','edits':int}
    ver=raw.get('verification') if p and isinstance(raw,dict) else None
    ok=isinstance(ver,dict) and ver.get('schema')=='gate-d-r3/verification-telemetry@1'
    # verificationSchema is the measured/not-measured flag: several fields are legitimately null
    # when measured (no check ran, no edit happened), so null alone cannot say \"not measured\".
    row['verificationSchema']=ver['schema'] if ok else None
    row.update(pick(ver if ok else {},vspec))
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
  for id in $TASK_IDS; do run_one "$TASKS_DIR/$id"; done
else
  run_one "$TASKS_DIR/$SEL"
fi
