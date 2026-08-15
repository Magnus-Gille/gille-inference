#!/usr/bin/env tsx
/**
 * Run a preregistered, real-history coding task through Pi and grade it deterministically.
 *
 * The model sees an immutable sparse archive of the source commit, never the hidden oracle. Raw Pi
 * events and stderr remain mode-0600 inside a throwaway directory. The durable JSONL row contains
 * only content-blind counts, timings, hashes, exit classes, and immutable provenance.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";

import {
  createPiBenchmarkTelemetry,
  observePiBenchmarkLine,
  type PiBenchmarkTelemetrySummary,
} from "./pi-benchmark-telemetry.js";

interface TaskSource {
  repository: string;
  baseCommit: string;
  referenceCommit: string;
  seedPaths: string[];
}

interface OracleFile {
  source: string;
  destination: string;
}

interface CheckSpec {
  id: string;
  command: string;
  args: string[];
  timeoutSeconds: number;
}

export interface RealAgentTaskSpec {
  id: string;
  source: TaskSource;
  instruction: string;
  allowedChangedPaths: string[];
  oracleFiles: OracleFile[];
  checks: CheckSpec[];
}

export interface RealAgentCorpus {
  schemaVersion: number;
  corpusRevision: string;
  tasks: RealAgentTaskSpec[];
}

export interface RealAgentCheckResult {
  id: string;
  pass: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputSha256: string;
}

export interface RealAgentBenchmarkResult extends PiBenchmarkTelemetrySummary {
  schemaVersion: 1;
  corpusRevision: string;
  task: string;
  model: string;
  provider: string;
  sourceBaseCommit: string;
  sourceReferenceCommit: string;
  runnerCommit: string;
  instructionSha256: string;
  piVersion: string;
  startedAt: string;
  wallMs: number;
  piExitCode: number | null;
  timedOut: boolean;
  changedPathCount: number;
  disallowedPathCount: number;
  checks: RealAgentCheckResult[];
  pass: boolean;
  exitClass: "pass" | "pi-error" | "pi-timeout" | "no-edit" | "disallowed-path" | "check-fail";
}

interface CliPlan {
  manifestPath: string;
  taskId: string | null;
  model: string | null;
  provider: string;
  outPath: string | null;
  capSeconds: number;
  keepWork: boolean;
  acknowledgeUncagedPi: boolean;
  validateOnly: boolean;
}

interface PiRunResult {
  exitCode: number | null;
  timedOut: boolean;
  telemetry: PiBenchmarkTelemetrySummary;
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent segments`);
  }
  return normalized;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value as string[];
}

export function validateRealAgentCorpus(value: unknown): RealAgentCorpus {
  const root = object(value);
  if (root === null || root["schemaVersion"] !== 1 || typeof root["corpusRevision"] !== "string") {
    throw new Error("real-agent corpus must use schemaVersion 1 and a corpusRevision");
  }
  if (!ID.test(root["corpusRevision"])) throw new Error("invalid corpusRevision");
  if (!Array.isArray(root["tasks"]) || root["tasks"].length === 0) throw new Error("corpus tasks must be non-empty");
  const seen = new Set<string>();
  const tasks = root["tasks"].map((rawTask, taskIndex): RealAgentTaskSpec => {
    const task = object(rawTask);
    if (task === null || typeof task["id"] !== "string" || !ID.test(task["id"])) throw new Error(`invalid task ${taskIndex} id`);
    if (seen.has(task["id"])) throw new Error(`duplicate task id: ${task["id"]}`);
    seen.add(task["id"]);
    const source = object(task["source"]);
    if (source === null || typeof source["repository"] !== "string") throw new Error(`task ${task["id"]} lacks source`);
    if (typeof source["baseCommit"] !== "string" || !FULL_COMMIT.test(source["baseCommit"])) throw new Error(`task ${task["id"]} has invalid baseCommit`);
    if (typeof source["referenceCommit"] !== "string" || !FULL_COMMIT.test(source["referenceCommit"])) throw new Error(`task ${task["id"]} has invalid referenceCommit`);
    const seedPaths = stringArray(source["seedPaths"], `task ${task["id"]} seedPaths`).map((path) => safeRelativePath(path, "seed path"));
    if (typeof task["instruction"] !== "string" || task["instruction"].trim().length < 80) throw new Error(`task ${task["id"]} instruction is too short`);
    const allowedChangedPaths = stringArray(task["allowedChangedPaths"], `task ${task["id"]} allowedChangedPaths`)
      .map((path) => safeRelativePath(path, "allowed path"));
    if (!Array.isArray(task["oracleFiles"]) || task["oracleFiles"].length === 0) throw new Error(`task ${task["id"]} needs oracleFiles`);
    const oracleFiles = task["oracleFiles"].map((rawOracle, oracleIndex): OracleFile => {
      const oracle = object(rawOracle);
      if (oracle === null) throw new Error(`task ${task["id"]} oracle ${oracleIndex} is invalid`);
      return {
        source: safeRelativePath(oracle["source"], "oracle source"),
        destination: safeRelativePath(oracle["destination"], "oracle destination"),
      };
    });
    for (const oracle of oracleFiles) {
      if (seedPaths.some((seed) => oracle.source === seed || oracle.source.startsWith(`${seed}/`))) {
        throw new Error(`task ${task["id"]} exposes oracle ${oracle.source} in its seed`);
      }
      if (allowedChangedPaths.includes(oracle.destination)) {
        throw new Error(`task ${task["id"]} oracle destination overlaps an allowed model path`);
      }
    }
    if (!Array.isArray(task["checks"]) || task["checks"].length === 0) throw new Error(`task ${task["id"]} needs checks`);
    const checkIds = new Set<string>();
    const checks = task["checks"].map((rawCheck, checkIndex): CheckSpec => {
      const check = object(rawCheck);
      if (check === null || typeof check["id"] !== "string" || !ID.test(check["id"])) throw new Error(`task ${task["id"]} check ${checkIndex} has invalid id`);
      if (checkIds.has(check["id"])) throw new Error(`task ${task["id"]} has duplicate check ${check["id"]}`);
      checkIds.add(check["id"]);
      if (typeof check["command"] !== "string" || check["command"] === "" || check["command"].includes("/")) throw new Error(`task ${task["id"]} check command must be a PATH binary name`);
      const args = Array.isArray(check["args"]) && check["args"].every((arg) => typeof arg === "string") ? check["args"] as string[] : null;
      if (args === null || typeof check["timeoutSeconds"] !== "number" || !Number.isInteger(check["timeoutSeconds"]) || check["timeoutSeconds"] < 1 || check["timeoutSeconds"] > 600) {
        throw new Error(`task ${task["id"]} check ${check["id"]} has invalid args or timeout`);
      }
      return { id: check["id"], command: check["command"], args, timeoutSeconds: check["timeoutSeconds"] };
    });
    return {
      id: task["id"],
      source: { repository: source["repository"], baseCommit: source["baseCommit"], referenceCommit: source["referenceCommit"], seedPaths },
      instruction: task["instruction"],
      allowedChangedPaths,
      oracleFiles,
      checks,
    };
  });
  return { schemaVersion: 1, corpusRevision: root["corpusRevision"], tasks };
}

export function classifyChangedPaths(changedPaths: string[], allowedPaths: string[]): { changed: string[]; disallowed: string[] } {
  const allowed = new Set(allowedPaths);
  const changed = [...new Set(changedPaths.filter((path) => path !== "node_modules" && !path.startsWith("node_modules/")))].sort();
  return { changed, disallowed: changed.filter((path) => !allowed.has(path)) };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveGatewayKey(env: Readonly<Record<string, string | undefined>>): string | null {
  const key = env["HS_API_KEY"] ?? env["GW_KEY"] ?? env["M5_API_KEY"];
  return key === undefined || key === "" ? null : key;
}

function loadCorpus(path: string): RealAgentCorpus {
  return validateRealAgentCorpus(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

function runSync(command: string, args: string[], cwd: string, timeoutMs: number): { status: number | null; timedOut: boolean; outputSha256: string } {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: false,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    status: result.status,
    timedOut: result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT",
    outputSha256: sha256Text(output),
  };
}

function requireGitObject(repoRoot: string, revision: string): void {
  const result = spawnSync("git", ["cat-file", "-e", `${revision}^{commit}`], { cwd: repoRoot, stdio: "ignore", shell: false });
  if (result.status !== 0) throw new Error(`required Git commit is unavailable: ${revision}`);
}

function validateTaskProvenance(repoRoot: string, task: RealAgentTaskSpec): void {
  for (const seedPath of task.source.seedPaths) {
    const result = spawnSync("git", ["cat-file", "-e", `${task.source.baseCommit}:${seedPath}`], {
      cwd: repoRoot, stdio: "ignore", shell: false,
    });
    if (result.status !== 0) throw new Error(`task ${task.id} seed path is absent at base commit: ${seedPath}`);
  }
  const result = spawnSync("git", [
    "diff", "--name-only", task.source.baseCommit, task.source.referenceCommit, "--", ...task.allowedChangedPaths,
  ], { cwd: repoRoot, encoding: "utf8", shell: false });
  if (result.status !== 0) throw new Error(`task ${task.id} reference diff is unavailable`);
  const referencePaths = String(result.stdout).split(/\r?\n/).filter(Boolean).sort();
  const expectedPaths = [...task.allowedChangedPaths].sort();
  if (JSON.stringify(referencePaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`task ${task.id} reference commit does not change every allowed path`);
  }
}

function requireCommittedBenchmarkSources(
  repoRoot: string,
  manifestPath: string,
  tasks: RealAgentTaskSpec[],
): void {
  const manifestRelative = relative(repoRoot, manifestPath);
  if (manifestRelative.startsWith("..") || manifestRelative === "") {
    throw new Error("live benchmark manifest must be inside the repository");
  }
  const paths = [...new Set([
    manifestRelative,
    "package.json",
    "package-lock.json",
    "scripts/real-agent-benchmark.ts",
    "scripts/pi-benchmark-telemetry.ts",
    ...tasks.flatMap((task) => task.oracleFiles.map((oracle) => oracle.source)),
  ])].sort();
  const status = spawnSync("git", [
    "status", "--porcelain=v1", "--untracked-files=all", "--", ...paths,
  ], { cwd: repoRoot, encoding: "utf8", shell: false });
  if (status.status !== 0) throw new Error("cannot verify benchmark source identity");
  if (String(status.stdout).trim() !== "") {
    throw new Error("live benchmark sources must be committed; commit the corpus, runner, telemetry, dependencies, and oracles first");
  }
}

function materializeSeed(repoRoot: string, task: RealAgentTaskSpec): { root: string; workDir: string; seedCommit: string } {
  const root = mkdtempSync(join(tmpdir(), "gille-real-agent-"));
  const workDir = join(root, "work");
  const archive = join(root, "seed.tar");
  mkdirSync(workDir, { mode: 0o700 });
  const archived = spawnSync("git", ["archive", "--format=tar", "--output", archive, task.source.baseCommit, ...task.source.seedPaths], {
    cwd: repoRoot, stdio: "pipe", encoding: "utf8", shell: false,
  });
  if (archived.status !== 0) throw new Error(`git archive failed: ${String(archived.stderr).slice(0, 500)}`);
  const extracted = spawnSync("tar", ["-xf", archive, "-C", workDir], { stdio: "pipe", encoding: "utf8", shell: false });
  rmSync(archive, { force: true });
  if (extracted.status !== 0) throw new Error(`seed extraction failed: ${String(extracted.stderr).slice(0, 500)}`);
  const initCommands: string[][] = [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=real-agent@local", "-c", "user.name=real-agent", "commit", "-q", "-m", "seed"],
  ];
  for (const args of initCommands) {
    const result = spawnSync("git", args, { cwd: workDir, stdio: "pipe", encoding: "utf8", shell: false });
    if (result.status !== 0) throw new Error(`seed Git initialization failed: ${String(result.stderr).slice(0, 500)}`);
  }
  const seedCommit = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8", shell: false }).stdout).trim();
  const nodeModules = join(repoRoot, "node_modules");
  if (!existsSync(nodeModules)) throw new Error(`node_modules is unavailable at ${nodeModules}`);
  symlinkSync(nodeModules, join(workDir, "node_modules"), "dir");
  return { root, workDir, seedCommit };
}

function changedPaths(workDir: string, seedCommit: string): string[] {
  const tracked = spawnSync("git", ["diff", "--name-only", seedCommit, "--"], { cwd: workDir, encoding: "utf8", shell: false });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: workDir, encoding: "utf8", shell: false });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error("cannot enumerate benchmark changes");
  return `${tracked.stdout}\n${untracked.stdout}`.split(/\r?\n/).filter(Boolean);
}

async function closeWritable(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((accept, reject) => {
    stream.once("error", reject);
    stream.end(accept);
  });
}

async function runPi(input: { workDir: string; logDir: string; task: RealAgentTaskSpec; model: string; provider: string; capSeconds: number }): Promise<PiRunResult> {
  const key = resolveGatewayKey(process.env);
  if (key === null) throw new Error("HS_API_KEY, GW_KEY, or canonical M5_API_KEY is required for a live run");
  // Keep harness artifacts outside the scored Git tree so they can never be mistaken for model
  // edits. The parent temp root is still mode-private and removed with the worktree by default.
  const rawPath = join(input.logDir, "pi-events.ndjson");
  const stderrPath = join(input.logDir, "pi-stderr.log");
  const raw = createWriteStream(rawPath, { flags: "wx", mode: 0o600, encoding: "utf8" });
  const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600, encoding: "utf8" });
  const telemetry = createPiBenchmarkTelemetry();
  const child = spawn("pi", [
    "--provider", input.provider,
    "--model", input.model,
    "--no-session",
    "--print",
    "--mode", "json",
    input.task.instruction,
  ], {
    cwd: input.workDir,
    env: {
      ...process.env,
      HS_API_KEY: key,
      GIT_CEILING_DIRECTORIES: dirname(input.workDir),
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
  child.stderr.pipe(stderr);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    const hardKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    hardKill.unref();
  }, input.capSeconds * 1000);
  timer.unref();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const exitPromise = new Promise<number | null>((accept, reject) => {
    child.once("error", reject);
    child.once("close", accept);
  });
  try {
    for await (const line of lines) {
      if (!raw.write(`${line}\n`)) await once(raw, "drain");
      observePiBenchmarkLine(telemetry, line, performance.now());
    }
    const exitCode = await exitPromise;
    return { exitCode, timedOut, telemetry: telemetry.summary() };
  } finally {
    clearTimeout(timer);
    await Promise.all([closeWritable(raw), closeWritable(stderr)]);
  }
}

function installOracles(repoRoot: string, workDir: string, task: RealAgentTaskSpec): void {
  for (const oracle of task.oracleFiles) {
    const source = resolve(repoRoot, oracle.source);
    const destination = resolve(workDir, oracle.destination);
    if (relative(repoRoot, source).startsWith("..") || relative(workDir, destination).startsWith("..")) {
      throw new Error("oracle path escaped its root");
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, 0o600);
  }
}

function runChecks(workDir: string, checks: CheckSpec[]): RealAgentCheckResult[] {
  return checks.map((check) => {
    const started = performance.now();
    const result = runSync(check.command, check.args, workDir, check.timeoutSeconds * 1000);
    return {
      id: check.id,
      pass: result.status === 0 && !result.timedOut,
      exitCode: result.status,
      timedOut: result.timedOut,
      durationMs: Math.round(performance.now() - started),
      outputSha256: result.outputSha256,
    };
  });
}

function appendResult(path: string, result: RealAgentBenchmarkResult): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

function parseArgs(argv: string[], defaultManifest: string): CliPlan {
  const plan: CliPlan = {
    manifestPath: defaultManifest,
    taskId: null,
    model: null,
    provider: "inference-gille",
    outPath: null,
    capSeconds: 900,
    keepWork: false,
    acknowledgeUncagedPi: false,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--keep-work") { plan.keepWork = true; continue; }
    if (flag === "--ack-uncaged-pi") { plan.acknowledgeUncagedPi = true; continue; }
    if (flag === "--validate") { plan.validateOnly = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
    index++;
    if (flag === "--manifest") plan.manifestPath = resolve(value);
    else if (flag === "--task") plan.taskId = value;
    else if (flag === "--model") plan.model = value;
    else if (flag === "--provider") plan.provider = value;
    else if (flag === "--out") plan.outPath = resolve(value);
    else if (flag === "--cap-s") plan.capSeconds = Number(value);
    else throw new Error(`unknown option: ${flag}`);
  }
  if (!Number.isInteger(plan.capSeconds) || plan.capSeconds < 30 || plan.capSeconds > 3600) throw new Error("--cap-s must be an integer from 30 to 3600");
  if (!plan.validateOnly && (plan.taskId === null || plan.model === null || plan.outPath === null)) {
    throw new Error("usage: real-agent-benchmark --task <id> --model <id> --out <results.jsonl> --ack-uncaged-pi [--provider <id>] [--cap-s <seconds>] [--keep-work]");
  }
  if (!plan.validateOnly && !plan.acknowledgeUncagedPi) {
    throw new Error("live Pi is not OS-caged; pass --ack-uncaged-pi only for an owner-authored public seed with no secrets");
  }
  if (plan.model !== null && (plan.model.startsWith("-") || !/^[A-Za-z0-9._/-]+$/.test(plan.model))) throw new Error("invalid model id");
  if (plan.provider.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(plan.provider)) throw new Error("invalid provider id");
  return plan;
}

export async function runRealAgentBenchmark(argv: string[]): Promise<number> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const defaultManifest = join(repoRoot, "benchmarks", "real-agent", "corpus.json");
  let plan: CliPlan;
  let corpus: RealAgentCorpus;
  try {
    plan = parseArgs(argv, defaultManifest);
    corpus = loadCorpus(plan.manifestPath);
    for (const task of corpus.tasks) {
      requireGitObject(repoRoot, task.source.baseCommit);
      requireGitObject(repoRoot, task.source.referenceCommit);
      validateTaskProvenance(repoRoot, task);
      for (const oracle of task.oracleFiles) {
        if (!existsSync(resolve(repoRoot, oracle.source))) throw new Error(`missing oracle: ${oracle.source}`);
      }
    }
    if (plan.validateOnly) {
      process.stdout.write(`${JSON.stringify({ ok: true, corpusRevision: corpus.corpusRevision, tasks: corpus.tasks.map((task) => task.id) })}\n`);
      return 0;
    }
    requireCommittedBenchmarkSources(repoRoot, plan.manifestPath, corpus.tasks);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const task = corpus.tasks.find((candidate) => candidate.id === plan.taskId);
  if (task === undefined) {
    process.stderr.write(`unknown task: ${plan.taskId}\n`);
    return 2;
  }
  const runnerCommit = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", shell: false }).stdout).trim();
  const piVersion = String(spawnSync("pi", ["--version"], { encoding: "utf8", shell: false }).stdout).trim();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let prepared: ReturnType<typeof materializeSeed> | null = null;
  try {
    prepared = materializeSeed(repoRoot, task);
    const pi = await runPi({
      workDir: prepared.workDir,
      logDir: prepared.root,
      task,
      model: plan.model!,
      provider: plan.provider,
      capSeconds: plan.capSeconds,
    });
    const paths = classifyChangedPaths(changedPaths(prepared.workDir, prepared.seedCommit), task.allowedChangedPaths);
    installOracles(repoRoot, prepared.workDir, task);
    const checks = runChecks(prepared.workDir, task.checks);
    const pass = pi.exitCode === 0 && !pi.timedOut && paths.changed.length > 0 && paths.disallowed.length === 0 && checks.every((check) => check.pass);
    const exitClass: RealAgentBenchmarkResult["exitClass"] = pi.timedOut
      ? "pi-timeout"
      : pi.exitCode !== 0
        ? "pi-error"
        : paths.changed.length === 0
          ? "no-edit"
          : paths.disallowed.length > 0
            ? "disallowed-path"
            : checks.some((check) => !check.pass)
              ? "check-fail"
              : "pass";
    const result: RealAgentBenchmarkResult = {
      schemaVersion: 1,
      corpusRevision: corpus.corpusRevision,
      task: task.id,
      model: plan.model!,
      provider: plan.provider,
      sourceBaseCommit: task.source.baseCommit,
      sourceReferenceCommit: task.source.referenceCommit,
      runnerCommit,
      instructionSha256: sha256Text(task.instruction),
      piVersion,
      startedAt,
      wallMs: Math.round(performance.now() - started),
      piExitCode: pi.exitCode,
      timedOut: pi.timedOut,
      changedPathCount: paths.changed.length,
      disallowedPathCount: paths.disallowed.length,
      checks,
      pass,
      exitClass,
      ...pi.telemetry,
    };
    appendResult(plan.outPath!, result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (plan.keepWork) process.stderr.write(`kept work directory: ${prepared.workDir}\n`);
    return pass ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    if (prepared !== null && !plan.keepWork) rmSync(prepared.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRealAgentBenchmark(process.argv.slice(2));
}
