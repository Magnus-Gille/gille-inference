# Gille Inference

## Resume and persistence

Keep the initial handshake read-only. Current proof obligations live in `docs/ROADMAP.md` and
GitHub issues; load `docs/architecture.md` only when architectural context is needed. Operators may
keep a gitignored `STATUS.md` as a private local handoff, but it must never be committed. These
files replace the generic `STATUS.md`/`PROGRESS.md`/`TODO.md` handoff defaults in the global
instructions.

After a substantive session, record public work in the relevant issue or pull request, containing
only the reusable engineering contract and sanitized evidence. Exact transient operator handoffs
may use the gitignored local `STATUS.md`; durable or multi-session deployment state, incidents, and
maintenance belong in the private repository `Magnus-Gille/grimnir-ops`, never in this public
repository. That repository is an execution tracker and does not own this service's code or
architecture. Log durable decisions before replacing mutable project status.

## Mission and architecture

This repository makes personally controlled inference safely useful to replaceable AI Conductors.
It owns the production M5 serving, bounded delegation, and capability-evidence subsystem beneath
Grimnir. The steady state is a strong frontier L1 plus increasingly local, evidence-gated
execution—not a weaker local clone for symmetry. The research questions behind that decision are
listed in `docs/architecture.md`.

Use the house vocabulary precisely:

- **L1 Conductor:** human-facing objective understanding, decomposition, and final integration;
  Claude Code or Codex today.
- **L2 Broker:** routing and lifecycle. Hugin is the optional durable macro-broker for task intake,
  node/provider choice, retry, and delivery. The M5 gateway is the on-box micro-broker for auth,
  admission, model choice, verification, and evidence.
- **L3 Runtime:** a model on M5, another node, or an external provider.
- **Harness:** a cross-cutting tool loop such as pi, aider, or opencode. A harness may drive a
  bounded leaf but is not automatically L1 or L2. `pi` the harness is not `Pi` hardware.

Interactive authenticated callers may reach the M5 directly; Hugin is not required in that path.
Hugin is valuable when work must survive the initiating session or needs fleet-level policy. The
M5 capability ledger owns node/model/task/verifier evidence; Hugin owns durable job and
fleet-operational state. See `docs/architecture.md`, `docs/nomenclature.md`, and
`docs/adr-004-m5-routing-ownership.md`.

**M5 is also the code under change here.** While the gateway is being edited, restarted, or
deployed, the global M5 delegation default may be degraded or self-referential. Keep such work on
L1 and say so instead of delegating into the component being modified.

When asked whether the Grimnir/M5 vision is true, blog-ready, or worth claiming, follow the
principle → mechanism → evidence → gap method in `docs/vision-evidence-map.md` and label every
claim by maturity. `docs/migration-go-no-go-verdict.md` holds the measured steady-state decision.

## Authority, privacy, and routing invariants

- **Eligibility precedes optimization.** Authority and data classification remove forbidden
  destinations before quality, availability, latency, or cost are considered.
- **Evidence precedes autonomy.** Unknown lanes escalate or remain shadow. Structural validity is
  not judgment quality; judgment-bearing lanes require an explicitly trusted verifier.
- **Harnesses do not expand authority.** A nested agent may replan inside its accepted task but
  does not inherit the human's broader objective, credentials, providers, or unrestricted tools.
- **Guest traffic stays content-blind.** Only deliberately authenticated owner traffic may enter
  the owner content log. Metrics and shared logs must not leak prompts, responses, secrets, or
  high-cardinality user labels.
- **Shadow remains labelled shadow.** Do not present shadow decisions, synthetic probes, or
  projected avoided spend as enforced routing, organic production quality, or realized savings.
- **The serial GPU is a shared scarce resource.** Respect admission and the durable GPU lease; do
  not run competing benchmarks or bypass owner-preemption controls.
- **Generated routing changes are fail-closed.** Use the routing-table writer/diff path and do not
  accept capability downgrades or missing expected evidence silently.
- **Secrets and live state never enter Git.** Keep keys in environment/configured secret stores.
  Never copy or deploy `data/`, `.env`, keystores, owner logs, or production databases.

Canonical policy: `docs/trust-and-routing-policy.md`, `docs/task-delegation-contract.md`,
`docs/task-exposure-contract.md`, `docs/observability.md`, and
`docs/delegation-cost-accounting.md`.

## Do not claim

- Codex is not an Opus-to-Sonnet stack; that path is Claude Code's. Both are replaceable L1s.
- Codex transcript ingestion does not exist. `scripts/extract-prompts.ts` reads Claude Code
  transcripts under `~/.claude/projects` only.
- There is no product called "Codex Max". Distinguish Claude Max from ChatGPT/Codex access.
- Codex review uses ChatGPT auth, not the OpenRouter key. An OpenRouter quota failure does not
  prove Codex review is unavailable.
- MCP (`src/homeserver/mcp.ts`) is one client surface. Direct authenticated API inference is
  valid without MCP or Hugin.
- Gate-D results are not interpretable without `gate-d/README.md` and
  `docs/gate-de-evaluation-plan.md`; read both before changing or citing them.

