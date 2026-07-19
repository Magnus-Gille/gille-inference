# Mac Studio M5 — Capacity Model

> **Historical scenario model.** This document predates the BosGame Strix Halo purchase and uses
> estimated, partly hypothetical Apple hardware. It is retained for decision provenance, not as the
> current capacity or architecture source. See [`architecture.md`](./architecture.md),
> [`bosgame-m5-architecture.md`](./bosgame-m5-architecture.md), and the measured migration verdict.

## Purpose

Decision framework for M5 Mac Studio purchase: **Pro vs Max**, **128GB vs 256GB**.
Based on real benchmark data from `gille-inference`.

---

## Hardware specs (estimated from M4 lineage)

**Note:** Mac Studio does not offer a Pro chip. Options are Max or Ultra.

| | M5 Max (128GB) | M5 Ultra (256GB) | M5 Ultra (512GB) |
|---|---|---|---|
| Memory bandwidth (est.) | ~550 GB/s | ~1100 GB/s | ~1100 GB/s |
| Usable RAM (after macOS) | ~118 GB | ~246 GB | ~500 GB |
| Relative to M4 Air (100 GB/s) | 5.5x | 11x | 11x |

> tok/s scales ~linearly with memory bandwidth for inference (memory-bound workload).
> Ultra = 2x Max dies fused, so doubles both bandwidth and max RAM.

---

## Model inventory (real sizes from ollama)

| Model | Weights | Quality (Opus) | M4 Air tok/s | Est. M5 Pro tok/s | Est. M5 Max tok/s |
|-------|---------|---------------|-------------|-------------------|-------------------|
| GPT-oss-120B (MoE 5.1B active) | 80 GB | 90% | — | ~30* | ~60* |
| Nemotron-3-Super (MoE 12B active) | 86 GB | 87% | — | ~20* | ~40* |
| Qwen3-Coder-Next (MoE 3B active) | 51 GB | 83% | — | ~38* | ~77* |
| GLM-4.7-Flash (MoE ~3B active) | 5.5 GB | 83% | 11.1 | ~31 | ~61 |
| Qwen3.5-35B-A3B (MoE 3B active) | 23 GB | TBD | 9.5 | ~26 | ~52 |
| Qwen3-14B (dense) | 9.3 GB | 75% | 5.8 | ~16 | ~32 |

*Estimated by scaling M4 Air performance (or OpenRouter times) by bandwidth ratio. Models not tested locally are rougher estimates.

---

## KV cache overhead

KV cache size depends on model architecture, context length, and number of concurrent sessions.

**Formula (approximate for Q4 models):**
```
KV cache (GB) ≈ num_layers × 2 × num_kv_heads × head_dim × context_length × sessions × 2 bytes / 1e9
```

**Simplified estimates per session:**

| Model | 8K ctx | 32K ctx | 128K ctx |
|-------|--------|---------|----------|
| GPT-oss-120B | ~1 GB | ~5 GB | ~20 GB |
| Nemotron-3-Super | ~1.5 GB | ~6 GB | ~24 GB |
| Qwen3-Coder-Next | ~0.5 GB | ~2 GB | ~8 GB |
| GLM-4.7-Flash | ~0.3 GB | ~1 GB | ~4 GB |
| Qwen3.5-35B-A3B | ~0.3 GB | ~1 GB | ~4 GB |
| Qwen3-14B | ~0.5 GB | ~2 GB | ~8 GB |

---

## Usage scenarios

### Assumptions
- 2 primary users
- Workloads: coding assistance, daily briefings (Skuld), chat, Grimnir infrastructure
- Need at least 1 "quality" model + 1 "fast utility" model loaded simultaneously
- Target: 32K context per session, 2 concurrent sessions minimum

### Scenario A: Quality + Utility combo
**GPT-oss-120B (quality) + GLM-4.7-Flash (utility)**

