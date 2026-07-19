# Home-inference architecture

**Status:** canonical architecture for this repository

**Last updated:** 2026-07-11

## Purpose

This repository makes personally controlled inference safely useful to any replaceable AI
Conductor. It provides dependable serving, bounded delegation, privacy-aware routing, and an
evidence loop that learns which owned capabilities can replace frontier work.

It began as a hardware and model evaluation. That evaluation justified the M5 and remains useful
evidence, but the repository is now also the production inference and capability-evidence
subsystem beneath Grimnir.

The standing production architecture is **hybrid**:

- a strong, replaceable frontier **Conductor** understands the human objective;
- **Hugin** optionally accepts durable, bounded tasks and chooses a node or provider;
- the M5 gateway safely serves direct inference and performs model-level delegation;
- local models and harnesses execute the work they have actually earned through evidence;
- uncertain, unsuitable, or policy-ineligible work stays with or returns to the frontier.

## Place in Grimnir

Grimnir is the larger personal-AI substrate. Its agent, model, and interaction surface are
replaceable tenants; its memory, authority boundaries, service contracts, and sovereignty policy
are intended to persist.

This repository owns the inference and capability-evidence part of that substrate. It inherits the
broader Grimnir principles, but it is not the canonical home for the whole Grimnir manifesto.

### This repository owns

- the M5 gateway and its OpenAI-compatible and MCP serving surfaces;
- authentication, per-key quotas, owner-preempting admission, and content-safe observability;
- model selection on the M5 and explicitly selected remote backends behind the same gateway;
- verified `/delegate` execution, deterministic verifiers, calibrated local judging, and the
  authoritative node/model/task capability ledger;
- bounded local harnesses and code-driven research pipelines;
- experiments that determine which work may safely move from frontier to owned inference.

### This repository does not own

- the human-facing Conductor implementation (Claude Code and Codex today);
- Munin's unified memory service;
- Grimnir's whole-system governance and service catalogue;
- Hugin's fleet-wide task lifecycle and macro-routing;
- a universal requirement that every inference call pass through Hugin.

## Layers and authority

The house vocabulary is defined in [`nomenclature.md`](./nomenclature.md).

| Layer/role | Authority | Concrete today |
|---|---|---|
| **L1 Conductor** | Human objective, top-level planning, decomposition, final acceptance | Claude Code or Codex; replaceable |
| **L2 Hugin macro-broker** | Accepted task lifecycle, durable execution, node/provider choice, retry and result delivery | Hugin |
| **L2 M5 micro-broker** | Auth, quota, admission, model choice, verification, escalation, capability evidence | `src/homeserver/` |
| **L3 Runtime** | Perform a model call on selected hardware/provider | llama-swap, Ollama, or an external API |
| **Harness** | Observe/act/replan inside a bounded agentic task | pi-harness, OpenCode, or a code-driven pipeline |

Authority follows the task envelope. A harness may plan and replan inside an accepted leaf task,
but it does not acquire L1's authority over the human's larger objective. If a local or Berget model
temporarily takes the human-facing seat during a provider outage, it is acting as a fallback
Conductor; Hugin has not "moved upward."

## Supported request paths

Hugin is intentionally optional for interactive inference.

### Direct and interactive inference

```text
Conductor or client
        |
        v
M5 gateway -- auth / quota / admission / explicit model or node
        |
        v
Runtime -- llama-swap on M5, or an explicitly selected backend
```

Use the OpenAI-compatible API or MCP `ask` when the caller wants an interactive model response and
already owns the surrounding task lifecycle. Direct calls still create content-blind operational
measurements; owner calls may deliberately feed the owner-only learning log.

### Durable delegated task

```text
Human
  |
  v
L1 Conductor -- understands objective, creates bounded task
  |
  v
Hugin -- intake / lease / lifecycle / macro-route / retry / delivery
  |
  +--> another owned node or permitted external provider
  |
  `--> M5 gateway /delegate -- micro-route / verifier / ledger / escalation
                                 |
                                 v
                         Runtime or bounded harness
