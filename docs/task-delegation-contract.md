# Delegated-task contract

**Status:** architecture contract; implementation coverage varies by field

**Last updated:** 2026-07-11

## Purpose

This contract defines what the L1 Conductor hands to Hugin and what authority follows a task into a
Runtime or harness. It prevents "delegate this" from becoming an implicit grant to rediscover the
human objective, read arbitrary context, use any provider, or run forever.

Hugin owns the accepted task's lifecycle. L1 retains ownership of the larger human objective and
final integration.

## Logical task envelope

Every durable delegated task should carry, explicitly or through a documented inherited default:

| Field | Meaning |
|---|---|
| `objective` | Bounded outcome, expressed independently of the larger conversation |
| `taskType` | Stable taxonomy value used for routing and evidence |
| `context` / `contextRefs` | Supplied material or approved sources the worker may read |
| `expectedOutput` | Output shape, destination, and required level of detail |
| `acceptance` | Deterministic verifier, rubric, checks, or explicit L1-review requirement |
| `sensitivity` | Data classification inherited by every nested action |
| `allowedDestinations` | Owned nodes and/or external providers permitted for this task |
| `toolPolicy` | Whether files, shell, web, MCP tools, or other side effects are permitted |
| `budget` | Time, tokens, cost, attempts, and concurrency bounds |
| `durability` | Whether the task should continue after the initiating L1 session closes |
| `idempotencyKey` | Identity used to avoid duplicate side effects or evidence |
| `delivery` | Where the result and terminal state must be reported |
| `escalation` | Conditions for returning to L1 or choosing a permitted stronger route |

Current APIs may encode only a subset. Missing fields are implementation gaps, not permission for a
worker to infer broader authority.

## Authority rules

1. L1 decides which part of the human objective becomes a task.
2. Hugin may choose among destinations allowed by the task and current policy.
3. The M5 gateway may choose a capable model within the selected node and policy.
4. A harness may plan and replan only inside the objective, context, tools, destinations, and
   budgets of the accepted envelope.
5. Nested model calls inherit the most restrictive sensitivity and destination policy in force.
6. A worker must return ambiguity that changes the objective, disclosure boundary, or external
   side effects to L1; it must not silently expand scope.
7. Final acceptance belongs to the supplied verifier when it is authoritative, otherwise to L1.

## Execution classes

### One-shot leaf

Suitable for bounded classify, extract, rewrite, translate, short QA, and similar work. Normally one
model call plus an optional deterministic verifier.

### Agentic leaf

Suitable when the accepted task itself needs a read/edit/run or search/read/check loop. Hugin or the
gateway starts a bounded harness. The harness is not a new L1 and does not inherit the surrounding
conversation unless that context is explicitly included.

### Pipeline job

Suitable for code-driven multi-stage work such as deep research. The pipeline defines stages and
budgets in code; models fill bounded roles. A pipeline may use multiple destinations only when each
is permitted by the task's sensitivity policy.

### Fallback Conductor

During a frontier outage, another model/harness may hold the human-facing Conductor role. That is a
separate task mode with L1 authority, not a Hugin leaf becoming progressively more autonomous.

## Lifecycle

```text
submitted -> admitted -> leased -> running -> verifying -> completed
                              |          |          |
                              |          |          `-> rejected/escalated
                              |          `-> retrying
                              `-> cancelled/expired
```

Required properties:

- leases and compare-and-set transitions prevent two workers from owning the same attempt;
- retry policy distinguishes transient infrastructure errors from task or verifier failure;
- cancellation is observable and bounded, even when a backend cannot stop instantaneously;
- terminal results retain provenance: actual node, model, harness, verifier, attempts, and policy;
- side-effecting tasks require an idempotency strategy stronger than prompt equality;
- a task may outlive L1 only when `durability` permits it and delivery remains defined.

## Verification and evidence

An execution is not automatically capability evidence.

- A deterministic, task-relevant verifier can create a strong pass/fail row.
- A calibrated judge may create evidence only for task types for which it is trusted.
- Structural checks such as non-empty output or valid JSON do not establish judgment quality.
- An unverified completion may be useful to the caller but cannot promote an autonomous route.
- Hugin operational success (the job finished) is distinct from capability success (the answer was
  correct enough).
- Capability evidence is written to or imported into the authoritative M5 ledger; Hugin must not
  create a competing capability database.

## Escalation

Escalation is explicit and policy-bounded. Valid reasons include:

- no eligible destination;
- insufficient or regressed capability evidence;
- verifier failure;
- timeout, busy, or unhealthy node after bounded retry;
- uncertainty/disagreement signal valid for the task type;
- missing context or ambiguity that would change task scope;
- requested quality above the local lane's demonstrated ceiling.

Escalation may choose only a destination already permitted by sensitivity policy. Otherwise the
result is blocked and returned to L1 for a human/policy decision.

## Current implementation gaps

- The logical envelope is richer than Hugin's current task schema and the gateway `/delegate`
  request; contract fields need incremental encoding rather than one large migration.
- End-to-end shadowing of an L1 leaf against a Hugin alternative is not yet a general production
  mechanism.
- Agentic text content-parts now enter the harvest/gate evidence lane with a loader-policy epoch;
  non-text multimodal parts remain intentionally outside that text-only path.
- Capability-policy and judge-version semantics still need to support safe rejudging when
  interpretation changes.
- Data classification is not yet consistently attached to every task at creation time.
