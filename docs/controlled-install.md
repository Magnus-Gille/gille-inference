# Controlled CPU installation admission

Issue [#409](https://github.com/Magnus-Gille/gille-inference/issues/409) replaces an
empty-resident-list assumption with an explicit activity and resource decision. A loaded model
can be idle. Conversely, an empty gateway queue cannot prove that a direct backend caller is idle.

`src/homeserver/controlled-install.ts` provides the pure decision and bounded run lifecycle.
It is operator tooling, not a gateway route, permission grant, GPU lease, or automatic installer.
The read-only activity diagnostic below samples configured runtime schedulers and the GPU mutex.
It is not a complete host collector. A separately reviewed, approved host adapter must provide
the remaining observations and installation operations below. Existing private rollout packets and
the Halogen evaluation runner retain their original rules; this code does not widen them.

`install-backend-inventory.ts` and `install-coverage.ts` now define the accepted inventory,
receipt reconciliation and bounded adapter interface for that missing coverage. They do not supply
a deployed host adapter or discover a complete host boundary. The offline checker below validates
the consistency of supplied evidence; it cannot authenticate it or authorize an installation.

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
   protected state. A final fresh observation checks restoration against the baseline: release/input
   identity, expiry, protected service health/invocations/restarts, OOM counters and residency policy.
   New customer activity or admission headroom after proven stop do not make restoration fail.
   Maintenance must remain inactive: the installation owns arbitration until restoration finishes.
   Admission and the running watchdog still enforce all activity/resource/maintenance predicates.

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

### Activity and recorded GPU-lock owner

Run on the host that owns the lease directory and direct runtime ports, using explicitly verified
operator bindings. These example paths and ports are placeholders, not a live deployment map:

```sh
node --import tsx scripts/observe-install-activity.ts \
  --lease-dir /absolute/approved/lease-directory \
  --backend runtime-a=http://127.0.0.1:8081/metrics \
  --timeout-ms 2000
```

The command only reads. It does not enable metrics, load/unload models, acquire/reclaim locks,
restart services or perform installation. It has no credential input. Backend URLs must be
literal loopback HTTP addresses with an explicit port and exactly `/metrics`: no DNS, userinfo,
queries, fragments or redirect following. Verify that each port serves the intended **direct
runtime**, not a proxy/router which can load models. Syntax alone cannot prove runtime identity.
At most 16 targets are accepted; each request and filesystem observation defaults to a 2-second
deadline (configurable up to 30 seconds), and each metrics body is limited to 128 KiB.

The parser requires exactly one unlabelled, nonnegative safe-integer sample and one `gauge` TYPE
declaration for both `llamacpp:requests_processing` and `llamacpp:requests_deferred`. Missing,
malformed, duplicate or incompatible data yields null counts and a closed reason code.
llama.cpp documents these as scheduler gauges behind `--metrics`; `/running` in llama-swap
describes resident processes, not equivalent active/queued request counts. See the upstream
[llama.cpp metrics contract](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#get-metrics)
and [llama-swap API](https://github.com/mostlygeek/llama-swap#api). These references do not prove
the versions or flags on an installed host.

Each backend sample includes start/completion times and source `llamacpp-metrics-v1`. The report
always retains `coverage: "unknown"` with scope `configured-runtime-schedulers`, even if every
configured runtime reports zero. It cannot see requests waiting upstream, model-loading transitions,
unlisted runtimes or traffic between polls. An approved host adapter must prove inventory, process
identity and complete ingress coverage before supplying `backend.coverage: "complete"` to the
installation guard. Do not copy these per-runtime zeros into whole-host counts.

The GPU observer reads `.holder/owner.json` under the specified existing lease directory. A
present mutex is occupied even with a stale, missing, oversized or invalid owner marker (including
an owner-file symlink). Missing lease roots, symlink root/mutex entries and metadata changes during
the sample yield unknown; the observer never
creates or repairs evidence. The returned UUID, PID and heartbeat describe the **recorded** owner,
not OS process liveness. Output omits hostnames, paths, URLs and raw error/response content.
Directory absence is a momentary observation, not a GPU-idle guarantee or reservation. Use the
real configured local directory; a valid but unrelated empty directory cannot prove anything.
The existing `gpu status` command now labels the actual mutex separately from FIFO tickets; its
ticket list and mutex observation are separate samples, not an atomic ownership snapshot.

Exit 0 means the mutex state and all configured scheduler samples were observed, even if busy;
1 means at least one observation is unknown or no runtime was configured; 2 means invalid input
or an unexpected collector failure. None means installation admission. Its diagnostic schema
deliberately differs from `host-probe-v1`. An unresponsive filesystem read can outlive its deadline,
but performs no mutation. Keep reports in private operator storage, never Git.

### Sampled process and listener identity

On little-endian Linux, add one `--runtime ID=PID` for **every** backend to bracket the
metrics request with process/listener observations. For example, append `--runtime runtime-a=1234`
to the command above, using the independently identified runtime PID. This is an optional stronger
diagnostic mode; the original command remains an unbound scheduler observation. Duplicate or
unmatched mappings are rejected before observation.

The collector reads the boot ID, process start ticks, PID/network namespace links, executable
file metadata, TCP listener tables and the declared process's descriptor links. It requires the
collector and runtime to share PID/network namespaces, exactly one listener on the specified port
across IPv4 and IPv6, the exact loopback binding, and a matching socket descriptor in that process.
Wildcard listeners, unreadable/missing IPv6 tables, competing listeners, unsupported platforms,
permission errors and changes between samples fail closed. It never reads `cmdline`, `environ`,
executable bytes or loaded libraries, and never emits descriptor paths, raw boot IDs or raw errors.
The parser follows the [Linux proc documentation](https://docs.kernel.org/filesystems/proc.html)
and [TCP table format](https://docs.kernel.org/networking/proc_net_tcp.html); TCP queue fields are
not inference request counts.

Each collection compares two samples and returns opaque SHA-256 fingerprints. Metrics are
retained only when collections before and after the HTTP request agree. `--expect-host SHA256`
and `--expect-runtime ID=SHA256` can additionally pin fingerprints from an independently accepted
observation. A reboot, process restart, executable-metadata change or listener replacement invalidates
the corresponding pin. Pins establish equality with that accepted sample, not trust by themselves.
Without a pin, a stable identity is only observed. The host fingerprint identifies a sampled boot,
not an authenticated machine or durable hardware identity.

The executable fingerprint uses device/inode/mode/size and nanosecond modification/change times;
it is **not** a binary hash or immutable release attestation. A listener descriptor can be shared
or inherited, so holding it does not prove exclusive request handling or that the process is
llama.cpp. Bracketing is not an atomic reservation and cannot exclude changes between observations.
An operator must still establish the intended direct runtime before probing its `/metrics` route.

Reads are capped at 64 KiB for process stat, 1 MiB/4096 rows per TCP table and 1024 descriptors per
process. Bound observation has a shared deadline for identity checks and HTTP activity; an expired
operation cannot start subsequent checks. An in-progress read may finish later without mutation.
All fixtures are synthetic; live host validation remains outstanding. This mode still reports
`coverage: "unknown"`. It does not discover the complete runtime inventory, account for proxy
queues or loading, fence ingress, or satisfy installation admission.

### Installation contract checker

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

## Complete inventory and traffic coverage contract

Completeness needs an independently accepted host boundary. A list of endpoints supplied to the
metrics CLI, a public model catalog, `/running`, an empty gateway queue or stable process fingerprints
cannot establish that boundary. Do not relabel these observations as end-to-end work counters.

The strict `installBackendInventorySchema` describes a graph of logical backends and ingress paths.
Backends include runtime processes and sidecars; ingress kinds are gateway, proxy, direct and lifecycle.
Every backend requires both a direct and a lifecycle path, even if an approved fence makes one
unreachable. Loading, unloading, process spawning, warm-up and work initiated without a network
request belong to the lifecycle path. Shared paths can link multiple backends. Links must be symmetric,
all references must resolve, and IDs and links must be unique. Limits are 64 backends and 128 paths.

`hashInstallBackendInventory` hashes a versioned canonical representation, sorting copies of all
IDs and links. Ordering does not affect the hash; host boot, topology and kind changes do. The
separate accepted binding pins this hash, a `boundaryIdentitySha256`, an expiry and maximum observation
age (at most 60 seconds). Accepting these values is an operator/host-adapter obligation outside this
library, not an authority conferred by a JSON file.

The boundary fingerprint must cover the separately reviewed physical mapping and isolation contract:
owning host/namespaces, service and runtime managers, effective configuration bytes, producer-to-ID
bindings, all inference ingress and any exclusions or enforced fences. The logical graph hash alone
does not bind ports, services or executable bytes. A boot fingerprint is equality evidence, not
authenticated machine identity. The host adapter must verify the physical contract independently;
copying expected digests or zero counts into a receipt is not measurement.

### Evidence required for every sample

`evaluateInstallCoverage` accepts two full `host-inventory-v1` receipts bracketing all activity
receipts. Both inventories must match the accepted host boot, topology digest, boundary digest and
exact backend/path ID sets, with zero unclassified backends **and** ingress paths. Unknown counts,
duplicates, omitted or extra members, stale/future samples, changes or an expired binding block
complete coverage. All activity timestamps must lie inside the inventory bracket. The oldest sample
is returned for downstream freshness checks.

Every backend and every path needs exactly one receipt. Its producer identity must be non-null and
unchanged before/after its measurement, and it must bind the same boot and inventory. Activity counts
are nonnegative safe integers for active, queued **and loading** work. An unavailable counter is null,
not zero. The source names specify semantic obligations, not mere string tags:

| Receipt source | Required host-adapter proof |
|---|---|
| `backend-work-v1` | All work in that backend, including already accepted work after client disconnect/timeout and loading transitions; scheduler gauges alone do not meet this contract. |
| `backend-stopped-v1` | Independently verified process absence with stable lifecycle-manager identity and no pending/active/loading work; its lifecycle and direct paths still need receipts. |
| `ingress-work-v1` | The entire mapped path, from accepting/queueing a request through backend settlement, including automatic loads and non-HTTP producers. Gateway fetch completion is not backend settlement. |
| `ingress-fence-v1` | An approved, enforced fence covering the whole mapped path, unexpired at evaluation, with existing active/queued/loading work independently proved drained. An enabled flag or an empty socket table is insufficient. |

`coverage: "complete"` means these supplied receipts satisfy the accepted graph contract.
`activity: "idle"` additionally requires all counts to be zero. Fully observed nonzero work returns
complete/busy, while missing or contradictory evidence returns unknown with closed reason codes.
Counters at successive stages can overlap, so the report does **not** sum them into invented request
totals. The checker emits only validated topology IDs after the graph hash/expiry binding passes;
raw errors and rejected input are omitted. Keep reports and actual host contracts in private storage.

### Current source map and remaining live integration

The following are code/config surfaces, not a claim about current deployment:

| Surface | Why the existing observation is insufficient |
|---|---|
| Primary llama-swap / legacy LM Studio (`model-admin.ts`) | The facade covers only the primary backend. `/running` is residency, not a full request/lifecycle queue. The repository llama-swap YAML is a manually synchronized mirror. |
| Embedding sidecar (`config.ts`, embedding systemd templates) | Separate service/endpoint; it must be inventoried even when omitted from a primary-backend snapshot. Readiness is not absence of work. |
| System One, image/audio and other configured direct providers | Configuration, process placement and actual producer paths must be reconciled separately, not inferred from the public model catalog. |
| Remote providers such as ORIN | Exclude only when the approved boundary independently proves they cannot execute inference on the installation host; account for local proxy/gateway work separately. |
| Gateway admission / maintenance | Tracks gateway admission and its waiters; does not cover direct backend callers, all lifecycle operations or backend work continuing after a disconnect. It cannot alone issue `ingress-work-v1`. |

No production source currently implements the full receipt contract. `observeInstallCoverage` is a
read-only orchestration seam for reviewed collectors: inventory before, all backend/path receipts,
inventory after, then reconciliation. It rejects an invalid first inventory before subsequent probes.
One shared cancellation signal and monotonic deadline cover the whole sequence (default 5 seconds,
maximum 30); binding expiry can shorten it. Returned receipts are copied so adapter object reuse cannot
rewrite an earlier sample. After cancellation, no subsequent collector is invoked. An already-running
read may finish later; collectors must stay read-only, bound their payloads and honor the shared signal.
No source-producer authentication or correctness is inferred from a callback's return value.

Polling/bracketing is not atomic, does not reserve resources and cannot rule out work between samples.
The existing installation guard's resource caps, fresh host/release proof, watchdog and approval remain
required. This change does not wire coverage results into `runControlledInstall`, enable maintenance,
alter network rules, or mark the live host covered. Completing #409 still requires independently
reviewed host inventory/counter/fence adapters and approved live verification.

### Offline coverage checker

```sh
node --import tsx scripts/check-install-coverage.ts INVENTORY.json BINDING.json EVIDENCE.json
```

Each input is bounded to 1 MiB and must be a stable regular file. Exit 0 means supplied evidence
reconciles as complete/idle; 1 means busy, unknown or rejected; 2 means usage or input-read failure.
Source `install-coverage-check-v1` is deliberately different from `host-probe-v1`. A saved receipt,
an accepted hash or this exit status never grants live installation admission. Tests exercise synthetic
graphs, omissions, stale/replaced evidence, counters/fences and cancellation, not live completeness.

### Native Linux discovery diagnostic

```sh
node --import tsx scripts/observe-host-inventory.ts --timeout-ms 5000
```

`linux-host-inventory.ts` discovers numeric PIDs from the visible `/proc` mount, parses both TCP
tables, and associates listening socket inodes with all readable descriptor holders. It requires no
predeclared backend list. Each process sample brackets descriptor reads with process start time,
PID/network namespace and executable inode metadata. The executable contents/path, command line,
environment, prompts and request bodies are never read. Reports contain only numeric IDs, validated
kernel TCP address hex/ports, counts, hashes and closed reason codes; keep actual reports private.

Two full scans expose changes to the visible PID set, identities, listener membership and sampled
established-socket counts. Shared listener ownership is preserved rather than choosing an arbitrary
PID. Read errors, process exit/reuse, foreign namespaces and unreadable holders are explicit gaps.
The report retains unknown process entries instead of silently omitting them. Whole-scan failures
or expiry return `unknown`; partial scans return `partial`. A common deadline (1–30000 ms) and caller
cancellation stop further reader calls. A pending filesystem read can finish later, within fixed
payload/entry limits: at most 8192 PIDs, 4096 descriptors per PID and 1 MiB/4096 rows per TCP table.

The source is `linux-host-inventory-v1`, scope `observer-visible-procfs`, and coverage is always
`unknown`. Even an `observed` result says only that the visible samples were readable and unchanged:
procfs visibility restrictions, containers, alternate namespaces, UDP/Unix sockets, non-network
work and lifecycle producers can remain outside this view. Kernel/zombie processes or permission
restrictions may make the observation partial. This output cannot issue a `host-inventory-v1`
receipt or establish the accepted boundary required above.

`tcpEstablishedSockets` is a process's observed descriptor-held TCP socket count in ESTABLISHED
state, including outbound and non-inference traffic. Shared sockets may appear for multiple holders;
counts must not be summed into requests. Zero is not idle proof, and a positive value is not active
inference proof. It is discovery evidence to reconcile with runtime scheduler and lifecycle sources.
The collector does not query unknown listeners, change services, load models or fence traffic.

Exit 0 means the visible sample is `observed`; exit 1 means `partial` or `unknown`; exit 2 means invalid
input or an unexpected top-level failure. No exit status grants installation admission. This adds
actual procfs discovery, but complete backend classification and traffic/lifecycle measurement remain
separate obligations before #409 can admit installations using live evidence.

## Version-2 continuity contract (local implementation only)

`live-install-observation.ts` adds a separate `host-probe-v2` schema and pure decision/session API.
It does not upgrade v1 diagnostics or wire a live collector, privileged launcher or host deadman.
The accepted binding fixes the host boot, manifest, run identity, complete producer identity list
(instance/build/config digests) and protected unit list. A matching hash alone is not authentication;
the future reviewed collector must bind channel peer identity, challenge and the observed bytes.

`evaluateLiveInstall` requires two distinct, fresh, complete idle samples, using the host's wall
and monotonic clocks and the current challenge. It rejects changed producer start sequences even
when current active/queued/loading counts have returned to zero. It also checks actual GPU owner
state, the installation lease, per-protected-cgroup OOM counters and existing resource/residency
invariants. Missing or extra producers, resets, observer replacement, stale samples and v1 sources
are rejected. The accepted manifest must cover gateway, proxy, direct runtime and lifecycle paths;
this module cannot discover omitted paths or prove the caller's declared coverage.

`LiveInstallEvidenceSession` owns a copied last sample and latches failures. Its first healthy sample
is only priming. Two healthy samples may issue a numeric monotonic permit deadline bounded by evidence
age and approval expiry. Reading the permit never renews it; after expiry or failure, later healthy
samples cannot revive the session. A restart must not create a new session for an existing job.
This is runner policy, not an independent stop mechanism: the planned host deadman must enforce the
deadline outside the runner process and require qualified recovery before another run.

`InstallProducerActivity` provides content-blind in-process accounting for accepted queued, active
and loading work. Call `begin` before accepted work can progress and settle the handle only when
actual producer work finishes, including after client disconnect. `track` settles in `finally`
after the wrapped operation completes. Short completed work leaves an incremented start sequence;
capacity/sequence/invariant failures permanently make counts unknown. `track` preserves the real
operation's result/failure despite known accounting faults; `failureReason()` retains the closed
instrumentation diagnostic. Low-level `begin` callers must likewise handle accounting failure without
suppressing inference. This helper is not yet wired
into gateway routes or upstream runtimes and therefore supplies no deployed coverage claim.

See the [reviewed M5 integration plan](controlled-install-m5-integration-plan.md) for the remaining
native observer, runtime/proxy instrumentation, arbitration, containment and exact approval gates.
