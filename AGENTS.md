# Gille Inference

## Resume and persistence

Use `docs/ROADMAP.md` and GitHub issues for current proof obligations, and
`docs/architecture.md` when architectural context is needed. Operators may keep a gitignored
`STATUS.md` as a private local handoff, but it must never be committed. Keep the initial handshake
read-only.

After a substantive session, record public work in the relevant issue or pull request. Private
deployment state and exact operator handoffs belong in a gitignored local `STATUS.md`, never in the
repository. Log durable decisions before replacing mutable project status.

`AGENTS.md` is the canonical cross-harness project guidance. `CLAUDE.md` only imports it for Claude
Code. Put recurring portable behavior here and keep harness-specific additions in the relevant
adapter. Do not maintain two substantive copies.

## Mission and architecture

This repository makes personally controlled inference safely useful to replaceable AI Conductors.
It began as a hardware/model evaluation and now owns the production M5 serving, bounded delegation,
and capability-evidence subsystem beneath Grimnir. The steady state is a strong frontier L1 plus
increasingly local, evidence-gated execution—not a weaker local clone for symmetry.

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

The durable research questions are: what the 128GB M5 can serve for one to five users; how
capacity, latency, and residency constrain it; which work belongs on the laptop or smaller fleet
nodes; which model/harness/verifier combinations are trustworthy; how much real user and agentic
work can be offloaded economically; and how L1, Hugin, and node gateways should learn and route
without weakening authority, privacy, availability, or evidence quality. Historical purchase
framing and measured answers live in `RESULTS.md`, `docs/eval-spec-hardware-gate.md`, and
`docs/migration-go-no-go-verdict.md`.

## Vision-to-evidence discipline

When evaluating whether the Grimnir/M5 inference vision is true, blog-ready, worth claiming, or
what would make it truer, answer from principles and evidence—not implementation volume.

The goal is useful proactive work with minimal operator time and in-loop attention, at quality the
operator accepts. The durable pillars are privacy, availability/sovereignty, cost, and a learning
loop in which production paths create evidence that improves routing, policy, or product choices.

Structure such analysis as follows:

1. **Principle -> mechanism -> evidence -> gap.** Cite concrete code, docs, live config,
   dashboards, or DB rows. Label each claim `deployed/enforced`, `deployed/shadow`, `measured`, or
   `aspirational`.
2. **Do not overclaim.** Shadow routes, harvest rows, projected savings, and small samples are
   learning evidence, not proof of production autonomy or ROI.
3. **Make the loop truer before polishing the story.** Propose the smallest measurement,
   dashboard, verifier, instruction, or code change that closes a weak claim.
4. **Keep boundaries explicit.** Separate owner-only learning data from content-blind guest and
   operational telemetry.
5. **Route gaps to their owner.** If another repo owns the correction, file it there rather than
   editing across repository boundaries.

The claim-by-claim source of truth is `docs/vision-evidence-map.md`; the measured steady-state
decision is in `docs/migration-go-no-go-verdict.md`.

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

## Client and harness facts

- Claude Code and Codex are current replaceable L1 surfaces. The planned full-stack comparison has
  separate frontier arms: Claude Code's Opus-to-Sonnet path and Codex; do not describe Codex as an
  Opus-to-Sonnet stack.
- `src/homeserver/mcp.ts` exposes M5 tools to Claude Code, Codex, and other compatible MCP clients.
  Direct authenticated API inference remains valid without MCP or Hugin.
- `scripts/extract-prompts.ts` currently reads Claude Code transcripts under
  `~/.claude/projects`. Codex transcript ingestion is not implemented; do not claim otherwise.
- Economic comparisons may distinguish Claude Max from ChatGPT/Codex access. There is no product
  called "Codex Max"; avoid the old compound label.
- Gate-D evaluates open harness/model combinations under deterministic oracles. Read
  `gate-d/README.md` and `docs/gate-de-evaluation-plan.md` before changing or interpreting it.
- Codex review uses ChatGPT auth, not the OpenRouter key. An OpenRouter quota failure does not prove
  that Codex review is unavailable; check the specific resource.

## Authoritative map

Start with `README.md`, then load only the references needed for the task:

