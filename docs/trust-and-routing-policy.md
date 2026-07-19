# Trust and routing policy

**Status:** architectural policy; partially enforced

**Last updated:** 2026-07-11

## Principle

Privacy, sovereignty, availability, quality, and cost are not interchangeable scores. A destination
must first be eligible to receive the task. Optimization happens only among eligible routes.

## Trust zones

| Zone | Examples | Meaning |
|---|---|---|
| **Owned/local** | M5, Orin, Pi, laptop | Prompt and result remain on hardware controlled by the operator, subject to the node's own storage and network policy |
| **Controlled external** | Berget | Processing leaves owned hardware but uses a deliberately selected provider/jurisdiction; not equivalent to local sovereignty |
| **General external** | OpenRouter and frontier APIs | Processing and provider routing follow the selected external service's terms and infrastructure |
| **Ineligible** | Any destination excluded by task or policy | Must not receive task content, even as fallback |

Provider labels such as "trusted" or "private" must identify the zone and policy basis. They must
not imply that controlled external processing has the same boundary as owned hardware.

## Task sensitivity

The target policy has at least these logical classes:

| Class | Default destination eligibility |
|---|---|
| **local-only** | Owned/local only |
| **controlled-external-ok** | Owned/local plus explicitly approved controlled external providers |
| **external-ok** | Any configured provider that satisfies task policy |
| **public** | Same as external-ok; content is not itself sensitive, but authority/tool constraints still apply |

The exact names may evolve, but the lattice must preserve the distinction. Unknown sensitivity
defaults conservatively; it is not automatically external-ok.

Sensitivity applies to:

- prompts and attached context;
- retrieved files and tool results;
- intermediate distillations that still contain sensitive facts;
- nested model calls made by a harness;
- logs, traces, judges, and shadow comparisons.

Transforming text into a summary does not automatically declassify it. A deliberate redaction or
classification step is required.

## Routing precedence

For every request or task:

1. Validate caller authority and task/tool permissions.
2. Determine or inherit sensitivity.
3. Remove destinations that are not allowed to see the content.
4. Remove routes without adequate capability evidence for autonomous use; retain them only in an
   explicitly authorized shadow experiment.
5. Remove unhealthy, quota-exhausted, or unavailable routes.
6. Meet required quality, latency, and durability.
7. Choose the lowest-cost remaining route, accounting for swap and retry cost where relevant.

No frontier fallback is allowed when the task is local-only. The correct result is an explicit
blocked or unavailable outcome.

## Surfaces and defaults

### Direct gateway access

The authenticated caller chooses a permitted model or explicit node. The gateway enforces key
allow-lists, quotas, admission, and backend constraints. Direct access does not require Hugin.

### Hugin task routing

Hugin may choose a node/provider only from the task's allowed set. It owns macro availability and
retry decisions, while the selected gateway owns its own admission and micro-routing. Hugin must
not turn a remote busy/error response into an unbounded retry storm.

### Agentic harnesses

Every nested tool or model call inherits the task's policy. A harness cannot use a general cloud
model merely because its local primary failed. Tool output is content and follows the same rules as
the original prompt.

### Shadow and judging

A shadow destination receives real content. It therefore requires the same data eligibility as a
production destination. Owner-only content may feed deliberate local learning. Guest content stays
content-blind by default and must not be copied into owner logs, shadow prompts, or judge datasets.

## Observability boundaries

[`observability.md`](./observability.md) is authoritative for storage details.

- `request_log` and Prometheus metrics are content-blind.
- `owner_request_log` is the only ordinary content sink and accepts deliberately authenticated
  owner traffic only.
- Non-owner prompts and responses are not retained for learning.
- External judge/provider use must satisfy the task's sensitivity policy, not merely the operator's
  ability to call it.

## Availability and degraded operation

- Hugin failure does not remove direct authorized access to the M5 gateway.
- M5 failure may trigger another eligible Hugin route.
- External-provider failure may fall back local even at reduced quality when policy and the caller's
  acceptance requirements permit it.
- A local-only task remains blocked rather than silently disclosed externally.
- Provider independence is valuable only when failure modes and credentials are genuinely distinct;
  two endpoints backed by the same upstream are not full redundancy.

## Enforcement status and gaps

**Enforced today:** gateway authentication, key allow-lists, quota, admission, owner-only content
logging guard, content-blind guest operations data, explicit Orin eligibility constraints.

**Partly enforced:** Hugin sensitivity/provider filtering, external-provider selection, nested
harness network/tool policy, and shadow-policy traces.

**Not yet complete:** a single end-to-end sensitivity field propagated from L1 through Hugin,
gateway, harness, nested calls, judge, and evidence row; explicit declassification; tested outage
fallbacks per trust class.
