/**
 * Port of code-battle gate-d-r3/telemetry/verification-telemetry.ts (CBATTLE-14, main 88b1a8e,
 * sha256 of the source file d97ece1edacfbf24c2d1fa11994e0ca4fc3b8fb65911d0fbadc081124fcbd5b0),
 * INFER-521. Deviations, all from Codex reviews of INFER-521 and offered back to CBATTLE-14 so the
 * two classifiers converge:
 *  - check patterns match the INVOKED executable of a normalized segment rather than any
 *    occurrence of a tool name, so `command -v tsc` or `grep 'npm test' README.md` is not a check;
 *  - segments are split outside quotes only, and a command that cannot be segmented reliably
 *    (unbalanced quotes, heredoc, command substitution) credits no check;
 *  - each check and mutation inside one command keeps its own segment position, so
 *    `tsc && sed -i ... && npm test` does not count the typecheck as after the edit;
 *  - a failed `&&` chain counts only its first segment as executed (`false && npm test` is no test
 *    run), unquoted `#` comments are ignored, and `--version`/`--help` queries are not checks.
 * The CLI block is dropped.
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
  /** Position of each check (parallel to kinds), from segmentPosition. */
  positions: number[];
  /** Segment index of each check (parallel to kinds). */
  segments: number[];
  attribution: Attribution;
}

interface PendingMutation {
  /** Position of the command's last mutating segment, from segmentPosition. */
  position: number;
  /** Position of the first segment if that segment mutates (the only one a failed `&&` chain surely ran). */
  firstSegmentPosition: number | null;
  attribution: Attribution;
  /** The command also runs a check, so a non-zero exit does not show that the mutation failed. */
  withChecks: boolean;
}

interface CheckRecord {
  kind: CheckKind;
  seq: number;
  outcome: Outcome;
}

/**
 * Split a shell command into the segments between `&&`, `||`, `;`, `&` and newlines, honouring
 * quotes and backslash escapes, so `echo "build && npm test"` is one segment (INFER-521 Codex
 * review). Pipes are recorded but do not split: `npm test | tail` is one check whose status is
 * hidden. A command it cannot reliably segment (unbalanced quotes, a heredoc, command
 * substitution) is unparseable: no checks are attributed to it.
 */
