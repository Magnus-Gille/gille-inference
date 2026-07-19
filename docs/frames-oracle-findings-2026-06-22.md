# FRAMES oracle diagnostic — where is the local deep-research gap? (2026-06-22)

**Question:** the deep-research pipeline trails Claude by ~0.4–0.5 on our blind judge. Is the
bottleneck **retrieval**, **reading**, **multi-hop reasoning**, or **synthesis**? Prior work tuned
*synthesis* (distill / reground / brain swap) and a bigger local brain (gpt-oss-120b) made it *worse* —
so we stopped guessing and measured it on an external, gold-answer benchmark.

**Why FRAMES.** [google/frames-benchmark](https://huggingface.co/datasets/google/frames-benchmark) —
824 multi-hop questions, Apache-2.0, fully offline, each with a **short gold answer** AND the **gold
Wikipedia source URLs**. That lets us run the pipeline in an **oracle arm**: inject the gold articles as
a frozen corpus (live retrieval bypassed; only the M5 model gateway runs) → this isolates
**reading + multi-hop synthesis** from retrieval. Published frontier reference: oracle **0.73** /
multi-step-retrieval **0.66** / no-retrieval **0.41**. Grading is fully **local** (normalized match →
local-judge fallback on `qwen3-coder-next-80b`) — **zero OpenRouter spend**.

Harness: `scripts/frames-{fetch,grade,eval}.ts` + `tests/frames-grade.test.ts` (grading logic TDD'd,
15 cases). Frozen-corpus injection via `runCli(opts, { deps })`, deterministic pipeline, `brain=local`
(distill=mellum, plan/synth=qwen3-coder-next-80b). Pilot N=25 (10 numerical).

## Result — oracle pilot (N=25): 0.48 overall, but the SPLIT is the finding

| slice | accuracy | vs FRAMES reference |
|---|---|---|
| **overall** | **12/25 = 0.48** | between no-retrieval (0.41) and multi-step (0.66) |
| **non-numerical** multi-hop | **11/15 = 0.73** | **= frontier oracle (0.73)** |
| **numerical reasoning** (any) | **1/10 = 0.10** | catastrophic |

Per reasoning-type (oracle, gold sources in hand): pure *Multiple constraints* 4/5 ✓ · *Tabular +
constraints* 3/3 ✓ · *Multiple constraints + Temporal* 2/2 ✓ — but **every combination containing
*Numerical reasoning* collapsed** (0/3, 0/2, 0/1, 0/1; one lone 1/1).

## Interpretation — the bottleneck is NUMERICAL REASONING, not retrieval or reading

1. **Reading + multi-hop synthesis is already frontier-grade.** Given the right sources, the pipeline
   scores **0.73 on non-numerical questions — exactly the frontier oracle number.** Constraint
   satisfaction, table lookups, and temporal chaining all work. This *vindicates* the synthesis work:
   the reading/synthesis layer is not the deficit.
2. **The entire deficit is numerical reasoning (0.10).** The synth model (`qwen3-coder-next-80b`, a
   *non-thinking coder*) cannot do the arithmetic / counting / summation these questions require.
   Verified genuine, not a grading artifact: gold `506000`→pred `579,000`; gold `950135`→`1,557,702`;
   gold `10 years`→`2 years`; several outright `"Unknown"`/`"No such state exists"`. It produces wrong
   numbers or gives up. (Consistent with the long-standing project evidence: the MoE "numeric
   self-verification spiral" and the SQL/math weakness in the cartography.)
3. **Retrieval is NOT the first lever.** With *perfect* retrieval the pipeline still caps at 0.48, and
   the cap is numerical, not source-coverage. Fixing retrieval cannot lift the 0/10 numerical bucket.
   The live-retrieval arm + retrieval-recall (BRIGHT) is now a **lower-priority, separate** measurement.

**The lever, empirically:** make the pipeline *compute* instead of *guessing numbers*. Candidates:
- a deterministic **compute step** in synthesis (extract the operands → evaluate, don't mental-math), or
- route numeric sub-questions / the final numeric resolution to a **reasoning model**
  (`qwen35-a3b` / `gpt-oss-120b` with thinking budget) rather than the coder, or
- **tool-use** (a calculator) exposed to the synth stage.

If the numerical bucket can be lifted from 0.10 toward the non-numerical 0.73, overall oracle jumps
~0.48 → ~0.70 — most of the gap to frontier, for free, on local models.

## Caveats
- **Pilot scale:** N=25 (numerical n=10). The effect size is large (0.10 vs 0.73) and matches prior
  evidence, but firm it at N≈100+ before over-claiming the exact numbers.
- **Oracle = upper bound.** 0.48 is the *ceiling* for the current pipeline on this sample; live
  retrieval can only lower it. We have NOT yet measured the retrieval layer (deliberately — numerical
  reasoning dominates and is fixable first).
- **Grading is robust:** 11/12 correct via normalized match, only 1 judge-rescued → not judge-inflated.
- `reportSentencePrecision` mean 0.16 is the known paraphrase confound (irrelevant to answer correctness);
  mean sourcesFetched 3.8 (a few questions had fewer gold articles / reader-thin pages).

## Follow-up experiment — can a local model fix the numerical bucket? (same day)

Tested the lever directly: take the 10 numerical questions, give each model the **same gold facts** + an
explicit "reason step-by-step, show every calculation, then output `ANSWER: <x>`" prompt, vary ONLY the
model. All local, free. Tool: `scripts/frames-numeric-rederive.ts`. (Numbers below are **post grader-audit** —
a Codex cross-model review flagged grader edge-cases; they were fixed and the saved outputs re-graded
offline, no model calls. See Caveats.)

| model (direct compute-derivation over gold facts) | numerical acc | note |
|---|---|---|
| gpt-oss-120b (reasoning) | 5/10 = 0.50 | slow (~30 tok/s, GTT spill) |
| qwen3-coder-next-80b (control = the pipeline's own synth model) | 5/10 = 0.50 | **TIES gpt-oss** (after the diacritic fix) |
| qwen35-a3b (reasoning) | 2/10 = 0.20 | **3/10 BLANK** — token-starved even at max_tokens=16000 |
| — full pipeline baseline | 1/10 = 0.10 | (from the oracle pilot above) |

### Findings
12. **The numerical deficit is largely RECOVERABLE WITHOUT A BIGGER MODEL.** The same coder that scores
    **0.10 inside the pipeline** scores **0.50** asked to compute directly over the gold facts — a ~5×
    recovery. So most of the in-pipeline failure is NOT the model's raw arithmetic ceiling; the
    distill→report→extract path (and/or a synth prompt that doesn't elicit step-by-step computation) is
    shedding it. **Caveat (Codex):** *which* structural factor is not yet isolated — the direct-derivation
    arm differs from the pipeline in several ways at once (raw corpus vs distilled notes, explicit compute
    prompt, no separate mellum answer-extractor). The controlled decomposition is the next experiment.
    **Cheap lever regardless: add an explicit reason→compute→answer derivation step for numeric questions.**
13. **A reasoning model gives NO clear edge here — and one is disqualified.** After the grader fix,
    gpt-oss-120b (0.50) and the plain coder (0.50) **TIE** on direct derivation; the earlier apparent
    gpt-oss lead was a diacritic grading artifact. So the lever is the **derivation step (structure/prompt),
    not a fancier model.** qwen35-a3b is WORSE (0.20) and **BLANKS 3/10** even at a 16k budget (the known
    thinking-model starvation) — do NOT use it.
14. **Numerical reasoning stays genuinely hard — structure alone won't fully close it.** Even the best
    local config caps at ~0.50, well under the ~0.67–0.73 non-numerical ceiling. Residual failures are real
    arithmetic/aggregation errors (gold 950135→891,692; 87→97). → **Full closure needs real TOOL-USE
    (a deterministic calculator/compute step)**, not just prompt structure or a bigger model.

### Caveats (incl. a Codex cross-model review of the harness)
- **Corpus fidelity — the key limitation (Codex CRITICAL).** The oracle corpus is built from Wikipedia's
  `explaintext` extract, which **strips tables**, and from *live* (unpinned) articles. FRAMES "Tabular"
  questions may therefore fail for **missing evidence**, not reasoning — so the precise numerical number is
  a confounded lower bound, and "the oracle isolates synthesis from retrieval" holds only *modulo
  source-coverage*. (Counter-signal: direct derivation still reaches 0.50 over the *same* corpus, so the
  evidence is often sufficient — but not always.) **Top fix before trusting precise numbers / scaling:
  rebuild the corpus table-preserving (pinned-revision `action=parse` HTML→markdown) + a per-sample
  preflight that the gold operands are present.**
- **Grader audited + corrected (Codex).** Three grader bugs fixed TDD in `frames-grade.ts` (decimal vs
  thousands conflation `3.14`↔`314`; over-permissive substring incl. negations; ASCII diacritic-stripping),
  and the saved outputs re-graded **offline**. Effect: the oracle set had **no false-positive inflation** —
  a deterministic-only regrade gives **0.44 / 0.67 / 0.10** (overall / non-numerical / numerical) as a
  *lower bound* vs the judge-inclusive **0.48 / 0.73 / 0.10** run; the single delta was a legitimate
  LLM-judge semantic match, not a bug. The numeric-rederive coder rose 0.40→0.50 (diacritic fix) to tie
  gpt-oss.
- **Control not yet apples-to-apples (Codex).** See #12 — the direct-derivation arm isn't matched to the
  pipeline's intermediate representation; the controlled arms (direct-compute over distilled notes vs over
  the report vs raw corpus, one grader) are the clean follow-up.
- n=25 pilot (numerical n=10); oracle is an upper bound (live retrieval can only lower end-to-end).
  `reportSentencePrecision` is the paraphrase confound (irrelevant to answer correctness).

## Next steps (re-prioritized by BOTH experiments + the review)
1. **Rebuild the oracle corpus table-preserving** (pinned-revision HTML→markdown + per-sample evidence
   preflight) and re-run the numerical subset — de-confound the table-stripping limitation before trusting
   the precise numerical number.
2. **Cheap structural win (model-agnostic):** add an explicit numeric **reason→compute→answer** derivation
   step over the distilled facts (the plain coder already reaches 0.50 this way — no model swap, and NOT
   qwen35-a3b). Re-run the full oracle arm → expect overall ~0.48 → ~0.6.
3. **Then tool-use:** a deterministic calculator/compute tool in the numeric path — the lever to close the
   last gap to the ~0.73 ceiling (prompt structure alone caps ~0.50).
4. **Controlled decomposition** of the 0.10→0.50 lift (distilled-notes vs report vs raw-corpus arms, one
   grader) to pinpoint which pipeline stage sheds the reasoning.
5. **Scale the oracle arm to N≈100**; then the live-retrieval arm + retrieval-recall (BRIGHT); later the
   agentic-vs-deterministic (Tongyi) showdown on the FRAMES scoreboard.

## Update — lever #1 (`numeric-derive-synth`) TESTED → NEGATIVE, not merged

Built the first lever on branch `m5/numeric-derive-synth`: a flag-gated pre-synth pass
(`RESEARCH_SYNTH_NUMERIC_DERIVE`, default off) that computes figures step-by-step and prepends them as
grounded "COMPUTED FIGURES" the report writes from. Validated on the full FRAMES oracle arm (N=25, flag ON):

| slice | flag ON | baseline |
|---|---|---|
| overall | **0.40** | 0.48 |
| numerical | **0.10** | 0.10 |
| non-numerical | **0.60** | 0.73 |

**Net negative — NOT merged.** Zero numerical lift, and a non-numerical regression (2 reports flipped
correct→wrong: idx4, idx15). Root cause from the run logs: the pass is **non-selective** — it emitted up to
**216 "computed figures" for a single question**, flooding the synthesis context with noise that buries the
needed value and degrades otherwise-fine reports.

**Lesson:** the eval win — a *dedicated* reason→compute call returning the *short answer* (0.50) — does NOT
transfer to *injecting figures into report-synthesis context*. Synthesis is the wrong stage; padding it hurts.

**Corrected next lever (supersedes #2/#3 above):** a **selective, tool-backed numeric step** — identify only
the specific quantity the answer needs, compute it **deterministically with a calculator tool** (extract
operands → evaluate → correct by construction), and answer/verify from that, rather than free-form
"compute everything" injected into prose. This is finding #14's "real tool-use," now empirically motivated.
Branch `m5/numeric-derive-synth` is kept as a documented dead-end (not merged; deletable).

## Update — Next-step #1 DONE: oracle corpus rebuilt TABLE-PRESERVING + evidence preflight

Addressed the Codex CRITICAL (corpus fidelity) before trusting the precise numerical number. Replaced the
table-stripping Extracts API with a **pinned-revision `action=parse` HTML→Markdown** fetcher that keeps
`<table>`/infobox data, and added a **per-sample evidence preflight** that checks whether the gold answer is
actually present in the rebuilt corpus — the de-confounder for the numeric split.

New, dependency-free + TDD'd: `scripts/frames-html-md.ts` (Wikipedia-HTML→Markdown, tables→GFM, **depth-aware**
row/cell extraction so nested infobox tables don't drop cell data, navbox/ref chrome dropped), `scripts/
frames-evidence.ts` (`evidencePresent` — exact / numeric-tokens / **numeric+words** / all-words, word-boundary
anchored, comma-insensitive). `frames-fetch.ts` records the pinned `revid` per source and writes
`data/frames/preflight.json` with a **full-vs-truncated** evidence flag.

**Numbers refined by a Codex cross-model review** of the harness (1 critical + 5 medium, all fixed TDD): the
first-pass evidence matcher was too loose — its `numeric-tokens` path marked a sample "present" whenever the
gold's *number* appeared **anywhere**, so a coincidental number elsewhere in the corpus produced a false
positive (and the converter's non-depth-aware regex silently dropped cell content after nested tables). The
matcher now requires a gold number+word answer to have **both** present (word-boundary anchored), and the
converter is depth-aware. These corrected the inflated first-pass numbers (13/17) downward.

**Evidence-present rate (gold answer findable in the table-preserving corpus, RIGOROUS matcher):**

| slice | present | of which truncation-recoverable | genuinely absent |
|---|---|---|---|
| overall | 17/25 | 3 (`#1 #6 #18`) | 5 |
| **numerical** | **9/17** | 3 → **~12/17 with a higher cap** | 5 (`#2 #5 #14 #21 #22`) |
| non-numerical | 8/8 | 0 | 0 |

→ Non-numerical evidence is always complete (8/8). For the numerical bucket, **3 missing samples are
TRUNCATION losses** — the gold figure IS in the full article but past the `MAX_ARTICLE_CHARS=24000` cut (the
preflight now flags these distinctly; raising the cap recovers them). **5 are genuinely absent** even against
the **full untruncated** articles (verified: #5 gold `506000` absent in 149k chars; #22 gold `950135` absent
in 403k chars) — derived/rounded gold or Wikipedia drift since FRAMES was authored.

**Net:** the honest numerical-reasoning denominator is the **evidence-present** subset (9/17 now, ~12/17 after
a cap bump), NOT the confounded 17 or the loose-matcher 13. The original "0.10 catastrophic" was computed over
a set ~half of which lacked recoverable evidence. **Next:** (a) raise `MAX_ARTICLE_CHARS` to recover the 3
flagged truncation losses; (b) re-run the oracle arm over the rebuilt corpus on the live M5 (free) and grade
the numeric split **only over evidence-present samples** → the first trustworthy numerical number. (The corpus
+ `preflight.json` live under the gitignored `data/frames/`; regenerate with `tsx scripts/frames-fetch.ts
--corpus --force`.)
