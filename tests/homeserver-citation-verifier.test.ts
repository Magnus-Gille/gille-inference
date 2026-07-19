import { describe, it, expect } from "vitest";
import {
  normalizeForMatch,
  findSpan,
  extractCitedSourceIds,
  checkCitations,
  citationsResolved,
  splitSentences,
  verifyReportSentences,
  type CitationClaim,
} from "../src/homeserver/citation-verifier.js";
import type { Source, DistilledNote } from "../src/homeserver/deep-research-types.js";

function src(id: string, markdown: string): Source {
  return { id, url: `https://ex/${id}`, title: id, tier: "secondary", markdown, contentHash: id };
}

function note(sourceId: string, claims: { text: string; quote: string }[]): DistilledNote {
  return { sourceId, tier: "secondary", claims };
}

describe("normalizeForMatch", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeForMatch("  Hello\t  WORLD\n ")).toBe("hello world");
  });

  it("strips markdown emphasis and backticks", () => {
    expect(normalizeForMatch("**bold** and `code` and _em_ and #head")).toBe(
      "bold and code and em and head"
    );
  });

  it("converts smart quotes to plain", () => {
    expect(normalizeForMatch("the “quote” it’s")).toBe("the quote it s");
  });

  it("treats any non-alphanumeric run as a single space", () => {
    expect(normalizeForMatch("a---b...c")).toBe("a b c");
  });

  it("returns empty for empty / punctuation-only input", () => {
    expect(normalizeForMatch("")).toBe("");
    expect(normalizeForMatch("***")).toBe("");
  });
});

describe("findSpan", () => {
  const hay = "The GDP grew by 3.2 percent in 2023 according to the report.";

  it("returns ratio 1 for an exact (normalized) substring and yields the original slice", () => {
    const r = findSpan("GDP grew by 3.2 percent", hay, 0.8);
    expect(r.matched).toBe(true);
    expect(r.ratio).toBe(1);
    expect(r.span).toContain("GDP grew by 3.2 percent");
  });

  it("matches a quote differing only in case", () => {
    const r = findSpan("gdp grew by 3.2 percent", hay, 0.8);
    expect(r.matched).toBe(true);
    expect(r.ratio).toBe(1);
  });

  it("matches a quote differing only in whitespace", () => {
    const r = findSpan("GDP   grew\n  by 3.2  percent", hay, 0.8);
    expect(r.matched).toBe(true);
    expect(r.ratio).toBe(1);
  });

  it("matches a quote differing only in markdown bold", () => {
    const r = findSpan("**GDP grew by 3.2 percent**", hay, 0.8);
    expect(r.matched).toBe(true);
    expect(r.ratio).toBe(1);
  });

  it("does not match fabricated text absent from the haystack", () => {
    const r = findSpan("unemployment fell to zero immediately overnight forever", hay, 0.8);
    expect(r.matched).toBe(false);
    expect(r.ratio).toBeLessThan(0.8);
  });

  it("does not match an empty needle", () => {
    const r = findSpan("", hay, 0.8);
    expect(r.matched).toBe(false);
    expect(r.ratio).toBe(0);
  });

  it("fuzzy-matches a faithful paraphrase with minor drift (above threshold)", () => {
    // Adjacency-preserving drift: a benign extra filler word, but every real bigram of the
    // quote survives and the number / polarity are intact → bigram ratio ≥ threshold.
    // (NOTE: the pre-hardening version of this test swapped the CONTENT word "percent"→"quarterly"
    //  and still expected a match — exactly the fabrication that finding #3 now correctly rejects;
    //  see the "[#3] single swapped content word" suite. Here we assert the legitimate case.)
    const r = findSpan("the GDP grew by 3.2 percent indeed", hay, 0.8);
    expect(r.matched).toBe(true);
    expect(r.ratio).toBeGreaterThanOrEqual(0.8);
  });
});

