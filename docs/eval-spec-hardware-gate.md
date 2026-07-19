# Go/No-Go Evaluation Spec: Mac Studio Hardware Purchase

**Status:** historical pre-purchase draft; superseded by the acquired Strix Halo M5 and measured
[`migration-go-no-go-verdict.md`](./migration-go-no-go-verdict.md)
**Date:** 2026-04-06
**Context:** The orchestration benchmark and cost analysis show promising results for local inference, but the debate review identified that the buy recommendation outran the evidence. This spec defines the exact criteria that must be met before committing to a purchase.

---

## 1. What we already know (prior evidence)

| Finding | Evidence | Confidence |
|---------|----------|------------|
| Local Gemma4-26B matches Sonnet on sub-tasks | Hybrid 1.98/2.0 vs cloud 1.88/2.0 (7 compound tasks, dual-judge) | Medium — small sample, synthetic tasks |
| Fully-local viable at 1.83/2.0 | 7/7 tasks completed, $0.00/task | Medium — same sample limitation |
| 97.3% of prompts classified as locally solvable | 750 real prompts, Qwen2.5-7B classifier | Low — unvalidated against actual routing |
| Hardware throughput ~90 tok/s (Gemma4-26B, 128GB) | Extrapolated from M4 Air (20 tok/s at 120 GB/s) via bandwidth formula | Low — not measured on target hardware |
| Single-user break-even at 25 months (2 users MAX 5x) | Derived arithmetic, not in codebase | Medium — math correct, assumptions unvalidated |

**What remains unvalidated:** concurrent throughput, real hardware performance, actual token displacement from billing, operational burden, degradation under load.

---

## 2. Hardware acquisition path

Weekly Mac Studio rental does not exist. Instead, run the concurrency and degradation tests on existing hardware and extrapolate.

**Available machines:**

| Machine | Chip | RAM | Bandwidth | Can run Gemma4-26B? | Max concurrent (E2B) |
|---------|------|-----|-----------|--------------------|--------------------|
| MacBook Air M4 | M4 | 32GB | ~120 GB/s | Yes (17GB, tight) | 4 users |
| MacBook Pro M1 | M1 | 16GB | ~68 GB/s | No (17GB > 16GB) | 4 users |

**Extrapolation to Mac Studio M4 Max (128GB, 546 GB/s):** bandwidth ratio = 546/120 = 4.55x vs Air. Already validated: Air measured ~20 tok/s for Gemma4-26B, 20 × 4.55 = 91 tok/s (matches the 90 tok/s estimate in models.ts).

**Key insight:** The concurrency *degradation pattern* (percentage drop per user) should be consistent across Apple Silicon chips — same memory controller architecture, same bandwidth-bound inference model. Testing on two machines cross-validates this assumption. If degradation is linear on both M1 and M4, it will be linear on M4 Max.

---

## 3. Test matrix

### 3.1 Throughput test (T)

Already measured on M4 Air. Extrapolate to Mac Studio via bandwidth ratio (4.55x).

| Test ID | Model | Measured (Air) | Extrapolated (Mac Studio) | Registry estimate |
|---------|-------|---------------|--------------------------|-------------------|
| T-01 | Gemma4-26B Q4 | ~20 tok/s | ~91 tok/s | 90 tok/s |
| T-02 | Gemma4-E2B Q4 | ~40 tok/s | ~182 tok/s | 150 tok/s |

**Status: Already validated.** Measured Air throughput × 4.55 matches registry estimates within 10%. No rental needed for this gate.

GPT-oss-120B and Qwen3-Coder-Next cannot be tested on the Air (too large). These remain estimated-only until real hardware is available.

### 3.2 Concurrent user test (C)

Run on both machines to cross-validate the degradation pattern.

**Script:** `tsx scripts/concurrent-benchmark.ts`

#### Air M4 (32GB) tests

