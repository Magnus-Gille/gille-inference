# Native code-loop recovery fixture

This fixture is for disposable GitHub-hosted Ubuntu workers only. It is not an installer for M5.
The accepted source uses the real gateway constructor, MCP dispatch, required-confinement runtime,
systemd user-manager transport, pasta, bubblewrap and owner check command. Pi/model answers and
the backend catalogue are explicitly synthetic; no model inference or inference-quality evidence
is produced. A fresh caller run ID is used for each phase so durable retries cannot mask the outage.

Declared resources before the reviewed workflow runs:

| Resource | Exact fixture target |
| --- | --- |
| Tree | /run/gi-code-loop-recovery-fixture |
| Account/UID | gi-code-loop-ci / 62056; existing identity refuses execution |
| Parent slice | girecovery.slice; 2 GiB, no swap, two CPU quota, 128 tasks |
| Manager/runtime | user@62056.service and user-runtime-dir@62056.service; only UID-specific drop-ins |
| Gateway/canary/driver | gi-recovery-gateway.service, gi-recovery-canary.service, gi-recovery-driver.service |
| Gateway/relay | fixture-only loopback ports 18457 / 18456; backend selects a fresh loopback port |
| Immutable payload | git archive HEAD; launcher/driver hashes and exact source SHA saved with artifact |
| Limits | job 15 minutes; fixture 300 seconds, driver 180 seconds, restart gate 30 seconds |

Manager recovery and gateway hardening are rendered from the existing source templates in isolated
subshells. The manager is the distribution's actual user manager with its normal delegation; gateway
hardening is not inherited by caged transient services. The runtime directory remains alive, and
the gateway mounts that directory rather than a socket inode.

The baseline and recovered jobs each perform the real confinement self-test, synthetic Pi execution,
and owner check. Between them the driver kills only the dedicated manager main process. A test-only
ExecStartPre gate makes the automatic restart's outage deterministic; no manual start/restart is used
for recovery. The driver checks the exact missing-transport refusal, no work ID, restart count,
unchanged gateway process start identity, stable runtime-directory inode and untouched fixture canary.
It rejects broadening or weakening confinement to pass. A missing native prerequisite is a failure.

Dependency setup uses the repository lockfile with lifecycle scripts disabled and an explicitly
inspected SQLite build through the existing npm/node-gyp toolchain and the setup-node runtime's
bundled read-only headers. No prebuilt-binary or header download is allowed by this fixture build.
Native packages come from the worker's official Ubuntu sources. No personal HOME, keys or live state
enter the fixture. The private synthetic client key file is removed and is never an uploaded artifact.

Cleanup stops only declared fixture units, checks zero unit PIDs and an empty remaining slice, disables
only fixture-created lingering and removes only created configuration/account/tree. Incomplete cleanup
fails the job. An independent workflow step checks cleanup evidence, missing task tree/account and
preserves exact source/launcher receipts. The test runner itself is disposable.

The conductor records each full hosted fixture attempt against the owner's six-attempt limit.
No production service, GPU/model, user credentials, repository setting or deployment is authorized here.
