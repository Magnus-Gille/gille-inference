import type { CodeLoopRequest } from "../../src/homeserver/code-loop-types.js";
import {
  GROUNDED_GENERATED_PYTHON_SUITE,
  REFERENCE_PYTHON_IMPLEMENTATION,
  WRONG_GENERATED_PYTHON_SUITE,
} from "./code-loop-schema-grounding.js";

/** Synthetic compatibility input only. Building it neither submits a job nor authorizes one. */
export function buildSchemaReleaseSmoke(
  arm: "positive" | "negative",
  clientRunId: string,
): CodeLoopRequest {
  return {
    client_run_id: clientRunId,
    instruction: 'This is a synthetic release compatibility check, not organic test generation. ' +
      'Use the write tool to set the existing empty smoke.txt file to exactly "smoke\\n" (smoke followed by one newline), then finish. ' +
      'Do not use bash or shell commands to make this change: shell mutations do not satisfy the edit/write deadline. ' +
      'Do not edit, repair, run, or reinterpret extractor.py or suite.py: they are deliberate protected positive/negative control fixtures. ' +
      'The owner runs their checks after your write. Do not create any other files.',
    files: [
      { path: "extractor.py", content: REFERENCE_PYTHON_IMPLEMENTATION },
      { path: "suite.py", content: arm === "positive" ? GROUNDED_GENERATED_PYTHON_SUITE : WRONG_GENERATED_PYTHON_SUITE },
      { path: "smoke.txt", content: "" },
    ],
    check_cmd: "python3 -m py_compile suite.py",
    schema_checks: [{ name: "reconstructed-schema", command: "python3 -m unittest suite.py" }],
    writable: ["smoke.txt"],
    protected: ["extractor.py", "suite.py"],
    task_type: "unit-test-gen",
    caps: { wall_s: 180, turns: 6, completion_tokens: 4000, edit_deadline_turn: 3 },
  };
}
