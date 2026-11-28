/**
 * Port of code-battle gate-d-r3/telemetry/verification-telemetry.ts (CBATTLE-14, main 88b1a8e,
 * sha256 of the source file d97ece1edacfbf24c2d1fa11994e0ca4fc3b8fb65911d0fbadc081124fcbd5b0),
 * INFER-521. The check+edit semantics are upstream's (mutation position relative to the checks in
 * one command, edits at half-steps). One deliberate deviation, from the Codex review of INFER-521:
 * check patterns match the INVOKED executable of a normalized segment rather than any occurrence of
 * a tool name, so `command -v tsc` or `grep 'npm test' README.md` is not a check run. The CLI block
 * is dropped. Offered back to CBATTLE-14 so the two classifiers converge.
 * gate-d/run.sh feeds pi's NDJSON stream to it through scripts/pi-benchmark-telemetry.ts, so the
 * runner never executes code from an external task root. Re-port it when the corpus changes it, and
 * keep the schema string so rows say which classifier produced them.
 */
/**
 * Content-blind verification-behaviour telemetry for one pi run (CBATTLE-14 §3).
 *
 * Reads pi's `--mode json` NDJSON events (the same stream gille-inference's
 * scripts/pi-benchmark-telemetry.ts consumes) and answers, per run: did the agent type-check, did it
 * run the tests, did it do so after its last edit, what were the outcomes, and did it stop while a
 * check it ran was red. The summary holds counters, enums and turn indices only: no commands, paths,
 * file contents or model text, so it may enter shared result rows (Guest traffic stays content-blind).
 *
 * This is the *explanatory* metric. The primary metric is grader-derived (`at-stop.sh` re-runs tsc
 * and the visible tests on the final workspace), because command classification can be fooled
 * (see DECISIONS.md D7 and the classifier limits documented below).
 */


type JsonObject = Record<string, unknown>;
export type CheckKind = "typecheck" | "tests";
export type Outcome = "passed" | "failed" | "unknown";
export type VerificationClass =
  | "no-edit"
  | "never-checked"
  | "checked-before-last-edit-only"
  | "stopped-on-red"
  | "checked-green-after-last-edit"
  | "checked-after-last-edit-unknown";

export interface VerificationSummary {
  schema: "gate-d-r3/verification-telemetry@1";
  turns: number;
  edits: number;
  bashMutations: number;
  firstEditTurn: number | null;
  lastEditTurn: number | null;
  typecheckRuns: number;
  testRuns: number;
  typecheckAfterLastEdit: boolean;
  testsAfterLastEdit: boolean;
  lastTypecheckOutcome: Outcome | null;
  lastTestOutcome: Outcome | null;
  /** A check that ran after the last edit ended red and was never re-run green. */
  stoppedWithFailingCheck: boolean;
  /** Check commands whose exit status cannot be attributed (pipes, `;`, `||`, compound failures). */
  ambiguousCheckOutcomes: number;
  verificationClass: VerificationClass;
  unparseableLines: number;
}

/**
 * How far a bash exit status can be attributed to the checks in the command:
 *  - exact: one segment, no pipe; its status is the check's status;
 *  - and-chain: `a && b && ...` without pipes; success means every check passed, failure is unknown;
 *  - none: pipes, `;`, `||` or newlines; the status says nothing reliable about any check.
 */
export type Attribution = "exact" | "and-chain" | "none";

interface PendingCheck {
  kinds: CheckKind[];
  seq: number;
  attribution: Attribution;
}

interface PendingMutation {
  seq: number;
  /** The command also runs a check, so a non-zero exit does not show that the mutation failed. */
  withChecks: boolean;
  position: "before-checks" | "after-checks";
}

interface CheckRecord {
  kind: CheckKind;
  seq: number;
  outcome: Outcome;
}

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\n)\s*/;
// Patterns match the INVOKED executable at the start of a normalized segment (INFER-521 Codex
// review): a tool name merely appearing in a segment (`command -v tsc`, `cat src/tsc.ts`,
// `echo npm test`) is not a check run.
const TYPECHECK = [
  /^tsc(\s|$)/, // tsc, npx tsc, ./node_modules/.bin/tsc (prefixes stripped by normalizeSegment)
  /^npm\s+run\s+(typecheck|type-check|tsc|build)\b/,
  /^(pnpm|yarn)\s+(run\s+)?(typecheck|type-check|tsc)\b/,
];
const TESTS = [
  /^npm\s+(run\s+)?test\b/, /^npm\s+t(\s|$)/, /^(pnpm|yarn)\s+(run\s+)?test\b/,
  /^tsx\s+--test\b/, /^node\s+(--import[\s=]+tsx\s+)?--test\b/,
  /^tsx\s+\S*test\S*\.ts\b/, // npx tsx test/foo.test.ts — running a test file directly
  /^(vitest|jest)(\s|$)/,
];
const MUTATING_BASH = [/\bsed\s+-i/, /(^|[^>2&])>{1,2}\s*[^&\s]/, /\btee\b/, /\b(mv|cp|rm)\s/, /\bperl\s+-p?i/, /\bpatch\b/];

