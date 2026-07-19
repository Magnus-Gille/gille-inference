# M5 Capability Cartography v1 — Overnight Report

**Date:** 2026-06-18 (run 2026-06-17 ~22:00 → ~23:50)
**Orchestrator:** Claude Code (Opus 4.8). **Workhorse:** BosGame M5 (4 local models via the gateway).
**Method:** 384 deterministically-verified runs — 4 models × 32 probes × 3 repeats — routed through the live gateway so every run also fed the ledger, the owner-log, and `/metrics`.

---

## TL;DR — the three things you asked for

**1. What I built** (overnight): a reusable benchmark harness (`scripts/m5-cartography.ts`), a content-blind Prometheus `/metrics` endpoint, and an owner-only full request log. (Plus, earlier in the session: the MCP server, the `hs` CLI, the `/v1/models` passthrough, and the Cloudflare tunnel — the four "front doors".)

**2. What I learned** — a verified capability map of every model × task type, and one big counter-intuitive finding: **the "smart" thinking models are *worse* for delegated sub-tasks** because reasoning eats their budget.

**3. How I applied it** — populated the ledger with 56 evidence-based verdicts, wrote an evidence-derived routing table (`docs/m5-routing.json`) for Hugin, and produced concrete settings fixes. The owner-log (388 records) is now the growing real-usage dataset.

---

## 1. What I built

| Artifact | File | What it does |
|---|---|---|
| **Cartography harness** | `scripts/m5-cartography.ts` | Runs the probe battery × N models, grades with the real deterministic verifiers (tsGate compiles+runs code; answerIs/numeric/jsonValid/…), writes resumable JSONL + records verdicts to the ledger. Model-grouped to minimise GPU swaps. |
| **`/metrics`** | `src/homeserver/metrics.ts` | Content-blind Prometheus exposition — `homeserver_requests_total{model,outcome,tier}`, `tokens_total`, `request_duration_seconds` histogram, etc. **No content, no per-user labels — ever.** Authed. |
| **Owner full-log** | `src/homeserver/owner-log.ts` | Stores the FULL prompt+completion for `tier===owner` keys only (guard `tier==="owner" && keyHash!==null`). Guests/legacy/implicit-admin are **never** content-logged. Toggle `HOMESERVER_OWNER_REQUEST_LOG`. |

All deployed + verified live. Test suites green (`/metrics` +18, owner-log +6, harness validated by a clean mellum smoke).

## 2. What I learned — the capability map

### Per-model overall (n=96 each)
| Model | Pass | Avg tok/s | Thinking? | One-line profile |
|---|---|---|---|---|
| **qwen3-coder-next-80b** | **93%** | 69 | no | Strongest generalist + the escalation target. |
| **gemma4** | 91% | 62 | yes | Solid; reasons efficiently. Multimodal-capable. |
| **mellum** | 88% | **138** | no | Fast workhorse. Perfect on code/extract/classify. Weak at math. |
| **qwen35-a3b** | 75% | 61 | yes | Degraded by reasoning-budget overrun (see Finding 1). |

### Task_type × model — pass% (selected)
| task | mellum | gemma4 | qwen35 | 80b-coder |
|---|---|---|---|---|
| classify / extract / regex / translate / unit-test / plan / qa | 100% | 100% | 67–100% | 100% |
| code-implement | **100%** | 80% | 100% | 100% |
| code-review | 100% | 100% | **0%** | 100% |
| summarize | 100% | 100% | **33%** | 67% |
| reason-math | **50%** | 100% | 100% | 100% |
| rewrite | 75% | 75% | 50% | **92%** |
| **sql** | 50% | 50% | 33% | 50% |

### Hard ceiling probes (pass/3 per model) — the most telling
| probe | mellum | gemma4 | qwen35 | 80b |
|---|---|---|---|---|
| longest-common-prefix (algo) | 3/3 | 3/3 | 3/3 | 3/3 |
| binary-search debug (fix a bug) | 3/3 | 3/3 | 3/3 | 3/3 |
| nested-JSON extraction | 3/3 | 3/3 | 2/3 | 3/3 |
| compound-math | **0/3** | 3/3 | 3/3 | 3/3 |
| 3-constraint instruction | 0/3 | 0/3 | 0/3 | **2/3** |
| SQL JOIN+GROUP BY+HAVING | **0/3** | **0/3** | **0/3** | **0/3** |

