# Deep-research harness — overnight improvement study (2026-06-21)

_Goal (overnight assignment): improve the local-first deep-research agent using the M5's "free"
compute. First-principles, test new models, validate every experiment. Branch:
`m5/deep-research-improvements`._

Prior state (the 3-way benchmark, `docs/deep-research-benchmark-2026-06-20.md`): **Local 3.00 <
Claude-harness 3.86 < Perplexity DR 4.58** (1–5, blind Opus-4.8 + o4-mini). Local's weakest judged
dimension was **citation_quality 2.2/5** — *below* its own deterministic precision metric. The
"+0.86 brain gap" and that 2.2 are what this study attacks, **without** a frontier brain.

---

## TL;DR (headline)

- **The night's most important lesson: a deterministic grounding metric and the blind judge DIVERGE.**
  Report-sentence support (`verifyReportSentences`) is a useful proxy but it rewards short, traceable
  sentences — and maximizing it (atomic-sentence prompting, ~77% support) made the blind Opus-4.8/o4-mini
  judge rate reports **worse overall** (3.68 → 3.06) because the bodies got choppy and shallow
  (coherence 4.30 → 3.30, depth 3.90 → 3.00) even as citation_quality rose (2.50 → 2.90). **Atomic
  discipline is a citation-vs-readability trade-off, not a free win** — only the judge caught the cost.
- **Validated win: `reground` (grounding-repair, WITHOUT atomic).** synthesize → deterministic
  report-sentence verify → feed the *unsupported* sentences back to re-ground/remove. On the frozen
  corpus, blind judge: citation_quality **1.83 → 3.00**, overall **3.40 → 3.67**, **no coherence
  regression** — it fixes grounding without the length collapse atomic causes. (End-to-end isolation of
  reground-alone: §5 Run 2.)
- **Diagnosis of the 2.2 citation gap:** the production synth (`qwen3-coder-next-80b`, a *coding* model)
  writes long sentences that recombine multiple facts but cite one source → prose doesn't trace.
