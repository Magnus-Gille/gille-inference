/**
 * Tests for the deep-research DISTILLATION-ABLATION runner (scripts/dr-ablation.ts).
 *
 * The runner holds a frozen web corpus fixed and varies (a) the DISTILL step and (b) the SYNTH
 * brain to find what closes the quality gap to Claude. These tests TDD the deterministic pieces
 * with FAKE ChatFns + temp dirs — no network. The real model calls (via --baseurl) are
 * integration-only and never exercised here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDeepResearchConfig } from "../src/homeserver/deep-research-config.js";
import {
  buildRichDistillPrompt,
  buildExtractiveDistillPrompt,
  renderNote,
  distillSource,
  distillCorpus,
  writeNotesFile,
  readNotesFile,
  readCorpus,
  synthLocalFromNotes,
  verifyReportFile,
  type DistillStyle,
  type Corpus,
  type NotesFile,
} from "../scripts/dr-ablation.js";
import { buildDistillPrompt } from "../src/homeserver/deep-research.js";
import type { ChatFn, ChatRequest, ChatResponse, Source } from "../src/homeserver/deep-research-types.js";

// ─── fixtures ──────────────────────────────────────────────────────────────────

const S1_MD =
  "Paris is the capital of France. The population is 2,100,000 people in the city. " +
  "The Eiffel Tower was completed in 1889 and stands 330 metres tall.";
const S2_MD =
  "France is a country in Western Europe. Its currency is the euro. " +
  "The Louvre in Paris is the most visited museum in the world.";

function makeCorpus(): Corpus {
  return {
    query: "What is the capital of France and key facts about it?",
    sources: [
      { id: "S1", url: "https://a.gov/paris", title: "Paris facts", tier: "primary", markdown: S1_MD },
      { id: "S2", url: "https://b.com/france", title: "France overview", tier: "secondary", markdown: S2_MD },
    ],
  };
}

/** A ChatFn that records every request and returns a canned response per call. */
function recordingChat(model: string, responder: (req: ChatRequest) => string): {
  fn: ChatFn;
  calls: ChatRequest[];
} {
  const calls: ChatRequest[] = [];
  const fn: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
    calls.push(req);
    return { text: responder(req), promptTokens: 10, completionTokens: 20, model };
  };
  return { fn, calls };
}

let tmp: string;
beforeEach(() => {
  resetDeepResearchConfig();
  tmp = mkdtempSync(join(tmpdir(), "dr-ablation-"));
});
afterEach(() => {
  resetDeepResearchConfig();
  rmSync(tmp, { recursive: true, force: true });
});

// ─── distill prompt builders ─────────────────────────────────────────────────────

describe("dr-ablation: distill prompt builders", () => {
  const src: Source = {
    id: "S1",
    url: "https://a.gov/paris",
    title: "Paris facts",
    tier: "primary",
    markdown: S1_MD,
    contentHash: "h",
  };

  it("terse reuses the pipeline's buildDistillPrompt verbatim", () => {
    // The terse style must call into the existing prompt (current mellum atomic-claims style).
    const terse = buildDistillPrompt(src, 6000);
    expect(terse.prompt).toContain("checkable claims");
    expect(terse.prompt).toContain(S1_MD);
  });

  it("rich asks for MORE claims plus a 2-3 sentence summary", () => {
    const p = buildRichDistillPrompt(src, 6000);
    expect(p.prompt).toContain(S1_MD);
    expect(p.prompt).toMatch(/summary/i);
    // denser: asks for more claims than the terse cap of 8
    expect(p.prompt).toMatch(/1[0-9]|20|more/i);
    // structured JSON with a summary field
    expect(p.prompt).toMatch(/"summary"/);
  });

  it("extractive demands VERBATIM copied sentences, no paraphrase, numbers preserved", () => {
    const p = buildExtractiveDistillPrompt(src, 6000);
    expect(p.prompt).toContain(S1_MD);
    expect(p.prompt).toMatch(/verbatim/i);
    expect(p.prompt).toMatch(/do not paraphrase|no paraphrase|copy/i);
    expect(p.prompt).toMatch(/number/i);
    expect(p.prompt).toMatch(/5|10/);
  });

  it("all builders truncate the page to maxChars", () => {
    const long: Source = { ...src, markdown: "x".repeat(10_000) };
    for (const build of [buildDistillPrompt, buildRichDistillPrompt, buildExtractiveDistillPrompt]) {
      const p = build(long, 100);
      // the 10k-char page must NOT appear in full
      expect(p.prompt).not.toContain("x".repeat(10_000));
      expect(p.prompt).toContain("x".repeat(100));
    }
  });
});

// ─── distillSource: per-style behavior (esp. none = no model call) ──────────────────

