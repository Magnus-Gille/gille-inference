# ADR-005: Hybrid steady state and replaceable Conductor

- **Status:** Accepted
- **Date:** 2026-07-11
- **Decider:** project owner
- **Related:** [`architecture.md`](./architecture.md),
  [`migration-go-no-go-verdict.md`](./migration-go-no-go-verdict.md),
  [`hugin-role-validation.md`](./hugin-role-validation.md)

## Context

Local models can perform substantial bounded work, and a good harness can close more of the gap
than simply selecting a larger model. But the completed migration gates found two failures that are
especially dangerous in the human-facing seat: local agentic brains under-read retrieval context,
and a local brain with an available frontier advisor failed to recognize when it needed help.

At the same time, Claude Code and Codex already provide strong models, state-of-the-art harnesses,
repo access, replanning, verification, and human interaction. Building a weaker general Conductor
inside Hugin would duplicate that layer and blur authority.

## Decision

Adopt **S1-Hybrid** as the production steady state:

- the strongest available permitted model/harness holds the L1 Conductor seat;
- the L1 implementation is replaceable and is not the identity of Grimnir;
- bounded leaf work moves to owned inference only when authority, data policy, and capability
  evidence permit it;
- Hugin is the optional durable macro-broker for tasks requiring lifecycle and fleet/provider
  choice, not a generic second Conductor;
- the M5 gateway remains directly accessible for interactive inference and owns micro-routing plus
  capability evidence;
- a local/fallback Conductor remains an explicit future experiment, not the presumed destination.

## Consequences

### Positive

- Uses frontier capability where gap recognition and top-level integration matter most.
- Captures local privacy, availability, and token-volume benefits on bounded work.
- Lets models, harnesses, and providers change underneath stable contracts.
- Gives Hugin a testable infrastructure role instead of an intelligence claim.

### Negative

- Full sovereignty is not guaranteed while the primary Conductor is external.
- Handoff quality and task-envelope design become critical infrastructure.
- The system must maintain honest evidence about which lanes remain frontier-dependent.

### Guardrails

- Do not describe S2 local-Conductor migration as inevitable.
- Do not force direct inference through Hugin to justify Hugin's existence.
- Do not promote a local route from shadow, structural checks, or untrusted judging.
- Re-litigate the Conductor seat only with an intervention and gate aimed at the measured
  under-reading and gap-blindness failures.