- **Model swap loses — keep the 80b.** The "general model grounds better" effect was really "the
  *reasoning* model writes shorter": `qwen35-a3b`/`gemma4` ground well but **blank stochastically**
  (a serial-GPU hazard); the non-thinking `Qwen3-30B-Instruct` writes long prose AND **drops [S#]
  citations** under atomic. The coder follows the dual instruction best.
- **Non-levers:** temperature on the coder (3 → 6%), outline-first (3%), self-critique (5%).
- Shipped to core (all TDD, 782 green, **default-off / behavior-preserving**): `RESEARCH_SYNTH_STRATEGY=reground`,
  `RESEARCH_SYNTH_ATOMIC` (off — trade-off), per-role temperature + token-floor, `stripThink()`,
  duplicate-"Disputed"-section fix, + an adversarial-review bug fix. The deterministic harness work
  (citation verifier, dedup, tier-ranking) is sound; the gap to Claude (4.28) remains the brain.

---

## 1. Method (what ran where)

- **Frozen-corpus isolation** (`scripts/dr-experiment.ts`): retrieve once per query (80b plan +
  mellum distill, 8 sources), cache `{plan, sources, notes, disputed}`, then vary **only** the
  synthesizer (model × temperature × strategy). This isolates the synthesis variable cleanly and
  avoids re-running the expensive distill fan-out per variant. Zero core-pipeline changes — the
  runner orchestrates the library's exported primitives.
- **Inner-loop signal**: the harness's own deterministic report-sentence support metric
  (`verifyReportSentences`, threshold 0.45) + distilled-claim precision + body length + tokens + wall
  time. **Outer-loop ground truth**: blind multi-way judge (Opus-4.8 + o4-mini), §5.
- **Inner-loop queries** (a subset of the 5 canonical benchmark queries, so results compare
  directly): intermittent fasting (numeric/clinical), EU AI Act GPAI (regulatory), Fermi paradox
  (conceptual).
- **M5 usage**: the box ran the meta-research dogfood, served every synth-variant model call (via an
  SSH `:18091` forward to llama-swap), and did all GGUF downloads. Search + read ran laptop-side
  (`~/.venvs/research`: ddgs + Trafilatura). The OpenRouter key (judges) never left the laptop.

---

## 2. Baseline, quantified (current production: 80b-coder, temp 0, oneshot)

| query | report-sentence support | distilled-claim cite | body |
|---|---|---|---|
| fasting | **0%** (0/28) | 84% | 7412c |
| aiact | **7%** (2/28) | 81% | 6777c |
| fermi | **3%** (1/33) | 93% | 13348c |

The benchmark's "citation_quality 2.2" is real and large: the synthesized prose barely traces to
sources even though the distilled-claim gate reads 81–93%.

**Validated root cause** (`scripts/dr-matcher-diag.ts` on the fasting baseline): every unsupported
sentence fails on **low bigram overlap** (0.08–0.41, all < 0.45), *not* the numeric guard — even
sentences whose numbers ARE in the source. The coder writes **long sentences that recombine multiple
facts** but cite one source; no single contiguous source span covers the whole sentence → low
overlap → flagged. (The matcher is correctly conservative; the fix is to make the *prose* traceable,
not to loosen the trust anchor — see §7.)

---

## 3. Synthesis-strategy results — DETERMINISTIC metric (mean across 3 queries, 80b synth)

> ⚠ These are report-sentence-support (`rsupport`) numbers — a **proxy**. atomic tops it, but the blind
> judge (§5) **reverses** the atomic ranking (atomic reports read choppy/shallow). Read §5 for the
> ground truth; this table shows what the deterministic harness *can* and *cannot* see.

| variant | strategy | rsupport% | cite% | calls | ~time | completion-tok | verdict |
|---|---|---|---|---|---|---|---|
| baseline-80b-t0 | oneshot, temp 0 | 3 | 86 | 1 | 44s | 1834 | control |
| 80b-t03 | oneshot, temp 0.3 | 6 | 84 | 1 | 42s | 1940 | temp ≈ no-op |
| 80b-t06 | oneshot, temp 0.6 | 3 | 91 | 1 | 47s | 2042 | temp ≈ no-op |
| 80b-outline | outline-first | 3 | 90 | 2 | 69s | 2710 | not worth it |
| 80b-critique | draft→critique→revise | 5 | 90 | 3 | 117s | 4604 | not worth it |
| 80b-reground | reground | 41 | 90 | 2 | 88s | 3576 | good (fails numeric) |
| **80b-atomic** | **atomic** | **58** | 90 | **1** | **36s** | **826** | **best value** |
| **80b-reground-atomic** | **atomic + reground** | **77** | 89 | 2 | 44s | 1642 | **best quality** |

- **Atomic is the breakout**: 80b-atomic per-query fasting **46** / aiact **83** / fermi **45** — it fixes
  the numeric-fasting case where reground alone stayed 0%. And it is **cheaper**: short dense traceable
  sentences mean ~826 completion tokens (vs baseline 1834) and 36s, the lowest of any variant.
- **80b-reground-atomic** (fasting 73 / aiact 78 / fermi 81) is the best **reliable** config — still
  cheap (1642 tok, 44s) because atomic bodies are short. reground compounds atomic without the cost
  blow-up.
- reground per-query: fasting 0 · aiact 80 · fermi 44 (the numeric-fasting failure is what atomic fixes).

---

## 4. Synthesis-MODEL results (DETERMINISTIC report-sentence support; judge verdict in §5)

| synth model | type | strat | fasting | aiact | fermi | reliable? |
|---|---|---|---|---|---|---|
| qwen3-coder-next-80b | coder (non-thinking) | oneshot | 0% | 7% | 3% | yes (but poorly grounded) |
| qwen3-coder-next-80b | coder | reground | 0% | 80% | 44% | **yes** |
| qwen35-a3b | general (reasoning) | oneshot | 73% | **blank** | 98% | NO (stochastic blank) |
| qwen35-a3b | general (reasoning) | reground | 78% | 98% | 91% | NO (stochastic blank) |
| gemma4 | general (thinking) | oneshot | 33% | 46% | 18% | yes-ish |
| gemma4 | general (thinking) | reground | 37% | **blank** | **blank** | NO (blanked 2/3) |
| Qwen3-30B-Instruct-2507 | general instruct (non-thinking) | oneshot | 15% | 7% | 2% | yes (but low — long prose) |
| Qwen3-30B-Instruct-2507 | general instruct (non-thinking) | reground | 47% | 53% | — | yes |
| Qwen3-30B-Instruct-2507 | general instruct (non-thinking) | atomic | **dropped [S#] citations** | | | yes, but broke citing |

**The model-swap question, settled — do NOT swap:**
- The "general model grounds better" effect (qwen35-a3b oneshot 73/98%) was really **"the reasoning
  model writes shorter, more careful sentences"** — and that reasoning is exactly what makes it **blank
  stochastically** (token budget exhausted on chain-of-thought; a serial-GPU hazard). qwen35 blanked on
  aiact; gemma4 blanked 2/3.
- The *non-thinking* general writers don't blank but aren't better: `Qwen3-30B-Instruct` writes long
  flowing prose like the coder (8% oneshot), and under the atomic prompt it **drops the `[S#]`
  citations** (it followed "short sentences" but ignored "cite each") — i.e. it follows the dual
  instruction **worse** than the coder, which kept both atomic *and* the citations.
- ⇒ The **prompt**, not the model, makes prose traceable. Keep the reliable, instruction-following
  `qwen3-coder-next-80b`; turn on atomic (+reground).
- **Metric caveat**: an empty / un-cited body scores a *vacuous* 100% (0/0 cited sentences). Treat
  body < 200c or 0 cited sentences as a FAIL; the blind judge penalizes them correctly.

---

## 5. Blind judge — ground truth

**Frozen-corpus, 3 key variants, blind Opus-4.8 + o4-mini (3 queries × 2 judges):**

| variant | factual | depth | citation_q | coherence | useful | **avg** | #rank-1 |
|---|---|---|---|---|---|---|---|
| baseline-80b (coder, oneshot) | 3.50 | 4.00 | **1.83** | 4.17 | 3.50 | **3.40** | 0 |
| 80b + reground | 3.83 | 3.83 | **3.00** | 3.83 | 3.83 | **3.67** | 3 |
| qwen35-a3b (general) | 3.17 | 3.00 | **3.33** | 3.00 | 3.00 | **3.10** | 3 |

Per-query avg: fasting — baseline 3.60 / reground 3.20 / **qwen35 4.60**; aiact — baseline 3.70 /
**reground 4.50** / qwen35 1.00 (blank); fermi — baseline 2.90 / reground 3.30 / **qwen35 3.70**.

**What the judge confirms:**
1. Baseline **citation_quality 1.83/5** reproduces the 2.2 problem independently.
2. **reground is a real, reliable win**: citation_quality **1.83 → 3.00**, overall **3.40 → 3.67**, with
   **no coherence regression** (4.17 → 3.83) and 3 rank-1 wins (baseline: 0). It never blanks.
3. **A general-model synth gives the best report when it doesn't blank** (qwen35 fasting 4.60, fermi
   3.70) — but the aiact blank (1.00) tanks its mean to 3.10. → capture the ceiling *reliably* with a
   non-thinking general writer (Qwen3-Instruct, §4).

### Final end-to-end benchmark (full pipeline, real ddgs/Trafilatura, 5 canonical queries, blind)

**Run 1 — baseline vs reground+ATOMIC vs Claude:**

| System | factual | depth | citation_q | coherence | useful | **avg** | #rank-1 |
|---|---|---|---|---|---|---|---|
| A · baseline (oneshot) | 3.90 | 3.90 | 2.50 | 4.30 | 3.80 | **3.68** | 2 |
| A · reground + **atomic** | 3.10 | 3.00 | **2.90** | 3.30 | 3.00 | **3.06** | 1 |
| B · Claude Sonnet 4.6 | 4.50 | 4.40 | 3.70 | 4.60 | 4.20 | **4.28** | 6 |

**⚠ The end-to-end judge contradicts the deterministic metric.** atomic+reground had the best
deterministic grounding (rsupport ~77%) and DID raise judged citation_quality (2.50 → 2.90) — but it
**dropped overall (3.68 → 3.06)** because the short atomic bodies (~half the length) read choppier and
shallower (coherence 4.30 → 3.30, depth 3.90 → 3.00, usefulness 3.80 → 3.00). **The rsupport metric
rewards short traceable sentences; readers want depth + flow.** This is the night's most important
lesson: a deterministic grounding metric is a *proxy*, and atomic-sentence discipline is a
**citation-vs-readability trade-off, not a free win** — only the blind judge exposed the cost. (Note
the frozen-corpus judge in §5 above tested reground **without** atomic and found it *helped*
3.40→3.67 — so the regression here is atomic's doing, not reground's.)

**Run 2 — baseline vs reground-ALONE vs Claude** (isolates the frozen-judge winner end-to-end):

| System | factual | depth | citation_q | coherence | useful | **avg** |
|---|---|---|---|---|---|---|
| A · baseline (oneshot) | 3.00 | 2.50 | 2.00 | 4.00 | 3.00 | **2.90** |
| A · reground-**alone** | 5.00 | 4.00 | 4.50 | 4.00 | 4.50 | **4.40** |
| B · Claude Sonnet 4.6 | 4.00 | 5.00 | 4.00 | 5.00 | 4.50 | **4.50** |

reground-alone won decisively here (2.90 → 4.40, ~Claude) and raised rsupport on 4/5 queries
(24→57, 16→74, 6→41, 0→78%). **Honest caveat on magnitude:** n=5 with a *fresh live-web corpus per
run* is noisy — the baseline itself swung 3.68 (Run 1) → 2.90 (Run 2), so do NOT read "4.40 ≈ Claude"
as parity; that one run got a favorable corpus. **What is robust is the DIRECTION, confirmed three
independent ways:** frozen-corpus judge (3.40 → 3.67), end-to-end Run 2 (2.90 → 4.40), and the
deterministic rsupport jumps — **reground-alone reliably improves grounding and overall quality over
baseline, without atomic's depth/coherence cost** (atomic+reground *lost* in Run 1). Net verdict:
**ship `reground` (flag, default-off); keep `atomic` off.** (The end-to-end benchmark's uncontrolled
corpus is itself a finding: for reproducible synthesis A/Bs, freeze the corpus — as §1's experiment did.)

---

## 6. Shipped to core (all TDD, default-off / behavior-preserving)

| change | files | flag (default) |
|---|---|---|
| Per-role temperature + min-token floor | `deep-research-config.ts`, `deep-research-cli.ts` (`applyChatParams`) | `RESEARCH_{PLANNER,DISTILL,SYNTH}_{TEMP,MIN_TOKENS}` (0) |
| Grounding-repair strategy | `deep-research.ts` (`buildRegroundPrompt`, `regroundBody`) | `RESEARCH_SYNTH_STRATEGY` (oneshot) |
| `stripThink()` on synth/repair bodies | `deep-research.ts` | always (no-op for non-thinking) |
| Duplicate-"Disputed"-section fix | `deep-research.ts` (`buildSynthPrompt`) | **always-on** (see caveat) |

reground adopts a repaired body only on a genuine precision gain that does **not** drop the number of
*unique* supported sentences and is non-vacuous (so a deletion- or repetition-based rewrite can't game
the metric — Codex finding). `stripThink` strips an *unclosed* `<think>` to EOF so a truncated reasoning
model can't leak chain-of-thought.

> **Caveat on "behavior-preserving":** the flag-gated changes (temp/floor, reground, atomic) are strictly
> default-off. The duplicate-"Disputed"-section fix is the one **always-on** change — it rewords the
> synth prompt's disputed instruction on *every* path (so a report no longer renders two
> `## Disputed / Uncertain` headings). It's an intentional defect fix, not gated; a regression test
> asserts exactly one such section. Everything else leaves the old path byte-identical.

---

## 7. Recommendations (backed by data)

1. **Enable `RESEARCH_SYNTH_STRATEGY=reground` for research synthesis** — the validated win, confirmed
   THREE ways: frozen-corpus judge (citation_quality 1.83 → 3.00, overall 3.40 → 3.67, no coherence
   loss), end-to-end Run 2 (overall 2.90 → 4.40), and rsupport jumps on 4/5 queries. Costs +1 model
   call (~+60s). Safe to flip the box research default to reground.
2. **Do NOT turn on `RESEARCH_SYNTH_ATOMIC` by default.** It maximizes the deterministic grounding
   metric but the blind judge rates the choppy short reports *worse overall* (3.68 → 3.06). Keep it as
   an opt-in for the rare run where citation-traceability matters more than depth/flow.
3. **Trust the judge over the metric.** Report-sentence support is a proxy; gate synthesis changes on a
   blind judge, not on rsupport alone. (This study's central correction.)
4. **Keep the synth on the reliable non-thinking 80b — do NOT swap to a reasoning model.** qwen35-a3b
   grounds well but blanks stochastically on the serial GPU; qwen3-30b-instruct drops citations under
   atomic. The coder follows the synthesis instruction best.
5. **Drop outline / self-critique** — measured cost, no benefit (≤5%).
6. **Redeploy the box** — it runs a pre-Phase-2 build (§9); it cannot even surface the citation metrics.
7. **Higher-leverage future work than synth tweaks:** the gap to Claude (4.28 vs ~3.7) is *depth +
   factual + synthesis judgment* across all dims, not just citation. Likeliest wins: (a) read MORE
   sources (Perplexity's edge is breadth) and a **source-relevance filter** (the harness enforces
   faithfulness but not relevance — see §9); (b) the **hybrid brain** (Claude/Haiku synth on
   pre-distilled notes) for quality runs — already built (`RESEARCH_BRAIN=hybrid`); (c) matcher
   clause-level credit (careful — trust anchor), lower priority.

---

## 8. What worked / what didn't — M5 offload log

**Worked**
- The box ran a full *thorough* meta-research end-to-end (36 sources, 3 iters, 241 claims) — used to
  research this very task (self-critique/refinement literature: arXiv 2512.05387, 2310.06271,
  NAACL-2025 HalluCana — corroborated the reground design).
- Box served ~30+ synth-variant model calls via the `:18091` tunnel reliably; one transient Tailscale
  drop, auto-recovered, no data loss (per-variant try/catch + resumable JSONL).
- Box did all GGUF downloads (Qwen3-Instruct 18G done; gpt-oss-120b 63G in progress) — pure
  network/disk, fully parallel to GPU work.
- mellum distill + 80b plan were fast and reliable for corpus building.

**Didn't / friction**
- **`qwen35-a3b` reasoning-blank** at an 8000-token synth budget (aiact) — reasoning models need a
  much higher floor or they emit nothing. Reliability risk for a serial-GPU production path.
- **llama-swap is serial** — every experiment had to be sequenced on the box GPU; concurrent runs
  thrash/risk OOM (heeded the prior serving-optimization warning; no crashes this session).
- **Double-backgrounding footgun**: `nohup … &` inside the Bash tool's `run_in_background` returns the
  launcher, not the job — confirm the remote PID, don't trust the "completed" of the launcher.

---

## 9. Other findings / defects

- **Deployment hygiene: the live box runs a STALE deploy.** Verified directly: the box's deployed
  `src/homeserver/deep-research.ts` + `deep-research-config.ts` contain **zero** occurrences of
  `verifyReportSentences` / `reportSentencePrecision` / `reportSentenceMatchThreshold` — i.e. Phase-1
  only. (The "Phase-2 live-validated" claim was the laptop dogfood script run against the box's
  *models*, never the box's deployed CLI.) Box reports therefore lack the report-sentence support line
  and the "## Unsupported sentences" section. `main` has Phase-2. → **redeploy the box** (rsync +
  restart per CLAUDE.md), then the atomic+reground improvements land with it.
- **Duplicate "## Disputed / Uncertain" section** in every report (synth prompt asked for one AND
  `renderReport` appends one) — **FIXED** this session: `buildSynthPrompt` now asks to weave caveats
  inline and the renderer owns the heading.
- **Instruction-following varies by model**: under the atomic prompt, `Qwen3-30B-Instruct` dropped the
  `[S#]` citations entirely (kept short sentences, lost the cite discipline); the 80b-coder kept both.
  A reason the coder remains the right synth once atomic is on.
- **Retrieval-relevance gap**: the harness enforces faithfulness (claims→sources) but not relevance
  (sources→question). The meta-research dogfood shoehorned tangential sources (BenchGuard / Formal-LLM
  / SVDecode) to fit sub-questions. Candidate future lever: a post-distill source-relevance filter.

---

## 10. Artifacts

- `scripts/dr-experiment.ts` — frozen-corpus synth experiment harness (retrieve/synth/judge/report).
- `scripts/dr-matcher-diag.ts` — per-sentence matcher diagnostic (why supported/unsupported).
- `scripts/dr-final-benchmark.ts` — end-to-end baseline vs reground vs Claude, blind-judged.
- `data/dr-exp/` (gitignored) — corpora, per-variant reports, `metrics.jsonl`, `NOTES.md` (raw log).

---

## 11. Addendum — follow-up (quality-max for research spikes; latency is free here)

Owner clarified that for the **deep-research / research-spike** use case, latency is a non-issue
(5–7+ min / many calls per run are fine). That reframes the optimization from "fast reliable default"
to **max quality**, and brings back levers downranked in §7.

**Thinking-budget probe** (`scripts/dr-thinking-budget-probe.ts`, qwen35-a3b on the aiact corpus):

| budget | finish_reason | completion_tok | content | reasoning_content | blank? | secs |
|---|---|---|---|---|---|---|
| 8000 ×2 | stop, stop | 4755, 4781 | full | 11394, 10731 | ok, ok | 97, 82 |
| 16000 ×2 | stop, stop | 6442, 6960 | full | 18774, 22751 | ok, ok | 111, 120 |

- **Not HW-constrained.** 64 GiB VRAM, ~40 GiB free with qwen35 loaded at `-c 32768`; raising the
  *completion* budget within the 32K window is free (KV already allocated). The 8000 cap was the
  experiment's floor, not a hardware limit.
- **The blanks are intermittent tail events, not the norm** — qwen35 finishes cleanly at 8K *and* 16K
  here (it used ~4.7–7k tokens and stopped naturally), in **~80–120s, not the 6–7 min I'd estimated**.
  The earlier aiact blank was an occasional run where reasoning ran to the cap. A 16–24K budget +
  retry-on-blank makes the reasoning synth fully reliable. Reasoning lands in a separate
  `reasoning_content` field (so `content` is clean) — `stripThink()` still covers the inline-`<think>`
  serving variant.

**Re-ranked quality-max levers (latency free):** (1) **depth** — `thorough` retrieval (more sources +
the gap loop), the measured biggest gap to Claude (depth 4.4–5.0 vs local 2.5–4.0), untested for
quality tonight (everything ran `quick`); (2) **reasoning-model synth** (qwen35-a3b, 16–24K budget +
retry) — best grounder, now viable; (3) **Tongyi-as-AGENT** (the specialist's own loop) — filed as a
build, issue **#40** (on the roadmap board); (4) **hybrid brain** (`RESEARCH_BRAIN=hybrid`, built).

**Queued (box):** a quality-max benchmark — best local (thorough + reground, ± qwen35 synth) vs
baseline vs Claude — to measure how close latency-unconstrained local gets to the 4.28 ceiling.
The benchmark script now takes `BENCH_IMPROVED_DEPTH=thorough`.

### 11b. Quality-max Run 1 (thorough + reground) — local arms ran; JUDGING BLOCKED (OpenRouter weekly limit)

Ran baseline (quick) vs **thorough + reground (80b)** vs Claude (thorough), 3 queries. The **local
arms succeeded** and `thorough` mode works as designed:

| query | baseline (quick) | thorough+reground | 
|---|---|---|
| fasting | 6 sources, 2323 w, rsupport 34% | **24 sources**, 2885 w, rsupport 33% |
| aiact | 6 sources, 2007 w, rsupport 7% | **24 sources**, 3088 w, rsupport 40% |
| coffee | 6 sources, 1377 w, rsupport 0% | 8 sources (gap loop stopped early), 1599 w, rsupport 63% |

**BLOCKED:** the OpenRouter key hit its **weekly limit** mid-run (`403 Key limit exceeded`), so every
blind-judge call AND the Claude arm 403'd → no judged scores. The depth question ("does reading 4×
the sources improve *judged* depth/quality, or just add length?") is therefore **unanswered tonight**.
The local reports are saved (`data/research/qualitymax-depth/qN-{A_baseline,A_reground}.md`); judge
them with `scripts/dr-judge-reports.ts` when credits reset.

**Cost lesson:** the Claude-harness arm (`B`) runs a FULL pipeline of Claude calls *per query* (plan +
6–24 distill + synth). Re-running it across three benchmark runs (5+5+3 queries) is what exhausted the
weekly budget — the *local* experiments were all free on the M5. **Future: cache the Claude reference
(run it once), or use `RESEARCH_BRAIN=hybrid` (Claude synth only, ~$0.07/run) instead of a full
Claude pipeline, and judge saved reports rather than re-running.**

### 11c. RESOLVED (2026-06-21, evening) — judged the saved depth reports + answered depth-vs-Claude

When 2 OpenRouter credits were added, judged the saved reports — but the right move was a **hybrid
judge** that barely touches OpenRouter: **Opus judge via the Claude subscription (a Claude Code
subagent — FREE), o4-mini judge via OpenRouter (~$0.03)**. New reusable tool: `scripts/dr-judge-hybrid.ts`
(blind-shuffle once/query with **counterbalanced ordering** to kill position bias → o4-mini scores +
emits blind bundles for the sub-Opus judge → `--aggregate` merges them). The earlier weekly-cap blowout
was the **Claude reference arm**, never the judge — judging is pennies.

**reground validated a 4th way** (thorough-depth corpus, cross-family blind, A_baseline vs A_reground):
overall **3.30 → 4.27** (+0.97), **citation_quality 2.67 → 4.17** (+1.50, the targeted metric),
depth 3.17→4.33, usefulness 3.17→4.33, **coherence flat 4.00→4.17 (no regression** — the key contrast
vs atomic-synth). reground won 5/6 judge-query verdicts. So reground holds across corpus (frozen
3.40→3.67), judge family, retrieval depth (6→24 sources), and end-to-end (Run-2 2.90→4.40).

**The saved `B_claude` depth reports were empty local stubs** (`brain: local · No claims could be
extracted`) — the Claude arm 403'd last session, so there was no real Claude reference. **Regenerated
it via the SUB (free):** 3 Claude/Opus subagents each independently researched the **same discovered
source URLs** (from the A_reground `## Sources`) with WebFetch and wrote a cited report (NOT shown the
local report → independent synthesis). Then a 3-way hybrid blind judge:

| system | factual | depth | citation | coherence | useful | **avg** | mean-rank | wins |
|---|---|---|---|---|---|---|---|---|
| A_baseline | 3.17 | 3.00 | 2.67 | 3.50 | 2.83 | **3.03** | 2.83 | 0/6 |
| A_reground | 4.17 | 3.83 | 4.00 | 3.83 | 3.83 | **3.93** | 2.17 | 0/6 |
| **B_claude** (sub) | 4.83 | 5.00 | 4.50 | 5.00 | 5.00 | **4.87** | **1.00** | **6/6** |

**ANSWER: thorough retrieval + reground NARROWS but does NOT close the gap to Claude.** Clean unanimous
ordering Claude > reground > baseline; Claude won **6/6** judge-query verdicts (mean-rank 1.00). reground
closes ~half the gap (+0.90 over baseline, ~0.94 still short of Claude); its strongest dimension vs Claude
is **citation_quality (4.00 vs 4.50)** — grounding-repair is where local catches up most — and it stays
furthest behind on depth/coherence/usefulness (3.83 vs 5.00). **Implication:** on synthesis quality the
local box, even tuned, is meaningfully below Claude → direct evidence for the **hybrid** design (Claude
brain for top-quality research, local for cheap/bulk). reground stays the right *local* default.

**Caveats:** n=3 (but both judges unanimous); Claude read **full pages** while the local harness
synthesized from mellum-**distilled** claims, so this isolates read+synth given the same *discovered*
sources, not retrieval; the judge truncates every report to 6000 chars (caps the longer local reports
more — yet Claude still dominated in-window). Total OpenRouter spend across both judge rounds: ~$0.05.
