# Nomenclature — the layers of the home-inference stack

**Status:** house vocabulary. Use these words consistently in code, docs, commits, and
conversation. The whole point is to stop overloading "orchestrator" and "Hugin".

## Why this exists

"Orchestrator" and "Hugin" were being used for two different layers at once. `CLAUDE.md`
once said *"the orchestrator (Claude Code / Hugin)"* (the decomposer, L1) while RQ7 says
*"the orchestrator (Hugin) route tasks"* (the router, L2). Same word, two jobs — that is
the root of the confusion. This doc pins each word to exactly one layer.

## The three layers (+ one cross-cutting role)

| Layer | Role name | What it does | Concrete today |
|---|---|---|---|
| **L1** | **Conductor** | Talks to the human; plans & decomposes the task; delegates sub-tasks | Claude Code (running on a sub max ×20); swappable for another agent later |
| **L2** | **Broker** *(split: Hugin = macro, homeserver gateway = micro)* | Hugin (macro): intake, task lifecycle, which node. Homeserver gateway (micro, on-box): auth, quota, admission, evidence-gated routing, escalation | Hugin dispatcher + `gateway.ts` + `orchestrator.ts` `delegate()` + `routing-table.ts` |
| **L3** | **Runtime** (worker) | Runs the model on specific hardware | llama-swap on the M5, laptop, Pi, or external API |
| **⊥** | **Harness** | Agentic driver (ReAct read→edit→run loop). A *role*, not a layer — plugs in as L1 or as an L3 leaf | pi, aider, opencode |

The canonical purpose, authority boundaries, and request paths are in
[`architecture.md`](./architecture.md). This document owns vocabulary, not the full design.

## Flow sketch

```
YOU
 │
 ▼
(A) Conductor  ── Claude Code today (sub max ×20); swappable
 │   plans & decomposes
 │   delegates sub-tasks ▼
Broker (Hugin)  ── picks compute per task:
 │                  ├─ the M5
 │                  ├─ other home hardware (laptop, Pi)
 │                  └─ external API (OpenRouter / frontier)  ← the "FRONTIER" target
 ▼   (for jobs routed to the M5:)
Runtime on the M5  ── llama-swap loads the right model
 │
 ├─ simple task (classify / extract / summarize / draft)
 │     → ONE model call, no harness
 │
 └─ agentic task (code, multi-step with tools)
       → model + HARNESS (this is where pi lives) running the read→edit→run loop
```

That is the **durable delegated-task path**, not a requirement for every inference call. An
interactive L1/client may call the authenticated M5 gateway directly when it already owns the task
lifecycle:

```text
Conductor/client ──▶ M5 gateway ──▶ Runtime
```

## Naming rules

1. **Bare "orchestrator" is banned.** It overloads everything. Always say either
   **Conductor** (L1) or **Broker / Hugin** (L2) explicitly.
2. **Hugin = L2 only (the Broker).** Matches "task dispatcher" and RQ7's "route tasks".
   Do **not** use Hugin for the L1 decomposer — that is the **Conductor**. This is the one
   change from prior loose usage, and the most important.
3. **Harness is a role, not a layer.** pi / aider / opencode are *harnesses*. The same
   harness can sit as the Conductor (you run `pi`, it delegates) **or** as an L3 leaf (Hugin
   dispatches a coding task to pi). So "pi is best" means "best *harness*", not "best Broker".
4. **A harness only appears for *agentic* leaf tasks.** A plain classify/extract/summarize on
   the M5 is a single model call — no harness. pi shows up only when the leaf itself needs a
   tool loop (e.g. code). pi is not "the M5's harness" in general; it is "the harness for
   agentic leaf tasks on the M5".
5. **pi ≠ Pi.** The coding harness (`~/.pi/agent`) and the Raspberry Pi hardware serving
   the `control-node` role are distinct. Always write **"pi-harness"** and **"the Pi /
   control-node"** in plain text.
6. **Hugin is optional for direct inference.** Use Hugin when a bounded task needs durable
   lifecycle, macro-routing, retry, asynchronous continuation, or delivery. Do not force ordinary
   interactive MCP/OpenAI calls through Hugin merely to increase broker usage.
7. **A nested agent is still a leaf.** A harness may observe, plan, and replan inside its accepted
   task envelope. It does not inherit authority over the human's larger objective and does not
   become L1.
8. **Fallback Conductor is a role, not Hugin growing upward.** If a local or Berget-backed agent
   temporarily holds the human-facing seat during an outage, call it the fallback **Conductor**.
9. **Replaceable tenant, stable contract.** Claude Code/Codex and their models are replaceable;
   Grimnir owns the memory, authority, task, privacy, and evidence contracts by which they
   participate.

## Mental model, one line

> **You** → talk to a **Conductor** (L1) → which may delegate durable jobs to **Hugin**
> (L2) → which routes each job to the right **Runtime** (L3, own or others' hardware). A
> **Harness** like pi is the *tool that drives* a model at L1 or inside a bounded L3 leaf. For
> interactive inference, the Conductor/client may call the M5 micro-broker directly.

## Why the layering matters

Each layer swaps independently:
- Replace Claude Code with another interface (L1) without touching the Broker.
- Add new hardware (L3) without touching the Conductor.
- Swap pi for a better harness without anyone upstream noticing.

That decoupling is exactly what makes "STAY S1-Hybrid + self-improving box" sustainable:
everything from the Broker down is infrastructure you never touch manually — you only sit in
the Conductor (A).
