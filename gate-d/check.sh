#!/usr/bin/env bash
# Gate D deterministic verifier — NO model in the grading path.
# Usage: check.sh <TASKDIR> <WORKDIR>
#   TASKDIR = gate-d/tasks/<id>      (has meta.json + repo/ pristine seed + INSTRUCTION.md)
#   WORKDIR = the repo copy to grade (after a harness arm has edited it)
# Exit 0 = task complete (all gates pass). Non-zero = FAIL (prints which gate failed).
#
# Gates: G0 edit/runtime/toolchain integrity · G1 oracle files unchanged vs seed (anti-cheat) ·
#        G2 an edit-target actually changed · G3 typecheck (tsc) · G4 oracle script exits 0 ·
#        G5 task-specific structural/runtime assertion · G6 meaningful TDD assertion coverage.
set -u
export GATE_D_ROOT="$(cd "$(dirname "$0")" && pwd)"
TASKDIR="${1:?usage: check.sh <TASKDIR> <WORKDIR>}"
WORK="${2:?usage: check.sh <TASKDIR> <WORKDIR>}"
SEED="$TASKDIR/repo"
META="$TASKDIR/meta.json"
j()  { python3 -c "import json;print(json.load(open('$META')).get('$1',''))"; }
jl() { python3 -c "import json;print('\n'.join(json.load(open('$META')).get('$1',[])))"; }
fail(){ echo "FAIL[$1]: $2"; exit 1; }

is_declared_edit(){
  local candidate="$1" allowed
  while IFS= read -r allowed; do
    [ -n "$allowed" ] && [ "$candidate" = "$allowed" ] && return 0
  done < <(jl edit)
  return 1
}

# G0a — the task manifest is the write allowlist. The agent runtimes operate in a real worktree
# and can create helper files, so checking only the declared targets would let an unlisted imported
# helper interfere with the oracle. Harness-owned git metadata and log captures are the only
# exceptions; a hidden oracle path is also harmless because Hugin overwrites it below before use.
HIDDEN="$(j hiddenOracle)"
ORACLE="$(j oracleCmd)"
EXPECTED_NODE_MODULES="$(cd "$(dirname "$0")/.." && pwd -P)/node_modules"
[ -L "$WORK/node_modules" ] && [ "$(readlink "$WORK/node_modules")" = "$EXPECTED_NODE_MODULES" ] \
  || fail G0-toolchain "node_modules must remain the harness-owned symlink to $EXPECTED_NODE_MODULES"
while IFS= read -r f; do [ -z "$f" ] && continue
  case "$f" in .arm.log|.check.log) continue;; esac
  [ -n "$HIDDEN" ] && [ "$f" = "$ORACLE" ] && continue
  if [ -L "$SEED/$f" ] || [ -L "$WORK/$f" ]; then
    [ -L "$SEED/$f" ] && [ -L "$WORK/$f" ] &&
      [ "$(readlink "$SEED/$f")" = "$(readlink "$WORK/$f")" ] && continue
  elif [ -f "$SEED/$f" ] || [ -f "$WORK/$f" ]; then
    cmp -s "$SEED/$f" "$WORK/$f" && continue
  else
    continue
  fi
  is_declared_edit "$f" || fail G0-files "$f changed outside the task's declared edit targets"
done < <(
  { (cd "$SEED" && find . \( -path './.git' -o -path './node_modules' \) -prune -o \( -type f -o -type l \) -print)
    (cd "$WORK" && find . \( -path './.git' -o -path './node_modules' \) -prune -o \( -type f -o -type l \) -print); } |
    sed 's#^\./##' | sort -u
)

# G0b — no type/lint-suppression escape hatches in the edited files. Without this, a single
# `// @ts-nocheck` line makes tsc skip the file → the tsGate (G3) passes on untyped JS.
while IFS= read -r f; do [ -z "$f" ] && continue
  [ -f "$WORK/$f" ] || continue
  grep -nE '@ts-(nocheck|ignore|expect-error)|eslint-disable' "$WORK/$f" >/dev/null 2>&1 \
    && fail G0-suppression "$f uses a type/lint-suppression directive (@ts-nocheck/@ts-ignore/eslint-disable)"
done < <(jl edit)

