# Current implementation plan

**Status:** current as of 2026-07-11. Historical Phase-A work is complete; see git history and
[`RESULTS.md`](../RESULTS.md).

The canonical architecture is [`architecture.md`](./architecture.md). Public execution state,
branches, deployments, and exact next steps live in the relevant issue or pull request. Private
operator handoffs are intentionally not tracked in this repository.

## Active sequence

| Order | Work | State | Exit condition |
|---|---|---|---|
| 1 | Version evidence interpretation policy | Active | Changed task/judge semantics can be regraded without destructive manual deletion |
| 2 | Re-accumulate clean shadow harvest evidence | Waiting on 1 | Roughly one week of current-policy rows, clean judge reliability, hand-checked fail sample |
| 3 | Decide production harvest for eligible non-judgment lanes | HOLD | Evidence supports an explicit GO/HOLD/NO-GO decision |
| 4 | Encode the delegated-task contract incrementally | Planned | Sensitivity, destinations, acceptance, budgets, and provenance propagate end to end |
| 5 | Validate Hugin's narrow durable-broker role | Active experiment | Recurring substantive tasks demonstrate completion, durability, policy compliance, and attention saved |
| 6 | Exercise trust-aware fallback | Planned | One documented node/provider outage drill per relevant trust class |

## Standing constraints

- Keep `HARVEST_MODE=shadow` and `HOMESERVER_DELEGATE_POLICY=shadow` until their evidence gates pass.
- Do not treat shadow rows as production routing or verified savings.
- Keep the frontier model in the L1 Conductor seat; re-test local L1 only through explicit migration
  gates.
- Hugin remains the macro-broker; the M5 gateway remains the micro-broker and single capability
  ledger owner.
- Non-owner traffic remains content-blind.
- Local M5 runs are cheap; preserve capped frontier/OpenRouter spend for irreducible references and
  cross-family judging of saved artifacts.

## Completed foundations

- Original hosted-proxy model evaluation and hardware decision.
- M5 purchase, production serving, llama-swap integration, and four-hour soak.
- Per-principal auth, quotas, owner-preempting admission, metrics, and owner/guest content boundary.
- Capability ledger, deterministic verifiers, routing-table generation, and regression refusal.
- Direct OpenAI/MCP inference and verified `/delegate` contract.
- Hugin-to-M5 integration and explicit Orin backend path.
- Agentic code-loop cage and Gate-D harness measurement.
- Deep-research pipeline and citation trust anchor.
- Shadow harvest, disagreement, delegate-policy, and cost-accounting mechanisms.
- Agentic OpenAI array-of-parts message ingestion with a stamped loader-policy epoch (#222/#223).
- Weekly model scout and guarded auto-promotion.
