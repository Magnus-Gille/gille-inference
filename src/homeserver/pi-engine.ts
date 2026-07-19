import { spawn } from "node:child_process";
import { withUserBusEnv } from "./code-loop-cage.js";
import { createInterface } from "node:readline";
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX } from "./code-loop-types.js";
import type {
  AgentEngine,
  CodeLoopUsage,
  EngineOutcome,
  EngineRunOptions,
  EngineRunResult,
  PiProcess,
  SpawnPiFn,
  CodeLoopAgentCheckAttempt,
  CodeLoopAgentCheckKind,
} from "./code-loop-types.js";

/**
 * pi engine — spawns `@mariozechner/pi-coding-agent` as a supervised subprocess (the exact
 * configuration that measured 10/10 on Gate D) and monitors its `--mode json` NDJSON event
 * stream for turn/token accounting, cap enforcement, and the degenerate-round retry state
 * machine (docs/agentic-code-tool-design.md §2, §7, §10).
 *
 * Event contract (UNVERSIONED — pinned against the sanitized synthetic fixture
 * tests/fixtures/pi-fixture-2026-07-02.ndjson, shaped after pi v0.70.2):
 *   • `turn_start`                          → one turn begins (counted for the turn cap)
 *   • `turn_end.message.usage.{input,output}` → per-turn token usage (summed)
 *   • `message_end.message` (role assistant) → assistant text blocks; the LAST non-empty one
 *                                              is the run summary
 *   • `message_update`                         → streaming noise, ignored
 *   • unparseable lines                      → tolerated + counted, never fatal (§10)
 */

// ─── NDJSON event extraction (pinned to the synthetic fixture format) ──────────────────

interface PiEvent {
  type?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  args?: { command?: unknown };
  result?: {
    content?: unknown;
  };
  message?: {
    role?: unknown;
    content?: unknown;
    usage?: { input?: unknown; output?: unknown };
    stopReason?: unknown;
    errorMessage?: unknown;
  };
}

function checkKindOfSegment(raw: string): CodeLoopAgentCheckKind | null {
  const c = raw.toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/^(?:env )?(?:[a-z_][a-z0-9_]*=\S+ )*/i, "")
    .replace(/^npx(?: --?\S+)* /, "");
  if (/^(?:tsc)(?: |$)/.test(c) || /^(?:npm|pnpm|yarn) (?:run )?typecheck\b/.test(c)) return "typescript";
  if (/^(?:npm|pnpm|yarn) (?:run )?test\b/.test(c) || /^(?:vitest|jest|pytest|cargo test|go test|node --test)(?: |$)/.test(c)) return "test";
  if (/^(?:npm|pnpm|yarn) (?:run )?lint\b/.test(c) || /^(?:eslint|biome check)(?: |$)/.test(c)) return "lint";
  if (/^(?:npm|pnpm|yarn) (?:run )?build\b/.test(c) || /^(?:cargo build|go build)(?: |$)/.test(c)) return "build";
  if (/^(?:npm|pnpm|yarn) (?:run )?(?:check|verify|validate)\b/.test(c) || /^(?:\.\/)?\S*(?:check|verify|validate)(?:[._/-]\S*)?(?: |$)/.test(c)) return "validation";
  return null;
}

