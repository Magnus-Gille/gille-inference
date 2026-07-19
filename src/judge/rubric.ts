import type { TaskDefinition } from "../types.js";

// ─── Judge system prompt ──────────────────────────────────────────────────────

export const JUDGE_SYSTEM_PROMPT =
  "You are an expert evaluator assessing AI-generated responses. Be strict but fair: 'acceptable' means it works but has clear room for improvement. 'good' means you'd accept this in a professional context. Return only valid JSON.";

// ─── Prompt builder ───────────────────────────────────────────────────────────

/**
 * Build a category-sensitive judge prompt for a given task and response.
 * For non-coding tasks the quality dimension focuses on clarity and accuracy
 * rather than types and structure.
 */
export function buildJudgePrompt(
  task: TaskDefinition,
  response: string
): string {
  const capabilitiesList = task.expectedCapabilities
    .map((c) => `- ${c}`)
    .join("\n");

  const isNonCoding = task.category === "non-coding";
  const qualityDescription = isNonCoding
    ? "**quality**: Is the response clear, accurate, and well-structured? Does it communicate the answer effectively?"
    : "**quality**: Is it well-structured, properly typed (for code), clear (for explanations)?";

  return `You are evaluating an AI coding assistant's response to a task.

## Task Information
Title: ${task.title}
Category: ${task.category}
Difficulty: ${task.difficulty}/5
Expected Capabilities:
${capabilitiesList}

## Response to Evaluate
<response>
${response}
</response>

## Scoring Instructions
Score each dimension using: "fail", "acceptable", or "good".

- **fail**: Fundamentally incorrect, missing key requirements, or would not work
- **acceptable**: Works but has notable issues (missing edge cases, poor structure, incomplete)
- **good**: Correct, complete, well-structured, handles edge cases

### Dimensions

**correctness**: Does the code/answer actually solve the problem? Are edge cases handled?
**completeness**: Are all expected capabilities addressed? Nothing important omitted?
${qualityDescription}

## Output Format
Return ONLY valid JSON matching this exact schema:
{"correctness":"fail"|"acceptable"|"good","completeness":"fail"|"acceptable"|"good","quality":"fail"|"acceptable"|"good","rationale":"Brief explanation of scores (2-3 sentences)"}`;
}
