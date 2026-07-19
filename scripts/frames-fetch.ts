/**
 * frames-fetch.ts — FRAMES sample fetcher + oracle corpus builder.
 *
 * Step 1: Pull 25 rows from google/frames-benchmark via HF datasets-server REST API
 *         → data/frames/sample.jsonl (one JSON object per line)
 *
 * Step 2: For each sample, fetch each Wikipedia article TABLE-PRESERVING — `action=parse&prop=
 *         text|revid` (the rendered HTML of a PINNED revision) → HTML→markdown that keeps tables /
 *         infoboxes (`frames-html-md.ts`). Replaces the old Extracts API, which stripped tables —
 *         the data FRAMES numerical questions need (Codex CRITICAL on PR #53).
 *         → data/frames/corpus/<idx>.json  (frozen corpus in dr-ablation corpus shape, with revid)
 *
 * Step 3: Per-sample EVIDENCE PREFLIGHT (`frames-evidence.ts`) — is the gold answer actually in the
 *         rebuilt corpus? Distinguishes truncation losses from genuine absences.
 *         → data/frames/preflight.json  (de-confounds the numerical-reasoning split)
 *
 * Usage:
 *   tsx scripts/frames-fetch.ts             # fetch sample + corpus (idempotent)
 *   tsx scripts/frames-fetch.ts --force     # re-fetch even if files exist
 *   tsx scripts/frames-fetch.ts --corpus    # only (re)build corpus from existing sample.jsonl
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wikiHtmlToMarkdown } from "./frames-html-md.js";
import { evidencePresent, isNumericReasoning } from "./frames-evidence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const FRAMES_DIR = join(REPO_ROOT, "data", "frames");
const CORPUS_DIR = join(FRAMES_DIR, "corpus");
const SAMPLE_PATH = join(FRAMES_DIR, "sample.jsonl");

const HF_API =
  "https://datasets-server.huggingface.co/rows?dataset=google%2Fframes-benchmark&config=default&split=test&offset=0&length=25";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const MAX_ARTICLE_CHARS = 24_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FramesSample {
  idx: number;
  question: string;
  gold_answer: string;
  wiki_links: string[];
  reasoning_types: string;
}

interface CorpusSource {
  id: string;
  url: string;
  title: string;
  tier: "primary" | "secondary" | "tertiary";
  markdown: string;
  /** Pinned Wikipedia revision the markdown was rendered from (reproducibility). null if unresolved. */
  revid: number | null;
}

interface Corpus {
  query: string;
  sources: CorpusSource[];
}

