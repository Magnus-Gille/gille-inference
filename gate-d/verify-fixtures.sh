#!/usr/bin/env bash
# Build-time self-test — proves every Gate D fixture grades correctly WITHOUT any model.
# Per task: (1) check.sh FAILs at the seed, (2) [if seedOracleRed != false] the oracle is
# genuinely RED at the seed (not just "no edit yet"), (3) check.sh PASSes with the reference
# solution. Plus anti-cheat regressions for the gaming vectors found in review, and a #172
# work-dir-isolation regression at the end (fixtures must never be reachable from a work dir).
# Slow/local validation may shard without changing default coverage: GATE_D_VERIFY_TASKS is a
# whitespace-separated r2 subset; GATE_D_VERIFY_PHASE is all|fixtures|anti-cheat (default all).
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
# Work dirs live OUTSIDE the repo tree (#172 — see run.sh for the full incident writeup), so a
# node_modules symlink stands in for the ancestor-directory walk `npx --no-install` relies on.
WORKROOT="${GATE_D_WORKROOT:-${TMPDIR:-/tmp}/gate-d-work}"; mkdir -p "$WORKROOT"
pass=0; fail=0
VERIFY_PHASE="${GATE_D_VERIFY_PHASE:-all}"
case "$VERIFY_PHASE" in all|fixtures|anti-cheat) ;; *) echo "invalid GATE_D_VERIFY_PHASE: $VERIFY_PHASE" >&2; exit 2;; esac
g(){ python3 -c "import json;v=json.load(open('$1')).get('$2','');print(str(v).lower() if isinstance(v,bool) else v)"; }

# ── Immutable r1 tree pin ───────────────────────────────────────────────────────────────
contract_pass=0; contract_fail=0
echo "── corpus contract ──"
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  PINNED_COMMIT="$(python3 -c "import json;print(json.load(open('$ROOT/corpus.json'))['revisions']['gate-d-r1']['pinnedCommit'])")"
  PINNED_TREE="$(python3 -c "import json;print(json.load(open('$ROOT/corpus.json'))['revisions']['gate-d-r1']['pinnedTaskTree'])")"
  R1_TASKS="$(python3 "$ROOT/gate_d_corpus.py" tasks --revision gate-d-r1)"
  R1_PATHS=""
  for id in $R1_TASKS; do R1_PATHS="$R1_PATHS gate-d/tasks/$id"; done
  UNTRACKED_R1="$(git -C "$REPO_ROOT" ls-files --others --exclude-standard -- $R1_PATHS 2>/dev/null || true)"
  task_tree_at_ref(){
    local ref="$1" spec line prefix mode rest type sha path_part name id tree
    spec="$(mktemp "$WORKROOT/r1-tree-XXXX")" || return 1
    for id in $R1_TASKS; do
      line="$(git -C "$REPO_ROOT" ls-tree "$ref" "gate-d/tasks/$id")" || { rm -f "$spec"; return 1; }
      [ -n "$line" ] || { rm -f "$spec"; return 1; }
      prefix="${line%%$'\t'*}"; mode="${prefix%% *}"; rest="${prefix#* }"
      type="${rest%% *}"; sha="${rest##* }"; path_part="${line#*$'\t'}"; name="${path_part##*/}"
      printf '%s %s %s\t%s\n' "$mode" "$type" "$sha" "$name" >> "$spec"
    done
    tree="$(git -C "$REPO_ROOT" mktree < "$spec")"; local status=$?; rm -f "$spec"
    [ "$status" = 0 ] || return "$status"
    printf '%s\n' "$tree"
  }
  PINNED_COMMIT_TREE=""
  PINNED_COMMIT_VALID=1
  git -C "$REPO_ROOT" cat-file -e "$PINNED_COMMIT^{commit}" 2>/dev/null || PINNED_COMMIT_VALID=0
  [ "$PINNED_COMMIT_VALID" = 0 ] || PINNED_COMMIT_TREE="$(task_tree_at_ref "$PINNED_COMMIT")" || PINNED_COMMIT_VALID=0
  CURRENT_R1_TREE="$(task_tree_at_ref HEAD)"
  if [ "$PINNED_COMMIT_VALID" = 0 ]; then
    echo "✗ pinned gate-d-r1 commit $PINNED_COMMIT is missing or has an incomplete task tree"; contract_fail=$((contract_fail+1))
  elif [ "$PINNED_COMMIT_TREE" != "$PINNED_TREE" ]; then
    echo "✗ pinned commit $PINNED_COMMIT hashes tasks 01–10 to $PINNED_COMMIT_TREE, not pinned tree $PINNED_TREE"; contract_fail=$((contract_fail+1))
  elif ! git -C "$REPO_ROOT" diff --quiet HEAD -- $R1_PATHS || [ -n "$UNTRACKED_R1" ]; then
    echo "✗ tasks 01–10 differ from pinned gate-d-r1 tree $PINNED_TREE"; contract_fail=$((contract_fail+1))
  elif [ "$CURRENT_R1_TREE" != "$PINNED_TREE" ]; then
    echo "✗ tasks 01–10 hash to $CURRENT_R1_TREE, expected pinned tree $PINNED_TREE"; contract_fail=$((contract_fail+1))
  else
    echo "✓ tasks 01–10 match pinned gate-d-r1 tree $PINNED_TREE"; contract_pass=$((contract_pass+1))
  fi