describe("extractCitedSourceIds", () => {
  it("parses [S1], [S2, S3], (S4) and preserves first-seen order, deduped", () => {
    const md = "First [S1]. Second [S2, S3]. Third (S4). Again [S2].";
    expect(extractCitedSourceIds(md)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("parses adjacent markers like [S4][S5]", () => {
    expect(extractCitedSourceIds("foo [S4][S5] bar")).toEqual(["S4", "S5"]);
  });

  it("is case-insensitive on the S but normalizes the id", () => {
    expect(extractCitedSourceIds("lower [s7] case")).toEqual(["S7"]);
  });

  it("returns [] when there are no markers", () => {
    expect(extractCitedSourceIds("no citations here at all")).toEqual([]);
  });
});

describe("checkCitations", () => {
  const sources = [
    src("S1", "The capital of France is Paris, a major city."),
    src("S2", "Water boils at 100 degrees Celsius at sea level."),
  ];

  it("resolves a claim whose quote appears in the source", () => {
    const claims: CitationClaim[] = [
      { claimText: "France's capital is Paris", sourceId: "S1", quote: "capital of France is Paris" },
    ];
    const c = checkCitations(claims, sources, 0.8);
    expect(c.resolved).toHaveLength(1);
    expect(c.unresolved).toHaveLength(0);
    expect(c.precision).toBe(1);
    expect(c.resolved[0]!.matchedSpan).toContain("Paris");
  });

  it("does not resolve a claim whose quote is absent from the source", () => {
    const claims: CitationClaim[] = [
      { claimText: "Paris has 50 million people", sourceId: "S1", quote: "fifty million inhabitants live there" },
    ];
    const c = checkCitations(claims, sources, 0.8);
    expect(c.resolved).toHaveLength(0);
    expect(c.unresolved).toHaveLength(1);
    expect(c.precision).toBe(0);
  });

  it("treats a dangling sourceId (not in sources) as unresolved", () => {
    const claims: CitationClaim[] = [
      { claimText: "Mars is red", sourceId: "S9", quote: "Mars is red" },
    ];
    const c = checkCitations(claims, sources, 0.8);
    expect(c.unresolved).toHaveLength(1);
    expect(c.precision).toBe(0);
  });

  it("returns precision 1 for empty claims", () => {
    const c = checkCitations([], sources, 0.8);
    expect(c.precision).toBe(1);
    expect(c.resolved).toHaveLength(0);
    expect(c.unresolved).toHaveLength(0);
  });

  it("computes mixed precision (2 of 3 ≈ 0.667)", () => {
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
      { claimText: "boiling", sourceId: "S2", quote: "Water boils at 100 degrees" },
      { claimText: "fabricated", sourceId: "S2", quote: "water boils at minus ten degrees" },
    ];
    const c = checkCitations(claims, sources, 0.8);
    expect(c.resolved).toHaveLength(2);
    expect(c.unresolved).toHaveLength(1);
    expect(c.precision).toBeCloseTo(2 / 3, 5);
  });

  it("falls back to claimText when no quote is provided", () => {
    const claims: CitationClaim[] = [{ claimText: "capital of France is Paris", sourceId: "S1" }];
    const c = checkCitations(claims, sources, 0.8);
    expect(c.resolved).toHaveLength(1);
    expect(c.precision).toBe(1);
  });
});

describe("citationsResolved verifier", () => {
  const sources = [
    src("S1", "The capital of France is Paris, a major European city."),
    src("S2", "Water boils at 100 degrees Celsius at sea level."),
  ];

  it("passes an all-resolved report with no dangling markers", async () => {
    const report = "France's capital is Paris [S1]. Water boils at 100C [S2].";
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
      { claimText: "boiling", sourceId: "S2", quote: "Water boils at 100 degrees" },
    ];
    const v = citationsResolved({ sources, claims });
    const r = await v(report);
    expect(r.outcome).toBe("pass");
    expect(r.score).toBe(1);
  });

  it("does not pass a report with a dangling [S9] marker even if all claims resolve", async () => {
    const report = "France's capital is Paris [S1]. Mystery fact [S9].";
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
    ];
    const v = citationsResolved({ sources, claims });
    const r = await v(report);
    expect(r.outcome).not.toBe("pass");
    expect(r.notes ?? "").toMatch(/dangling|S9/i);
  });

  it("score equals precision", async () => {
    const report = "Paris [S1]. Fabricated [S2].";
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
      { claimText: "fab", sourceId: "S2", quote: "water freezes at one thousand degrees" },
    ];
    const v = citationsResolved({ sources, claims });
    const r = await v(report);
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  it("is partial when precision is in [0.5, minPrecision)", async () => {
    const report = "Paris [S1]. Fabricated [S2].";
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
      { claimText: "fab", sourceId: "S2", quote: "water freezes at one thousand degrees" },
    ];
    const v = citationsResolved({ sources, claims }); // minPrecision default 0.9
    const r = await v(report);
    expect(r.outcome).toBe("partial");
  });

  it("fails when precision is below 0.5", async () => {
    const report = "a [S2]. b [S2]. c [S1].";
    const claims: CitationClaim[] = [
      { claimText: "a", sourceId: "S2", quote: "totally made up text alpha" },
      { claimText: "b", sourceId: "S2", quote: "totally made up text beta" },
      { claimText: "c", sourceId: "S1", quote: "capital of France is Paris" },
    ];
    const v = citationsResolved({ sources, claims });
    const r = await v(report);
    expect(r.outcome).toBe("fail");
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL HARDENING REGRESSION TESTS
// Each guards against a confirmed defect where the deterministic matcher (the harness's
// TRUST ANCHOR) accepted a fabricated / falsified / vacuous citation.
// ───────────────────────────────────────────────────────────────────────────────────

describe("[#1 CRITICAL] numbers stay atomic + numeric exact-match guard", () => {
  it("normalizes digit-separated numbers as a single atomic token", () => {
    // "$2,500,000" must NOT fragment into "2 500 000" — separators between digits collapse away.
    expect(normalizeForMatch("$2,500,000")).toBe("2500000");
    expect(normalizeForMatch("revenue 7.5 billion")).toBe("revenue 75 billion");
    expect(normalizeForMatch("price 1,234.56 each")).toBe("price 123456 each");
  });

  it("rejects a fabricated dollar quantity even though the prose around it matches", () => {
    const hay = "The company raised 2,500,000 dollars in total funding last year.";
    const r = findSpan("9,500,000 dollars in total funding", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("rejects a fabricated 'billion' figure that differs only in the number", () => {
    const hay = "In 2023 revenue reached 2 billion dollars across all regions.";
    const r = findSpan("revenue reached 7 billion dollars", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("still matches when the numbers are identical", () => {
    const hay = "The company raised 2,500,000 dollars in total funding last year.";
    const r = findSpan("2,500,000 dollars in total funding", hay, 0.8);
    expect(r.matched).toBe(true);
  });

  it("still matches a number with different separator formatting but same value", () => {
    const hay = "The company raised 2,500,000 dollars in total funding last year.";
    // "2500000" normalizes identically to "2,500,000"
    const r = findSpan("2500000 dollars in total funding", hay, 0.8);
    expect(r.matched).toBe(true);
  });
});

describe("[#2 HIGH] bigram adjacency + negation guard", () => {
  it("rejects a fabricated claim that inverts which subject the value belongs to", () => {
    const hay = "Unemployment rose to 5 percent while inflation fell to 2 percent.";
    const r = findSpan("inflation rose to 5 percent", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("rejects a claim that drops a negation present in the source", () => {
    const hay = "The treatment is not effective against the virus.";
    const r = findSpan("treatment is effective against the virus", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("rejects a claim that adds a negation absent from the source", () => {
    const hay = "The treatment is effective against the virus.";
    const r = findSpan("treatment is not effective against the virus", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("still matches a faithful paraphrase that keeps the same polarity and word order", () => {
    const hay = "The new policy will reduce carbon emissions by thirty percent.";
    const r = findSpan("policy will reduce carbon emissions by thirty percent", hay, 0.8);
    expect(r.matched).toBe(true);
  });

  it("still matches when both sides share the same negation", () => {
    const hay = "The drug is not approved for use in children under twelve.";
    const r = findSpan("drug is not approved for use in children", hay, 0.8);
    expect(r.matched).toBe(true);
  });
});

describe("[#3 HIGH] single swapped content word no longer resolves a short quote", () => {
  it("rejects a 5-token quote with one fabricated content word", () => {
    const hay = "The bridge spans four hundred meters across the river.";
    // swap "four" → "nine": one content word changed in a short quote
    const r = findSpan("bridge spans nine hundred meters", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("rejects swapping a non-numeric content word in a short quote", () => {
    const hay = "The vaccine reduces hospitalization in elderly patients.";
    const r = findSpan("vaccine increases hospitalization in elderly", hay, 0.8);
    expect(r.matched).toBe(false);
  });
});

describe("[#4 MEDIUM] stopword-only / trivial quotes do not fuzzy-resolve", () => {
  it("does not fuzzy-resolve a pure-stopword needle against stopword-rich text", () => {
    // The haystack is dense with 'the' (a 5-token window of 'the's existed in the OLD reproduction),
    // so the OLD multiset bag-of-words pass scored this 1.0 and resolved it. The literal run
    // "the the the the the" does NOT appear, so there is no exact substring — it must NOT resolve.
    const hay = "the cat the dog the bird the fish the ant the bee the owl the fox the end";
    const r = findSpan("the the the the the", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("does not fuzzy-resolve a needle with fewer than 2 distinct content words", () => {
    const hay = "and the report or the and so the but the report yet the report end here now";
    // "the report and the and" → only one distinct content token ("report"); no exact substring.
    const r = findSpan("the report and the and", hay, 0.8);
    expect(r.matched).toBe(false);
  });

  it("still resolves a trivial needle when it is an exact substring of the source", () => {
    const hay = "Section heading: the the the the the appears verbatim here.";
    const r = findSpan("the the the the the", hay, 0.8);
    expect(r.matched).toBe(true);
  });
});

describe("[#5 MEDIUM] case-consistent source-id canonicalization", () => {
  it("resolves a claim against a lowercase source id", () => {
    const sources = [src("s1", "The capital of France is Paris, a major city.")];
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
    ];
    const c = checkCitations(claims, sources, 0.8);
    expect(c.resolved).toHaveLength(1);
    expect(c.precision).toBe(1);
  });

  it("does not flag a marker as dangling when source id case differs", async () => {
    const sources = [src("s1", "The capital of France is Paris, a major European city.")];
    const report = "France's capital is Paris [S1].";
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "s1", quote: "capital of France is Paris" },
    ];
    const v = citationsResolved({ sources, claims });
    const r = await v(report);
    expect(r.notes ?? "").not.toMatch(/dangling/i);
    expect(r.outcome).toBe("pass");
  });
});

describe("[#6 MEDIUM] no inline markers → not a clean pass", () => {
  it("does not pass a report that has claims but zero inline [S#] markers", async () => {
    const sources = [src("S1", "The capital of France is Paris, a major European city.")];
    const report = "France's capital is Paris. It is a large city."; // NO [S1]
    const claims: CitationClaim[] = [
      { claimText: "Paris", sourceId: "S1", quote: "capital of France is Paris" },
    ];
    const v = citationsResolved({ sources, claims });
    const r = await v(report);
    expect(r.outcome).not.toBe("pass");
  });

  it("still passes vacuously when there are no claims at all (nothing to cite)", async () => {
    const sources = [src("S1", "irrelevant.")];
    const v = citationsResolved({ sources, claims: [] });
    const r = await v("A report with no claims and no markers.");
    expect(r.outcome).toBe("pass");
  });
});

describe("[#8 HIGH] directional-antonym guard — an inverted-direction claim does not resolve", () => {
  it("rejects an UP claim against a DOWN source span", () => {
    const hay = "The new policy will sharply reduce carbon emissions worldwide next year.";
    const r = findSpan("policy will sharply increase carbon emissions worldwide", hay, 0.5);
    expect(r.matched).toBe(false);
  });

  it("rejects a DOWN claim against an UP source span", () => {
    const hay = "Quarterly revenue rose to a new record across all of the regions.";
    const r = findSpan("quarterly revenue fell to a new record across all", hay, 0.5);
    expect(r.matched).toBe(false);
  });

  it("still matches when both sides share the same direction", () => {
    const hay = "The new policy will reduce carbon emissions by thirty percent overall.";
    const r = findSpan("policy will reduce carbon emissions by thirty percent", hay, 0.8);
    expect(r.matched).toBe(true);
  });
});

describe("[#7 LOW] marker regex requires matched delimiters", () => {
  it("does not extract mismatched-delimiter markers", () => {
    expect(extractCitedSourceIds("foo [S1) bar")).toEqual([]);
    expect(extractCitedSourceIds("foo (S2] bar")).toEqual([]);
  });

  it("still extracts properly matched bracket and paren markers", () => {
    expect(extractCitedSourceIds("a [S1] b (S2) c")).toEqual(["S1", "S2"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────
// PHASE-2 — report-sentence → cited-source verification.
// The MVP citation pass checks DISTILLED-CLAIM → source. It is blind to the synthesizer
// hallucinating a NEW sentence and slapping a valid [S#] marker on it (the dogfood failure:
// "synthesis can hallucinate a sentence + cite a source whose distilled claims don't cover it").
// `verifyReportSentences` closes that gap deterministically: every sentence carrying an [S#]
// marker must have its CONTENT actually found (via the hardened `findSpan`) in the cited
// source's evidence (page markdown + that source's distilled claims). Else it is `unsupported`.
// ───────────────────────────────────────────────────────────────────────────────────

describe("splitSentences", () => {
  it("splits a paragraph on sentence terminators", () => {
    expect(splitSentences("Alpha is one. Beta is two. Gamma is three.")).toEqual([
      "Alpha is one.",
      "Beta is two.",
      "Gamma is three.",
    ]);
  });

  it("does NOT split on a decimal point inside a number", () => {
    expect(splitSentences("Version 3.2 is faster than 2.9 overall.")).toEqual([
      "Version 3.2 is faster than 2.9 overall.",
    ]);
  });

  it("keeps a trailing [S#] marker attached to its sentence", () => {
    expect(splitSentences("The river flows north [S1]. It is cold there [S2].")).toEqual([
      "The river flows north [S1].",
      "It is cold there [S2].",
    ]);
  });

  it("skips markdown heading lines entirely", () => {
    expect(splitSentences("## Overview\nParis is the capital [S1].")).toEqual([
      "Paris is the capital [S1].",
    ]);
  });

  it("strips a leading list marker", () => {
    expect(splitSentences("- The first item is here [S1].")).toEqual(["The first item is here [S1]."]);
    expect(splitSentences("1. The first item is here [S1].")).toEqual(["The first item is here [S1]."]);
  });

  it("does NOT drop a heading line that carries a citation (it is a claim to grade)", () => {
    expect(splitSentences("### Vaccines cause autism according to the data [S1]")).toEqual([
      "Vaccines cause autism according to the data [S1]",
    ]);
  });

  it("does not split at a common abbreviation followed by a capital/digit", () => {
    expect(splitSentences("See Fig. 3 for the full details given here [S1].")).toEqual([
      "See Fig. 3 for the full details given here [S1].",
    ]);
    expect(splitSentences("Compared the drug vs. Placebo over six months [S1].")).toEqual([
      "Compared the drug vs. Placebo over six months [S1].",
    ]);
    expect(splitSentences("Reported by Smith et al. Overall the effect held [S1].")).toEqual([
      "Reported by Smith et al. Overall the effect held [S1].",
    ]);
  });

  it("does not merge two real sentences when the first ends in a bracketed citation", () => {
    // regression guard: "[S1]." must not be mistaken for an abbreviation/initial
    expect(splitSentences("The river flows north [S1]. It is cold there [S2].")).toEqual([
      "The river flows north [S1].",
      "It is cold there [S2].",
    ]);
  });

  it("does not merge across a real one-letter word ending (a single letter is not an initial)", () => {
    // regression guard for the dropped single-letter-initial rule: "grade A." ends a real sentence.
    expect(splitSentences("The sample earned grade A. It exceeded the cited threshold [S1].")).toEqual([
      "The sample earned grade A.",
      "It exceeded the cited threshold [S1].",
    ]);
  });
});

describe("verifyReportSentences", () => {
  const sources = [
    src("S1", "Paris is the capital of France, a major European city on the Seine."),
    src("S2", "The server sustains forty seven tokens per second under sustained load."),
  ];

  it("credits a cited sentence whose content appears in the cited source", () => {
    const r = verifyReportSentences({
      reportBody: "Paris is the capital of France [S1].",
      sources,
    });
    expect(r.supported).toHaveLength(1);
    expect(r.unsupported).toHaveLength(0);
    expect(r.precision).toBe(1);
    expect(r.supported[0]!.supportedBy).toBe("S1");
    expect(r.supported[0]!.matchedSpan).toContain("Paris");
  });

  it("THE GAP: flags a hallucinated sentence that cites a real but uncovering source", () => {
    // distilled-claim precision would be a perfect 1.0 here (S1's real claims resolve), yet the
    // synthesizer invented a throughput figure and cited S1, which says nothing of the sort.
    const r = verifyReportSentences({
      reportBody: "France's economy grew forty seven percent last quarter alone [S1].",
      sources,
    });
    expect(r.supported).toHaveLength(0);
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]!.citedSourceIds).toEqual(["S1"]);
    expect(r.precision).toBe(0);
  });

  it("credits a sentence supported by the cited source's distilled claim (paraphrase the page lacks)", () => {
    // The page text does not contain this wording, but the source's distilled claim does — and the
    // synthesizer writes FROM the notes, so this is legitimately grounded.
    const notes = [note("S1", [{ text: "Paris hosts roughly two million residents", quote: "two million residents" }])];
    const r = verifyReportSentences({
      reportBody: "Paris hosts roughly two million residents [S1].",
      sources,
      notes,
    });
    expect(r.supported).toHaveLength(1);
    expect(r.precision).toBe(1);
  });

  it("rejects a cited sentence with a fabricated digit number (numeric guard carries through)", () => {
    // The hardened `findSpan` keeps digit numbers atomic and requires an exact numeric match, so a
    // fabricated statistic — the common real-world case (models emit "47 tokens/s", not "forty
    // seven") — cannot resolve on prose overlap alone.
    const r = verifyReportSentences({
      reportBody: "The server sustains 95 tokens per second under sustained load [S3].",
      sources: [src("S3", "The server sustains 47 tokens per second under sustained load.")],
      threshold: 0.5,
    });
    expect(r.unsupported).toHaveLength(1);
    expect(r.precision).toBe(0);
  });

  it("rejects a cited sentence whose polarity is flipped vs the source (negation guard)", () => {
    const neg = [src("S1", "The treatment is not effective against the virus in trials.")];
    const r = verifyReportSentences({
      reportBody: "The treatment is effective against the virus in trials [S1].",
      sources: neg,
      threshold: 0.5,
    });
    expect(r.unsupported).toHaveLength(1);
    expect(r.precision).toBe(0);
  });

  it("credits a multi-source sentence when at least one cited source supports it", () => {
    const r = verifyReportSentences({
      reportBody: "The server sustains forty seven tokens per second under sustained load [S1][S2].",
      sources,
      threshold: 0.5,
    });
    expect(r.supported).toHaveLength(1);
    expect(r.supported[0]!.supportedBy).toBe("S2");
    expect(r.precision).toBe(1);
  });

  it("treats a dangling citation (uncollected source) as unsupported", () => {
    const r = verifyReportSentences({
      reportBody: "Quantum entanglement enables instant correlation across vast distance [S9].",
      sources,
    });
    expect(r.unsupported).toHaveLength(1);
    expect(r.unsupported[0]!.matchRatio).toBe(0);
    expect(r.precision).toBe(0);
  });

  it("counts uncited substantive sentences separately and does not grade them", () => {
    const r = verifyReportSentences({
      reportBody:
        "Paris is the capital of France [S1]. This paragraph adds broader European geographic context.",
      sources,
    });
    expect(r.supported).toHaveLength(1);
    expect(r.unsupported).toHaveLength(0);
    expect(r.uncitedSentenceCount).toBe(1);
    expect(r.precision).toBe(1); // only cited sentences count toward precision
  });

  it("is vacuously precise (1) when no sentence carries a citation", () => {
    const r = verifyReportSentences({
      reportBody: "An overview of the topic without any inline source markers anywhere here.",
      sources,
    });
    expect(r.supported).toHaveLength(0);
    expect(r.unsupported).toHaveLength(0);
    expect(r.precision).toBe(1);
    expect(r.uncitedSentenceCount).toBe(1);
  });

  it("computes mixed precision (one supported, one hallucinated → 0.5)", () => {
    const r = verifyReportSentences({
      reportBody:
        "Paris is the capital of France [S1]. France's economy grew forty seven percent last quarter [S1].",
      sources,
    });
    expect(r.supported).toHaveLength(1);
    expect(r.unsupported).toHaveLength(1);
    expect(r.precision).toBeCloseTo(0.5, 5);
  });

  it("grades a hallucinated claim emitted as a markdown heading (cannot hide in a heading)", () => {
    const r = verifyReportSentences({
      reportBody: "### Vaccines cause autism according to the gathered data [S1]",
      sources: [src("S1", "Paris is the capital of France, a major European city.")],
    });
    expect(r.supported).toHaveLength(0);
    expect(r.unsupported).toHaveLength(1);
    expect(r.precision).toBe(0);
  });

  it("flags a cited sentence whose direction is inverted vs the cited source (antonym guard)", () => {
    const r = verifyReportSentences({
      reportBody: "The new policy will sharply increase carbon emissions worldwide next year [S1].",
      sources: [src("S1", "The new policy will sharply reduce carbon emissions worldwide next year.")],
    });
    expect(r.unsupported).toHaveLength(1);
    expect(r.precision).toBe(0);
  });

  it("calibration (default 0.45): credits a faithful ~0.50 paraphrase yet still flags a ~0.33 over-claim", () => {
    // Both inputs are sanitized from the 2026-06-20 M5 dogfood run: the
    // strict 0.6 threshold flagged faithful paraphrases (ratio 0.43–0.59) as unsupported while real
    // over-claims clustered <=0.30. 0.45 separates them.
    const paraSources = [src("S1", "Because the value is now a defined constant, it has no measurement uncertainty.")];
    const paraBody =
      "Because it is now a defined constant rather than a measured quantity, it has no measurement uncertainty [S1].";
    // strict 0.6 → the false-positive the dogfood exposed
    expect(verifyReportSentences({ reportBody: paraBody, sources: paraSources, threshold: 0.6 }).unsupported).toHaveLength(1);
    // calibrated default (0.45) → credited
    expect(verifyReportSentences({ reportBody: paraBody, sources: paraSources }).supported).toHaveLength(1);

    // a genuine over-claim (specifics absent from the cited source, ratio ~0.33) stays flagged at 0.45
    const overSources = [src("S2", "The metre was redefined in terms of the distance light travels in 1/299,792,458 of a second.")];
    const overBody =
      "At the 17th General Conference on Weights and Measures the metre was redefined as the path travelled by light in 1/299,792,458 of a second [S2].";
    expect(verifyReportSentences({ reportBody: overBody, sources: overSources }).unsupported).toHaveLength(1);
  });

  it("does not grade a cited fragment too short to verify deterministically", () => {
    const r = verifyReportSentences({
      reportBody: "Yes [S1]. Paris is the capital of France [S1].",
      sources,
    });
    expect(r.supported).toHaveLength(1); // only the substantive sentence is graded
    expect(r.unsupported).toHaveLength(0);
    expect(r.precision).toBe(1);
  });

  it("grades a terse 2-content-token cited sentence (a brief fabrication cannot skip the gate)", () => {
    const r = verifyReportSentences({
      reportBody: "Cancer cured [S1].",
      sources, // S1 = "Paris is the capital of France …" — says nothing of the sort
    });
    expect(r.unsupported).toHaveLength(1);
    expect(r.precision).toBe(0);
  });
});
