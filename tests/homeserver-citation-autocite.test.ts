import { describe, it, expect } from "vitest";
import {
  autoAttributeCitations,
  verifyReportSentences,
  extractCitedSourceIds,
} from "../src/homeserver/citation-verifier.js";
import type { Source } from "../src/homeserver/deep-research-types.js";

// ─── fixtures ─────────────────────────────────────────────────────────────────────

function src(id: string, markdown: string): Source {
  return { id, url: `https://x/${id}`, title: `Title ${id}`, tier: "secondary", markdown, contentHash: id };
}

const S1 = src(
  "S1",
  "Paris is the capital of France. The Eiffel Tower was completed in 1889 and stands 330 metres tall."
);
const S2 = src(
  "S2",
  "France is a country in Western Europe. Its population is about 68 million people as of recent estimates."
);
const SOURCES = [S1, S2];

describe("autoAttributeCitations (deterministic reverse-citation)", () => {
  it("attributes [S#] to grounded-but-uncited sentences; precision rises from ~0 to high", () => {
    const body = [
      "Paris is the capital of France.",
      "France is a country in Western Europe.",
    ].join("\n\n");

    // Before: no markers at all → verifier sees uncited sentences, precision is the vacuous 1
    // but ZERO cited sentences (supported 0 / unsupported 0).
    const before = verifyReportSentences({ reportBody: body, sources: SOURCES });
    expect(before.supported.length).toBe(0);
    expect(before.unsupported.length).toBe(0);
    expect(before.uncitedSentenceCount).toBe(2);

    const out = autoAttributeCitations(body, SOURCES);

    // Each sentence now carries the correct source marker (before the terminal period).
    expect(out).toContain("Paris is the capital of France [S1].");
    expect(out).toContain("France is a country in Western Europe [S2].");

    const after = verifyReportSentences({ reportBody: out, sources: SOURCES });
    expect(after.supported.length).toBe(2);
    expect(after.unsupported.length).toBe(0);
    expect(after.uncitedSentenceCount).toBe(0);
    expect(after.precision).toBeGreaterThan(0.9);
  });

  it("leaves a fabricated/unsupported sentence UNCITED (it stays a flagged miss)", () => {
    const body = "Berlin is the capital of France and home to a billion robot cats.";
    const out = autoAttributeCitations(body, SOURCES);
    // No source contains this — nothing attributed.
    expect(extractCitedSourceIds(out)).toEqual([]);
    expect(out).toBe(body);
  });

  it("preserves a sentence that already carries an [S#] marker (idempotent, no double-cite)", () => {
    const body = "Paris is the capital of France [S2].";
    const out = autoAttributeCitations(body, SOURCES);
    // The pre-existing (even if 'wrong') marker is preserved; no extra marker bolted on.
    expect(out).toBe(body);
    expect(extractCitedSourceIds(out)).toEqual(["S2"]);
  });

  it("running twice is a no-op (idempotent on already-attributed output)", () => {
    const body = "Paris is the capital of France.";
    const once = autoAttributeCitations(body, SOURCES);
    const twice = autoAttributeCitations(once, SOURCES);
    expect(twice).toBe(once);
    expect(extractCitedSourceIds(once)).toEqual(["S1"]);
  });

  it("numeric guard: a sentence with a WRONG number is not attributed to the right-number source", () => {
    // S1 says the tower is 330 metres; this sentence claims 500 metres — the numeric guard in
    // findSpan must block the attribution rather than match on the surrounding prose.
    const body = "The Eiffel Tower was completed in 1889 and stands 500 metres tall.";
    const out = autoAttributeCitations(body, SOURCES);
    expect(extractCitedSourceIds(out)).toEqual([]);
    expect(out).toBe(body);
  });

  it("negation guard: a negated sentence is not attributed to a non-negated source span", () => {
    const negSrc = src("S1", "The drug significantly reduced tumor growth in the trial.");
    const body = "The drug did not reduce tumor growth in the trial.";
    const out = autoAttributeCitations(body, [negSrc]);
    expect(extractCitedSourceIds(out)).toEqual([]);
  });

  it("picks the BEST-matching source across all sources, not merely the first", () => {
    const body = "Its population is about 68 million people as of recent estimates.";
    const out = autoAttributeCitations(body, SOURCES);
    // Content lives in S2, not S1 → S2 attributed.
    expect(extractCitedSourceIds(out)).toEqual(["S2"]);
  });

  it("does not attribute to a too-short / low-content sentence (findSpan trivial-needle guard)", () => {
    const body = "It is.";
    const out = autoAttributeCitations(body, SOURCES);
    expect(out).toBe(body);
    expect(extractCitedSourceIds(out)).toEqual([]);
  });

  it("does NOT corrupt markdown table rows / horizontal rules / fenced code (structural lines skipped)", () => {
    const body = [
      "| City | Fact |",
      "| --- | --- |",
      "| Paris is the capital of France | yes |",
      "---",
      "```",
      "Paris is the capital of France.",
      "```",
    ].join("\n");
    const out = autoAttributeCitations(body, SOURCES);
    // Every structural line is emitted byte-for-byte — no [S#] bolted onto a table cell / fence / rule.
    expect(out).toBe(body);
    expect(extractCitedSourceIds(out)).toEqual([]);
  });

  it("attributes prose but leaves an adjacent table untouched (mixed body)", () => {
    const body = ["Paris is the capital of France.", "", "| col |", "| --- |", "| Paris is the capital of France |"].join(
      "\n"
    );
    const out = autoAttributeCitations(body, SOURCES);
    expect(out).toContain("Paris is the capital of France [S1].");
    // The table row is unchanged (no marker inside the cell).
    expect(out).toContain("| Paris is the capital of France |");
    expect(out).not.toContain("Paris is the capital of France | [S1]");
  });

  it("respects a custom threshold (a very high threshold suppresses paraphrase attribution)", () => {
    const body = "Paris serves as the capital city of the French Republic.";
    const lenient = autoAttributeCitations(body, SOURCES, { threshold: 0.2 });
    const strict = autoAttributeCitations(body, SOURCES, { threshold: 0.99 });
    expect(extractCitedSourceIds(strict)).toEqual([]);
    // (lenient may or may not attribute depending on overlap — assert it does not crash / is a string)
    expect(typeof lenient).toBe("string");
  });
});
