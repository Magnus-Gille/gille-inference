import { describe, it, expect } from "vitest";
import { classifyTask, isKnownTaskType, TASK_TYPES } from "../src/homeserver/taxonomy.js";
import {
  routableTaskTypes,
  EXCLUDED_FROM_ROUTING,
} from "../src/homeserver/routing-table-generator.js";

/** The 5 deep-research roles the ledger must learn per-model (design §6b). */
const RESEARCH_TYPES = ["research-plan", "source-distill", "claim-verify", "gap-check", "synthesis"];

describe("taxonomy: deep-research task types", () => {
  it("registers all five research roles as known task types", () => {
    for (const id of RESEARCH_TYPES) {
      expect(isKnownTaskType(id)).toBe(true);
    }
  });

  it("keeps a unique id per task type (no accidental dupes)", () => {
    const ids = TASK_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("classifies a distillation prompt as source-distill", () => {
    const c = classifyTask("Read this page and extract claims with a supporting quote as JSON.");
    expect(c.taskType).toBe("source-distill");
  });

  it("classifies a gap prompt as gap-check", () => {
    const c = classifyTask("Given what we have so far, what is still missing and unanswered?");
    expect(c.taskType).toBe("gap-check");
  });

  it("classifies a synthesis prompt as synthesis", () => {
    const c = classifyTask("Synthesize these notes into a long-form sectioned report.");
    expect(c.taskType).toBe("synthesis");
  });

  it("classifies a contradiction prompt as claim-verify", () => {
    const c = classifyTask("These sources contradict each other — resolve the contradiction.");
    expect(c.taskType).toBe("claim-verify");
  });

  it("classifies a planning prompt as research-plan", () => {
    const c = classifyTask("Produce the sub-questions and search queries for this research plan.");
    expect(c.taskType).toBe("research-plan");
  });

  it("leaves an unrelated prompt out of the research buckets", () => {
    const c = classifyTask("Refactor this function and rename the variable.");
    expect(RESEARCH_TYPES).not.toContain(c.taskType);
  });
});

describe("taxonomy: triage as a first-class routable task type (issue #155)", () => {
  it("registers triage as a known task type", () => {
    expect(isKnownTaskType("triage")).toBe(true);
  });

  it("makes triage a routable type (in the generator's routable set, not excluded)", () => {
    // Adding triage to TASK_TYPES must flow through to the routing-table generator's routable set,
    // so a future regeneration (#157) can learn a triage-specific verdict from ledger evidence.
    expect(routableTaskTypes()).toContain("triage");
    expect(EXCLUDED_FROM_ROUTING.has("triage")).toBe(false);
  });
});