// Checkers and runtimes whose own redirects (`npm test > out.log`) are not source edits.
const CHECK_TOOL = /^(npm|npx|pnpm|yarn|tsc|node|tsx|vitest|jest)(\s|$)/;

/** Strip env assignments, `env`/`time`/`timeout N`, `npx` flags and a directory prefix. */
function normalizeSegment(seg: string): string {
  let s = seg.trim();
  for (let previous = ""; previous !== s; ) {
    previous = s;
    s = s
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "")
      .replace(/^(env|time|command\s+--)\s+/, "")
      .replace(/^timeout\s+\S+\s+/, "")
      .replace(/^npx\s+((--no-install|--yes|-y)\s+)*/, "")
      .replace(/^\S*\/(?=[A-Za-z0-9_.-]+(\s|$))/, ""); // ./node_modules/.bin/tsc -> tsc
  }
  return s;
}

function object(v: unknown): JsonObject | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null;
}

/** Which checks a shell command runs. Exported for the classifier tests. */
export function classifyCommand(command: string): {
  kinds: CheckKind[];
  attribution: Attribution;
  mutates: boolean;
  /** Where the last mutating segment sits relative to the check segments (null when nothing mutates). */
  mutationPosition: "before-checks" | "after-checks" | null;
} {
  const segments = command.trim().split(SEGMENT_SPLIT).filter((s) => s !== "");
  const kinds: CheckKind[] = []; // one entry per check segment, so `npm test && … && npm test` counts twice
  let checkSegments = 0;
  let lastCheck = -1;
  let lastMutation = -1;
  segments.forEach((raw, i) => {
    const seg = normalizeSegment(raw);
    let hit = false;
    if (TYPECHECK.some((re) => re.test(seg))) { kinds.push("typecheck"); hit = true; }
    if (TESTS.some((re) => re.test(seg))) { kinds.push("tests"); hit = true; }
    if (hit) {
      checkSegments++;
      lastCheck = i;
    } else if (!CHECK_TOOL.test(seg) && MUTATING_BASH.some((re) => re.test(seg))) {
      lastMutation = i; // `echo x > src/a.ts` mutates; `npm test > log` is a check, not an edit
    }
  });
  // A pipe hides the check's exit status (`npm test | tail` exits with tail's status).
  const piped = /(^|[^|])\|([^|]|$)/.test(command);
  const otherSeparators = /;|\|\||\n/.test(command.trim());
  const attribution: Attribution = piped || otherSeparators ? "none" : segments.length > 1 || checkSegments > 1 ? "and-chain" : "exact";
  const mutates = lastMutation >= 0;
  // "before-checks": some check runs after the last mutation (`sed && test`, `sed && test && sed && test`);
  // "after-checks": nothing re-checks after it (`test && sed`, or a mutation with no check at all).
  const mutationPosition = !mutates ? null : lastCheck > lastMutation ? "before-checks" : "after-checks";
  return { kinds, attribution, mutates, mutationPosition };
}

/** Outcome of a finished pi bash tool call; pi appends `Command exited with code N` on failure. */
function outcomeOf(ev: JsonObject): "passed" | "failed" | "error" {
  if (ev["isError"] === false) return "passed";
  const content = object(ev["result"])?.["content"];
  if (ev["isError"] === true && Array.isArray(content)) {
    const text = content.map((p) => (object(p)?.["type"] === "text" ? String(object(p)?.["text"] ?? "") : "")).join("");
    if (/(?:^|\n)Command exited with code [1-9]\d*\s*$/.test(text)) return "failed";
  }
  return "error";
}

