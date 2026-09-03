import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Derive the checkout root from this source file rather than process.cwd(). Tests and CLI
// subprocesses may change cwd, but the repository's private data tree remains the same target.
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_DATA_ROOT = resolve(REPOSITORY_ROOT, "data");

export function isTestRuntime(): boolean {
  return process.env["NODE_ENV"] === "test" || process.env["VITEST"] !== undefined;
}

/**
 * Canonicalize a path even when its final component has not been created yet. realpathSync only
 * accepts an existing path, so walk upward to the nearest existing ancestor and append the
 * not-yet-created suffix after resolving symlinks on that ancestor.
 */
function canonicalizeExistingAncestors(path: string): string {
  let candidate = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    suffix.unshift(basename(candidate));
    candidate = parent;
  }
  return resolve(realpathSync.native(candidate), ...suffix);
}

export function assertTestPathOutsideRepositoryData(path: string, kind: "database" | "feedback"): void {
  if (!isTestRuntime()) return;
  const canonicalPath = canonicalizeExistingAncestors(path);
  const canonicalDataRoot = canonicalizeExistingAncestors(REPOSITORY_DATA_ROOT);
  if (
    canonicalPath === canonicalDataRoot ||
    canonicalPath.startsWith(`${canonicalDataRoot}${sep}`)
  ) {
    throw new Error(
      `Refusing a test ${kind} path under the repository's ./data/ tree; use a unique OS temporary path`
    );
  }
}
