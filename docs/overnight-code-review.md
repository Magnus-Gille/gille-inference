# Overnight stability review

This is the starting brief for a review on `m5-agent`: inspect the current code, produce a
prioritized report, and implement a small set of verified improvements in a separate branch.
Halogen and its experiment runners are excluded from this run.

## Start from the published source

Clone the `codex/overnight-code-review` branch of `Magnus-Gille/gille-inference` into a new
directory. Record its full source SHA, then create a new `codex/` branch for the night's changes.
Use the owner's already-configured agent on `m5-agent`; this brief does not install or configure
an agent, model provider, service, or scheduler. Read `AGENTS.md`, `README.md`, and
`docs/ROADMAP.md` before work. Load additional contracts only for the paths under review.

The starting branch combines current `main` with the local code-health consumer-graph audit
and concurrent static analysis. It does not include old deployment proposals or model studies.
The study in `experiments/night_forge` is unrelated to reviewing this repository and is not needed.

## Task to give the agent

> Review this repository for stability and maintainability, then implement a small set of
> evidence-backed improvements on a new `codex/` branch. Work for at most eight hours from your
> start time; finish earlier when the useful verified work is complete. Reserve the final hour
> for checks, review, and the report. Do not fill the time with speculative edits.
>
> Establish the baseline before changing code: record the immutable source SHA, working-tree
> status, tool versions, typecheck and test results, with baseline failures kept separate.
> Follow the repository's delegation rules for bounded source exploration, implementation,
> and checks. Keep integration, security-critical decisions, and final acceptance with the
> Conductor. Use only existing configured routes and respect their effective permissions.
>
> First map important request and job lifecycles, cancellation and timeout paths, resource
> ownership and cleanup, error propagation, input validation, state transitions, and persistence
> boundaries. Inspect tests alongside source. Prioritize reproducible failures and fragile
> runtime behavior, then focused simplifications that make those paths easier to verify.
>
> Use the informational code-health tools as supporting evidence. Knip rows are investigation
> leads; verify callers in tests, scripts, benchmark tooling and dynamic imports before deciding
> that code is unused. Unknown graph qualification remains unknown. The existing coverage
> profile covers two tests and three source files; it is not whole-repository coverage.
> Missing analyzer dependencies or GitHub metadata must be reported, not replaced by invented
> measurements. Do not enable scheduled collection or change repository Actions variables.
>
> Exclude Halogen, `data/`, `.env*`, secrets, private operator handoffs, and unrelated repositories.
> Do not run inference, benchmarks against live services, production probes, deployment commands,
> installers, model downloads, migrations, or service/configuration changes. Keep tests local
> with synthetic fixtures and no production credentials. Dependency setup must satisfy the
> owner's isolation and dependency-source rules; if that setup is unavailable, record the gap
> and continue source review that does not depend on it.
>
> Fix only bounded defects with a clear trigger, impact, and acceptance check. Reproduce each
> behavioral defect with a failing regression test, then fix it and run focused checks. Preserve
> API contracts, authentication, routing authority, telemetry privacy, deployment safeguards,
> and unrelated work. Leave architectural changes and policy changes as proposals. Do not
> weaken tests or safety controls, add dependencies, or perform broad formatting rewrites.
>
> Keep changes reviewable in small commits with source and tests together. After deterministic
> checks, obtain independent cross-model review under the owner's review policy; validate each
> finding and report unavailable review capability. Rerun affected checks after corrections.
> Do not push, open PRs, merge, deploy, or modify another repository during this run.
>
> Finish with `docs/overnight-review-report.md`: source and final SHAs; baseline versus final
> checks; findings ranked by impact with concrete triggers and source references; fixes made;
> declined findings and why; remaining proposals; review identity and limitations; and exact
> commands to reproduce the evidence. Include actual delegation outcomes and model/effort
> observations, distinguishing requested settings from unavailable runtime metadata. Keep
> secrets, raw runtime data, and machine-specific operational details out of committed reports.
> Clearly distinguish implemented and verified changes from suggestions.

## Useful local checks

With the declared project dependencies already available:

```sh
node --test research/code-health-402/test-producer.mjs
npm test -- tests/code-health-unused-graph.test.mjs
npm run typecheck
npm test
git diff --check
```

Use bounded test concurrency appropriate to the host. The collector is optional and its setup,
scope, budgets and missing-evidence behavior are documented in
[`research/code-health-402/README.md`](../research/code-health-402/README.md).
Synthetic conformance checks do not prove a successful real analyzer collection.

The endpoint of the overnight run is a local report and reviewed commits on `m5-agent`.
Publication and integration of those new commits are a separate owner decision.
