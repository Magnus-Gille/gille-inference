# Controlled CPU installation admission

Issue [#409](https://github.com/Magnus-Gille/gille-inference/issues/409) replaces an
empty-resident-list assumption with an explicit activity and resource decision. A loaded model
can be idle. Conversely, an empty gateway queue cannot prove that a direct backend caller is idle.

`src/homeserver/controlled-install.ts` provides the pure decision and bounded run lifecycle.
It is operator tooling, not a gateway route, permission grant, GPU lease, or automatic installer.
There is no live host collector in this change. A separately reviewed, approved host adapter must
provide the observations and installation operations below. Existing private rollout packets and
the Halogen evaluation runner retain their original rules; this code does not widen them.

## Decision contract

The strict version-1 plan binds an exact 40-character release SHA, an immutable input-manifest
SHA-256, expiry, enforced memory/CPU/task limits, free-memory reserve, minimum CPU-idle percentage,
and finite observation, work, stop and cleanup timeouts. Unknown fields are rejected. The
schemas exported by the module are authoritative; no implicit policy defaults are applied.

The installation approval must also bind the host, paths, units, launcher, allowed mutations,
artifact checksums, maintenance policy, ownership/cleanup and rollback procedure. The plan is a
subset of that approval, not a replacement for the repository's controlled-evaluation envelope
or fresh production approval. The host adapter verifies these external bindings before admission.

| Evidence | Required condition |
|---|---|
| Gateway | Active requests and queued work are zero; no GPU lease held |
| Direct backends | Complete coverage, zero active and queued requests; unknown blocks |
| Memory | Available bytes at least the entire approved install cap plus the protected reserve |
| CPU | Measured idle percentage at least the explicitly approved minimum |
| Containment | Effective memory, CPU and task limits exactly match the plan |
| Protected services | All active; invocation identities, restart counts and inventory unchanged |
| OOM | Known counter, unchanged throughout the run |
| Identity | Observed immutable release and input-manifest hashes match the plan |
| Maintenance | Observed inactive; unknown or another maintenance window blocks |
| Freshness | Timestamp neither in the future nor older than the approved maximum age |

Free-memory checks deliberately reserve the full install cap again during execution. This can
stop conservatively as the installer allocates memory; no unmeasured reclaim credit is assumed.
The adapter must verify OS limits, not merely echo requested plan numbers. Run the foreground
helper inside an already approved, bounded unit/cgroup; the helper itself does not set limits.

The first accepted observation records the actual prior resident set. `residency: "preserve"`
requires that set to remain unchanged (order is immaterial). `"allow-idle-changes"` permits natural
loading/unloading only while every activity, resource and protection check passes. This broader
predicate must be explicit in the approved packet. Neither mode unloads, reloads or restarts a
model to satisfy a check. Loading transitions with uncertain activity must be reported unknown.

## Host observation contract

`observe(signal)` returns one `ControlledInstallObservation` with source `host-probe-v1` and a
timestamp representing the **oldest** measurement in that observation. The adapter must bound
each read, reject mixed/replaced identities, and cover every backend ingress, including callers
that bypass the gateway. Gateway lease/queue evidence, `/running`, `ready`, and absence of a
single TCP connection are individually insufficient for `backend.coverage: "complete"`.
Use trustworthy active/queued counters or an approved ingress fence; if they are unavailable,
return `coverage: "unknown"` and null counts. Never invent zeros from missing data.

The protected-unit inventory must come from the approved host contract, not whichever services
happen to be returned by a partial query. Bind the release and input hashes to bytes actually
used; do not derive them from a mutable checkout or copy the expected values into observations.
The adapter owns an exclusive installation lock for the whole run, including cleanup. Ordinary
inference is not fenced by this module: new work causes a stop at the next bounded observation.
Keep hard OS resource caps in force during this detection interval and during cleanup.

Polling has a worst-case detection interval of approximately `pollMs + observationTimeoutMs`,
plus event-loop scheduling. It cannot prove absence of requests between observations. This is a
controlled CPU installation contract, not safe admission for competing GPU inference or a model
promotion. Units, files and activation procedures remain separately approved operator work.

## Lifecycle and adapter obligations

Call `runControlledInstall(plan, operations, operatorSignal)` with these operations:

1. `observe(signal)` performs read-only checks. A rejected preflight calls no mutation methods.
2. `run(signal)` starts exactly the approved CPU work. The watchdog observes concurrently; work
   failure, new/unknown activity, drift, caller cancellation, expiry or runtime limit abort it.
3. `stop(signal)` proves all owned processes/services have stopped, including descendants. It
   runs even after successful work. Failure or timeout prevents artifact cleanup and returns
   `restoration-failed`.
4. `cleanup(signal)` removes/restores only artifacts owned by this run, idempotently. It must
   observe cancellation and never start additional work after returning or being aborted.
5. `verifyRestoration(baseline, signal)` independently verifies owned cleanup and preserved
   protected state. A final fresh observation also rechecks the decision against the baseline.

The supervisor reserves separate time for stop, cleanup, restoration verification and final
observation before approval expires. Stop and cleanup receive fresh bounded signals so cancelling
the work does not suppress restoration. It never waits indefinitely for an uncooperative work
promise. An adapter that ignores cancellation must still be contained by an independently
stoppable unit; JavaScript cannot forcibly terminate arbitrary adapter code. Do not use callbacks
that can start delayed work after stop has verified absence. A timed-out observer must be read-only.

`completed` requires successful work and all restoration checks. `rejected` means no work was
started. `stopped` with `restored: true` means work was interrupted and cleanup was proved.
`restoration-failed` requires operator attention and a new approval before retrying. OOM or
protected-service drift always stops the approved envelope, even if owned artifacts were cleaned.
Do not automatically retry a stopped or failed run or silently extend its approval.

`createInstallProcess` in `controlled-install-process.ts` is an optional POSIX adapter for
foreground commands. Wire its `run` and `stop` methods into the operations above. It starts a
dedicated process group, sends TERM on abort and escalates to KILL, including when the parent
has exited but descendants remain. Stop proves the group absent. Output is suppressed and the
environment must be an explicit allowlist. It is not a sandbox: daemonization, `setsid`, service
manager children, remote work and hostile commands require a separately verified unit/cgroup
stop adapter. Never pass credentials in argv or use this helper to run the gateway installer
without its existing release/approval gates.

## Read-only diagnostics

```sh
node --import tsx scripts/check-controlled-install.ts PLAN.json OBSERVATION.json [BASELINE.json]
```

Exit 0 means the supplied fresh evidence passes, 1 means policy rejection, and 2 means usage or
input-read failure. This command performs no installation and grants no authority. It prints only
closed reason codes, observation time and source; malformed inputs never echo content, raw errors
or paths. Saved observations are useful for contract checks, never for live admission. Keep live
plans, observations and baselines in private operator storage, not Git.

The run result also retains bounded `checks.admission`, `checks.stop`, and `checks.final`
diagnostics with the relevant observation time and source. Successful cleanup does not overwrite
the observation that stopped work. An unavailable probe produces a stage-specific failure code
with a null check, rather than a fabricated observation timestamp.

Vitest coverage is synthetic policy/lifecycle evidence and local process cancellation evidence.
It is not a production installation, live backend-activity verification or measured model quality.