describe("dr-ablation: distillSource per style", () => {
  const src: Source = {
    id: "S1",
    url: "https://a.gov/paris",
    title: "Paris facts",
    tier: "primary",
    markdown: S1_MD,
    contentHash: "h",
  };

  it("none does NO model call and truncates the markdown to maxChars", async () => {
    let called = false;
    const chat: ChatFn = async () => {
      called = true;
      return { text: "x", promptTokens: 0, completionTokens: 0, model: "m" };
    };
    const note = await distillSource(src, "none", chat, 30);
    expect(called).toBe(false); // KEY: no model call for `none`
    expect(note.id).toBe("S1");
    expect(note.tier).toBe("primary");
    expect(note.distilled).toBe(S1_MD.slice(0, 30));
    expect(note.distilled.length).toBe(30);
  });

  it("terse calls the model and renders parsed atomic claims compactly", async () => {
    const { fn, calls } = recordingChat(
      "mellum",
      () => '{"tier":"primary","claims":[{"text":"Paris is the capital of France","quote":"Paris is the capital of France"}]}'
    );
    const note = await distillSource(src, "terse", fn, 6000);
    expect(calls.length).toBe(1);
    expect(calls[0]!.prompt).toContain("checkable claims"); // reused terse prompt
    expect(note.distilled).toContain("Paris is the capital of France");
  });

  it("extractive preserves the verbatim quoted text returned by the model", async () => {
    const verbatim = "The Eiffel Tower was completed in 1889 and stands 330 metres tall.";
    const { fn } = recordingChat(
      "mellum",
      () => JSON.stringify({ tier: "primary", quotes: [verbatim, "Paris is the capital of France."] })
    );
    const note = await distillSource(src, "extractive", fn, 6000);
    // the verbatim sentence (with its number) survives unmodified into the note
    expect(note.distilled).toContain(verbatim);
    expect(note.distilled).toContain("330");
  });

  it("rich includes the model's summary plus its extra claims in the note", async () => {
    const { fn } = recordingChat(
      "mellum",
      () =>
        JSON.stringify({
          tier: "primary",
          summary: "Paris is the French capital and a major cultural centre.",
          claims: [
            { text: "Paris is the capital of France", quote: "Paris is the capital of France" },
            { text: "The Eiffel Tower stands 330 metres tall", quote: "stands 330 metres tall" },
          ],
        })
    );
    const note = await distillSource(src, "rich", fn, 6000);
    expect(note.distilled).toContain("Paris is the French capital");
    expect(note.distilled).toContain("Eiffel Tower stands 330 metres");
  });

  it("records an EMPTY note (no crash) on a blank/garbage model response", async () => {
    const blank: ChatFn = async () => ({ text: "", promptTokens: 0, completionTokens: 0, model: "m" });
    const note = await distillSource(src, "terse", blank, 6000);
    expect(note.id).toBe("S1");
    expect(note.distilled).toBe(""); // graceful empty note
  });
});

// ─── distillCorpus + notes IO round-trip ────────────────────────────────────────

describe("dr-ablation: corpus + notes IO round-trips", () => {
  it("readCorpus loads the qN.json shape", () => {
    const corpus = makeCorpus();
    const p = join(tmp, "q1.json");
    writeFileSync(p, JSON.stringify(corpus), "utf-8");
    const loaded = readCorpus(p);
    expect(loaded.query).toBe(corpus.query);
    expect(loaded.sources).toHaveLength(2);
    expect(loaded.sources[0]!.id).toBe("S1");
    expect(loaded.sources[1]!.tier).toBe("secondary");
  });

  it("distillCorpus + writeNotesFile + readNotesFile round-trips the notes shape", async () => {
    const corpus = makeCorpus();
    const { fn } = recordingChat(
      "mellum",
      () => '{"tier":"primary","claims":[{"text":"a fact","quote":"a fact"}]}'
    );
    const notes = await distillCorpus(corpus, "terse", "mellum", fn, 6000);
    expect(notes.query).toBe(corpus.query);
    expect(notes.style).toBe("terse");
    expect(notes.model).toBe("mellum");
    expect(notes.notes).toHaveLength(2);
    expect(notes.notes[0]!.id).toBe("S1");

    const p = join(tmp, "notes.json");
    writeNotesFile(p, notes);
    const back = readNotesFile(p);
    expect(back).toEqual(notes);
  });

  it("none-style distillCorpus records the model id as 'none' and makes no calls", async () => {
    const corpus = makeCorpus();
    let called = false;
    const chat: ChatFn = async () => {
      called = true;
      return { text: "x", promptTokens: 0, completionTokens: 0, model: "m" };
    };
    const notes = await distillCorpus(corpus, "none", "none", chat, 6000);
    expect(called).toBe(false);
    expect(notes.style).toBe("none");
    expect(notes.notes[0]!.distilled).toBe(S1_MD.slice(0, 6000));
  });
});

