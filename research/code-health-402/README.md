# Informational code-health producer

This directory contains the gille-inference producer for the frozen Grimnir code-health v1
objective contract. It emits a bounded `code-health-v1` artifact; it does not change serving,
inference, routing, packaging, release, or deployment behavior.

The collector emits one exact objective snapshot with all five metric slots, plus a transport
manifest and an evidence index. All references resolve within the artifact or to a bounded source
path and line or numeric GitHub Actions run ID. The artifact contains JSON and Markdown evidence,
not executable files or absolute paths. Analyzer diagnostics are sanitized to repository-relative
paths. `unused_candidates` uses the versioned `knip-consumer-audited-v2` scope in
[`unused-scope-v2.json`](unused-scope-v2.json): it adds the six omitted operator roots and
includes tests, benchmark tools, and gate tooling as consumers. The source-linked reference audit
uses a complete tracked source inventory for those consumers and keeps unresolved or computed
candidate-module loads unknown. Process-launch consumers imported from `child_process` or
`node:child_process` remain unmodeled and keep qualification unknown until their launched source
coverage is proven. Reviewed data enumeration is recorded separately. The code-candidate
domain contains Knip file and export rows; dependency rows stay in raw analyzer evidence and do not
enter the candidate count. A complete inventory with no unresolved candidate-module references can
qualify the graph; otherwise raw Knip rows remain investigation leads and the objective slot stays
unknown. Confirmed regressions remain unknown until a maintainer completes a release-window survey as specified in
[`release-regression-record.md`](release-regression-record.md).

The source-graph AST checks are part of the regular Vitest suite, which runs after dependency installation in main CI. The pre-install producer conformance suite remains dependency-free.

## Collection cadence and scope

The workflow collects first-attempt `push` runs on `main` for the trailing half-open 28-day
window every day. It enumerates the complete Actions run list, checks the workflow file at each
run's commit, and includes only runs that use the current pinned workflow definition. Older
workflow versions are listed as explicit exclusions. Every included run uses attempt 1 even when a
later retry is green. An inaccessible attempt remains visible with unknown job outcomes. More than
1,000 runs, incomplete enumeration, or an unrecognized workflow config produces an unavailable
slot instead of a truncated measurement. Workflow-version checks resolve every distinct run SHA
against its local Git tree in one batch, then hash each unique workflow blob; missing objects use
the existing local resolver and fail closed if still unavailable. This reduces repeated Git
process launches without changing run selection or workflow digest checks. After cohort selection,
first-attempt and job retrieval use a fixed four-run pool. Per-run API calls remain sequential and
retain the existing retry, page, timeout, and shared deadline limits; results and errors are written
in enumeration order. Runs that cannot start before the deadline remain represented with unknown
attempt evidence. The collector does not overlap these requests with static analysis or coverage.

Scheduled collection is skipped unless the repository Actions variable
`CODE_HEALTH_COLLECTION_ENABLED` is the exact string `true`. Pull requests still run only synthetic
producer tests and conformance checks; they do not install analyzers or collect a report. When
enabled, daily scheduled runs collect CI metadata only and mark the static
slots unknown with `not-collected`. Complexity, Knip candidates, and scoped TypeScript coverage
run weekly on Monday. A main-branch `workflow_dispatch` with `collect_static=true` remains available
independently of the schedule variable; each
static run installs the pinned tools and invokes the collector once. The same explicit scope can be
requested before or after an agreed simplification sprint. Complexity uses the #401 ESLint correction configuration at a
threshold of 20 and a separate complete TypeScript executable-function inventory. Coverage uses
the #401 two-test/three-source-file V8 profile; the declared scope includes the unimported
`image-sidecar.ts` file. Static size and 30-day change-frequency context is reported separately
from the five contract metrics.

## Setup, overhead, and artifacts

The static workflow records setup, conformance, dependency installation, analyzer installation,
collector, and total pre-upload elapsed times separately. It applies a 900-second pre-upload
budget to static runs and a 30-second pre-upload budget to metadata-only runs. Exceeding the
workflow budget marks an otherwise valid report partial while retaining its completed inventories.
Collector time is also recorded against its own 30-second metadata and 180-second coverage bounds.
Artifact upload has a three-minute timeout, but its measured duration is visible only in GitHub
Actions step timing. Therefore the recorded budget result covers pre-upload work only; end-to-end
workflow duration including upload remains unknown until the Actions run is inspected.

For an explicit local static smoke test, install the pinned root and analyzer dependencies as
described by the workflow, then run
`CODE_HEALTH_REAL_SMOKE=true node --test research/code-health-402/test-producer.mjs` from the
repository root. Ordinary `node --test research/code-health-402/test-producer.mjs` runs only the
synthetic suite and skips the real analyzer smoke. The #401 local measurements were 7.2 seconds
for the scoped coverage command, 1.92 seconds for corrected ESLint, and 4.4 seconds for Knip;
hosted setup and GitHub API time are measured separately.

Artifacts are versioned with the immutable commit SHA and retained for 30 days as bounded raw
collection evidence. No Munin or Heimdall credentials are exposed to this workflow. The producer
does not claim six-month retained history or a deployed consumer; that requires the respective
owning repository's reviewed adoption work.

## Disable and reverse

Set the repository Actions variable `CODE_HEALTH_COLLECTION_ENABLED` to `true` to enable scheduled
metadata and weekly static collection. Unset it or change it to any other value to disable scheduled
collection. Pull-request conformance and main-branch `workflow_dispatch` remain available in either
state. No application runtime reads these files. To remove the producer entirely, revert
`.github/workflows/code-health.yml` and this research directory in a reviewed commit. Verify that
scheduled code-health runs stop and that the existing `.github/workflows/ci.yml` checks remain
unchanged. This does not delete previously uploaded artifacts; they expire under their declared
retention period.

The implementation is an informational adoption audit for gille-inference #402, linked to Grimnir
#211. The exact vendored contract source revision and file hashes are recorded in
[`contract-provenance.json`](../../contracts/grimnir-code-health-v1/contract-provenance.json).
