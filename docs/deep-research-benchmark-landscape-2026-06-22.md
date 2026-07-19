# Deep-Research Benchmark Landscape (2026-06-22)

Reference for evaluating/improving the self-hosted deep-research pipeline (local-only, M5). Produced by a
web research sweep; **confidence caveat:** launch-era figures (OpenAI Deep Research Feb-2025; FRAMES;
DeepResearch Bench; BrowseComp Apr-2025) are primary-source-verified. Several late-2025/2026 "leaderboard"
numbers from aggregator trackers were **excluded as untrustworthy**. Also note **contamination risk** — a
deep-research agent can retrieve a benchmark's answers off the live web, so treat any live-web score with
caution (prefer offline/frozen corpora).

Framing note: the literature is split on whether the bottleneck is retrieval or synthesis (DeepWeb-Bench
attributes ~12–14% of errors to retrieval, >70% to derivation; BRIGHT shows a ~40-pt nDCG collapse on
reasoning-heavy retrieval). So **measure where your gap is, don't assume** — which is exactly what the
FRAMES oracle arm did (see `frames-oracle-findings-2026-06-22.md`): the answer was *numerical reasoning*.

## End-to-end benchmarks

| Benchmark | Tests | Grading (cheap gold? / judge?) | Dataset / offline | SOTA reference | Report-pipeline fit |
|---|---|---|---|---|---|
| **FRAMES** | multi-hop RAG synthesis (2–15 Wiki articles) | LLM-judge autorater (≈0.96 human agree); answers short → cheap, can use a local judge | `google/frames-benchmark`, **824 Q, Apache-2.0, offline** | Gemini-1.5-Pro oracle **0.73**, multi-step retrieval 0.66, no-retrieval 0.41 | **EXCELLENT — adopted.** retrieve+synthesize, offline, gold answers |
| GAIA | live web + tool use + files, multi-step agent | gold exact-match (cheap) | `gaia-benchmark/GAIA`; val 165 open | OpenAI DR 67.4%; open scaffolds ~69–82% | Poor — agentic/GUI, needs live web |
| BrowseComp | hard multi-hop browsing, single short answer | gold exact-match (cheap) | `openai/simple-evals`, 1,266 Q, MIT; **needs live web** | OpenAI DR 51.5% vs humans 29.2% | Poor for reports — tests navigate, not synth |
| BrowseComp-Plus | same Q over fixed 100K-doc corpus | exact-match, offline | `Tevatron/browsecomp-plus(-corpus)`; **offline** | (shared testbed) | Partial — clean offline **retriever** isolation |
| HLE (Humanity's Last Exam) | expert closed-book knowledge, 2,500 Q | LLM equality-check | subset public; CC-BY-4.0 | OpenAI DR 26.6%; Perplexity DR 21.1% | Poor — knowledge exam, no pipeline |
| SimpleQA / -Verified | short factual recall (parametric) | LLM classifier | GitHub/Kaggle; offline | Gemini-2.5-Pro 55.6 F1 (Verified) | Poor — no retrieval/synth |
| DeepResearch Bench | 100 PhD report tasks, 22 fields | **RACE** (LLM-judge 4-dim) + **FACT** (citation) | `muset-ai/DeepResearch-Bench-Dataset`; offline grading | Gemini-2.5 DR RACE 48.9, OpenAI DR 47.0 | **Best report-QUALITY fit** (judge-expensive; use later) |
| ResearcherBench | 65 frontier AI-science Qs | rubric coverage + faithfulness + groundedness | `GAIR-NLP/ResearcherBench`; offline | OpenAI DR ~70% citation / ~84% faithful | Good — faithfulness/groundedness split is diagnostic |
| DeepConsult | 102 consulting report Qs | pairwise LLM-judge win-rate vs OpenAI-DR | `youdotcom-oss/ydc-deep-research-evals`; offline | Salesforce EDR 71.6% win-rate | Good for enterprise reports |
| SealQA / Seal-0 / Seal-Hard | fact-seeking under conflicting/noisy search | LLM-judge (≈98% human agree) | `vtllms/sealqa`; **frozen, offline** (Jun-2025) | GPT-5-high Seal-0 43% / Seal-Hard 64%; open-235B ~5%/11% | **Strong — hard follow-on**, prose-tolerant |
| WebWalkerQA | site-traversal QA, 680 Q | LLM-judge (Qwen2.5-72B) | `callanwu/WebWalkerQA`, Apache-2.0; mostly offline | Tongyi DeepResearch 72.2; o3 71.7 | Partial — reader/crawl depth |
| WebArena / WebVoyager / Mind2Web | browser ACTION sequences | action-completion / trajectory judge | Docker sandbox / live sites | WebVoyager ~89%; WebArena 65–74% | **Not applicable** — actions, not reports |
| HotpotQA / 2WikiMultiHop / MuSiQue / Bamboogle | classic 2–4-hop Wiki QA | **gold EM/F1 (cheapest)** + evidence/support F1 | HF, offline | RAG ~60–70 F1; MuSiQue best ~40 F1 | Low — contaminated/extractive; sanity-check only |

## Component-level benchmarks (isolate a single stage — cheap, deterministic, no judge)

| Stage | Benchmark | Metric (cost) | Offline | Note |
|---|---|---|---|---|
| **Retrieval (reasoning-heavy)** | **BRIGHT** (2407.12883) | nDCG@10 (cheap) | yes | MTEB-good ≠ BRIGHT-good (40-pt gap). Best ~38 |
| Retrieval (general) | BEIR / MTEB / MS-MARCO | nDCG@10 / MRR (cheap) | yes | embedding-backbone selection only |
| **Reading faithfulness** | **SummaC-ZS** (2111.09525) | NLI entailment ROC-AUC (free) | yes | segment source at ~200 tokens |
| Faithfulness (per-claim) | **MiniCheck-770M** (2404.10774) | per-claim support (free) | yes | "GPT-4-level at 400× lower cost" — ideal inline verifier |
| **Citation grounding** | **ALCE** (2305.14627) | citation recall/precision (NLI) | yes (GPU) | top models ~50% full support on ELI5 |
| Attribution classifier | AttributionBench (2402.15089) | macro-F1 (cheap) | yes | test `citation-verifier.ts` directly; ceiling ~80 F1 |
| Reference-free RAG triage | RAGAS (2309.15217) | faithfulness/relevance (local-judge) | yes | low context-recall→retrieval; high context+low faith→reading; high faith+low answer-rel→synthesis |
| Full-pipeline process audit | LiveDRBench / DeepResearch-9K / ResearchRubrics | claim-discovery F1 / process trace | varies | localize which stage regressed |

Living index of new ones: GitHub `DavidZWZ/Awesome-Deep-Research`.

## Recommendation (adopted)

1. **FRAMES — primary objective score.** Offline, gold answers + gold source URLs, frontier reference
   (oracle 0.73 / multi-step 0.66 / no-retrieval 0.41). Its three-way split (no-retrieval / your-retrieval /
   oracle-gold-injected) localizes the bottleneck immediately. **Done — see the FRAMES findings doc.**
   (Caveat surfaced in use: `explaintext` corpus strips tables → rebuild table-preserving before trusting
   precise tabular/numerical numbers.)
2. **BRIGHT + SummaC-ZS — the diagnostic pair, zero judge cost.** BRIGHT = "did you fetch the right things"
   (retrieval under reasoning load); SummaC = "did you read them without hallucinating" (faithfulness). Both
   offline, deterministic. Use to separate input-side from reading once retrieval is in play.
3. **SealQA (Seal-Hard) — the hard, contamination-resistant, frontier-comparable follow-on** once the basics
   are green (frozen, offline, prose-tolerant judge; frontier <65% so it discriminates).
- **Skip for the core objective:** GAIA/BrowseComp/WebArena/WebVoyager/Mind2Web (agentic/GUI, live web).
  HLE/SimpleQA (closed-book exams). DeepResearch Bench/ResearcherBench/DeepConsult are the right
  report-QUALITY tools *later* (RACE/rubric) but are judge-expensive and don't cheaply say *where* you fail.
