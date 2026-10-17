#!/usr/bin/env tsx

/**
 * Check an observer review bundle's offline integrity and structure.
 *
 * This command does not authorize mutation, qualify Linux state, or contact M5.
 */
import { pathToFileURL } from "node:url";

import {
  checkObserverReviewBundle,
  type ObserverBundleReport,
} from "../src/homeserver/observer-review-bundle.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SOURCE = "observer-review-bundle-v1" as const;
const UNEXPECTED_FAILURE_REASON = "unexpected wrapper failure";

const HELP = `Usage: tsx scripts/check-observer-review-bundle.ts <directory> <sha256>
       tsx scripts/check-observer-review-bundle.ts --help

Checks observer review bundle integrity and structure offline only.
This command never authorizes M5 work or mutation.
It never performs Linux qualification or contacts M5.
`;

export interface ObserverReviewBundleCliDependencies {
  checkObserverReviewBundle?: typeof checkObserverReviewBundle;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}

interface ParsedArguments {
  help: boolean;
  directory?: string;
  expectedDigest?: string;
}

function unexpectedFailureReport(): ObserverBundleReport {
  return {
    source: SOURCE,
    valid: false,
    authorizesMutation: false,
    packetSha256: null,
    reasons: [UNEXPECTED_FAILURE_REASON],
  };
}

function parseArguments(argv: string[]): ParsedArguments {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length !== 2) throw new Error("expected exactly <directory> and <sha256>");
  const [directory, expectedDigest] = argv;
  if (!directory || !expectedDigest || !SHA256_HEX.test(expectedDigest)) {
    throw new Error("expected a lowercase 64-character hexadecimal sha256 digest");
  }
  return { help: false, directory, expectedDigest };
}

export async function main(
  argv = process.argv.slice(2),
  dependencies: ObserverReviewBundleCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));

  let args: ParsedArguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    stderr(`[observer-review-bundle] usage error: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    return 2;
  }

  if (args.help) {
    stdout(HELP);
    return 0;
  }

  try {
    const check = dependencies.checkObserverReviewBundle ?? checkObserverReviewBundle;
    const report = await check(args.directory!, args.expectedDigest!);
    stdout(`${JSON.stringify(report)}\n`);
    return report.valid ? 0 : 1;
  } catch {
    stdout(`${JSON.stringify(unexpectedFailureReport())}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify(unexpectedFailureReport())}\n`);
    process.exitCode = 1;
  });
}
