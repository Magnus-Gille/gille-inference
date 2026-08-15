#!/usr/bin/env tsx
/**
 * Reproducible single-stream llama-bench harness for the 128 GB Strix Halo node.
 *
 * Run this on M5 under the repository GPU lease. The command never downloads a model and never
 * changes serving state; it hashes an explicitly staged GGUF, executes an explicitly named
 * llama-bench binary without a shell, samples read-only Linux telemetry, and writes <out>.json
 * plus <out>.md atomically.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { release as kernelRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import {
  assertStrixBenchmarkCoverage,
  buildLlamaBenchArgs,
  makeStrixBenchmarkReport,
  parseStrixBenchmarkArgs,
  renderStrixBenchmarkMarkdown,
  type LlamaBenchRow,
  type StrixBenchmarkPlan,
  type StrixBenchmarkReport,
  type StrixSystemSnapshot,
  type StrixTelemetry,
} from "../src/homeserver/strix-benchmark.js";

export interface ExecutionResult {
  rows: LlamaBenchRow[];
  telemetry: StrixTelemetry;
}

export interface CliDependencies {
  hashModel: (path: string) => Promise<string>;
  execute: (plan: StrixBenchmarkPlan) => Promise<ExecutionResult>;
  systemSnapshot: () => StrixSystemSnapshot;
  writeReport: (prefix: string, report: StrixBenchmarkReport) => { jsonPath: string; markdownPath: string };
  now: () => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

async function sha256File(path: string): Promise<string> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`model artifact is not a non-empty regular file: ${path}`);
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function readNumber(path: string): number | null {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function hwmonFiles(pattern: RegExp): string[] {
  const root = "/sys/class/hwmon";
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .flatMap((entry) => {
        try {
          return readdirSync(join(root, entry.name))
            .filter((name) => pattern.test(name))
            .map((name) => join(root, entry.name, name));
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function maxReadable(paths: string[], divisor: number): number | null {
  const values = paths.map(readNumber).filter((value): value is number => value !== null).map((value) => value / divisor);
  return values.length === 0 ? null : Math.max(...values);
}

function memAvailableBytes(): number | null {
  try {
    const match = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function processRssBytes(pid: number): number | null {
  try {
    const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function validateRows(value: unknown): LlamaBenchRow[] {
  if (!Array.isArray(value)) throw new Error("llama-bench JSON root must be an array");
  const requiredStrings = ["build_commit", "cpu_info", "gpu_info", "backends", "model_filename", "model_type"];
  const requiredNumbers = [
    "build_number", "model_size", "model_n_params", "n_batch", "n_ubatch", "flash_attn",
    "n_prompt", "n_gen", "n_depth", "avg_ts", "stddev_ts",
  ];
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error(`llama-bench row ${index} is not an object`);
    const row = item as Record<string, unknown>;
    if (requiredStrings.some((field) => typeof row[field] !== "string")) throw new Error(`llama-bench row ${index} lacks a required string field`);
    if (requiredNumbers.some((field) => typeof row[field] !== "number" || !Number.isFinite(row[field]))) throw new Error(`llama-bench row ${index} lacks a required numeric field`);
    if (typeof row["type_k"] !== "string" || typeof row["type_v"] !== "string") throw new Error(`llama-bench row ${index} lacks KV types`);
    return row as LlamaBenchRow;
  });
}

async function executeLlamaBench(plan: StrixBenchmarkPlan): Promise<ExecutionResult> {
  if (!existsSync(plan.llamaBenchPath)) throw new Error(`llama-bench binary does not exist: ${plan.llamaBenchPath}`);
  const availableBefore = memAvailableBytes();
  const temperatureFiles = hwmonFiles(/^temp\d+_input$/);
  const powerFiles = hwmonFiles(/^power\d+_(?:average|input)$/);
  const temperatureSamples: number[] = [];
  const powerSamples: number[] = [];
  let peakRssBytes: number | null = null;
  let stdout = "";
  let stderr = "";

  const child = spawn(plan.llamaBenchPath, buildLlamaBenchArgs(plan), {
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  const sample = (): void => {
    if (child.pid !== undefined) {
      const rss = processRssBytes(child.pid);
      if (rss !== null) peakRssBytes = peakRssBytes === null ? rss : Math.max(peakRssBytes, rss);
    }
    const temperature = maxReadable(temperatureFiles, 1000);
    if (temperature !== null) temperatureSamples.push(temperature);
    const power = maxReadable(powerFiles, 1_000_000);
    if (power !== null) powerSamples.push(power);
  };
  sample();
  const sampler = setInterval(sample, 250);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) child.kill("SIGTERM");
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-1_000_000);
  });
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code ?? 1));
  }).finally(() => {
    clearInterval(sampler);
    sample();
  });
  if (exitCode !== 0) throw new Error(`llama-bench exited ${exitCode}: ${stderr.trim().slice(-2000)}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`llama-bench stdout is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    rows: validateRows(parsed),
    telemetry: {
      peakRssBytes,
      availableRamBeforeBytes: availableBefore,
      availableRamAfterBytes: memAvailableBytes(),
      maxTemperatureC: temperatureSamples.length === 0 ? null : Math.max(...temperatureSamples),
      averagePowerW: powerSamples.length === 0 ? null : powerSamples.reduce((sum, value) => sum + value, 0) / powerSamples.length,
    },
  };
}

function commandVersion(command: string, args: string[], pattern: RegExp): string | null {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return output.match(pattern)?.[1] ?? output.trim().split("\n")[0]?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

function systemSnapshot(): StrixSystemSnapshot {
  let rocmVersion: string | null = null;
  try {
    rocmVersion = readFileSync("/opt/rocm/.info/version", "utf8").trim() || null;
  } catch {
    rocmVersion = commandVersion("rocminfo", ["--version"], /(?:version|rocminfo)\s*[: ]\s*([^\n]+)/i);
  }
  return {
    kernel: kernelRelease(),
    mesaVersion: commandVersion("vulkaninfo", ["--summary"], /Mesa\s+([0-9]+(?:\.[0-9]+){1,3})/i),
    rocmVersion,
  };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw error;
  }
}

function writeReport(prefix: string, report: StrixBenchmarkReport): { jsonPath: string; markdownPath: string } {
  const resolvedPrefix = resolve(prefix);
  const jsonPath = `${resolvedPrefix}.json`;
  const markdownPath = `${resolvedPrefix}.md`;
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(markdownPath, renderStrixBenchmarkMarkdown(report));
  return { jsonPath, markdownPath };
}

export const DEFAULT_DEPS: CliDependencies = {
  hashModel: sha256File,
  execute: executeLlamaBench,
  systemSnapshot,
  writeReport,
  now: () => new Date().toISOString(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runStrixBenchmark(argv: string[], dependencies: CliDependencies = DEFAULT_DEPS): Promise<number> {
  try {
    const plan = parseStrixBenchmarkArgs(argv);
    const startedAt = dependencies.now();
    const modelSha256 = await dependencies.hashModel(plan.modelPath);
    const execution = await dependencies.execute(plan);
    const report = makeStrixBenchmarkReport({
      plan,
      modelSha256,
      rows: execution.rows,
      startedAt,
      finishedAt: dependencies.now(),
      system: dependencies.systemSnapshot(),
      telemetry: execution.telemetry,
    });
    assertStrixBenchmarkCoverage(report.results, plan.contexts);
    const paths = dependencies.writeReport(plan.outPrefix, report);
    dependencies.stdout(JSON.stringify({ status: "complete", ...paths, modelSha256, rows: report.results.length }));
    return 0;
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runStrixBenchmark(process.argv.slice(2));
}
