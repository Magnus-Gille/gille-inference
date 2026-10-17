#!/usr/bin/env tsx
/**
 * Stage an exact public Hugging Face model revision without changing the live model roster.
 *
 * The command requires an immutable revision and an explicit output root. It plans from the
 * pinned public Hub tree, downloads resumably, verifies all LFS weight SHA-256 values, records
 * hashes for control files, and atomically publishes the completed revision directory.
 */
import { pathToFileURL } from "node:url";

import {
  collectPublicStagePlan,
  parseModelStageArgs,
  stageModelRelease,
  type ModelStagePlan,
  type ModelStageResult,
} from "../src/homeserver/model-release-staging.js";

interface CliDependencies {
  collect: (model: string, revision: string) => Promise<ModelStagePlan>;
  stage: (
    plan: ModelStagePlan,
    outRoot: string,
    options: { minFreeAfterBytes: number }
  ) => Promise<ModelStageResult>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_DEPS: CliDependencies = {
  collect: collectPublicStagePlan,
  stage: (plan, outRoot, options) => stageModelRelease(plan, outRoot, options),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export async function runModelReleaseStaging(
  argv: string[],
  dependencies: CliDependencies = DEFAULT_DEPS
): Promise<number> {
  try {
    const args = parseModelStageArgs(argv);
    const plan = await dependencies.collect(args.model, args.revision);
    const result = await dependencies.stage(plan, args.outRoot, {
      minFreeAfterBytes: args.minFreeAfterBytes,
    });
    dependencies.stdout(
      JSON.stringify({
        status: result.status,
        model: plan.model,
        revision: plan.revision,
        directory: result.directory,
        manifestPath: result.manifestPath,
        files: plan.files.length,
        totalBytes: result.totalBytes,
      })
    );
    return 0;
  } catch (error) {
    dependencies.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runModelReleaseStaging(process.argv.slice(2));
}
