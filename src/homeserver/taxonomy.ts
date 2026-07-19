/**
 * Task taxonomy.
 *
 * The ledger learns capability *per task type*, so we need a stable set of types and a
 * cheap, deterministic way to assign an incoming prompt to one. v1 uses a keyword/regex
 * heuristic — fast, free, good enough to bucket delegations. A model-assisted classifier
 * can replace `classifyTask` later without touching the ledger or policy.
 */

export interface TaskType {
  id: string;
  label: string;
  description: string;
  /** Lower-cased keywords/phrases that vote for this type. */
  keywords: string[];
  /**
   * True when this task type's contract is a STRUCTURED JSON payload (e.g. triage's verdict object,
   * source-distill's claims array). The delegate path defaults such tasks to a `json_object`
   * response_format (see orchestrator.resolveResponseFormat / config.autoJsonResponseFormat) so
   * gpt-oss-120b's harmony decoder is grammar-constrained and can't emit the bare-JSON-no-channel-
   * markup that hard-throws a PEG 500 (#166). Prose task types leave it unset.
   */
  jsonOutput?: boolean;
}

export const TASK_TYPES: TaskType[] = [
  {
    id: "draft",
    label: "Draft generative writing",
    description:
      "Produce a first draft of non-code prose from scratch — a PR description, commit message, " +
      "email, or message — as opposed to `rewrite` (reword text that already exists) or " +
      "`code-implement` (code). #198: 'write a' alone is a code-implement keyword, so drafting asks " +
      "phrased as \"write a PR description\" were false-positiving into code-implement; other " +
      "drafting asks (\"draft a commit message\") scored zero everywhere and fell to `other`. " +
      "Declared FIRST in this array (not in its thematic spot near synthesis) so that a genuine " +
      "score TIE against code-implement's broad, weak \"write a\" keyword resolves here — the " +
      "classifier's tie-break is first-scored-wins by array position (classifyTask() below). " +
      "KNOWN LIMITATION (Codex cross-model review): \"draft\" as a verb for code (\"draft a " +
      "TypeScript module\") still wins outright with no code-implement keyword even in contention, " +
      "since none of code-implement's keywords match — the pure substring/no-negation classifier " +
      "cannot express \"draft, but only when the object isn't code\" without a code-noun allowlist " +
      "that would never be exhaustive. Accepted as lower-frequency than the fixed cases above.",
    keywords: [
      "draft a",
      "draft an",
      "draft the",
      "commit message",
      "pr description",
      "pull request description",
      "write an email",
      "write a message",
      "cover letter",
    ],
  },
  {
    id: "code-implement",
    label: "Code implementation",
    description: "Write a function/module from a spec.",
    // #198: bare "write a" is a broad, weak signal — dropping it entirely (an earlier version of
    // this fix) traded the PR-description false positive below for a new regression: "Write a
    // TypeScript module"/"Write a CLI" no longer matched ANY code-implement keyword and fell to
    // `other` (caught by cross-model review). Kept, but `draft` is declared first in TASK_TYPES
    // (see below) so a genuine tie against a specific draft artifact phrase — e.g. "Write a
    // professional PR description..." scoring "write a"(2) vs draft's "pr description"(2) —
    // resolves to draft, not code-implement.
    keywords: ["implement", "write a", "write a function", "create a function", "code that", "function that"],
  },
  {
    id: "code-edit",
    label: "Code edit/refactor",
    description: "Modify or refactor existing code.",
    keywords: ["refactor", "rename", "modify", "change the", "update the function", "edit this"],
  },
  {
    id: "code-review",
    label: "Code review / bug find",
    description: "Find bugs or critique code.",
    keywords: [
      "review",
      "find the bug",
      "what's wrong",
      "is there a bug",
      "critique",
      "spot the",
      // Symptom-first debugging asks (no code pasted, just a failure description) are the same
      // "find/diagnose the bug" job as a pasted-code review, but scored zero everywhere and fell
      // to `other` (#198).
      "debug",
      "stack trace",
      "why is this failing",
      "not working",
      // Cross-model (Codex) review of #198's first pass: bare artifact nouns on `draft` ("pr
      // description", "commit message") outscored the single-word "review"/"critique" here, so an
      // ordinary "Review this PR description" request misclassified as draft. These strengthen the
      // common review-intent phrasing so it isn't lost to a topic-only noun match.
      "review this",
      "review the",
    ],
  },
  {
    id: "unit-test-gen",
    label: "Unit-test generation",
    description: "Write tests for given code.",
    keywords: ["write a test", "unit test", "write tests", "vitest", "test case", "test for"],
  },
  {
    id: "summarize",
    label: "Summarization",
    description: "Condense text.",
    keywords: ["summarize", "summarise", "tl;dr", "in one sentence", "condense", "brief summary"],
  },
  {
    id: "extract",
    label: "Extraction",
    description: "Pull a specific field/value out of text.",
    keywords: ["extract", "pull out", "find the email", "get the", "return only the", "what is the value"],
  },
  {
    id: "classify",
    label: "Classification",
    description: "Assign a label/category.",
    keywords: ["classify", "categorize", "is this", "label this", "sentiment", "which category", "positive or negative"],
  },
  {
    id: "data-transform",
    label: "Data transformation",
    description: "Reshape data between formats (CSV→JSON etc).",
    keywords: ["convert", "transform", "to json", "to csv", "reshape", "parse this into", "as a json array"],
  },
  {
    id: "regex",
    label: "Regex authoring",
    description: "Write a regular expression.",
    keywords: ["regex", "regular expression", "pattern that matches", "match the pattern"],
  },
  {
    id: "sql",
    label: "SQL authoring",
    description: "Write a SQL query.",
    keywords: ["sql", "select query", "write a query", "join", "group by"],
  },
  {
    id: "reason-math",
    label: "Reasoning / arithmetic",
    description: "Word problems, arithmetic, logic.",
    keywords: ["how many", "calculate", "what is the total", "solve", "if a", "word problem"],
  },
  {
    id: "reason-hard",
    label: "Hard reasoning (competition/multi-step)",
    description:
      "Multi-step math, number theory, combinatorics, probability, and graduate-level conceptual " +
      "reasoning — the work a long-chain-of-thought specialist model is built for. Distinct from " +
      "reason-math (grade-school) so a reasoning model earns its own ledger verdict.",
    keywords: [
      "prove",
      "modulo",
      "number theory",
      "combinatorics",
      "probability that",
      "lowest terms",
      "smallest positive integer",
      "in how many ways",
    ],
  },
  {
    id: "rewrite",
    label: "Rewrite / rephrase",
    description: "Reword text for tone/clarity.",
    keywords: ["rewrite", "rephrase", "make this more", "formal tone", "simplify this", "reword"],
  },
  {
    id: "translate",
    label: "Translation",
    description: "Translate between languages.",
    keywords: ["translate", "in french", "in swedish", "to spanish", "translation"],
  },
  {
    id: "plan-decompose",
    label: "Planning / decomposition",
    description: "Break a goal into steps.",
    keywords: ["steps to", "break down", "plan to", "list the steps", "outline", "how would you approach"],
  },
  {
    id: "qa-factual",
    label: "Factual Q&A",
    description: "Answer a factual question.",
    keywords: ["what is", "who is", "when did", "explain", "define"],
  },
  {
    id: "triage",
    label: "Request triage",
    description:
      "Decide how to handle an incoming request — e.g. is it ready to act on, does it need " +
      "clarification, or can it be answered directly (the ratatoskr brain, ratatoskr#31). The " +
      "first production workload routed through /delegate; earns its own routing verdict (#155).",
    // Deliberately narrow keywords: triage is domain knowledge the keyword classifier largely
    // lacks (callers assert it explicitly), so these only catch the unambiguous cases and avoid
    // stealing generic prompts from classify/qa-factual.
    keywords: ["triage", "ready or clarify", "needs clarification"],
    // Triage returns a structured verdict object — the workload that produced 27/120 harmony 500s
    // on gpt-oss-120b (#164); grammar-constrain its output by default (#166).
    jsonOutput: true,
  },
  {
    id: "memory-decision",
    label: "Memory decision reconsideration",
    description:
      "Reconsider a stored decision against new information and emit a structured reopen/hold verdict. " +
      "This is distinct from arithmetic even when an embedded record happens to contain words such as " +
      "'solve' or 'if a'.",
    // These are deliberately instruction-frame / output-contract markers from the two observed
    // persistent-memory decision templates, rather than generic words such as "memory", "decision",
    // or "verdict". #198 found 205 rows of this shape being mislabelled as reason-math because the
    // keyword classifier substring-matched incidental text such as "resolve" and "verify a".
    keywords: [
      "decision record retrieved from memory",
      "with respect to the stored decision",
      "<retrieved_memory>",
      "new piece of information has just arrived",
      "reopen_switch",
      "reopen_hold",
    ],
    // Both observed variants require a JSON VERDICT object. Keep this declarative so /delegate
    // applies grammar-constrained JSON decoding by default (#166).
    jsonOutput: true,
  },
  // ─── Deep-research roles (docs/deep-research-harness-design.md §6b) ───
  // The harness routes each pipeline stage to a model; the ledger learns capability per role,
  // so these earn their own verdicts (e.g. mellum=distill, qwen3-coder-next-80b=plan/synth).
  {
    id: "research-plan",
    label: "Research planning / decomposition",
    description:
      "Decompose a research query into the right sub-questions and a bounded query set. " +
      "Model-bound (plan quality cannot be faked in glue).",
    keywords: [
      "sub-questions",
      "sub questions",
      "research plan",
      "break this research",
      "search queries for",
      "what should i search",
    ],
  },
  {
    id: "source-distill",
    label: "Per-source distillation / extraction",
    description:
      "Read one full page and extract self-contained claims with verbatim supporting quotes as " +
      "structured JSON. High-volume, throughput-dominated; the distiller role.",
    keywords: [
      "extract claims",
      "supporting quote",
      "claims and quotes",
      "distill this page",
      "as json with claims",
      "key claims from",
    ],
    // Emits claims + verbatim quotes as structured JSON — grammar-constrain it by default (#166).
    jsonOutput: true,
  },
  {
    id: "claim-verify",
    label: "Claim verification / contradiction resolution",
    description:
      "Given a set of claims that disagree across sources, judge agreement vs. genuine dispute. " +
      "Bounded; invoked only when deterministic clustering flags a conflict.",
    keywords: [
      "do these sources agree",
      "is this disputed",
      "resolve the contradiction",
      "which claim is correct",
      "contradict",
      "reconcile these",
    ],
  },
  {
    id: "gap-check",
    label: "Coverage gap assessment",
    description:
      "Given coverage so far, decide whether it is sufficient or name the remaining gaps and " +
      "fresh queries. The model never controls the loop — code enforces the iteration budget.",
    keywords: [
      "what's still missing",
      "what is still missing",
      "remaining gaps",
      "is the coverage sufficient",
      "what else should i research",
      "unanswered",
    ],
  },
  {
    id: "synthesis",
    label: "Long-form synthesis",
    description:
      "Synthesize distilled notes from many sources into a long, sectioned, cited narrative. " +
      "Quality-critical and the hardest local role; the synthesizer.",
    keywords: [
      "synthesize",
      "synthesise",
      "write a report",
      "long-form report",
      "sectioned report",
      "comprehensive overview",
      // Munin memory-consolidation prompts (15-20KB single-turn, "You are a memory consolidation
      // agent for Munin... synthesize recent log entries into an enriched status summary...") are
      // a real, high-volume synthesis workload but were losing the keyword vote to qa-factual —
      // their embedded ground-truth/log text incidentally contains "what is"/"explain"/"define"
      // more often than the lone "synthesize" hit scored (#198, #201). These are instruction-frame
      // markers specific to that template (not generic words like "consolidate"/"summary" that
      // would vacuum up unrelated prompts) so they add signal without widening the bucket.
      "consolidation agent",
      "enriched status summary",
      "recent log entries into",
    ],
  },
  {
    id: "conversation",
    label: "Conversation / agentic turn",
    description:
      "An open-ended multi-turn or agentic exchange — brainstorming, or a 'what should happen " +
      "next' turn — that carries no code/data/factual-question shape of its own. #198's suggested " +
      "catch for the largest unclassifiable slice of harvested traffic: real usage that isn't a " +
      "bounded, typed task at all.",
    // Deliberately excludes generic preambles/tails that attach to almost any request and, being
    // 2-point multi-word phrases, would outscore a legitimate 1-point keyword match on the actual
    // task: "what do you think" / "any concerns" / "any thoughts" would steal an ordinary
    // code-review ask ("review this, what do you think?" — #198 self-review caught this before
    // shipping); "given the tool results" would steal an ordinary summarize/extract ask ("Given
    // the tool results, summarize the failures" — caught by cross-model/Codex review).
    keywords: [
      "brainstorm",
      "let's discuss",
      "continue the conversation",
      "what should i say",
      "what should the agent do next",
    ],
  },
  {
    id: "other",
    label: "Other / unclassified",
    description: "Fallback bucket.",
    keywords: [],
  },
];

