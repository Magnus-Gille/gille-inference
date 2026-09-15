import { describe, expect, it } from "vitest";

import {
  HALOGEN_PILOT_CEILING_MS,
  HALOGEN_PILOT_TEN_MINUTES_MS,
  type HalogenPilotRow,
  summarizeHalogenPilot,
} from "../src/homeserver/halogen-evidence.js";

const TASKS = ["task-a", "task-b", "task-c"];
const PROFILE = "a".repeat(64);
const COMMIT = "b".repeat(40);

function rows(overrides: Partial<HalogenPilotRow> = {}): HalogenPilotRow[] {
  return TASKS.flatMap((task) => [1, 2, 3].map((repetition) => ({
    id: task + "-" + repetition,
    task,
    repetition,
    pass: true,
    checksPassed: 2,
    checksTotal: 2,
    timedOut: false,
    exitClass: "pass",
    disallowedPathCount: 0,
    wallMs: 30_000,
    firstEditMs: 2_000,
    finishReason: "stop",
    profileSha256: PROFILE,
    runnerCommit: COMMIT,
    ...overrides,
  })));
}

describe("summarizeHalogenPilot", () => {
  it("qualifies a complete nine-row pilot and reports both completion budgets", () => {
    const result = summarizeHalogenPilot(rows(), TASKS);

    expect(result).toMatchObject({
      status: "pilot-qualified",
      reasons: [],
      profileSha256: PROFILE,
      runnerCommit: COMMIT,
      rowCount: 9,
      completedByTenMinutes: 9,
      completedByCeiling: 9,
    });
  });

  it("fails closed for duplicate and missing task repetitions", () => {
    const complete = rows();
    const duplicate = [...complete.slice(0, 8), { ...complete[0], id: "replacement" }];

    const result = summarizeHalogenPilot(duplicate, TASKS);

    expect(result.status).toBe("hold");
    expect(result.reasons).toEqual(expect.arrayContaining(["duplicate_row", "missing_row"]));
  });

  it("fails closed for an unexpected task and mixed immutable profiles", () => {
    const evidence = rows();
    evidence[0] = { ...evidence[0], task: "task-unexpected", profileSha256: "c".repeat(64) };

    const result = summarizeHalogenPilot(evidence, TASKS);

    expect(result.status).toBe("hold");
    expect(result.reasons).toEqual(expect.arrayContaining(["unexpected_row", "missing_row", "mixed_profile_sha256"]));
    expect(result.profileSha256).toBe(null);
  });

  it("does not let a hidden check failure qualify the pilot", () => {
    const evidence = rows();
    evidence[4] = { ...evidence[4], pass: true, checksPassed: 1, checksTotal: 2 };

    const result = summarizeHalogenPilot(evidence, TASKS);

    expect(result.status).toBe("hold");
    expect(result.reasons).toContain("checks_failed");
  });

  it("requires finite positive wall time within the ceiling and a successful first edit", () => {
    const overCeiling = rows({ wallMs: HALOGEN_PILOT_CEILING_MS + 1 });
    const result = summarizeHalogenPilot(overCeiling, TASKS);
    expect(result.status).toBe("hold");
    expect(result.reasons).toContain("wall_exceeds_ceiling");

    const noFirstEdit = rows({ firstEditMs: null });
    expect(summarizeHalogenPilot(noFirstEdit, TASKS).reasons).toContain("first_edit_missing");

    const afterFinish = rows({ firstEditMs: 40_000, wallMs: 30_000 });
    expect(summarizeHalogenPilot(afterFinish, TASKS).reasons).toContain("first_edit_invalid");
  });

  it("returns HOLD for malformed input without throwing", () => {
    expect(() => summarizeHalogenPilot(null, TASKS)).not.toThrow();
    expect(summarizeHalogenPilot(null, TASKS)).toMatchObject({ status: "hold" });
    expect(summarizeHalogenPilot(null, TASKS).reasons).toContain("invalid_input");
    expect(summarizeHalogenPilot(rows(), ["task-a", "task-a", "task-b"]).status).toBe("hold");
  });

  it("counts successful completions against ten-minute and ceiling budgets", () => {
    const evidence = rows();
    evidence[0] = { ...evidence[0], wallMs: HALOGEN_PILOT_TEN_MINUTES_MS + 1 };
    evidence[1] = { ...evidence[1], wallMs: HALOGEN_PILOT_CEILING_MS + 1 };

    const result = summarizeHalogenPilot(evidence, TASKS);

    expect(result.completedByTenMinutes).toBe(7);
    expect(result.completedByCeiling).toBe(8);
    expect(result.status).toBe("hold");
  });
  it("excludes path violations and missing first edits from completion counters", () => {
    const evidence = rows();
    evidence[0] = { ...evidence[0], disallowedPathCount: 1 };
    evidence[1] = { ...evidence[1], firstEditMs: null };

    const result = summarizeHalogenPilot(evidence, TASKS);

    expect(result.completedByTenMinutes).toBe(7);
    expect(result.completedByCeiling).toBe(7);
    expect(result.status).toBe("hold");
  });

});
