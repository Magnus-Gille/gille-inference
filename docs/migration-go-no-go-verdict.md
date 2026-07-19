# Migration GO/NO-GO — Verdict (A–E synthesis)

**Status:** FINAL (2026-06-25). All gates measured: A–D, plus Gate E across all four arms
(A0 frontier reference + A1/A2/A3 local) and the E1–E6 verdict. E5 (judge) is moot — no arm
was E5-pivotal (none cleared E1–E4(+E6 for A3)), so Gate E is a deterministic FAIL.

Companion to `docs/gate-de-evaluation-plan.md` (the plan) — this is the result.

> **Terminology note (2026-07-11):** this report predates the house vocabulary. "Orchestrator" or
> "brain" below means the human-facing **L1 Conductor**, not Hugin. The result is now a foundation of
> the canonical [`architecture.md`](./architecture.md): S1-Hybrid is the steady state; S2 is a
> future option to re-test, not an inevitable target.

---

## TL;DR

**Recommend S1-Hybrid (frontier brain + local leaf execution) as the steady state. S2
(local brain) is NOT yet justified — but the gap is narrower than expected.**

- **S1 is GO**: Gates A + B + C clear; D clears on the `pi` harness. The financial prize
  (~90% of tokens live in leaf sub-tasks) is already capturable locally.
- **S2 is NO-GO (first pass)**: Gate E — no local-brain arm clears E1–E5(+E6). The
  *agentic* local brain (a2) collapses (under-reads) on every retrieval task; the
  *deterministic* local brain (a1) doesn't collapse and answers nearly as well as the
  frontier, but misses on the plan-coverage metric (E3).

The surprise: on raw **answer correctness**, the local arms (13/20) come within one task of
the frontier Opus reference (14/20). The brain-seat failure is not "local can't answer" —
it's **"local can't reliably hold the orchestration loop"** (collapse), exactly the standing
finding, now measured rather than assumed.

---

## The three states (recap)

| | Orchestrator (brain) | Leaf execution | Harness |
|---|---|---|---|
| **S0 — Baseline** | Frontier (Claude) | Frontier | Claude Code |
| **S1 — Hybrid** | Frontier | **Local (M5)** | Claude Code or OSS |
| **S2 — Experimental local-L1 option** | **Local (M5)** | **Local (M5)** | **OSS** |

Go to S1: A + B + C. Go to S2: A + B + C + D + E.

---

## Gate-by-gate results

| Gate | Question | Result | Verdict |
|---|---|---|---|
| **A** (T1) | Is local leaf execution real? | Leaf types viable locally; frontier floor ~1.1% (sql only — 0% of real usage) | ✅ PASS |
| **B** (T2–T4) | Is the router trustworthy? | Routing accuracy 96.9%, gap recall 100% (sql never leaks local) | ✅ PASS |
| **C** (T9) | Does serving hold under load? | mellum 120.9 / 80b 60.0 tok/s; TTFT@4 p50 299ms; 4h soak 23,667 reqs / 0 failures / ≥55 tok/s | ✅ PASS (hardware KEEP) |
| **D** (T6) | Is an OSS harness viable? | `pi` 10/10, `aider` 6/10 deterministic agentic-coding tasks → pi clears the bar | ✅ PASS (on pi) |
| **E** (T5) | Can a *local* model be the brain? | No arm cleared E1–E5(+E6); a2 collapses, a1/a3 miss plan-coverage, a3 never escalates gaps | ❌ **NO-GO** |

---

## Gate E — local-as-orchestrator bake-off (the S2 decider)