else
  if [ "${GATE_D_STRICT_PIN:-0}" = 1 ]; then
    echo "✗ cannot enforce gate-d-r1 tree pin outside a git checkout (GATE_D_STRICT_PIN=1)"; contract_fail=$((contract_fail+1))
  else
    echo "⚠ gate-d-r1 tree pin skipped outside a git checkout (CI enforces it; set GATE_D_STRICT_PIN=1 to require locally)"
  fi
fi
DEFAULT_TASKS="$(python3 "$ROOT/gate_d_corpus.py" tasks)"
HOLDOUT_TASKS="$(GATE_D_INCLUDE_HOLDOUT=1 python3 "$ROOT/gate_d_corpus.py" tasks)"
if [ "$(printf '%s\n' $DEFAULT_TASKS | wc -l | tr -d ' ')" = 10 ] && \
   [ "$(printf '%s\n' $HOLDOUT_TASKS | wc -l | tr -d ' ')" = 14 ]; then
  echo "✓ default enumeration is r1 (10); explicit holdout enumeration is r2 (14)"; contract_pass=$((contract_pass+1))
else
  echo "✗ corpus enumeration cardinality drifted"; contract_fail=$((contract_fail+1))
fi
echo "──── $contract_pass passed, $contract_fail failed ────"
if [ "${GATE_D_CONTRACT_ONLY:-0}" = 1 ]; then
  [ "$contract_fail" = 0 ]
  exit $?
fi

# Fixture verification intentionally covers the complete authored r2 corpus without invoking a
# model. Routine model consumers remain on r1 unless they opt in explicitly.
ALL_TASKS="${GATE_D_VERIFY_TASKS:-$(python3 "$ROOT/gate_d_corpus.py" tasks --revision gate-d-r2)}"
task_selected(){
  local candidate
  for candidate in $ALL_TASKS; do [ "$candidate" = "$1" ] && return 0; done
  return 1
}
if [ "$VERIFY_PHASE" != "anti-cheat" ]; then
for id in $ALL_TASKS; do
  T="$ROOT/tasks/$id"
  oracle=$(g "$T/meta.json" oracleCmd)
  hidden=$(g "$T/meta.json" hiddenOracle)
  seedred=$(g "$T/meta.json" seedOracleRed); [ -z "$seedred" ] && seedred="true"
  W=$(mktemp -d "$WORKROOT/${id}-XXXX"); cp -r "$T/repo/." "$W/"; ln -s "$REPO_ROOT/node_modules" "$W/node_modules"
  ok=1
  # (1) check.sh must FAIL at the seed
  bash "$ROOT/check.sh" "$T" "$W" >/dev/null 2>&1 && { echo "✗ $id: check.sh PASSES at seed"; ok=0; }
  # (2) the oracle itself must be RED at seed (copy a hidden oracle in first); skip for refactor tasks
  if [ "$seedred" != "false" ] && [ "$ok" = 1 ]; then
    [ -n "$hidden" ] && { mkdir -p "$W/$(dirname "$oracle")"; cp "$T/$hidden" "$W/$oracle"; }
    if ( cd "$W" && npx --no-install tsx "$oracle" ) >/dev/null 2>&1; then echo "✗ $id: seed oracle PASSES (trivial)"; ok=0; fi
    cp -r "$T/repo/." "$W/"   # restore (we may have copied the hidden oracle in)
  fi
  # (3) check.sh must PASS with the reference solution
  cp -r "$T/solution/." "$W/"
  if out=$(bash "$ROOT/check.sh" "$T" "$W" 2>&1); then :; else echo "✗ $id: reference solution fails check.sh:"; echo "$out" | sed 's/^/    /'; ok=0; fi
  [ "$ok" = 1 ] && { echo "✓ $id"; pass=$((pass+1)); } || fail=$((fail+1))
  rm -rf "$W"
done
fi