const TASK_TYPE_IDS = new Set(TASK_TYPES.map((t) => t.id));

export function isKnownTaskType(id: string): boolean {
  return TASK_TYPE_IDS.has(id);
}

const JSON_OUTPUT_TASK_TYPES = new Set(TASK_TYPES.filter((t) => t.jsonOutput).map((t) => t.id));

/**
 * True when the task type's contract is a structured JSON payload (TaskType.jsonOutput) — the signal
 * the delegate path uses to default a json_object response_format so gpt-oss-120b can't drift into a
 * harmony/PEG 500 (#166). Unknown ids are treated as non-JSON.
 */
export function taskTypeEmitsJson(id: string): boolean {
  return JSON_OUTPUT_TASK_TYPES.has(id);
}

export interface Classification {
  taskType: string;
  confidence: number; // 0..1, share of votes the winner took
  scores: Record<string, number>;
}

/**
 * Heuristic classifier: count keyword hits per type, return the winner. Ties and zero
 * hits fall back to "other" (which is delegated and learned just like any other type).
 */
export function classifyTask(prompt: string): Classification {
  const text = prompt.toLowerCase();
  const scores: Record<string, number> = {};
  let total = 0;
  for (const t of TASK_TYPES) {
    let score = 0;
    for (const kw of t.keywords) {
      if (text.includes(kw)) score += kw.includes(" ") ? 2 : 1; // multi-word phrases are stronger signals
    }
    if (score > 0) scores[t.id] = score;
    total += score;
  }

  let winner = "other";
  let best = 0;
  for (const [id, s] of Object.entries(scores)) {
    if (s > best) {
      best = s;
      winner = id;
    }
  }
  return {
    taskType: winner,
    confidence: total > 0 ? Math.round((best / total) * 100) / 100 : 0,
    scores,
  };
}
