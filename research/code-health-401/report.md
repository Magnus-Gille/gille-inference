# Code-health exploration #401

This report is a bounded exploration against frozen main `7a169653afb67cc55284126f7602c257bd04591f` (2026-10-09). It does not change runtime code, CI configuration, release configuration, or production state.

## Scope and reproducibility

The language inventory covers `src/**/*.ts`, `scripts/**/*.ts`, `scripts/**/*.mjs`, and `client/**/*.mjs`: 271 TypeScript files and 10 JavaScript modules (6 client, 4 scripts), plus 10 Python files and 11 shell scripts. ESLint complexity applies only to the 271 TypeScript files; its 275 processed rows also include four JavaScript script rows without configured complexity rules. The trial tooling is isolated under `research/code-health-401/tooling/`; its exact top-level versions are recorded in `tooling/package.json` and the lockfile. The repository package and lock were not modified.

Installation provenance: these task-local packages were absent from PATH, so this leaf installed the pinned analyzer set with npm into `research/code-health-401/tooling/` after the sandbox-only attempt could not reach the registry. The exact command was `npm install --prefix research/code-health-401/tooling --save-dev --save-exact --ignore-scripts knip@5.46.0 eslint@9.39.1 @typescript-eslint/parser@8.62.1 @typescript-eslint/eslint-plugin@8.62.1 c8@10.1.3`, followed by task-local resolver inputs (`vitest@3.2.7`, `better-sqlite3@12.8.0`, `openai@4.104.0`, `tsx@4.19.0`, `zod@3.23.8`, `typescript@5.7.3`). No credentials, `.env` files, secrets, runtime package manifests, or external state were touched. These versions are analyzer-trial provenance; the valid rerun must record the supported execution Node and the root `npm ci` dependency versions separately.
The coverage provider was installed by the owning root agent in an isolated task-only directory, with its pinned `package.json` and lockfile copied to `coverage-tooling/` for reproduction; this leaf did not install it. No dependency was added to the runtime package or lockfile.

The analyzer baseline and rejected Knip setup attempts used these commands from the checkout root. Knip setup failures are retained as rejected history; ESLint measures syntax independently of runtime import resolution. The accepted corrected ESLint configuration is `eslint-correction.config.mjs` (threshold 20); use that path when reproducing the accepted count. `/usr/bin/time -p` `real` is the elapsed wall-clock measure; output bytes are measured with `wc -c` after each command.

```text
research/code-health-401/tooling/node_modules/.bin/eslint \
  --config research/code-health-401/eslint.config.mjs --no-warn-ignored \
  --format json src scripts

research/code-health-401/tooling/node_modules/.bin/knip \
  --config research/code-health-401/knip.json --tsConfig tsconfig.json --production \
  --include files --include dependencies --include exports --reporter json \
  --no-progress --no-exit-code

# Rejected correction pass: production-only mode with unproven project graph.
research/code-health-401/tooling/node_modules/.bin/knip \
  --config research/code-health-401/knip-root-correction.json --tsConfig tsconfig.json --production \
  --include files --include dependencies --include exports --include-entry-exports \
  --reporter json --no-progress --no-exit-code

# Valid Knip setup to run after root npm ci: normal mode for file/export graph.
research/code-health-401/tooling/node_modules/.bin/knip \
  --config research/code-health-401/knip-valid.json --tsConfig tsconfig.json \
  --include files --include dependencies --include exports --reporter json \
  --no-progress --no-exit-code

# Separate production dependency view from the same explicit entrypoints.
research/code-health-401/tooling/node_modules/.bin/knip \
  --config research/code-health-401/knip-valid.json --tsConfig tsconfig.json --production \
  --include dependencies --reporter json --no-progress --no-exit-code

research/code-health-401/tooling/node_modules/.bin/c8 --all \
  --include 'research/code-health-401/fixtures/coverage-probe/*.mjs' \
  --reporter json-summary --reporter text \
  --report-dir research/code-health-401/artifacts/baseline/c8 \
  node research/code-health-401/fixtures/coverage-probe/driver.mjs
```