function hasCheckCandidate(command: string): boolean {
  // Wider than the accepted grammar on purpose: a refused/masked candidate is coverage loss,
  // not proof that no check ran. Only the count escapes the engine. Peel only bounded shell
  // grouping/negation prefixes here; normalizedCheck deliberately sees the original segment, so
  // grouped checks can never become attributable pass/fail evidence.
  return command.split(/&&|\|\||[;\n|]/).some((segment) => {
    let candidate = segment;
    for (let depth = 0; depth < 8; depth++) {
      let unwrapped = candidate.replace(/^\s*(?:[({]|!\s*)\s*/, "");
      unwrapped = unwrapped.replace(/^\s*(?:command|exec|sudo)\s+/i, "");
      unwrapped = unwrapped.replace(
        /^\s*timeout\s+(?:(?:(?:-[ks])\s+\S+|--(?:kill-after|signal)(?:=\S+|\s+\S+)|--(?:preserve-status|foreground|verbose))\s+)*\S+\s+/i,
        ""
      );
      unwrapped = unwrapped.replace(
        /^\s*nice(?:(?:\s+-n\s+\S+)|(?:\s+--adjustment(?:=\S+|\s+\S+)))?\s+/i,
        ""
      );
      // Shells accept combined option words (`-lc`, `-xec`) as well as bare `-c`.
      // This widening is candidate-only: wrapped commands remain unattributable coverage loss.
      unwrapped = unwrapped.replace(
        /^\s*(?:bash|sh|zsh|dash|ksh)(?:\s+--?\S+)*\s+-[a-z]*c[a-z]*\s+/i,
        ""
      );
      unwrapped = unwrapped.replace(/^\s*(?:poetry|uv|pdm)\s+run\s+/i, "");
      unwrapped = unwrapped.replace(/^\s*corepack\s+/i, "");
      unwrapped = unwrapped.replace(/^\s*['"]/, "");
      if (unwrapped === candidate) break;
      candidate = unwrapped;
    }
    if (checkKindOfSegment(candidate) !== null) return true;
    const c = candidate.toLowerCase().replace(/\s+/g, " ").trim();
    return /^make (?:test|lint|typecheck|build|check|verify|validate)(?: |$)/.test(c) ||
      /^(?:bun|deno) test(?: |$)/.test(c) ||
      /^(?:npm|pnpm|yarn) exec (?:vitest|jest|pytest|eslint|tsc)(?: |$)/.test(c) ||
      /^python\d*(?:\.\d+)? -m pytest(?: |$)/.test(c);
  });
}

function normalizedCheck(command: string): {
  kind: CodeLoopAgentCheckKind;
  failureAttributionAmbiguous: boolean;
} | null {
  // A shell-success event is valid evidence for the check only when no later/unconditional shell
  // branch can mask its exit status. Keep the common `cd repo && npm test` shape, but reject
  // `npm test || true`, pipelines/backgrounding, semicolon/newline tails, and multiple checks.
  const normalizedCommand = command.trim();
  // This intentionally is not a shell parser. Quotes, comments, substitutions, and backticks can
  // make a check-shaped `&& npm test` substring inert data (for example a commit message). Refuse
  // attribution for those shapes; hasCheckCandidate still records their content-blind coverage
  // loss so uncertainty can never become affirmative pass evidence.
  if (/["'`#]|\$\(/.test(normalizedCommand)) return null;
  const hasBackgroundOperator = [...normalizedCommand].some((char, index) => {
    if (char !== "&") return false;
    const previous = normalizedCommand[index - 1];
    const next = normalizedCommand[index + 1];
    // Preserve fd/output redirections (`2>&1`, `<&3`, `&>file`) and `&&`; any other single
    // ampersand can detach the check from the bash tool's reported exit status.
    return previous !== "&" && next !== "&" && previous !== ">" && previous !== "<" && next !== ">";
  });
  if (hasBackgroundOperator || /\|\||;|\n|(^|[^|])\|([^|]|$)/.test(normalizedCommand)) return null;
  const segments = normalizedCommand.toLowerCase().split(/&&/);
  const matches: Array<{ index: number; kind: CodeLoopAgentCheckKind }> = [];
  for (let index = 0; index < segments.length; index++) {
    const kind = checkKindOfSegment(segments[index]!);
    if (kind !== null) matches.push({ index, kind });
  }
  if (matches.length !== 1 || matches[0]!.index !== segments.length - 1) return null;
  return {
    kind: matches[0]!.kind,
    // A successful `cd repo && npm test` proves the final check ran and passed. A failed bash
    // event does not prove which segment failed, so its exit must not be attributed to the check.
    failureAttributionAmbiguous: segments.length > 1,
  };
}

/** Content-blind classification of a real bash tool start; never returns the command itself. */
export function agentCheckStartOf(ev: PiEvent): {
  id: string;
  kind: CodeLoopAgentCheckKind;
  command_fingerprint: string;
  /** Internal correlation hint; never emitted in caller-visible telemetry. */
  failureAttributionAmbiguous: boolean;
} | null {
  if (ev.type !== "tool_execution_start" || ev.toolName !== "bash" || typeof ev.toolCallId !== "string") return null;
  const command = ev.args?.command;
  if (typeof command !== "string") return null;
  const check = normalizedCheck(command);
  if (check === null) return null;
  return {
    id: ev.toolCallId,
    kind: check.kind,
    command_fingerprint: `sha256:${createHash("sha256").update(command, "utf8").digest("hex")}`,
    failureAttributionAmbiguous: check.failureAttributionAmbiguous,
  };
}

function agentCheckEndOf(ev: PiEvent): { id: string; status: "passed" | "failed" | "execution-error"; exit_code: number | null } | null {
  if (ev.type !== "tool_execution_end" || ev.toolName !== "bash" || typeof ev.toolCallId !== "string") return null;
  // pi 0.70.2 emits no structured exit-code field. A successful bash event is trustworthy but
  // its numeric exit is unobserved; a failed bash event appends this process-generated suffix to
  // the final text block. Parse only that anchored suffix, never arbitrary model/tool output.
  if (ev.isError === false) return { id: ev.toolCallId, status: "passed", exit_code: null };
  if (ev.isError === true && Array.isArray(ev.result?.content)) {
    const text = (ev.result.content as Array<{ type?: unknown; text?: unknown }>)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("");
    const match = /(?:^|\n)Command exited with code ([1-9]\d*)\s*$/.exec(text);
    if (match !== null) {
      const exitCode = Number(match[1]);
      if (Number.isSafeInteger(exitCode)) return { id: ev.toolCallId, status: "failed", exit_code: exitCode };
    }
  }
  return { id: ev.toolCallId, status: "execution-error", exit_code: null };
}

/** A completed, successful pi mutation event from the pinned NDJSON contract. */
export function completedMutationToolOf(ev: PiEvent): "edit" | "write" | null {
  if (ev.type !== "tool_execution_end" || ev.isError !== false) return null;
  return ev.toolName === "edit" || ev.toolName === "write" ? ev.toolName : null;
}

function mutationToolStartOf(ev: PiEvent): { id: string; tool: "edit" | "write" } | null {
  if (ev.type !== "tool_execution_start" || typeof ev.toolCallId !== "string") return null;
  return ev.toolName === "edit" || ev.toolName === "write"
    ? { id: ev.toolCallId, tool: ev.toolName }
    : null;
}

export function parsePiLine(line: string): PiEvent | null {
  const t = line.trim();
  if (t === "") return null;
  try {
    const v = JSON.parse(t) as unknown;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) return v as PiEvent;
    return null;
  } catch {
    return null;
  }
}

/** True for events that begin a model turn (the turn-cap unit). */
export function isTurnStart(ev: PiEvent): boolean {
  return ev.type === "turn_start";
}

/** Per-turn usage from a turn_end event ({input, output} token counts), or null. */
export function usageOf(ev: PiEvent): { prompt: number; completion: number } | null {
  if (ev.type !== "turn_end") return null;
  const u = ev.message?.usage;
  if (u === undefined || u === null || typeof u !== "object") return null;
  const prompt = typeof u.input === "number" && Number.isFinite(u.input) ? u.input : 0;
  const completion = typeof u.output === "number" && Number.isFinite(u.output) ? u.output : 0;
  return { prompt, completion };
}

/** Assistant text from a message_end event (concatenated text blocks), or null. */
export function assistantTextOf(ev: PiEvent): string | null {
  if (ev.type !== "message_end") return null;
  const m = ev.message;
  if (m === undefined || m.role !== "assistant" || !Array.isArray(m.content)) return null;
  const parts: string[] = [];
  for (const block of m.content as Array<{ type?: unknown; text?: unknown }>) {
    if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  const joined = parts.join("").trim();
  return joined === "" ? null : joined;
}

/**
 * The per-turn integrity signal (§10 pre-ship must-fix). pi records a mid-stream abort — including
 * the gateway's degeneracy retry-frame — as a turn_end with `stopReason:"error"` (+ `errorMessage`)
 * while STILL exiting 0 (verified live 2026-07-03 against pi 0.70.2). Without reading this, the
 * harness would gate success on exit-0 + no char-run and silently accept the truncated turn.
 * Returns the error message for an errored turn_end, or null for a clean/non-turn_end event.
 */
export function turnErrorOf(ev: PiEvent): string | null {
  if (ev.type !== "turn_end") return null;
  const m = ev.message;
  if (m === undefined || m === null || m.stopReason !== "error") return null;
  return typeof m.errorMessage === "string" && m.errorMessage.trim() !== "" ? m.errorMessage : "pi reported a turn error (no message)";
}

// ─── Degeneracy heuristics (belt-and-braces on top of the gateway watchdog) ─────────────

/** The gateway's retry-frame text on a watchdog abort (gateway.ts degenerate branch). */
const GATEWAY_RETRY_FRAME_MARKER = "degenerate response and was reset";

/**
 * True if `text` contains a run of ≥ threshold consecutive identical NON-whitespace chars —
 * the "?????" recurrent degeneration signature (mirrors DegeneracyWatchdog semantics).
 */
export function hasDegenerateRun(text: string, threshold = 400): boolean {
  if (threshold <= 0) return false;
  let runChar = -1;
  let runLen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // whitespace breaks runs (space, tab, CR, LF)
    if (c === 32 || c === 9 || c === 13 || c === 10) {
      runChar = -1;
      runLen = 0;
      continue;
    }
    if (c === runChar) {
      runLen++;
      if (runLen >= threshold) return true;
    } else {
      runChar = c;
      runLen = 1;
    }
  }
  return false;
}

/** Did this (failed) run look like a serving-layer degeneracy abort rather than a pi bug? */
export function looksDegenerate(collectedText: string, rawTail: string, threshold = 400): boolean {
  return (
    rawTail.includes(GATEWAY_RETRY_FRAME_MARKER) ||
    collectedText.includes(GATEWAY_RETRY_FRAME_MARKER) ||
    hasDegenerateRun(collectedText, threshold) ||
    hasDegenerateRun(rawTail, threshold)
  );
}

// ─── pi argv + env ──────────────────────────────────────────────────────────────────────

export interface PiEngineConfig {
  piBin: string;
  provider: string;
  /** Env passed to pi — MINIMAL by design (§6): PATH, HOME=<sandbox>, PI_CODING_AGENT_DIR, HS_API_KEY. */
  piAgentDir: string;
  apiKey: string;
  /** Degeneracy run threshold for the belt-and-braces final-text scan. */
  degeneracyRunThreshold: number;
  /** Max readiness-poll budget after a suspected degeneracy abort (ms). Default 300 000. */
  readinessBudgetMs?: number;
}

export function buildPiArgv(cfg: Pick<PiEngineConfig, "piBin" | "provider">, model: string, instruction: string): string[] {
  return [cfg.piBin, "--provider", cfg.provider, "--model", model, "--no-session", "--print", "--mode", "json", instruction];
}

/**
 * The scrubbed pi environment (§6): NO gateway .env inheritance, no OPENROUTER_API_KEY.
 * HOME points into the sandbox so any dotfile writes stay contained even without the cage.
 */
export function buildPiEnv(cfg: Pick<PiEngineConfig, "piAgentDir" | "apiKey">, sandboxDir: string): Record<string, string> {
  // Scrubbed on purpose (no OPENROUTER etc.); withUserBusEnv adds ONLY the user-manager bus
  // pointers the OUTER systemd-run needs — inside the cage, bwrap re-sets HOME and hides
  // /run/user anyway.
  return withUserBusEnv({
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: sandboxDir,
    PI_CODING_AGENT_DIR: cfg.piAgentDir,
    HS_API_KEY: cfg.apiKey,
    ...(process.env["XDG_RUNTIME_DIR"] ? { XDG_RUNTIME_DIR: process.env["XDG_RUNTIME_DIR"] } : {}),
    ...(process.env["DBUS_SESSION_BUS_ADDRESS"]
      ? { DBUS_SESSION_BUS_ADDRESS: process.env["DBUS_SESSION_BUS_ADDRESS"] }
      : {}),
  });
}

// ─── The real spawn (process-group kill so the whole tree dies) ─────────────────────────

export const realSpawnPi: SpawnPiFn = (argv, opts) => {
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group → group kill reaches bash grandchildren
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(null));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    pid: child.pid,
    kill(signal) {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal); // negative pid = the whole group
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    },
    exited,
  };
};

// ─── Sandbox growth measurement ─────────────────────────────────────────────────────────

/** Recursive on-disk size of a directory (bytes). Best-effort; unreadable entries count 0. */
export function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) total += dirSizeBytes(p);
      else total += st.size;
    } catch {
      /* raced away — skip */
    }
  }
  return total;
}

