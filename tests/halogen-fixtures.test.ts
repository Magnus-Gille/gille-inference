import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type OracleFile = { source: string; destination: string };
type HalogenTask = {
  id: string;
  fixtureRoot: string;
  seedPaths: string[];
  allowedChangedPaths: string[];
  oracleFiles: OracleFile[];
};

const taskIds = ["py-jsonl-usage-report", "py-interval-report"];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadTask(id: string): HalogenTask {
  return JSON.parse(
    readFileSync(resolve(repositoryRoot, "benchmarks/halogen/tasks", `${id}.json`), "utf8"),
  ) as HalogenTask;
}

function runHiddenOracle(root: string): ReturnType<typeof spawnSync> {
  return spawnSync("python3", ["-B", "tests/hidden.py"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function materializeSeed(task: HalogenTask, root: string): void {
  const fixtureRoot = resolve(repositoryRoot, task.fixtureRoot);
  cpSync(join(fixtureRoot, "app"), join(root, "app"), { recursive: true });
}

function installOracle(task: HalogenTask, root: string): void {
  const oracle = task.oracleFiles[0];
  expect(oracle).toBeDefined();
  const destination = resolve(root, "tests", "hidden.py");
  expect(destination.startsWith(`${root}/`)).toBe(true);
  const source = resolve(repositoryRoot, oracle.source);
  expect(source.startsWith(`${repositoryRoot}/`)).toBe(true);
  mkdirFor(destination);
  copyFileSync(source, destination);
}

function mkdirFor(file: string): void {
  const parent = file.slice(0, file.lastIndexOf("/"));
  mkdirSync(parent, { recursive: true });
}

describe("synthetic Halogen fixtures", () => {
  it("keeps oracles/references out of seeds and proves seed-red/reference-green", () => {
    for (const id of taskIds) {
      const task = loadTask(id);
      const fixtureRoot = resolve(repositoryRoot, task.fixtureRoot);
      const referenceRoot = resolve(repositoryRoot, "benchmarks/halogen/references", task.id);

      expect(task.seedPaths.length).toBeGreaterThan(0);
      expect(task.allowedChangedPaths).toEqual(
        task.allowedChangedPaths.filter((path) => task.seedPaths.includes(path)),
      );
      const seedAbsolutePaths = task.seedPaths.map((path) => resolve(fixtureRoot, path));
      const oracleAbsolutePaths = task.oracleFiles.map(({ source }) => resolve(repositoryRoot, source));
      expect(oracleAbsolutePaths.every((path) => !seedAbsolutePaths.includes(path))).toBe(true);
      expect(seedAbsolutePaths.some((path) => path.includes("/oracles/") || path.includes("/references/"))).toBe(false);
      expect(seedAbsolutePaths.some((path) => path === referenceRoot || path.startsWith(`${referenceRoot}/`))).toBe(false);
      expect(fixtureRoot.startsWith(`${repositoryRoot}/benchmarks/halogen/fixtures/`)).toBe(true);
      expect(referenceRoot.startsWith(`${repositoryRoot}/benchmarks/halogen/references/`)).toBe(true);
      expect(existsSync(referenceRoot)).toBe(true);

      const seedRoot = mkdtempSync(join(tmpdir(), `halogen-${id}-seed-`));
      const referenceWorkRoot = mkdtempSync(join(tmpdir(), `halogen-${id}-reference-`));
      try {
        materializeSeed(task, seedRoot);
        installOracle(task, seedRoot);
        const seedResult = runHiddenOracle(seedRoot);
        expect(seedResult.error).toBeUndefined();
        expect(seedResult.status, seedResult.stderr || seedResult.stdout).not.toBe(0);

        materializeSeed(task, referenceWorkRoot);
        cpSync(join(referenceRoot, "app"), join(referenceWorkRoot, "app"), { recursive: true });
        installOracle(task, referenceWorkRoot);
        const referenceResult = runHiddenOracle(referenceWorkRoot);
        expect(referenceResult.error).toBeUndefined();
        expect(referenceResult.status, referenceResult.stderr || referenceResult.stdout).toBe(0);
      } finally {
        rmSync(seedRoot, { recursive: true, force: true });
        rmSync(referenceWorkRoot, { recursive: true, force: true });
      }
    }
  });
});
