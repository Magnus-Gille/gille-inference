import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "../src/judge/rubric.js";
import {
  scoreToNumber,
  compareJudges,
  shouldFlagForReview,
} from "../src/judge/aggregate.js";
import type { TaskDefinition, JudgeScores } from "../src/types.js";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const codingTask: TaskDefinition = {
  id: "test-coding-task",
  category: "simple-coding",
  title: "Implement a personnummer validator",
  prompt: "Write a TypeScript function that validates a Swedish personnummer.",
  expectedCapabilities: [
    "Parse personnummer format",
    "Validate Luhn checksum",
    "Handle both 10 and 12 digit formats",
  ],
  difficulty: 2,
  tags: ["typescript", "validation"],
  maxTokens: 1000,
};

const nonCodingTask: TaskDefinition = {
  id: "test-non-coding-task",
  category: "non-coding",
  title: "Summarise a technical document",
  prompt: "Summarise the following document in 3 bullet points.",
  expectedCapabilities: [
    "Extract key points",
    "Maintain technical accuracy",
    "Keep concise",
  ],
  difficulty: 2,
  tags: ["summarization"],
  maxTokens: 500,
};

// ─── rubric.ts ────────────────────────────────────────────────────────────────

describe("buildJudgePrompt", () => {
  it("includes the task title", () => {
    const prompt = buildJudgePrompt(codingTask, "some response");
    expect(prompt).toContain("Implement a personnummer validator");
  });

  it("includes the task category", () => {
    const prompt = buildJudgePrompt(codingTask, "some response");
    expect(prompt).toContain("simple-coding");
  });

  it("includes all expected capabilities as bullet points", () => {
    const prompt = buildJudgePrompt(codingTask, "some response");
    expect(prompt).toContain("- Parse personnummer format");
    expect(prompt).toContain("- Validate Luhn checksum");
    expect(prompt).toContain("- Handle both 10 and 12 digit formats");
  });

  it("includes the response text", () => {
    const response = "function validatePersonnummer(pnr: string): boolean {}";
    const prompt = buildJudgePrompt(codingTask, response);
    expect(prompt).toContain(response);
  });

  it("includes difficulty level", () => {
    const prompt = buildJudgePrompt(codingTask, "response");
    expect(prompt).toContain("2/5");
  });

  it("for coding tasks uses type-focused quality description", () => {
    const prompt = buildJudgePrompt(codingTask, "response");
    expect(prompt).toContain("properly typed");
  });

  it("for non-coding tasks uses clarity/accuracy quality description", () => {
    const prompt = buildJudgePrompt(nonCodingTask, "response");
    expect(prompt).toContain("clear");
    expect(prompt).toContain("accurate");
    // Should NOT mention types for non-coding
    expect(prompt).not.toContain("properly typed");
  });

  it("outputs JSON schema in instructions", () => {
    const prompt = buildJudgePrompt(codingTask, "response");
    expect(prompt).toContain('"correctness"');
    expect(prompt).toContain('"completeness"');
    expect(prompt).toContain('"quality"');
    expect(prompt).toContain('"rationale"');
  });
});

describe("JUDGE_SYSTEM_PROMPT", () => {
  it("is a non-empty string", () => {
    expect(typeof JUDGE_SYSTEM_PROMPT).toBe("string");
    expect(JUDGE_SYSTEM_PROMPT.length).toBeGreaterThan(20);
  });

  it("mentions JSON", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("JSON");
  });
});

// ─── aggregate.ts ─────────────────────────────────────────────────────────────

describe("scoreToNumber", () => {
  it("maps fail to 0", () => {
    expect(scoreToNumber("fail")).toBe(0);
  });

  it("maps acceptable to 1", () => {
    expect(scoreToNumber("acceptable")).toBe(1);
  });

  it("maps good to 2", () => {
    expect(scoreToNumber("good")).toBe(2);
  });
});

describe("compareJudges", () => {
  it("returns agreement=true when all dimensions match exactly", () => {
    const opus: JudgeScores = {
      correctness: "good",
      completeness: "good",
      quality: "good",
    };
    const o4mini: JudgeScores = {
      correctness: "good",
      completeness: "good",
      quality: "good",
    };
    const result = compareJudges(opus, o4mini);
    expect(result.agreement).toBe(true);
    expect(result.maxDifference).toBe(0);
  });

  it("returns agreement=true when all dimensions differ by at most 1", () => {
    const opus: JudgeScores = {
      correctness: "good",
      completeness: "acceptable",
      quality: "good",
    };
    const o4mini: JudgeScores = {
      correctness: "acceptable",
      completeness: "fail",
      quality: "good",
    };
    const result = compareJudges(opus, o4mini);
    expect(result.agreement).toBe(true);
    expect(result.maxDifference).toBe(1);
  });

  it("returns agreement=false when any dimension differs by 2", () => {
    const opus: JudgeScores = {
      correctness: "fail",
      completeness: "good",
      quality: "good",
    };
    const o4mini: JudgeScores = {
      correctness: "good",
      completeness: "good",
      quality: "good",
    };
    const result = compareJudges(opus, o4mini);
    expect(result.agreement).toBe(false);
    expect(result.maxDifference).toBe(2);
  });

  it("populates per-dimension details correctly", () => {
    const opus: JudgeScores = {
      correctness: "fail",
      completeness: "acceptable",
      quality: "good",
    };
    const o4mini: JudgeScores = {
      correctness: "good",
      completeness: "acceptable",
      quality: "good",
    };
    const result = compareJudges(opus, o4mini);
    expect(result.dimensions["correctness"]).toEqual({
      opus: "fail",
      o4mini: "good",
      agrees: false,
    });
    expect(result.dimensions["completeness"]).toEqual({
      opus: "acceptable",
      o4mini: "acceptable",
      agrees: true,
    });
    expect(result.dimensions["quality"]).toEqual({
      opus: "good",
      o4mini: "good",
      agrees: true,
    });
  });
});