| Test ID | Model | Users | Command |
|---------|-------|-------|---------|
| C-A1 | Gemma4-26B | 1, 2 | `tsx scripts/concurrent-benchmark.ts --model gemma4:26b --users 1,2 --rounds 5` |
| C-A2 | Gemma4-E2B | 1, 2, 4 | `tsx scripts/concurrent-benchmark.ts --model gemma4:e2b --users 1,2,4 --rounds 5` |

#### Pro M1 (16GB) tests

| Test ID | Model | Users | Command |
|---------|-------|-------|---------|
| C-P1 | Gemma4-E2B | 1, 2, 4 | `tsx scripts/concurrent-benchmark.ts --model gemma4:e2b --users 1,2,4 --rounds 5` |

Each test runs 5 rounds × N users = 5N inference calls per level. Measures per round:
- **Median tok/s per user**
- **p95 time-to-first-token (TTFT)**
- **Total throughput** (all users combined)
- **Throughput degradation** vs single-user baseline

**Cross-validation:** Compare E2B degradation curves from Air (C-A2) and Pro (C-P1). If the percentage drop per user is consistent (within 10%), the bandwidth-sharing model is validated across chips and we can confidently extrapolate to Mac Studio.

**Pass criteria:**
- At 2 concurrent users: per-user tok/s >= 50% of single-user baseline AND p95 TTFT < 5 seconds
- At 4 concurrent users: per-user tok/s >= 30% of single-user baseline AND p95 TTFT < 10 seconds
- Total throughput at 4 users >= 80% of single-user total throughput (tests for non-linear degradation)
- **Cross-validation:** E2B degradation pattern on Air and Pro within 10% of each other

**Why these thresholds:** At 2 users, 50% per-user means linear sharing (expected for bandwidth-bound). Below 50% indicates overhead costs. At 4 users, we accept more degradation but need total throughput to hold — if it drops below 80%, something non-linear is happening (KV cache pressure, scheduling overhead). TTFT limits ensure interactive use remains responsive.

### 3.3 Quality under quantization (Q)

Compare Q4 vs Q8 output quality on the same tasks.

| Test ID | Model | Quant | Tasks |
|---------|-------|-------|-------|
| Q-01 | Gemma4-26B Q4 | 4.5 bits | All 7 compound tasks |
| Q-02 | Gemma4-26B Q8 | 8 bits | All 7 compound tasks |

Judge both with the same dual-judge pipeline.

**Pass criteria:** Q4 average score within 0.2 of Q8 average score. If Q8 is materially better, recalculate RAM budgets (Q8 uses 2x memory).

### 3.4 Sustained load test (S)

Run the full benchmark suite continuously for 4 hours. Monitor for:

| Metric | Threshold |
|--------|-----------|
| Ollama crashes or restarts | 0 |
| Thermal throttling (tok/s drops >20% vs start) | < 10% of run time |
| Memory pressure (swap usage) | < 1 GB swap |
| Failed inference calls | < 2% |

**Pass criteria:** All thresholds met. Hardware must be reliable for unattended operation.

### 3.5 Orchestration replication (O)

Re-run the orch-v1 compound tasks on the rental hardware to validate that proxy results hold.

| Test ID | Strategy | Model | Expected score |
|---------|----------|-------|---------------|
| O-01 | Fully-local | Gemma4-26B Q4 | >= 1.70/2.0 |
| O-02 | Hybrid | Opus + Gemma4-26B Q4 | >= 1.85/2.0 |

**Pass criteria:** Scores within 0.15 of M4 Air results. Larger delta means quantization or hardware differences affect quality more than expected.

---

## 4. Economic validation (E)

### 4.1 Billing data check

Pull actual API spend from OpenRouter dashboard for the last 3 months.

| Metric | How to measure |
|--------|---------------|
| Actual tokens/month | OpenRouter usage dashboard |
| Actual spend/month (SEK) | OpenRouter billing |
| Token split by model tier | Group by model: Opus, Sonnet, Haiku, other |
| Fraction that would route local | Apply prompt classifier to actual API calls, weight by token volume |

**Pass criteria:** At least 40% of actual token spend (by SEK, not by count) would be displaced by models that pass the throughput test. Below 40%, the Sonnet displacement thesis doesn't hold at actual usage patterns.