| Resource | 1 session each | 2 sessions each |
|----------|---------------|-----------------|
| GPT-oss weights | 80 GB | 80 GB |
| GLM-4.7 weights | 5.5 GB | 5.5 GB |
| KV cache (32K) | 6 GB | 12 GB |
| macOS | 10 GB | 10 GB |
| **Total** | **101.5 GB** | **107.5 GB** |
| Fits 128GB? | Yes (16.5 GB headroom) | Yes (10.5 GB headroom) |
| Fits 256GB? | Yes (144.5 GB headroom) | Yes (138.5 GB headroom) |

### Scenario B: Two quality models
**GPT-oss-120B + Qwen3-Coder-Next (for code-specific tasks)**

| Resource | 1 session each | 2 sessions each |
|----------|---------------|-----------------|
| GPT-oss weights | 80 GB | 80 GB |
| Qwen3-Coder-Next weights | 51 GB | 51 GB |
| KV cache (32K) | 7 GB | 14 GB |
| macOS | 10 GB | 10 GB |
| **Total** | **148 GB** | **155 GB** |
| Fits 128GB? | **NO** | **NO** |
| Fits 256GB? | Yes (98 GB headroom) | Yes (91 GB headroom) |

### Scenario C: High-concurrency utility
**Nemotron-3-Super + GLM-4.7 + Qwen3.5-35B, 2 users × 2 sessions**

| Resource | Calculation | GB |
|----------|------------|-----|
| Nemotron-3-Super weights | | 86 |
| GLM-4.7 weights | | 5.5 |
| Qwen3.5-35B weights | | 23 |
| KV cache (32K, 4 sessions split) | ~12 | 12 |
| macOS | | 10 |
| **Total** | | **136.5 GB** |
| Fits 128GB? | **NO** | |
| Fits 256GB? | Yes (109.5 GB headroom) | |

### Scenario D: 128K context (long document work)
**GPT-oss-120B, single user, 128K context**

| Resource | Calculation | GB |
|----------|------------|-----|
| GPT-oss weights | | 80 |
| KV cache (128K, 1 session) | | 20 |
| macOS | | 10 |
| **Total** | | **110 GB** |
| Fits 128GB? | Yes (8 GB headroom — tight) | |
| Fits 256GB? | Yes (136 GB headroom) | |

Add a second user or a second model and 128GB breaks.

---

## Decision matrix

| Config | Price (est.) | Scenario A | Scenario B | Scenario C | Scenario D | Verdict |
|--------|-------------|------------|------------|------------|------------|---------|
| M5 Max 128GB | $$$ | OK (tight) | NO | NO | Barely | Single quality model + utility |
| M5 Ultra 256GB | $$$$$ | Easy | Easy | Easy | Easy | Multi-model, multi-user, fast |
| M5 Ultra 512GB | $$$$$$ | Easy | Easy | Easy | Easy | Future-proof overkill |

### The key question: is Max 128GB enough?

It depends entirely on **how good the small models are for your workloads**.

If GLM-4.7-Flash (5.5GB, 83%) or Qwen3.5-35B-A3B (23GB, TBD) are "good enough":
- **Max 128GB works great.** You can load 2-3 small/medium MoE models, serve 2 users with 32K+ context, and still have headroom. The 550 GB/s bandwidth means 30-60 tok/s on these models.

If you need GPT-oss-120B (80GB, 90%) quality:
- **Max 128GB = single model only.** One quality model + one tiny utility model, short context, model swapping for anything else.
- **Ultra is the only path to concurrent large models.**

### Recommendation

**Start with M5 Max 128GB** unless benchmarks prove that small MoE models can't handle your critical workloads. The price jump to Ultra is massive, and the quality gap between 5.5GB GLM (83%) and 80GB GPT-oss (90%) may not justify 3x+ the cost.

**The benchmark suite exists to answer this question.** Keep expanding task coverage toward real Grimnir workloads (briefing generation, code review, chat) to see where small models break down.

