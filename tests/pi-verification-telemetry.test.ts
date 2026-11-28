// Ported from code-battle gate-d-r3/telemetry/verification-telemetry.test.ts (main 88b1a8e), INFER-521.
import { test } from "vitest";
import { strict as assert } from "node:assert";
import { classifyCommand, summarizeNdjson } from "../scripts/pi-verification-telemetry.js";

const start = (id: string, tool: string, command?: string) =>
  JSON.stringify({ type: "tool_execution_start", toolCallId: id, toolName: tool, args: command === undefined ? {} : { command } });
const end = (id: string, tool: string, ok: boolean, code = 1) =>
  JSON.stringify({ type: "tool_execution_end", toolCallId: id, toolName: tool, isError: !ok,
    result: { content: [{ type: "text", text: ok ? "" : `boom\nCommand exited with code ${code}` }] } });
const turn = JSON.stringify({ type: "turn_start" });
const run = (...lines: string[]) => summarizeNdjson(lines.join("\n"));

test("classifier: common check commands", () => {
  assert.deepEqual(classifyCommand("npx tsc --noEmit -p tsconfig.json").kinds, ["typecheck"]);
  assert.deepEqual(classifyCommand("npm test").kinds, ["tests"]);
  assert.deepEqual(classifyCommand("npm run typecheck").kinds, ["typecheck"]);
  assert.deepEqual(classifyCommand("npx tsx test/paging.test.ts").kinds, ["tests"]);
  assert.deepEqual(classifyCommand("npx tsx --test test/*.test.ts").kinds, ["tests"]);
  assert.deepEqual(classifyCommand("node --test").kinds, ["tests"]);
  assert.deepEqual(classifyCommand("npx tsc --noEmit && npm test").kinds.sort(), ["tests", "typecheck"]);
});

test("classifier: non-checks and attribution", () => {
  assert.deepEqual(classifyCommand("echo npm test").kinds, []);
  assert.deepEqual(classifyCommand("cat src/tsc.ts").kinds, []);
  assert.deepEqual(classifyCommand("ls test").kinds, []);
  assert.deepEqual(classifyCommand("npx tsx src/cli.ts").kinds, []);
  assert.equal(classifyCommand("npm test").attribution, "exact");
  assert.equal(classifyCommand("cd /w && npm test").attribution, "and-chain");
  assert.equal(classifyCommand("npm test | tail -5").attribution, "none");
  assert.equal(classifyCommand("npm test; echo done").attribution, "none");
  assert.equal(classifyCommand("npx tsc || true").attribution, "none");
  assert.equal(classifyCommand("sed -i 's/a/b/' src/x.ts").mutates, true);
  assert.equal(classifyCommand("npm test 2>&1").mutates, false);
});

test("stop right after the first edit: never-checked", () => {
  const s = run(turn, start("1", "read"), end("1", "read", true), turn, start("2", "edit"), end("2", "edit", true));
  assert.equal(s.verificationClass, "never-checked");
  assert.equal(s.edits, 1);
  assert.equal(s.firstEditTurn, 2);
  assert.equal(s.typecheckRuns + s.testRuns, 0);
});

test("checked green after the last edit", () => {
  const s = run(turn, start("1", "edit"), end("1", "edit", true), turn,
    start("2", "bash", "npx tsc --noEmit"), end("2", "bash", true), start("3", "bash", "npm test"), end("3", "bash", true));
  assert.equal(s.verificationClass, "checked-green-after-last-edit");
  assert.equal(s.typecheckAfterLastEdit && s.testsAfterLastEdit, true);
  assert.equal(s.lastTestOutcome, "passed");
  assert.equal(s.stoppedWithFailingCheck, false);
});

test("saw red, edited again, never re-checked", () => {
  const s = run(turn, start("1", "edit"), end("1", "edit", true), start("2", "bash", "npm test"), end("2", "bash", false),
    turn, start("3", "edit"), end("3", "edit", true));
  assert.equal(s.verificationClass, "checked-before-last-edit-only");
  assert.equal(s.lastTestOutcome, "failed");
});

test("saw red and stopped", () => {
  const s = run(turn, start("1", "edit"), end("1", "edit", true), start("2", "bash", "npx tsc --noEmit"), end("2", "bash", false, 2));
  assert.equal(s.verificationClass, "stopped-on-red");
  assert.equal(s.stoppedWithFailingCheck, true);
});

test("red then green rerun is not stopped-on-red", () => {
  const s = run(start("1", "edit"), end("1", "edit", true), start("2", "bash", "npm test"), end("2", "bash", false),
    start("3", "bash", "npm test"), end("3", "bash", true));
  assert.equal(s.verificationClass, "checked-green-after-last-edit");
});

test("piped checks are counted but their outcome is unknown", () => {
  const s = run(start("1", "edit"), end("1", "edit", true), start("2", "bash", "npm test | tail -3"), end("2", "bash", true));
  assert.equal(s.testRuns, 1);
  assert.equal(s.lastTestOutcome, "unknown");
  assert.equal(s.ambiguousCheckOutcomes, 1);
  assert.equal(s.verificationClass, "checked-after-last-edit-unknown");
});