function splitShell(command: string): { segments: string[]; separators: Set<string>; parseable: boolean } {
  const segments: string[] = [];
  const separators = new Set<string>();
  let current = "";
  let quote: "'" | '"' | null = null;
  let parseable = true;
  const cut = () => { if (current.trim() !== "") segments.push(current.trim()); current = ""; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (quote === "'") { current += c; if (c === "'") quote = null; continue; }
    if (c === "\\") { current += c + (next ?? ""); i++; continue; }
    if (quote === '"') {
      if (c === "`" || (c === "$" && next === "(")) parseable = false;
      current += c; if (c === '"') quote = null; continue;
    }
    if (c === "'" || c === '"') { quote = c; current += c; continue; }
    if (c === "`" || (c === "$" && next === "(")) parseable = false;
    if (c === "<" && next === "<") parseable = false; // heredoc or here-string
    if (c === "#" && (current === "" || /\s$/.test(current))) {
      // An unquoted comment runs to the end of the line: nothing in it executes (Codex review).
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if ((c === "&" && next === "&") || (c === "|" && next === "|")) { separators.add(c + next); cut(); i++; continue; }
    if (c === "|") { separators.add("|"); current += c; continue; }
    if (c === "&" && command[i - 1] !== ">" && next !== ">") { separators.add("&"); cut(); continue; } // background
    if (c === ";" || c === "\n") { separators.add(c); cut(); continue; }
    current += c;
  }
  if (quote !== null) parseable = false;
  cut();
  return { segments, separators, parseable };
}

/**
 * Where segment i of n in the tool call numbered seq sits on the run's timeline: strictly inside
 * (seq - 0.5, seq + 0.5) and in segment order, so checks and mutations of one command are ordered
 * against each other and against every other tool call (edit/write tools sit at seq itself).
 */
function segmentPosition(seq: number, i: number, n: number): number {
  return seq - 0.45 + (0.9 * (i + 0.5)) / Math.max(n, 1);
}
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

// `tsc --version`, `npm test --help` and the like discover a tool; they check nothing (Codex review).
const INFO_ONLY = /(^|\s)(--version|-v|-V|--help|-h)(\s|$)/;
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
  /** Segment index of each entry of kinds. */
  checkSegments: number[];
  segmentCount: number;
  attribution: Attribution;
  mutates: boolean;
  /** Segment index of the last mutating segment (null when nothing mutates). */
  mutationSegment: number | null;
  /** Every mutating segment's index, in order. */
  mutationSegments: number[];
  /** Where the last mutating segment sits relative to the check segments (null when nothing mutates). */
  mutationPosition: "before-checks" | "after-checks" | null;
} {
  const split = splitShell(command);
  if (!split.parseable) {
    // No check is credited to a command the classifier cannot segment; a mutation anywhere in it
    // still counts as an edit (`cat > src/a.ts <<EOF ...`), after anything it might have checked.
    const mutates = MUTATING_BASH.some((re) => re.test(command));
    return { kinds: [], checkSegments: [], segmentCount: 1, attribution: "none", mutates,
      mutationSegment: mutates ? 0 : null, mutationSegments: mutates ? [0] : [],
      mutationPosition: mutates ? "after-checks" : null };
  }
  const segments = split.segments;
  const kinds: CheckKind[] = []; // one entry per check segment, so `npm test && … && npm test` counts twice
  const checkSegments: number[] = [];
  let checkSegmentCount = 0;
  let lastCheck = -1;
  let lastMutation = -1;
  const mutationSegments: number[] = [];
  segments.forEach((raw, i) => {
    const seg = normalizeSegment(raw);
    let hit = false;
    if (INFO_ONLY.test(seg)) return; // neither a check nor an edit
    if (TYPECHECK.some((re) => re.test(seg))) { kinds.push("typecheck"); checkSegments.push(i); hit = true; }
    if (TESTS.some((re) => re.test(seg))) { kinds.push("tests"); checkSegments.push(i); hit = true; }
    if (hit) {
      checkSegmentCount++;
      lastCheck = i;
    } else if (!CHECK_TOOL.test(seg) && MUTATING_BASH.some((re) => re.test(seg))) {
      lastMutation = i; // `echo x > src/a.ts` mutates; `npm test > log` is a check, not an edit
      mutationSegments.push(i);
    }
  });
  // A pipe hides the check's exit status (`npm test | tail` exits with tail's status); so do `;`,
  // `||`, `&` and newlines. Only separators outside quotes count.
  const hidden = ["|", "||", ";", "&", "\n"].some((sep) => split.separators.has(sep));
  const attribution: Attribution = hidden ? "none" : segments.length > 1 || checkSegmentCount > 1 ? "and-chain" : "exact";
  const mutates = lastMutation >= 0;
  // "before-checks": some check runs after the last mutation (`sed && test`, `sed && test && sed && test`);
  // "after-checks": nothing re-checks after it (`test && sed`, or a mutation with no check at all).
  const mutationPosition = !mutates ? null : lastCheck > lastMutation ? "before-checks" : "after-checks";
  return { kinds, checkSegments, segmentCount: segments.length, attribution, mutates,
    mutationSegment: mutates ? lastMutation : null, mutationSegments, mutationPosition };
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
  // Positions: edit/write tools sit at their tool-call number; checks and mutations inside a bash
  // command sit at their own segment's position within it (segmentPosition), so `tsc && sed &&
  // npm test` puts the typecheck before the edit and the test after it.
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
            const at = (i: number) => segmentPosition(seq, i, c.segmentCount);
            if (c.kinds.length > 0) {
              pending.set(id, { kinds: c.kinds, positions: c.checkSegments.map(at), segments: c.checkSegments,
                attribution: c.attribution });
            }
            if (c.mutationSegment !== null) {
              pendingMutations.set(id, { position: at(c.mutationSegment), withChecks: c.kinds.length > 0,
                firstSegmentPosition: c.mutationSegments[0] === 0 ? at(0) : null, attribution: c.attribution });
            }
          }
        }
      }
      if (type === "tool_execution_end" && id !== null) {
        if (pendingEdits.delete(id) && ev["isError"] === false) noteEdit();
        const m = pendingMutations.get(id);
        if (m !== undefined) {
          pendingMutations.delete(id);
          if (ev["isError"] === false) {
            bashMutations++;
            noteEdit(m.position);
          } else if (m.attribution === "and-chain") {
            // A failed `a && b && c` surely ran only `a`; later segments may have been skipped
            // (Codex review). Count the edit only when the first segment is the mutation.
            if (m.firstSegmentPosition !== null) {
              bashMutations++;
              noteEdit(m.firstSegmentPosition);
            }
          } else if (m.withChecks) {
            // `;`, `||` or pipes: the non-zero status may come from the check; assume the edit ran.
            bashMutations++;
            noteEdit(m.position);
          }
        }
        const p = pending.get(id);
        if (p !== undefined) {
          pending.delete(id);
          const raw = outcomeOf(ev);
          let outcome: Outcome = raw === "error" ? "unknown" : raw;
          // A failed `&&` chain surely ran only its first segment: checks after it may never have
          // run, so they are not counted as runs (Codex review).
          const unconfirmed = p.attribution === "and-chain" && ev["isError"] !== false;
          if (p.attribution === "none" || unconfirmed) {
            ambiguousCheckOutcomes++;
            outcome = "unknown";
          }
          p.kinds.forEach((kind, i) => {
            if (unconfirmed && p.segments[i] !== 0) return;
            checks.push({ kind, seq: p.positions[i]!, outcome });
          });
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
