# Local LLM Inference Evaluation — Final Results

> **Historical Phase-A result.** These are hosted-proxy screening results and pre-purchase economic
> estimates, not the current M5 production architecture, realized ROI, or local model roster. Start
> with [`docs/architecture.md`](./docs/architecture.md) and
> [`docs/vision-evidence-map.md`](./docs/vision-evidence-map.md) for current claims and maturity.

**Date:** 2026-03-30
**Evaluator:** Claude Opus 4.6 + OpenAI o4-mini (dual judge)
**Total runs:** 385 inference calls across 12 models, 30 tasks, 3 hardware tiers
**Total judge evaluations:** 758
**Total cost:** ~$4 (OpenRouter inference + judging)

---

## Executive Summary

**Can local models do useful work?** Yes. The best model we tested (GPT-oss-120B) scored 1.89/2.0 — near-perfect quality — and fits in 80GB on a 128GB Mac Studio. Five other models scored above 1.6, all fitting in 128GB.

**Is it economically justified?** At the measured reference workload (~1.9B tokens/month), a 40K SEK Mac Studio breaks even in 6-8 months vs OpenRouter API. With 4 co-op members, the cost is ~300 SEK/person/month — half the reference Claude MAX subscription.

**How many concurrent users?** The best models use MoE architecture with 3-5B active parameters, enabling ~55-90 tok/s on a Mac Studio. At 5 concurrent users, each gets 11-18 tok/s — usable for interactive work.

---

## 1. Model Quality Leaderboard

Tested 12 models against 30 tasks (20 generic + 10 real-world). Judged by both Claude Opus and OpenAI o4-mini. Scale: 0 = fail, 1 = acceptable, 2 = good.

| Rank | Model | Score | Fits 128GB | Active params | Avg time (cloud) |
|------|-------|-------|------------|--------------|-----------------|
| **1** | **GPT-oss-120B** | **1.89** | **Yes (80GB)** | 5.1B MoE | 102s |
| 2 | Qwen3-235B-MoE | 1.68 | No (256GB) | 22B MoE | 159s |
| 3 | MiniMax-M2.5 | 1.68 | No (256GB) | 15B MoE | 62s |
| 4 | GLM-4.7-Flash | 1.64 | **Yes (~4GB)** | ~3B MoE | 65s |
| 5 | Qwen3-Coder-Next | 1.62 | **Yes (~46GB)** | 3B MoE | 19s |
| 6 | Qwen3-32B | 1.62 | **Yes** | 32B dense | 443s |
| 7 | Devstral-2 | 1.62 | **Yes (~70GB)** | 123B dense | 14s |
| 8 | Qwen3-14B | 1.51 | **Yes (~10GB)** | 14B dense | 84s |
| 9 | Nemotron-3-Super | 1.51 | **Yes (~65GB)** | 12B hybrid | 7.5s |
| 10 | DS-R1-32B | 1.35 | **Yes** | 32B dense | 82s |
| 11 | Llama3.3-70B | 1.33 | Yes (tight) | 70B dense | 66s |
| 12 | Qwen2.5-Coder-32B | 0.33 | **Yes** | 32B dense | 5.4s |

**Key findings:**
- **GPT-oss-120B dominates** — OpenAI's open-weight model with native Metal support
- **MoE models win** — the top 5 models are all MoE, using 3-22B active params despite having 80-309B total
- **Bigger isn't better** — Llama 70B (dense) scores lower than GLM-4.7-Flash (3B active)
- **Qwen2.5-Coder-32B is broken** — fast but nearly all-fail scores. Responses too terse (188 avg tokens)

---

## 2. Three-Tier Hardware Comparison

Same models, same tasks, tested on cloud (OpenRouter), MacBook Air M4 (32GB), and Raspberry Pi 5 (8GB).

### Speed comparison (real-001: Project Status Report)

