# Vision-to-evidence map

**Status:** current claim ledger

**As of:** 2026-07-11

This document prevents the architecture story from outrunning implementation and organic evidence.
Statuses use the vocabulary in [`architecture.md`](./architecture.md).

| Vision claim | Mechanism/artifact | State | Important gap |
|---|---|---|---|
| The human-facing brain is replaceable | L1 contract, Munin context, house nomenclature | **deployed** across Claude Code/Codex use | Formal L1 task handoff schema is incomplete |
| Frontier Conductor + local leaves is the steady state | [`migration-go-no-go-verdict.md`](./migration-go-no-go-verdict.md) Gates A-E | **measured** | Organic production offload volume is still small/noisy |
| Direct local inference works without Hugin | Gateway OpenAI API and MCP `ask` | **deployed/enforced** | Availability UX across all clients is uneven |
| Hugin provides durable task lifecycle and macro-routing | Hugin leases/CAS, runtime registry, M5 and Orin paths | **deployed** | Queue and substantive recurring use remain light |
| M5 safely serves multiple principals | Keystore, quota, owner-preempting admission, SLA | **deployed/enforced** | Best-effort service, one serial GPU |
| Local agentic coding can be useful | pi-harness code loop and Gate D, 10/10 deterministic battery | **measured; bounded deployment** | General repo-context and organic agentic evidence are immature |
| Model choice is evidence-gated | Capability ledger, routing table, regression refusal | **deployed/enforced** for eligible `/delegate` lanes | Many task/model rows remain unknown or unverified |
| Real use improves future routing | Owner log, harvest, delegate policy, import pipeline | **deployed/shadow** | Agentic text content-parts are now ingested and loader-epoch stamped; full evidence-policy/rejudge versioning and a mature promotion sample remain |
| Cross-model disagreement catches weak local answers | Disagreement gate experiment | **measured** for short verifiable leaves; **shadow** in production | Output similarity is invalid for open-ended/agentic traffic; positive sample is small |
| The system selects the cheapest capable route | Routing/cost traces and savings accounting | **deployed/shadow** | Not an ROI claim until verified volume and local cost calibration mature |
| Guest use teaches the system without eavesdropping | Content-blind request log and metrics | **deployed/enforced** | Guest content intentionally cannot supply answer-quality evidence |
| Owner use can feed deliberate local learning | Owner-only request log and local harvest judge | **deployed/shadow** | Retention policy and sensitivity propagation need continued discipline |
| Privacy-aware routing spans local, Berget, and OpenRouter | Hugin trust/sensitivity filters and provider registry | **partly deployed** | Trust-zone semantics and end-to-end data classification are incomplete |
| The system survives a frontier-provider outage | Multiple local/external runtime types | **aspirational/partly deployed** | No canonical tested fallback-Conductor runbook or recurring outage drill |
| The fleet improves its model roster automatically | Weekly scout, probe, gate flags, transactional promotion | **deployed** | Promotion quality is bounded by probes; human review remains appropriate |
| Hugin can run a bounded agentic leaf without becoming L1 | Harness runtime support plus task boundary | **partly deployed** | Authority/budget fields are not fully encoded in the task schema |
| One capability truth guides routing | M5 ledger and ADR-004 | **architecturally settled** | Hugin verdict-like storage must remain operational, not become a competing capability ledger |

## Claims that must remain narrow

- **Offloadability:** a measured ceiling or verifier-backed production count, never a universal
  percentage inferred from changing chat traffic.
- **Savings:** verified avoided frontier cost, not total hardware ROI without calibrated local cost
  and representative volume.
- **Self-improving:** shadow-first evidence collection and guarded promotion, not an autonomous system
  rewriting arbitrary code or policy.
- **Sovereignty:** owned/local execution. Berget adds provider and jurisdiction diversity but is
  still external processing.
- **Hugin necessity:** architectural value as durable delegation infrastructure is clear; recurring
  demand and attention saved remain empirical questions.

## Nearest work that makes the vision truer

1. Complete evidence-policy and rejudge versioning so changed interpretation can be applied without
   destructive manual deletion; agentic content-parts ingestion itself shipped in #222/#223.
2. Accumulate and hand-check fresh shadow harvest evidence before turning production policy on.
3. Encode sensitivity, destinations, acceptance, and budgets more completely in the Hugin task
   envelope.
4. Dogfood recurring Hugin tasks that outlive L1 and measure useful completion plus operator attention
   saved.
5. Exercise one explicit provider/node outage per trust class and document the observed fallback.
6. Keep capability evidence in the M5 ledger and make Hugin operational evidence visibly distinct.
