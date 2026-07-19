/**
 * Issue #198 — persistent-memory decision-reconsideration traffic was counted as `reason-math`.
 *
 * On the live box, 205/206 sampled reason-math rows (2026-07-01..10) were one of two variants of
 * this structured REOPEN_SWITCH / REOPEN_HOLD / HOLD workload. A lone arithmetic keyword could
 * match inside incidental prose (for example "resolve" or "verify a"), despite no arithmetic task
 * being present. These synthetic prompts retain only the shared instruction frame and output
 * contract; they intentionally contain no private memory content.
 */
import { describe, expect, it } from "vitest";
import { classifyTask, taskTypeEmitsJson } from "../src/homeserver/taxonomy.js";
import { EXCLUDED_FROM_ROUTING, routableTaskTypes } from "../src/homeserver/routing-table-generator.js";

const DECISION_RECORD_VARIANT = `You are an AI agent managing a long-running project with a persistent memory system.
Below is a decision record retrieved from memory. Your job is to decide how to respond to the new
information with respect to the stored decision. Verify a claim before you resolve any conflict.

Return VERDICT: {"class":"REOPEN_SWITCH|REOPEN_HOLD|HOLD","reason":"..."}.`;

const RETRIEVED_MEMORY_VARIANT = `You are an agent with a persistent memory.
<retrieved_memory>
Prior decision: use queue A.
</retrieved_memory>

A new piece of information has just arrived. Return VERDICT:
{"action":"REOPEN_SWITCH|REOPEN_HOLD|HOLD","reason":"..."}.`;

describe("taxonomy: persistent-memory decision reconsideration (#198)", () => {
  it("classifies the decision-record template as memory-decision, not arithmetic", () => {
    const c = classifyTask(DECISION_RECORD_VARIANT);
    expect(c.taskType).toBe("memory-decision");
    expect(c.taskType).not.toBe("reason-math");
    expect(c.scores["memory-decision"]).toBeGreaterThan(c.scores["reason-math"] ?? 0);
  });

  it("classifies the retrieved-memory template as memory-decision", () => {
    const c = classifyTask(RETRIEVED_MEMORY_VARIANT);
    expect(c.taskType).toBe("memory-decision");
    expect(c.taskType).not.toBe("reason-math");
  });

  it("declares the reopen/hold verdict workload JSON-shaped", () => {
    expect(taskTypeEmitsJson("memory-decision")).toBe(true);
  });

  it("adds the lane to the evidence-based routing universe without assigning it a model", () => {
    // A future table generation may learn a route from verifier-backed evidence. Until then, the
    // checked-in table has no entry and the orchestrator's normal unknown-lane policy applies.
    expect(routableTaskTypes()).toContain("memory-decision");
    expect(EXCLUDED_FROM_ROUTING.has("memory-decision")).toBe(false);
  });

  it("does not reclassify an ordinary arithmetic task", () => {
    expect(classifyTask("If a train has 12 passengers and 5 leave, how many remain?").taskType).toBe("reason-math");
  });
});