| Platform | Model | Time | Quality |
|----------|-------|------|---------|
| Cloud | Qwen3-14B | **12s** | 2.0 (good) |
| Cloud | GLM-4.7-Flash | 34s | 2.0 (good) |
| MacBook Air | Qwen3-14B | 238s | 2.0 (good) |
| MacBook Air | GLM-4.7-Flash | 56s | 2.0 (good) |
| Pi 5 | qwen2.5:7b | 559s | 2.0 (good) |
| Pi 5 | qwen2.5:3b | 136s | 1.0 (acceptable) |

### Quality: local vs hosted

| Platform | Model | Quality score | Notes |
|----------|-------|-------------|-------|
| **Cloud (OpenRouter)** | Qwen3-14B | **1.55** | Baseline — likely FP16 |
| **MacBook Air (local)** | Qwen3-14B | **1.48** | 5% quality drop — negligible |
| **Pi 5 (local)** | qwen2.5:7b | **1.72** | Different model, but acceptable |
| **Cloud (OpenRouter)** | GLM-4.7-Flash | **1.70** | Baseline |
| **MacBook Air (local)** | GLM-4.7-Flash | **1.07** | Significant quality drop locally |
| **Pi 5 (local)** | qwen2.5:3b | **1.11** | Small model, limited quality |

**Key finding:** Qwen3-14B maintains quality locally (1.48 vs 1.55 hosted — within noise). GLM-4.7-Flash degrades more (1.07 vs 1.70), likely because the local quantization hurts this MoE model more. This suggests dense models like Qwen3-14B may be more reliable for local deployment than highly sparse MoE models.

---

## 3. Cost Analysis

### Measured reference workload: ~1.9B tokens/month

| Option | Monthly cost (SEK) | Notes |
|--------|-------------------|-------|
| **Current: Claude MAX** | 1,000 | Running out of compute regularly |
| OpenRouter Qwen3-32B | ~4,800 | Full volume on API |
| OpenRouter GPT-oss-120B | ~3,600 | Full volume on API |
| **Mac Studio M4 Max 128GB** | ~1,186 | Amortized 36 months + electricity |
| Mac Studio (4-way co-op) | **~300/person** | The sweet spot |

### Break-even analysis

| Hardware | Solo break-even | 2-person split | 4-person split |
|----------|----------------|---------------|---------------|
| Mac Studio 128GB (40K SEK) | **8 months** vs OpenRouter | 4 months | 2 months |
| Mac Studio 256GB (95K SEK) | ~20 months | 10 months | 5 months |

### Recommendation
The 128GB Mac Studio pays for itself in under a year solo, and in 2-4 months with a co-op. The 256GB is not justified — the best model (GPT-oss-120B) fits in 128GB.

---

## 4. Concurrent User Capacity (Estimated)

Based on M4 Max 128GB (546 GB/s memory bandwidth) and active parameter counts:

| Model | Active params | Est. tok/s | Users at 10 tok/s each |
|-------|-------------|-----------|----------------------|
| GPT-oss-120B | 5.1B | ~55 | **5 users** |
| GLM-4.7-Flash | ~3B | ~90 | **9 users** |
| Qwen3-Coder-Next | 3B | ~90 | **9 users** |
| Qwen3-14B | 14B (dense) | ~55 | **5 users** |
| Devstral-2 | 123B (dense) | ~8 | **0-1 users** |

**For the hackathon booth:** GLM-4.7-Flash or Qwen3-Coder-Next can serve 5-9 concurrent users from one Mac Studio. GPT-oss-120B can serve 5.

---

## 5. Recommended Setup

### Mac Studio M4 Max 128GB — Dual-Model Loadout

| Slot | Model | RAM | Role | Est. tok/s |
|------|-------|-----|------|-----------|
| Primary | **GPT-oss-120B** | ~80GB | Quality workhorse (1.89 score) | ~55 |
| Utility | **GLM-4.7-Flash** | ~4GB | Fast tasks, debugging, non-coding | ~90 |
| Free | | ~44GB | OS + context windows | |