The correction pass changed the complexity threshold from 10 to 20 and changed Knip to explicit production entrypoints with `!` suffixes. It reduced complexity warnings from 429 to 152. The Knip results are rejected as evidence: the checkout initially lacked its real `node_modules`, and the isolated project patterns did not prove the production graph. The four dependency rows and entry-file exports therefore remain unknown until Knip is rerun against the real installed manifest and a validated entrypoint/project configuration. No unused-file conclusion is accepted from this attempt. This is a review report, not an automatic deletion recommendation.

The valid Knip rerun used Node 22.23.3, the restored root npm-ci tree with the locked native `better-sqlite3@12.8.0`, `knip-valid.json`, normal mode for the file/export graph, and a separate `--production --include dependencies` view. Both exited 0 in 4.40 seconds. Normal mode found 101 candidate files and 453 export/dependency rows; the ten highest review candidates by file listing were `scripts/analyze-prompts.ts`, `scripts/benchmark-deep-research.ts`, `scripts/cascade-gate-experiment.ts`, `scripts/classify-prompts.ts`, `scripts/concurrent-benchmark.ts`, `scripts/constitutional-recovery-service.ts`, `scripts/dr-ablation-judge.ts`, `scripts/dr-ablation-tongyi.ts`, `scripts/dr-ablation.ts`, and `scripts/dr-experiment.ts`. The first ten export candidates were `client/m5-client.mjs:REQUIRED_AGENT_TOOLS`, `client/m5-client.mjs:defaultAdoptionSpoolDir`, `client/m5-client.mjs:askRefusalFromMeta`, `client/m5-client.mjs:probeTailnetStatus`, `client/m5-client.mjs:defaultTailnetProbe`, `client/m5-provision.mjs:createCommandRunner`, `client/m5-provision.mjs:ensureProvisionProfile`, `client/m5-build.mjs:defaultBuildConfigPath`, `client/m5-build.mjs:createBuildArchive`, and `src/homeserver/strix-benchmark.ts:normalizeLlamaBenchRows`. These are unknown review candidates because package scripts, dynamic imports, tests, and direct client consumers are outside a simple production graph. The production dependency view reported four rows (`better-sqlite3`, `openai`, `tsx`, `zod`); source imports and package scripts confirm they are used, so this dependency result is also unknown/configuration-sensitive rather than a removal recommendation.

The first real Vitest attempt used CLI include flags but left a broad default instrumented set, so its 72,842-line aggregate is rejected setup history. The single correction pass uses the reproducible `vitest.coverage.config.mjs` config, which sets the repository root, exactly two test files, and exactly three eligible source files. With Node 22.23.3, Vitest `3.2.7`, the isolated `@vitest/coverage-v8@3.2.7` provider, and the restored root npm-ci tree, the command below passed 34 tests in 2 files, exit 0, in 7.20 seconds wall time (Vitest reported 5.56 seconds):

```text
PATH=/private/tmp/code-health-explorations-20261009/node22/node_modules/node/bin:$PATH \
  /usr/bin/time -p node_modules/.bin/vitest run \
  --config research/code-health-401/vitest.coverage.config.mjs
```

The scoped result is 246 lines/186 covered (75.6%), 26/25 branches (96.15%), and 8/6 functions (75%). It reports `errors.ts` at 98.28% lines, `task-type-identity.ts` at 70%, and the explicitly eligible but unimported `image-sidecar.ts` at 0% of 51 lines. This is useful report-only coverage evidence; adopt the bounded config for exploration, then adjust it to the repository's eventual owned test scope before any CI gate. No gate is proposed here.

## Findings

The complexity analyzer's ten highest candidates after correction were inspected. “Useful” means a bounded review target; “false-positive” means the metric is structural and should not trigger a refactor by itself; “unknown” requires owner review.

| Candidate | Complexity | Classification |
|---|---:|---|
| `src/homeserver/gateway.ts:4404` | 312 | false-positive structural route/handler aggregation |
| `src/homeserver/autonomy-contract-v1.ts:270` | 153 | unknown; closed validation logic |
| `src/homeserver/autonomy-controller.ts:1508` | 117 | unknown; policy orchestration |
| `src/homeserver/m3-qualification.ts:810` | 104 | useful triage target |
| `src/homeserver/roster-proposal.ts:1196` | 102 | unknown; decision logic |
| `src/homeserver/gateway.ts:3978` | 101 | useful triage target |
| `src/homeserver/model-registry.ts:75` | 94 | unknown; type guard aggregation |
| `src/homeserver/code-loop.ts:938` | 90 | useful triage target |
| `src/homeserver/mcp.ts:827` | 88 | useful triage target |
| `src/homeserver/cli.ts:441` | 85 | unknown; command/key-management branching |

