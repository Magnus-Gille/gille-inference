import type { JudgeScores, ScoreLevel } from "../types.js";

// ─── Score mapping ────────────────────────────────────────────────────────────

/**
 * Convert a ScoreLevel to a numeric value for comparison.
 * fail=0, acceptable=1, good=2
 */
export function scoreToNumber(score: ScoreLevel): number {
  switch (score) {
    case "fail":
      return 0;
    case "acceptable":
      return 1;
    case "good":
      return 2;
  }
}

// ─── Comparison ───────────────────────────────────────────────────────────────

export interface DimensionComparison {
  opus: ScoreLevel;
  o4mini: ScoreLevel;
  agrees: boolean;
}

export interface JudgeComparison {
  /** true if all dimensions are within 1 step of each other */
  agreement: boolean;
  /** the largest gap between judges on any single dimension (0-2) */
  maxDifference: number;
  dimensions: Record<string, DimensionComparison>;
}

/**
 * Compare scores from two judges across all dimensions.
 * agreement is true if every dimension differs by at most 1 step.
 */
export function compareJudges(
  opus: JudgeScores,
  o4mini: JudgeScores
): JudgeComparison {
  const dimensionKeys = ["correctness", "completeness", "quality"] as const;

  const dimensions: Record<string, DimensionComparison> = {};
  let maxDifference = 0;

  for (const key of dimensionKeys) {
    const opusScore = opus[key];
    const o4miniScore = o4mini[key];
    const diff = Math.abs(scoreToNumber(opusScore) - scoreToNumber(o4miniScore));
    if (diff > maxDifference) {
      maxDifference = diff;
    }
    dimensions[key] = {
      opus: opusScore,
      o4mini: o4miniScore,
      agrees: diff <= 1,
    };
  }

  const agreement = maxDifference <= 1;

  return { agreement, maxDifference, dimensions };
}

// ─── Review flagging ──────────────────────────────────────────────────────────

/**
 * Returns true if any dimension differs by 2 (fail vs good).
 * These cases warrant manual review.
 */
export function shouldFlagForReview(
  opus: JudgeScores,
  o4mini: JudgeScores
): boolean {
  const { maxDifference } = compareJudges(opus, o4mini);
  return maxDifference === 2;
}
