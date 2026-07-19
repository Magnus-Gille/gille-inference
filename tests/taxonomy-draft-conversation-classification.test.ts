/**
 * Issue #198 — the "other" catch-all covered 46% of real harvest-shadow traffic (82.8% shadow-fail).
 * #211/#212 already pulled two identified templates (Munin consolidation, memory-decision) out of
 * `other`/misroutes. This closes the broader "the classifier misses real traffic shapes" gap with:
 *
 *   1. A `draft` type for generative first-draft writing (PR descriptions, commit messages, emails) —
 *      distinct from `rewrite` (reword EXISTING text) and `code-implement` (code). Before this change,
 *      "Write a professional PR description..." false-positived into `code-implement` on the bare
 *      "write a" keyword, and "Draft a commit message..." scored zero everywhere and fell to `other`.
 *   2. A `conversation` type — the issue's own suggested "conversation/agentic-turn" bucket — for
 *      open-ended multi-turn/agentic exchanges (opinions, brainstorming, "what should the agent do
 *      next") that carry no code/data/factual-question shape and previously scored zero everywhere.
 *   3. Extra `code-review` keywords ("debug", "stack trace", "why is this failing", "not working") so
 *      symptom-first debugging asks (no code pasted yet) land as code-review instead of `other`.
 *
 * These are exactly the request shapes CLAUDE.md's own delegation guidance names ("draft the PR
 * body", "draft the conventional commit message") and the kind of zero-signal agentic turn a
 * Claude-Code-driven M5 gateway sees constantly — verifiable from the classifier's own scoring
 * without needing the owner-only harvested rows.
 */
import { describe, expect, it } from "vitest";
import { classifyTask, taskTypeEmitsJson } from "../src/homeserver/taxonomy.js";
import { EXCLUDED_FROM_ROUTING, routableTaskTypes } from "../src/homeserver/routing-table-generator.js";

describe("taxonomy: draft (generative first-draft writing) (#198)", () => {
  it("classifies a commit-message draft request as draft, not other", () => {
    const c = classifyTask("Draft a commit message for this diff.");
    expect(c.taskType).toBe("draft");
  });

  it("classifies an email draft request as draft", () => {
    const c = classifyTask("Draft an email to the team about the outage.");
    expect(c.taskType).toBe("draft");
  });

  it("redirects a PR-description 'write a' prompt away from the code-implement false positive", () => {
    const c = classifyTask("Write a professional PR description summarizing these changes.");
    expect(c.taskType).toBe("draft");
    expect(c.taskType).not.toBe("code-implement");
  });

  it("does not steal a genuine code-implement 'write a function' prompt", () => {
    const c = classifyTask("Write a function that reverses a string in place.");
    expect(c.taskType).toBe("code-implement");
  });

  it("does not steal a review of an existing PR description/commit message (Codex review finding)", () => {
    // Codex cross-model review of this PR: bare artifact nouns like "pr description"/"commit
    // message" classify ANY operation on those artifacts as draft, not just first-draft requests.
    // "Review this PR description" scored draft=2 vs code-review=1 before this fix. code-review
    // gained "review this"/"review the" so ordinary review phrasing outscores the bare noun.
    expect(classifyTask("Review this PR description").taskType).toBe("code-review");
    expect(classifyTask("Can you review the commit message for typos?").taskType).toBe("code-review");
  });

  it("does not regress a generic code-implement 'write a <noun>' request into other (Codex review finding)", () => {
    // Codex cross-model review: dropping the bare "write a" keyword entirely (the original fix for
    // the PR-description false positive) traded that bug for a new one — "Write a TypeScript
    // module"/"Write a CLI" no longer matched ANY code-implement keyword and fell to `other`, the
    // exact failure mode #198 is about. "write a" is reinstated, and `draft` is ordered before
    // code-implement in TASK_TYPES so a genuine tie (a specific draft artifact phrase vs. the bare
    // "write a" signal) still resolves in draft's favor — see the PR-description test above.
    expect(classifyTask("Write a TypeScript module that parses JSON.").taskType).toBe("code-implement");
    expect(classifyTask("Write a CLI that parses command-line arguments.").taskType).toBe("code-implement");
    expect(classifyTask("Write a parser for this grammar.").taskType).toBe("code-implement");
  });

  it("is not JSON-shaped", () => {
    expect(taskTypeEmitsJson("draft")).toBe(false);
  });
});

