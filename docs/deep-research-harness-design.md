# Self-Hosted Deep Research Harness — Design Document

_Status: design / decision-grade. Author: lead architect. Date: 2026-06-20. Target repo: `gille-inference`._

## 1. Thesis and verdict

**Can a self-hosted, local-model harness match ChatGPT / Claude / Gemini / Perplexity "Deep Research"? Honest verdict: yes for the _Perplexity-class_ bar, mostly yes for the _Gemini-class_ bar, and no for the hardest _Claude-/OpenAI-class_ multi-hop questions — provided you stop trying to make a generic chat model "be" a research agent and instead let the harness carry the long-horizon intelligence.**

The decisive finding in this dossier is that the naive framing "local = worse than API" is wrong in mid-2026. The real axis is **generic local chat model vs. agentic-RL-trained local model**. HuggingFace's [smolagents reproduction](https://huggingface.co/blog/open-deep-research) with a generic model reached only ~55% GAIA; Alibaba's [Tongyi-DeepResearch-30B-A3B](https://huggingface.co/Alibaba-NLP/Tongyi-DeepResearch-30B-A3B) (Apache-2.0, 30.5B total / 3.3B active) scores **70.9 GAIA — matching/beating OpenAI's o3-deep-research** (~67–73%), and its 3.3B active params run fast on the M5's Strix Halo. The bottleneck was never local-vs-cloud; it was **agentic training**, and that is now available under Apache-2.0.

So the design philosophy holds and is reinforced: **the harness carries the intelligence, not the model.** A rigid `plan → search → read → extract → verify → synthesize` pipeline of _bounded_ local-model calls, with deterministic glue (dedup, citation enforcement, source-hierarchy ranking) in code, removes exactly the long-horizon autonomy local models are weakest at — and reserves the agentic-trained model for the few genuinely model-bound steps.

**Recommended default: a HYBRID-capable harness that ships local-first.** The everyday default is fully local on the M5 (Tongyi-DeepResearch as the brain, satisfying constraints (a)/(b)). The same harness flips to a "clever-API brain" for the planning and final-synthesis stages via a single config axis — for the rare hard question where the honest quality gap matters and sovereignty can be traded. This is detailed in §5.

The remainder of this document justifies that verdict and turns it into an integration plan against this repo.

---

## 1b. Ground-truth corrections (verified on the live M5, 2026-06-20)

Three facts checked directly against the running box (`free`, amdgpu sysfs `mem_info_*`, the `llama-swap` config, `docker`/`podman` absence) and the empirical [M5 Capability Cartography](m5-cartography-report-2026-06-18.md) **override** the dossier's hardware/deploy assumptions. They tighten, not weaken, the verdict.

1. **Memory is not "128 GB, use it all."** The BIOS dedicates **64 GiB to the iGPU (VRAM)**, leaving **64 GB system RAM** + a **30 GiB GTT** spill region (so ~94 GB is *addressable* by the iGPU, but only **~64 GB is fast dedicated VRAM**). The comfortable fast-inference budget is therefore **~64 GB**. Tongyi-DR-30B-A3B (Q8 ~32 GB / Q4 ~18 GB) and Qwen3-30B-A3B (~18 GB) fit with wide headroom. **GPT-OSS-120B (~63 GB) is marginal** — weights alone nearly fill VRAM, so its KV cache spills into the slower GTT and it contends hard with the llama-swap co-tenants and the Whisper STT endpoint. Treat the 120B synthesizer as an *optional, scheduled-last* upgrade, **not** the default — **Tongyi-DR-30B-A3B is the safe single brain.**

2. **No Docker / Podman on the box.** SearXNG's usual Docker deploy is unavailable. Order of preference for this box: (a) **Docker-free serverless search for v1** — the `ddgs`/DuckDuckGo path or Brave API needs no server at all; (b) **SearXNG from source under a Python venv + a systemd unit** (Python 3.14 is present) for the full self-hosted, $0/query path; (c) Brave API as the reliable fallback. The pluggable `SearchProvider` makes this a *config* choice, not a rebuild — so every "SearXNG (Docker…)" mention in §4b/§6e should read "SearXNG (venv+systemd) **or** a Docker-free provider."

3. **Bootstrap on the models already served — Tongyi is an upgrade, not a prerequisite.** The box already serves `mellum`, `gemma4`, `qwen3-coder-next-80b`, `qwen35-a3b`. The cartography report *measured*, on this exact box: **`mellum` = 100% on summarize/extract/classify at 138 t/s, non-thinking** — the ideal Phase-1 **distiller**; and **`qwen3-coder-next-80b` = best generalist (93%), the only model to crack the multi-constraint probe** — the Phase-1 **planner/synthesizer**. So Phase 1 runs end-to-end on existing models with zero downloads; Phase 0 (pull Tongyi-DR) is the *quality* upgrade for the plan/gap/synth roles. Also measured: **avoid `qwen35-a3b` for short bounded calls** (reasoning-budget trap — 24/96 empty) unless `max_tokens ≥ 6000`, and **never route math/synthesis to `mellum`** (compound-math 0/3).

---

## 2. The quality bar — model-bound vs. harness-bound

All four frontier products converge on the same _shape_: plan a multi-step strategy → iterate search/read/reflect over dozens of queries and **hundreds of sources** → **read full pages, not snippets** → triangulate and flag disputed claims → synthesize a long, structured, source-hierarchy-aware cited report. Run-time envelope spans 2–4 min (Perplexity, lightest) to 5–45 min (Claude, heaviest).

| Product | Model class | Loop shape | Searches/run | Duration | Citation mechanism | Benchmark |
|---|---|---|---|---|---|---|
| [OpenAI ChatGPT DR](https://openai.com/index/introducing-deep-research/) | fine-tuned o3 (RL e2e) + o3-mini summarizer | plan → search → browse → reflect/backtrack → synthesize | dozens | 5–30 min | inline, trained-in | GAIA 67.36 / HLE 26.6 |
| [Anthropic Claude Research](https://www.anthropic.com/engineering/built-multi-agent-research-system) | Opus 4 lead + parallel Sonnet 4 subagents | orchestrator → 1–10+ parallel subagents → synth → **dedicated CitationAgent** | 3–10 to 100+ | 5–45 min | separate citation pass | +90.2% vs single-agent Opus 4 |
| [Google Gemini DR](https://ai.google.dev/gemini-api/docs/interactions/deep-research) | Gemini 2.5/3 Pro | plan sub-Qs → retrieve **full pages** → synth+gap-detect → re-search (dozens) | dozens | 5–15 min | linked sources | n/a |
| [Perplexity DR](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research) | proprietary + test-time-compute | iterative search → read → reason next → refine plan | **3–5 sequential** | **2–4 min** | sources + uncertainty notes | HLE 21.1 |
| **Local target: [Tongyi-DR-30B-A3B](https://huggingface.co/Alibaba-NLP/Tongyi-DeepResearch-30B-A3B)** | open MoE 30.5B/3.3B-active, ReAct+iterative | agentic-RL-trained ReAct / heavy mode | multi-step | local-bound | harness-enforced | **GAIA 70.9** |

**Perplexity's ~3–5-search shape is the realistic v1 bar.** Claude's documented orchestrator + dedicated [CitationAgent](https://www.anthropic.com/engineering/built-multi-agent-research-system) is the most copyable _blueprint_. The core deliverable that drives the whole design is this split:

### Harness-bound (enforce in deterministic code — model-agnostic)

These do **not** need a strong brain. They are code plus bounded calls, and this is precisely where "the harness carries the intelligence" is correct:

- the `plan → search → read → extract → verify → synthesize` pipeline structure itself;
- query fan-out and sub-question decomposition (templated, bounded);
- **dedup** of sources/URLs;
- **citation enforcement** — a separate non-LLM pass mapping every claim to a source span (Claude literally runs this as a dedicated agent);
- **source-hierarchy ranking** (primary > secondary > tertiary). Note: Anthropic found agents biased toward SEO-optimized content over authoritative sources — a failure a harness must _correct in code_;
- gap-detection loop control / iteration budgets;
- reading **full pages** not snippets;
- uncertainty/disagreement surfacing as a checklist.

### Model-bound (need a genuinely capable brain — cannot be faked in glue)

- multi-step **plan quality** — decomposing a vague prompt into the _right_ sub-questions;
- **gap reasoning** — knowing _when_ coverage is sufficient vs. when to re-search;
- long-context **synthesis** into a coherent narrative across hundreds of snippets;
- **judgment** about source credibility and contradiction resolution.

These four are exactly what frontier DR gets from end-to-end agentic-RL training, not scaffolding. The design conclusion follows directly: **spend the agentic model only on the four model-bound steps; spend deterministic code (and cheap high-throughput models) on everything else.**

---

## 3. Architecture — the recommended pipeline

The pipeline is a fixed sequence of **bounded** stages. Each stage is either deterministic code or a single bounded model call against the M5 gateway. The only loop is the gap-check, with a hard iteration budget (default 3, matching [local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher)'s IterDRAG-inspired default). Long-horizon autonomy lives in **none** of the model calls — it lives in the loop controller, which is code.

```
                       ┌─────────────────────────────────────────────────────────────┐
   submit-from-        │                  DETERMINISTIC LOOP CONTROLLER                │
   anywhere            │              (code: budgets, dedup, citation gate)            │
   (Munin task) ──────▶│                                                               │
                       │   ┌──────────┐                                                │
                       │   │ 0. PLAN  │  brain call ×1  → sub-questions + query set     │
                       │   │ (model)  │  (Tongyi-DR / API brain)                        │
                       │   └────┬─────┘                                                 │
                       │        ▼                                                       │
                       │   ┌──────────┐    code: dedup URLs, drop seen, rank by tier    │
                       │   │ 1. SEARCH│◀── SearXNG (primary) ─▶ Brave (fallback)        │
                       │   │ (provider)│   search(query) → [{url,title,snippet}]        │
                       │   └────┬─────┘                                                 │
                       │        ▼                                                       │
                       │   ┌──────────┐    Trafilatura (primary) ─▶ Crawl4AI/Jina (JS)  │
                       │   │ 2. READ  │    read(url) → clean markdown  (FULL PAGE)       │
                       │   │ (fetcher)│    code: hash-dedup near-identical pages         │
                       │   └────┬─────┘                                                 │
                       │        ▼                                                       │
                       │   ┌──────────┐  bounded model call PER SOURCE (high volume)    │
                       │   │ 3. DISTIL│  Qwen3-30B-A3B → {claims[], quotes[], tier}      │
                       │   │ (model×N)│  per-source notes, NOT raw page, leave this box  │
                       │   └────┬─────┘                                                 │
                       │        ▼                                                       │
                       │   ┌──────────┐  code: cross-source claim clustering            │
                       │   │ 4.VERIFY │  + bounded model call to resolve contradictions │
                       │   │ TRIANGUL.│  → agreement / DISPUTED flag per claim           │
                       │   └────┬─────┘                                                 │
                       │        ▼                                                       │
                       │   ┌──────────┐  brain call ×1 → "what's still unknown?"         │
                       │   │5.GAP CHECK│ ── gaps? & budget left? ──┐                     │
                       │   │ (model)  │                            │ YES → back to PLAN  │
                       │   └────┬─────┘ ◀──────────────────────────┘  (new sub-queries) │
                       │        │ NO / budget exhausted                                 │
                       │        ▼                                                       │
                       │   ┌──────────┐  brain call ×1 (quality-critical)               │
                       │   │6.SYNTHES.│  GPT-OSS-120B / Tongyi / API brain               │
                       │   │ (model)  │  long sectioned report from DISTILLED notes      │
                       │   └────┬─────┘                                                 │
                       │        ▼                                                       │
                       │   ┌──────────────────────────────────────────────┐            │
                       │   │ 7. CITATION ENFORCEMENT  (deterministic pass)  │            │
                       │   │ every claim → [source_id] → span in fetched MD │            │
                       │   │ unmatched claim = FAIL → bounded re-cite call  │            │
                       │   └────┬───────────────────────────────────────────┘            │
                       │        ▼                                                       │
                       │   ┌──────────┐  bounded model call ×1                          │
                       │   │8.POPULAR │  Simon-Willison-style 1500–2500w summary         │
                       │   │ SUMMARY  │                                                 │
                       │   └────┬─────┘                                                 │
                       └────────┼──────────────────────────────────────────────────────┘
                                ▼
        detailed cited report ──▶ ~/mimir/research/<project>/report.md
        popular summary       ──▶ ~/mimir/reading/<project>.md
        index ping            ──▶ Heimdall /read  (NAS, Tailscale/LAN-only)
```

### Where deterministic code carries intelligence the model lacks

| Stage | Model does | Code does (the carried intelligence) |
|---|---|---|
| 1 SEARCH | nothing (provider call) | dedup URLs, drop already-seen, **rank candidates by source tier before fetch** |
| 2 READ | nothing (fetcher) | full-page fetch (not snippet), near-duplicate page hashing, JS-escalation policy |
| 3 DISTIL | summarize one page, extract claims+quotes, self-tag source tier | bound the call (one page in, structured JSON out); **reject malformed JSON deterministically and retry** rather than trusting the model |
| 4 VERIFY | resolve a specific contradiction when code flags one | cluster claims across sources by string/embedding similarity; **mark DISPUTED when sources disagree** (the lever that beats single-pass systems) |
| 5 GAP | "what's missing?" | enforce the iteration **budget**; the model never decides to keep going forever |
| 7 CITE | re-cite only the claims code flagged unmatched | **map every claim to a source span** by string-match over locally-fetched text; this is non-LLM and is what closes most of the citation-precision gap |

This is the heart of the thesis: the brittle long-horizon behaviors (when to stop, never dropping a source, never hallucinating a citation) are removed from the model and made structural.

---

## 4. Component choices — answering (a) OSS, (b) local models, (c) search

### 4a. The OSS framework decision: **bespoke pipeline, with STORM as the structural reference and `local-deep-researcher` as the loop reference**

The survey splits cleanly, which itself validates the thesis:

- **Agent-loop frameworks degrade hard on local models** and are the wrong base: [open_deep_research](https://github.com/langchain-ai/open_deep_research) (the repo itself warns "Most local/open models lack robust implementations" of structured-outputs + tool-calling), [smolagents ODR](https://huggingface.co/blog/open-deep-research) (documented **22-point GAIA cliff** going code-actions → JSON-actions), [dzhng/deep-research](https://github.com/dzhng/deep-research) (defaults o3-mini, reasoning-dependent).
- **Pipeline frameworks are local-friendly by construction**: [STORM](https://github.com/stanford-oval/storm) (perspective-guided Q&A → outline → write, first-class LiteLLM) and [local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher) (fixed reflect-loop, first-class Ollama).

| Project | License | Stars | Architecture | Local | Output | Decision |
|---|---|---|---|---|---|---|
| **STORM / Co-STORM** | MIT | ~28.9k | Pipeline: persona Q&A → outline → write | Yes (LiteLLM) | Long Wikipedia-style cited article | **Structural reference** — closest to the detailed-report deliverable |
| **local-deep-researcher** | MIT | ~9.2k | Bounded loop: query→search→summarize→reflect ×N | Yes (first-class) | Short MD summary | **Loop reference** — exact thesis match; TS impl exists |
| GPT-Researcher | Apache-2.0 | ~27.8k | planner→executor→publisher | Partial (Ollama community-patched) | 2000+ word report | Middle option; local quality unproven |
| open_deep_research | MIT | ~11.8k | agentic supervisor/subagents | Weak | structured report | Reject for engine; borrow report structure |
| smolagents ODR | Apache-2.0 | — | CodeAgent + text browser | Weak (22pt cliff) | 55% GAIA | Reject; reference for code-actions |
| Perplexica / Khoj / SurfSense | MIT / AGPL / Apache | ~33k/35k/— | Stateful web apps (DB+auth+UI) | Yes | conversational answers | Reject as base; borrow **SearXNG + LiteLLM + RRF** retrieval pattern |

**Recommendation: build the orchestration glue bespoke in TypeScript** to match this repo's gateway stack, using STORM's two-stage decomposition (persona/perspective-guided sub-questions → outline → write) as the structural model and local-deep-researcher's reflect-loop as the gap-check model. Rationale:

1. The owner's deliverable is a **long, sectioned, heavily-cited report** — STORM's exact target — _plus_ a popular summary, which no single framework produces.
2. Running STORM's Python pipeline behind a thin service would bolt a second runtime onto the box and a ~18-month-old upstream (last release v1.1.0, [Jan 2025](https://github.com/stanford-oval/storm/releases); LiteLLM dep is maintained but feature velocity has slowed). A bespoke TS pipeline lives _inside_ `src/homeserver/`, reuses `verifier.ts` / `ledger.ts` / the gateway client directly, and is small enough to own.
3. The pipeline is ~8 bounded stages — genuinely small. Forking a framework to make it emit two outputs and call our verifiers would be more glue than writing the loop.

**Honest caveat:** even STORM-style structure will trail frontier DR on reasoning-heavy synthesis and citation precision. The deterministic citation-enforcement + source-hierarchy passes are what close most (not all) of that gap.

### 4b. Search provider and reader — answering (c)

Adopt a **pluggable two-layer interface** so providers swap by config without touching the pipeline:

```ts
interface SearchProvider { search(query: string): Promise<{ url: string; title: string; snippet: string }[]> }
interface Reader        { read(url: string): Promise<{ markdown: string; isThin: boolean }> }
```

**SEARCH — primary: self-hosted [SearXNG](https://docs.searxng.org/dev/search_api.html)** (AGPL-3.0), Dockerized on the tailnet, JSON enabled (`search.formats: [html, json]` — it returns **403 if JSON is not explicitly enabled**), limiter on (Valkey), engine list tuned **away from Google** toward block-tolerant engines (DuckDuckGo, Brave, Startpage, Mojeek, Wikipedia). This honors constraint (a) fully at $0/query. Queried over the tailnet as `GET /search?q=...&format=json`.

**SEARCH — fallback: [Brave Search API](https://brave.com/search/api/).** It is the right fallback precisely where SearXNG is weakest: Brave runs its **own independent index** (~30B+ pages, not a Google/Bing scraper), so it does not share SearXNG's IP-block failure mode, and it returns LLM-ready snippets. **Pricing correction (verified June 2026):** Brave's old free tier is **gone** — new users now get **$5/mo metered credit (~1,000 queries) at ~$0.003–0.005/query** ([implicator.ai](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/), [costbench](https://costbench.com/software/ai-search-apis/brave-search-api/)). At a home research load (tens of queries/report) that is cents/month. The harness fails over to Brave automatically when SearXNG returns 403/empty/CAPTCHA or trips a circuit breaker. Keep **Tavily** (permanent free ~1k credits/mo, best agent formatting) as a secondary API fallback and **Exa** ($7/1k, neural index) as an optional discovery provider for hard topics. **Do NOT use Perplexity Sonar as a default** — it performs search+synthesis itself, violating constraint (b); reserve it only as an occasional verification oracle.

**READER — primary: [Trafilatura](https://trafilatura.readthedocs.io/)** (Apache-2.0, pure Python, in-process, zero tokens, fastest clean main-text extraction) for the common case (articles/docs/wiki). **Fallback when text is thin or JS is needed: [Crawl4AI](https://www.firecrawl.dev/blog/exa-alternatives)** (Apache-2.0, Playwright) or self-hosted [Jina Reader](https://github.com/jina-ai/reader) (Apache-2.0, stateless Docker). Keep hosted `r.jina.ai` (10M free tokens/key, then ~$0.05/M) as last-resort for anti-bot pages. **Avoid Firecrawl for self-hosting** — AGPL-3.0 plus a self-host build that is "not production-ready" makes it the wrong OSS choice when Trafilatura+Crawl4AI cover the same ground under Apache-2.0.

| Layer | Option | License | Independent index | LLM-ready | Cost | Role |
|---|---|---|---|---|---|---|
| SEARCH | SearXNG (self-host) | AGPL-3.0 | No (aggregator) | No | $0 | **Primary** |
| SEARCH | Brave API | Closed | **Yes** | Yes | ~$0.003–0.005/q ($5/mo credit) | **Fallback** |
| SEARCH | Tavily | Closed | No (federated) | Yes (best DX) | free ~1k/mo | Alt fallback |
| SEARCH | Exa | Closed | Yes (neural) | Yes | $7/1k | Discovery add-on |
| SEARCH | Perplexity Sonar | Closed | does its own | answer, not search | $1/M+$5–14/1k | **Avoid as default** (violates (b)) |
| READER | Trafilatura | Apache-2.0 | — | Clean MD, $0 | $0 | **Primary (static)** |
| READER | Crawl4AI | Apache-2.0 | — | Yes | $0 (browser) | JS fallback |
| READER | Jina Reader | Apache-2.0 | — | Yes | $0 self-host / 10M free | Anti-bot/last-resort |
| READER | Firecrawl | AGPL-3.0 | — | Yes | self-host not prod-ready | **Avoid** |

**Honest trade-off on (a):** a fully-OSS search layer is achievable (SearXNG) but it is the **single most fragile link** — Google/Bing actively CAPTCHA self-hosted instances. The Brave fallback is the pragmatic hedge: cheap, independent index, LLM-ready, and it removes the single point of failure **without putting reasoning in a frontier API**. The reasoning stays local; only the SERP can fall back to an API.

### 4c. Local model role assignment (constraint b) — what fits in 128 GB

The M5 is memory-bandwidth-bound (~215 GB/s real), which caps generation: 30B-A3B MoE runs fast (~55–86 t/s), dense 70B crawls (~5 t/s), 235B-class saturates the box. The design is **bounded calls to fast MoE models**, not one self-driving model.

| Role (frequency) | Model | Quant / footprint | Context | Strix Halo speed | Why |
|---|---|---|---|---|---|
| **PLANNER / gap-reasoning** (×1–4) | [Tongyi-DeepResearch-30B-A3B](https://huggingface.co/Alibaba-NLP/Tongyi-DeepResearch-30B-A3B) | Q8_0 ~32GB / Q4_K_M ~18GB | ~128K | ~70–86 t/s | **Purpose-trained for the deep-research action space.** Best GAIA/BrowseComp/FRAMES for size ([70.9/43.4/90.6](https://arxiv.org/html/2510.24701v3)). The model that "knows what deep research is." |
| **DISTILLER / per-source extractor** (×N, high volume) | [Qwen3-30B-A3B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507) | Q4_K_M ~18GB | 256K (262,144) | ~86 t/s gen, **~1140 t/s prefill** | **Prefill speed is decisive** — this call runs many times per report ingesting full pages; throughput dominates. 256K ctx swallows long docs. |
| **SYNTHESIZER + verifier** (×1–2, quality-critical) | [GPT-OSS-120B](https://www.hardware-corner.net/strix-halo-llm-optimization/) (MXFP4 native) | ~63GB + KV | 128K | ~53–56 t/s | Best local reasoning/synthesis at usable speed (MoE, near o4-mini reasoning, strong tool calls). The "big brain" you can still afford. Schedule **after** the read/extract fan-out frees RAM. |
| Tool-call reliability (alt) | [Qwen3-32B](https://pricepertoken.com/leaderboards/benchmark/bfcl-v3) dense | — | ~128K | slower (dense) | Top open BFCL-v3 (75.7) — only if function-call malformation becomes the bottleneck; otherwise deterministic glue + 30B-A3B. |
| **AVOID** | Qwen3-235B-A22B (IQ3 ~107GB) / Llama-3.3-70B dense (~5 t/s) | — | — | — | 235B saturates the box and breaks llama-swap co-tenancy + Whisper; 70B dense is ~10× too slow. |

**Single-model fallback (if you run only one brain): Tongyi-DeepResearch-30B-A3B.** It is the single best fit-for-purpose pick — fast, fits with huge headroom (leaving RAM for llama-swap co-tenancy + the Whisper STT endpoint), and uniquely trained for exactly this loop. Run it for **all** roles and accept slightly weaker final-synthesis polish. If you can spare one hot-swap slot, add GPT-OSS-120B purely for the final synthesis/verify pass — that single upgrade closes most of the visible quality gap.

All picks run under the **existing llama.cpp + llama-swap stack** (Vulkan/RADV best for token-gen, ROCm available for prefill-heavy batches). No new runtime. Register Tongyi + Qwen3-30B-A3B + GPT-OSS-120B as three hot-swap entries; only GPT-OSS-120B's ~63GB meaningfully competes with co-tenants, so schedule its pass last.

**Honest gap (model-bound):** even with the best local stack, expect visible underperformance on hard multi-hop entity resolution ([BrowseComp 43.4](https://arxiv.org/html/2510.24701v3) vs. frontier far higher), long-horizon backtracking/stop decisions, and citation/synthesis nuance over very long context. The mitigation is structural — the rigid pipeline removes precisely the autonomy these models are weakest at.

---

## 5. Decision (d) — local-on-M5 vs. clever-API vs. hybrid

**Cost is not the deciding factor.** Even pure-API one-call DR is only ~$25–50/mo at 2 runs/day — trivially below the Claude MAX (1,000–2,000 SEK/mo) and Mac Studio amortization baselines. The decision is governed by **sovereignty, latency, and quality-at-synthesis.**

| Option | $/run | Quality vs. frontier | Latency | Sovereignty | Constraint (b)? |
|---|---|---|---|---|---|
| **(1) Fully local on M5** | ~$0 (electricity $0.05–0.15) | 70–80% on bounded stages; **synthesis is the weak link** (slower, can drop/over-weight sources) | 10–20+ min single-stream; prefill-bound; llama-swap reload penalty alternating reader↔synth | **Maximal** — only the search query leaves the tailnet (and that's $0/private via SearXNG) | **Yes (default)** |
| **(2) Clever API (Perplexity/OpenAI o4-mini DR)** | ~$0.40–0.80/run | Is the frontier reference; but **black-box**, no per-stage control, can't enforce your source-hierarchy rules | 2–5 min, off-box, frees GPU | **Worst** — full query + all fetched content + report transit a US provider | **No** — frontier does the reasoning |
| **(3) Hybrid: local reads + API brain for plan/synth only** | ~$0.05–0.30/run | **85–95%** — bulk extraction local & private; hardest stages get frontier reasoning; deterministic glue closes much of the rest | 5–12 min; synthesis offload removes the slow 235B-on-serial-GPU wall | **Strong-but-not-pure** — raw pages stay local; only your own **pre-summarized notes** go to the API | **Mostly** — route synth to local for full (b); API-synth is the explicit opt-in upgrade |

**Cheap API brains (hybrid):** the two model-bound stages are tiny in tokens — PLAN (~3–8K) and SYNTHESIS (~15–40K of pre-summarized notes in, ~3–5K out). So a strong brain costs **cents**: [Gemini 2.5 Flash](https://www.cloudzero.com/blog/claude-api-pricing/) synthesis ~$0.01–0.03/run, Claude Haiku 4.5 ~$0.03–0.07, Claude Sonnet 4.6 ~$0.10–0.25. Batch API is 50% cheaper; prompt caching cuts cached input 90%.

### Recommendation: ship **local-first as the default**, with a pluggable "brain" so the same harness runs local-only OR hybrid by config.

This honors the owner's stated local-first constraint (b) literally — **the shipped default puts no reasoning in a frontier API** — while telling the truth about where local hurts and giving a one-flag escape hatch.

- **Why not pure-API as default:** violates (b) outright, is a black box you cannot wrap with your own citation/source-hierarchy rules, and sends every query + every page + the full report to a US provider — the opposite of why the home setup exists. Cost ($0.40–0.80) is not the objection; control is.
- **Why hybrid is the _capability_ the harness must have:** the M5's serial GPU makes synthesis the wall (235B prefills ~144 t/s, gens ~5 t/s; a 30–40K-token synthesis is minutes of prefill before a slow trickle), and synthesis is exactly where local models most visibly lag. Hybrid keeps the ~90% token bulk (fetch/summarize/extract/dedup/verify) **local and private** and spends cents to put a frontier brain on _only_ plan + synthesis — and because the synthesizer receives only your pre-summarized notes (not raw pages), the privacy exposure is small and tunable.

### Pluggable-brain design (single config axis, cheapest → best)

The harness has one `brain` setting per stage. Because every model call already routes through the M5 gateway's OpenAI-compatible client, "use an API brain" is just a different `baseURL`/`model` for the PLAN and SYNTHESIS stages — no pipeline change.

```
DEFAULT (sovereign) ──────────────────────────────────────────▶ best in-hybrid quality
SearXNG + Tongyi-local-synth     (pure local, sovereign, slow synthesis)   ← SHIPPED DEFAULT
SearXNG + Gemini-Flash-synth     (~$0.01–0.03/run, off-box, fast)
Brave   + Haiku-4.5-synth        (~$0.07/run, recommended hybrid default)
Brave   + Sonnet-4.6-synth       (~$0.25/run, best in-hybrid synthesis)
──────────────────────────────── escape hatch ────────────────────────────────
one-off high-stakes:  call Perplexity/OpenAI DR directly, LABELLED non-sovereign
```

A `SENSITIVE` flag on a run forces **every** stage local (full sovereignty, accept the synthesis-quality dip). The privacy line is enforceable: the distill prompt (stage 3) produces abstracted notes, so the API-synth path never sees raw PII-bearing page text — add an explicit redaction instruction to that prompt if a run mixes sensitive material.

---

## 6. Integration plan against THIS repo

The harness lives **inside** `src/homeserver/` as bespoke TypeScript and reuses the existing gateway, ledger, verifiers, and config. It is co-located on the M5 with llama-swap to eliminate network latency on the read/extract/verify loop.

### 6a. New modules

| File | Responsibility |
|---|---|
| `src/homeserver/deep-research.ts` | Core harness: the 8-stage `plan→search→read→distill→verify→gap→synth→cite` pipeline + popular-summary pass. Pure orchestration; all model calls go through the gateway client. |
| `src/homeserver/deep-research-config.ts` | `DeepResearchConfig` (env-driven, mirrors `config.ts`): `RESEARCH_PLANNER_MODEL`, `RESEARCH_DISTILL_MODEL`, `RESEARCH_SYNTH_MODEL`, `RESEARCH_BRAIN` (`local`/`hybrid`), `SEARCH_PROVIDER` (`searxng`/`brave`/`tavily`/`ddgs`), `SEARCH_FALLBACK_PROVIDER`, `SEARCH_API_KEY`, `DDGS_PYTHON`, `DDGS_SCRIPT` (relative → resolved against repo root), `READER_PROVIDER`, `RESEARCH_MAX_ITERS` (default 3), `RESEARCH_CITATION_THRESHOLD` (0.8), `RESEARCH_REPORT_SENTENCE_THRESHOLD` (0.45, Phase-2), `MIMIR_NAS_PATH`, `RESEARCH_OUTPUT_DIR`. **Synthesis-quality knobs (2026-06-21 study, all default-off):** `RESEARCH_SYNTH_STRATEGY` (`oneshot`/`reground` — reground is the validated citation win), `RESEARCH_SYNTH_REPAIR_ROUNDS` (1), `RESEARCH_SYNTH_ATOMIC` (false — citation-vs-readability trade-off), per-role `RESEARCH_{PLANNER,DISTILL,SYNTH}_TEMP` (0) + `RESEARCH_{PLANNER,DISTILL,SYNTH}_MIN_TOKENS` (0; raise for reasoning synth). See `docs/deep-research-improvements-2026-06-21.md`. |
| `src/homeserver/search-provider.ts` | Pluggable `SearchProvider` interface; `SearxngProvider` (primary) + `BraveProvider`/`TavilyProvider` (fallback) behind a circuit breaker. |
| `src/homeserver/reader.ts` | Pluggable `Reader` interface; Trafilatura (shell to the Python lib or a tiny sidecar) primary, Crawl4AI/Jina fallback on thin/JS pages; full-page markdown + near-duplicate hashing. |
| `src/homeserver/citation-verifier.ts` | **Deterministic** claim→source-span mapping (string-match over fetched markdown). Builds on `verifier.ts` predicates; exports a `citationsResolved()` verifier (every `[source_id]` claim must match a span). |
| `src/homeserver/deep-research-cli.ts` | CLI driver: `submit`, `status`, `fetch` — callable headless from Hugin over SSH. |

### 6b. Reuse (do NOT reimplement)

- **`verifier.ts`** — `answerIs()`, `containsAll()`, `matches()`, `jsonValid()`, `nonEmpty()`, `predicate()`, `all()` for the distill-JSON gate and the citation pass. `jsonValid()` rejects malformed per-source extraction _deterministically_ (the "reject + retry, don't trust" rule in §3).
- **`ledger.ts`** — `recordDelegation()` logs each sub-step `(taskType, modelId, outcome, score, verifier, errorClass)`; `shouldDelegate()` / `getVerdict()` learn which models reliably do `search-query` / `claim-verify` / `synthesis` and freeze poor performers (3 fails + 0 passes → not_viable). The harness inherits auto-learning for free.
- **`taxonomy.ts`** — add task types to `TASK_TYPES`: `research-plan`, `source-distill`, `claim-verify`, `gap-check`, `synthesis`. `classifyTask()` keyword-heuristic extends cleanly.
- **Gateway client** — instantiate one `OpenAI` SDK pointed at `HOMESERVER_GATEWAY_URL` (default `http://127.0.0.1:8080/v1`) with the bearer key, exactly as `src/runner/lmstudio-client.ts` does. Every model call then flows the metered `/v1/chat/completions` path and hits the same ledger + quota + admission controls — **no auth/billing reimplementation**. (For hybrid, the PLAN/SYNTH stages get a second client with an API `baseURL`.)
- **`config.ts`** — follow the `loadConfig()` → `HomeserverConfig` env-var pattern.
- **`catalogue.ts`** — `warmCatalogue()` at startup + cached `canonicalizeModelTrusted()` to list available research models for the `/research/models` endpoint without hot-path REST calls.
- **`admission.ts` / `quota.ts`** — a research run is a long sequence of metered calls; owner-preempts-guest admission already protects the serial GPU. Run research under the owner key so it yields to guest chat.

### 6c. Gateway endpoints (submission path)

Add two routes to `src/homeserver/gateway.ts`, inserted **after the `/ledger` route (line 2264) and before `/metrics` (line 2274)**, using the same principal resolver + allow-list checks as the existing routes:

```
POST /research              body { query, depth?: 'quick'|'thorough', brain?: 'local'|'hybrid', sensitive?: bool }
                            → { jobId, status: 'queued' }      (queues to a bounded in-memory job queue)
GET  /research/{jobId}/status → { jobId, status: 'queued'|'running'|'done'|'error', progress?, reportPath? }
GET  /research/models       → trusted research model set (from catalogue.ts)
```

**Submission from anywhere (unchanged UX).** The existing `research-spike` skill writes a Munin task; **Hugin** (Pi 5, polls Munin every 30s) currently spawns a frontier-Claude runtime. Re-point that runtime to the M5: Hugin runs `ssh m5 'tsx src/homeserver/deep-research-cli.ts submit --query "..." --depth thorough'`, which `POST`s to `http://localhost:8080/research`, gets a `jobId`, and Hugin polls `GET /research/{jobId}/status` to completion, then marks the Munin task done.

**Simpler alternative (recommended for v1):** skip the Pi intermediary — a **systemd timer on the M5** consumes a Munin research queue directly (file-poll or Munin MCP) overnight. The Pi 5 (8 GB) is fine for dispatch but should not host the heavy loop; the loop runs entirely on the M5 either way. Keep the gateway `/research` endpoint as the canonical trigger so it is callable from any environment on the tailnet.

### 6d. Output path (unchanged) and portal sync

After synthesis + citation enforcement + popular summary, write locally then rsync to the NAS:

- detailed cited report → `data/research/<jobId>/report.md` → `~/mimir/research/<project>/`
- popular 1500–2500-word summary → `~/mimir/reading/<project>.md`
- ping Heimdall's index so the `/read` page (NAS, Tailscale/LAN-only) surfaces it

`rsync -az --mkdir m5:/srv/gille-inference/data/research/ → NAS:/home/inference/mimir/research/`. This is the exact convention the current research-spike flow uses, so Heimdall needs no change.

**Per CLAUDE.md: update `src/homeserver/portal.html` and `src/homeserver/README.md` in the SAME change** when the `/research` endpoint ships — add it to the "What's running" / "How to use it" docs and the README endpoint table. Portal HTML is cached in memory, so a portal edit needs `sudo systemctl restart home-gateway` (not zero-downtime).

### 6e. Deploy flow (per CLAUDE.md)

```bash
# from clean main on the laptop:
rsync -az --no-perms --omit-dir-times \
  --exclude .git --exclude node_modules --exclude data --exclude .env \
  --exclude '*.log' --exclude debate --exclude .claude --exclude dist \
  ./ m5:/srv/gille-inference/
ssh m5 'sudo systemctl restart home-gateway'   # only if gateway/server code changed
```

Separately, stand up the OSS sidecars on the M5/tailnet: **SearXNG** (Docker, JSON enabled, limiter on) and, if JS-heavy pages prove common, **Crawl4AI** (Playwright). Trafilatura is an in-process Python dependency (or a tiny local sidecar called from `reader.ts`).

---

## 7. Phased build plan

Effort: **S** = ≤1 day, **M** = 2–4 days, **L** = ≥1 week.

| Phase | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| **0. Probe the brain** | Pull Tongyi-DR-30B-A3B GGUF (Q8_0), register behind llama-swap, run `llama-bench` + a hand ReAct loop. Confirm it slots into the OpenAI-compatible tool-calling loop and measure real t/s + KV footprint at target ctx with co-tenants loaded. | **S** | Tongyi answers a 2-hop research question via the gateway; t/s and ctx measured (resolves the dossier's open questions). |
| **1. MVP end-to-end (one model, SearXNG)** | `deep-research.ts` straight-line `plan→search→read→distill→synth` (no verify/gap loop yet), single model (Tongyi), SearXNG only, Trafilatura reader. CLI `submit`. Writes one `report.md`. | **M** | One end-to-end run produces a cited report from ~10–20 real sources on a real query. |
| **2. Verify + triangulate + gap loop** | Add `citation-verifier.ts` (deterministic claim→span), cross-source claim clustering + DISPUTED flagging, gap-check stage with iteration budget (default 3). Wire `ledger.recordDelegation()` per sub-step. | **M** | Every claim resolves to a source span or is dropped; disputed claims appear in output; loop terminates on budget. |
| **3. Popular summary + Heimdall wiring** | Add the Simon-Willison-style 1500–2500-word summary pass; rsync both outputs to `~/mimir/research` + `~/mimir/reading`; Heimdall index ping. Gateway `/research` + `/research/{id}/status` routes; Munin→Hugin (or M5 systemd-timer) submission; portal.html + README update. | **M** | Submit-from-anywhere → report appears on Heimdall `/read`, matching the current research-spike UX. |
| **4. Quality fallback (escalate to API; pluggable brain)** | Wire the per-stage `brain` config axis; add Brave search fallback + circuit breaker; add Crawl4AI/Jina reader fallback; implement the `SENSITIVE`/`hybrid` flags. | **M** | Same harness runs local-only OR hybrid by config; SearXNG failure auto-fails-over to Brave. |
| **5. Validation gate** | Run 5–10 prompts through (a) pure-local, (b) Brave+Haiku hybrid, (c) Perplexity Sonar DR; judge with the repo's existing Opus + o4-mini judge harness to **quantify** the real gap (not benchmark proxies). | **L** | A measured quality-gap table per stage; decision on whether hybrid-default should replace local-default for non-sensitive runs. |

MVP is Phases 0–1. Phases 2–3 reach the keep-the-UX bar. Phase 4 delivers the pluggable brain. Phase 5 replaces this document's estimates with measured numbers.

---

## 8. Risks and honest limitations

| Risk / limitation | Where it bites | Mitigation |
|---|---|---|
| **Synthesis quality lags frontier** (structure, source prioritization, not dropping sources) | The one model-bound stage hardest to fix in code | Feed the synthesizer **distilled notes not raw pages**; enforce the outline (STORM-style) in code; offer the hybrid API-synth flag for hard runs; GPT-OSS-120B as the local "big brain." |
| **Hard multi-hop entity resolution** ([BrowseComp 43.4](https://arxiv.org/html/2510.24701v3) vs. frontier far higher) | Questions needing 5+ chained lookups | Accept the ceiling; the gap-check loop + iteration budget bounds wasted effort; escalate to API DR for genuinely hard one-offs (labelled non-sovereign). |
| **SearXNG is the most fragile link** — Google/Bing CAPTCHA self-hosted instances | Search stage, under bursty load | Tune engines away from Google (DDG/Brave/Startpage/Mojeek/Wikipedia); limiter on; **automatic Brave fallback** on 403/empty/CAPTCHA; keep query fan-out in the low tens/report. |
| **Citation hallucination** — model attributes a claim to the wrong source | Report trustworthiness | **Deterministic citation-enforcement pass** (`citation-verifier.ts`) maps every claim to a literal span; unmatched → drop or bounded re-cite. This is the single highest-value piece of glue. |
| **Local model malforms tool/JSON calls after many rounds** (4-bit degrades after multiple tool rounds) | Distill/extract stage at volume | Keep calls **bounded and single-shot**; `jsonValid()` gate + deterministic retry; the ledger freezes models that fail repeatedly. |
| **Serial GPU = no concurrency; one run blocks the box** | Latency, multi-user | Run overnight via systemd timer; owner-preempts-guest admission already yields to live chat; hybrid offloads the slow synthesis prefill off-box. |
| **llama-swap reload penalty** alternating reader ↔ synthesizer | Wall-clock | Batch all distill calls (reader model) before the single synthesis swap; schedule GPT-OSS-120B's pass last so it never co-resides with the fan-out. |
| **Upstream STORM/Tongyi drift** (STORM ~18mo since v1.1.0; Tongyi's runtime expectations unverified) | Maintenance | Bespoke TS harness owns the pipeline (no STORM runtime dependency); pin the Tongyi GGUF; Phase 0 probe de-risks the runtime format. |
| **Sovereignty leak via hybrid** | API-synth path | Default ships **fully local**; hybrid is opt-in; distill notes are abstracted (no raw pages to the API); `SENSITIVE` flag forces all-local. |

**Bottom line.** This harness will reliably hit the Perplexity-class bar and approach the Gemini-class bar for well-scoped questions, with citation discipline that may actually _exceed_ the frontier products (because it is enforced deterministically rather than trained-in and trusted). It will visibly trail Claude-/OpenAI-class DR on the hardest open-ended multi-hop research — and for those, the explicit, labelled escape hatch to an API brain is the honest answer, not a generic chat model pretending to be a research agent.

---

### Sources

- Frontier products: [OpenAI DR](https://openai.com/index/introducing-deep-research/) · [Anthropic multi-agent research](https://www.anthropic.com/engineering/built-multi-agent-research-system) · [Gemini DR](https://ai.google.dev/gemini-api/docs/interactions/deep-research) · [Perplexity DR](https://www.perplexity.ai/hub/blog/introducing-perplexity-deep-research) · [comparison](https://glasp.co/articles/deep-research-tools-compared)
- Local agentic models: [Tongyi-DeepResearch-30B-A3B](https://huggingface.co/Alibaba-NLP/Tongyi-DeepResearch-30B-A3B) · [Tongyi paper](https://arxiv.org/html/2510.24701v3) · [Qwen3-30B-A3B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-30B-A3B-Instruct-2507) · [Strix Halo perf](https://www.hardware-corner.net/strix-halo-llm-optimization/) · [BFCL-v3](https://pricepertoken.com/leaderboards/benchmark/bfcl-v3) · [Qwen3-235B](https://huggingface.co/ubergarm/Qwen3-235B-A22B-GGUF) · [smolagents ODR](https://huggingface.co/blog/open-deep-research)
- OSS frameworks: [STORM](https://github.com/stanford-oval/storm) ([releases](https://github.com/stanford-oval/storm/releases)) · [local-deep-researcher](https://github.com/langchain-ai/local-deep-researcher) · [GPT-Researcher](https://github.com/assafelovic/gpt-researcher) · [open_deep_research](https://github.com/langchain-ai/open_deep_research) · [dzhng/deep-research](https://github.com/dzhng/deep-research)
- Search & reader: [SearXNG API](https://docs.searxng.org/dev/search_api.html) · [SearXNG outgoing](https://docs.searxng.org/admin/settings/settings_outgoing.html) · [Brave API](https://brave.com/search/api/) · [Brave free-tier change](https://www.implicator.ai/brave-drops-free-search-api-tier-puts-all-developers-on-metered-billing/) · [Brave pricing](https://costbench.com/software/ai-search-apis/brave-search-api/) · [Tavily](https://docs.tavily.com/documentation/api-credits) · [Exa](https://exa.ai/docs/changelog/pricing-update) · [Trafilatura](https://trafilatura.readthedocs.io/) · [Jina Reader](https://github.com/jina-ai/reader)
- Cost model: [Perplexity Sonar DR](https://www.cloudzero.com/blog/perplexity-api-pricing/) · [OpenAI o4-mini DR](https://pricepertoken.com/pricing-page/model/openai-o4-mini-deep-research) · [Claude API pricing](https://www.cloudzero.com/blog/claude-api-pricing/) · [Tavily credits](https://docs.tavily.com/documentation/api-credits)
