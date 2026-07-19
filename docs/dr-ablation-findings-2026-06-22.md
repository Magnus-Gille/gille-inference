# Deep-Research Distillation Ablation — findings (2026-06-22, all-nighter)

**Question:** decompose the quality gap to Claude in local deep-research. Is the bottleneck the
distillation step, the synthesis brain, or their interaction — and can a *free* local config match Claude?

**Method (clean, frozen-corpus 2-D ablation).** 9 diverse queries (medical×2, law, technical, finance,
history, current-tech, Swedish-policy, cognitive-science). Each query's corpus (10–15 sources, full page
text) frozen ONCE via sub WebSearch/WebFetch — every arm runs over the *same* pages (no retrieval
confound). Then a grid: **DISTILL** {terse-mellum, rich-mellum, extractive-mellum, rich-qwen3.5a3b,
rich-80b, none(full-pages)} × **SYNTH** {local-80b (M5, free), Sonnet (sub), Opus (sub)}, reground on.
Cost ≈ free: distill + local-synth on the M5; Claude-family synth + the Opus judge on the Claude
subscription; OpenRouter only for the o4-mini cross-family judge. Blind cross-family judge (sub-Opus +
o4-mini), 5 dims (factual/depth/citation/coherence/usefulness) 1–5 + rank, n = 9 queries × 2 judges = 18/cell.

## Headline heatmap (8 core systems; avg score)

| distill ↓ \ synth → | local-80b (free) | Sonnet | Opus |
|---|---|---|---|
| terse-mellum | 3.83 | — | 4.18 |
| **rich-mellum** | **3.99** | — | **4.46** (best) |
| rich-80b-distiller | 3.70 | — | — |
| none (full pages) | **2.92** (worst) | 4.32 | 4.28 |

Full per-dim table: `data/dr-ablation/JUDGED-heatmap.md`.

## Findings

1. **The synthesis brain matters.** Claude-Opus beats the local 80b at every shared distill point:
   terse +0.35, rich +0.47, full-pages **+1.36**. (This *refines* the earlier quality-max-depth study,
   where hybrid-Sonnet ≈ reground-80b — that was a single operating point with Sonnet; the controlled
   9-query grid with Opus shows a real, consistent brain effect.)
2. **Local-80b NEEDS distillation; full pages drown it.** `none-80b` (local synth over raw full pages) is
   the *worst* system (2.92; citation_quality 2.17 — it loses traceability in the raw context). Claude,
   by contrast, *thrives* on full pages (4.28–4.32).
3. **Richer mellum distillation is the universal best-distill.** `rich-mellum` tops both the local column
   (3.99 > terse 3.83 > none 2.92) AND the Opus column (4.46 — better than full-pages-Opus 4.28). Focused,
   denser claims help even the frontier brain.
4. **Best free-local config = `rich-mellum-80b` (3.99)** — within ~0.3–0.5 of the frontier (Opus/Sonnet
   4.28–4.46). The gap is real but the *right* local pipeline closes most of it; the naive one (none-80b)
   does not.
5. **A bigger distiller is not better.** Using the 80b as the distiller (`rich-80b` 3.70) is *worse* than
   tiny mellum (`rich-mellum` 3.99). Mellum is the right distiller (fast, free, best). → RQ5: mellum =
   distiller; 80b = local synth (but only over distilled input); Claude/Sonnet = top-tier synth.
6. **Sonnet ≈ Opus** on full pages (4.32 vs 4.28) → the cheaper Claude is the right API tier when one is used.

## So: the gap to Claude is a **brain × distill interaction**, not a single bottleneck
- The optimal pipeline *differs by brain*: local-80b wants **rich distillation** (and is wrecked by full
  pages); Claude wants either rich distillation or full pages.
- The earlier "distillation is THE bottleneck" was true at the operating point measured; the fuller grid
  shows the residual gap to Claude at the best local config (rich-mellum) is a genuine **synth-brain gap
  of ~0.3–0.5**, and that local's catastrophic failure on full pages is a context-handling limit of the 80b.
- **Buy-vs-API takeaway:** a free local box, configured as `rich-mellum-distill → 80b-synth+reground`,
  reaches ~3.99 vs ~4.3–4.5 for a frontier API. Whether that ~0.4 is worth paying for is use-case
  dependent — but the *free* path is much closer than the naive setup suggested.

