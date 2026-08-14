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
    const provenance: StrixServerProvenance = validateServerProvenance({
      schemaVersion: 1,
      modelArtifactSha256: await deps.hashFile(args.modelArtifact),
      runtimeCommit: args.runtimeCommit,
      runtimeBinarySha256: await deps.hashFile(runtimeBinary),
      serverArgsSha256: createHash("sha256").update(procArgs).digest("hex"),
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
