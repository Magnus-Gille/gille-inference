# Gille Inference

Self-hosted inference serving, bounded delegation, and capability learning for personally
controlled AI compute. Gille Inference is the local-runtime and evidence component of Grimnir, but
it can also be deployed on its own behind any OpenAI-compatible client.

This repository makes owned inference safely useful to replaceable AI Conductors such as Claude
Code and Codex. It runs the M5 gateway, protects its serial GPU, routes work to models that have
earned the task, verifies delegated results, and records evidence that can improve future routing.

It began as a local-LLM and hardware evaluation. Those benchmark tools and results remain here, but
the repository is now the production inference and capability-evidence subsystem beneath Grimnir.

## The operating thesis

The production steady state is **frontier brain + increasingly local execution**:

```text
human
  |
  v
L1 Conductor -- Claude Code or Codex; understands the objective
  |
  +--------------------- direct interactive inference ----------------------+
  |                                                                         |
  `--> Hugin -- durable task + node/provider choice                         |
            |                                                               |
            +--> other eligible node/provider                               |
            |                                                               |
            `---------------------> M5 gateway <-----------------------------+
                                      |
                                      +-- auth / quota / admission
                                      +-- model routing / verification / ledger
                                      `-- llama-swap Runtime or bounded harness
```

Hugin is **not always between L1 and the M5**. Interactive callers may use the authenticated M5
gateway directly. Hugin is valuable when a bounded task needs durable lifecycle, asynchronous
execution, fleet/provider selection, retry, or delivery after the initiating L1 session ends.

Hugin does not need to outthink L1. Its purpose is to make execution across replaceable local and
external workers durable, policy-aware, and measurable.

Read [`docs/architecture.md`](./docs/architecture.md) first. It is the canonical current
architecture. The whole-system vision remains canonical in the
[`grimnir`](https://github.com/Magnus-Gille/grimnir) repository.

## Grimnir ecosystem

Gille Inference is one independently deployable part of a larger personal-AI stack:

| Repository | Role |
|---|---|
| `grimnir` | System architecture, conventions, and service registry |
| `hugin` | Durable task intake, lifecycle, retry, and fleet-level routing |
| `gille-inference` | Authenticated inference gateway, bounded harnesses, and capability evidence |
| `munin-memory` | Persistent memory and retrieval |
| `mimir` | Authenticated file serving |
| `heimdall` | Operational dashboard and observability |
| `brokkr` | Hardware, OS, storage, backup, and recovery substrate |

These repositories are complementary rather than a required monolith. A standalone deployment
needs only this repository and a compatible model backend. Hugin is optional for durable work;
Munin Memory, Mimir, and Heimdall are optional consumers or peers.

## What lives here

### Production M5 serving

`src/homeserver/` contains:

- an authenticated OpenAI-compatible gateway and MCP server;
- per-principal allow-lists, quotas, expiry, and owner-preempting admission;
- llama-swap model administration and explicit remote-node adaptation;
- content-blind Prometheus metrics and request logs;
- a deliberately owner-only content log for local learning;
- recurrent-model poison clearing and stream-degeneracy protection.

### Delegation and capability evidence

- `/delegate` classifies bounded work, consults capability evidence, runs an eligible model,
  verifies the result where possible, and records provenance.
- The capability ledger is the single node/model/task knowledge base consumed by routing.
- The generated routing table refuses silent capability regressions.
- Harvest and delegate-policy mechanisms learn from owner traffic in shadow mode before changing
  production behavior.
- Savings traces distinguish verified avoided frontier work from speculative or shadow savings.

### Bounded agentic and research execution

- pi-harness drives an accepted read/edit/run loop inside a tested cage.
- The deep-research harness uses code-defined stages, pluggable search/read adapters, and a
  deterministic citation verifier.
- Weekly model scouting evaluates new local candidates without disturbing the live runtime.

### Evaluation framework

The original TypeScript/SQLite benchmark runner, cross-family judging, analysis tools, hardware
capacity work, and migration gates remain part of the repository. They provide the evidence behind
the production architecture and allow it to be re-tested as models and harnesses improve.

## Architectural boundaries

| Concern | Owner |
|---|---|
| Human objective, decomposition, final integration | L1 Conductor |
| Durable task lifecycle and node/provider choice | Hugin macro-broker |
| M5 auth, admission, model choice, verification, capability ledger | M5 micro-broker in this repo |
| Model execution | L3 Runtime |
| Tool-driven loop inside a bounded task | Harness |

This repository does not own Munin, the human-facing Conductor, the whole Grimnir service graph, or
Hugin's task lifecycle. It defines and operates the serving/evidence boundary those systems use.

## Principles

1. **Eligibility before optimization.** Authority and data classification remove forbidden
   destinations before quality, availability, latency, or cost are considered.
2. **Evidence before autonomy.** Unknown and weakly judged lanes stay shadow or escalate.
3. **One capability truth.** The M5 ledger owns node/model/task/verifier evidence; Hugin owns job and
   fleet-operational state.
4. **Guest traffic stays content-blind.** Only deliberately authenticated owner traffic can enter
   the content learning log.
5. **Shadow is not production.** Shadow routes, harvest rows, and projected savings are labelled as
   such.
6. **Harnesses do not expand authority.** A nested agent may replan inside its accepted task but
   does not inherit the human's larger objective or unrestricted tools/providers.
7. **Hybrid is the current steady state.** A local top-level Conductor remains a research target,
   not an assumed destination.

## Current evidence state

- M5 serving, auth, quota, admission, direct MCP/API access, and content boundaries are deployed.
- Local leaf execution, serial-GPU capacity, and bounded pi-harness coding have passed measured
  gates.
- The frontier Conductor remains necessary: local-brain experiments exposed under-reading and
  gap-blindness despite near-frontier raw answer rates.
- Capability routing is enforced only where evidence is admissible.
- Harvest and broad delegate policy remain shadow-first while fresh organic evidence accumulates.
- Hugin's architectural role is settled; recurring substantive use and attention saved remain
  empirical validation questions.

See [`docs/vision-evidence-map.md`](./docs/vision-evidence-map.md) for claim-by-claim maturity.

## Security and limitations

- This is self-hosted infrastructure, not a managed service. No availability, model-quality, or
  support SLA is implied by the repository.
- Operators own TLS, network exposure, keys, model provenance, backups, and patching.
- The code-loop cage is Linux-specific defense in depth. Do not expose tool-running routes to
  untrusted users, and read the threat assumptions before enabling it.
- Local model output is untrusted. Evidence gates reduce risk; they do not make generated code,
  research, or operational decisions automatically safe.
- Dated benchmark reports describe particular hardware, models, and software versions. They are
  evidence, not promises of comparable results elsewhere.

See [`SECURITY.md`](./SECURITY.md),
[`docs/trust-and-routing-policy.md`](./docs/trust-and-routing-policy.md), and
[`docs/observability.md`](./docs/observability.md) before exposing a deployment.

## Documentation map

- [`docs/architecture.md`](./docs/architecture.md) — canonical purpose, topology, ownership, and
  learning loop.
- [`docs/nomenclature.md`](./docs/nomenclature.md) — L1/L2/L3 and harness vocabulary.
- [`docs/task-delegation-contract.md`](./docs/task-delegation-contract.md) — authority and lifecycle
  of work passed from L1 to Hugin.
- [`docs/trust-and-routing-policy.md`](./docs/trust-and-routing-policy.md) — trust zones, sensitivity,
  and routing precedence.
- [`docs/adr-004-m5-routing-ownership.md`](./docs/adr-004-m5-routing-ownership.md) — Hugin/M5 routing
  seam and the single-ledger decision.
- [`docs/adr-005-hybrid-steady-state.md`](./docs/adr-005-hybrid-steady-state.md) — why the frontier
  Conductor plus evidence-gated local execution is the steady state.
- [`docs/hugin-role-validation.md`](./docs/hugin-role-validation.md) — dated trial that decides
  whether Hugin's implementation earns its maintenance surface.
- [`docs/gateway-api-contract.md`](./docs/gateway-api-contract.md) — concrete gateway surfaces.
- [`docs/observability.md`](./docs/observability.md) — content and telemetry boundaries.
- [`docs/migration-go-no-go-verdict.md`](./docs/migration-go-no-go-verdict.md) — measured decision to
  retain the frontier Conductor and localize leaf work.
- [`docs/ROADMAP.md`](./docs/ROADMAP.md) — current phases and open proof obligations.
- [`RESULTS.md`](./RESULTS.md) — original hosted-proxy benchmark and hardware economics.

## Quick start

### Requirements

- Node.js 20+
- npm
- Runtime/provider configuration for the command being used
- `OPENROUTER_API_KEY` only for experiments that deliberately call OpenRouter

```bash
npm ci
npm run typecheck
npm test
```

Copy [`deploy/env.example`](./deploy/env.example) to `.env` only when configuring the gateway;
keep that populated file mode `0600` and out of Git. The root [`.env.example`](./.env.example) is
only for optional external evaluation credentials.

### Gateway CLI

```bash
# Show commands
npm run homeserver -- --help

