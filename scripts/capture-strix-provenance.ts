#!/usr/bin/env tsx
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { release as kernelRelease } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateServerProvenance, type StrixServerProvenance } from "../src/homeserver/strix-server-benchmark.js";

interface CaptureArgs {
  pid: number;
  modelArtifact: string;
  runtimeCommit: string;
  backend: "vulkan" | "hip";
  quant: string;
  contextSize: number;
  kvTypeK: string;
  kvTypeV: string;
  flashAttention: "on" | "off" | "auto";
  batch: number;
  ubatch: number;
  parallelism: number;
  speculation: string;
  draftDepth: number | null;
  cacheRamMiB: number;
  contextCheckpoints: number;
  checkpointMinStep: number;
  cacheIdleSlots: "on" | "off";
  outPath: string;
}

interface Dependencies {
  hashFile: (path: string) => Promise<string>;
  readProcExe: (pid: number) => string;
  readProcArgs: (pid: number) => Buffer;
  kernel: () => string;
  mesa: () => string | null;
  rocm: () => string | null;
  write: (path: string, content: string) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positive(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function nonNegative(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`);
  return value;
}

function cacheRamMiB(raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < -1) throw new Error("--cache-ram-mib must be -1 or a non-negative integer");
  return value;
}

export function parseCaptureArgs(argv: string[]): CaptureArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) throw new Error(`unrecognized argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, nextValue(argv, index, flag));
    index++;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined || value.trim() === "") throw new Error(`${flag} is required`);
    return value;
  };
  const backend = required("--backend");
  if (backend !== "vulkan" && backend !== "hip") throw new Error("--backend must be vulkan or hip");
  const flashAttention = required("--fa");
  if (flashAttention !== "on" && flashAttention !== "off" && flashAttention !== "auto") throw new Error("--fa must be on, off, or auto");
  const draftRaw = required("--draft-depth");
  const draftDepth = draftRaw === "none" ? null : positive(draftRaw, "--draft-depth");
  const cacheIdleSlots = required("--cache-idle-slots");
  if (cacheIdleSlots !== "on" && cacheIdleSlots !== "off") throw new Error("--cache-idle-slots must be on or off");
  return {
    pid: positive(required("--pid"), "--pid"),
    modelArtifact: required("--model-artifact"),
    runtimeCommit: required("--runtime-commit"),
    backend,
    quant: required("--quant"),
    contextSize: positive(required("--context"), "--context"),
    kvTypeK: required("--kv-k"),
    kvTypeV: required("--kv-v"),
    flashAttention,
    batch: positive(required("--batch"), "--batch"),
    ubatch: positive(required("--ubatch"), "--ubatch"),
    parallelism: positive(required("--parallelism"), "--parallelism"),
    speculation: required("--speculation"),
    draftDepth,
    cacheRamMiB: cacheRamMiB(required("--cache-ram-mib")),
    contextCheckpoints: nonNegative(required("--ctx-checkpoints"), "--ctx-checkpoints"),
    checkpointMinStep: nonNegative(required("--checkpoint-min-step"), "--checkpoint-min-step"),
    cacheIdleSlots,
    outPath: required("--out"),
  };
}

