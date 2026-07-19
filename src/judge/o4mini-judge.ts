import OpenAI from "openai";
import type { TaskDefinition, JudgeScores, ScoreLevel } from "../types.js";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "./rubric.js";
import type { JudgeResult } from "./opus-judge.js";

// Re-export so consumers can use either judge's result type
export type { JudgeResult } from "./opus-judge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SCORE_LEVELS: ReadonlySet<string> = new Set(["fail", "acceptable", "good"]);

function isScoreLevel(v: unknown): v is ScoreLevel {
  return typeof v === "string" && SCORE_LEVELS.has(v);
}

function extractJson(raw: string): string {
  // Try raw first
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1]!.trim();

  // Find first { ... } block
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  return trimmed;
}

function parseScores(raw: string): JudgeResult {
  const jsonStr = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
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
      correctness: obj["correctness"] as ScoreLevel,
      completeness: obj["completeness"] as ScoreLevel,
      quality: obj["quality"] as ScoreLevel,
    },
    rationale: obj["rationale"],
  };
}

// ─── Judge function ───────────────────────────────────────────────────────────

export async function judgeWithO4Mini(
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
        role: "system",
        content: JUDGE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: extraInstruction
          ? `${userPrompt}\n\nIMPORTANT: ${extraInstruction}`
          : userPrompt,
      },
    ];

    const completion = await client.chat.completions.create({
      model: "openai/o4-mini",
      messages,
      max_tokens: 16384,
      // Note: temperature and response_format omitted — o4-mini is a reasoning
      // model that doesn't reliably support these via OpenRouter. We extract
      // JSON from the response text instead.
    });

    const msg = completion.choices[0]?.message as unknown as Record<string, unknown> | undefined;
    return (msg?.content as string | null) ?? (msg?.reasoning_content as string | null) ?? "";
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