// ─── synthLocalFromNotes: assembles synth prompt + writes report.md ─────────────────

describe("dr-ablation: synthLocalFromNotes", () => {
  function notesFile(style: DistillStyle = "terse"): NotesFile {
    return {
      query: "What is the capital of France and key facts about it?",
      style,
      model: "mellum",
      notes: [
        { id: "S1", tier: "primary", distilled: "Paris is the capital of France. The population is 2,100,000." },
        { id: "S2", tier: "secondary", distilled: "France's currency is the euro. The Louvre is in Paris." },
      ],
    };
  }

  // a synth fake that returns a grounded body when asked to synthesize, and a popular blurb otherwise.
  // Bodies must exceed the 200-char "synthesis failed" floor (real bodies are 1000s of chars).
  function synthFake(model = "synth"): ChatFn {
    return async (req: ChatRequest): Promise<ChatResponse> => {
      if (/1500-2500 words/.test(req.prompt)) {
        return { text: "Paris, briefly\n\nA short accessible summary.", promptTokens: 1, completionTokens: 1, model };
      }
      const body =
        "## Overview\n" +
        "Paris is the capital of France [S1]. The population is 2,100,000 people in the city [S1]. ".repeat(2) +
        "\n\n## Economy\n" +
        "France's currency is the euro [S2]. The Louvre in Paris is the most visited museum in the world [S2]. ".repeat(2);
      return { text: body, promptTokens: 1, completionTokens: 1, model };
    };
  }

  it("assembles the synth prompt from the notes and writes a report.md with body + Sources", async () => {
    const corpus = makeCorpus();
    let synthPrompt = "";
    const synth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      if (!/1500-2500 words/.test(req.prompt) && !synthPrompt) synthPrompt = req.prompt;
      return synthFake()(req);
    };
    const out = join(tmp, "synth-out");
    const res = await synthLocalFromNotes({
      notes: notesFile(),
      corpus,
      model: "synth",
      reground: false,
      chat: synth,
      outDir: out,
    });

    // the synth prompt was assembled from the distilled notes (cite by source id)
    expect(synthPrompt).toContain("[S1]");
    expect(synthPrompt).toContain("Paris is the capital of France");

    const report = readFileSync(res.reportPath, "utf-8");
    expect(report).toContain("Paris is the capital of France [S1]");
    expect(report).toContain("## Sources");
    expect(report).toContain("[S1]");
    expect(report).toContain("[S2]");

    const meta = JSON.parse(readFileSync(res.metaPath, "utf-8")) as Record<string, unknown>;
    expect(meta["query"]).toBe(corpus.query);
    expect(meta["model"]).toBe("synth");
    expect(meta["style"]).toBe("terse");
    expect(meta["reground"]).toBe(false);
  });

  it("reground=on runs a repair pass that improves report-sentence precision", async () => {
    const corpus = makeCorpus();
    let synthCalls = 0;
    const grounded =
      "## Overview\n" + "Paris is the capital of France [S1]. The population is 2,100,000 [S1]. ".repeat(4);
    const ungrounded =
      "## Overview\n" + "Paris will host the 2099 lunar games and a Mars colony by 2100 [S1]. ".repeat(4);
    const synth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      synthCalls++;
      if (/1500-2500 words/.test(req.prompt))
        return { text: "T\n\n" + "summary. ".repeat(30), promptTokens: 1, completionTokens: 1, model: "s" };
      if (/UNSUPPORTED SENTENCES|corrected full Markdown/i.test(req.prompt))
        return { text: grounded, promptTokens: 1, completionTokens: 1, model: "s" };
      return { text: ungrounded, promptTokens: 1, completionTokens: 1, model: "s" };
    };
    const out = join(tmp, "reground-out");
    const res = await synthLocalFromNotes({
      notes: notesFile(),
      corpus,
      model: "s",
      reground: true,
      chat: synth,
      outDir: out,
    });
    expect(synthCalls).toBeGreaterThanOrEqual(2); // initial synth + ≥1 repair
    const report = readFileSync(res.reportPath, "utf-8");
    expect(report).toContain("Paris is the capital of France [S1]"); // the repaired body
    expect(res.stats.reportSentencePrecision).toBeGreaterThan(0);
  });

  it("reground=off does exactly one synth + one popular call (no repair)", async () => {
    const corpus = makeCorpus();
    let synthCalls = 0;
    const synth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      synthCalls++;
      return synthFake()(req);
    };
    const out = join(tmp, "oneshot-out");
    await synthLocalFromNotes({
      notes: notesFile(),
      corpus,
      model: "synth",
      reground: false,
      chat: synth,
      outDir: out,
    });
    expect(synthCalls).toBe(2); // synth + popular, no repair
  });

  it("map-reduces when the assembled prompt would be enormous, flagging it in meta", async () => {
    // a notes file whose distilled bodies vastly exceed the 100k-char single-synth ceiling →
    // forces the map-reduce path (per-chunk synth then combine).
    const big: NotesFile = {
      query: "huge",
      style: "none",
      model: "none",
      notes: Array.from({ length: 6 }, (_, i) => ({
        id: `S${i + 1}`,
        tier: "secondary" as const,
        distilled: `chunk ${i + 1} content. `.repeat(4000), // ~ tens of thousands of chars each
      })),
    };
    const corpus: Corpus = {
      query: "huge",
      sources: big.notes.map((n) => ({
        id: n.id,
        url: `https://x/${n.id}`,
        title: n.id,
        tier: n.tier,
        markdown: n.distilled,
      })),
    };
    const synth: ChatFn = async (req: ChatRequest): Promise<ChatResponse> => {
      if (/1500-2500 words/.test(req.prompt))
        return { text: "T\n\nsummary " + "x ".repeat(50), promptTokens: 1, completionTokens: 1, model: "s" };
      // each chunk/combine synth returns a small grounded body
      return { text: "## Part\nchunk content is present [S1].", promptTokens: 1, completionTokens: 1, model: "s" };
    };
    const out = join(tmp, "mapreduce-out");
    const res = await synthLocalFromNotes({
      notes: big,
      corpus,
      model: "s",
      reground: false,
      chat: synth,
      outDir: out,
    });
    const meta = JSON.parse(readFileSync(res.metaPath, "utf-8")) as Record<string, unknown>;
    expect(meta["mapReduce"]).toBe(true);
  });
});

