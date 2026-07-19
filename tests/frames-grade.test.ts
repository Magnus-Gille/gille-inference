/**
 * TDD for frames-grade.ts — pure answer-normalization + match logic.
 * Red first: this file is written BEFORE the implementation.
 */

import { describe, it, expect } from "vitest";
import { normalizeAnswer, looseAnswerMatch } from "../scripts/frames-grade.js";

describe("normalizeAnswer", () => {
  it("lowercases", () => {
    expect(normalizeAnswer("Jane Ballou")).toBe("jane ballou");
  });
  it("strips punctuation", () => {
    expect(normalizeAnswer("Hello, World!")).toBe("hello world");
  });
  it("strips leading/trailing articles", () => {
    expect(normalizeAnswer("The Eiffel Tower")).toBe("eiffel tower");
    expect(normalizeAnswer("a quick fox")).toBe("quick fox");
    expect(normalizeAnswer("An apple")).toBe("apple");
  });
  it("collapses extra whitespace", () => {
    expect(normalizeAnswer("  too   many   spaces  ")).toBe("too many spaces");
  });
  it("strips digit-group separators in numbers", () => {
    // "1,234" and "1234" should normalize the same
    expect(normalizeAnswer("1,234")).toBe("1234");
    expect(normalizeAnswer("1234")).toBe("1234");
  });
  // P0.1 — decimal preservation
  it("preserves decimal points in numbers (3.14 stays 3.14)", () => {
    expect(normalizeAnswer("3.14")).toBe("3.14");
  });
  it("does NOT strip the dot from 1.5 (1.5 stays 1.5)", () => {
    expect(normalizeAnswer("1.5")).toBe("1.5");
  });
  it("strips thousands commas but not decimal points: 506,000 → 506000", () => {
    expect(normalizeAnswer("506,000")).toBe("506000");
  });
  // P0.3 — diacritic folding + framing strip
  it("folds diacritics via NFKD: Özil → Ozil", () => {
    expect(normalizeAnswer("Mesut Özil")).toBe("mesut ozil");
  });
  it("strips leading framing phrase 'This was '", () => {
    expect(normalizeAnswer("This was Mesut Ozil.")).toBe("mesut ozil");
  });
  it("strips leading framing phrase 'Her name is '", () => {
    expect(normalizeAnswer("Her name is Jane Ballou.")).toBe("jane ballou");
  });
  it("normalizes curly apostrophes same as straight ones", () => {
    // "Reve d’Or" (curly) and "Reve d'Or" (straight) should normalize identically
    expect(normalizeAnswer("Reve d’Or")).toBe(normalizeAnswer("Reve d'Or"));
  });
});

describe("looseAnswerMatch", () => {
  it("exact match after normalization", () => {
    expect(looseAnswerMatch("France", "France")).toBe(true);
  });
  it("case + punctuation diff", () => {
    expect(looseAnswerMatch("france!", "FRANCE")).toBe(true);
  });
  it("substring: gold inside predicted", () => {
    // predicted = "Her name is Jane Ballou." → framing stripped → "jane ballou" exact match
    expect(looseAnswerMatch("Jane Ballou", "Her name is Jane Ballou.")).toBe(true);
  });
  it("substring: predicted inside gold (short pred in longer gold)", () => {
    expect(looseAnswerMatch("The quick brown fox", "fox")).toBe(true);
  });
  it("numeric equality: comma-formatted vs plain", () => {
    expect(looseAnswerMatch("1,234", "1234")).toBe(true);
  });
  it("numeric equality: floats", () => {
    expect(looseAnswerMatch("3.14", "3.14")).toBe(true);
  });
  it("date format same value", () => {
    // Both normalize to the same string
    expect(looseAnswerMatch("1989", "1989")).toBe(true);
  });
  it("word-spelled number does NOT match (falls to judge)", () => {
    // "42" vs "forty-two": normalized forms are "42" and "fortytwo" → not substring match
    expect(looseAnswerMatch("42", "forty-two")).toBe(false);
  });
  it("unrelated answers do not match", () => {
    expect(looseAnswerMatch("Germany", "France")).toBe(false);
  });
  it("partial overlap not a match: 'cat' in 'concatenate' — substring on WORDS not chars", () => {
    // We want word-level substring, not char-level
    // "cat" should NOT match "concatenate" (it's a char substr but not a word substr)
    expect(looseAnswerMatch("cat", "concatenate")).toBe(false);
  });

  // P0.1 — decimal vs integer: must NOT conflate
  it("3.14 vs 314 → false (decimal ≠ integer)", () => {
    expect(looseAnswerMatch("3.14", "314")).toBe(false);
  });
  it("1.5 vs 15 → false (decimal ≠ integer)", () => {
    expect(looseAnswerMatch("1.5", "15")).toBe(false);
  });
  it("506,000 vs 506000 → true (thousands separator)", () => {
    expect(looseAnswerMatch("506,000", "506000")).toBe(true);
  });

  // P0.2 — over-permissive substring false positives
  it("unit-only single-word predicted inside long gold → false", () => {
    // "Years" is a single token matching inside "98 Years (Arlington, TX & Rubik's Cube)"
    expect(looseAnswerMatch("98 Years (Arlington, TX & Rubik's Cube)", "Years")).toBe(false);
  });
  it("single numeric predicted in non-numeric gold phrase → false", () => {
    // "10" matching inside "10 years" via substring should NOT score
    expect(looseAnswerMatch("10 years", "10")).toBe(false);
  });
  it("negation: predicted appears after 'not' in predicted string → false", () => {
    // "Germany, not France" — gold is "France", predicted says NOT France
    expect(looseAnswerMatch("France", "Germany, not France")).toBe(false);
  });

  // P0.3 — diacritic + framing: SHOULD match
  it("diacritic fold: Mesut Özil matches This was Mesut Ozil.", () => {
    expect(looseAnswerMatch("This was Mesut Ozil.", "Mesut Özil")).toBe(true);
  });
  it("curly apostrophe: Reve d’Or matches Reve d'Or", () => {
    expect(looseAnswerMatch("Reve d’Or", "Reve d'Or")).toBe(true);
  });
});
