# BosGame M5 — home-inference architecture & model residency plan

**Status:** historical pre-arrival design, retained for decision provenance. The M5 has arrived and
the production roster, backend, measurements, and topology have evolved. Do not use this document
as the current system architecture; see [`architecture.md`](./architecture.md), the routing table,
and the dated evidence documents linked below. Private operator status is not tracked here.

Hardware anchor: **BosGame M5 — AMD Ryzen AI Max+ 395 "Strix Halo", 128 GB unified
LPDDR5X** (~215–256 GB/s; ~96 GB allocatable to the iGPU). Supersedes the earlier
Mac Studio framing (`docs/mac-studio-capacity-model.md`).

**Price anchor (2026-06-15):** the *same silicon* sells across a wide price band.
AMD's own first-party **Ryzen AI Max+ 395 Developer Platform** (128 GB LPDDR5X-8000,
Radeon 8060S, 2 TB SSD; Win11-Pro and Linux SKUs) lists at **$3,999.99** (Micro Center,
US, in-store pickup only) — identical APU / memory / iGPU to the BosGame M5 bought at
**~26,221 SEK (~$2,000–2,500 incl. VAT)**. The ~2× premium buys branding, a 2 TB SSD,
official dev support and validated firmware — **not** more usable VRAM (~96 GB either
way) or throughput (same APU → same tok/s). This confirms the buy decision: the cheaper
Strix Halo mini-PC class (BosGame M5 / Minisforum MS-S1 MAX) is the value pick for
single-user inference; the dev platform's extras don't move the inference numbers. The
listing also cross-checks our specs exactly (Ryzen AI Max+ 395, 128 GB LPDDR5X-8000,
Radeon 8060S) — no surprises.

## The constraint that drives everything

**One serial compute stream.** The single iGPU shares one memory bus, so:
- "Concurrency" is **scheduling, not parallelism** — multi-tenant serving is a
  priority queue in front of one worker, never parallel execution.
- Generation is **memory-bandwidth-bound** → **MoE-first** (only active params are
  read per token). gpt-oss-120B-class hits ~30 tok/s *because* ~5B active; a dense
  70B crawls at ~5–6 tok/s on the same box.
- **Don't fill RAM with idle models.** A second resident model adds zero throughput
  (compute is serial) — it only saves reload latency. Resident count is driven by
  switch-cost amortization, not by maxing RAM. Favor **fewer models + bigger KV/context**.

## Model residency plan

The historical roster was a curated "Top-3" set; every model was MoE with small active params.

| Slot | Model | Quant / size | Role | Validated |
|---|---|---|---|---|
| **Flagship (default)** | **Qwen3.5-35B-A3B** (3B active) | ~20–23 GB | Anchor workhorse + best coder | ✅ M4 Air n=147 |
| **Router / short-answer** | **Mellum2-12B-A2.5B-Instruct** (2.5B active) | Q8_0 ~12.9 GB | extract/classify/summarize/rewrite/qa, sub-second, no-think | ✅ 26/26 probes |
| **Quality / vision (JIT)** | **Gemma-4-26B-A4B-it** (3.8B active) | Q4 ~18 GB | multimodal + quality 2nd opinion | ✅ Air |
| **Escalation coder (arrival-gated)** | **Qwen3-Coder-Next-80B** (3B active) | Q4_K_M ~48.5 GB | hard agentic coding | ❌ never downloaded/probed |

**Flagship decision (2026-06-15):** 35B-A3B is the *default* flagship, NOT the 80B.
Rationale — the 35B is the only validated coder AND **beat the 80B in the Hugin sweep
(73.4% vs 70.6% SWE-bench)**, and it fits the Air so the whole pipeline rehearses
pre-arrival. The 80B is a ~48 GB unproven bet whose two biggest risks (tool-call
reliability in llama.cpp, real tok/s) can only be tested on the box. Download +
prove the 80B on arrival; promote only if it actually wins.

**Memory budget (≤~96 GB iGPU):** pin flagship + router (~33 GB) resident, JIT-swap
Gemma over headroom (TTL), keep the rest for KV/context. For overnight batch, prefer
**one model hot at 32K ctx with q8_0 KV** over many cramped models.

## Per-task-type routing (15 types)

Rule: smallest resident model with a frozen VIABLE verdict; escalate only on gate fail.

- **Mellum2** (sub-second): extract, classify, reason-math, summarize, rewrite,
  data-transform, regex, sql, qa-factual, translate (~78% of real prompt volume).
- **Qwen3.5-35B** (escalate to 80B): code-implement, code-review, unit-test-gen.
- **80B flagship**: code-edit, plan-decompose (then escalate plan-decompose to frontier —
  architecture/multi-file is the class-wide local weak spot, ~0.0–0.5).
- **Pre-filter (hard rule):** self-verification-spiral prompts (e.g. Swedish
  personnummer `simple-001`) FAIL across all local models → route straight to frontier.

## Serving + external access

Topology: **Cloudflare Tunnel → gateway (auth + admission + quota) → llama-swap →
llama-server**. The gateway is the only bespoke surface (owner-preempts-guest
admission is what no off-the-shelf product does on a serial single-GPU box).
Full operator/onboarding/SLA docs in [`../deploy/`](../deploy/).

- **Transport:** Cloudflare Tunnel (no open ports, TLS, edge DDoS). Rejected CF Access
  service tokens (two custom headers break "paste one Bearer key" onboarding).
- **Identity:** app-layer per-friend bearer keys (`hs_<tier>_…`, SHA-256-hashed, tier
  owner|guest, model allow-list, RPM/TPM/daily, expiry). `keys mint|rotate|list|revoke` —
  `rotate` atomically revokes + re-mints a leaked/refreshed key under a fresh alias (revoked
  aliases stay occupied because `alias` is the PRIMARY KEY, so plain revoke+re-mint fails) (#99).
- **Best-effort SLA** (published, `deploy/SLA.md`): owner always preempts; `503
  server_busy` is normal; concurrency capped; model set may change; per-key quotas;
  keys revocable. A leaked key is damage-capped (quota + no paid backend), never a bomb.

## On-arrival test plan (needs the box)

1. **Qwen3-Coder-Next-80B throughput + viability** (~48.5 GB; never run anywhere). #1.
2. **Tool-call reliability in llama.cpp** (Qwen3/Gemma4 templates — open issues
   #20809/#20198/#19647). Gates the whole agentic thesis. #2.
3. Filled-context decode at 32–64K (does the 30–45% slowdown hold? KV q8_0 vs q4 quality).
4. >56 GiB MoE throughput on Strix; ROCm vs Vulkan for prompt-heavy overnight ingest.
5. Co-residency: does flagship + 35B + Mellum2 leave workable KV headroom?

**Pre-arrival (Air, now):** promote the n=1 Mellum2 routing verdicts to frozen n≥3.

## Provenance caveat

Every quality number is M4 Air (Ollama/LM Studio) or OpenRouter hosted-proxy — **zero
measurements on Strix yet**. Throughput figures are external Strix benchmarks. Treat
this as the validated-on-arrival starting config, not a measured result.
