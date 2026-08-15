import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  classifyChangedPaths,
  sha256Text,
  validateRealAgentCorpus,
} from "../scripts/real-agent-benchmark.js";

const corpusPath = new URL("../benchmarks/real-agent/corpus.json", import.meta.url);

describe("real-agent benchmark preregistration", () => {
  it("loads the pinned real-history task and keeps the hidden oracle out of the seed", () => {
    const corpus = validateRealAgentCorpus(JSON.parse(readFileSync(corpusPath, "utf8")) as unknown);
    expect(corpus.corpusRevision).toBe("strix-real-r1");
    expect(corpus.tasks).toHaveLength(1);
    const task = corpus.tasks[0];
    expect(task.id).toBe("pi-telemetry-contract");
    expect(task.source.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(task.source.referenceCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(task.source.seedPaths.some((path) => path.startsWith("benchmarks/real-agent"))).toBe(false);
    expect(task.oracleFiles.every((oracle) => !task.source.seedPaths.includes(oracle.source))).toBe(true);
    expect(sha256Text(task.instruction)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed on duplicate tasks, path traversal, and abbreviated commits", () => {
    const valid = JSON.parse(readFileSync(corpusPath, "utf8")) as { tasks: Array<Record<string, unknown>> };
    expect(() => validateRealAgentCorpus({ ...valid, tasks: [valid.tasks[0], valid.tasks[0]] })).toThrow(/duplicate/i);
    expect(() => validateRealAgentCorpus({
      ...valid,
      tasks: [{ ...valid.tasks[0], allowedChangedPaths: ["../escape"] }],
    })).toThrow(/parent/i);
    const source = valid.tasks[0]["source"] as Record<string, unknown>;
    expect(() => validateRealAgentCorpus({
      ...valid,
      tasks: [{ ...valid.tasks[0], source: { ...source, baseCommit: "4f32c11" } }],
    })).toThrow(/baseCommit/i);
    expect(() => validateRealAgentCorpus({
      ...valid,
      tasks: [{
        ...valid.tasks[0],
        source: { ...source, seedPaths: ["benchmarks"] },
      }],
    })).toThrow(/exposes oracle/i);
  });

  it("deduplicates changes and rejects every path outside the preregistered set", () => {
    expect(classifyChangedPaths(
      ["scripts/a.ts", "scripts/a.ts", "tests/a.test.ts", "node_modules", "docs/unplanned.md"],
      ["scripts/a.ts", "tests/a.test.ts"],
    )).toEqual({
      changed: ["docs/unplanned.md", "scripts/a.ts", "tests/a.test.ts"],
      disallowed: ["docs/unplanned.md"],
    });
  });
});
