# Informational code-health producer

This directory contains the gille-inference producer for the frozen Grimnir code-health v1
objective contract. It emits a bounded `code-health-v1` artifact; it does not change serving,
inference, routing, packaging, release, or deployment behavior.

The collector emits one exact objective snapshot with all five metric slots, plus a transport
manifest and an evidence index. All references resolve within the artifact or to a bounded source
path and line or numeric GitHub Actions run ID. The artifact contains JSON and Markdown evidence,
not executable files or absolute paths. Analyzer diagnostics are sanitized to repository-relative
paths. `unused_candidates` remains unknown because the #401 graph is unqualified; raw candidates
and the existing manual triage are retained for investigation. Confirmed regressions remain
unknown until a maintainer completes a release-window survey as specified in
[`release-regression-record.md`](release-regression-record.md).

## Collection cadence and scope

The workflow collects first-attempt `push` runs on `main` for the trailing half-open 28-day
window every day. It enumerates the complete Actions run list, checks the workflow file at each
run's commit, and includes only runs that use the current pinned workflow definition. Older
workflow versions are listed as explicit exclusions. Every included run uses attempt 1 even when a
later retry is green. An inaccessible attempt remains visible with unknown job outcomes. More than
1,000 runs, incomplete enumeration, or an unrecognized workflow config produces an unavailable
slot instead of a truncated measurement.

Pull requests run only synthetic producer tests and conformance checks; they do not install
analyzers or collect a report. Daily scheduled runs collect CI metadata only and mark the static
slots unknown with `not-collected`. Complexity, Knip candidates, and scoped TypeScript coverage
run weekly on Monday or on a main-branch `workflow_dispatch` with `collect_static=true`; each
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

Disable collection by removing or reverting `.github/workflows/code-health.yml`; no application
runtime reads these files. To restore the prior state, revert the workflow and this research
directory in a reviewed commit. Verify that scheduled code-health runs stop and that the existing
`.github/workflows/ci.yml` checks remain unchanged. This does not delete previously uploaded
artifacts; they expire under their declared retention period.

The implementation is an informational adoption audit for gille-inference #402, linked to Grimnir
#211. The exact vendored contract source revision and file hashes are recorded in
[`contract-provenance.json`](../../contracts/grimnir-code-health-v1/contract-provenance.json).