describe("taxonomy: conversation (open-ended agentic/multi-turn turn) (#198)", () => {
  it("classifies a brainstorm/discussion request as conversation, not other", () => {
    const c = classifyTask("Let's discuss a few options here — feel free to brainstorm alternatives.");
    expect(c.taskType).toBe("conversation");
  });

  it("does not steal a casual code-review request that ends with an opinion-soliciting tail", () => {
    // "what do you think?" / "any concerns?" / "any thoughts?" are generic tail questions that
    // attach to almost any request, including ordinary code-review asks. They were dropped from
    // conversation's keyword list because, as 2-point multi-word phrases, they beat code-review's
    // single-word "review"/"critique" keywords (1 point) and stole this common phrasing (#198).
    expect(classifyTask("Review this code, what do you think?").taskType).toBe("code-review");
    expect(classifyTask("Can you critique this function? Any concerns?").taskType).toBe("code-review");
  });

  it("classifies a 'decide the next agent action' turn as conversation", () => {
    const c = classifyTask(
      "You are continuing a multi-turn agentic session. Given the tool results below, what should the agent do next?"
    );
    expect(c.taskType).toBe("conversation");
  });

  it("classifies a mid-dialogue continuation as conversation", () => {
    const c = classifyTask(
      "Continue the conversation: I said we should ship Friday, they replied with concerns about tests. What should I say next?"
    );
    expect(c.taskType).toBe("conversation");
  });

  it("does not reclassify an ordinary factual question", () => {
    expect(classifyTask("What is the capital of Sweden?").taskType).toBe("qa-factual");
  });

  it("does not steal a typed request that happens to start with an agentic preamble (Codex review finding)", () => {
    // Codex cross-model review: "given the tool results" was the same collision class as the
    // opinion tails already removed above — a generic 2-point preamble that beat a legitimate
    // 1-point keyword match on the actual task. "Given the tool results, summarize the failures"
    // scored conversation=2 vs summarize=1. Dropped from conversation's keyword list; the
    // "decide the next agent action" test below still passes on "what should the agent do next".
    expect(classifyTask("Given the tool results, summarize the failures.").taskType).toBe("summarize");
    expect(classifyTask("Given the tool results, extract the error codes.").taskType).toBe("extract");
  });
});

describe("taxonomy: code-review symptom-first debugging keywords (#198)", () => {
  it("classifies a symptom-only debugging ask as code-review, not other", () => {
    const c = classifyTask("I'm debugging a weird issue where the server hangs on startup, any ideas?");
    expect(c.taskType).toBe("code-review");
  });

  it("classifies a stack-trace-first ask as code-review", () => {
    const c = classifyTask("Getting a stack trace at startup and not working after the last deploy, why is this failing?");
    expect(c.taskType).toBe("code-review");
  });
});

describe("taxonomy: routing universe registration (#198)", () => {
  it("registers draft and conversation as routable (evidence-eligible) without assigning a model", () => {
    expect(routableTaskTypes()).toContain("draft");
    expect(routableTaskTypes()).toContain("conversation");
    expect(EXCLUDED_FROM_ROUTING.has("draft")).toBe(false);
    expect(EXCLUDED_FROM_ROUTING.has("conversation")).toBe(false);
  });
});

describe("taxonomy: existing types are untouched (additive-only guarantee) (#198)", () => {
  it("still classifies the memory-decision and synthesis templates from #211/#212", () => {
    expect(
      classifyTask(
        "You are an agent with a persistent memory.\n<retrieved_memory>\nPrior decision: use queue A.\n</retrieved_memory>\n\nA new piece of information has just arrived. Return VERDICT: {\"action\":\"REOPEN_SWITCH|REOPEN_HOLD|HOLD\"}."
      ).taskType
    ).toBe("memory-decision");
    expect(
      classifyTask(
        "You are a memory consolidation agent for Munin. Synthesize recent log entries into an enriched status summary."
      ).taskType
    ).toBe("synthesis");
  });

  it("still classifies an ordinary arithmetic word problem as reason-math", () => {
    expect(classifyTask("If a train has 12 passengers and 5 leave, how many remain?").taskType).toBe("reason-math");
  });
});
