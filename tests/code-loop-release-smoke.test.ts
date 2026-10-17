import { describe, expect, it } from "vitest";
import { buildSchemaReleaseSmoke } from "./fixtures/code-loop-release-smoke.js";
import { validateCodeLoopRequest } from "../src/homeserver/code-loop.js";
import { GROUNDED_GENERATED_PYTHON_SUITE, WRONG_GENERATED_PYTHON_SUITE } from "./fixtures/code-loop-schema-grounding.js";

describe("synthetic schema release smoke contract", () => {
  it.each(["positive", "negative"] as const)("%s request passes the real request validator", arm => {
    expect(validateCodeLoopRequest(buildSchemaReleaseSmoke(arm, `synthetic-${arm}`), {
      wallSDefault: 480, wallSMax: 900, turnsDefault: 24, turnsMax: 40,
      tokensDefault: 60_000, tokensMax: 120_000,
    })).toEqual({ ok: true, caps: { wall_s: 180, turns: 6, completion_tokens: 4000, edit_deadline_turn: 3 } });
  });

  it("explicitly requests an observable write, not an ambiguous shell append", () => {
    const request = buildSchemaReleaseSmoke("positive", "synthetic-positive");
    expect(request.instruction).toContain("Use the write tool");
    expect(request.instruction).toContain('"smoke\\n"');
    expect(request.instruction).toContain("Do not use bash or shell commands");
    expect(request.instruction).toContain("synthetic");
    expect(request.files.find(file => file.path === "smoke.txt")?.content).toBe("");
    expect(request.writable).toEqual(["smoke.txt"]);
    expect(request.protected).toEqual(["extractor.py", "suite.py"]);
    expect(request.caps).toEqual({ wall_s: 180, turns: 6, completion_tokens: 4000, edit_deadline_turn: 3 });
    expect(request.check_cmd).toBe("python3 -m py_compile suite.py");
    expect(request.schema_checks).toEqual([{ name: "reconstructed-schema", command: "python3 -m unittest suite.py" }]);
    expect(request.task_type).toBe("unit-test-gen");
  });

  it("changes only the deliberate oracle control and caller-owned id between arms", () => {
    const positive = buildSchemaReleaseSmoke("positive", "synthetic-positive");
    const negative = buildSchemaReleaseSmoke("negative", "synthetic-negative");
    expect(positive.files.find(file => file.path === "suite.py")?.content).toBe(GROUNDED_GENERATED_PYTHON_SUITE);
    expect(negative.files.find(file => file.path === "suite.py")?.content).toBe(WRONG_GENERATED_PYTHON_SUITE);
    expect(negative.files.filter(file => file.path !== "suite.py")).toEqual(positive.files.filter(file => file.path !== "suite.py"));
    expect({ ...negative, client_run_id: positive.client_run_id, files: positive.files }).toEqual(positive);
  });
});
