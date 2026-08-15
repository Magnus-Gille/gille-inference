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
  modelInferenceMs: number | null;
  timedModelMessages: number;
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

export function createPiBenchmarkTelemetry(): PiBenchmarkTelemetry {
  let turns = 0;
  let toolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let modelInferenceMs = 0;
  let timedModelMessages = 0;
  let unparseableLines = 0;
  let assistantMessageStartedMs: number | null = null;

  return {
    observe(event, observedMs) {
      const type = event["type"];
      if (type === "turn_start") turns++;
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
      if (type === "message_end" && roleOf(event) === "assistant" && assistantMessageStartedMs !== null) {
        const elapsed = observedMs - assistantMessageStartedMs;
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          modelInferenceMs += elapsed;
          timedModelMessages++;
        }
        assistantMessageStartedMs = null;
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
        modelInferenceMs: timedModelMessages > 0 ? Math.round(modelInferenceMs) : null,
        timedModelMessages,
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

function writeSummary(path: string, summary: PiBenchmarkTelemetrySummary): void {
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
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      raw.write(`${line}\n`);
      observePiBenchmarkLine(telemetry, line, performance.now());
    }
    await new Promise<void>((accept, reject) => {
      raw.once("error", reject);
      raw.end(accept);
    });
    writeSummary(plan.summaryPath, telemetry.summary());
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