// ─── verify: the shared scorer over ANY report.md ──────────────────────────────────

describe("dr-ablation: verifyReportFile (shared scorer)", () => {
  it("a sentence citing [S1] whose text is in S1 is supported; a fabricated [S1] sentence is unsupported", () => {
    const corpus = makeCorpus();
    const corpusPath = join(tmp, "q.json");
    writeFileSync(corpusPath, JSON.stringify(corpus), "utf-8");

    const report =
      "# Report\n\n" +
      "## Overview\n" +
      "Paris is the capital of France [S1].\n" +
      "The colony on Mars was founded in 2099 by French settlers [S1].\n";
    const reportPath = join(tmp, "report.md");
    writeFileSync(reportPath, report, "utf-8");

    const outPath = join(tmp, "verify.json");
    const result = verifyReportFile(reportPath, corpusPath, outPath);

    // the grounded sentence is supported, the fabricated one is not
    expect(result.supported).toBe(1);
    expect(result.unsupported).toBe(1);
    expect(result.reportSentencePrecision).toBeCloseTo(0.5, 5);

    // and it was written to disk
    const written = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
    expect(written["supported"]).toBe(1);
    expect(written["unsupported"]).toBe(1);
    expect(written["reportSentencePrecision"]).toBeCloseTo(0.5, 5);
    expect(typeof written["uncitedSentenceCount"]).toBe("number");
  });

  it("works on a report produced by ANY tool (no notes needed)", () => {
    const corpus = makeCorpus();
    const corpusPath = join(tmp, "q.json");
    writeFileSync(corpusPath, JSON.stringify(corpus), "utf-8");
    const reportPath = join(tmp, "external.md");
    writeFileSync(reportPath, "## Facts\nFrance's currency is the euro [S2].\n", "utf-8");
    const result = verifyReportFile(reportPath, corpusPath, join(tmp, "v.json"));
    expect(result.supported).toBe(1);
    expect(result.unsupported).toBe(0);
    expect(result.reportSentencePrecision).toBe(1);
  });
});

// ─── renderNote: compact rendering of parsed claims ────────────────────────────────

describe("dr-ablation: renderNote", () => {
  it("renders claims compactly, one per line", () => {
    const rendered = renderNote(
      { sourceId: "S1", tier: "primary", claims: [{ text: "fact one", quote: "q1" }, { text: "fact two", quote: "q2" }] },
      undefined
    );
    expect(rendered).toContain("fact one");
    expect(rendered).toContain("fact two");
  });

  it("prepends a summary line when present (rich style)", () => {
    const rendered = renderNote(
      { sourceId: "S1", tier: "primary", claims: [{ text: "fact one", quote: "q1" }] },
      "A two sentence summary here."
    );
    expect(rendered).toContain("A two sentence summary here.");
    expect(rendered).toContain("fact one");
  });
});