/** One row of the evidence preflight: is the gold answer present in the rebuilt corpus? */
interface PreflightRow {
  idx: number;
  question: string;
  gold_answer: string;
  reasoning_types: string;
  numeric: boolean;
  /** present in the (truncated) corpus the pipeline actually sees. */
  present: boolean;
  how: string;
  /**
   * present in the FULL (pre-truncation) article markdown — null when this corpus was loaded from
   * cache (full text unavailable). Lets us tell "evidence past the MAX_ARTICLE_CHARS cut" (a fixable
   * truncation loss) from "genuinely absent / extraction-broken" (Codex review).
   */
  presentFull: boolean | null;
  /** true when evidence is present in the full article but lost after truncation → bump the cap. */
  truncationLoss: boolean;
  sources: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "frames-eval/1.0 (research benchmark; https://github.com/Magnus-Gille)" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} — ${url}`);
  return resp.json();
}

/** Extract article title from a Wikipedia URL path segment. */
function titleFromWikiUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").pop() ?? "";
    return decodeURIComponent(seg.replace(/_/g, " "));
  } catch {
    return url;
  }
}

/**
 * Fetch a Wikipedia article as TABLE-PRESERVING markdown from a PINNED revision.
 *
 * Replaces the old Extracts API (`prop=extracts&explaintext=1`), which silently stripped tables
 * and infoboxes — the data FRAMES numerical questions need (Codex CRITICAL on PR #53). We use
 * `action=parse&prop=text|revid` to get the rendered HTML of a specific revision, then convert it
 * to markdown keeping `<table>` data. Pinning to a revid (the current one on first build, or a
 * supplied one on re-run) makes the corpus reproducible.
 *
 * Returns `{ markdown: "", revid }` on a missing page / fetch error.
 */
async function fetchWikiMarkdown(
  title: string,
  pinnedRevId: number | null
): Promise<{ markdown: string; revid: number | null }> {
  const params = new URLSearchParams({
    action: "parse",
    format: "json",
    formatversion: "2",
    prop: "text|revid",
    redirects: "1",
  });
  // Pin to a specific revision when we have one (reproducible re-run); else resolve the page's
  // current revision (and record it).
  if (pinnedRevId !== null) params.set("oldid", String(pinnedRevId));
  else params.set("page", title);

  const url = `${WIKI_API}?${params}`;
  try {
    const data = (await fetchJson(url)) as {
      parse?: { revid?: number; text?: string };
      error?: { info?: string };
    };
    if (data?.error || !data?.parse?.text) {
      process.stderr.write(`  [wiki] WARN no parse for "${title}": ${data?.error?.info ?? "empty"}\n`);
      return { markdown: "", revid: pinnedRevId };
    }
    const md = wikiHtmlToMarkdown(data.parse.text);
    return { markdown: md, revid: data.parse.revid ?? pinnedRevId };
  } catch (err) {
    process.stderr.write(`  [wiki] WARN fetch failed for "${title}": ${err}\n`);
    return { markdown: "", revid: pinnedRevId };
  }
}

// ─── Step 1: Fetch FRAMES sample ─────────────────────────────────────────────

async function fetchSample(force: boolean): Promise<FramesSample[]> {
  if (!force && existsSync(SAMPLE_PATH)) {
    process.stderr.write(`[fetch] SKIP sample.jsonl already exists (use --force to re-fetch)\n`);
    const lines = readFileSync(SAMPLE_PATH, "utf-8").trim().split("\n").filter(Boolean);
    return lines.map((l) => JSON.parse(l) as FramesSample);
  }

  process.stderr.write(`[fetch] Fetching 25 rows from HF datasets-server...\n`);
  const data = (await fetchJson(HF_API)) as {
    rows?: Array<{ row_idx: number; row: Record<string, unknown> }>;
  };

  const rows = data?.rows ?? [];
  if (rows.length === 0) throw new Error("HF API returned no rows — check dataset/split/config");

  const samples: FramesSample[] = rows.map((r) => {
    const row = r.row;
    // Collect wiki links from individual wikipedia_link_N columns (N=1..10) + "wikipedia_link_11+"
    // The `wiki_links` column is a Python list repr string — less reliable than the individual cols.
    const wikiLinks: string[] = [];
    for (let n = 1; n <= 10; n++) {
      const v = row[`wikipedia_link_${n}`];
      if (typeof v === "string" && v.startsWith("http")) wikiLinks.push(v);
    }
    const v11 = row["wikipedia_link_11+"];
    if (typeof v11 === "string" && v11.startsWith("http")) v11 && wikiLinks.push(v11);
    return {
      idx: r.row_idx,
      question: String(row["Prompt"] ?? row["prompt"] ?? ""),
      gold_answer: String(row["Answer"] ?? row["answer"] ?? ""),
      wiki_links: wikiLinks,
      reasoning_types: String(row["reasoning_types"] ?? row["Reasoning Types"] ?? ""),
    };
  });

  mkdirSync(FRAMES_DIR, { recursive: true });
  writeFileSync(SAMPLE_PATH, samples.map((s) => JSON.stringify(s)).join("\n") + "\n", "utf-8");
  process.stderr.write(`[fetch] Wrote ${samples.length} rows to ${SAMPLE_PATH}\n`);
  return samples;
}

// ─── Step 2: Build oracle corpus ─────────────────────────────────────────────

async function buildCorpus(samples: FramesSample[], force: boolean): Promise<void> {
  mkdirSync(CORPUS_DIR, { recursive: true });
  let skipped = 0;
  let built = 0;
  let totalSources = 0;
  const preflight: PreflightRow[] = [];

  for (const sample of samples) {
    const outPath = join(CORPUS_DIR, `${sample.idx}.json`);
    let corpus: Corpus;
    // FULL (pre-truncation) markdown for this sample — only available on a fresh fetch. null when
    // loaded from cache (then we can't distinguish a truncation loss from genuine absence).
    let fullMarkdown: string | null = null;

    if (!force && existsSync(outPath)) {
      skipped++;
      corpus = JSON.parse(readFileSync(outPath, "utf-8")) as Corpus;
      totalSources += corpus.sources.length;
    } else {
      process.stderr.write(`[corpus] [${sample.idx}] ${sample.question.slice(0, 60)}...\n`);
      // Reuse any pinned revids from a prior build so a rebuild renders the SAME revisions.
      const prior: Corpus | null =
        existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf-8")) as Corpus) : null;
      const priorRevByUrl = new Map<string, number | null>(
        (prior?.sources ?? []).map((s) => [s.url, s.revid ?? null])
      );
      const sources: CorpusSource[] = [];
      const fullParts: string[] = [];
      let sIdx = 1;

      for (const url of sample.wiki_links) {
        const title = titleFromWikiUrl(url);
        process.stderr.write(`  → fetching "${title}"\n`);
        const { markdown, revid } = await fetchWikiMarkdown(title, priorRevByUrl.get(url) ?? null);
        if (!markdown) {
          process.stderr.write(`  → SKIP (empty/404)\n`);
          continue;
        }
        fullParts.push(markdown);
        sources.push({
          id: `S${sIdx}`,
          url,
          title,
          tier: "primary",
          markdown: markdown.slice(0, MAX_ARTICLE_CHARS),
          revid,
        });
        sIdx++;
        // Small delay to avoid rate-limiting the Wiki API.
        await new Promise((r) => setTimeout(r, 150));
      }

      corpus = { query: sample.question, sources };
      fullMarkdown = fullParts.join("\n\n");
      writeFileSync(outPath, JSON.stringify(corpus, null, 2), "utf-8");
      built++;
      totalSources += sources.length;
      process.stderr.write(`  → wrote corpus (${sources.length} sources)\n`);
    }

    // ── Evidence preflight: is the gold answer present in the (rebuilt) corpus? ──
    // Check the TRUNCATED corpus (what the pipeline sees) and, when available, the FULL article —
    // so a "present in full but lost after the 24k cut" truncation loss is flagged distinctly from
    // a genuine absence (Codex review).
    const allMarkdown = corpus.sources.map((s) => s.markdown).join("\n\n");
    const ev = evidencePresent(sample.gold_answer, allMarkdown);
    const evFull = fullMarkdown !== null ? evidencePresent(sample.gold_answer, fullMarkdown) : null;
    const truncationLoss = evFull !== null && evFull.present && !ev.present;
    preflight.push({
      idx: sample.idx,
      question: sample.question,
      gold_answer: sample.gold_answer,
      reasoning_types: sample.reasoning_types,
      numeric: isNumericReasoning(sample.reasoning_types),
      present: ev.present,
      presentFull: evFull !== null ? evFull.present : null,
      truncationLoss,
      how: ev.how,
      sources: corpus.sources.length,
    });
  }

  // Persist + summarize the preflight — this is what de-confounds the numerical-reasoning split.
  const preflightPath = join(FRAMES_DIR, "preflight.json");
  writeFileSync(preflightPath, JSON.stringify(preflight, null, 2), "utf-8");

  const total = preflight.length;
  const present = preflight.filter((p) => p.present).length;
  const numeric = preflight.filter((p) => p.numeric);
  const numericPresent = numeric.filter((p) => p.present).length;
  const nonNumeric = preflight.filter((p) => !p.numeric);
  const nonNumericPresent = nonNumeric.filter((p) => p.present).length;

  process.stderr.write(
    `[corpus] Done: ${built} built, ${skipped} skipped. Total sources: ${totalSources}\n`
  );
  process.stderr.write(
    `[preflight] gold answer present in corpus: ${present}/${total} overall` +
      ` | numeric ${numericPresent}/${numeric.length}` +
      ` | non-numeric ${nonNumericPresent}/${nonNumeric.length}  → ${preflightPath}\n`
  );
  const missing = preflight.filter((p) => !p.present);
  if (missing.length > 0) {
    process.stderr.write(
      `[preflight] ${missing.length} sample(s) WITHOUT in-corpus evidence (exclude from reasoning split): ` +
        missing.map((p) => `#${p.idx}`).join(", ") +
        "\n"
    );
  }
  // Distinguish FIXABLE truncation losses (evidence was in the full article but lost after the
  // MAX_ARTICLE_CHARS cut) from genuine absences — the former say "raise the cap", the latter
  // "exclude the sample" (Codex review).
  const truncated = preflight.filter((p) => p.truncationLoss);
  if (truncated.length > 0) {
    process.stderr.write(
      `[preflight] ${truncated.length} of those are TRUNCATION LOSSES (present in the full article — raise ` +
        `MAX_ARTICLE_CHARS=${MAX_ARTICLE_CHARS} to recover): ` +
        truncated.map((p) => `#${p.idx}`).join(", ") +
        "\n"
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const corpusOnly = argv.includes("--corpus");

  if (!corpusOnly) {
    const samples = await fetchSample(force);
    await buildCorpus(samples, force);
  } else {
    if (!existsSync(SAMPLE_PATH)) {
      throw new Error(`--corpus: sample.jsonl not found at ${SAMPLE_PATH}. Run without --corpus first.`);
    }
    const lines = readFileSync(SAMPLE_PATH, "utf-8").trim().split("\n").filter(Boolean);
    const samples = lines.map((l) => JSON.parse(l) as FramesSample);
    await buildCorpus(samples, force);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