**Why 40%:** The "1 hour/day to break even" calculation assumed nearly all local tokens displace Sonnet-tier pricing. If the actual mix is heavier on cheap models or Haiku-tier calls, the displacement value per token drops. 40% of spend ensures the hardware cost (~1,211 SEK/month) is covered by displaced API calls even with a conservative margin.

### 4.2 Subscription math formalization

Implement the subscription-downgrade model in `src/analysis/cost.ts`:

```
Input: N users, current MAX tier, target Pro tier, hardware cost
Output: monthly saving, break-even months, 3-year savings
Sensitivity: vary N (1-4), vary MAX tier ($100/$200), vary throughput efficiency (60-100%)
```

**Pass criteria:** The formalized model produces the same numbers as the conversational estimates (25mo / 11mo / 7mo), confirming they're correct. If they diverge, investigate and fix.

### 4.3 Operator time estimate

During the rental period, track:
- Hours spent on setup, configuration, troubleshooting
- Number of Ollama restarts or interventions needed
- Model load/unload operations
- Any manual fixes required

**Pass criteria:** Operator time < 4 hours/week after initial setup. Above 4 hours/week, add this as a cost line item at the user's hourly rate.

---

## 5. Decision matrix

All tests must pass their individual criteria. The final decision uses a weighted gate:

| Gate | Weight | Criteria | Rationale |
|------|--------|----------|-----------|
| Throughput | 25% | T tests pass (measured >= 70% of estimated) | Foundation for all capacity claims |
| Concurrency | 30% | C tests pass (2-user at 50%, 4-user at 30%) | Co-op is the strongest financial case |
| Quality | 15% | O tests pass (within 0.15 of proxy scores) | Quality must hold on real hardware |
| Economics | 20% | E-1 passes (>= 40% spend displacement) | Must actually save money |
| Reliability | 10% | S test passes (stable for 4 hours) | Must work unattended |

**Overall pass:** Weighted score >= 80% (i.e., can fail one minor gate if the rest are strong).

**If overall pass:** Buy the 128GB Mac Studio. The evidence chain is complete.

**If overall fail:**
- If only concurrency fails: buy for single-user heavy API use only (no co-op pitch)
- If throughput fails: recalculate all economics with measured numbers, re-evaluate
- If economics fails: do not buy — the displacement thesis doesn't hold at actual usage
- If quality fails: investigate quantization; consider Q8 or different models
- If reliability fails: investigate Ollama stability; may need alternative serving stack

---

## 6. Timeline

| Day | Activity | Machine |
|-----|----------|---------|
| 1 (evening) | Run C-A1, C-A2 (Air concurrency tests) | Air M4 32GB |
| 1 (evening) | Run C-P1 (Pro concurrency tests) | Pro M1 16GB |
| 2 | Run Q-01, Q-02 (Q4 vs Q8 quality) | Air M4 32GB |
| 2 | Run S test (sustained 4-hour load) | Air M4 32GB |
| 2-3 | Pull billing data, run economic validation E | Any |
| 3 | Analyze results, cross-validate, write report, go/no-go | Any |

**Total cost of evaluation:** ~500 SEK (OpenRouter API for judging Q4/Q8 runs). No rental needed.

**Cost of being wrong:** 40,000 SEK hardware + integration effort if it doesn't work out, minus ~25,000 SEK resale = ~15,000 SEK net loss. The 500 SEK evaluation is cheap insurance against a 15,000 SEK mistake.

---

## 7. Out of scope for this gate

These are real gaps but not blockers for the purchase decision:

- **Agentic multi-turn evaluation** — requires judge contract redesign (per previous debate). Important for Hugin routing policy but not for the hardware gate.
- **Pi benchmarks** — nice-to-have for Q4 (Pi offload) but doesn't affect the Mac Studio decision.
- **M5 vs M4 comparison** — M5 doesn't exist yet. Buy M4 now if data justifies it; M5 is a future upgrade path.
- **Production Hugin routing policy** — design work that comes after hardware is validated, not before.