// ─── One monitored pi run ───────────────────────────────────────────────────────────────

interface SingleRun {
  exitCode: number | null;
  killedFor: "wall" | "turns" | "tokens" | "growth" | "edit-deadline" | null;
  usage: CodeLoopUsage;
  finalMessage: string;
  unparseableLines: number;
  /** Tail of raw stdout+stderr (degeneracy marker scan). */
  rawTail: string;
  /** errorMessage of the last turn_end with stopReason:"error", or null — the per-turn integrity
   *  signal (§10). Set even when pi exits 0, which it does on a gateway degeneracy abort. */
  erroredTurn: string | null;
  startedAtMs: number;
  endedAtMs: number;
  firstEditTurn: number | null;
  firstEditAtMs: number | null;
  mutationToolCall: boolean;
  agentChecks: CodeLoopAgentCheckAttempt[];
  /** Count only; refused candidates and unmatched bash events never expose command content. */
  agentCheckCoverageLossEvents: number;
}

const RAW_TAIL_BYTES = 16 * 1024;
const SIGKILL_GRACE_MS = 5_000;

async function runPiOnce(
  spawnPi: SpawnPiFn,
  argv: string[],
  env: Record<string, string>,
  opts: EngineRunOptions,
  pollMs: number,
  now: () => number,
  turnOffset: number,
  checkOrderOffset: number
): Promise<SingleRun> {
  const started = now();
  const proc = spawnPi(argv, { cwd: opts.sandboxDir, env });

  let turns = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let finalMessage = "";
  let unparseable = 0;
  let rawTail = "";
  let erroredTurn: string | null = null;
  let firstEditTurn: number | null = null;
  let firstEditAtMs: number | null = null;
  let mutationToolCall = false;
  const mutationStarts = new Map<string, { turn: number; atMs: number }>();
  const checkStarts = new Map<string, Omit<CodeLoopAgentCheckAttempt, "ended_ms" | "status" | "exit_code"> & {
    failureAttributionAmbiguous: boolean;
  }>();
  const ignoredBashStarts = new Set<string>();
  const agentChecks: CodeLoopAgentCheckAttempt[] = [];
  let agentCheckCoverageLossEvents = 0;
  let killedFor: SingleRun["killedFor"] = null;
  let killTimer: NodeJS.Timeout | null = null;

  const appendTail = (chunk: string): void => {
    rawTail = (rawTail + chunk).slice(-RAW_TAIL_BYTES);
  };

  const kill = (reason: NonNullable<SingleRun["killedFor"]>): void => {
    if (killedFor !== null) return;
    killedFor = reason;
    proc.kill("SIGTERM");
    killTimer = setTimeout(() => proc.kill("SIGKILL"), SIGKILL_GRACE_MS);
    // Don't hold the event loop open for the escalation timer.
    killTimer.unref?.();
  };

  // Wall-clock cap.
  const wallTimer = setTimeout(() => kill("wall"), opts.caps.wall_s * 1000);
  // Growth cap poll.
  const growthTimer = setInterval(() => {
    if (dirSizeBytes(opts.sandboxDir) > opts.growthCapBytes) kill("growth");
  }, Math.max(pollMs, 25));

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    appendTail(line.slice(-2048) + "\n");
    const ev = parsePiLine(line);
    if (ev === null) {
      if (line.trim() !== "") unparseable++;
      return;
    }
    if (isTurnStart(ev)) {
      turns++;
      const overallTurn = turnOffset + turns;
      if (
        opts.caps.edit_deadline_turn !== undefined &&
        !mutationToolCall &&
        overallTurn > opts.caps.edit_deadline_turn
      ) {
        kill("edit-deadline");
        return;
      }
      if (turns > opts.caps.turns) kill("turns");
      return;
    }
    const mutationStart = mutationToolStartOf(ev);
    if (mutationStart !== null && turns > 0 && killedFor === null && !mutationToolCall) {
      mutationStarts.set(mutationStart.id, { turn: turnOffset + turns, atMs: now() });
      return;
    }
    if (completedMutationToolOf(ev) !== null && turns > 0 && killedFor === null && !mutationToolCall) {
      mutationToolCall = true;
      const start = typeof ev.toolCallId === "string" ? mutationStarts.get(ev.toolCallId) : undefined;
      if (start !== undefined) {
        firstEditTurn = start.turn;
        firstEditAtMs = start.atMs;
      }
      return;
    }
    const checkStart = agentCheckStartOf(ev);
    if (checkStart !== null) {
      if (checkStarts.has(checkStart.id) || ignoredBashStarts.has(checkStart.id)) {
        agentCheckCoverageLossEvents++;
        return;
      }
      if (checkStarts.size + agentChecks.length >= CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX) {
        ignoredBashStarts.add(checkStart.id);
        agentCheckCoverageLossEvents++;
        return;
      }
      checkStarts.set(checkStart.id, {
        order: checkOrderOffset + checkStarts.size + agentChecks.length + 1,
        kind: checkStart.kind,
        command_fingerprint: checkStart.command_fingerprint,
        started_ms: now(),
        failureAttributionAmbiguous: checkStart.failureAttributionAmbiguous,
      });
      return;
    }
    if (ev.type === "tool_execution_start" && ev.toolName === "bash") {
      if (typeof ev.toolCallId === "string") ignoredBashStarts.add(ev.toolCallId);
      const command = ev.args?.command;
      if (typeof command !== "string" || hasCheckCandidate(command)) agentCheckCoverageLossEvents++;
      return;
    }
    const checkEnd = agentCheckEndOf(ev);
    if (checkEnd !== null) {
      const start = checkStarts.get(checkEnd.id);
      if (start !== undefined) {
        const { failureAttributionAmbiguous, ...visibleStart } = start;
        const ambiguousFailure = failureAttributionAmbiguous && checkEnd.status === "failed";
        agentChecks.push({
          ...visibleStart,
          ended_ms: now(),
          status: ambiguousFailure ? "execution-error" : checkEnd.status,
          exit_code: ambiguousFailure ? null : checkEnd.exit_code,
        });
        checkStarts.delete(checkEnd.id);
      } else if (!ignoredBashStarts.delete(checkEnd.id)) {
        // A parsed end without its parsed start has unknown command identity; count the gap rather
        // than claiming the stream proved no check happened.
        agentCheckCoverageLossEvents++;
      }
      return;
    }
    // A turn_end carries BOTH usage and (on a mid-stream abort) the error signal — capture the
    // error before the usage early-return so the same turn_end still counts toward token usage.
    const turnErr = turnErrorOf(ev);
    if (turnErr !== null) erroredTurn = turnErr;
    const usage = usageOf(ev);
    if (usage !== null) {
      promptTokens += usage.prompt;
      completionTokens += usage.completion;
      if (completionTokens > opts.caps.completion_tokens) kill("tokens");
      return;
    }
    const text = assistantTextOf(ev);
    if (text !== null) finalMessage = text;
  });
  proc.stderr.on("data", (chunk: Buffer | string) => appendTail(String(chunk)));

  const exitCode = await proc.exited;
  const ended = now();
  for (const start of checkStarts.values()) {
    const { failureAttributionAmbiguous: _internal, ...visibleStart } = start;
    agentChecks.push({ ...visibleStart, ended_ms: ended, status: "execution-error", exit_code: null });
  }
  agentChecks.sort((a, b) => a.order - b.order);
  if (
    killedFor === null &&
    opts.caps.edit_deadline_turn !== undefined &&
    !mutationToolCall &&
    turnOffset + turns >= opts.caps.edit_deadline_turn
  ) {
    killedFor = "edit-deadline";
  }
  clearTimeout(wallTimer);
  clearInterval(growthTimer);
  if (killTimer !== null) clearTimeout(killTimer);
  rl.close();

  return {
    exitCode,
    killedFor,
    usage: { turns, wall_ms: Math.max(0, ended - started), prompt_tokens: promptTokens, completion_tokens: completionTokens },
    finalMessage,
    unparseableLines: unparseable,
    rawTail,
    erroredTurn,
    startedAtMs: started,
    endedAtMs: ended,
    firstEditTurn,
    firstEditAtMs,
    mutationToolCall,
    agentChecks,
    agentCheckCoverageLossEvents,
  };
}