# ── Anti-cheat regressions (gaming vectors found by adversarial review; must FAIL) ──
if [ "$VERIFY_PHASE" != "fixtures" ]; then
echo "── anti-cheat ──"
cheat(){ # <name> <taskid> <setup-fn>; expects check.sh to FAIL after setup
  local name="$1" tid="$2" fn="$3"
  task_selected "$tid" || return
  local W; W=$(mktemp -d "$WORKROOT/cheat-XXXX"); cp -r "$ROOT/tasks/$tid/repo/." "$W/"; ln -s "$REPO_ROOT/node_modules" "$W/node_modules"
  "$fn" "$W"
  if bash "$ROOT/check.sh" "$ROOT/tasks/$tid" "$W" >/dev/null 2>&1; then echo "✗ cheat $name PASSED"; fail=$((fail+1)); else echo "✓ cheat $name rejected"; pass=$((pass+1)); fi
  rm -rf "$W"
}
c_nocheck(){ printf '// @ts-nocheck\nexport function sum(xs){ let s=0; for (const x of xs) s+=x; return s; }\n' > "$1/src/sum.ts"; }
c_inline(){ cp "$ROOT/tasks/03-impl-fn-across-2-files/solution/src/geo.ts" "$1/src/geo.ts"
  cat > "$1/src/index.ts" <<'IDX'
import type { Point } from "./geo.ts";
export function nearest(p: Point, candidates: Point[]): Point {
  const d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y); // inlined, never imports distance
  let best = candidates[0]!, bd = d(p, best);
  for (const c of candidates.slice(1)) { const x = d(p, c); if (x < bd) { bd = x; best = c; } }
  return best;
}
IDX
}
c_04(){ # inline JSON in cli.ts + a vacuous `// formatJson` comment — must fail (oracle imports formatJson)
  printf 'export interface Row { name: string; value: number }\n// formatJson\nexport function formatText(rows: Row[]): string { return rows.map((r)=>`${r.name}: ${r.value}`).join("\\n"); }\n' > "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string { return argv.includes("--json") ? JSON.stringify(DATA) : formatText(DATA); }
CLI
}
c_10(){ # fix the caller locally instead of the shared util — must fail (G1 pins the callers)
  printf '\n// touched\n' >> "$1/src/util.ts"
  cat > "$1/src/key.ts" <<'KEY'
import { clean } from "./util.ts";
export function key(s: string): string { return clean(s).trim(); }
KEY
}
c_12(){ # call formatCsv only in a dead helper while run() inlines CSV — oracle passes, G5 must fail
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
function deadHelper(): string { return formatCsv(DATA); }
void deadHelper;
export function run(argv: string[]): string {
  return argv.includes("--csv")
    ? ["name,value", ...DATA.map((row) => `${row.name},${row.value}`)].join("\n")
    : formatText(DATA);
}
CLI
}
c_12_discard(){ # call formatCsv but discard its value while run() still inlines CSV — must fail
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string {
  void formatCsv(DATA);
  return argv.includes("--csv")
    ? ["name,value", ...DATA.map((row) => `${row.name},${row.value}`)].join("\n")
    : formatText(DATA);
}
CLI
}
c_13(){ # correct implementation + vacuous tests and unused slugify call — hidden oracle passes, G6 fails
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";
slugify("not asserted");
assert.equal(1, 1); assert.equal(true, true); assert.strictEqual("x", "x");
TEST
}
c_13_wrong(){ # three real slugify assertions with wrong expectations — G6 passes, visible G5 test must fail
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";
assert.equal(slugify("Hello World"), "wrong");
assert.ok(slugify("Two words") === "also-wrong");
assert.match(slugify("A B"), /^never$/);
TEST
}
c_13_fake_runner(){ # fake callback is never executed — visible command passes, G6 must reject it
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";
function test(_name: string, _callback: () => void): void {}
test("slug", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("A B"), "a-b");
  assert.equal(slugify("already-ok"), "already-ok");
});
TEST
}
c_13_fake_assert(){ # real node:test callback uses no-op local assertions — G6 must reject it
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import { test } from "node:test";
import { slugify } from "../src/slugify.ts";
const assert = { equal(..._args: unknown[]): void {} };
test("slug", () => {
  assert.equal(slugify("Hello World"), "hello-world");
  assert.equal(slugify("A B"), "a-b");
  assert.equal(slugify("already-ok"), "already-ok");
});
TEST
}
c_13_loop_inflation(){ # one invariant assertion repeated by a constant loop is one case, not three
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";
[1, 2, 3].forEach(() => assert.equal(slugify("same"), "same"));
TEST
}
c_13_expected_loop_inflation(){ # varying only the expected value does not exercise three inputs
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";
for (const expected of ["same", "same", "same"]) {
  assert.equal(slugify("same"), expected);
}
TEST
}
c_13_exclusive_branch_inflation(){ # only one branch executes, so three alternatives are one case
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const branch = Date.now() % 3;
if (branch === 0) assert.equal(slugify("a"), "a");
else if (branch === 1) assert.equal(slugify("b"), "b");
else assert.equal(slugify("c"), "c");
TEST
}
c_13_short_circuit_subject(){ # subject is never called behind an unknown-to-the-analyzer false binding
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const run = false;
assert.equal(run && slugify("a"), false);
assert.equal(run && slugify("b"), false);
assert.equal(run && slugify("c"), false);
TEST
}
c_13_returned_callback(){ # statements after return are syntactic only, never execution evidence
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.ts";
test("dead assertions", () => {
  return;
  assert.equal(slugify("a"), "a");
  assert.equal(slugify("b"), "b");
  assert.equal(slugify("c"), "c");
});
TEST
}
c_13_dead_loops(){ # statically false loop bodies never execute
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
while (false) {
  assert.equal(slugify("a"), "a");
  assert.equal(slugify("b"), "b");
}
for (; false;) assert.equal(slugify("c"), "c");
TEST
}
c_13_empty_iterable(){ # an unknown iterable may be empty, so its guaranteed lower bound is zero
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const xs = new Set<string>();
for (const x of xs) {
  assert.equal(slugify(x), x);
  assert.equal(slugify(x), x);
  assert.equal(slugify(x), x);
}
TEST
}
c_13_conditional_switch_break(){ # a possible break makes fallthrough assertions non-guaranteed
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const guard = true;
switch (0) {
  case 0: if (guard) break;
  default:
    assert.equal(slugify("a"), "a");
    assert.equal(slugify("b"), "b");
    assert.equal(slugify("c"), "c");
}
TEST
}
c_13_mutated_array(){ # cardinality proof is invalidated when the table escapes to a mutator
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const rows = ["a", "b", "c"];
function wipe(values: string[]): void { values.length = 0; }
wipe(rows);
for (const row of rows) assert.equal(slugify(row), row);
TEST
}
c_13_shadow_assert(){ # authentic import is shadowed by a no-op assertion receiver
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
{
  const assert = { equal(..._args: unknown[]): void {} };
  assert.equal(slugify("a"), "a");
  assert.equal(slugify("b"), "b");
  assert.equal(slugify("c"), "c");
}
TEST
}
c_13_shadow_subject(){ # authentic subject import is shadowed by a local fake
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
{
  const slugify = (value: string): string => value;
  assert.equal(slugify("a"), "a");
  assert.equal(slugify("b"), "b");
  assert.equal(slugify("c"), "c");
}
TEST
}
c_13_shadow_runner(){ # authentic node:test runner is shadowed and never invokes its callback
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.ts";
{
  const test = (_name: string, _callback: () => void): void => {};
  test("fake", () => {
    assert.equal(slugify("a"), "a");
    assert.equal(slugify("b"), "b");
    assert.equal(slugify("c"), "c");
  });
}
TEST
}
c_13_skipped_runner(){ # string skip/todo reasons disable or de-enforce node:test callbacks
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.ts";
test("skipped assertions", { skip: "not yet" }, () => {
  assert.equal(slugify("a"), "a");
  assert.equal(slugify("b"), "b");
  assert.equal(slugify("c"), "c");
});
test("todo assertions", { todo: "not yet" }, () => {
  assert.equal(slugify("a"), "wrong");
  assert.equal(slugify("b"), "wrong");
  assert.equal(slugify("c"), "wrong");
});
test("context-disabled assertions", (t) => {
  assert.equal(slugify("a"), "wrong");
  t.skip("not yet");
  assert.equal(slugify("b"), "wrong");
  assert.equal(slugify("c"), "wrong");
});
TEST
}
c_13_optional_chain(){ # optional-chain call arguments never run when the base is nullish
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const maybe: any = undefined;
assert.equal(maybe?.fn(slugify("a")), undefined);
assert.equal(maybe?.["fn"](slugify("b")), undefined);
assert.equal(maybe?.fn(slugify("c")), undefined);
TEST
}
c_13_sparse_for_each(){ # Array#forEach skips holes even though the array length is three
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const rows: string[] = [,,,];
rows.forEach((row) => assert.equal(slugify(row), row));
TEST
}
c_13_overridden_for_each(){ # a reassigned forEach method does not invoke the supplied callback
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const rows = ["a", "b", "c"];
rows.forEach = () => {};
rows.forEach((row) => assert.equal(slugify(row), row));
TEST
}
c_13_overridden_array_prototype(){ # reflective prototype replacement also suppresses every callback
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
Object.defineProperty(Array.prototype, "forEach", { value() {} });
const rows = ["a", "b", "c"];
rows.forEach((row) => assert.equal(slugify(row), row));
TEST
}
c_13_inert_callback(){ # forEach calls a generator but never iterates its assertion body
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
const rows = ["a", "b", "c"];
rows.forEach(function* (row) { assert.equal(slugify(row), row); });
TEST
}
c_13_abrupt_exit(){ # successful process exit prevents all following assertions from running
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
(process as any)["exit"](0);
assert.equal(slugify("a"), "a");
assert.equal(slugify("b"), "b");
assert.equal(slugify("c"), "c");
TEST
}
c_13_class_field(){ # instance field initializers are syntax only until a class is instantiated
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
assert.ok(class { value = slugify("a"); });
assert.ok(class { value = slugify("b"); });
assert.ok(class { value = slugify("c"); });
TEST
}
c_13_mutated_assert(){ # the imported assertion receiver is replaced with a no-op
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { slugify } from "../src/slugify.ts";
assert.equal = () => {};
assert.equal(slugify("a"), "wrong");
assert.equal(slugify("b"), "wrong");
assert.equal(slugify("c"), "wrong");
TEST
}
c_13_mutated_runner(){ # the imported runner method is replaced and never invokes its callback
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.ts";
test.only = (_name: string, _callback: () => void) => {};
test.only("fake", () => {
  assert.equal(slugify("a"), "a");
  assert.equal(slugify("b"), "b");
  assert.equal(slugify("c"), "c");
});
TEST
}
c_13_local_subject(){ # a same-named local fake is not an imported subject binding
  cp "$ROOT/tasks/13-type-safe-slug-tests/solution/src/slugify.ts" "$1/src/slugify.ts"
  cat > "$1/test/slugify.test.ts" <<'TEST'
import assert from "node:assert/strict";
const slugify = (value: string): string => value;
assert.equal(slugify("a"), "a");
assert.equal(slugify("b"), "b");
assert.equal(slugify("c"), "c");
TEST
}
c_12_shadow_import(){ # local fake shadows the authentic import while inline output passes the oracle
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string {
  const formatCsv = (_rows: Row[]): string => "name,value\nalpha,1\nbeta,2";
  return argv.includes("--csv") ? formatCsv(DATA) : formatText(DATA);
}
CLI
}
c_12_unknown_launder(){ # nested unmodeled helper discards the imported result and returns inline output
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string {
  function passthrough(_ignored: string, value: string): string { return value; }
  return argv.includes("--csv")
    ? passthrough(formatCsv(DATA), "name,value\nalpha,1\nbeta,2")
    : formatText(DATA);
}
CLI
}
c_12_dead_condition(){ # imported result exists only behind a statically false composite condition
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string {
  if (false && argv.length > 0) return formatCsv(DATA);
  return argv.includes("--csv") ? "name,value\nalpha,1\nbeta,2" : formatText(DATA);
}
CLI
}
c_12_empty_loop(){ # impossible empty-array loop return is not dependency flow
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string {
  for (const row of []) return formatCsv([row] as Row[]);
  return argv.includes("--csv") ? "name,value\nalpha,1\nbeta,2" : formatText(DATA);
}
CLI
}
c_12_logical_launder(){ # imported result is only the condition; inline output is the returned value
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
export function run(argv: string[]): string {
  return argv.includes("--csv")
    ? formatCsv(DATA) && "name,value\nalpha,1\nbeta,2"
    : formatText(DATA);
}
CLI
}
c_12_dead_runtime_branch(){ # an unrelated unknown branch cannot satisfy the real --csv path
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
export function run(argv: string[]): string {
  if (Date.now() < 0) return formatCsv(DATA);
  return argv.includes("--csv") ? INLINE : formatText(DATA);
}
CLI
}
c_12_helper_selection(){ # a local helper selects the inline alternative at runtime
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
function choose(imported: string, inline: string): string {
  return Date.now() < 0 ? imported : inline;
}
export function run(argv: string[]): string {
  return argv.includes("--csv") ? choose(formatCsv(DATA), INLINE) : formatText(DATA);
}
CLI
}
c_12_container_selection(){ # imported output is evaluated but a static inline sibling is returned
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
export function run(argv: string[]): string {
  return argv.includes("--csv") ? [formatCsv(DATA), INLINE][1] : formatText(DATA);
}
CLI
}
c_12_lossy_transform(){ # slice erases the imported output before inline output is concatenated
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
export function run(argv: string[]): string {
  return argv.includes("--csv")
    ? formatCsv(DATA).slice(0, 0).concat(INLINE)
    : formatText(DATA);
}
CLI
}
c_12_wrong_flag_index(){ # the oracle's CSV flag is at index one, never at this static index
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
export function run(argv: string[]): string {
  return argv[999] === "--csv" ? formatCsv(DATA)
    : argv.includes("--csv") ? INLINE : formatText(DATA);
}
CLI
}
c_12_unrelated_length_comparison(){ # argv length alone does not prove an unrelated branch selects CSV
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
export function run(argv: string[]): string {
  if (Date.now() < argv.length) return formatCsv(DATA);
  return argv.includes("--csv") ? INLINE : formatText(DATA);
}
CLI
}
c_12_mutated_flag_selector(){ # replacing includes makes the syntactic CSV branch inert at runtime
  cp "$ROOT/tasks/12-add-csv-cli-format/solution/src/format.ts" "$1/src/format.ts"
  cat > "$1/src/cli.ts" <<'CLI'
import { formatCsv, formatText, type Row } from "./format.ts";
const DATA: Row[] = [{ name: "alpha", value: 1 }, { name: "beta", value: 2 }];
const INLINE = "name,value\nalpha,1\nbeta,2";
export function run(argv: string[]): string {
  Date.now() > 0 && (argv.includes = () => false);
  return argv.includes("--csv") ? formatCsv(DATA)
    : argv[1] === "--csv" ? INLINE : formatText(DATA);
}
CLI
}
c_14_shadow_import(){ # local validator duplicates behavior but the imported contract is unused
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const assertValidHandle = (candidate: string): void => {
    if (!/^[a-z0-9_-]{1,20}$/i.test(candidate)) throw new Error("invalid handle");
  };
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_oracle_early_exit(){ # candidate source exits successfully before the hidden oracle can finish
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) (globalThis as any)["pro" + "cess"].exit(0);
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_mutated_shared_assert(){ # candidate dependency disables the assertion object used by the oracle
  cat > "$1/src/validate.ts" <<'VALIDATE'
export function assertValidHandle(_value: string): void {}
VALIDATE
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { strict as assert } from "node:assert";
import { assertValidHandle } from "./validate.ts";

Object.defineProperty(assert, "equal", { value() {} });
Object.defineProperty(assert, "throws", { value() {} });

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_aliased_shared_assert(){ # assignment alias hides the imported assertion object from direct mutation checks
  cat > "$1/src/validate.ts" <<'VALIDATE'
export function assertValidHandle(_value: string): void {}
VALIDATE
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { strict as assert } from "node:assert";
import { assertValidHandle } from "./validate.ts";

let shared: typeof assert;
shared = assert;
Object.defineProperty(shared, "equal", { value() {} });
Object.defineProperty(shared, "throws", { value() {} });

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_dynamic_shared_assert(){ # dynamic builtin loading reaches the same assertion object as the hidden oracle
  cat > "$1/src/validate.ts" <<'VALIDATE'
export function assertValidHandle(_value: string): void {}
VALIDATE
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";

const assert = (await import("node:" + "assert")).strict;
Object.defineProperty(assert, "equal", { value() {} });
Object.defineProperty(assert, "throws", { value() {} });

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_unlisted_runtime_helper(){ # an imported helper outside the manifest edit list mutates the hidden oracle
  cat > "$1/src/validate.ts" <<'VALIDATE'
export function assertValidHandle(_value: string): void {}
VALIDATE
  cat > "$1/src/runtime-helper.ts" <<'HELPER'
import { strict as assert } from "node:assert";
Object.defineProperty(assert, "equal", { value() {} });
Object.defineProperty(assert, "throws", { value() {} });
HELPER
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import "./runtime-helper.ts";
import { assertValidHandle } from "./validate.ts";

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_fake_toolchain(){ # replacing the harness symlink with no-op tsc/tsx makes bad code look green
  cat > "$1/src/validate.ts" <<'VALIDATE'
export function assertValidHandle(_value: string): void {}
VALIDATE
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
  rm -f "$1/node_modules"
  mkdir -p "$1/node_modules/.bin"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$1/node_modules/.bin/tsc"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$1/node_modules/.bin/tsx"
  chmod +x "$1/node_modules/.bin/tsc" "$1/node_modules/.bin/tsx"
}
c_14_eval_early_exit(){ # string evaluation hides process control from ordinary AST identifiers
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) eval("process.exit(0)");
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_git_runtime_helper(){ # .git is harness-owned and excluded from the normal worktree comparison
  cat > "$1/src/validate.ts" <<'VALIDATE'
export function assertValidHandle(_value: string): void {}
VALIDATE
  mkdir -p "$1/.git"
  cat > "$1/.git/runtime-helper.ts" <<'HELPER'
import { strict as assert } from "node:assert";
Object.defineProperty(assert, "equal", { value() {} });
Object.defineProperty(assert, "throws", { value() {} });
HELPER
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import "../.git/runtime-helper.ts";
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle(normalized);
  return normalized;
}
NORMALIZE
}
c_14_dead_arrow(){ # uncalled arrow body is not executed validation
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  const dead = (): void => assertValidHandle(normalized);
  void dead;
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14_empty_callback(){ # a callback over a statically empty array never validates
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  [].forEach(() => assertValidHandle(normalized));
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14_stale_property(){ # a validated old property value is overwritten before the return
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const box = { v: "safe" };
  assertValidHandle(box.v);
  box.v = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,20}$/i.test(box.v)) throw new Error("invalid handle");
  return box.v;
}
NORMALIZE
}
c_14_callable_selection(){ # a static fake sibling is called instead of the imported validator
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  const fake = (candidate: string): void => {
    if (!/^[a-z0-9_-]{1,20}$/i.test(candidate)) throw new Error("invalid handle");
  };
  [assertValidHandle, fake][1](normalized);
  return normalized;
}
NORMALIZE
}
c_14_destructure_selection(){ # destructuring must not merge checked and returned properties
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  const box = { checked: "safe", returned: normalized };
  const { checked, returned } = box;
  assertValidHandle(checked);
  if (!/^[a-z0-9_-]{1,20}$/i.test(returned)) throw new Error("invalid handle");
  return returned;
}
NORMALIZE
}
c_14_compound_assignment(){ # assignment after validation replaces the checked symbolic value
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  let normalized = "safe";
  assertValidHandle(normalized);
  normalized &&= value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14(){ # call the validator only in a dead helper while normalizeHandle duplicates it — G5 must fail
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";

function deadHelper(value: string): void { assertValidHandle(value); }
void deadHelper;

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14_wrong_value(){ # validator runs, but not on the normalized value returned to the caller
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";

export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  assertValidHandle("always_valid");
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14_swallowed(){ # a caught validator failure does not guarantee the returned value was validated
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  try { assertValidHandle(normalized); } catch {}
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14_while_false(){ # a validator nested in a statically dead loop is not execution evidence
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  while (false) assertValidHandle(normalized);
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
c_14_unmatched_switch(){ # a validator in a statically unmatched case is not execution evidence
  cp "$ROOT/tasks/14-shared-handle-validation/solution/src/validate.ts" "$1/src/validate.ts"
  cat > "$1/src/normalize.ts" <<'NORMALIZE'
import { assertValidHandle } from "./validate.ts";
export function normalizeHandle(value: string): string {
  const normalized = value.trim().toLowerCase();
  switch ("text") { case "csv": assertValidHandle(normalized); break; }
  if (!/^[a-z0-9_-]{1,20}$/i.test(normalized)) throw new Error("invalid handle");
  return normalized;
}
NORMALIZE
}
cheat "@ts-nocheck" 01-make-failing-test-pass c_nocheck
cheat "T03 inline-distance" 03-impl-fn-across-2-files c_inline
cheat "04 inline-no-formatJson" 04-add-cli-flag c_04
cheat "10 fix-the-caller" 10-fix-shared-util-regression c_10
cheat "12 inline-no-formatCsv-import" 12-add-csv-cli-format c_12
cheat "12 discarded-formatCsv-result" 12-add-csv-cli-format c_12_discard
cheat "13 vacuous-assertions" 13-type-safe-slug-tests c_13
cheat "13 wrong-visible-assertions" 13-type-safe-slug-tests c_13_wrong
cheat "13 fake-test-runner" 13-type-safe-slug-tests c_13_fake_runner
cheat "13 fake-assert-object" 13-type-safe-slug-tests c_13_fake_assert
cheat "13 invariant-loop-inflation" 13-type-safe-slug-tests c_13_loop_inflation
cheat "13 expected-only-loop-inflation" 13-type-safe-slug-tests c_13_expected_loop_inflation
cheat "13 exclusive-branch-inflation" 13-type-safe-slug-tests c_13_exclusive_branch_inflation
cheat "13 short-circuit-subject" 13-type-safe-slug-tests c_13_short_circuit_subject
cheat "13 returned-callback" 13-type-safe-slug-tests c_13_returned_callback
cheat "13 statically-dead-loops" 13-type-safe-slug-tests c_13_dead_loops
cheat "13 possibly-empty-iterable" 13-type-safe-slug-tests c_13_empty_iterable
cheat "13 conditional-switch-break" 13-type-safe-slug-tests c_13_conditional_switch_break
cheat "13 mutated-array-cardinality" 13-type-safe-slug-tests c_13_mutated_array
cheat "13 shadowed-assert" 13-type-safe-slug-tests c_13_shadow_assert
cheat "13 shadowed-subject" 13-type-safe-slug-tests c_13_shadow_subject
cheat "13 shadowed-runner" 13-type-safe-slug-tests c_13_shadow_runner
cheat "13 skipped-runner" 13-type-safe-slug-tests c_13_skipped_runner
cheat "13 optional-chain-arguments" 13-type-safe-slug-tests c_13_optional_chain
cheat "13 sparse-forEach" 13-type-safe-slug-tests c_13_sparse_for_each
cheat "13 overridden-forEach" 13-type-safe-slug-tests c_13_overridden_for_each
cheat "13 overridden-Array-prototype" 13-type-safe-slug-tests c_13_overridden_array_prototype
cheat "13 inert-generator-callback" 13-type-safe-slug-tests c_13_inert_callback
cheat "13 abrupt-process-exit" 13-type-safe-slug-tests c_13_abrupt_exit
cheat "13 class-field-syntax" 13-type-safe-slug-tests c_13_class_field
cheat "13 mutated-assert-receiver" 13-type-safe-slug-tests c_13_mutated_assert
cheat "13 mutated-test-runner" 13-type-safe-slug-tests c_13_mutated_runner
cheat "13 local-subject" 13-type-safe-slug-tests c_13_local_subject
cheat "12 shadowed-formatCsv" 12-add-csv-cli-format c_12_shadow_import
cheat "12 unknown-call-laundering" 12-add-csv-cli-format c_12_unknown_launder
cheat "12 dead-composite-condition" 12-add-csv-cli-format c_12_dead_condition
cheat "12 empty-loop-return" 12-add-csv-cli-format c_12_empty_loop
cheat "12 logical-result-laundering" 12-add-csv-cli-format c_12_logical_launder
cheat "12 unrelated-runtime-branch" 12-add-csv-cli-format c_12_dead_runtime_branch
cheat "12 helper-result-selection" 12-add-csv-cli-format c_12_helper_selection
cheat "12 container-result-selection" 12-add-csv-cli-format c_12_container_selection
cheat "12 lossy-safe-transform" 12-add-csv-cli-format c_12_lossy_transform
cheat "12 wrong-static-flag-index" 12-add-csv-cli-format c_12_wrong_flag_index
cheat "12 unrelated-argv-length-comparison" 12-add-csv-cli-format c_12_unrelated_length_comparison
cheat "12 mutated-flag-selector" 12-add-csv-cli-format c_12_mutated_flag_selector
cheat "14 shadowed-validator" 14-shared-handle-validation c_14_shadow_import
cheat "14 candidate-oracle-early-exit" 14-shared-handle-validation c_14_oracle_early_exit
cheat "14 candidate-mutated-shared-assert" 14-shared-handle-validation c_14_mutated_shared_assert
cheat "14 candidate-aliased-shared-assert" 14-shared-handle-validation c_14_aliased_shared_assert
cheat "14 candidate-dynamic-shared-assert" 14-shared-handle-validation c_14_dynamic_shared_assert
cheat "14 unlisted-runtime-helper" 14-shared-handle-validation c_14_unlisted_runtime_helper
cheat "14 fake-node-toolchain" 14-shared-handle-validation c_14_fake_toolchain
cheat "14 eval-oracle-early-exit" 14-shared-handle-validation c_14_eval_early_exit
cheat "14 git-runtime-helper" 14-shared-handle-validation c_14_git_runtime_helper
cheat "14 dead-local-arrow" 14-shared-handle-validation c_14_dead_arrow
cheat "14 empty-array-callback" 14-shared-handle-validation c_14_empty_callback
cheat "14 stale-property-validation" 14-shared-handle-validation c_14_stale_property
cheat "14 callable-selection" 14-shared-handle-validation c_14_callable_selection
cheat "14 destructured-property-selection" 14-shared-handle-validation c_14_destructure_selection
cheat "14 post-validation-compound-assignment" 14-shared-handle-validation c_14_compound_assignment
cheat "14 normalize-only-validation" 14-shared-handle-validation c_14
cheat "14 validator-on-wrong-value" 14-shared-handle-validation c_14_wrong_value
cheat "14 swallowed-validator" 14-shared-handle-validation c_14_swallowed
cheat "14 while-false-validator" 14-shared-handle-validation c_14_while_false
cheat "14 unmatched-switch-validator" 14-shared-handle-validation c_14_unmatched_switch
fi

echo "──── $pass passed, $fail failed ────"

# ── Work-dir isolation regression (#172) — reported as its own section so the fixture self-test's
# summary line above stays the stable, doc-referenced count. ──
iso_pass=0; iso_fail=0
echo "── work-dir isolation (#172) ──"
if git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  RUN_WORKROOT="$(bash "$ROOT/run.sh" --print-workroot 2>/dev/null)"
  case "$RUN_WORKROOT" in
    "$REPO_ROOT"|"$REPO_ROOT"/*|"")
      echo "✗ run.sh WORKROOT ('$RUN_WORKROOT') is inside the repo (or empty)"; iso_fail=$((iso_fail+1));;
    *)
      echo "✓ run.sh WORKROOT is outside the repo ($RUN_WORKROOT)"; iso_pass=$((iso_pass+1));;
  esac
  dirty="$(git -C "$REPO_ROOT" status --porcelain -- gate-d/tasks gate-d/src 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    echo "✗ gate-d/tasks or gate-d/src changed during this self-test:"; echo "$dirty"; iso_fail=$((iso_fail+1))
  else
    echo "✓ gate-d/tasks and gate-d/src untouched by this self-test"; iso_pass=$((iso_pass+1))
  fi
  mkdir -p "$ROOT/src"
  printf 'preexisting user edit\n' > "$ROOT/src/preexisting-marker"
  if out="$(GATE_D_WORKROOT="$WORKROOT" GW_KEY=dummy CAP_S=1 bash "$ROOT/run.sh" pi 01-make-failing-test-pass 2>&1)"; then
    echo "✗ run.sh did not abort on pre-existing fixture dirtiness"; iso_fail=$((iso_fail+1))
  elif ! grep -q "already dirty before this run" <<<"$out"; then
    echo "✗ run.sh failed for the wrong reason while fixtures were dirty:"; echo "$out" | sed 's/^/    /'; iso_fail=$((iso_fail+1))
  elif [ ! -f "$ROOT/src/preexisting-marker" ]; then
    echo "✗ run.sh removed a pre-existing dirty fixture marker"; iso_fail=$((iso_fail+1))
  else
    echo "✓ run.sh aborts before touching pre-existing fixture edits"; iso_pass=$((iso_pass+1))
  fi
  rm -rf "$ROOT/src"
else
  echo "(skip: not a git checkout — nothing to escape to)"
fi
echo "──── $iso_pass passed, $iso_fail failed ────"

[ "$contract_fail" = 0 ] && [ "$fail" = 0 ] && [ "$iso_fail" = 0 ]