describe("shouldFlagForReview", () => {
  it("returns true when correctness is fail vs good", () => {
    const opus: JudgeScores = {
      correctness: "fail",
      completeness: "good",
      quality: "good",
    };
    const o4mini: JudgeScores = {
      correctness: "good",
      completeness: "good",
      quality: "good",
    };
    expect(shouldFlagForReview(opus, o4mini)).toBe(true);
  });

  it("returns true when completeness is fail vs good", () => {
    const opus: JudgeScores = {
      correctness: "acceptable",
      completeness: "fail",
      quality: "acceptable",
    };
    const o4mini: JudgeScores = {
      correctness: "acceptable",
      completeness: "good",
      quality: "acceptable",
    };
    expect(shouldFlagForReview(opus, o4mini)).toBe(true);
  });

  it("returns false when all dimensions agree exactly", () => {
    const scores: JudgeScores = {
      correctness: "acceptable",
      completeness: "acceptable",
      quality: "acceptable",
    };
    expect(shouldFlagForReview(scores, scores)).toBe(false);
  });

  it("returns false when dimensions differ by at most 1", () => {
    const opus: JudgeScores = {
      correctness: "fail",
      completeness: "acceptable",
      quality: "good",
    };
    const o4mini: JudgeScores = {
      correctness: "acceptable",
      completeness: "good",
      quality: "acceptable",
    };
    expect(shouldFlagForReview(opus, o4mini)).toBe(false);
  });
});

// ─── opus-judge.ts (mocked) ───────────────────────────────────────────────────

describe("judgeWithOpus (mocked)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ok=true with parsed scores on valid JSON response", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              correctness: "good",
              completeness: "acceptable",
              quality: "good",
              rationale: "The implementation is correct and well-structured.",
            }),
          },
        },
      ],
    });

    vi.doMock("openai", () => {
      return {
        default: vi.fn().mockImplementation(() => ({
          chat: { completions: { create: mockCreate } },
        })),
      };
    });

    const { judgeWithOpus } = await import("../src/judge/opus-judge.js");
    const result = await judgeWithOpus(codingTask, "function foo() {}");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scores.correctness).toBe("good");
      expect(result.scores.completeness).toBe("acceptable");
      expect(result.scores.quality).toBe("good");
      expect(result.rationale).toContain("correct");
    }
  });

  it("retries once on invalid JSON and returns ok=false if retry also fails", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "not valid json" } }],
    });

    vi.doMock("openai", () => {
      return {
        default: vi.fn().mockImplementation(() => ({
          chat: { completions: { create: mockCreate } },
        })),
      };
    });

    const { judgeWithOpus } = await import("../src/judge/opus-judge.js");
    const result = await judgeWithOpus(codingTask, "function foo() {}");

    expect(result.ok).toBe(false);
    // Should have been called twice (first attempt + retry)
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});

// ─── o4mini-judge.ts (mocked) ─────────────────────────────────────────────────

describe("judgeWithO4Mini (mocked)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns ok=true with parsed scores on valid JSON response", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              correctness: "acceptable",
              completeness: "acceptable",
              quality: "fail",
              rationale: "Missing edge cases and type safety.",
            }),
          },
        },
      ],
    });

    vi.doMock("openai", () => {
      return {
        default: vi.fn().mockImplementation(() => ({
          chat: { completions: { create: mockCreate } },
        })),
      };
    });

    const { judgeWithO4Mini } = await import("../src/judge/o4mini-judge.js");
    const result = await judgeWithO4Mini(codingTask, "function foo() {}");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scores.correctness).toBe("acceptable");
      expect(result.scores.quality).toBe("fail");
    }
  });

  it("calls o4-mini model via OpenRouter", async () => {
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              correctness: "good",
              completeness: "good",
              quality: "good",
              rationale: "Excellent response.",
            }),
          },
        },
      ],
    });

    vi.doMock("openai", () => {
      return {
        default: vi.fn().mockImplementation(() => ({
          chat: { completions: { create: mockCreate } },
        })),
      };
    });

    const { judgeWithO4Mini } = await import("../src/judge/o4mini-judge.js");
    await judgeWithO4Mini(codingTask, "response text");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/o4-mini",
      })
    );
  });
});