### What stays on cloud (Opus/Sonnet)
- Complex architecture design (local models scored 0.5-1.5 on architecture)
- Research requiring web search
- Multi-turn creative/strategic work
- Tasks requiring >128K context

### What moves to local (~50% of workload)
- Refactoring (local scored 2.0 — perfect)
- Debugging (1.6-2.0)
- Status reports and documentation (2.0)
- Commit messages (2.0)
- Swedish text tasks (1.3-1.7)
- Simple coding (1.3-1.5)
- Non-coding assistant tasks (1.5-2.0)

---

## 6. Answers to the Key Questions

### Q1: Would I get useful work out of local models?
**Yes.** GPT-oss-120B scores 1.89/2.0 — nearly as good as frontier models on these tasks. Even on the tested 32 GB MacBook Air, Qwen3-14B produces quality work (1.48) — just slower.

### Q2: How much of my workload could be offloaded?
**~45-55%.** Refactoring, debugging, documentation, commit messages, status reports, and simple coding all work well locally. Architecture, research, and complex creative tasks stay on Opus.

### Q3: How many concurrent users on a Mac Studio?
**3-5 comfortably, up to 9 with smaller models.** MoE models (GPT-oss-120B at 5.1B active, GLM-4.7-Flash at 3B active) are the key — they deliver high quality at low compute cost per token.

### Q4: Is it economically feasible?
**Yes.** Solo: breaks even in 8 months. 4-person co-op: ~300 SEK/person/month — cheaper than any current subscription, with unlimited compute and full privacy.

---

## 7. Caveats and Limitations

1. **Quality scores are hosted proxy estimates.** OpenRouter serves at FP16/BF16; local inference at Q4/Q8 may score slightly lower. Qwen3-14B showed minimal degradation (1.48 vs 1.55), but other models may vary.

2. **Speed estimates are theoretical.** Actual tok/s on Mac Studio needs Phase B validation on real hardware.

3. **Concurrent user estimates are linear division.** Real multi-user serving has queuing overhead, context management, and thermal throttling effects that can only be measured empirically.

4. **GPT-oss-120B local runtime is unvalidated.** The MXFP4 native format with Metal support exists but has not been confirmed running via Ollama/MLX. This is the single highest-risk item.

5. **30 tasks is indicative, not statistically rigorous.** Per-category conclusions (4-6 tasks each) should be treated as directional, not definitive.

---

## 8. Recommended Next Steps

1. **Validate GPT-oss-120B locally** — confirm it runs via Ollama on Apple Silicon
2. **Rent a Mac Studio for a weekend** (~$50-100) — run Phase B concurrent latency tests
3. **Try aider + Ollama** — test the agentic coding workflow (local Claude Code alternative)
4. **Wait for M5 Max announcement** — expected summer 2026, likely 614+ GB/s bandwidth
5. **If M5 delivers:** buy 128GB model, split with co-op, deploy GPT-oss-120B + GLM-4.7-Flash

---

## Appendix: Evaluation Methodology

- **Framework:** Custom TypeScript evaluation pipeline with SQLite storage
- **Inference:** OpenRouter API (cloud), Ollama (local Air + Pi)
- **Judging:** Dual LLM-as-judge (Claude Opus 4.5 + OpenAI o4-mini)
- **Scoring:** 3-point scale (fail=0, acceptable=1, good=2) across correctness, completeness, quality
- **Tasks:** 20 generic (coding + non-coding) + 10 real-world (mined from 6,567 actual prompts)
- **Models:** 12 open-weight models, 8B-309B parameters
- **Hardware tiers:** Cloud (OpenRouter), MacBook Air M4 32GB, Raspberry Pi 5 8GB
- **Code:** [github.com/Magnus-Gille/gille-inference](https://github.com/Magnus-Gille/gille-inference)