Three sprint-sized follow-ups have both high complexity and recent churn (from `git log --since=2026-09-01 --numstat`):

- `m3-qualification.ts`: complexity 104; +1,354/-26 lines across 2 commits. Split validation phases only with focused regression fixtures and preserve fail-closed outcomes.
- `code-loop.ts`: complexity 90; +910/-100 across 6 commits. Extract one lifecycle boundary at a time and retain the existing telemetry/coverage semantics.
- `gateway.ts`: `handleRequest` complexity 101; +604/-60 across 12 commits. Use route-family helpers with request/auth/error regression coverage; leave the larger 312 score as an architectural review question.

The c8 probe is a tooling sanity fixture only. It confirms that `--all` includes eligible source that is never imported (`unimported.mjs` appears with 4/4 lines and 1/1 function at 0% coverage), but it is not evidence about the repository's TypeScript source coverage. The final Vitest trial supplies the real TypeScript evidence with a pinned supported Node/tool manifest and an explicit eligible include set containing unimported source.

## CI and release regression data sources

The first regression evidence sources are local and deterministic: `.github/workflows/ci.yml` runs pinned checkout/setup actions, `npm ci`, `npm run typecheck`, strict Gate-D fixture verification, `npm test`, and the Python native System One adapter test. Release-side sources are the package `release:check-client` script (`scripts/verify-client-package.mjs`), client package smoke tests, and the deployment runbook under `deploy/`.

For a concrete CI starting point, the sanitized artifact `artifacts/ci-runs-sanitized.json` records the read-only GitHub Actions endpoint query `repos/Magnus-Gille/gille-inference/actions/workflows/ci.yml/runs?branch=main&per_page=20` fetched at `2026-10-09T08:21:12.828324+00:00`. It is the latest 20 `main` workflow runs, not a complete historical cohort (`total_count=215`), and all 20 rows have `run_attempt=1`; the rows are 17 successes, 1 failure, and 2 cancelled runs. The conservative first-attempt cohort definition is: select one workflow (`ci.yml`) and branch (`main`), retain only `status=completed`, count only `conclusion=success|failure` in the denominator, report cancelled/in-progress separately, and never let a later retry hide a first-attempt failure. For every listed row with `run_attempt > 1`, retrieve `GET /repos/Magnus-Gille/gille-inference/actions/runs/{run_id}/attempts/1` and use that attempt's status/conclusion, not the latest row. A missing/inaccessible first-attempt record remains unknown and is excluded from the success/failure denominator with its count visible. Persist run ID, first-attempt number, head SHA, event, workflow and observation time so repeat collection is idempotent. Event type (`push` here) is reported separately. A release-regression cohort still needs release/tag or package-publication records and human-confirmed regression links; those are unknown in this bounded trial. This exploration did not run CI, publish a package, deploy, or mutate external state. The analyzer results therefore remain source-trial evidence, not CI or release qualification.

## Native, Python, and shell limits

`better-sqlite3` is the native runtime dependency; CI documents its Node 22 prebuilt/node-gyp path. TypeScript/ESLint/Knip do not analyze Python or shell behavior. A read-only Python AST parse covered all 10 Python files successfully. `shellcheck scripts/*.sh` exited 1 with four existing diagnostics: one `SC2155` warning and `SC2094`/`SC2016` informational findings. No shell edits were made. Child-process and native adapter boundaries remain outside the TypeScript graph and require their own checks.

## Decisions and artifact overhead