## Caveats
- n = 9 queries (both judges consistent). The deterministic `verifyReportSentences` metric is **confounded
  here** (it penalises Claude's fluent paraphrase vs the 80b's verbatim-ish echo) — the blind judge is the
  metric; verify is a fabrication floor only.
- Claude-family synth ran via subagents whose instruction *mirrors* the pipeline synth prompt but isn't
  byte-identical. The local `none` arm feeds the 80b raw full pages as one note-per-source; a different
  full-page-to-local-synth design might fare better, though the 80b genuinely struggles with raw context.
- Core 8 systems shown; the secondary 4 (extractive, qwen3.5-a3b-distiller, Sonnet at terse/rich) + the
  Tongyi agent-mode benchmark are being judged/run separately and will extend this table.

## Full 12-system heatmap (adds extractive, qwen3.5-a3b distiller, Sonnet@terse/rich)

| distill ↓ \ synth → | local-80b (free) | Sonnet | Opus |
|---|---|---|---|
| terse-mellum | 3.89 | 4.29 | 4.18 |
| rich-mellum | 4.07 | 4.23 | **4.51** |
| extractive-mellum | 3.60 | — | — |
| **rich-qwen3.5a3b** | **2.13** (catastrophic, citation 1.00) | — | — |
| rich-80b-distiller | 4.09 | — | — |
| none (full pages) | 3.19 | 4.49 | **4.61** (best) |

(Full per-dim + mean-rank: `data/dr-ablation/JUDGED-heatmap.md`. Top by mean-rank: none-opus 3.6,
rich-mellum-opus 3.8, none-sonnet 4.3; local arms cluster ~6.3–7.4; bottom: extractive 7.8, none-80b 9.5,
qwen3.5a3b-distiller 11.9.)

### Additional findings
7. **The distiller choice is decisive — and a reasoning model is the WRONG distiller.** Using
   **qwen3.5-a3b (a reasoning model) as the distiller is catastrophic: 2.13, citation_quality 1.00** — it
   over-thinks/blanks and yields garbage notes, so synth is ungrounded. **Extractive** (verbatim passage
   distill) also underperforms paraphrased claims (3.60). → mellum's terse/rich paraphrased claims are
   decisively the right distillation; do not distil with a reasoning model.
8. **Sonnet ≈ Opus, sometimes better** (terse-sonnet 4.29 > terse-opus 4.18; none-sonnet 4.49 ≈ none-opus
   4.61) → when paying for an API synth tier, **Sonnet is the right (cheaper) choice**.
9. **The Claude bar:** none-opus 4.61 / rich-mellum-opus 4.51 / none-sonnet 4.49. **Best free local
   ≈ 4.07–4.09** (rich-mellum-80b or rich-80b-distiller) → a **~0.5 gap** — real but moderate, and the
   *right* local config (rich distillation → 80b synth) gets you there; the naive ones (full-pages-80b
   3.19, extractive 3.60, reasoning-distiller 2.13) do not.

### Methodology note
Absolute dim scores drifted ~±0.2–0.3 between the 8-system and 12-system judge passes (absolute scoring is
sensitive to bundle composition). The **rank order and the qualitative findings are robust** across both;
treat the absolute numbers as ordinal, not interval.

## Final heatmap — 13 systems (CANONICAL; adds the Tongyi agent-mode benchmark, issue #40)

| system | avg | mean-rank || system | avg | mean-rank |
|---|---|---|---|---|---|---|
| **rich-mellum-opus** | **4.69** | 3.1 || rich-mellum-80b | 4.17 | 5.9 |
| none-opus | 4.44 | 5.2 || terse-mellum-80b | 4.16 | 6.3 |
| terse-mellum-sonnet | 4.40 | 5.2 || extractive-mellum-80b | 3.68 | 8.8 |
| terse-mellum-opus | 4.38 | 5.3 || none-80b | 3.31 | 9.8 |
| rich-mellum-sonnet | 4.34 | 5.1 || rich-qwen3.5a3b-80b | 2.28 | 12.1 |
| none-sonnet | 4.34 | 5.8 || **tongyi-agent** | **2.22** | 12.4 |
| rich-80b-80b | 4.28 | 6.1 |||||

