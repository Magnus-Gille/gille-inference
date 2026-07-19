# Architecture Decisions

## ADR-001: OpenRouter for all API calls

**Decision:** Use a single OpenRouter API key for inference (local model proxying) and both judges (Opus, o4-mini).

**Rationale:** Simplest possible setup. OpenRouter is OpenAI-compatible, so the openai SDK works without modification. Single billing surface.

**Consequence:** Phase A results are "hosted proxy upper bound" — NOT local performance. All published results must be labelled accordingly.

## ADR-002: Single SQLite file, no migrations machinery

**Decision:** All tables created via a single `CREATE TABLE IF NOT EXISTS` DDL block in `db.ts`. No migration framework.

**Rationale:** This is a one-shot evaluation project, not a long-lived production system. Migrations add complexity with no benefit here. If the schema needs to change, the db file is deleted and recreated.

## ADR-003: Node16 module resolution with .js imports

**Decision:** Use `"module": "Node16"` and `"moduleResolution": "Node16"` in tsconfig. All intra-project imports use `.js` extensions.

**Rationale:** Required for ESM compatibility in Node.js. Without `.js` extensions Node16 resolution fails at runtime.

## ADR-004: M5 routing ownership — Hugin macro-routes nodes, homeserver micro-routes models, the ledger is the one knowledge base

**Decision:** Hugin owns intake + macro-routing (*which node/provider*) for durable delegated tasks and registers the M5 as one runtime behind the homeserver gateway (`:8080`). Homeserver owns micro-routing (*which model on the M5*) + serial-GPU admission + the external gateway/keystore/quota. `ledger.ts` stays the **single** capability knowledge base — Hugin reads or writes evidence through the gateway's defined contract and never replicates it. Nightly/autonomous local sub-tasks route through `POST /delegate` (verified + ledger-learning), not raw `/v1/chat/completions`. Interactive clients may call the gateway directly; Hugin is not mandatory for raw inference.

**Rationale:** The two layers are different altitudes, not duplicates; wiring the M5 ad-hoc would build two divergent routing DBs and break RQ7 ("which node+model is best per task type"). Writing the seam down before arrival is cheap now, expensive later.

**Consequence:** Bounded Hugin work is required (it is not a drop-in): extend `DispatcherRuntime`/`Provider` unions, add a `baseUrl` carrier + Bearer-auth executor, hold an owner-tier gateway key. Full design, code references, alternatives, and follow-ups in [`adr-004-m5-routing-ownership.md`](./adr-004-m5-routing-ownership.md).

## ADR-005: Hybrid steady state — replaceable frontier Conductor, evidence-gated local execution

**Decision:** Keep the strongest available model/harness in the human-facing L1 Conductor seat.
Move bounded leaf work to owned inference only when task authority, data policy, and capability
evidence permit it. Treat a local top-level Conductor as a future experiment, not the production
destination.

**Rationale:** Migration Gates A-D validated local leaves, serving, routing, and pi-harness execution.
Gate E found that local brains could answer nearly as well but under-read retrieval tasks and failed
to recognize gaps reliably. The system's durable value is therefore the replaceable substrate and
learning loop, not a weaker duplicate L1.

**Consequence:** Hugin is a durable macro-broker, not a generic second Conductor. Direct M5 access
remains supported. Shadow and verifier-backed evidence determine which lanes become autonomous.
Canonical architecture: [`architecture.md`](./architecture.md); evidence:
[`migration-go-no-go-verdict.md`](./migration-go-no-go-verdict.md); full decision:
[`adr-005-hybrid-steady-state.md`](./adr-005-hybrid-steady-state.md).

## Hugin timed deprecation trial

**Decision:** Freeze expansion and validate Hugin's narrow durable-supervisor role from 2026-07-11
through 2026-08-22. Keep, reduce, or remove it using pre-registered demand, usefulness, durability,
reliability, security, and maintenance thresholds. Delete the internal mini-Conductor unless it
earns a distinct measured niche.

**Rationale:** The architecture explains why a broker can be valuable despite a stronger L1, but
current real usage is too light to justify the maintenance surface by intent alone.

**Consequence:** No manufactured traffic and no forced Hugin path for direct inference. Governing
criteria: [`hugin-role-validation.md`](./hugin-role-validation.md).
