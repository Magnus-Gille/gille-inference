#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseStrixSpeculationPolicyArgs,
  renderStrixSpeculationPolicyMarkdown,
  synthesizeStrixSpeculationPolicy,
} from "../src/homeserver/strix-speculation-policy.js";

interface Dependencies {
  readFile: (path: string) => string;
  write: (path: string, content: string) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve original failure. */ }
    throw error;
  }
}

const DEFAULT_DEPS: Dependencies = {
  readFile: (path) => readFileSync(path, "utf8"),
  write: atomicWrite,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export function runStrixSpeculationPolicySynthesis(argv: string[], deps: Dependencies = DEFAULT_DEPS): number {
  try {
    const args = parseStrixSpeculationPolicyArgs(argv);
    const direct = JSON.parse(deps.readFile(args.directPath)) as unknown;
    const candidates = args.candidatePaths.map((path) => JSON.parse(deps.readFile(path)) as unknown);
    const policy = synthesizeStrixSpeculationPolicy(direct, candidates, args.minimumUsefulWorkGain, args.minimumBatches);
    const prefix = resolve(args.outPrefix);
    const jsonPath = `${prefix}.json`;
    const markdownPath = `${prefix}.md`;
    deps.write(jsonPath, `${JSON.stringify(policy, null, 2)}\n`);
    deps.write(markdownPath, renderStrixSpeculationPolicyMarkdown(policy));
    deps.stdout(JSON.stringify({
      status: "complete",
      jsonPath,
      markdownPath,
      cells: policy.cells.length,
      speculativeCells: policy.cells.filter((cell) => cell.selection === "speculative").length,
      directCells: policy.cells.filter((cell) => cell.selection === "direct").length,
    }));
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runStrixSpeculationPolicySynthesis(process.argv.slice(2));
}