async function hashFile(path: string): Promise<string> {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact is not a non-empty regular file: ${path}`);
  return await new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

const SPECULATION_VALUE_FLAGS = new Set([
  "--spec-type",
  "--spec-draft-n",
  "--spec-draft-n-min",
  "--spec-draft-n-max",
  "--spec-draft-p-min",
  "--spec-draft-p-split",
]);

interface ObservedSpeculationArgs {
  invariantSha256: string;
  speculation: string | null;
  draftDepth: number | null;
}

function analyzeServerArgs(procArgs: Buffer): ObservedSpeculationArgs {
  const argv = procArgs.toString("utf8").split("\0");
  if (argv.at(-1) === "") argv.pop();
  const invariant: string[] = [];
  const speculationValues = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    const inlineFlag = [...SPECULATION_VALUE_FLAGS].find((flag) => token.startsWith(`${flag}=`));
    const flag = inlineFlag ?? (SPECULATION_VALUE_FLAGS.has(token) ? token : null);
    if (flag !== null) {
      if (speculationValues.has(flag)) throw new Error(`duplicate speculation argument: ${flag}`);
      const value = inlineFlag === undefined ? argv[index + 1] : token.slice(flag.length + 1);
      if (value === undefined || value === "" || (inlineFlag === undefined && value.startsWith("--"))) {
        throw new Error(`speculation argument requires a value: ${flag}`);
      }
      speculationValues.set(flag, value);
      if (inlineFlag === undefined) index++;
      continue;
    }
    if (token.startsWith("--spec-")) throw new Error(`unsupported speculation argument: ${token}`);
    invariant.push(token);
  }
  const depthFlags = ["--spec-draft-n", "--spec-draft-n-max"].filter((flag) => speculationValues.has(flag));
  if (depthFlags.length > 1) throw new Error(`ambiguous speculation draft depth flags: ${depthFlags.join(", ")}`);
  const rawDepth = depthFlags.length === 0 ? null : speculationValues.get(depthFlags[0]!)!;
  const draftDepth = rawDepth === null ? null : Number(rawDepth);
  if (draftDepth !== null && (!Number.isSafeInteger(draftDepth) || draftDepth <= 0)) {
    throw new Error("captured speculation draft depth must be a positive integer");
  }
  return {
    invariantSha256: createHash("sha256").update(JSON.stringify(invariant)).digest("hex"),
    speculation: speculationValues.get("--spec-type") ?? null,
    draftDepth,
  };
}

export function hashServerArgsInvariant(procArgs: Buffer): string {
  return analyzeServerArgs(procArgs).invariantSha256;
}

function commandVersion(command: string, args: string[], pattern: RegExp): string | null {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return output.match(pattern)?.[1] ?? output.trim().split("\n")[0]?.slice(0, 200) ?? null;
  } catch { return null; }
}

function rocmVersion(): string | null {
  try { return readFileSync("/opt/rocm/.info/version", "utf8").trim() || null; }
  catch { return commandVersion("rocminfo", ["--version"], /(?:version|rocminfo)\s*[: ]\s*([^\n]+)/i); }
}

function atomicWrite(path: string, content: string): void {
  const resolved = resolve(path);
  mkdirSync(dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, resolved);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve original failure. */ }
    throw error;
  }
}

const DEFAULT_DEPS: Dependencies = {
  hashFile,
  readProcExe: (pid) => readlinkSync(`/proc/${pid}/exe`, "utf8"),
  readProcArgs: (pid) => readFileSync(`/proc/${pid}/cmdline`),
  kernel: kernelRelease,
  mesa: () => commandVersion("vulkaninfo", ["--summary"], /Mesa\s+([0-9]+(?:\.[0-9]+){1,3})/i),
  rocm: rocmVersion,
  write: atomicWrite,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runCaptureStrixProvenance(argv: string[], deps: Dependencies = DEFAULT_DEPS): Promise<number> {
  try {
    const args = parseCaptureArgs(argv);
    const runtimeBinary = deps.readProcExe(args.pid);
    const procArgs = deps.readProcArgs(args.pid);
    if (procArgs.byteLength === 0) throw new Error("server process has an empty command line");
    const observedSpeculation = analyzeServerArgs(procArgs);
    const declaredDirect = args.speculation === "none" && args.draftDepth === null;
    const observedDirect = (observedSpeculation.speculation === null || observedSpeculation.speculation === "none") &&
      observedSpeculation.draftDepth === null;
    if (declaredDirect !== observedDirect || (!declaredDirect && args.speculation !== observedSpeculation.speculation)) {
      throw new Error("declared speculation mode does not match the captured process argv");
    }
    if (args.draftDepth !== observedSpeculation.draftDepth) {
      throw new Error("declared draft depth does not match the captured process argv");
    }
    const provenance: StrixServerProvenance = validateServerProvenance({
      schemaVersion: 1,
      modelArtifactSha256: await deps.hashFile(args.modelArtifact),
      runtimeCommit: args.runtimeCommit,
      runtimeBinarySha256: await deps.hashFile(runtimeBinary),
      serverArgsSha256: createHash("sha256").update(procArgs).digest("hex"),
      serverArgsInvariantSha256: observedSpeculation.invariantSha256,
      backend: args.backend,
      quant: args.quant,
      kernel: deps.kernel(),
      mesaVersion: deps.mesa(),
      rocmVersion: deps.rocm(),
      contextSize: args.contextSize,
      kvTypeK: args.kvTypeK,
      kvTypeV: args.kvTypeV,
      flashAttention: args.flashAttention,
      batch: args.batch,
      ubatch: args.ubatch,
      parallelism: args.parallelism,
      speculation: args.speculation,
      draftDepth: args.draftDepth,
      cacheRamMiB: args.cacheRamMiB,
      contextCheckpoints: args.contextCheckpoints,
      checkpointMinStep: args.checkpointMinStep,
      cacheIdleSlots: args.cacheIdleSlots,
    });
    deps.write(args.outPath, `${JSON.stringify(provenance, null, 2)}\n`);
    deps.stdout(JSON.stringify({ status: "complete", outPath: resolve(args.outPath), pid: args.pid }));
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCaptureStrixProvenance(process.argv.slice(2));
}
