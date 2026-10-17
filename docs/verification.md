# Local verification and hosted check manifest

Run `node scripts/verify-local.mjs` with Node.js 20 or newer from the repository root. It executes
these five repository checks in order, continuing after a failure:

1. `npm run typecheck`
2. `GATE_D_STRICT_PIN=1 bash gate-d/verify-fixtures.sh`
3. `npm test -- --maxWorkers=2`
4. `python3 tests/test_systemone_native_server.py -v`
5. `git diff --check`

The runner uses the existing dependencies and never installs packages or accesses GitHub. Each
child receives only the invoking process's `PATH` value, a newly created short `/tmp` directory as
`TMPDIR`, a new scratch directory as `HOME`, and the strict Gate D pin for that one check. Command output is
kept in the terminal transcript and the exit code, signal, and error are included in the JSON
report. A missing or unlaunchable tool is `unavailable`; a launched command with a nonzero exit is
`failed`. Both fail the overall command, and later checks still run.

The final report lists actual `commandsRan` separately from the workflow manifest and any
`historicalReceiptValidation`. A passing local subset marks the `CI / test` entry
`local-subset-passed` and leaves `hostedStatus` pending. The report always says
`deliveryReady: false`: local verification does not establish a GitHub check or delivery result.

The manifest is derived from the checked-in workflow sources and validates each required
workflow name, trigger, and job set. It fails closed when a baseline workflow or known job is
missing, a workflow identity changes, a new unaccounted workflow appears, or the optional client
workflow has an unrecognized matrix. Check identity is represented by `workflowName` plus
`rawName`; display names containing spaces remain intact. The baseline contains eleven checks:

| Workflow | Raw check name | Event scope |
| --- | --- | --- |
| Bound cgroup stop proof | `cgroup-stop-proof` | `main` push, pull request |
| CI | `Gitleaks` | `main` or `aider-eval/base` push, pull request |
| CI | `test` | `main` or `aider-eval/base` push, pull request |
| Informational code health | `Collect report-only code health` | gated schedule; pull-request conformance; `main` dispatch |
| Fixed host arbitration | `host-arbiter` | `main` push, pull request |
| Observer test-host prerequisites | `native-boundary` | `main` push, pull request |
| Observer test-host prerequisites | `preflight` | `main` push, pull request |
| Native producer activity | `cpp-activity` | `main` push, pull request |
| Native producer channel | `producer-channel` | `main` push, pull request |
| Pinned proxy activity fixture | `proxy-activity` | `main` push, pull request |
| C++ runtime producer channel | `runtime-producer-channel` | `main` push, pull request |

If `.github/workflows/client-compatibility.yml` exists at the invoked revision, the manifest adds
`Client compatibility / Client Node 18` and `Client compatibility / Client Node 22`; it records
the workflow's absence explicitly otherwise. This preserves the distinction between the current
baseline and the separate client compatibility change.

The manifest marks hosted OS/kernel/cgroup proofs, Gitleaks history scanning, and the pinned
upstream proxy fixture as CI-only and unavailable locally. The code-health workflow is
report-only. Pull requests run conformance only; they do not produce the five metric values.
Schedule collection is controlled by `CODE_HEALTH_COLLECTION_ENABLED`; its value is unknown to
this offline command. Only the two cron expressions declared in the workflow are recognized, and
an omitted cron is marked not applicable. Monday static collection or a `main` dispatch depends
on hosted analyzer tools. Unknown or uncollected metric
slots remain unavailable; they are never rendered as a fresh green measurement.

To inspect a manifest without running commands:

```sh
node scripts/verify-local.mjs --manifest-only --event pull_request
node scripts/verify-local.mjs --manifest-only --event push --branch aider-eval/base
node scripts/verify-local.mjs --manifest-only --event schedule --schedule '47 4 * * 1'
node scripts/verify-local.mjs --manifest-only --event workflow_dispatch --branch main --no-collect-static
```

An offline receipt can be checked without querying GitHub by adding `--receipt <json-file>` and
`--head <fresh-40-character-sha>`. The JSON file must contain `checkRuns`, whose entries include
`name`, `workflowName`, `head_sha`, `status`, and `conclusion`. Validation requires a matching
workflow publisher, raw check name, supplied head, completed status, and `success` conclusion for
every applicable check. Missing, neutral, skipped, failed, and in-progress checks remain failures.
Receipt results are historical evidence and are kept separate from commands run in the current
invocation.