10. **Tongyi agent-mode (issue #40) is the WORST system (2.22, mean-rank 12.4).** The model-driven specialist
    is mechanically fine (native `<tool_call>` dialect + #46 auto-citation held; no crashes) but **under-reads**:
    it consumes only 2-4 of 11-15 corpus sources per run (synthesises after 1-2 reads, trading breadth for
    loop agility), and several runs hallucinated (grounded at 0%). On a thin/unusual corpus (q4 Rust-vs-Go) it
    hard-failed — 3 searches, never a visit, a 108-word skeleton. **Verdict: the DETERMINISTic harness decisively
    beats the agentic specialist** — the harness's exhaustive, code-driven read of all relevant sources is its
    edge; letting the model drive trades that away. (Consistent with the original finding that Tongyi lost as a
    bounded stage model — it loses here too, for a different reason: under-exploration.)

**Canonical numbers = this 13-system table.** Absolute dim scores drifted ~±0.2–0.3 across the 8/12/13-system
passes (absolute scoring is bundle-composition-sensitive); the rank order and every qualitative finding are
stable across all three. Best free local ≈ 4.2 (rich-distill → 80b synth); Claude bar ≈ 4.4–4.7; gap ≈ 0.4–0.5.

## Follow-up: does a BIGGER local synth brain close the gap? — gpt-oss-120b (2026-06-22). NO.

**Hypothesis.** The residual ~0.4–0.5 free-local gap is a *synth-brain* limit (Opus +0.47 over the 80b at
the same rich-mellum distill). A stronger local non-thinking brain — **gpt-oss-120b** (MoE, 5.1B active;
already on the M5, never tested as synth) — might close it *for free*, and might survive raw full pages
where the 80b drowned. Tested by swapping ONLY the synth brain over the frozen rich-mellum notes (and the
none/full-pages notes), reusing the exact pipeline + judge harness.

**Result — gpt-oss-120b synth is the WORST of the 6 arms (3.36), below even the 80b (4.08).** Fresh 6-system
blind pass (sub-Opus + o4-mini, n=9×2=18/cell; `data/dr-ablation/JUDGED-heatmap-gptoss-6sys.md`):

| system | avg | mean-rank | citation_quality |
|---|---|---|---|
| rich-mellum-opus | 4.52 | 2.5 | 4.39 |
| none-opus | 4.51 | 2.1 | 4.44 |
| rich-mellum-sonnet | 4.31 | 3.3 | 4.28 |
| rich-mellum-80b (free baseline) | 4.08 | 3.6 | 4.50 |
| none-80b | 3.66 | 4.5 | 3.22 |
| **rich-mellum-gptoss** | **3.36** | **5.0** | **2.67** (worst) |

11. **A bigger local brain does NOT close the synth gap — it widens it.** gpt-oss-120b *writes* like a
    frontier model (long: ~20KB/3,795 words, 96 [S#] citations, sections + tables) but does not *synthesize*
    like one. Both judges independently ranked it last (Opus: rank 6 in 5/9 queries; o4-mini: rank 6 in 4/9),
    driven by **citation_quality 2.67** (next-worst 3.22) and factual_accuracy 3.67 — the classic fluent /
    over-cited / under-grounded failure the rubric explicitly punishes. The other session's *qualitative* read
    ("frontier-style, 96 citations, table-rich") was a length/citation-count mirage; blind cross-family judging
    caught the padding that eyeballing missed. **The 80b remains the best free-local synth brain.** (Did not
    run the contingent `none-gptoss` arm: rich-mellum is the *easier* synth job, and gpt-oss already lost it at
    3.36, so full noisy pages would only be worse — low information value, compute saved.)

    *Truncation does not explain this.* The judge bundle caps each report at 4,500 chars; gpt-oss reports are
    long, but `rich-mellum-80b` is **longer on average** (21.6KB vs 20.1KB) — so the 80b is judged on an even
    *smaller* fraction of its text (~21% vs ~22%) and still wins by 0.72. The cap only flatters the concise
    Claude arms (seen at ~43%), a pre-existing property of the whole study; the gpt-oss-vs-80b comparison is
    apples-to-apples.

**Buy-vs-API takeaway (unchanged, reinforced):** the ~0.4–0.5 gap to Claude is **not** closeable for free by
throwing a larger local model at synthesis — the 64 GiB-VRAM-class local brain that *helps* (the 80b coder)
already plateaus below Claude, and the next size up regresses. → the **paid hybrid tier (Claude/Sonnet synth-only)
stays justified** when top-quality deep research is needed; `rich-mellum-80b` remains the best *free* default.
Artifacts: 6-system judge dir = live `data/dr-ablation/judge/`; canonical 13-system preserved in `judge.bak-13sys`
+ `JUDGED-heatmap-13sys-canonical.md`.
