# Experiment: Cross-Model Disagreement as a Free Escalation Gate

**Date:** 2026-06-25. **Status:** design → run. Follows the Gate E verdict (S2 NO-GO) and a
3-stream literature review. Goal: **maximize M5 leaf offload at iso-quality** (RQ6/RQ7), with
the frontier as orchestrator + escalation backstop.

## Research basis (what's established)

- **Small models cannot detect their own errors.** "Too Consistent to Detect" (Tan et al.,
  EMNLP 2025, arXiv:2505.17656): self-consistency, semantic entropy, self-knowledge probes,
  and verbalized confidence all score **≤0.5 AUROC** on *self-consistent* errors (confident +
  wrong). Kadavath 2022 (arXiv:2207.05221): self-calibration degrades sharply with model size.
  → This is exactly the Gate E E4 failure (A3's advisor never fired because the local brain
  couldn't recognise its own gaps). The Advisor pattern was structurally doomed.
- **The fix is an EXTERNAL signal.** Cheapest reliable, in order: (1) deterministic verifiers
  (free, perfect where applicable — we have `verifier.ts`); (2) **cross-model disagreement /
  perplexity (CMP)** — a *different* cheap model checks the answer in one pass: **AUROC 0.75 vs
  0.59** for self-assessment (arXiv:2603.25450, 2026), label-free, training-free, catches
  self-consistent errors. Independently ranked #1 by both the cascade and the escalation
  research streams. Agreement-Based Cascading (Kolawole 2024, arXiv:2407.02348): escalate on
  disagreement → 2–25× cost cut, training-free.
- **Pre-generation routing > post-hoc cascading** when task type is known (Bouchard 2026,
  arXiv:2605.06350) — validates our routing table, but it's hand-coded + class-level only;
  disagreement adds the missing instance-level gate.

## Hypothesis

Cross-model disagreement between two cheap **local** models (mellum vs qwen3-coder-next-80b)
predicts leaf-task failure **substantially better** than the local model's own confidence, and
yields a higher local-offload rate at iso-quality than the routing table alone.

## Design (mostly free — all local; gold answers are ground truth)

**Dataset.** A labelled leaf-task set with deterministic correctness checks, spanning easy →
hard so failures actually occur. Sources: `probes.ts` (22 probes, 14 task types, each with a
`verifier.ts` checker) + a sample of harder items (FRAMES numeric leaves, D3/D4-style). Target
~60–120 items.

**Per item (all on the M5, free):**
1. `mellum` → output → `verify` (0/1 correct) → record.
2. `qwen3-coder-next-80b` → output → `verify` (0/1) → record.
3. **Agreement signal** `G_disagree`: do the two outputs disagree? (verifier-equivalence for
   structured; normalised match / embedding for text.)
4. **Self-confidence baseline** `G_self`: ask mellum to verbalise confidence 0–1 (the signal
   the literature says fails).

**Ground truth:** the verifier pass/fail.

**Metrics.**
- `AUROC(G_disagree → "primary-local-model wrong")` vs `AUROC(G_self → wrong)`. Primary claim:
  disagreement ≫ self-confidence (research predicts self ≈ 0.5–0.6).
- **Offload frontier:** for policy "keep local unless the gate fires," plot
  (frontier-call rate) vs (final accuracy, assuming frontier is correct on escalated items).
  Compare three gates: routing-table-only (current), `G_self`, `G_disagree` — and the
  combination (verifier ∧ disagreement). Which keeps the MOST work local at iso-quality?
- Per-task-type breakdown: where disagreement helps vs where deterministic verifiers already
  suffice (so we don't add a redundant model call).

**Why this matters / decision it informs.** If disagreement is a strong free gate, it becomes
the instance-level escalation signal for the live router (`orchestrator.delegate()`): keep a
leaf local unless (a) a deterministic verifier fails, or (b) mellum & qwen disagree → escalate.
That is a concrete, research-backed upgrade to S1-Hybrid that raises the local share without
quality loss — and it's the gap-detector the local brain couldn't be.

**Cost.** ~$0 (local mellum + qwen). Optional small frontier sample only if we want to measure
real post-escalation quality rather than assume frontier-correct.

## Results — first pass (2026-06-26)

**Directional finding (holds): answer-level cross-model disagreement beats self-confidence as
an escalation gate** — AUROC 0.731 vs 0.463 (self-confidence ≈ chance, as the literature
predicts). On the standard probes the one mellum failure was confidently-wrong (selfUnc 0.00)
yet flagged by disagreement (1.0) — a textbook self-consistent error.

**But the experiment is underpowered and taught us more about METHOD than magnitude:**
- **mellum is far more capable than assumed** — it passed ~28/29 hard reasoning tasks
  (multi-step math, dates, logic, counting). Good for offload; bad for *measuring* the gate
  (almost no failures to predict). Genuine mellum failures across both batches: ~2 total.
- **Two metric bugs found by running it** (both fixed): (1) disagreement was computed on the
  full chain-of-thought, so two models agreeing on the answer but reasoning differently looked
  like disagreement (AUROC 0.35) — fixed by comparing the **extracted ANSWER**; (2) coercing
  ordinals ("2nd"→2) created false agreement — fixed with a **pure-number** guard.
- **Brittle gold verifiers taint the signal** — `strAns("2nd")` failed mellum's correct
  "ANSWER: 2"/"second place" (a verifier false-negative masquerading as a model failure).

**Conclusion:** the *signal* is sound and matches the literature, but a trustworthy measurement
needs (a) a genuinely hard / large labelled set so the primary model fails 20–40%, and (b)
**task-type-aware agreement** — compare answers the way the verifier does (numeric equality,
canonical forms, code-by-execution), not generic text/number heuristics. Toy hand-probes are
the wrong substrate.

**Sharper next experiment:** evaluate the disagreement gate on **real delegation traces / the
cartography+ledger corpus** (hundreds of (task, model, deterministic-verdict) records already
on the box), where ground truth comes from the existing downstream verifiers — no hand-authored
golds, real task distribution, enough volume for power. Then wire the winning gate into
`orchestrator.delegate()` as the instance-level escalation signal.

## Results — POWERED real-data run (2026-06-26, n=57)

Replayed 57 real owner sub-tasks (`owner_request_log`, stride-sampled) through mellum + qwen +
frontier (Opus). Ground truth = mellum diverged from frontier (proxy for "escalation changes
the answer").

- **Base divergence rate 0.07** — mellum matched frontier on ~93% of real sub-tasks (the high
  offload ceiling, confirmed a 3rd way after Gate E and the hard probes).
- **Cross-model disagreement AUROC 0.986 vs self-confidence 0.807.** Clean separation: the 4
  diverged cases scored disagreement {0.33, 0.43, 0.59, 0.68}; 53 agreed cases scored mostly
  **0.00** (frontier-identical output). On those 4 diverged tasks mellum's self-confidence was
  {0.00, 0.05, 0.05, 0.25} — i.e. **confident on 3 of 4 where it actually diverged** (the
  self-consistent-error mode, live on real usage).
- **Offload economics:** escalating only the ~**10.5%** of tasks where mellum & qwen disagree
  catches **100%** of frontier-divergent cases → keep ~90% of real work local at frontier-iso
  quality. Self-confidence as a gate needs minFrontier = 1 (useless as a threshold).

**Verdict:** cross-model disagreement is a cheap (one extra local call), real-data-validated
instance-level escalation gate that decisively beats self-confidence. **Recommend wiring it into
`orchestrator.delegate()`:** run mellum; if a second local model disagrees, escalate; else keep
local. Caveats: n=57 with 4 positives (wide CI); divergence-from-frontier is a proxy not a
correctness oracle; some agreed cases may be self-experiment traffic. Cleaner follow-up =
semantic/embedding agreement + a divergence-rich slice + filtered self-traffic, but the
direction + magnitude are solid enough to implement behind a flag.

## Implementation — wired into `delegate()` behind a flag (2026-06-26)

Shipped as `src/homeserver/disagreement-gate.ts` (the validated answer-comparison primitives,
moved out of the experiment script so they ARE the production code) + an integration in
`orchestrator.delegateImpl`. Config `HOMESERVER_DISAGREEMENT_GATE`:

- **`off`** (default) — behaviour-preserving; the second model never runs.
- **`shadow`** — runs the second model and RECORDS the disagreement in the ledger `notes` as a
  `gate(shadow):<model> score=.. disagree=..` line. The `escalated` flag stays **false** (shadow
  changes nothing about routing — only the note carries the would-escalate signal). This is the
  **"validate in the live ledger before default"** path the verdict called for: turn it on, let
  real owner traffic flow, then query the gate's live fire-rate before spending a frontier credit:

  ```sql
  -- shadow gate fire-rate: how often would the gate have escalated?
  -- #91 (DONE): promoted to structured gate_* columns — no more notes-regex.
  SELECT
    SUM(gate_would_escalate)                          AS would_escalate,
    COUNT(*)                                           AS gated,
    SUM(CASE WHEN gate_error IS NOT NULL THEN 1 END)  AS secondary_errors
  FROM delegations WHERE gate_mode = 'shadow';
  ```

  Or from code: `gateFireRate("shadow")` in `src/homeserver/ledger.ts` returns
  `{gated, wouldEscalate, secondaryErrors, rate}` directly (also surfaced via
  `recentDelegations()` → `GET /ledger`'s `recent` array, per-row `gateMode`/`gateScore`/
  `gateWouldEscalate`/`gateError`). The free-text `gate(shadow):<model> score=.. disagree=..`
  note is still written alongside for human-readable debugging, but is no longer the only way
  to query this.
- **`on`** — runs the second model AND escalates to frontier on disagreement.

Scope: the gate fires ONLY on the **unverified** delegation path (a deterministic verifier verdict
is authoritative and trusted instead — no wasted second call). A failed/ flaky secondary never
escalates on its own. Default secondary `qwen3-coder-next-80b`, threshold `0.3`.

**Operational caveat (ties to issue #88):** on the serial-GPU box, primary `mellum` → secondary
`qwen3-coder-next-80b` is a **model swap** per gated task. Enabling `on` box-wide would thrash the
GPU. Validate the swap cost in `shadow` first; the FIFO/lease work (#88) is the prerequisite for a
practical always-on gate.

## Live shadow measurement on the box (2026-06-26)

Deployed to the M5 (gate default-off) and ran a controlled measurement: `scripts/gate-shadow-measure.ts`
samples real owner sub-tasks from `owner_request_log` and runs them through the PRODUCTION
`delegate()` with the gate forced to `shadow`, wrapped in the `gpu run` lease (#88). Writes are
isolated to an online-backup scratch copy of `eval.db` (the live ledger is never mutated — a
measurement `outcome='error'` row would otherwise count in `getVerdict()` and nudge live routing).
Run = a 3-task pilot + an n=24 batch (27 gated rows total across both):

- **The gate fires where expected:** in the n=24 batch, 22/24 ran the gate (mellum-routed); 2 skipped
  (qwen-routed → secondary==primary, correctly inert); 0 sql escalations; 0 secondary errors.
- **Live fire-rate ≈ 4.5%** (1/22 disagree ≥ 0.3). Clean score separation: 14/22 at 0.00, a tail of
  {0.07, 0.12, 0.13, 0.13, 0.14, 0.23, 0.25}, and one `code-implement` at **0.38** crossing the
  threshold — directionally sensible (the hardest task in the slice). Lower than the experiment's
  ~10.5% but same direction; the sample is small and `extract`-dominated (the real recent traffic).
- **Shadow is truly inert:** every gated row has `escalated=0`; the signal lives only in the
  `gate(shadow):<model> score=.. disagree=..` note, queryable as designed.
- **Real cost is ~11 s per gated task** (warm mellum↔qwen swap), NOT minutes — only the first
  cold-load was ~70 s. And the gate touches ONLY `/delegate` traffic: `/v1/chat/completions` uses
  `handleChatProxy` and the MCP `ask` tool uses `runChatCompletion` — neither calls `delegate()` —
  so day-to-day usage is unaffected.

**Caveat that matters for productionising:** `/delegate` is low-traffic in normal operation (the
`ask` MCP offload uses the chat path), so the gate as wired observes little real traffic. To gate
the actual `ask`/chat sub-task stream, the gate would need to move onto `runChatCompletion` — see
the next section.

## Gating the real chat/ask stream — OFFLINE over logged traffic (2026-06-26)

A live hook in `runChatCompletion`/`handleChatProxy` was rejected on the merits: the chat path
serves LOCAL models only (no frontier escalation there), so a live gate could only ever be
observability — and running a second model per request would force a mellum↔qwen swap on the serial
GPU (the #88 thrash) for data we already have. The owner's chat/ask responses are captured in
`owner_request_log`, so `scripts/gate-chat-replay.ts` reproduces the gate's signal on the real chat
stream with ZERO serving impact: per logged request it runs ONLY the secondary model on the same
messages and scores disagreement (production `disagreementScore`/`gateDecision`) against the ACTUAL
served response. READ-ONLY on the DB, no ledger writes, no frontier spend. Because only ONE model
(qwen) runs — loaded once, reused for the whole batch — there is **no swap thrash at all**.

**Live result (n=40 real chat/ask requests, on the box, 0.8 min):**
- **Fire-rate ≈ 7.5%** (3/40 disagree ≥ 0.3) — closer to the experiment's ~10.5% than the
  /delegate run's 4.5%, on the real chat distribution. Clean separation: 30/40 at `0.00`, a tail of
  {0.10…0.43}, and one `reason-math` (served by `qwen35-a3b`) at **0.90** — a textbook hard-task
  divergence.
- **By served model:** `qwen3-30b-instruct` (the workhorse, 33/40) **0/33** — perfect agreement,
  highly offloadable; disagreements cluster on `gemma4` (2/3) and `qwen35-a3b` (1/4) — the
  reasoning/code-edit tail.
- **~1.3 s per request** (secondary warm, no swaps). Safe to schedule nightly via `gpu run`.

This is the productionised form of the chat-path gate for a serial-GPU box: continuous observability
of the disagreement rate on real `ask`/chat traffic, without touching the hot serving path.

## Follow-on experiments (if this lands)
1. Grammar-constrained decoding on local tool/plan calls → parse-rate ~100% (E3 fix; cheap win).
2. Context reorder + LLMLingua pre-digest on retrieval leaves → E2 under-read (the S2 lever).
3. Train a small RouteLLM-style router on the ledger + disagreement features.
