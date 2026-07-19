<!--
  Draft blog post for issue #119.
  Status: draft, pending an owner voice pass + publish decision. Not yet published anywhere.
  Fact-checked against live-box state and repo docs on 2026-07-09. Earlier passes corrected stale
  serving-architecture claims: model count, Qwen roster, Hugin/homeserver ownership, pinning behavior,
  and swap-latency figures.
  2026-07-12: added the "you don't manage large local context — you avoid needing it" framing
  (the issue's original Angle), just before "What pinned each seat," which prior fact-check/
  scoping passes had not yet woven in. Re-verified pi 10/10 vs aider 6/10, routing accuracy
  96.9%, AUROC 0.986/0.807, and the 23,667-request soak against
  docs/migration-go-no-go-verdict.md and docs/cascade-gate-experiment-design.md — unchanged, no
  new numbers invented.
-->

> **Architecture note:** this is a narrative draft, not the normative system specification. The
> canonical current design is [`../architecture.md`](../architecture.md), including direct M5 access,
> Hugin's bounded role, trust policy, and evidence maturity.

# Local models don't know what they don't know: measurements from a home inference stack

Six months of benchmarking on a home inference box compresses into one sentence: local models can answer nearly as well as frontier models — within one task of parity on my hardest battery — but they cannot tell when they are out of their depth, and that single deficit ends up dictating the whole architecture.

I nearly missed it, because for months I was asking the wrong question. Or rather, three questions wearing one word.

## One word, three jobs

In my notes, "orchestrator" meant three different things depending on the day. Sometimes it meant the thing that talks to me — the planner that takes "do the analysis" and decomposes it into thirty sub-tasks. Sometimes it meant Hugin, the routing service that decides whether a sub-task goes to the small local model, the big one, or a frontier API. And sometimes it meant the agentic loop itself — the read-file, edit, run-tests, self-correct driver that wraps a model when a task needs tools.

So when I wrote "can a local model be the orchestrator?", I genuinely could not tell, six weeks later, which question I had been asking — and they turn out to have three different answers. One is a hard no, one is a qualified yes, and one is "it depends on the loop more than the model." Conflating them nearly steered the purchase decision wrong. "Orchestrator", bare, is now banned in the repo. In its place: three layers and one cross-cutting role.

## The stack in one line

Me → **Conductor** (plans, decomposes) → **Broker** (picks compute per sub-task) → **Runtime** (serves the call), with a **Harness** wrapped around a leaf when — and only when — the leaf is agentic.

**L1, the Conductor**, talks to the human: it plans, decomposes, and delegates. Today it's Claude Code — a frontier model in an agentic harness — and it's deliberately swappable. The Conductor doesn't serve inference; models run at L3.

**L2, the Broker**, is the routing layer, not a single magic process. Hugin is the macro-broker: it owns intake, task lifecycle, and the "which node?" decision across the fleet. When that node is the M5, the homeserver gateway becomes the micro-broker: auth, quotas, admission, the evidence-backed routing table, verifier and ledger checks, disagreement gates, and the production policy that decides whether a task is safe to run locally or should escalate. The table maps fifteen-odd task types to a serving model, to a `FRONTIER` sentinel meaning "escalate off-box", or to `UNKNOWN`. Escalation logic lives in this layer and nowhere else — the measurements below explain why.

**L3, the Runtime**, is a model on a specific piece of hardware. On the M5 — the BosGame box from the last post: Strix Halo, 128GB unified memory, ~215–256GB/s bandwidth, one serial compute stream — that's llama-swap fronting llama-server over six served chat models: a small router (Mellum2, 12B with 2.5B active, ~13GB), a mid-size general model (Qwen3-30B-Instruct), a newer mid-size Qwen candidate (Qwen3.6-35B-A3B, served non-thinking), a multimodal quality model (Gemma-4-26B-A4B), a big escalation coder (Qwen3-Coder-Next-80B at Q4, ~48GB), and a large MoE (GPT-OSS-120B) — plus a Whisper transcription model that doesn't figure in this story. That roster is deliberately not sacred: Qwen3.6 replaced the older Qwen3.5 slot, and I am likely to keep only one of the two mid-size Qwens live after more replay evidence. There is no pinning: llama-swap holds exactly one model resident at a time, every model on a 30-minute idle TTL, so the very next request for a different model pays a full swap regardless of which one "matters more." Measured this week: cold-swap costs range from ~10s (mellum) to ~51s (gpt-oss-120b) against a warm call of 0.1–0.3s — a 66–234× tax (measured per-sample cold/warm ratio) that a single misrouted or interleaved request eats in full. But a Runtime can equally be the laptop, the Raspberry Pi, or an external API. The Broker doesn't care; a Runtime is just an endpoint that serves completions.

And the piece that took me longest to see clearly: **the Harness is a role, not a layer.** A harness — pi-harness, aider, opencode — is the ReAct driver that wraps a model for agentic work: read, edit, run, observe, repeat. It can sit at L1 (I run pi-harness directly and it delegates downward) or be attached to an L3 leaf (Hugin dispatches a coding task to pi-harness driving a local model). At the leaf, a harness appears only when the task is agentic; a classify or summarise job is a single model call, no harness anywhere.[^1]

[^1]: Related hazard: pi the coding harness and the Pi the Raspberry Pi are near-homographs. You laugh, but this caused a real mis-read — hence "pi-harness" and "the Pi", everywhere, including this post.

That's the mechanical shape. The reason it holds together is a framing I only landed on after wiring the whole thing up: **you don't manage large local context — you avoid needing it.** A leaf task arrives at the Runtime already bounded — the Conductor did the reading, the deciding-what-matters, and the deciding-what's-missing about the *larger* objective before delegating it. The Runtime executing that leaf never has to hold the shape of the whole objective or notice a gap outside its own bounded envelope — a harness on an agentic leaf can still observe, replan, and ask for task-local detail within that envelope; what it never inherits is the Conductor's job of deciding what the larger objective needs. That's exactly the job the measurements below show local models are bad at. Decomposition isn't a workaround for small context windows — it's what keeps a local model out of the one job it can't yet do.

## What pinned each seat

Naming schemes are cheap. This one earns its keep because each seat assignment is pinned by a measurement — and two of the three are negative results.

### The Conductor seat: local is a hard no — but not where you'd expect

I ran a four-arm orchestration bake-off (Gate E in my notes): 20 gold tasks — retrieval, feature decomposition gated by the TypeScript compiler, pipeline analysis, SQL gap-hunting — with a frontier reference arm and three local-brain arms, all sharing the identical delegation substrate, so only the brain varies.

Raw answer correctness was the least interesting number: frontier got 14/20, the best local arms got 13/20. Within one task. Look only at that and you'd conclude local brains are fine.

They are not fine. The agentic local arm collapsed outright on all five retrieval tasks — it under-reads, synthesises after skimming, and falls over. And the most instructive arm was the hybrid: a local brain with a capped frontier advisor it could consult when stuck. It spent zero frontier tokens across the whole battery. Not "used the advisor badly" — it never recognised a single task as escalation-worthy, including the tasks designed to be recognised as escalation-worthy (which, awkwardly, it answered correctly anyway). Its gap recall — of the tasks where the right move was to flag a knowledge gap and ask for help, the fraction where it actually did — was zero. (The third, deterministic arm failed on a plan-coverage metric whose 0.85 bar the frontier reference itself missed, scoring 0.79 — the verdict doc calls that metric a weak discriminator, so I won't lean on it.)

All three local arms failed the gate. The finding in one sentence: local models can answer nearly as well as frontier models, but they don't know what they don't know — and the Conductor seat is precisely the seat where knowing what you don't know is the job. This does not mean local models can never do bounded planning as a leaf task; my routing table can send narrow `plan-decompose` jobs local. It means I do not yet trust a local model to own the top-level human-facing seat where it has to decide what it has not seen, what to read next, and when to escalate.

### The leaf work: a qualified yes — about 93% of it

Over 57 real delegated sub-tasks pulled from my own request log, Mellum — the little 12B router model — matched frontier output on all but 4, a divergence rate of 0.07. Two independent lines corroborate it: the bake-off answer rates above, and a hard-probe battery where mellum itself passed ~28 of 29. So the offload ceiling for leaf tasks sits around nine in ten in this sample. This matters because in agentic work roughly 90% of tokens are spent on delegated sub-tasks, not on the top-level conversation — and that is exactly the slice local hardware can eat. It is a measured ceiling, not an automatic production claim: some lanes are still shadow-only until enough verifier-backed evidence accumulates.

### Escalation: cross-model disagreement, not self-confidence

Which leaves the question the Broker exists to answer: how do you know which ~7% to escalate?

The obvious signal is to ask the model how sure it is. Measured on those same 57 tasks, self-reported confidence scored AUROC 0.807 as an escalation signal (AUROC: 1.0 is a perfect discriminator, 0.5 is a coin flip — so 0.807 sounds respectable). But look at the failures: the four divergent tasks scored self-uncertainty of 0.00, 0.05, 0.05 and 0.25. On three of the four, the model reported near-zero uncertainty — confident precisely where it was wrong, the self-consistent-error mode the literature predicts. No threshold separates those three from the mass of confident-and-correct answers; to catch them you'd have to escalate nearly everything. Useless as a gate.

Cross-model disagreement is a different animal. Run the same input through a second local model and score how much the two outputs disagree: the 4 frontier-divergent cases scored 0.33–0.68; the 53 agreed cases scored roughly zero. AUROC 0.986 — near-perfect separation. Escalating the ~10.5% of tasks where the two local models disagreed caught all four cases where local output actually differed from frontier — with the honest caveat that four positives out of 57 is a small base, and divergence-from-frontier is a proxy for error, not a ground-truth label. The cost is one extra local inference: ~11 seconds when it forces a model swap on the serial GPU, ~1.3 seconds when the secondary model is resident.

There's a boundary to this instrument, and I found it the honest way — by watching it break. On the box, the fire-rate first came in at 4.5% in live shadow mode and 7.5% replaying the real chat stream offline. Then the traffic changed and the replay fire-rate jumped to 85–100% overnight. Not an offloadability collapse, and not a broken gate: the benchmark-era flood of short, verifiable leaf tasks — the regime those launch numbers were measured on — had ended, and what remained was open-ended synthesis and agentic tool-loop traffic. On that traffic, output-similarity stops being an error signal: two models paraphrasing an open-ended summary differently isn't disagreement about facts, and an agentic turn can't be meaningfully replayed outside its execution context. So the claim worth making is narrower and more useful: cross-model disagreement has held up as an escalation gate on short verifiable leaf work — small-sample evidence still, but exactly the lane local models should own first — while long-form and agentic traffic needs its error signal from verifier-backed lanes or a context-aware judge, not from output similarity. Task-type labels are what let the router keep those regimes apart, which is why label hygiene turned out to be production infrastructure rather than bookkeeping.

This signal structurally requires two models and a router between them. It cannot live inside a single Runtime, and it shouldn't live in the Conductor. It's an L2 property — which, more than anything, is why the Broker is a layer and not a config file. In production terms, this is also where the caution lives: verifier-backed lanes can route or block; broad or unverified lanes stay in shadow or escalate; and shadow evidence is not the same thing as automatic routing.

### The Runtime: the loop moved the needle more than the model

Same local model — the 80B coder — driven by two different harnesses over 10 deterministic agentic coding tasks with oracle-checked grading. pi-harness, with native tool-calling and a real read-edit-run-self-correct loop: 10/10, including a hard cross-file rename. aider, with SEARCH/REPLACE diffs and effectively single-shot attempts (each miss completed in 15–29 seconds, no feedback loop): 6/10. Identical weights, four-task swing. When people ask which local model is best for coding, the honest answer is that at this scale the harness choice moved my numbers more than any model swap I've measured.

The deep-research work rhymes with this from the other direction. Thirteen configurations of a research pipeline, blind cross-family judge, same hardware:

| Configuration | Blind-judge score /5 |
|---|---|
| Model-driven agent loop (research-tuned model drives its own search) | 2.2 — dead last |
| Code-driven pipeline, 80B synthesis | ~4.2 |
| Code-driven pipeline, 120B synthesis | 3.4 |
| Same pipeline, frontier synthesis | +0.4–0.5 over the 80B |

The agent mode reads 2–4 sources out of a corpus of 11–15 and then confidently synthesises — under-reading again. And note the 120B row: a much bigger local model made the pipeline *worse*. It writes like a frontier model; it doesn't synthesise like one. Structure beat scale, twice.

## The production scar

One war story deserves its own paragraph. Under abrupt client disconnects, the 80B model — a recurrent architecture — would wedge into a degenerate loop, streaming the same character over and over until reloaded. It's fixed now: a streaming watchdog detects the runaway repetition, aborts the response, and triggers an automatic clean reload. But it's a standing reminder that "serves benchmarks" and "survives production" are different claims.

## What this predicts for other home-inference builds

**Hybrid is the steady state, not a waypoint.** The stack that passed every gate is frontier brain plus local muscle: a frontier model holds the Conductor seat, local models execute the leaves, and a disagreement gate — measured offline, still running in shadow today — identifies the ~5–10% that should escalate on short verifiable leaf work (on open-ended and agentic traffic the gate's output-similarity signal doesn't apply, and escalation has to come from verifiers or a judge instead). The all-local configuration fails today — on under-reading under retrieval load, and on gap-blindness — and I have no measurement suggesting those particular deficits are improving fast. Plan for hybrid; treat full-local as an option you re-test, not a destination you assume.

**Buy the loop, not just the model.** The 10/10-versus-6/10 harness result and the 4.2-versus-2.2 pipeline result are the same lesson: the scaffolding around the weights is worth more than the next size up in weights. Before spending on memory for a bigger model, spend time on the harness and the pipeline. It's free, and it moved my numbers more.

**Put the escalation brain in the middle, backed by a second local model.** To be precise about what's measured: my cross-check pair was the small router against the 80B coder, and I have *not* run the experiment that trades second-model memory against a bigger primary — so "a small second model beats making the primary bigger" is an extrapolation, not a result. What is measured: self-reported confidence betrays you on exactly the errors that matter; cross-model disagreement didn't, across everything I could throw at it. The serving side held up under the two-model design too: 96.9% routing accuracy, 120 tok/s on the small model and 60 on the big one, sub-300ms median time-to-first-token at four concurrent clients, and a four-hour soak of 23,667 requests with zero failures — all on one serial compute stream. The economics follow the same split: amortized, the box lands in the same monthly bracket as a frontier subscription, but the saving is lane-specific. Verified delegated calls stop billing per token; unverified or shadow lanes do not become ROI until the volume, verifier quality, and local cost calibration are all real.

## What's still open

The Conductor-seat failure is the one I want to attack, because its shape suggests it isn't terminal: local brains fail on under-reading and gap-blindness, not on answering. The next experiment is a pre-digest stage — deterministic code compresses and structures the orchestration context before the local brain sees it, targeting the retrieval collapse and the escalation-blindness directly. If that moves the gate metrics, the seat gets re-litigated. Two smaller items: the deferred frontier-harness baseline for the coding battery (pi-harness's perfect score made it moot for the pass/fail call, but I want the number), and a bigger live sample on the disagreement gate's fire-rate before I trust the economics precisely.

The implementation is also still learning its own fleet shape. The 80B coder is not going anywhere: it is the heavy specialist, the code-loop model, and the second-opinion model in several gates. The smaller Qwen story is less settled. Qwen3.6 cleanly replaced the old Qwen3.5 slot, but a small live smoke test did not show it replacing Qwen3-30B-Instruct for general mid-size work. That is exactly the point of the architecture: the model roster is data, not doctrine. The layer boundary stays stable while the runtime lineup changes underneath it.

The mental model to carry away: human → Conductor → Broker → Runtime, with a Harness as the tool that drives a model at either end. The frontier model keeps the seat that requires knowing what it doesn't know. Everything else is increasingly local — and measurably so.
