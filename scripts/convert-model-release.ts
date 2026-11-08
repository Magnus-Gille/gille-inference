#!/usr/bin/env tsx
/**
 * Convert a staged official Hugging Face revision to GGUF (BF16, optional mmproj, quants).
 *
 * Usage:
 *   tsx scripts/convert-model-release.ts --staged-dir <abs revision dir> --llama-dir <abs pinned
 *     llama.cpp checkout> --out-dir <abs dir> --name Qwen4-27B [--quant Q4_K_M,Q8_0] [--mmproj]
 *     [--quantize-bin <abs>] [--python <abs>] [--dry-run]
 *
 * Runs on the M5 host after scripts/stage-model-release.ts. `--dry-run` prints the JSON plan only.
 * Conversion and quantization are CPU-only, so no GPU lease is needed; this command never loads a
 * model into llama-swap and never changes the live roster. Outputs are written as `.partial` files,
 * renamed atomically, hashed, and recorded in conversion-manifest.json. Nothing secret is passed
 * on any command line.
 */
import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  executeConversion,
  parseConversionArgs,
  planConversion,
  type ConversionDependencies,
} from "../src/homeserver/model-release-conversion.js";

interface CliDependencies extends ConversionDependencies {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const STDERR_TAIL_CHARS = 8192;

const DEFAULT_DEPS: CliDependencies = {
  // spawn, not execFile: a long conversion emits unbounded progress output, and execFile's
  // maxBuffer would kill the child. Progress streams to the operator; only a stderr tail is kept.
  run: (bin, argv) =>
    new Promise((resolve) => {
      const child = spawn(bin, argv, { stdio: ["ignore", "inherit", "pipe"] });
      let tail = "";
      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
      });
      child.on("error", (error) => resolve({ status: null, stderr: error.message }));
      child.on("close", (code, signal) =>
        resolve({ status: code, stderr: signal ? `${tail}\nterminated by ${signal}` : tail })
      );
    }),
  llamaCommit: (llamaDir) =>
    new Promise((resolve) => {
      execFile("git", ["-C", llamaDir, "rev-parse", "HEAD"], { timeout: 10_000 }, (error, stdout) =>
        resolve(error ? null : stdout.trim())
      );
    }),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runModelReleaseConversion(
  argv: string[],
  dependencies: CliDependencies = DEFAULT_DEPS
): Promise<number> {
  try {
    const args = parseConversionArgs(argv);
    const steps = planConversion(args);
    if (args.dryRun) {
      dependencies.stdout(JSON.stringify({ dryRun: true, steps }, null, 2));
      return 0;
    }
    const { manifestPath, manifest } = await executeConversion(args, steps, dependencies);
    dependencies.stdout(
      JSON.stringify({ status: "converted", manifestPath, outputs: manifest.outputs.length })
    );
    return 0;
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runModelReleaseConversion(process.argv.slice(2));
}
