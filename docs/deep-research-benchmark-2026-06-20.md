# Deep-research benchmark — local vs Claude-harness vs Perplexity DR (2026-06-20)

_The design's Phase-5 validation gate, run for real instead of by benchmark proxy. 5 research
questions, three systems, blind-judged by two cross-family judges._

## Method

| System | What it is |
|---|---|
| **A · Local (M5)** | The deployed harness: `ddgs` search + Trafilatura reader + **local M5 models** — qwen3-coder-next-80b (plan/synth) + mellum (distill) via llama-swap. |
| **B · Claude (same harness)** | The **identical** harness + search + reader, but **Claude Sonnet 4.6** does plan/distill/synth (via OpenRouter). Isolates the single variable: local vs frontier reasoning. |
| **C · Perplexity DR** | `perplexity/sonar-deep-research` — a productized frontier Deep Research (its own retrieval + synthesis), one call. |

- **Queries (5):** intermittent fasting (clinical), EU AI Act GPAI obligations, coffee & cardiovascular consensus, Fermi paradox resolutions, GLP-1 agonists for non-diabetic weight loss.
- **Judges:** `anthropic/claude-opus-4.8` + `openai/o4-mini`, **blind** (reports shuffled to anonymous labels per query), scoring 1–5 on factual_accuracy / depth_coverage / citation_quality / coherence / usefulness + an overall rank.
- **Harness fairness:** A and B used the same `depth=quick`, 5 sources/query, same ddgs + Trafilatura. Run laptop-side (OpenRouter key never written to the box); the box served A's local models via an SSH forward.
- Artifacts: `data/research/benchmark-2026-06-20T19-03-12-351Z/` (BENCHMARK.md, results.json, 15 reports).

## Results (mean 1–5, 5 queries × 2 judges)

| System | factual | depth | citation | coherence | useful | **avg** | mean rank | rank-1 wins | avg time |
|---|---|---|---|---|---|---|---|---|---|
| **C · Perplexity DR** | 4.7 | 4.9 | 3.7 | 4.9 | 4.7 | **4.58** | 1.3 | **8 / 10** | 255s |
| **B · Claude Sonnet (same harness)** | 3.9 | 3.8 | 3.8 | 4.0 | 3.8 | **3.86** | 2.0 | 1 | 214s |
| **A · Local M5 (80b + mellum)** | 3.0 | 3.0 | **2.2** | 3.8 | 3.0 | **3.00** | 2.7 | 1 | 201s |

Ordering is unambiguous and the two judges agreed on nearly every query: **Perplexity DR > Claude-harness > Local.** Per-query rank-1 went to C on 8 of 10 judge-rankings; A took rank-1 once (Q5, GLP-1, from the Opus judge) and B once (Q5, from o4-mini).

## Findings

1. **The harness carries real weight; the brain is the gap.** A vs B is the *same* pipeline — only the reasoning model changes — and Claude buys **+0.86/5 for cents/run**. The deterministic scaffolding (search, dedup, tier-ranking, citation glue) does meaningful work, but frontier reasoning still separates the tiers. The design thesis, now measured.
2. **Local's one real weakness is citation_quality (2.2/5)** — far below B/C (~3.7–3.8), and *below its own deterministic precision metric* (72–100%). Independent judges see weaker grounding than the metric claims, confirming the dogfood gap: the MVP metric checks *distilled-claim → source*, not whether the synthesized prose is grounded. **This is exactly what the Phase-2 report-sentence citation pass fixes** — the highest-leverage local improvement.
3. **Local is not slow or incoherent.** Warm, A averaged 201s (*faster* than B and C) and coherence 3.8 ≈ the others. The cold-start / llama-swap reload — not steady-state speed or quality — was local's only latency story.
4. **Perplexity DR (4.58) is the bar to chase, not match today.** It reads more sources with frontier retrieval+synthesis; our harness-with-Claude (3.86) is the realistic sovereign-ish ceiling right now.

## Decision

Validates shipping **local-first with a pluggable escape hatch**, not local-only:

- **Private / sovereign →** local (3.0/5, $0, on-box).
- **Quality, non-sensitive →** hybrid (local fetch + Claude synth — raw pages never leave; 3.86, cents).
- **Hardest / throwaway →** Perplexity DR (4.58, ~$0.5, labelled non-sovereign).

→ Re-point `/research-spike` to **local-default with a `--brain hybrid` flag**.

## Open follow-up (the next experiment)

A used the *generic* qwen3-coder-80b. **Tongyi-DeepResearch-30B-A3B** is purpose-trained for the research loop (GAIA 70.9 ≈ o3-deep-research). Re-running A with **Tongyi as a single brain** measures how much of the 3.0 → 3.86 gap a research-specialist local model closes — and it removes the plan↔distill↔synth swap. Plus: re-judge after the Phase-2 report-sentence citation pass lands (local's weakest dimension).

## Update — Tongyi-DR probed as the local brain: a NEGATIVE result

Pulled Tongyi-DR-30B-A3B (Q4_K_M) onto the box, registered it in llama-swap, and re-ran A with
**planner=tongyi-dr, synth=tongyi-dr, distill=mellum** on Q1+Q2 (same B=Claude, C=Perplexity anchors,
which held: 4.05 / 4.75 ≈ the 5-query 3.86 / 4.58). Two integration findings first: Tongyi is a
**reasoning model** (reasoning in a separate `reasoning_content` field; the harness reads `content`,
correct, but the per-stage token budget must be raised so reasoning finishes) and it **degenerate-loops
at temperature 0** (the known MoE hazard, and the harness's default) — at temp 0 its plan collapsed to a
1-query fallback; at temp 0.6 + a 4000-token floor it planned cleanly (6 sub-questions / 5 queries, 95–100%
citation precision).

**Same-query head-to-head (Q1+Q2, both judges):**

| System (Q1+Q2) | avg /5 |
|---|---|
| A · qwen3-coder-80b (generic) | **3.10** |
| A · Tongyi-DR (research-specialist) | **2.20** |

**Tongyi scored ~0.9 *lower* than the generic 80b-coder** — weakest on depth_coverage (1.75) and
usefulness (1.75). The likely reason: Tongyi-DR is RL-trained to drive its **own** agentic ReAct
browse loop (where its GAIA 70.9 comes from). Our harness deliberately *replaces* that autonomy with
deterministic code and uses the model only for **bounded single calls** (plan, synth). Stripped of the
loop it was trained for, Tongyi is a weaker plain plan/synth model than a strong generalist coder.

**This reinforces the core thesis** ("the harness carries the intelligence, not the model"): when the
scaffolding carries the long-horizon work, a strong *generalist* beats an agentic *specialist* used as a
stage model. **Conclusion: keep qwen3-coder-80b as the local plan/synth brain; do not swap in Tongyi.**
Tongyi may still pay off in a *different* architecture — as an autonomous agent driving its own
search/read/reflect loop (Tongyi-*as-agent*, not Tongyi-as-stage) — which is a separate, larger
experiment, not a config change. The model + llama-swap entry are left in place for that future test.

The real local-quality levers remain: **hybrid (Claude synth)** for quality runs, the **Phase-2
report-sentence citation pass** (local's weakest dimension), and synth-prompt/outline tightening.
