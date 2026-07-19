import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePiLine,
  isTurnStart,
  usageOf,
  assistantTextOf,
  completedMutationToolOf,
  turnErrorOf,
  hasDegenerateRun,
  looksDegenerate,
  buildPiArgv,
  buildPiEnv,
  makePiEngine,
} from "../src/homeserver/pi-engine.js";
import type { PiProcess, SpawnPiFn, EngineRunOptions } from "../src/homeserver/code-loop-types.js";

const FIXTURE = join(__dirname, "fixtures", "pi-fixture-2026-07-02.ndjson");
const BASH_FIXTURE = join(__dirname, "fixtures", "pi-bash-events-0.70.2.ndjson");

// ─── NDJSON parsing pinned to a synthetic fixture matching pi v0.70.2 ──────────────────

describe("pi NDJSON parsing (synthetic fixture)", () => {
  const lines = readFileSync(FIXTURE, "utf8").split("\n");

  it("counts 4 turns via turn_start events", () => {
    const turns = lines.map(parsePiLine).filter((e) => e !== null && isTurnStart(e)).length;
    expect(turns).toBe(4);
  });

  it("sums prompt+completion tokens from turn_end usage", () => {
    let prompt = 0;
    let completion = 0;
    for (const line of lines) {
      const ev = parsePiLine(line);
      if (ev === null) continue;
      const u = usageOf(ev);
      if (u !== null) {
        prompt += u.prompt;
        completion += u.completion;
      }
    }
    expect(prompt).toBe(2001);
    expect(completion).toBe(346);
  });

  it("extracts the final assistant message as the summary", () => {
    let final = "";
    for (const line of lines) {
      const ev = parsePiLine(line);
      if (ev === null) continue;
      const t = assistantTextOf(ev);
      if (t !== null) final = t;
    }
    expect(final).toContain("Fixed");
    expect(final).toContain("i <= n");
  });

  it("extracts the first completed edit/write mutation from the synthetic pi fixture", () => {
    let turn = 0;
    let firstMutationTurn: number | null = null;
    for (const line of lines) {
      const ev = parsePiLine(line);
      if (ev === null) continue;
      if (isTurnStart(ev)) turn++;
      if (firstMutationTurn === null && completedMutationToolOf(ev) !== null) {
        firstMutationTurn = turn;
      }
    }
    expect(firstMutationTurn).toBe(2);
    expect(completedMutationToolOf({
      type: "tool_execution_end",
      toolName: "edit",
      isError: true,
    })).toBeNull();
    expect(completedMutationToolOf({
      type: "tool_execution_end",
      toolName: "bash",
      isError: false,
    })).toBeNull();
  });

  it("turnErrorOf: extracts the error message from a stopReason:error turn_end; null otherwise", () => {
    const errored = { type: "turn_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } };
    expect(turnErrorOf(errored)).toBe("boom");
    // stopReason:error with no/empty message → a non-empty sentinel, never null
    expect(turnErrorOf({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "error" } })).toBeTruthy();
    // a clean stop is not an error
    expect(turnErrorOf({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "stop" } })).toBeNull();
    // no turn_end / no stopReason → null
    expect(turnErrorOf({ type: "message_end", message: { role: "assistant", content: [] } })).toBeNull();
    // the synthetic successful fixture has no errored turns
    const anyErr = readFileSync(FIXTURE, "utf8").split("\n").map(parsePiLine).filter((e) => e !== null).some((e) => turnErrorOf(e!) !== null);
    expect(anyErr).toBe(false);
  });

  it("tolerates unparseable lines (returns null, never throws)", () => {
    expect(parsePiLine("not json {")).toBeNull();
    expect(parsePiLine("")).toBeNull();
    expect(parsePiLine("   ")).toBeNull();
    expect(parsePiLine("[1,2,3]")).toBeNull(); // arrays are not events
  });
});

describe("degeneracy heuristics", () => {
  it("flags a >=400 identical non-whitespace run", () => {
    expect(hasDegenerateRun("?".repeat(400))).toBe(true);
    expect(hasDegenerateRun("?".repeat(399))).toBe(false);
  });
  it("whitespace breaks runs (deep indentation never trips)", () => {
    expect(hasDegenerateRun(("  " + "x".repeat(10) + "\n").repeat(100), 400)).toBe(false);
  });
  it("looksDegenerate catches the gateway retry-frame marker in stderr", () => {
    expect(looksDegenerate("", "data: {\"error\":{\"message\":\"The model backend produced a degenerate response and was reset\"}}", 400)).toBe(true);
  });
});