- `docs/architecture.md` — canonical topology, ownership, and learning loop.
- `docs/nomenclature.md` — L1/L2/L3/harness vocabulary.
- `docs/vision-evidence-map.md` — maturity of public-facing claims.
- `docs/trust-and-routing-policy.md` — trust zones and routing precedence.
- `docs/gateway-api-contract.md` and `src/homeserver/README.md` — concrete API/operator surface.
- `docs/observability.md` — content and telemetry boundaries.
- `docs/adr-005-hybrid-steady-state.md` — why frontier L1 plus local leaves is current policy.
- `docs/ROADMAP.md` and GitHub issues — current proof obligations and resumption detail.
- `RESULTS.md`, `docs/eval-spec-hardware-gate.md`, and `docs/migration-go-no-go-verdict.md` —
  benchmark interpretation and hardware/migration decisions.
- `deploy/README.md` — production configuration and deployment runbook.

Source ownership is intentionally discoverable from code rather than duplicated as a volatile file
tree here:

- `src/homeserver/gateway.ts`, `config.ts`, and `model-admin.ts` — service composition and backend.
- `src/homeserver/orchestrator.ts`, `delegate-policy.ts`, `taxonomy.ts` — delegation and routing.
- `src/homeserver/ledger.ts`, `verifier.ts`, `verifier-classification.ts`,
  `routing-table-generator.ts`, and `routing-table-diff.ts` — evidence and generated routes.
- `src/homeserver/keystore.ts`, `quota.ts`, `admission.ts`, `request-log.ts`, `owner-log.ts`, and
  `metrics.ts` — authority, capacity, and telemetry boundaries.
- `src/homeserver/mcp.ts`, `code-loop.ts`, related `code-loop-*` modules, and `pi-engine.ts` — MCP
  and bounded agentic execution.
- `src/homeserver/deep-research.ts`, related `deep-research-*` modules, `citation-verifier.ts`,
  `search-provider.ts`, and `reader.ts` — research harness.
- `src/homeserver/scout-gate.ts`, `model-registry.ts`, and `probe-runner.ts` — model evaluation.

Issue-specific internals, dated measurements, model comparisons, and historical phases belong in
issues and focused documents under `docs/`, not in this always-loaded file. Private deployment
handoffs may use the gitignored local `STATUS.md`.

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

Essential entry points:

```bash
npm run homeserver -- --help
npm run homeserver:serve
npm run homeserver:probe
npm run homeserver:ledger

npm run run:eval -- --batch v1 --models all --tasks all
npm run run:judge -- --batch v1 --judge both
npm run run:analysis -- --batch v1
```

Prompt mining is currently Claude-only:

```bash
npx tsx scripts/extract-prompts.ts
npx tsx scripts/classify-prompts.ts
npx tsx scripts/analyze-prompts.ts
```

## Benchmark and paid-resource discipline

The historical Phase-A OpenRouter results are hosted-proxy upper bounds, not local performance;
label them accordingly. Local M5 compute is the cheap arm, while OpenRouter judges and frontier
references consume a capped resource.

- Estimate paid judge/reference calls before a study and perform irreducible credit-dependent
  validation while quota remains.
- Run a frontier reference once, save it, and reuse it. Judge saved reports; never rerun an
  expensive pipeline merely to re-judge it.
- Prefer local arms and cost-minimal hybrid synthesis when they answer the question. Batch work by
  model to avoid unnecessary cold swaps.
- Keep raw measurements, shadow evidence, and calibrated production conclusions distinct.

See `docs/mac-studio-capacity-model.md`, `docs/deep-research-harness-design.md`, and the dated
benchmark reports under `docs/` for methodology and results.

## Deploying the M5 gateway

The live directory `/srv/gille-inference` is not a Git checkout. Deploy only from a clean,
reviewed `main` and follow `deploy/README.md` plus `src/homeserver/README.md`. The safe baseline is:

```bash
rsync -az --no-perms --omit-dir-times \
  --exclude .git --exclude node_modules --exclude data --exclude .env \
  --exclude '*.log' --exclude debate --exclude .claude --exclude .codex --exclude dist \
  ./ m5:/srv/gille-inference/
```

Never sync `data/` or `.env`; they contain the live database, keystore/credits, logs, and secrets.
Restart `home-gateway` only when gateway/server code or cached portal content changed, then verify
the documented health endpoint. CLI/script-only changes may be zero-downtime. New `bin/invite`
deployments may need their executable bit restored because `--no-perms` drops it.

```bash
ssh m5 'sudo systemctl restart home-gateway'
curl http://<m5-tailnet-ip>:8080/healthz
ssh m5 'chmod +x /srv/gille-inference/bin/invite'
```

`src/homeserver/portal.html` is hand-maintained and cached in memory. Whenever served models,
endpoints, limits, credits/rate policy, or billing dimensions change, update the portal's "What's
running" and "How to use it" sections in the same change and keep `src/homeserver/README.md`
consistent. A portal-only deploy still requires a gateway restart.
