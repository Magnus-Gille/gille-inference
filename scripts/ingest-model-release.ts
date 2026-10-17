#!/usr/bin/env tsx
/**
 * Archive and inspect the public control files for an official Hugging Face model release.
 *
 * The default target is Qwen/Qwen3.8-27B. The command never fetches weights: it reads public Hub
 * metadata, pins the immutable revision, downloads only small configuration/tokenizer control
 * files, and writes deterministic JSON plus Markdown beneath the gitignored data/ tree.
 *
 * Exit codes:
 *   0 — public release archived and inspected
 *   1 — malformed input or inconsistent/unsafe public release metadata
 *   3 — model is not publicly available yet (HTTP 401/403/404)
 */
import { pathToFileURL } from "node:url";

import {
  collectPublicRelease,
  parseReleaseIngestionArgs,
  ReleaseUnavailableError,
  writeReleaseArchive,
  type ReleaseArchive,
} from "../src/homeserver/model-release-ingestion.js";

interface CliDependencies {
  collect: (model: string) => Promise<ReleaseArchive>;
  write: typeof writeReleaseArchive;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_DEPS: CliDependencies = {
  collect: (model) => collectPublicRelease(model),
  write: writeReleaseArchive,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runReleaseIngestion(
  argv: string[],
  dependencies: CliDependencies = DEFAULT_DEPS
): Promise<number> {
  let model = "Qwen/Qwen3.8-27B";
  try {
    const args = parseReleaseIngestionArgs(argv);
    model = args.model;
    const archive = await dependencies.collect(args.model);
    const written = dependencies.write(args.outDir, archive);
    const reportPath = written.find((path) => path.endsWith("/REPORT.md")) ?? null;
    const releaseJsonPath = written.find((path) => path.endsWith("/release.json")) ?? null;
    dependencies.stdout(
      JSON.stringify({
        status: "archived",
        model: archive.inspection.model.id,
        revision: archive.inspection.model.revision,
        directory: archive.relativeDirectory,
        releaseJsonPath,
        reportPath,
        filesWritten: written.length,
      })
    );
    return 0;
  } catch (error) {
    if (error instanceof ReleaseUnavailableError) {
      dependencies.stdout(
        JSON.stringify({ status: "unavailable", model, httpStatus: error.statusCode })
      );
      return 3;
    }
    dependencies.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReleaseIngestion(process.argv.slice(2));
}