# Start the gateway using the configured environment
npm run homeserver:serve

# Run configured capability probes
npm run homeserver:probe

# Inspect the capability ledger
npm run homeserver:ledger
```

Production configuration, systemd, gateway exposure, and operator commands are documented under
[`deploy/`](./deploy/README.md) and [`src/homeserver/README.md`](./src/homeserver/README.md).

### Evaluation pipeline

Each stage is idempotent and resumable. Results are stored in SQLite at `EVAL_DB_PATH` or
`./data/eval.db`.

```bash
# Run inference tasks
npx tsx src/runner/index.ts --batch v1 --models all --tasks all

# Resume a partial batch
npx tsx src/runner/index.ts --batch v1 --resume

# Judge saved runs
npx tsx src/judge/index.ts --batch v1 --judge both

# Produce analysis
npx tsx src/analysis/index.ts --batch v1
```

All OpenRouter-backed results must be labelled **hosted proxy upper bound**, not local hardware
performance. Local compute is cheap; cross-family judges and frontier references are capped and
should be run only against saved artifacts.

## Technology

- TypeScript with Node16 ESM resolution and `.js` import extensions
- `tsx` for direct TypeScript execution
- SQLite via `better-sqlite3`, WAL mode
- OpenAI-compatible APIs for local and external inference
- Vitest

## Contributing, support, and license

Bug reports and focused feature proposals are welcome through GitHub issues. Security reports must
follow [`SECURITY.md`](./SECURITY.md) and must not include sensitive details in a public issue.
Development and pull-request guidance is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

Gille Inference is available under the [MIT License](./LICENSE). The project is maintained on a
best-effort basis; there is no guaranteed response time or compatibility commitment before a
stable server release.

## Project history

The repository began by asking whether local open-weight models and expensive unified-memory
hardware could replace enough API usage to be worthwhile. Phase A screened hosted model proxies;
later phases measured the actual Strix Halo M5, production serving, routing, harnesses, and local
versus frontier control loops.

The important result is no longer merely "the hardware is fast enough." The stronger finding is:

- local models can absorb much bounded leaf work;
- the harness and verifier often matter more than another model-size step;
- local models have not earned the top-level Conductor seat;
- the durable product is the loop that decides, measures, and revises what can safely run locally.

Historical results remain in [`RESULTS.md`](./RESULTS.md), benchmark reports, and migration gate
documents. Claims involving percentages, savings, or self-improvement should be
read with the maturity labels in the current evidence map.