# G0c — edited code must not terminate or rewrite the trusted Node verifier runtime. A candidate
# `process.exit(0)` or mutation of Node's shared assert/test objects can otherwise make an oracle
# stop early with a false green exit code.
while IFS= read -r f; do [ -z "$f" ] && continue
  [ -f "$WORK/$f" ] || continue
  node "$(dirname "$0")/check-runtime-integrity.mjs" "$WORK/$f" \
    >/tmp/gd-runtime.$$ 2>&1 \
    || { cat /tmp/gd-runtime.$$; rm -f /tmp/gd-runtime.$$; fail G0-runtime "$f can interfere with the trusted verifier runtime"; }
done < <(jl edit)
rm -f /tmp/gd-runtime.$$

# G1 — oracle files byte-identical to the pristine seed (the harness must not edit them)
while IFS= read -r f; do [ -z "$f" ] && continue
  diff -q "$SEED/$f" "$WORK/$f" >/dev/null 2>&1 || fail G1-oracle-tampered "$f differs from seed"
done < <(jl oracleFiles)

# G2 — at least one declared edit-target changed vs seed (real work happened, not a no-op)
changed=0
while IFS= read -r f; do [ -z "$f" ] && continue
  diff -q "$SEED/$f" "$WORK/$f" >/dev/null 2>&1 || changed=1
done < <(jl edit)
[ "$changed" = 1 ] || fail G2-no-edit "no edit-target changed vs seed"

# Hidden-oracle support: if a task declares one, stage it into WORK at oracleCmd BEFORE the
# typecheck (the harness never sees it — used by the TDD task so a vacuous self-test can't pass).
if [ -n "$HIDDEN" ]; then
  mkdir -p "$WORK/$(dirname "$ORACLE")"
  cp "$TASKDIR/$HIDDEN" "$WORK/$ORACLE" || fail G4-hidden "could not stage hidden oracle"
fi

# G3 — typecheck (tsGate). tsc/tsx resolve via node_modules — either by walking up from WORK (if
# it lives under the repo) or via the symlink run.sh/verify-fixtures.sh place at $WORK/node_modules
# (#172: WORK now lives outside the repo tree, so there's no ancestor to walk up into).
( cd "$WORK" && npx --no-install tsc --noEmit -p tsconfig.json ) >/tmp/gd-tsc.$$ 2>&1 \
  || { echo "--- tsc ---"; cat /tmp/gd-tsc.$$; rm -f /tmp/gd-tsc.$$; fail G3-tsc "typecheck failed"; }
rm -f /tmp/gd-tsc.$$

# G4 — oracle runtime assertions (exit 0 = green)
( cd "$WORK" && npx --no-install tsx "$ORACLE" ) >/tmp/gd-or.$$ 2>&1 \
  || { echo "--- oracle ---"; cat /tmp/gd-or.$$; rm -f /tmp/gd-or.$$; fail G4-oracle "oracle assertions failed"; }
rm -f /tmp/gd-or.$$

# G5 — task-specific structural assertion (bash expression evaluated inside WORK).
# Default a missing/empty value to `true` (explicit no-op) so an omitted key can't silently
# turn G5 into eval "" (which would always pass).
STRUCT="$(j structural)"; STRUCT="${STRUCT:-true}"
( cd "$WORK" && eval "$STRUCT" ) >/dev/null 2>&1 || fail G5-structural "structural check failed: $STRUCT"

# G6 — optional AST-backed TDD assertion gate. This counts assertion CALL SITES rather than lines,
# understands common node:test callbacks plus statically sized for-of/forEach tables, and requires
# the named subject call to be inside the assertion. Vacuous asserts plus an unused subject call
# therefore cannot satisfy the task.
ASSERT_GATE="$(j testAssertionGate)"
if [ -n "$ASSERT_GATE" ] && [ "$ASSERT_GATE" != "{}" ]; then
  ASSERT_FILE="$(python3 -c "import json;print(json.load(open('$META'))['testAssertionGate']['file'])")"
  ASSERT_SUBJECT="$(python3 -c "import json;print(json.load(open('$META'))['testAssertionGate']['subject'])")"
  ASSERT_MINIMUM="$(python3 -c "import json;print(json.load(open('$META'))['testAssertionGate']['minimum'])")"
  node "$(dirname "$0")/check-test-assertions.mjs" "$WORK/$ASSERT_FILE" "$ASSERT_SUBJECT" "$ASSERT_MINIMUM" \
    >/tmp/gd-assert.$$ 2>&1 \
    || { cat /tmp/gd-assert.$$; rm -f /tmp/gd-assert.$$; fail G6-assertions "$ASSERT_FILE lacks $ASSERT_MINIMUM meaningful $ASSERT_SUBJECT assertions"; }
  rm -f /tmp/gd-assert.$$
fi

echo "PASS"
