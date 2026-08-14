#!/usr/bin/env tsx
/** Prove source-level converter/runtime support for an archived model release and pinned llama.cpp checkout. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  inspectModelRuntimeCompatibility,
  renderModelRuntimeCompatibilityMarkdown,
  runtimeCompatibilitySourcePaths,
  type ModelRuntimeCompatibilityReport,
  type RuntimeCompatibilityInput,
} from "../src/homeserver/model-runtime-compatibility.js";

interface CompatibilityArgs {
  releaseJson: string;
  llamaDir: string;
  runtimeRevision: string;
  outDir: string;
}

interface CliDependencies {
  collect: (args: CompatibilityArgs) => RuntimeCompatibilityInput;
  inspect: typeof inspectModelRuntimeCompatibility;
  write: (outDir: string, report: ModelRuntimeCompatibilityReport) => string[];
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_RELEASE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseRuntimeCompatibilityArgs(argv: string[]): CompatibilityArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!["--release-json", "--llama-dir", "--runtime-revision", "--out-dir"].includes(flag)) {
      throw new Error(`unrecognized argument: ${flag}`);
    }
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, nextValue(argv, index, flag));
    index++;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined || value.trim().length === 0) throw new Error(`${flag} is required`);
    return value;
  };
  const runtimeRevision = required("--runtime-revision");
  if (!COMMIT_RE.test(runtimeRevision)) {
    throw new Error("--runtime-revision must be an immutable lowercase 40-character commit");
  }
  return {
    releaseJson: required("--release-json"),
    llamaDir: required("--llama-dir"),
    runtimeRevision,
    outDir: required("--out-dir"),
  };
}

function boundedRegularFile(path: string, maximumBytes: number): string {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`source is not a regular file: ${path}`);
  if (info.size > maximumBytes) throw new Error(`source exceeds byte limit: ${path}`);
  return readFileSync(path, "utf8");
}

function committedSource(
  checkoutRoot: string,
  commit: string,
  relativePath: string,
): string | undefined {
  try {
    return execFileSync(
      "git",
      ["-C", checkoutRoot, "show", `${commit}:${relativePath}`],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: MAX_SOURCE_BYTES + 1,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    // Missing, oversized, or unreadable commit objects are all absence of proof. The inspector
    // records the required path as missing and fails closed instead of consulting mutable files.
    return undefined;
  }
}

export function collectRuntimeCompatibilityInput(args: CompatibilityArgs): RuntimeCompatibilityInput {
  const release = JSON.parse(boundedRegularFile(resolve(args.releaseJson), MAX_RELEASE_BYTES)) as RuntimeCompatibilityInput["release"];
  const checkoutRoot = realpathSync(args.llamaDir);
  const checkoutRuntimeCommit = execFileSync("git", ["-C", checkoutRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const sources: Record<string, string> = {};
  const sourcePaths = runtimeCompatibilitySourcePaths();
  for (const relativePath of sourcePaths) {
    const path = resolve(checkoutRoot, relativePath);
    if (!path.startsWith(`${checkoutRoot}${sep}`)) throw new Error(`unsafe runtime source path: ${relativePath}`);
    const source = committedSource(checkoutRoot, args.runtimeRevision, relativePath);
    if (source !== undefined) sources[relativePath] = source;
  }
  const checkoutSourceClean =
    execFileSync(
      "git",
      ["-C", checkoutRoot, "status", "--porcelain=v1", "--untracked-files=no", "--", ...sourcePaths],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).trim().length === 0;
  return {
    release,
    requestedRuntimeCommit: args.runtimeRevision,
    checkoutRuntimeCommit,
    checkoutSourceClean,
    sources,
  };
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
}

function writeReport(outDir: string, report: ModelRuntimeCompatibilityReport): string[] {
  mkdirSync(outDir, { recursive: true });
  if (lstatSync(outDir).isSymbolicLink()) throw new Error("--out-dir must not be a symbolic link");
  const root = realpathSync(outDir);
  const jsonPath = join(root, "compatibility.json");
  const markdownPath = join(root, "REPORT.md");
  atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(markdownPath, renderModelRuntimeCompatibilityMarkdown(report));
  return [jsonPath, markdownPath];
}

const DEFAULT_DEPS: CliDependencies = {
  collect: collectRuntimeCompatibilityInput,
  inspect: inspectModelRuntimeCompatibility,
  write: writeReport,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runRuntimeCompatibilityCheck(
  argv: string[],
  dependencies: CliDependencies = DEFAULT_DEPS
): Promise<number> {
  try {
    const args = parseRuntimeCompatibilityArgs(argv);
    const report = dependencies.inspect(dependencies.collect(args));
    const paths = dependencies.write(args.outDir, report);
    dependencies.stdout(
      JSON.stringify({
        status: report.supported ? "compatible" : "incompatible",
        model: report.model,
        modelRevision: report.modelRevision,
        runtimeRevision: report.runtimeCommit,
        architecture: report.selectedArchitecture,
        paths,
      })
    );
    return report.supported ? 0 : 2;
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRuntimeCompatibilityCheck(process.argv.slice(2));
}