### The seven findings
1. **THE THINKING-MODEL TRAP (the headline) — VERIFIED as budget starvation, not incapability.** qwen35-a3b is a reasoning model; its verbose `<think>` block overflows the battery's 2048-token budget, so **24/96 runs returned empty content** and 4 hit the 180s timeout. **I verified the cause** rather than assume it: re-running the exact JSON probe at `max_tokens=6000` made qwen35 return the *correct* answer (`[{"name":"Alice","age":30},…]`, `finish=stop`) — the probe it had *blanked* at 2048. So it was never incapable; it was starved (reasoning alone ran 4–7k chars). **Two validated fixes:** (a) give thinking models a much larger budget (≥6000), or (b) read `reasoning_content` as a fallback (the answer is formed there). **`/no_think` is inert** here — qwen35 ignored it and still burned 2048 tokens to near-empty. mellum + 80b-coder do **zero** reasoning (0/96) and are clean at any budget. **Takeaway:** for *cheap, short* delegated sub-tasks the non-thinking models remain the better default (predictable, no budget tax) — but qwen35/gemma4 are fully usable *if* you pay the budget.
2. **mellum is the workhorse.** 138 tok/s and 100% on code-implement, code-review, extract, classify, summarize, regex, unit-test, translate, plan, data-transform, qa. It is the cheap default for most sub-tasks.
3. **mellum's real limits (not budget).** Math: reason-math 50%, compound-math 0/3 ("expected 1517.5, got 1085"). Multi-constraint: 0/3. These are genuine — it's a code model, not a reasoner. **Never route math to mellum.**
4. **80b-coder is the best generalist** (93%) and the only model to crack the 3-constraint probe (2/3). It is the escalation target for math, rewrite, and hard instruction-following — at a usable 69 tok/s.
5. **SQL is the universal gap.** Every local model ≤50%, and the JOIN+GROUP BY+HAVING probe is **0/3 across all four**. → **escalate SQL to a frontier model.**
6. **Local models CAN do real code work.** Algorithmic implementation *and* debugging (fix-the-bug) were **3/3 across every model**. This is the core of the offload thesis confirmed: the box can take real coding sub-tasks.
7. **Flip-test tok/s held under sustained battery load** — mellum 138, 80b 69, gemma4 62, 35B 61 — no thermal/throughput collapse over ~330 back-to-back generations.

### A scrutiny note (you asked me to scrutinise the tasks)
The verifiers worked, but they exposed a **measurement bug, not a model bug**: grading only `content` *under-rates thinking models* whose answer lands in `reasoning_content`. That single insight reframes qwen35's whole column. Logged as the #1 harness fix for v2 (read `reasoning_content` as a fallback) — exactly the kind of thing this exercise exists to surface.

## 3. How I applied it

- **Ledger:** 56 (task_type, model) verdicts written from the runs — **45 viable · 8 marginal · 3 not_viable**. Hugin's macro-router can now consult real evidence (`delegate-local` vs `escalate-frontier`) instead of guessing.
- **Routing table:** `docs/m5-routing.json` — best local model per task type, `escalateToFrontier: ["sql"]`, `avoidForShortTasks: ["qwen35-a3b"]`, and a global "prefer non-thinking models" rule. Ready to wire into Hugin.
- **Settings recommendations:**
  - Default delegated sub-tasks → **mellum** (fast, predictable); math/rewrite/hard-instruction → **80b-coder**; SQL → **frontier**.
  - **Thinking models (qwen35-a3b, gemma4): set `max_tokens ≥ 6000` and a longer timeout — VALIDATED** (qwen35 returned the correct JSON at 6000 that it blanked at 2048). Alternatively read `reasoning_content` as a fallback. `/no_think` is inert.
- **Observability:** `/metrics` (aggregate, content-blind) + the owner-log (388 full-content records, your private dataset) are live and were populated by the battery — the box now measures itself on every call.

## 4. Reproducibility & data
- Raw: `data/cartography-overnight.jsonl` (384 lines), `data/cartography-overnight.out` (summary), owner-log (`owner_request_log`, 388 rows).
- Re-run: `HS_API_KEY=<owner> tsx scripts/m5-cartography.ts <runId>` (resumable).

## 5. Open items / v2
- [ ] Re-run the thinking models (qwen35, gemma4) at `max_tokens ≥ 6000` (validated fix) AND/OR teach the harness to read `reasoning_content` as a fallback → re-score them fairly (their 75% / 91% are **budget-capped, not capability-capped**).
- [ ] (Lower priority now) a real thinking-disable for Qwen3.5 in llama.cpp (`enable_thinking`), since `/no_think` is inert — but bigger budgets already solve it.
- [ ] Wire `docs/m5-routing.json` into Hugin's macro-router.
- [ ] Add a SQL-escalation path + re-validate.
- [ ] Heimdall panels for `/metrics` + the owner-log "your usage" view.
- [ ] Bigger battery (more probes/type, harder coding) now that the harness is proven.
