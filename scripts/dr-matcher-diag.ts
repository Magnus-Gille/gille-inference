/**
 * Matcher diagnostic: for a saved experiment report, show WHY each cited sentence is judged
 * supported/unsupported — its best bigram ratio + whether its numbers are in the matched window
 * vs anywhere in the cited source. Tells us the binding constraint (numeric guard vs low overlap)
 * before any matcher change. Offline (no GPU): reads the cached corpus + report.md.
 *
 *   tsx scripts/dr-matcher-diag.ts <qid> <variant>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReportSentences } from "../src/homeserver/citation-verifier.js";
import type { Source, DistilledNote } from "../src/homeserver/deep-research-types.js";

const OUT = "data/dr-exp";
const [qid = "fasting", variant = "baseline-80b-t0"] = process.argv.slice(2);

const corpus = JSON.parse(readFileSync(join(OUT, "corpus", `${qid}.json`), "utf-8")) as {
  sources: Source[];
  notes: DistilledNote[];
};
const md = readFileSync(join(OUT, "reports", `${qid}__${variant}.md`), "utf-8");
// body = between the "> Generated" line and the first appended deterministic section
const afterHeader = md.split(/\n>.*\n/).slice(1).join("\n>");
const body = afterHeader.split(/\n## (?:Disputed \/ Uncertain|Unsupported sentences|Sources)/)[0] ?? afterHeader;

const numsIn = (s: string) => new Set((s.match(/-?\d[\d,]*\.?\d*/g) ?? []).map((n) => n.replace(/,/g, "")));
const srcById = new Map(corpus.sources.map((s) => [s.id, s]));
const notesById = new Map<string, DistilledNote>();
for (const n of corpus.notes) notesById.set(n.sourceId, n);

for (const thr of [0.45, 0.35, 0.3]) {
  const rc = verifyReportSentences({ reportBody: body, sources: corpus.sources, notes: corpus.notes, threshold: thr });
  console.log(`\n=== threshold ${thr}: supported ${rc.supported.length} / unsupported ${rc.unsupported.length} (precision ${(rc.precision * 100).toFixed(0)}%) ===`);
  if (thr === 0.45) {
    for (const u of rc.unsupported.slice(0, 12)) {
      const sentNums = numsIn(u.sentence);
      // whole-source numbers across all cited sources
      const srcNums = new Set<string>();
      for (const sid of u.citedSourceIds) {
        const src = srcById.get(sid);
        if (src) for (const n of numsIn(src.markdown)) srcNums.add(n);
        const note = notesById.get(sid);
        if (note) for (const c of note.claims) for (const n of numsIn(c.text + " " + c.quote)) srcNums.add(n);
      }
      const missingFromSrc = [...sentNums].filter((n) => !srcNums.has(n));
      const allNumsInSrc = sentNums.size > 0 && missingFromSrc.length === 0;
      const verdict = u.matchRatio >= thr ? "RATIO_OK→failed_on_guard" : "LOW_RATIO";
      console.log(
        `  ratio=${u.matchRatio.toFixed(2)} [${verdict}] nums=${sentNums.size} allNumsInSource=${allNumsInSrc} missing=[${missingFromSrc.slice(0, 4).join(",")}] :: ${u.sentence.slice(0, 90)}`
      );
    }
  }
}