```

Use Hugin when work must survive the initiating L1 session, needs fleet/provider selection, has a
delivery lifecycle, or should continue asynchronously. Autonomous and nightly Hugin work targeting
the M5 uses `/delegate`, not raw chat, so verified execution can improve the capability ledger.

## Stable substrate and replaceable tenants

The following should be replaceable without redesigning the system:

- Claude Code, Codex, or another L1 product;
- the frontier model holding the Conductor seat;
- pi-harness, OpenCode, or another leaf harness;
- the local model roster and quantizations;
- OpenRouter, Berget, or another permitted external provider.

The stable contracts are:

- the authority and data-classification attached to a task;
- the delegated-task schema and lifecycle semantics;
- the gateway's authentication, admission, and serving contracts;
- verifier and evidence semantics;
- the authoritative capability history;
- content boundaries between owner learning and guest observability.

This is why Hugin is useful even when L1 is more capable: Hugin's value is durable, policy-aware,
measurable execution across replaceable workers, not superior general intelligence.

## Routing ownership

[`adr-004-m5-routing-ownership.md`](./adr-004-m5-routing-ownership.md) is authoritative for the
macro/micro seam.

| Question | Owner | Evidence/state |
|---|---|---|
| Should L1 delegate this part of the human objective? | L1 policy, informed by evidence | Partly manual; policy shadow traces exist |
| Which node or provider should accept the bounded task? | Hugin | Deployed; real demand remains light |
| Which model should run it on the M5? | M5 gateway | Deployed, routing-table and ledger gated |
| Can node N/model M perform task type T? | M5 capability ledger | Single authoritative capability knowledge base |
| Is the job alive, retrying, complete, cancelled, or delivered? | Hugin | Hugin task lifecycle |

Hugin may retain operational records and task outcomes. It must not maintain a competing
node/model/task capability truth. Evidence produced outside the gateway becomes capability evidence
only through the gateway's defined import/write contract.

## Trust and routing precedence

[`trust-and-routing-policy.md`](./trust-and-routing-policy.md) defines the policy in detail. Routing
uses this precedence:

1. **Authority and data eligibility:** eliminate destinations and tools the task may not use.
2. **Safety and demonstrated capability:** require appropriate evidence or escalate/stay shadow.
3. **Availability and completion probability:** choose a healthy route that can finish the task.
4. **Required quality and latency:** meet the caller's task-specific service needs.
5. **Cost:** choose the cheapest remaining capable route.

Cost never makes an ineligible disclosure acceptable. Berget is a controlled external trust zone,
not the same privacy boundary as owned hardware. OpenRouter/frontier routing is provider-dependent
external processing and must be labelled and permitted as such.

## The learning loop

The system is meant to improve from production work without converting user traffic into
uncontrolled experimentation.

```text
observe real work
      |
classify a bounded task
      |
try local in verified or shadow mode
      |
deterministic verifier or calibrated judge
      |
record node + model + task type + verifier + outcome
      |
accumulate trustworthy evidence and inspect regressions
      |
promote, retain, freeze, or remove a route
```

Evidence must state its maturity:

- **deployed/enforced** — changes live production behavior;
- **deployed/shadow** — records what would happen without changing the answer or route;
- **measured** — supported by a bounded experiment, not necessarily organic production;
- **aspirational** — intended mechanism with no adequate implementation/evidence yet.

Current state is summarized in [`vision-evidence-map.md`](./vision-evidence-map.md). In particular,
harvest and delegation policy remain shadow-first. Shadow rows are learning evidence, not proof of
production offload or financial return.

## Agentic execution

A simple classify, extract, rewrite, or short-answer task is normally one model call. A harness is
introduced only when the bounded task requires an observe-act-check loop.

The harness is part of the execution method, not an additional authority layer. Its filesystem,
network, tool, time, token, and provider permissions are inherited from the delegated task and
further constrained by its cage. See [`task-delegation-contract.md`](./task-delegation-contract.md)
and [`agentic-code-tool-design.md`](./agentic-code-tool-design.md).

## Failure and fallback

- If Hugin is unavailable, authorized clients may still use the M5 gateway directly.
- If the M5 or selected node is unavailable, Hugin may choose another policy-eligible node/provider.
- If no permitted destination can meet the task, the system returns an explicit blocked/escalated
  result; it does not silently weaken privacy policy.
- If local evidence is missing, weak, stale, or regressed, autonomous routing stays shadow or moves
  to frontier according to task policy.
- The frontier Conductor remains the production steady state until a replacement earns that seat
  through the migration gates rather than through architectural aspiration.

## Success criteria

The architecture succeeds when it:

- completes recurring bounded work with less operator attention;
- preserves task authority and privacy constraints through every nested call;
- survives L1 session closure and individual provider/node outages where policy permits;
- moves verified task volume local without lowering accepted quality;
- produces evidence usable for future routing decisions;
- keeps guest traffic content-blind and owner learning deliberate;
- makes local cost and frontier savings claims from verified volume and calibrated costs.

The original seven research questions remain useful, but the decision is no longer just whether a
piece of hardware benchmarks well. The durable question is how much real agentic work the owned
substrate can safely and measurably absorb.

## Reading order

1. This document — system purpose and ownership.
2. [`nomenclature.md`](./nomenclature.md) — house vocabulary.
3. [`task-delegation-contract.md`](./task-delegation-contract.md) — L1-to-Hugin task boundary.
4. [`trust-and-routing-policy.md`](./trust-and-routing-policy.md) — privacy and destination rules.
5. [`vision-evidence-map.md`](./vision-evidence-map.md) — claim maturity and open gaps.
6. [`adr-004-m5-routing-ownership.md`](./adr-004-m5-routing-ownership.md) — routing seam decision.
7. [`adr-005-hybrid-steady-state.md`](./adr-005-hybrid-steady-state.md) — production Conductor decision.
8. [`hugin-role-validation.md`](./hugin-role-validation.md) — dated demand/maintenance trial.
9. [`gateway-api-contract.md`](./gateway-api-contract.md) — concrete M5 API.
10. [`migration-go-no-go-verdict.md`](./migration-go-no-go-verdict.md) — measured hybrid decision.