---

## Concurrent serving — the TTFT ceiling

RAM and KV cache are not the only constraint. **Queue latency** under concurrent load is a separate, binding ceiling for interactive use.

### Measured: serialized queue model (cross-validated across chips)

Ollama serves concurrent requests **serially**, not via batched attention. Each user gets full single-user throughput — but waits in queue for prior requests to finish.

**Air M4 (32GB, 120 GB/s) — Gemma4-E2B:**
- 1 user: 93% per-user tok/s at 4 users (earlier result, 2026-04-06)

**Pro M1 (16GB, 68 GB/s) — Gemma4-E2B (2026-04-21):**

| Users | tok/s/user | Per-user degradation | p95 TTFT |
|-------|-----------|---------------------|----------|
| 1 | 50.1 | 100% (baseline) | 0.6s |
| 2 | 50.2 | 100% | 10.7s |
| 4 | 49.5 | 99% | 27.2s |

**Cross-validation:** degradation pattern is identical on M1 Pro and M4 Air → the bandwidth-sharing model holds across chip generations. Extrapolation to Mac Studio M4 Max / M5 is trustworthy for *throughput*.

### Implication: TTFT is the binding constraint, not tok/s

- Per-user tok/s holds at ~100% even at 4 concurrent users
- But p95 TTFT scales ~linearly with queue depth: ~10s per additional user ahead in the queue (at 50 tok/s with typical response lengths)
- Eval spec gates:
  - 2 users, TTFT <5s: **FAIL** (10.7s measured)
  - 4 users, TTFT <10s: **FAIL** (27.2s measured)

**Usability implication:**

| Use case | Queue latency tolerable? |
|----------|--------------------------|
| Interactive chat | Only 1 user at a time |
| Hugin sub-task delegation (async) | 3-5 users fine — sub-tasks already run in background |
| Code completion / real-time editing | 1 user only |
| Batch jobs (briefing gen, indexing) | Scales with users — zero throughput loss |

### Reliability: sustained load (2026-04-21)

Pro M1, 250-round / 37-minute continuous benchmark with Gemma4-E2B:
- 0 failures, 0 ollama restarts
- 0 thermal throttling (tok/s drift +2.8% start→end)
- Memory pressure stable

Ollama is reliable for unattended operation on Apple Silicon.

### What would change this ceiling

Batched attention (vLLM-style) would flatten TTFT across concurrent users at the cost of per-user tok/s. Ollama does not do this today; MLX-server has experimental support. If/when ollama or MLX ships batching, the "3 interactive users" scenario becomes viable on the same hardware.

---

## Architectural context: hybrid local + cloud

The Mac Studio is not meant to replace frontier models. The Grimnir architecture uses a **delegation pattern**:

- **Frontier models (Claude, Codex)** — orchestration, complex reasoning, architecture decisions, nuanced writing. Pay per-token, get Opus-level intelligence.
- **Local models (Mac Studio)** — fast worker tasks delegated by the orchestrator. Briefing generation (Skuld), memory queries (Munin), code review triage, chat/utility, structured generation.

**Implication for hardware:** Local models need to be *fast and cheap*, not *smart*. A 5.5GB model at 60 tok/s serving utility tasks is more valuable than an 80GB model at 10 tok/s trying to be a worse Claude. This strongly favors Max 128GB packed with small MoE models over Ultra with one large model.

## Open questions

1. Actual M5 bandwidth numbers (estimates above are extrapolated from M4)
2. MLX backend expansion — which models will have native MLX support by summer 2026?
3. Whether concurrent serving (vLLM-style batching) comes to ollama/MLX — would flatten the TTFT queue ceiling (see "Concurrent serving" section)
4. Qwen3.5-35B-A3B quality scores (judges pending)
5. Task-specific benchmarks for actual Grimnir workloads (briefing gen, code triage, memory summarization)
