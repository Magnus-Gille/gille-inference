#!/usr/bin/env tsx
/**
 * Record Pi's temporary NDJSON stream while retaining only content-blind benchmark telemetry.
 *
 * The raw log remains inside Gate D's throwaway work directory. The summary contains counters and
 * durations only: no prompts, paths, tool arguments, model text, or tool output.
 */
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

export interface PiBenchmarkTelemetrySummary {
  turns: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  modelTurnMs: number | null;
  timedModelTurns: number;
  assistantStreamMs: number | null;
  timedAssistantMessages: number;
  unparseableLines: number;
}

export interface PiBenchmarkTelemetry {
  summary(): PiBenchmarkTelemetrySummary;
  observe(event: JsonObject, observedMs: number): void;
  unparseable(): void;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function roleOf(event: JsonObject): unknown {
  return object(event["message"])?.["role"];
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

// ── Verification-behaviour telemetry (INFER-521) ───────────────────────────────────────────────
// Ported verbatim (logic unchanged) from code-battle gate-d-r3 `telemetry/verification-telemetry.ts`
// (CBATTLE-14 §3, its DECISIONS.md D7), so Gate D rows on any corpus carry the same counters and
// enums the r3 analysis expects. Content-blind: counters, enums and turn indices only; commands are
// classified in memory and never leave the run. This is the explanatory metric; the primary one is
// the grader-derived at-stop.sh result that run.sh records for external corpora.

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

interface CheckRecord {
  kind: CheckKind;
  seq: number;
  outcome: Outcome;
}

const SEGMENT_SPLIT = /\s*(?:&&|\|\||;|\n)\s*/;
// Every pattern is anchored at the command a segment runs (after `commandHead` strips env
// assignments and launchers), never searched in arbitrary text: `which tsc`, `git grep "npm test"`
// and `git diff -- test/vitest.config.ts` run no check (INFER-521 review).
const TYPECHECK = [
  /^(?:\S*\/)?tsc(\s|$)/, // tsc, npx tsc, ./node_modules/.bin/tsc
  /^npm\s+run\s+(typecheck|type-check|tsc|build)\b/,
  /^pnpm\s+(run\s+)?(typecheck|tsc)\b/,
];
const TESTS = [
  /^npm\s+(run\s+)?test\b/, /^npm\s+t\b/, /^pnpm\s+(run\s+)?test\b/, /^yarn\s+test\b/,
  /^tsx\s+--test\b/, /^node\s+(--import\s+tsx\s+)?--test\b/,
  /^tsx\s+\S*test\S*\.ts\b/, // npx tsx test/foo.test.ts — running a test file directly
  /^(?:\S*\/)?(?:vitest|jest)(?:\s|$)/, /^yarn\s+(?:vitest|jest)(?:\s|$)/,
];

/** The command a segment runs: leading `(` or `!`, env assignments, `time`/`timeout N` and launchers removed. */
export function commandHead(segment: string): string {
  let s = segment.trim();
  for (;;) {
    const next = s
      .replace(/^\(\s*/, "")
      .replace(/^!\s+/, "") // still a check, but unattributable (see `negated` below)
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "")
      .replace(/^time\s+/, "")
      .replace(/^timeout\s+(?:-\S+\s+)*\S+\s+/, "")
      .replace(/^(?:npx|bunx)\s+(?:-\S+\s+)*/, "")
      .replace(/^(?:pnpm|yarn)\s+exec\s+/, "");
    if (next === s) return s;
    s = next;
  }
}
const MUTATING_BASH = [/\bsed\s+-i/, /(^|[^>2&])>{1,2}\s*[^&\s]/, /\btee\b/, /\b(mv|cp|rm)\s/, /\bperl\s+-p?i/, /\bpatch\b/];

/** Which checks a shell command runs. Exported for the classifier tests. */
export function classifyCommand(command: string): { kinds: CheckKind[]; attribution: Attribution; mutates: boolean } {
  const segments = command.trim().split(SEGMENT_SPLIT).filter((s) => s !== "");
  const kinds = new Set<CheckKind>();
  let checkSegments = 0;
  for (const seg of segments) {
    if (/^\s*(echo|printf|cat|grep|rg|ls)\b/.test(seg)) continue; // `echo npm test` is not a test run
    // `tsc --version`, `tsc --showConfig`, `vitest --help` verify nothing (INFER-521 review).
    if (/(^|\s)(--version|-v|--help|-h|--showConfig|--listFiles(Only)?|--init)(\s|$)/.test(seg)) continue;
    let hit = false;
    const head = commandHead(seg);
    if (TYPECHECK.some((re) => re.test(head))) { kinds.add("typecheck"); hit = true; }
    if (TESTS.some((re) => re.test(head))) { kinds.add("tests"); hit = true; }
    if (hit) checkSegments++;
  }
  // A pipe hides the check's exit status (`npm test | tail` exits with tail's status).
  const piped = /(^|[^|])\|([^|]|$)/.test(command);
  const otherSeparators = /;|\|\||\n/.test(command.trim());
  // `! npm test` succeeds because the tests failed; `npm test &` succeeds without waiting for them
  // (INFER-521 review). Neither exit status says anything about the check.
  const negated = segments.some((s) => /^\s*!\s/.test(s));
  const backgrounded = /(^|[^&>|])&(?![&>])/.test(command);
  const attribution: Attribution = piped || otherSeparators || negated || backgrounded ? "none" : segments.length > 1 || checkSegments > 1 ? "and-chain" : "exact";
  // Per segment (INFER-521 review): a whole-command test let `npm test && sed -i ...` hide its edit
  // behind the leading `npm`. Pipes are split too, so `cat x | tee y` still counts as a mutation.
  const mutates = command.trim().split(/\s*(?:&&|\|\||;|\n|\|)\s*/).some((seg) =>
    MUTATING_BASH.some((re) => re.test(seg)) && !/^\s*(npm|npx|tsc|node|tsx)\b/.test(seg));
  return { kinds: [...kinds], attribution, mutates };
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
  let lastEditSeq = -1;
  let unparseableLines = 0;
  let ambiguousCheckOutcomes = 0;
  const pending = new Map<string, PendingCheck>();
  const pendingMutations = new Map<string, true>();
  const pendingEdits = new Map<string, true>();
  const checks: CheckRecord[] = [];

  function noteEdit() {
    edits++;
    lastEditSeq = seq;
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
            // A command that both checks and mutates (INFER-521 review): the order inside it is not
            // attributable, so the mutation is placed after its checks. Verification of the final
            // state is then never credited to it; it can only under-credit `sed -i ... && npm test`.
            if (c.mutates) pendingMutations.set(id, true);
          }
        }
      }
      if (type === "tool_execution_end" && id !== null) {
        if (pendingEdits.delete(id) && ev["isError"] === false) noteEdit();
        // A failed shell call may still have changed files in an earlier segment (`sed -i ... && false`),
        // so a detected mutation counts as a possible edit whatever the exit status (INFER-521 review).
        if (pendingMutations.delete(id)) {
          bashMutations++;
          noteEdit();
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
      // A known failure stays flagged until a confirmed pass: an unattributable retry
      // (`npm test | tail`) neither clears it nor counts as green (INFER-521 review).
      const lastKnown = (xs: CheckRecord[]) => {
        const known = xs.filter((c) => c.outcome !== "unknown");
        return known.length === 0 ? null : known[known.length - 1]!.outcome;
      };
      const stoppedRed = [tcAfter, tsAfter].some((xs) => lastKnown(xs) === "failed");
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

export function createPiBenchmarkTelemetry(): PiBenchmarkTelemetry {
  let turns = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let modelTurnMs = 0;
  let timedModelTurns = 0;
  let assistantStreamMs = 0;
  let timedAssistantMessages = 0;
  let unparseableLines = 0;
  let modelTurnStartedMs: number | null = null;
  let assistantMessageStartedMs: number | null = null;

  return {
    observe(event, observedMs) {
      const type = event["type"];
      if (type === "turn_start") {
        turns++;
        modelTurnStartedMs = observedMs;
      }
      if (type === "tool_execution_start" && typeof event["toolCallId"] === "string" && typeof event["toolName"] === "string") {
        toolCalls++;
      }
      if (type === "turn_end") {
        const usage = object(object(event["message"])?.["usage"]);
        if (usage !== null) {
          promptTokens += tokenCount(usage["input"]);
          completionTokens += tokenCount(usage["output"]);
        }
      }
      if (type === "message_start" && roleOf(event) === "assistant") {
        assistantMessageStartedMs = observedMs;
      }
      if (type === "message_end" && roleOf(event) === "assistant") {
        if (modelTurnStartedMs !== null) {
          const elapsed = observedMs - modelTurnStartedMs;
          if (Number.isFinite(elapsed) && elapsed >= 0) {
            modelTurnMs += elapsed;
            timedModelTurns++;
          }
          modelTurnStartedMs = null;
        }
        if (assistantMessageStartedMs !== null) {
          const elapsed = observedMs - assistantMessageStartedMs;
          if (Number.isFinite(elapsed) && elapsed >= 0) {
            assistantStreamMs += elapsed;
            timedAssistantMessages++;
          }
          assistantMessageStartedMs = null;
        }
      }
    },
    unparseable() {
      unparseableLines++;
    },
    summary() {
      return {
        turns,
        toolCalls,
        promptTokens,
        completionTokens,
        modelTurnMs: timedModelTurns > 0 ? Math.round(modelTurnMs) : null,
        timedModelTurns,
        assistantStreamMs: timedAssistantMessages > 0 ? Math.round(assistantStreamMs) : null,
        timedAssistantMessages,
        unparseableLines,
      };
    },
  };
}

export function observePiBenchmarkLine(
  telemetry: PiBenchmarkTelemetry,
  line: string,
  observedMs: number,
): void {
  if (line.trim() === "") return;
  try {
    const event = object(JSON.parse(line) as unknown);
    if (event === null) telemetry.unparseable();
    else telemetry.observe(event, observedMs);
  } catch {
    telemetry.unparseable();
  }
}

export function observeVerificationLine(
  telemetry: ReturnType<typeof createVerificationTelemetry>,
  line: string,
): void {
  if (line.trim() === "") return;
  try {
    const event = object(JSON.parse(line) as unknown);
    if (event === null) telemetry.unparseable();
    else telemetry.observe(event);
  } catch {
    telemetry.unparseable();
  }
}

interface RecorderPlan {
  logPath: string;
  summaryPath: string;
}

function parseArgs(argv: string[]): RecorderPlan {
  let logPath: string | null = null;
  let summaryPath: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== "--log" && flag !== "--summary") || value === undefined || value.startsWith("--")) {
      throw new Error("usage: pi-benchmark-telemetry --log <raw.ndjson> --summary <summary.json>");
    }
    index++;
    if (flag === "--log") logPath = resolve(value);
    else summaryPath = resolve(value);
  }
  if (logPath === null || summaryPath === null || logPath === summaryPath) {
    throw new Error("--log and --summary are required and must be distinct paths");
  }
  return { logPath, summaryPath };
}

/** What the Gate D recorder writes: the benchmark counters plus the verification summary. */
export interface PiRecorderSummary extends PiBenchmarkTelemetrySummary {
  verification: VerificationSummary;
}

function writeSummary(path: string, summary: PiRecorderSummary): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(summary)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export async function runPiBenchmarkTelemetry(argv: string[]): Promise<number> {
  let plan: RecorderPlan;
  try {
    plan = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  mkdirSync(dirname(plan.logPath), { recursive: true });
  const raw = createWriteStream(plan.logPath, { encoding: "utf8", flags: "wx", mode: 0o600 });
  const telemetry = createPiBenchmarkTelemetry();
  const verification = createVerificationTelemetry();
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      raw.write(`${line}\n`);
      observePiBenchmarkLine(telemetry, line, performance.now());
      observeVerificationLine(verification, line);
    }
    await new Promise<void>((accept, reject) => {
      raw.once("error", reject);
      raw.end(accept);
    });
    writeSummary(plan.summaryPath, { ...telemetry.summary(), verification: verification.summary() });
    return 0;
  } catch (error) {
    raw.destroy();
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runPiBenchmarkTelemetry(process.argv.slice(2));
}
