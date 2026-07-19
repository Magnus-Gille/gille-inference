import OpenAI from "openai";
import type { TaskDefinition, JudgeScores, ScoreLevel } from "../types.js";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "./rubric.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type JudgeResult =
  | { ok: true; scores: JudgeScores; rationale: string }
  | { ok: false; error: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SCORE_LEVELS: ReadonlySet<string> = new Set(["fail", "acceptable", "good"]);

function isScoreLevel(v: unknown): v is ScoreLevel {
  return typeof v === "string" && SCORE_LEVELS.has(v);
}

function parseScores(raw: string): JudgeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `JSON parse failed: ${raw.slice(0, 200)}` };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, error: "Response is not a JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  if (
    !isScoreLevel(obj["correctness"]) ||
    !isScoreLevel(obj["completeness"]) ||
    !isScoreLevel(obj["quality"]) ||
    typeof obj["rationale"] !== "string"
  ) {
    return {
      ok: false,
      error: `Invalid score shape: ${JSON.stringify(obj).slice(0, 300)}`,
    };
  }

  return {
    ok: true,
    scores: {
      correctness: obj["correctness"],
      completeness: obj["completeness"],
      quality: obj["quality"],
    },
    rationale: obj["rationale"],
  };
}

// ─── Judge function ───────────────────────────────────────────────────────────

export async function judgeWithOpus(
  task: TaskDefinition,
  response: string
): Promise<JudgeResult> {
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env["OPENROUTER_API_KEY"] ?? "",
  });

  const userPrompt = buildJudgePrompt(task, response);

  async function callModel(extraInstruction?: string): Promise<string> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      {
        role: "user",
        content: extraInstruction
          ? `${userPrompt}\n\nIMPORTANT: ${extraInstruction}`
          : userPrompt,
      },
    ];

    const completion = await client.chat.completions.create({
      model: "anthropic/claude-opus-4-5",
      messages,
      system: JUDGE_SYSTEM_PROMPT,
      temperature: 0.0,
      max_tokens: 512,
      stream: false,
    } as Parameters<typeof client.chat.completions.create>[0] & { stream: false });

    const nonStreamCompletion = completion as OpenAI.ChatCompletion;
    return nonStreamCompletion.choices[0]?.message?.content ?? "";
  }

  // First attempt
  const firstRaw = await callModel();
  const firstResult = parseScores(firstRaw);
  if (firstResult.ok) return firstResult;

  // Retry once with explicit JSON instruction
  try {
    const retryRaw = await callModel(
      "You MUST respond with ONLY valid JSON. No markdown, no code fences, no explanation. Just the raw JSON object."
    );
    return parseScores(retryRaw);
  } catch (err) {
    return {
      ok: false,
      error: `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