- Complexity: adjust to review-only reporting; do not adopt a CI gate from a single threshold. Keep an explicit threshold and inspect the top ten with churn and ownership context.
- Knip: adjust to explicit production entrypoints; retain tests, dynamic loaders, package scripts, and config review before removing anything. Do not use `--fix`.
- Coverage: adopt as a bounded report-only trial using `vitest.coverage.config.mjs`; the explicit scope passes and includes the unimported `image-sidecar.ts` row at 0%. Adjust the source/test inventory before considering a CI gate.
- Python/shell/native inventory: adopt as separate checks; do not fold them into the TypeScript analyzer result.

Measured baseline/correction elapsed times were 1.98/1.92 seconds for ESLint and 0.93/0.79 seconds for Knip. The toy c8 probe took 0.30 seconds; the rejected broad Vitest attempt took 4.02 seconds wall time, and the final scoped Vitest run took 7.20 seconds (Vitest 5.56 seconds). Human-readable c8 output was 624 bytes and the JSON summary 1,382 bytes; the final scoped Vitest summary is 1,321 bytes plus 1,095 bytes of text output. Raw analyzer JSON was 4,190,224 bytes (baseline ESLint), 2,979,864 bytes (correction ESLint), 122 bytes (baseline Knip), and 1,702 bytes (correction Knip); raw JSON is retained only in the ignored task-local `artifacts/raw/` directory and is reproducible with the commands above. The committed machine-readable sample is `artifacts/sample.json`; it records the valid Knip rerun and final scoped Vitest metrics. The sanitized CI source is 8,094 bytes and contains run metadata only.

## Clean-checkout reproduction and use

Use an artifact-bearing revision, for example `f4462ce4d9b5df3f78ae36cb211905680a57059f` or the merged revision of this PR, and a supported Node 22 runtime. The measured source baseline `7a169653afb67cc55284126f7602c257bd04591f` predates this research directory and cannot reproduce the trial by itself. Before running, require `git diff --exit-code 7a169653afb67cc55284126f7602c257bd04591f -- src scripts client tests package.json package-lock.json tsconfig.json vitest.config.ts` to pass; later application changes require a new baseline. Install the root and two isolated tool trees from their committed locks; the link below makes the separately pinned provider discoverable to the root Vitest without re-resolving application dependencies. Do not use a root `npm install --no-save` for the provider: that can drift loose dependency versions away from the source lock.

```sh
npm ci
npm ci --prefix research/code-health-401/tooling --ignore-scripts
npm ci --prefix research/code-health-401/coverage-tooling --ignore-scripts
ln -s ../../research/code-health-401/coverage-tooling/node_modules/@vitest/coverage-v8 node_modules/@vitest/coverage-v8
node_modules/.bin/vitest run --config research/code-health-401/vitest.coverage.config.mjs
research/code-health-401/tooling/node_modules/.bin/eslint --config research/code-health-401/eslint-correction.config.mjs --no-warn-ignored --format json src scripts
node research/code-health-401/verify-sample.mjs
```

The symlink command assumes a fresh `npm ci` tree with no existing coverage provider. Runtime scope is macOS arm64 with Node 22.23.3; exact OS metadata is in the sample. Python/shell inventory counts include scripts rather than promising behavioral coverage.

Start with one report per week and before/after an explicitly scoped simplification sprint. The observed analyzer and selected-test times are local wall time; hosted runner overhead remains unknown. Keep source/test/config versions and denominators visible, and compare a repo only to its own same-scope history. Defer publishing a dead-code total from Knip until its entrypoint and dependency graph passes sanity checks. A missing or unusable reading is unknown, never zero.

Audit consists of the immutable source revision, committed configurations/locks, the sanitized sample and source references, and the PR review/check receipts. Reversal is a normal reviewed revert of `research/code-health-401/`; no service, installed skill, runtime dependency, or CI gate depends on this directory. Disposable tool installs can be removed with their task worktree after review; preserve unrelated files.

## Manual unused-candidate review

`artifacts/knip-triage.json` records ten runtime-sensitive file/export candidates selected by operational reach and recent churn, with exact import/test references. Eight are false positives (omitted operator entrypoints or exports intentionally used by tests); two remain uncertain ownership/export-surface questions. No unreachable implementation was proved. The concrete `cli.ts -> gateway.ts` call chain and direct runtime-package imports reinforce that this graph is not ready to produce a trustworthy dead-code total. The candidate count 101 is raw analyzer output, not 101 dead files.
