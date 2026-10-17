import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CODE_LOOP_SCHEMA_FIXTURE_PROVENANCE,
  CODE_LOOP_USAGE_SCHEMA,
  CODE_LOOP_SCHEMA_TASK_INSTRUCTION,
  GROUNDED_GENERATED_PYTHON_SUITE,
  MUTANT_IMPLEMENTATIONS,
  RECONSTRUCTED,
  REFERENCE_PYTHON_IMPLEMENTATION,
  WRONG_GENERATED_PYTHON_SUITE,
} from "./fixtures/code-loop-schema-grounding.js";

function runPythonSuite(extractor: string, suite: string): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "gille-schema-grounding-"));
  try {
    writeFileSync(join(directory, "extractor.py"), extractor, "utf8");
    writeFileSync(join(directory, "suite.py"), suite, "utf8");
    const result = spawnSync("python3", ["-m", "unittest", "suite.py"], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function compilePython(source: string): { status: number | null; output: string } {
  const directory = mkdtempSync(join(tmpdir(), "gille-schema-compile-"));
  const path = join(directory, "suite.py");
  try {
    writeFileSync(path, source, "utf8");
    const result = spawnSync("python3", ["-m", "py_compile", path], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
    });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("reconstructed code-loop schema grounding fixture (#260)", () => {
  it("is explicitly marked reconstructed and states the closed contract", () => {
    expect(RECONSTRUCTED).toBe("RECONSTRUCTED");
    expect(CODE_LOOP_SCHEMA_FIXTURE_PROVENANCE.originalArtifact).toBe(false);
    expect(CODE_LOOP_USAGE_SCHEMA.input.relevantEvent).toMatchObject({
      eventType: "event.type == 'event_msg'",
      payloadType: "event.payload.type == 'token_count'",
      usage: "event.payload.info.last_token_usage",
      sessionMetadata: "event.payload.session_meta.session_id",
      turnMetadata: "event.payload.turn_context.call_id",
      spawnMetadata: "event.payload.turn_context.source.subagent.thread_spawn",
    });
    expect(CODE_LOOP_USAGE_SCHEMA.output.cardinality).toContain("one row");
    expect(CODE_LOOP_USAGE_SCHEMA.output.ordering).toEqual([
      "timestamp ascending",
      "call_id ascending as deterministic tie-breaker",
    ]);
    expect(CODE_LOOP_SCHEMA_TASK_INSTRUCTION).toContain("payload.info.last_token_usage");
    expect(CODE_LOOP_SCHEMA_TASK_INSTRUCTION).toContain("event.timestamp");
    expect(CODE_LOOP_SCHEMA_TASK_INSTRUCTION).toContain("one dictionary per remaining token_count event/call");
    expect(CODE_LOOP_SCHEMA_TASK_INSTRUCTION).toContain("call_id ascending");
  });

  it("compiles the reconstructed wrong suite, but the wrong assertions fail against the reference", () => {
    const compileResult = compilePython(WRONG_GENERATED_PYTHON_SUITE);
    expect(compileResult.status, compileResult.output).toBe(0);
    const result = runPythonSuite(REFERENCE_PYTHON_IMPLEMENTATION, WRONG_GENERATED_PYTHON_SUITE);
    expect(result.status, result.output).not.toBe(0);
  });

  it("passes the grounded suite against the reference implementation", () => {
    const result = runPythonSuite(REFERENCE_PYTHON_IMPLEMENTATION, GROUNDED_GENERATED_PYTHON_SUITE);
    expect(result, result.output).toMatchObject({ status: 0 });
  });

  it.each(Object.entries(MUTANT_IMPLEMENTATIONS))(
    "grounded suite rejects named mutant %s",
    (name, mutant) => {
      const result = runPythonSuite(mutant, GROUNDED_GENERATED_PYTHON_SUITE);
      expect(result.status, `${name}: ${result.output}`).toBe(1);
    },
  );
});
