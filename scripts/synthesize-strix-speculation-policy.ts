#!/usr/bin/env tsx
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseStrixSpeculationPolicyArgs,
  renderStrixSpeculationPolicyMarkdown,
  synthesizeStrixSpeculationPolicy,
} from "../src/homeserver/strix-speculation-policy.js";

interface Dependencies {
  readFile: (path: string) => string;
  writePair: (jsonPath: string, json: string, markdownPath: string, markdown: string) => void;
  canonicalPath: (path: string) => string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface ArtifactPairFileOps {
  exists: (path: string) => boolean;
  mkdir: (path: string) => void;
  writeExclusive: (path: string, content: string) => void;
  rename: (from: string, to: string) => void;
  unlink: (path: string) => void;
}

const DEFAULT_PAIR_OPS: ArtifactPairFileOps = {
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  writeExclusive: (path, content) => writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }),
  rename: renameSync,
  unlink: unlinkSync,
};

function stagedWrite(path: string, content: string, ops: ArtifactPairFileOps): string {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  ops.writeExclusive(temporary, content);
  return temporary;
}

export function writeArtifactPair(
  jsonPath: string,
  json: string,
  markdownPath: string,
  markdown: string,
  ops: ArtifactPairFileOps = DEFAULT_PAIR_OPS
): void {
  if (dirname(jsonPath) !== dirname(markdownPath)) throw new Error("policy artifacts must share a directory");
  ops.mkdir(dirname(jsonPath));
  let temporaryJson: string | null = null;
  let temporaryMarkdown: string | null = null;
  const backupJson = `${jsonPath}.${process.pid}.${randomUUID()}.bak`;
  const backupMarkdown = `${markdownPath}.${process.pid}.${randomUUID()}.bak`;
  let backedUpJson = false;
  let backedUpMarkdown = false;
  let publishedJson = false;
  let publishedMarkdown = false;
  try {
    temporaryJson = stagedWrite(jsonPath, json, ops);
    temporaryMarkdown = stagedWrite(markdownPath, markdown, ops);
    if (ops.exists(jsonPath)) {
      ops.rename(jsonPath, backupJson);
      backedUpJson = true;
    }
    if (ops.exists(markdownPath)) {
      ops.rename(markdownPath, backupMarkdown);
      backedUpMarkdown = true;
    }
    ops.rename(temporaryMarkdown, markdownPath);
    temporaryMarkdown = null;
    publishedMarkdown = true;
    ops.rename(temporaryJson, jsonPath);
    temporaryJson = null;
    publishedJson = true;
  } catch (error) {
    for (const path of [temporaryJson, temporaryMarkdown]) {
      if (path === null) continue;
      try { ops.unlink(path); } catch { /* Best-effort rollback. */ }
    }
    if (publishedJson) {
      try { ops.unlink(jsonPath); } catch { /* Best-effort rollback. */ }
    }
    if (publishedMarkdown) {
      try { ops.unlink(markdownPath); } catch { /* Best-effort rollback. */ }
    }
    if (backedUpJson) {
      try { ops.rename(backupJson, jsonPath); } catch { /* Preserve original failure. */ }
    }
    if (backedUpMarkdown) {
      try { ops.rename(backupMarkdown, markdownPath); } catch { /* Preserve original failure. */ }
    }
    throw error;
  }
  if (backedUpJson) {
    try { ops.unlink(backupJson); } catch { /* The published pair is authoritative. */ }
  }
  if (backedUpMarkdown) {
    try { ops.unlink(backupMarkdown); } catch { /* The published pair is authoritative. */ }
  }
}

export function canonicalProspectivePath(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync.native(resolved);
  const suffix = [basename(resolved)];
  let ancestor = dirname(resolved);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve output path: ${path}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync.native(ancestor), ...suffix);
}

const DEFAULT_DEPS: Dependencies = {
  readFile: (path) => readFileSync(path, "utf8"),
  writePair: writeArtifactPair,
  canonicalPath: canonicalProspectivePath,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export function runStrixSpeculationPolicySynthesis(argv: string[], deps: Dependencies = DEFAULT_DEPS): number {
  try {
    const args = parseStrixSpeculationPolicyArgs(argv);
    const prefix = resolve(args.outPrefix);
    const jsonPath = `${prefix}.json`;
    const markdownPath = `${prefix}.md`;
    const inputPaths = [args.directPath, ...args.candidatePaths].map(deps.canonicalPath);
    if ([jsonPath, markdownPath].map(deps.canonicalPath).some((path) => inputPaths.includes(path))) {
      throw new Error("output artifacts must not overwrite input evidence");
    }
    const direct = JSON.parse(deps.readFile(args.directPath)) as unknown;
    const candidates = args.candidatePaths.map((path) => JSON.parse(deps.readFile(path)) as unknown);
    const policy = synthesizeStrixSpeculationPolicy(direct, candidates, args.minimumUsefulWorkGain, args.minimumBatches);
    deps.writePair(
      jsonPath,
      `${JSON.stringify(policy, null, 2)}\n`,
      markdownPath,
      renderStrixSpeculationPolicyMarkdown(policy)
    );
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