export function createVerificationTelemetry() {
  let turns = 0;
  let seq = 0;
  let edits = 0;
  let bashMutations = 0;
  let firstEditTurn: number | null = null;
  let lastEditTurn: number | null = null;
  // Edit positions are half-steps around tool calls: a mutation that precedes the checks in the same
  // bash command sits just before that command's check records, one that follows them just after.
  let lastEditSeq = -1;
  let unparseableLines = 0;
  let ambiguousCheckOutcomes = 0;
  const pending = new Map<string, PendingCheck>();
  const pendingMutations = new Map<string, PendingMutation>();
  const pendingEdits = new Map<string, true>();
  const checks: CheckRecord[] = [];

  function noteEdit(at: number = seq) {
    edits++;
    lastEditSeq = Math.max(lastEditSeq, at);
    lastEditTurn = turns;
    if (firstEditTurn === null) firstEditTurn = turns;
  }

  return {
    observe(ev: JsonObject): void {
      const type = ev["type"];
      const id = typeof ev["toolCallId"] === "string" ? (ev["toolCallId"] as string) : null;
      const tool = ev["toolName"];
      if (type === "turn_start") turns++;
      if (type === "tool_execution_start" && id !== null) {
        seq++;
        if (tool === "edit" || tool === "write") pendingEdits.set(id, true);
        if (tool === "bash") {
          const command = object(ev["args"])?.["command"];
          if (typeof command === "string") {
            const c = classifyCommand(command);
            if (c.kinds.length > 0) pending.set(id, { kinds: c.kinds, seq, attribution: c.attribution });
            if (c.mutationPosition !== null) {
              pendingMutations.set(id, { seq, withChecks: c.kinds.length > 0, position: c.mutationPosition });
            }
          }
        }
      }
      if (type === "tool_execution_end" && id !== null) {
        if (pendingEdits.delete(id) && ev["isError"] === false) noteEdit();
        const m = pendingMutations.get(id);
        if (m !== undefined) {
          pendingMutations.delete(id);
          if (ev["isError"] === false || m.withChecks) {
            bashMutations++;
            noteEdit(m.position === "before-checks" ? m.seq - 0.5 : m.seq + 0.5);
          }
        }
        const p = pending.get(id);
        if (p !== undefined) {
          pending.delete(id);
          const raw = outcomeOf(ev);
          let outcome: Outcome = raw === "error" ? "unknown" : raw;
          if (p.attribution === "none" || (p.attribution === "and-chain" && outcome === "failed")) {
            ambiguousCheckOutcomes++;
            outcome = "unknown";
          }
          for (const kind of p.kinds) checks.push({ kind, seq: p.seq, outcome });
        }
      }
    },
    unparseable(): void {
      unparseableLines++;
    },
    summary(): VerificationSummary {
      const of = (k: CheckKind) => checks.filter((c) => c.kind === k);
      const after = (k: CheckKind) => of(k).filter((c) => c.seq > lastEditSeq);
      const last = (xs: CheckRecord[]) => (xs.length === 0 ? null : xs[xs.length - 1]!.outcome);
      const tcAfter = after("typecheck");
      const tsAfter = after("tests");
      const stoppedRed = [tcAfter, tsAfter].some((xs) => last(xs) === "failed");
      let cls: VerificationClass;
      if (edits === 0) cls = "no-edit";
      else if (checks.length === 0) cls = "never-checked";
      else if (tcAfter.length === 0 && tsAfter.length === 0) cls = "checked-before-last-edit-only";
      else if (stoppedRed) cls = "stopped-on-red";
      else if ([tcAfter, tsAfter].every((xs) => xs.length === 0 || last(xs) === "passed")) cls = "checked-green-after-last-edit";
      else cls = "checked-after-last-edit-unknown";
      return {
        schema: "gate-d-r3/verification-telemetry@1",
        turns, edits, bashMutations, firstEditTurn, lastEditTurn,
        typecheckRuns: of("typecheck").length,
        testRuns: of("tests").length,
        typecheckAfterLastEdit: tcAfter.length > 0,
        testsAfterLastEdit: tsAfter.length > 0,
        lastTypecheckOutcome: last(of("typecheck")),
        lastTestOutcome: last(of("tests")),
        stoppedWithFailingCheck: stoppedRed,
        ambiguousCheckOutcomes,
        verificationClass: cls,
        unparseableLines,
      };
    },
  };
}

export function summarizeNdjson(text: string): VerificationSummary {
  const t = createVerificationTelemetry();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const ev = object(JSON.parse(line) as unknown);
      if (ev === null) t.unparseable();
      else t.observe(ev);
    } catch {
      t.unparseable();
    }
  }
  return t.summary();
}
