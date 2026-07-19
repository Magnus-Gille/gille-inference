import { describe, it, expect } from "vitest";
import { evidencePresent, normalizeForMatch, isNumericReasoning } from "../scripts/frames-evidence.js";

describe("normalizeForMatch", () => {
  it("strips thousands separators and lowercases", () => {
    expect(normalizeForMatch("8,804,190")).toBe("8804190");
    expect(normalizeForMatch("New York City")).toBe("new york city");
  });
});

describe("evidencePresent — the de-confounding preflight", () => {
  it("exact substring match", () => {
    expect(evidencePresent("Paris", "The capital is Paris, France.")).toEqual({
      present: true,
      how: "exact",
    });
  });

  it("a comma-formatted figure that only lives in a table is FOUND (table-stripping bug case)", () => {
    // Exactly the case the table-stripping bug broke: the figure was only in a table, so the
    // plaintext corpus lacked it. With tables preserved, the digits are present — the normalized
    // gold (8804190) is a substring of the normalized table → exact.
    const corpus = "| Year | Population |\n| --- | --- |\n| 2020 | 8804190 |";
    expect(evidencePresent("8,804,190", corpus)).toEqual({ present: true, how: "exact" });
  });

  it("numeric-tokens: a numeric-dominant answer (multiple numbers, no significant words) is found", () => {
    // "to" is a short stop token, so this is numeric-dominant; both numbers present → found.
    const corpus = "values 12 and also 99 appear in the table";
    expect(evidencePresent("12 to 99", corpus)).toEqual({ present: true, how: "numeric-tokens" });
  });

  it("numeric-tokens requires EVERY gold number present", () => {
    expect(evidencePresent("12 and 99", "only 12 here").present).toBe(false);
  });

  it("number+words: a coincidental number whose entity-word is ABSENT is NOT evidence (Codex)", () => {
    expect(evidencePresent("42 elephants", "there were 42 zebras in the field")).toEqual({
      present: false,
      how: "absent",
    });
  });

  it("number+words: present when BOTH appear (non-contiguous → numeric+words, not exact)", () => {
    const r = evidencePresent("42 elephants", "the 42 animals were all elephants");
    expect(r.present).toBe(true);
    expect(r.how).toBe("numeric+words");
  });

  it("all-words: multi-word descriptive answer present out of order", () => {
    const r = evidencePresent("Golden Gate Bridge", "the bridge known as the golden gate spanning the bay");
    expect(r.present).toBe(true);
    expect(r.how).toBe("all-words");
  });

  it("word matching is boundary-anchored (a token inside a larger word is not a match — Codex)", () => {
    expect(evidencePresent("ny", "germany is large").present).toBe(false);
    expect(evidencePresent("yorkk", "the yorkshire dales").present).toBe(false);
  });

  it("absent when neither the string, its numbers, nor its words appear", () => {
    expect(evidencePresent("42 elephants", "the corpus mentions only zebras")).toEqual({
      present: false,
      how: "absent",
    });
  });

  it("empty gold is never 'present'", () => {
    expect(evidencePresent("", "anything").present).toBe(false);
  });
});

describe("isNumericReasoning", () => {
  it("flags numerical / tabular reasoning types", () => {
    expect(isNumericReasoning("Numerical reasoning | Multiple constraints")).toBe(true);
    expect(isNumericReasoning("Tabular reasoning")).toBe(true);
    expect(isNumericReasoning("Post processing")).toBe(false);
  });
});