### Method
Four arms over **20 gold tasks** (D1 FRAMES-oracle retrieval / D2 feature-decomp gated by
real `tsc`+`tsx` / D3 pipeline top-3 / D4 sql-gap recovery), all sharing one
`plan → delegate → integrate` loop with `orchestrator.delegate()` as the **constant local
leaf substrate**. Only the brain (and A3's advisor) changes:

- **A0** — frontier brain (`anthropic/claude-opus-4-5`) — the reference ceiling. _$0.67._
- **A1** — local deterministic brain (`qwen3-coder-next-80b`). Free.
- **A2** — local *agentic* brain (`runAgentResearch` on D1; generic loop elsewhere). Free.
- **A3** — local brain + frontier **advisor**, capped at `--advisor-k 3` calls/task. _The
  only arm that tests E6._

Scoring is a deterministic Tier-1 trust anchor (`scripts/gate-e-score.ts`); E1–E6 applied by
`scripts/gate-e-verdict.ts` via the new `scripts/gate-e-apply-verdict.ts` CLI. (E5's blind
judge is the only model-graded residual — see "Open issues".)

### Results

| Arm | Answer | E1 ≥A0−0.10 | E2 zero-collapse | E3 cov≥0.85 | E4 gap/over-esc | E6 share≤25% | Verdict |
|---|---|---|---|---|---|---|---|
| **A0** ref | 14/20 (0.70) | — | 0 collapses | mean 0.81 (min 0.25) | gap recall 1 | — | reference |
| **A1** local-det | 13/20 (0.65) | ✅ | ✅ **0** | ❌ 0.79 (min 0.25 D3-05) | ✅ recall 1, over-esc 0.066 | n/a | **FAIL (E3)** |
| **A2** local-agentic | 13/20 (0.65) | ✅ | ❌ **5** (all D1 under-read) | ❌ 0.56 | ✅ recall 1, over-esc 0.095 | n/a | **FAIL (E2)** |
| **A3** local+advisor | 12/20 (0.60) | ✅ | ✅ **0** | ❌ 0.78 (min 0.25) | ❌ **recall 0** (gaps never escalated) | ✅ 0 tok | **FAIL (E3, E4)** |

(E5 judge: **moot** — no arm cleared E1–E4(+E6 for A3), so the judge could not change any verdict; not run.)

### Key findings

1. **The discriminator is E2 (collapse), not raw answer rate.** Local answer correctness
   (13/20) is within one task of frontier (14/20). What separates the arms is whether the
   brain holds the loop: the agentic a2 **under-reads and collapses on all 5 D1**; the
   deterministic a1 never collapses. "Local can't orchestrate" = "local can't reliably hold
   context," not "local can't answer."

2. **E3 (plan coverage) is a weak discriminator as measured.** It keyword-matches plan text
   against required steps — and **A0 itself fails it** (mean 0.79 < 0.85; D3-05 min 0.25
   even for Opus). So a1's E3 "failure" partly reflects plan-vocabulary mismatch, not a
   planning gap. _Follow-up: give `planCoverage` the leaf-taskType robustness already added
   to `stageChecklistCovered` (PR #85)._

3. **A0 reference is clean at 14/20, 0 collapses** after fixing a harness parser bug
   (`parsePlan` truncated Opus's plan when a ` ```ts ` fence appeared inside a JSON string
   value — local models never triggered it). D2-03 is now a genuine tsGate answer-fail, not
   an error-collapse.

4. **The Advisor pattern (A3) never engaged.** A3's frontier-token spend was **zero** — the
   local brain answered D4's sql tasks locally and *never recognised them as gaps to escalate*
   (gap recall 0 → E4 FAIL), even though it happened to get the D4 answers right. This is a
   sharper failure than "lazy escalation": the local brain **doesn't know what it doesn't
   know**, so the on-demand-advisor design can't fire. E6 "passes" (0 ≤ 25%) only *because*
   it never escalated; E4 is what catches the real failure. (Contrast A1, where the
   deterministic leaf substrate force-escalates sql via the routing table → E4 PASS.)

### Verdict

**Gate E FAILS on all four arms → S2 is a NO-GO.** No local-brain arm clears the required
criteria, all on deterministic grounds: a2 collapses (E2); a1 and a3 miss plan-coverage (E3);
a3 additionally never escalates gaps (E4). No arm was E5-pivotal, so the blind judge could not
change any verdict and was not run. This does **not** block S1 — it blocks only S2. The plan's
expected first-pass outcome ("local can't *independently* orchestrate; frontier stays the
brain") holds, now measured across the frontier reference + three local configurations.

---

## Recommendation

**Stay S1-Hybrid.** Keep the M5 for leaf execution + serving (Gates A/B/C/D justify it); keep
the frontier model in the brain seat. The S2 way-forward is the plan's **orchestration-context
pre-digest** mini-project (generalise rich-mellum-distill to shape context before the local
brain sees it) — targeted at the two real blockers surfaced here: the **E2 collapse** (agentic
under-read) and the **E4 gap-blindness** (the brain not recognising what to escalate).

---

## Open issues / follow-ups

- **E5 judge harness:** `scripts/dr-judge-hybrid.ts` is hardcoded to the 5 deep-research
  queries + `q<N>-<system>.md` filenames and cannot judge the 20 Gate E tasks. A Gate-E-shaped
  o4-mini blind judge (`scripts/gate-e-judge.ts`) + the `gate-e-apply-verdict --judge` wiring
  were built and tested this session, but **not run** (E5 was moot — no pivotal arm). They're
  ready if a future arm/iteration clears E1–E4(+E6); the cross-family Opus-sub confirmation
  would be a watched add-on then.
- **`planCoverage` vocabulary-robustness:** E3 keyword-matches plan text and even A0 "fails"
  it (D3-05 min 0.25). Give `planCoverage` the leaf-taskType robustness already added to
  `stageChecklistCovered` (PR #85) so E3 measures planning, not phrasing — it is currently a
  weak discriminator (the substantive separators were E2 and E4).
- Housekeeping: revoke the `gate-d-eval` guest key; stray `portal-stats-card.png`.
