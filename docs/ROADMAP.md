# Roadmap

**Last updated:** 2026-07-11

**Architecture:** [`architecture.md`](./architecture.md)

**Execution detail:** repository issues and pull requests. Private operator handoffs are not
tracked in this repository.

## Direction

The project has moved from evaluating a possible hardware purchase to operating and improving the
inference/evidence subsystem beneath Grimnir.

The objective is not to make every call local. It is to move bounded work onto owned compute when
privacy policy permits and capability evidence says quality will hold, while keeping the strongest
available model in the human-facing Conductor seat.

## Phases

| Phase | Outcome | State |
|---|---|---|
| 1. Model and hardware evaluation | Screen local candidates and decide whether to acquire hardware | **Complete** |
| 2. Production M5 serving | Authenticated gateway, llama-swap, admission, quotas, metrics, resilience | **Complete/deployed** |
| 3. Capability routing | Task taxonomy, verifiers, ledger, routing table, safe regression handling | **Complete/deployed** for eligible lanes |
| 4. Hybrid migration gates | Decide frontier versus local Conductor, local leaves, harness, serving | **Complete**: hybrid GO, local Conductor NO-GO |
| 5. Learning from real work | Owner-only harvest, shadow policy, cost traces, trustworthy promotion | **In progress/shadow** |
| 6. Durable fleet delegation | Hugin task lifecycle, node/provider routing, bounded agentic leaves | **Deployed, adoption under validation** |
| 7. Trust-aware resilience | End-to-end sensitivity and tested local/controlled/general-external fallback | **Partial** |
| 8. Self-maintaining capability substrate | Scout, guarded promotion, regression detection, actionable observability | **Partial/deployed** |

Hugin's current validation window and pre-registered keep/reduce/remove thresholds are in
[`hugin-role-validation.md`](./hugin-role-validation.md).

## Near-term proof obligations

### Evidence integrity

- Preserve structured OpenAI message content in agentic owner traffic.
- Version task interpretation and judge policy so corrected semantics can be re-applied safely.
- Accumulate a clean current-policy sample before enabling production harvest.
- Keep judgment-quality lanes behind trusted-verifier allow-lists.

### Hugin value

- Dogfood recurring tasks that genuinely benefit from durability or macro-routing.
- Measure useful completion, continuation after L1 closes, operator attention saved, and operational
  maintenance.
- Keep generic mini-Conductor expansion frozen unless a narrow task shows a measured quality,
  availability, cost, or repeatability advantage.
- Keep direct M5 access available; do not inflate Hugin usage by forcing interactive inference
  through it.

### Trust and fallback

- Carry sensitivity and allowed destinations from L1 through Hugin, gateway, harness, judges, and
  evidence.
- Distinguish owned/local, controlled external such as Berget, and general external providers.
- Test explicit outage/fallback behavior without silently weakening data policy.

### Economics

- Base savings on verified displaced frontier calls.
- Calibrate local energy/amortization assumptions against real utilization.
- Report shadow projections separately from realized savings and total hardware ROI.

## Longer horizon

- Re-test the local Conductor seat only when a specific intervention targets the measured
  under-reading and gap-blindness failures.
- Expand local agentic execution when task envelopes, cages, and verifiers support it—not merely
  because a larger model is available.
- Allow model and harness rosters to change underneath stable task, policy, and evidence contracts.
- Keep Grimnir useful during individual provider, subscription, hardware, and geopolitical failure
  modes without promising a quality level the fallback has not earned.

## Explicit non-goals

- Replacing Claude Code/Codex with a weaker local clone for ideological symmetry.
- Turning Hugin into a second general-purpose Conductor.
- Duplicating the capability ledger in Hugin.
- Sending sensitive work to a cheaper but ineligible destination.
- Claiming autonomous self-improvement from shadow evidence.