describe("pi argv + scrubbed env", () => {
  it("builds the exact Gate-D-equivalent argv", () => {
    const argv = buildPiArgv({ piBin: "/x/pi", provider: "inference-local" }, "qwen3-coder-next-80b", "do it");
    expect(argv).toEqual([
      "/x/pi", "--provider", "inference-local", "--model", "qwen3-coder-next-80b",
      "--no-session", "--print", "--mode", "json", "do it",
    ]);
  });
  it("scrubs the env — PATH/HOME/PI_CODING_AGENT_DIR/HS_API_KEY + user-bus pointers, no OPENROUTER leak", () => {
    const env = buildPiEnv({ piAgentDir: "/agent", apiKey: "svc-key" }, "/sandbox");
    expect(Object.keys(env).sort()).toEqual([
      "DBUS_SESSION_BUS_ADDRESS", "HOME", "HS_API_KEY", "PATH", "PI_CODING_AGENT_DIR", "XDG_RUNTIME_DIR",
    ]);
    expect(env["HOME"]).toBe("/sandbox");
    expect(env["HS_API_KEY"]).toBe("svc-key");
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
  });
  it("buildPiEnv carries the user-bus pointers so the OUTER systemd-run can reach the user manager from a system service", () => {
    const env = buildPiEnv({ piAgentDir: "/agent", apiKey: "svc-key" }, "/sandbox");
    const uid = process.getuid!();
    expect(env["XDG_RUNTIME_DIR"]).toBe(process.env["XDG_RUNTIME_DIR"] ?? `/run/user/${uid}`);
    expect(env["DBUS_SESSION_BUS_ADDRESS"]).toBe(
      process.env["DBUS_SESSION_BUS_ADDRESS"] ?? `unix:path=/run/user/${uid}/bus`
    );
  });
});

// ─── Fake spawn: replay canned NDJSON through the engine monitor ─────────────────────────

function makeFakeProc(lines: string[], opts: { exitCode?: number | null; waitForKill?: boolean; stderr?: string } = {}): PiProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((r) => (resolveExit = r));
  queueMicrotask(() => {
    // Guard against a synchronous mid-stream kill (readline consumes 'data' as we write, so a
    // cap breach can end the stream inside this loop) — stop writing once it's ended.
    for (const l of lines) {
      if (stdout.writableEnded) break;
      stdout.write(l + "\n");
    }
    if (opts.stderr && !stderr.writableEnded) stderr.write(opts.stderr);
    if (!opts.waitForKill) {
      if (!stdout.writableEnded) stdout.end();
      if (!stderr.writableEnded) stderr.end();
      resolveExit(opts.exitCode ?? 0);
    }
  });
  return {
    stdout,
    stderr,
    pid: 4321,
    kill() {
      try { stdout.end(); } catch { /* */ }
      try { stderr.end(); } catch { /* */ }
      resolveExit(null);
    },
    exited,
  };
}

function fakeSpawnOf(proc: PiProcess): SpawnPiFn {
  return () => proc;
}

function engineOpts(sandboxDir: string, over: Partial<EngineRunOptions> = {}): EngineRunOptions {
  return {
    sandboxDir,
    instruction: "do it",
    model: "qwen3-coder-next-80b",
    caps: { wall_s: 60, turns: 24, completion_tokens: 60_000 },
    cageArgv: [],
    growthCapBytes: 50 * 1024 * 1024,
    ...over,
  };
}

const CFG = { piBin: "/x/pi", provider: "inference-local", piAgentDir: "/agent", apiKey: "k", degeneracyRunThreshold: 400 };