## Authoritative map

Start with `README.md`, then load only the references needed for the task:

- `docs/architecture.md` — canonical topology, ownership, and learning loop.
- `docs/nomenclature.md` — L1/L2/L3/harness vocabulary.
- `docs/vision-evidence-map.md` — maturity of public-facing claims and the audit method.
- `docs/trust-and-routing-policy.md` — trust zones and routing precedence.
- `docs/gateway-api-contract.md` and `src/homeserver/README.md` — concrete API/operator surface.
- `docs/observability.md` — content and telemetry boundaries.
- `docs/adr-005-hybrid-steady-state.md` — why frontier L1 plus local leaves is current policy.
- `docs/ROADMAP.md` and GitHub issues — current proof obligations and resumption detail.
- `RESULTS.md`, `docs/eval-spec-hardware-gate.md`, and `docs/migration-go-no-go-verdict.md` —
  benchmark interpretation and hardware/migration decisions.
- `deploy/README.md` — production configuration and deployment runbook.

Source ownership is discoverable from `src/homeserver/` with `rg`; it is intentionally not
duplicated here. Issue-specific internals, dated measurements, and historical phases belong in
issues and focused documents under `docs/`.

## Development and validation

Requirements are Node.js 20+ and npm. The codebase is strict TypeScript/ESM, run through `tsx`; use
`.js` extensions in TypeScript imports. SQLite is synchronous via `better-sqlite3` with WAL where
configured. Tests use Vitest.

Use the smallest relevant validation first, then broaden in proportion to risk:

```bash
npm install
npm test -- tests/<affected>.test.ts
npm run typecheck
npm test
git diff --check
```

For documentation-only instruction changes, validate the import contract, links/paths, exact diff,
and harness loading; do not manufacture a code-suite signal. For behavioral changes, add a
regression test that fails before the fix and run the affected suite plus typecheck. Preserve
idempotence and resumability in runners, importers, cron jobs, and generated-artifact writers.

The gateway entry point is `npm run homeserver -- --help` (`serve`, `probe`, `ledger`). The
runner entry points are `npm run run:eval`, `npm run run:judge`, and `npm run run:analysis`; each
requires `--batch <id>` and has no `--help`, so read the script header for flags. Prompt mining is
`scripts/extract-prompts.ts`, `scripts/classify-prompts.ts`, and `scripts/analyze-prompts.ts`.

## Benchmark and paid-resource discipline

The historical Phase-A OpenRouter results are hosted-proxy upper bounds, not local performance;
label them accordingly. Local M5 compute is the cheap arm; OpenRouter judges and frontier
references consume a capped resource.

- Estimate paid judge/reference calls before a study and perform irreducible credit-dependent
  validation while quota remains.
- Run a frontier reference once, save it, and reuse it. Judge saved reports; never rerun an
  expensive pipeline merely to re-judge it.
- Prefer local arms and cost-minimal hybrid synthesis when they answer the question. Batch work by
  model to avoid unnecessary cold swaps.
- Keep raw measurements, shadow evidence, and calibrated production conclusions distinct.

See `docs/mac-studio-capacity-model.md` and `docs/deep-research-harness-design.md` for method.

## Deploying the M5 gateway

Read the **"Live deployment (authoritative)"** section of `deploy/README.md` before touching
production. It owns the live path, systemd unit, deploy/verify commands, rollback recipe, and the
MCP-restart caveat. Facts that must not drift:

- The unit is `home-gateway.service` with `WorkingDirectory=/home/magnus/home-server-eval`. The
  live tree is a plain rsync'd copy, not a git checkout. `/srv/gille-inference` does not exist on
  the box; do not target it.
- Deploy only with `scripts/deploy-gateway.sh deploy <accepted-full-sha>` (`dry-run` and `verify`
  exist). It binds the invoked checkout and the caller's worktree/HEAD to the explicit release
  SHA, ships a `git archive` of that commit rather than worktree bytes, and fails closed on any
  mismatch or failed probe. Preserve that outer source-identity gate and immutable-payload
  boundary in addition to every existing check.
- `src/homeserver/portal.html` is hand-maintained and cached in memory. Whenever served models,
  endpoints, limits, credits/rate policy, or billing dimensions change, update its "What's
  running" and "How to use it" sections and `src/homeserver/README.md` in the same change. A
  portal-only deploy still requires a gateway restart.

### Controlled-evaluation envelope

The owner may approve a bounded envelope for transient non-production units on the M5. It must fix
the goal, host, paths, unit prefix, allowed mutations, model/runtime/gateway, resource and
time/count ceilings, prior-resident set, maintenance, cleanup, restoration, OOM and
protected-service checks, forbidden production changes, and stopping conditions. Record each exact
unit, immutable release, and launcher before execution. Fail closed and require new confirmation if
scope expands, safeguards weaken, production or credentials enter scope, the envelope expires, or
restoration, OOM, or protected-service anomalies occur. A pre-mutation failure that preserves all
invariants may be diagnosed and retried inside the remaining envelope.