// ─── The engine (with the degenerate-round retry state machine, §10) ────────────────────

export interface PiEngineDeps {
  spawnPi: SpawnPiFn;
  /** Poll gateway/model readiness after a suspected degeneracy abort. */
  readinessProbe: (timeoutMs: number) => Promise<boolean>;
  /** Growth/caps poll cadence (ms). */
  pollMs: number;
  /** Monotonic-enough wall clock seam for deterministic phase telemetry tests. */
  now?: () => number;
}

const CONTINUATION_PREFIX =
  "A previous attempt at this task was aborted mid-run by a server-side stream reset. " +
  "The workspace is preserved with your partial progress. Review the current state and continue the task: ";

export function makePiEngine(cfg: PiEngineConfig, deps: PiEngineDeps): AgentEngine {
  const readinessBudgetMs = cfg.readinessBudgetMs ?? 300_000;
  const now = deps.now ?? Date.now;

  return {
    async run(opts: EngineRunOptions): Promise<EngineRunResult> {
      const env = buildPiEnv(cfg, opts.sandboxDir);

      const attempt = (instruction: string, turnOffset: number, checkOrderOffset: number) =>
        runPiOnce(
          deps.spawnPi,
          [...opts.cageArgv, ...buildPiArgv(cfg, opts.model, instruction)],
          env,
          opts,
          deps.pollMs,
          now,
          turnOffset,
          checkOrderOffset
        );

      const first = await attempt(opts.instruction, 0, 0);

      // Defensive redaction: detail can carry a raw stdout/stderr tail, and HS_API_KEY (the
      // owner-tier bearer) is in pi's env — pi 0.70.2 doesn't echo it today, but the detail
      // leaves the engine for the MCP caller's result JSON, so never rely on that. Skipped for
      // degenerate short keys (< 8 chars — real keys are hs_owner_<long>): redacting a 1-char
      // dev/test key would mangle every occurrence of that character in the diagnostics.
      const redact = (s: string): string =>
        cfg.apiKey.length >= 8 ? s.split(cfg.apiKey).join("[redacted]") : s;

      const toResult = (run: SingleRun, extra: SingleRun | null, outcome: EngineOutcome, detail: string): EngineRunResult => {
        const last = extra ?? run;
        const usage: CodeLoopUsage = extra
          ? {
              turns: run.usage.turns + extra.usage.turns,
              wall_ms: Math.max(0, extra.endedAtMs - run.startedAtMs),
              prompt_tokens: run.usage.prompt_tokens + extra.usage.prompt_tokens,
              completion_tokens: run.usage.completion_tokens + extra.usage.completion_tokens,
            }
          : run.usage;
        const editRun = run.firstEditAtMs !== null
          ? run
          : extra !== null && extra.firstEditAtMs !== null
            ? extra
            : null;
        const firstEditAtMs = editRun?.firstEditAtMs ?? null;
        const firstEditTurn = editRun?.firstEditTurn ?? null;
        const editStartMs = firstEditAtMs === null ? undefined : Math.max(0, firstEditAtMs - run.startedAtMs);
        const missedDeadline = run.killedFor === "edit-deadline" || extra?.killedFor === "edit-deadline";
        const mutationToolCall = run.mutationToolCall || (extra?.mutationToolCall ?? false);
        const combinedAgentChecks = [...run.agentChecks, ...(extra?.agentChecks ?? [])];
        const agentChecks = combinedAgentChecks.slice(0, CODE_LOOP_AGENT_CHECK_ATTEMPT_MAX);
        const droppedAgentChecks = combinedAgentChecks.length - agentChecks.length;
        return {
          outcome,
          usage,
          finalMessage: (last.finalMessage || run.finalMessage).slice(0, 2048),
          unparseableLines: run.unparseableLines + (extra?.unparseableLines ?? 0),
          detail: redact(detail),
          telemetry: {
            ...(firstEditTurn !== null ? { first_edit_turn: firstEditTurn } : {}),
            ...(editStartMs !== undefined ? { edit_start_ms: editStartMs } : {}),
            phase_ms: editStartMs === undefined
              ? {}
              : {
                  inspect: editStartMs,
                  edit: Math.max(0, last.endedAtMs - firstEditAtMs!),
                },
            mutation_evidence: mutationToolCall ? "tool-call" : "none",
            observability_coverage: mutationToolCall && firstEditAtMs === null ? 0.75 : 1,
            agent_check_unparseable_lines: run.unparseableLines + (extra?.unparseableLines ?? 0),
            agent_check_coverage_loss_events:
              run.agentCheckCoverageLossEvents + (extra?.agentCheckCoverageLossEvents ?? 0) + droppedAgentChecks,
            ...(missedDeadline ? { failure_kind: "edit-deadline" as const } : {}),
            agent_checks: agentChecks.map((attempt, index) => ({
              ...attempt,
              order: index + 1,
              started_ms: Math.max(0, attempt.started_ms - run.startedAtMs),
              ended_ms: Math.max(0, attempt.ended_ms - run.startedAtMs),
            })),
          },
        };
      };

      if (first.killedFor !== null) {
        return toResult(first, null, "cap-exceeded", `cap breached: ${first.killedFor}`);
      }
      // Clean completion requires ALL of: zero exit, no errored turn, no degenerate char-run. The
      // erroredTurn check is the §10 must-fix: pi records a mid-stream gateway abort as a turn_end
      // with stopReason:"error" while STILL exiting 0, so exit-code + char-run alone would silently
      // accept a truncated turn as "completed" (verified live 2026-07-03).
      if (first.exitCode === 0 && first.erroredTurn === null && !hasDegenerateRun(first.finalMessage, cfg.degeneracyRunThreshold)) {
        return toResult(first, null, "completed", "");
      }

      // Failure path. Suspected serving-layer degeneracy (gateway retry-frame seen in the stream or
      // in the structured turn error, or a "?????" run) → readiness-polled single retry in the SAME
      // sandbox (§10). The poll is readiness-based, not a fixed backoff — a poison-clear reload
      // takes ~30 s+. A non-degeneracy turn error (e.g. an abrupt "terminated") is surfaced as an
      // arm-error rather than silently completed — better a loud failure than a truncated success.
      const degenerate =
        looksDegenerate(first.finalMessage, first.rawTail, cfg.degeneracyRunThreshold) ||
        (first.erroredTurn !== null && first.erroredTurn.includes(GATEWAY_RETRY_FRAME_MARKER));
      if (!degenerate) {
        // A structured per-turn error (§10) is the clearest signal — surface it directly.
        if (first.erroredTurn !== null) {
          return toResult(first, null, "arm-error", `pi turn errored: ${first.erroredTurn.slice(0, 160)}`);
        }
        // Otherwise carry the raw stdout+stderr TAIL (bounded ~400 chars) — an instant death (e.g.
        // pi ENOENT inside the cage) leaves its only evidence on stderr, and a bare "pi exited 1"
        // costs a manual sandbox dig (live smoke, 2026-07-02).
        const tail = first.rawTail.trim().slice(-400);
        return toResult(
          first,
          null,
          "arm-error",
          `pi exited ${first.exitCode === null ? "on signal" : first.exitCode}${tail !== "" ? `: ${tail}` : ""}`
        );
      }

      const ready = await deps.readinessProbe(readinessBudgetMs);
      if (!ready) {
        return toResult(first, null, "degenerate", "degeneracy suspected; model never became ready for the retry");
      }

      const second = await attempt(CONTINUATION_PREFIX + opts.instruction, first.usage.turns, first.agentChecks.length);
      if (second.killedFor !== null) {
        return toResult(first, second, "cap-exceeded", `cap breached on retry: ${second.killedFor}`);
      }
      if (second.exitCode === 0 && second.erroredTurn === null && !hasDegenerateRun(second.finalMessage, cfg.degeneracyRunThreshold)) {
        return toResult(first, second, "completed", "recovered after a degeneracy retry");
      }
      return toResult(first, second, "degenerate", "second attempt after degeneracy also failed — terminal");
    },
  };
}

// ─── Real readiness probe (llama-swap /running via the configured origin) ───────────────

/**
 * Poll the backend until the target model reports state "ready" (llama-swap /running), or
 * until the budget expires. A backend without /running (404) is treated as ready — pi's own
 * first call will then block on the model load, which is acceptable.
 */
export function makeLlamaSwapReadinessProbe(origin: string, model: string, pollMs = 5_000): (timeoutMs: number) => Promise<boolean> {
  return async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(`${origin}/running`, { signal: AbortSignal.timeout(5_000) });
        if (res.status === 404) return true; // non-llamaswap backend: no readiness signal
        if (res.ok) {
          const data = (await res.json()) as { running?: Array<{ model?: string; state?: string }> };
          const entry = (data.running ?? []).find((r) => r.model === model);
          // Idle (model unloaded) is also "ready enough": the next call will load it cleanly.
          if (!entry || entry.state === "ready") return true;
        }
      } catch {
        /* backend momentarily down (poison-clear restart window) — keep polling */
      }
      if (Date.now() + pollMs > deadline) return false;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  };
}