test("and-chain: green attributes to every check, red to none", () => {
  const g = run(start("1", "edit"), end("1", "edit", true), start("2", "bash", "npx tsc --noEmit && npm test"), end("2", "bash", true));
  assert.equal(g.lastTypecheckOutcome, "passed");
  assert.equal(g.lastTestOutcome, "passed");
  const r = run(start("1", "edit"), end("1", "edit", true), start("2", "bash", "npx tsc --noEmit && npm test"), end("2", "bash", false));
  assert.equal(r.lastTypecheckOutcome, "unknown");
});

test("bash file mutations count as edits", () => {
  const s = run(start("1", "bash", "npm test"), end("1", "bash", true), start("2", "bash", "sed -i 's/x/y/' src/a.ts"), end("2", "bash", true));
  assert.equal(s.bashMutations, 1);
  assert.equal(s.verificationClass, "checked-before-last-edit-only");
});

test("failed edits and no edits", () => {
  assert.equal(run(start("1", "edit"), end("1", "edit", false)).verificationClass, "no-edit");
  assert.equal(run("not json", turn).unparseableLines, 1);
});

test("summary is content-blind", () => {
  const s = run(start("1", "edit"), end("1", "edit", true), start("2", "bash", "npm test -- --grep SECRET_TOKEN"), end("2", "bash", true));
  assert.ok(!JSON.stringify(s).includes("SECRET"));
});

test("edit-and-check in one command records the edit before the check (Codex review)", () => {
  const g = run(start("1", "bash", "sed -i 's/x/y/' src/a.ts && npm test"), end("1", "bash", true));
  assert.equal(g.bashMutations, 1);
  assert.equal(g.testsAfterLastEdit, true);
  assert.equal(g.verificationClass, "checked-green-after-last-edit");
  // The chain failed: the edit may still have happened and the test outcome is unknown.
  const r = run(start("1", "bash", "sed -i 's/x/y/' src/a.ts && npm test"), end("1", "bash", false));
  assert.equal(r.edits, 1);
  assert.equal(r.verificationClass, "checked-after-last-edit-unknown");
  // Check first, then edit: the check is before the last edit.
  const a = run(start("1", "bash", "npm test && sed -i 's/x/y/' src/a.ts"), end("1", "bash", true));
  assert.equal(a.verificationClass, "checked-before-last-edit-only");
  assert.deepEqual(classifyCommand("npm test > out.log").mutationPosition, null);
  // Interleaved: the final test follows the final edit (second Codex review).
  const i = run(start("1", "bash", "sed -i 's/a/b/' src/a.ts && npm test && sed -i 's/b/c/' src/a.ts && npm test"),
    end("1", "bash", true));
  assert.equal(i.verificationClass, "checked-green-after-last-edit");
  assert.equal(i.testRuns, 2); // repeated checks in one command are each counted (third Codex review)
  assert.equal(i.bashMutations, 1); // one tool call, one recorded edit
  assert.equal(classifyCommand("sed -i x a.ts").mutationPosition, "after-checks");
});

// INFER-521 Codex review: deviations from the code-battle original, pinned here.
test("classifier: only an invoked check counts", () => {
  assert.deepEqual(classifyCommand("command -v tsc").kinds, []);
  assert.deepEqual(classifyCommand("which vitest").kinds, []);
  assert.deepEqual(classifyCommand("grep -r 'npm test' README.md").kinds, []);
  assert.deepEqual(classifyCommand("./node_modules/.bin/tsc --noEmit").kinds, ["typecheck"]);
  assert.deepEqual(classifyCommand("CI=1 npm test").kinds, ["tests"]);
  assert.deepEqual(classifyCommand("timeout 60 npx --no-install tsc -p .").kinds, ["typecheck"]);
  assert.deepEqual(classifyCommand("cd /w && npx tsc --noEmit").kinds, ["typecheck"]);
  assert.equal(classifyCommand("npm test && sed -i 's/a/b/' src/x.ts").mutates, true);
  assert.equal(classifyCommand("npm test > out.log").mutates, false);
});

test("check then edit in one command: the check is before the last edit (upstream semantics)", () => {
  const s = run(
    turn, start("e1", "edit"), end("e1", "edit", true),
    start("b1", "bash", "npm test && sed -i 's/a/b/' src/x.ts"), end("b1", "bash", true),
  );
  assert.equal(s.edits, 2);
  assert.equal(s.testsAfterLastEdit, false);
  assert.equal(s.verificationClass, "checked-before-last-edit-only");
});

test("an anchored check with an env prefix still orders against the edit", () => {
  const s = run(start("1", "bash", "sed -i 's/x/y/' src/a.ts && CI=1 npx --no-install tsc --noEmit"), end("1", "bash", true));
  assert.equal(s.typecheckAfterLastEdit, true);
  assert.equal(s.verificationClass, "checked-green-after-last-edit");
});

test("`command -v tsc` after an edit is not verification", () => {
  const s = run(turn, start("e1", "edit"), end("e1", "edit", true), start("b1", "bash", "command -v tsc"), end("b1", "bash", true));
  assert.equal(s.verificationClass, "never-checked");
  assert.equal(s.typecheckRuns, 0);
});

test("a check's own log plumbing is not an edit", () => {
  assert.equal(classifyCommand("npm test 2>&1 | tee test.log").mutates, false);
  assert.equal(classifyCommand("echo x > src/a.ts").mutates, true);
});