describe("makePiEngine — monitored runs", () => {
  it("replays the synthetic fixture → completed, with correct usage + summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim() !== "");
    let clock = 0;
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines, { exitCode: 0 })),
      readinessProbe: async () => true,
      pollMs: 10_000,
      now: () => (clock += 100),
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("completed");
    expect(r.usage.turns).toBe(4);
    expect(r.usage.prompt_tokens).toBe(2001);
    expect(r.usage.completion_tokens).toBe(346);
    expect(r.finalMessage).toContain("Fixed");
    expect(r.telemetry).toEqual({
      first_edit_turn: 2,
      edit_start_ms: 100,
      phase_ms: { inspect: 100, edit: 100 },
      mutation_evidence: "tool-call",
      observability_coverage: 1,
      agent_check_unparseable_lines: 0,
      agent_check_coverage_loss_events: 0,
      agent_checks: [],
    });
  });

  it("records one passing agent-side TypeScript check from bash events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "check-1", toolName: "bash", args: { command: "npx --no-install tsc --noEmit -p tsconfig.json" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "check-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
    ];
    let clock = 0;
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
      now: () => (clock += 10),
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([
      {
        order: 1,
        kind: "typescript",
        command_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        started_ms: 10,
        ended_ms: 20,
        status: "passed",
        exit_code: null,
      },
    ]);
    expect(JSON.stringify(r.telemetry?.agent_checks)).not.toContain("tsconfig.json");
  });

  it("preserves a failing-then-passing check sequence without overwriting attempts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const command = "npm test";
    const lines = [JSON.stringify({ type: "turn_start" }), ...readFileSync(BASH_FIXTURE, "utf8").trim().split("\n")];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks?.map((a) => ({ order: a.order, kind: a.kind, status: a.status, exit: a.exit_code }))).toEqual([
      { order: 1, kind: "test", status: "failed", exit: 1 },
      { order: 2, kind: "test", status: "passed", exit: null },
    ]);
  });

  it("accepts harmless outer whitespace around a check command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "check-newline", toolName: "bash", args: { command: "  npm test\n" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "check-newline", toolName: "bash", isError: false }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toMatchObject([
      { order: 1, kind: "test", status: "passed", exit_code: null },
    ]);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(0);
  });

  it("bounds agent-check attempts and turns dropped attempts into coverage loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = Array.from({ length: 1_002 }, (_, index) => [
      JSON.stringify({ type: "tool_execution_start", toolCallId: `check-${index}`, toolName: "bash", args: { command: "npm test" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: `check-${index}`, toolName: "bash", isError: false }),
    ]).flat();
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toHaveLength(1_000);
    expect(r.telemetry?.agent_checks?.[0]?.order).toBe(1);
    expect(r.telemetry?.agent_checks?.[999]?.order).toBe(1_000);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(2);
  });

  it("marks a check tool execution failure distinctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "lint-1", toolName: "bash", args: { command: "npm run lint" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "lint-1", toolName: "bash", isError: true }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toMatchObject([
      { order: 1, kind: "lint", status: "execution-error", exit_code: null },
    ]);
  });

  it("does not manufacture check evidence from a misleading model summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "TypeScript and all tests passed" }] } }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.finalMessage).toContain("tests passed");
    expect(r.telemetry?.agent_checks).toEqual([]);
  });

  it("does not treat a bash command that only prints a check name as check evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "echo-1", toolName: "bash", args: { command: "echo npm test" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "echo-1", toolName: "bash", isError: false }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([]);
  });

  it("does not report a shell-masked test exit as passing check evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "masked-1", toolName: "bash", args: { command: "npm test || true" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "masked-1", toolName: "bash", isError: false }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "masked-2", toolName: "bash", args: { command: "npm test; echo done" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "masked-2", toolName: "bash", isError: false }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "masked-3", toolName: "bash", args: { command: "npm test | tee test.log" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "masked-3", toolName: "bash", isError: false }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "masked-4", toolName: "bash", args: { command: "npm test &" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "masked-4", toolName: "bash", isError: false }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "masked-5", toolName: "bash", args: { command: "npm test& wait" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "masked-5", toolName: "bash", isError: false }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "masked-6", toolName: "bash", args: { command: "npm test && npm run lint" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "masked-6", toolName: "bash", isError: false }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([]);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(6);
  });

  it("does not manufacture passing checks from quoted, commented, or substituted text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const commands = [
      "echo \"a && npm test\"",
      "git commit -m \"fix && npm test\"",
      "echo hi # && npm test",
      "grep -r '&& npm test' src",
      "echo $(printf 'a && npm test')",
      "echo `printf 'a && npm test'`",
    ];
    const lines = commands.flatMap((command, index) => [
      JSON.stringify({ type: "tool_execution_start", toolCallId: `inert-${index}`, toolName: "bash", args: { command } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: `inert-${index}`, toolName: "bash", isError: false }),
    ]);
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([]);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(commands.length);
  });

  it("counts parenthesized check candidates as coverage loss without attributing an outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "grouped-1", toolName: "bash", args: { command: "(npm test)" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "grouped-1", toolName: "bash", isError: false }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "grouped-2", toolName: "bash", args: { command: "cd repo && (npm test || true)" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "grouped-2", toolName: "bash", isError: false }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([]);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(2);
  });

  it("counts common wrapped check candidates as coverage loss without attributing an outcome", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const commands = [
      "timeout 600 npm test",
      "bash -c 'npm test'",
      "bash -lc 'npm test'",
      "sh -c \"npm test\"",
      "sh -lc \"npm test\"",
      "poetry run pytest",
      "uv run pytest",
      "pdm run pytest",
      "make test",
      "sudo npm test",
      "command npm test",
      "exec npm test",
      "nice -n 10 npm test",
      "timeout -k 5 600 npm test",
      "corepack pnpm test",
      "bun test",
      "npm exec vitest",
      "pnpm exec vitest",
    ];
    const lines = commands.flatMap((command, index) => [
      JSON.stringify({ type: "tool_execution_start", toolCallId: `wrapped-${index}`, toolName: "bash", args: { command } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: `wrapped-${index}`, toolName: "bash", isError: false }),
    ]);
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([]);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(commands.length);
  });

  it("records a parsed but uncorrelated bash end as content-blind coverage loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_end", toolCallId: "missing-start", toolName: "bash", isError: false }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toEqual([]);
    expect(r.telemetry?.agent_check_unparseable_lines).toBe(0);
    expect(r.telemetry?.agent_check_coverage_loss_events).toBe(1);
  });

  it("does not invent exit codes or trust a suffix on a successful pi event", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "build-1", toolName: "bash", args: { command: "npm run build" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "build-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "Command exited with code 2" }] } }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toMatchObject([
      { order: 1, kind: "build", status: "passed", exit_code: null },
    ]);
  });

  it("marks isError:true without pi's anchored exit suffix as execution-error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "build-1", toolName: "bash", args: { command: "npm run build" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "build-1", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "spawn failed" }] } }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks).toMatchObject([
      { order: 1, kind: "build", status: "execution-error", exit_code: null },
    ]);
  });

  it("materializes a fully parseable check start without an end as execution-error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "test-pending", toolName: "bash", args: { command: "npm test" } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "process ended early" }] } }),
    ];
    let clock = 0;
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
      now: () => (clock += 10),
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.unparseableLines).toBe(0);
    expect(r.telemetry?.agent_check_unparseable_lines).toBe(0);
    expect(r.telemetry?.agent_checks).toEqual([{
      order: 1,
      kind: "test",
      command_fingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      started_ms: 10,
      ended_ms: 20,
      status: "execution-error",
      exit_code: null,
    }]);
  });

  it("accepts a successful final && check but does not blame it for an ambiguous earlier failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "tool_execution_start", toolCallId: "test-after-good-cd", toolName: "bash", args: { command: "cd . && npm test" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "test-after-good-cd", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "passed" }] } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "test-after-cd", toolName: "bash", args: { command: "cd missing && npm test" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "test-after-cd", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "bash: cd: missing: No such file\nCommand exited with code 1" }] } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "test-after-false", toolName: "bash", args: { command: "false && npm test" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: "test-after-false", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "Command exited with code 1" }] } }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines)),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.telemetry?.agent_checks?.map((attempt) => ({ status: attempt.status, exit_code: attempt.exit_code }))).toEqual([
      { status: "passed", exit_code: null },
      { status: "execution-error", exit_code: null },
      { status: "execution-error", exit_code: null },
    ]);
  });

  it("enforces a no-edit deadline with a machine-readable failure kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = Array.from({ length: 7 }, () => JSON.stringify({ type: "turn_start" }));
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines, { waitForKill: true })),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir, {
      caps: { wall_s: 60, turns: 13, completion_tokens: 60_000, edit_deadline_turn: 6 },
    }));
    expect(r.outcome).toBe("cap-exceeded");
    expect(r.detail).toContain("edit-deadline");
    expect(r.telemetry).toMatchObject({
      mutation_evidence: "none",
      observability_coverage: 1,
      failure_kind: "edit-deadline",
      phase_ms: {},
    });
    expect(r.telemetry?.first_edit_turn).toBeUndefined();
    expect(r.telemetry?.edit_start_ms).toBeUndefined();
  });

  it("does not let a failed edit tool call satisfy the deadline", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const failedEdit = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: "edit-failed", toolName: "edit" }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "edit-failed",
        toolName: "edit",
        isError: true,
      }),
      ...Array.from({ length: 6 }, () => JSON.stringify({ type: "turn_start" })),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(failedEdit, { waitForKill: true })),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir, {
      caps: { wall_s: 60, turns: 13, completion_tokens: 60_000, edit_deadline_turn: 6 },
    }));
    expect(r.outcome).toBe("cap-exceeded");
    expect(r.telemetry).toMatchObject({
      mutation_evidence: "none",
      failure_kind: "edit-deadline",
    });
    expect(r.telemetry?.first_edit_turn).toBeUndefined();
    expect(r.telemetry?.edit_start_ms).toBeUndefined();
  });

  it("aggregates retry timing and first-edit turn from the original run start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const degenerateFinal = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "?".repeat(500) }] },
    });
    const editStart = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
    });
    const editEnd = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "write-1",
      toolName: "write",
      isError: false,
    });
    const goodFinal = JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    let call = 0;
    const spawn: SpawnPiFn = () => {
      call++;
      return call === 1
        ? makeFakeProc([JSON.stringify({ type: "turn_start" }), degenerateFinal], { exitCode: 1 })
        : makeFakeProc([JSON.stringify({ type: "turn_start" }), editStart, editEnd, goodFinal], { exitCode: 0 });
    };
    let clock = 0;
    const engine = makePiEngine(CFG, {
      spawnPi: spawn,
      readinessProbe: async () => true,
      pollMs: 10_000,
      now: () => (clock += 100),
    });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("completed");
    expect(r.usage).toMatchObject({ turns: 2, wall_ms: 400 });
    expect(r.telemetry).toMatchObject({
      first_edit_turn: 2,
      edit_start_ms: 300,
      phase_ms: { inspect: 300, edit: 100 },
      mutation_evidence: "tool-call",
    });
  });

  it("turn cap breach → kill + cap-exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = Array.from({ length: 8 }, () => JSON.stringify({ type: "turn_start" }));
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines, { waitForKill: true })),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir, { caps: { wall_s: 60, turns: 3, completion_tokens: 60_000 } }));
    expect(r.outcome).toBe("cap-exceeded");
    expect(r.detail).toContain("turns");
  });

  it("token cap breach → kill + cap-exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const lines = [
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "turn_end", message: { usage: { input: 10, output: 5000 } } }),
    ];
    const engine = makePiEngine(CFG, {
      spawnPi: fakeSpawnOf(makeFakeProc(lines, { waitForKill: true })),
      readinessProbe: async () => true,
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir, { caps: { wall_s: 60, turns: 24, completion_tokens: 1000 } }));
    expect(r.outcome).toBe("cap-exceeded");
    expect(r.detail).toContain("tokens");
  });

  it("degenerate first attempt → readiness-polled retry → recovered completed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const degenerateFinal = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "?".repeat(500) }] } });
    const goodFinal = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done cleanly" }] } });
    let call = 0;
    const spawn: SpawnPiFn = () => {
      call++;
      return call === 1
        ? makeFakeProc([JSON.stringify({ type: "turn_start" }), degenerateFinal], { exitCode: 1 })
        : makeFakeProc([JSON.stringify({ type: "turn_start" }), goodFinal], { exitCode: 0 });
    };
    let readinessCalls = 0;
    const engine = makePiEngine(CFG, {
      spawnPi: spawn,
      readinessProbe: async () => { readinessCalls++; return true; },
      pollMs: 10_000,
    });
    const r = await engine.run(engineOpts(dir));
    expect(readinessCalls).toBe(1);
    expect(r.outcome).toBe("completed");
    expect(r.detail).toContain("recovered");
    expect(r.finalMessage).toBe("done cleanly");
  });

  it("degenerate then never-ready → terminal degenerate (no second spawn)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const degenerateFinal = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "?".repeat(500) }] } });
    let call = 0;
    const spawn: SpawnPiFn = () => { call++; return makeFakeProc([degenerateFinal], { exitCode: 1 }); };
    const engine = makePiEngine(CFG, { spawnPi: spawn, readinessProbe: async () => false, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("degenerate");
    expect(call).toBe(1);
  });

  it("clean nonzero exit (not degenerate) → arm-error, no retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    let call = 0;
    const spawn: SpawnPiFn = () => { call++; return makeFakeProc([JSON.stringify({ type: "turn_start" })], { exitCode: 2 }); };
    const engine = makePiEngine(CFG, { spawnPi: spawn, readinessProbe: async () => true, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("arm-error");
    expect(call).toBe(1);
  });

  // ─── §10 pre-ship must-fix: pi records a mid-stream gateway abort as a turn_end with
  // stopReason:"error" while STILL EXITING 0 (verified live 2026-07-03 against pi 0.70.2 + the real
  // gateway degeneracy frame). Without a per-turn integrity check the harness would gate success on
  // exit-0 + no char-run and silently accept the truncated turn as "completed". ──────────────────
  const partialMsgEnd = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Let me start by editing the" }] } });
  const degenTurnEnd = JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Let me start by editing the" }], stopReason: "error", errorMessage: "The model backend produced a degenerate response and was reset — please retry.", usage: { input: 5, output: 3 } } });
  const goodMsgEnd = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done cleanly" }] } });

  it("exit-0 turn_end with stopReason:error + gateway marker → NOT completed; readiness-polled retry (§10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    let call = 0;
    const spawn: SpawnPiFn = () => {
      call++;
      return call === 1
        ? makeFakeProc([JSON.stringify({ type: "turn_start" }), partialMsgEnd, degenTurnEnd], { exitCode: 0 })
        : makeFakeProc([JSON.stringify({ type: "turn_start" }), goodMsgEnd], { exitCode: 0 });
    };
    let readinessCalls = 0;
    const engine = makePiEngine(CFG, { spawnPi: spawn, readinessProbe: async () => { readinessCalls++; return true; }, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(readinessCalls).toBe(1); // it detected the errored turn and took the degeneracy retry path
    expect(call).toBe(2);
    expect(r.outcome).toBe("completed");
    expect(r.detail).toContain("recovered");
  });

  it("exit-0 turn_end with stopReason:error but NO degeneracy marker (e.g. 'terminated') → arm-error, no retry (§10)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const terminatedTurnEnd = JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Let me start by editing the" }], stopReason: "error", errorMessage: "terminated" } });
    let call = 0;
    const spawn: SpawnPiFn = () => { call++; return makeFakeProc([JSON.stringify({ type: "turn_start" }), partialMsgEnd, terminatedTurnEnd], { exitCode: 0 }); };
    const engine = makePiEngine(CFG, { spawnPi: spawn, readinessProbe: async () => true, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("arm-error"); // surfaced, NOT silently "completed"
    expect(call).toBe(1); // not a recognizable degeneracy → no wasted readiness-poll + retry
  });

  it("arm-error detail carries the exit code AND the stderr tail (the 94ms silent-death fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    // The real failure mode: bwrap execs a pi that is ENOENT inside the cage → instant exit,
    // the only evidence on stderr. That evidence must reach the caller.
    const spawn: SpawnPiFn = () =>
      makeFakeProc([], { exitCode: 1, stderr: "bwrap: execvp /home/inference/.local/bin/pi: No such file or directory\n" });
    const engine = makePiEngine(CFG, { spawnPi: spawn, readinessProbe: async () => true, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("arm-error");
    expect(r.detail).toContain("pi exited 1");
    expect(r.detail).toContain("No such file or directory");
  });

  it("arm-error detail REDACTS the service API key (HS_API_KEY is in pi's env; the tail is forwarded raw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    const key = "hs_owner_sekret999abc";
    const spawn: SpawnPiFn = () =>
      makeFakeProc([], { exitCode: 1, stderr: `auth failed: bearer ${key} rejected by gateway\n` });
    const engine = makePiEngine({ ...CFG, apiKey: key }, { spawnPi: spawn, readinessProbe: async () => true, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("arm-error");
    expect(r.detail).not.toContain(key);
    expect(r.detail).toContain("[redacted]");
    expect(r.detail).toContain("rejected by gateway"); // the diagnostic context survives
  });

  it("arm-error detail is bounded (~400 chars of tail, not the whole stream)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cl-eng-"));
    // Long but NOT degenerate-looking (whitespace breaks identical-char runs).
    const spawn: SpawnPiFn = () => makeFakeProc([], { exitCode: 1, stderr: "error: load failure at /p\n".repeat(200) + "THE-END" });
    const engine = makePiEngine(CFG, { spawnPi: spawn, readinessProbe: async () => true, pollMs: 10_000 });
    const r = await engine.run(engineOpts(dir));
    expect(r.outcome).toBe("arm-error");
    expect(r.detail.length).toBeLessThanOrEqual(450);
    expect(r.detail).toContain("THE-END"); // the TAIL survives the bound
  });
});
