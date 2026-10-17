# Halogen synthetic runtime window

This is the first, non-production load gate for [#317](https://github.com/Magnus-Gille/gille-inference/issues/317).
It does not promote the model, expose an endpoint, or qualify agent usefulness.

## Scope and identities

The operator prepares a private JSON plan accepted by `halogenHostPlanSchema`. It binds a full
runner commit, an expiry, the immutable profile hash, an unprivileged account, a unique 32-hex
run ID, the approved local gateway address, candidate and restoration unit names, the prior experiment's PID/start ticks, binary
hash, exact argv/cwd and model file identity, the exact approved normal resident set, and the
protected service set. Admission must return that resident set and a window ending no later
than the approved expiry; a mismatch ends the attempt before runtime mutations. Keep this plan and
operational receipts outside the public repository. Never put credentials in the plan.

The CLI defaults to a read-only plan. Execution requires the exact approved plan-byte SHA-256
and self-contained executable SHA-256. Each candidate start claims its run identity with an
exclusive file create. Existing units, containers or receipts are not adopted or overwritten.
A plain source invocation cannot execute; use the reviewed bundle.

```bash
node_modules/.bin/esbuild scripts/run-halogen-compatibility.ts \
  --bundle --platform=node --format=esm --target=node22 \
  --outfile=/absolute/private/output/halogen-runtime.mjs \
  --metafile=/absolute/private/output/halogen-runtime-meta.json
node /absolute/private/output/halogen-runtime.mjs --plan /absolute/private/plan.json
```

Before accepting an executable, inspect the build metadata: every external import must be a
Node built-in. Record the full source commit, bundle hash, plan hash and exact launch command
in the controlled-evaluation approval packet. Stage the bundle and the committed
`qualify-halogen.py`, `stage-halogen.py`, and `halogen-candidate.json` under the plan's private
release directory. The verifier and manifest hashes are checked before execution, and all
model artifacts are verified again before opening maintenance. The pinned image must already
be installed; the runtime uses `--pull=never` and cannot install it implicitly.

## Boundaries enforced by the runner

- One 3,600-second maintenance window owns admission and the durable GPU lease; abort work
  600 seconds before expiry. The candidate unit and Podman container each have an independent
  1,800-second hard lifetime.
- Use a transient **system** unit running as the explicit unprivileged owner. This permits a
  unit-scoped 96 GiB locked-memory ceiling without changing the user manager or global limits.
  The same unit enforces 96 GiB total memory, zero swap, 512 tasks and group OOM termination.
- The rootless container has no network, a read-only filesystem, no capabilities, no-new-privileges,
  private IPC, bounded tmpfs mounts, and only the pinned model directory mounted read-only.
  No credential, user home or owner-data mount is passed into the container.
- Verify effective systemd settings, kernel cgroup limits, the candidate process's cgroup and
  privilege restrictions, and the actual container network/rootfs/model mount. The unique run
  identity binds both the unit description and container label; cleanup refuses a conflicting unit.
  Device mappings must be exactly the `/dev/kfd` and `/dev/dri/renderD128` bind
  mounts (source meets destination, never read-only) in the OCI config plus
  the keep-groups annotation — rootless podman reports these instead of
  `HostConfig.Devices`. Pseudo-device mounts are excluded by requiring every
  absolute source to stat as a character device. This is rootless-container
  isolation on a shared host kernel, not a VM or protection against a GPU-driver vulnerability.
- Require a 12 GiB host-memory reserve. Monitor available memory, host OOM count and protected
  service identities during startup and the compatibility request sequence. Inventory GPU users
  with host visibility: permit the named protected services, reject unexpected clients, and require
  both replaceable workloads to leave the GPU before starting the candidate. Protected GPU
  workloads can still affect latency; these probes establish compatibility, not exclusive benchmarks.
- Check the actual API/engine version, slots, context, KV pool, output cap, cache mode, MTP,
  prompt-lookup policy and server defaults. Configuration text alone is insufficient.
- Send synthetic requests only through `podman exec` and container loopback. The API port is
  never published. The maintenance credential stays in the parent process and is excluded from
  command environments and the container.

## Shutdown and restoration

The supervisor snapshots the normal resident set from maintenance admission. It permits only
an empty set or one ready model. The separate prior experiment is stopped through a PID file
descriptor after checking its start identity; a recycled PID must not receive the signal.
Cleanup checks unit and container ownership before mutation. It stops the unit and also stops
the container by its immutable ID, even if the unit is missing or its stop RPC fails. A failed
container stop receives a bounded kill attempt. Both unit and container must be observed stopped
before the prior experiment or normal resident can be reloaded.

An OOM event, protected-service change, unverified shutdown or failed restoration ends the
approved envelope. The supervisor then refuses further model reloads as applicable and retains
exclusion until the original server TTL, reporting failure rather than claiming restoration.
It cannot extend the approved window. Server-side expiry is implemented by
`ExclusiveMaintenanceWindow` in `src/homeserver/maintenance-window.ts` and covered by its expiry
test; failed cleanup reports retention without claiming that future expiry was observed. Further recovery requires a new operator decision under
AGENTS.md. Retaining the window is an explicit optional client behavior; existing maintenance
callers retain their previous unconditional-close behavior.

The stopped candidate container and journal remain available for diagnosis; they hold no GPU
residency. Their exact removal, and any retired restoration unit, must be included in the
approval packet's cleanup scope. Do not remove unrelated containers, volumes, units or branches.

## Qualification limits

Synthetic compatibility is only the first gate. The two new Python fixture tasks under
`benchmarks/halogen` are explicitly synthetic coding tasks, with hidden oracles and reference
implementations kept outside the model's seed paths. CI proves the incomplete seeds fail and
the reference overlays pass. They must be executed through a reviewed caged pilot runner;
this runtime-window script does not run them or replace the historical real-repository corpus.

Streaming/cancellation behavior, sustained tool use, semantic task results, request-budget
evidence, resource restoration and a reviewed production integration remain necessary before
advertising this model as ready for use.
