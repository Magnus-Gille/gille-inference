/**
 * Issues #198 / #201 — Munin memory-consolidation prompts (15-20KB single-turn "You are a memory
 * consolidation agent for Munin... synthesize recent log entries into an enriched status
 * summary..." requests) were losing the classifyTask() keyword vote to `qa-factual`, because their
 * embedded ground-truth/log text incidentally contains "what is"/"explain"/"define" more often than
 * the lone "synthesize" hit scored. Confirmed on live traffic (owner_request_log rows #5231/#5608/
 * #5670, 2026-07-01..03): all three won qa-factual (score 3-4) over synthesis (score 1). This
 * mislabeling poisoned the #201 stratified gate sample (31/34 rows) and pollutes harvest evidence.
 *
 * This test file uses SYNTHETIC prompts that mimic the real template's generic instruction-frame
 * phrasing (fine to reuse — it's Munin's own system-prompt boilerplate, not private log content) at
 * a keyword density matching the real rows, not artificially stuffed.
 */
import { describe, it, expect } from "vitest";
import { classifyTask } from "../src/homeserver/taxonomy.js";

/**
 * Mirrors the real template's opening + a "what is"/"explain"/"define" density matching the actual
 * rows (one occurrence each) — the exact reason qa-factual was outscoring synthesis in production.
 */
const CONSOLIDATION_PROMPT = `You are a memory consolidation agent for Munin, a persistent memory system for an AI assistant.
Your job is to synthesize recent log entries into an enriched status summary for the namespace "projects/example-widget".

## Ground Truth (human-maintained — DO NOT contradict)

The following status entry is manually maintained and represents ground truth. Explain the current
architecture and define any terms a new reader would not know. What is the current phase of the
project?

## Recent Log Entries

- 2026-07-01: Decided to use library X for the queue.
- 2026-07-02: Fixed a parsing bug in the ingest path.
- 2026-07-03: Reviewed PR #42 and merged it.

## Instructions

Write an updated status summary that reconciles the log entries above with the ground truth. Keep
it factual and concise.`;

/**
 * A prompt that merely CONTAINS "synthesize" once but is really a qa-factual explainer — must NOT
 * be vacuumed into `synthesis` just because the word appears. Precision check for the fix: the new
 * synthesis keywords are specific instruction-frame markers ("consolidation agent", "enriched status
 * summary", "recent log entries into"), not generic words, so this prompt should still win qa-factual.
 */
const EXPLAINER_WITH_STRAY_SYNTHESIZE_WORD = `Explain what mitochondria are and define the term ATP.
What is their primary function in a cell? When you're done, briefly synthesize the key points into a
short closing sentence.`;

describe("taxonomy: Munin memory-consolidation prompts classify as synthesis (#198, #201)", () => {
  it("classifies a consolidation-agent prompt as synthesis, not qa-factual", () => {
    const c = classifyTask(CONSOLIDATION_PROMPT);
    expect(c.taskType).toBe("synthesis");
  });

  it("gives synthesis a clear margin over qa-factual on the consolidation prompt (not a near-tie)", () => {
    const c = classifyTask(CONSOLIDATION_PROMPT);
    const synthesisScore = c.scores["synthesis"] ?? 0;
    const qaFactualScore = c.scores["qa-factual"] ?? 0;
    expect(synthesisScore).toBeGreaterThan(qaFactualScore);
    // qa-factual still fires (the prompt legitimately contains "what is"/"explain"/"define" once
    // each) — the fix must out-score it, not suppress it.
    expect(qaFactualScore).toBeGreaterThan(0);
  });

  it("does NOT classify a prompt that merely contains the word 'synthesize' as synthesis", () => {
    const c = classifyTask(EXPLAINER_WITH_STRAY_SYNTHESIZE_WORD);
    expect(c.taskType).toBe("qa-factual");
    expect(c.taskType).not.toBe("synthesis");
  });

  it("leaves short factual questions classified as qa-factual (existing corpus untouched)", () => {
    expect(classifyTask("What is the capital of France?").taskType).toBe("qa-factual");
    expect(classifyTask("Who is the current CEO of the company?").taskType).toBe("qa-factual");
    expect(classifyTask("Explain how photosynthesis works.").taskType).toBe("qa-factual");
  });

  it("still classifies the original deep-research synthesis prompt as synthesis (no regression)", () => {
    const c = classifyTask("Synthesize these notes into a long-form sectioned report.");
    expect(c.taskType).toBe("synthesis");
  });
});
