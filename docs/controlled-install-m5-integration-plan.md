# M5 controlled installation: integration design for #409

Status: proposed implementation design, based on merged PRs #412, #414, #418, #419 and #420.
This document is not an operational approval or an executable deployment packet. The integrated
observer, runtime instrumentation and host runner described below do not exist yet. No current
release may be labelled ready merely because its diagnostic tests pass.

## Outcome and selected operating mode

Admit a bounded CPU-only installation alongside a resident but idle model, preserving protected
services. Reject missing evidence. Stop the installation if new inference, queueing or loading starts,
or identity, resource headroom or protected state changes. Never evict a model to make admission pass.

Use an independent **CPU installation lease**, mutually exclusive with other installations and
maintenance. Do not take the GPU lease and do not open the existing exclusive maintenance window
during an installation. That window owns the GPU lease and admission fence; the current installation
guard requires both to be inactive. Production telemetry rollout may use an independently approved
maintenance window, but that is a different operation from running the CPU installer.

Implement one host arbiter in the fixed launcher. It exclusively holds an OS `flock` on a fixed,
root-owned lock file for either installation or maintenance; clients cannot open/replace that file.
Acquisition is atomic and non-queued: busy means refusal. Installation holds it through stop,
cleanup and restoration. Every maintenance entry point must acquire it **before** the GPU lease
and admission fence, then release in reverse order. The gateway's maintenance implementation must
be updated; an observer's "maintenance inactive" sample cannot replace this arbitration.
Use bounded owner tokens/heartbeats, and fail closed after arbiter restart: reconcile outstanding
units, maintenance state and restoration before issuing any new token. Arbiter death triggers
independent installation stop; its OS lock releasing does not itself authorize another run.
Maintenance token loss follows the existing fence/GPU restoration path and blocks new arbitration
until verified. Test both acquisition race orders, duplicate release and each owner/arbiter crash.

Keep inference routes available during the CPU operation. The policy is stop-on-new-work, with hard
OS limits protecting the host during detection and shutdown. Polling never supplies an atomic
no-work guarantee. A latched work-start sequence must detect work that begins and ends between polls.

## Components and authority

| Component | Responsibility | Authority |
|---|---|---|
| Temporary host observer | Read selected procfs, cgroup and service metadata; discover unexpected processes/listeners; verify producer identity | Fixed, reviewed executable with tightly bounded privileged reads; no service control or inference |
| Runtime/proxy instrumentation | Count accepted/queued/executing work and model lifecycle at their actual owning boundaries | Existing service identities; content-blind counters, no new public inference surface |
| Unprivileged reconciler | Bind live receipts to the accepted topology/release and evaluate admission/watchdog conditions | Read-only evidence and stop request for its own installation |
| Fixed host launcher | Acquire installation lease, create the one approved unit, enforce its limits and stop/clean only that unit | Narrow service-manager operations bound to the approved packet |
| Installation workload | Execute the approved CPU command against immutable, staged inputs | Separate non-root identity/cgroup; no GPU, production files, secrets or arbitrary service control |

The gateway and existing inference services retain their current isolation. Do not run the gateway
as root, grant the interactive conductor general sudo, or broaden an inference service's filesystem
access to solve observation failures. A process list or a new capability alone does not prove coverage.

### Host observer decision

Build a small standalone native helper from a pinned source/toolchain; do not run an extensible
JavaScript harness or mutable checkout with privilege. It accepts no arbitrary path, PID, URL, shell
command or environment input from a caller. Its only operation is a bounded snapshot under a
root-owned accepted manifest. The manifest defines the observation boundary, not an unrestricted
filesystem allowlist. The helper rejects unknown fields, symlinks and oversized input.

The proposed Linux privilege ceiling is `CAP_SYS_PTRACE` plus `CAP_DAC_READ_SEARCH` in a dedicated,
short-lived service under its own non-root UID. These are powerful cross-user read capabilities: they require explicit owner
approval and independent security review. They must not be added to the gateway or an interactive
account. The implementation must demonstrate why each is needed, remove any unnecessary capability,
and fail closed if sufficient reads would need more privilege. No global ptrace/hidepid change.

Use host PID/network visibility (`PrivateUsers=no`, `PrivateNetwork=no`, `ProtectProc=default`,
`ProcSubset=all`) only for this helper. Deny IP networking, subprocess execution after
startup, ptrace/process-memory operations and service-manager mutation. Permit only fixed AF_UNIX
channels: its evidence channel and authenticated read-only system-bus queries to systemd. Select a
fixed allowlist of systemd list/get/property methods for units, jobs and activation metadata; forbid
start/stop/reload/transient-unit and all other mutation methods with enforcing D-Bus/AppArmor policy
and explicit polkit denial for this UID. No shelling out to systemctl. Negative tests must demonstrate
mutation denial and positive tests must establish complete live job/activation visibility. If this
method-level boundary cannot be enforced, G1 fails; static unit files are not a substitute.
Use read-only filesystem
mounts, no devices or writable production paths, a fixed root-owned executable, bounded memory/CPU
and a fixed lifetime. Use a dedicated enforcing AppArmor profile, supported by the host's read-only
LSM check. Availability alone does not prove the proposed rules work. The profile must deny credential/data files and
`/proc/*/{cmdline,environ,mem,root}` traversal while permitting only the metadata operations needed.
Do not describe the service as isolated until negative tests prove the effective profile and syscall
rules. If the available host MAC mechanism cannot enforce that boundary, stop for a revised design;
do not silently substitute a broad privileged Node process.

Return fixed-schema numbers, approved IDs, hashes and closed reasons over an owner-restricted local
channel. No raw paths, process names/arguments, user content or errors. Bind the channel to the
root-owned helper instance, host boot, manifest digest, invocation, monotonic sequence and request
nonce. A checksum in caller-supplied JSON is not authentication. Limit serialized output and all
individual reads; a timeout, overflow or lost observer becomes unknown and revokes admission.

### Proving the accepted boundary

The observer must reconcile the complete visible process/cgroup/service-manager inventory against
an explicitly accepted manifest, not just poll a supplied endpoint list. Record each backend's unit,
UID, cgroup, immutable executable/build/config identity, listening endpoint and every direct,
proxy/gateway and lifecycle path. Match socket holders with process start time and service invocation.
Include active units, pending starts, socket activation, preload, timers, unload and replacement paths.

Every process or producer must be covered or have a separately reviewed exclusion. Exclusions need
root-controlled executable/configuration and containment evidence; names such as "python", a port
number or a broad cgroup wildcard do not establish non-inference. Kernel threads require positive
kernel metadata identification. User-launched/unmanaged runtimes and unexplained namespaces or
listeners block admission. Include the observer, launcher and approved job as exact owned exceptions,
so they cannot invalidate their own snapshot or create a generic exemption for unrelated jobs.

The manifest is a finite, operator-accepted boundary on a trusted host, not a detector of arbitrary
malicious computation by root. Root/operator changes outside the packet invalidate it. The helper
must prove the expected host namespaces and procfs visibility, and bind effective config/activation
state before and after measurement. Missing permission or unclassified entries remain unknown.
No `host-inventory-v1` complete receipt is emitted until all of these checks pass.

### Authoritative traffic and lifecycle measurements

Instrument each actual local runtime and the proxy/lifecycle manager at pinned versions. Preserve
model IDs, weights, routing, context, precision and serving limits. Rebuild the existing runtime
revision with a minimal reviewed observation patch where necessary; no opportunistic runtime upgrade.

Each producer exposes an atomic snapshot of: instance/boot identity, active accepted work, queued
work, loading/unloading work, and a monotonic work-start sequence. Increment that sequence before
work can execute; include canceled and failed requests, deferred admission, preload and lifecycle
starts. Counter reset, wrap, missing producer or changed identity invalidates continuity. Keep
requests counted until the producer actually settles them, including after client disconnect.
Count accepted body/handler/dispatch waiting as well as scheduler waiting where it can lead to work.
Exclude only explicitly audited read-only observation routes from the counters.

For llama.cpp, enable `--metrics` in the reviewed launch definitions while retaining `--no-slots`.
The two existing scheduler gauges remain useful cross-checks, but cannot replace the full producer
snapshot: loading, HTTP/handler waiting and work-start continuity are additional instrumentation.
For llama-swap, count proxy waiting and startup/preload/stop activity before dispatch to the runtime.
For an active native System One, audio or image runtime, implement the same producer contract before
calling the host covered. An inactive optional backend needs measured absence and a covered lifecycle
path; do not disable or unload it just to pass. Unimplemented active backends block the rollout gate.

Keep the new observation route local and content-blind. Reuse an existing private listener or a
restricted Unix socket; do not create a public metrics endpoint. Bind responses to the observed
producer, not merely a loopback port. An ingress is drained only when its own counters and all mapped
downstream producers are drained. A proxy/client disconnect is not downstream settlement. Preserve
per-producer counts; combine only busy/unknown predicates, never sum overlapping queues into requests.

### Integrating the guard

Introduce a versioned live observation contract rather than manufacturing `host-probe-v1` counts from
the new diagnostics. It must carry coverage/manifest binding, producer continuity, explicit loading,
gateway admission/owner queue, actual GPU mutex ownership, resources, global and protected-cgroup
OOM counters, and protected-unit invocation/restart state. Preserve the old diagnostic APIs without
treating their data as live admission evidence.

Implement the five `ControlledInstallOperations` against the host: observe, run, stop, cleanup and
verifyRestoration. Bind actual executable/input/config bytes to the accepted release and input manifest.
Use `observeInstallCoverage` reconciliation where applicable; extend its receipt version for event
continuity without silently granting that property to v1 receipts. Take two complete stable samples
before admission. Record a fresh prior resident set; allow only the packet's explicit residency rule.

Verify the prepared job's cgroup limits before releasing its execution gate. An independent host-side
deadman holds a short execution permit. Only a fresh, complete, passing observation bound to the same
boot/manifest/producer identities and continuity may renew it. Runner liveness alone cannot renew it;
the workload cannot write it. Its monotonic expiry is no later than the evidence's maximum-age deadline
or the approval expiry, whichever comes first. Unknown/failed evidence revokes it immediately.
The deadman must stop the unit on expiry even if the initiating chat, connection or supervisor disappears.
Observer, reconciler, launcher or deadman restart and sequence-continuity loss default to stop, never
automatic permit renewal. Keep arbitration quarantined until cgroup-empty and verified cleanup/
restoration; uncertain recovery requires operator review. `RuntimeMaxSec` is a second ceiling, not a
substitute for the short deadman. The fixed launcher cannot execute arbitrary unit properties, paths or commands supplied
outside the accepted input manifest. The job must not daemonize into another cgroup or launch services.

Stop uses whole-cgroup termination, then proves `cgroup.events populated=0` and absence of the owned
unit's work before cleanup. TERM followed by KILL is not proof by itself. Cleanup is idempotent,
symlink-safe and restricted to the run's exact owned files. Never delete, evict or restart protected
state to repair a failed check. Separate restoration of owned artifacts/protected state from final
admission: legitimate new customer work can keep the host busy after a successful stop. Report that
as stopped/restored, not a restoration failure just because fresh admission would be denied.

## Implementation and proof sequence

### Work packages and dependencies

1. **L1 contract and boundary:** freeze the v2 receipt, event-continuity rules, manifest schema,
   installation/maintenance exclusion protocol and approval-packet schema. Inventory the current
   runtime build identities read-only; an unidentifiable deployed build blocks a claimed same-version
   rebuild and requires an explicit replacement/version decision before G2.
2. **Observer implementation:** build the fixed helper, AppArmor policy and bounded local channel;
   prove cross-UID visibility and forbidden-read rejection on a disposable Linux test host. Privilege
   choices and final policy review stay with L1; parsing fixtures and negative-test construction are
   suitable bounded leaves.
3. **Producer instrumentation:** independently implement the contract in each accepted runtime and
   in the proxy/lifecycle layer, with pinned builds and direct/proxied cancellation/load tests.
   Runtime-specific implementation/tests are separate leaves after L1 freezes the shared contract.
4. **Host runner and guard:** implement lease arbitration, staged execution gate, cgroup limits,
   deadman, versioned reconciliation, stop and restoration. L1 owns integration and privileged
   launcher decisions; pure contract/guard tests can run in parallel with packages 2 and 3.
5. **Release preparation:** integrate all packages, run the cross-component matrix, independently
   review the immutable candidate and generate G1's concrete packet. G1's evidence finalizes the
   host manifest; G2 and G3 packets follow only after their preceding gates pass.

Packages 2–4 may proceed in parallel after package 1. G1 can identify host-specific gaps while
remaining unprivileged G0 work continues, but G2 requires all G0 implementation evidence plus G1.
Each mutating leaf uses its own worktree. There is no M5 mutation during these local work packages.

| Gate | Deliverable and acceptance | M5 mutations |
|---|---|---|
| G0: local integration | Versioned receipts/guard, fixed helper+MAC policy, launcher/deadman, runtime/proxy patches, pinned builds and packet validator; Linux fixture/integration tests and independent review | None |
| G1: observer qualification | Exact candidate observer temporarily installed; compare host/systemd/procfs sentinel visibility; prove denied paths/syscalls; obtain accepted complete inventory or explicit gaps | Only separately approved observer files/unit/profile; no inference restart |
| G2: telemetry and control rollout | Transactional runtime/proxy/gateway changes plus fixed launcher, arbiter, reconciler and deadman installation/qualification; installation admission remains disabled; per-service health/route checks and recorded rollback | Explicitly approved artifacts, identities, sockets, policies, unit/config changes and restarts |
| G3: end-to-end canary | Activate only the G2-qualified runner for an approved bounded no-op CPU job while a resident model is idle; prove busy/unknown refusal, new-work cancellation, connection loss, cleanup and state preservation | Only approved transient job, bounded admission activation and named synthetic requests/lifecycle actions |
| G4: real installation | New exact immutable payload and resource envelope, all prior gates passed, fresh owner approval | Only that approved installation |

G0 includes a Linux test host with distinct service UIDs and restricted procfs, not just injected
JSON. Test the exact runtime build with direct and proxied requests, cold load, deferred queue,
slow body, client disconnect and work shorter than one polling interval. Verify `--metrics` does not
enable `/slots`; test all active runtime types. No live M5 inference test is implied by local approval.

Minimum cross-component tests: resident+idle admits without eviction; active/queued/loading/unknown
reject; missed-between-polls work is caught by sequence; missing sidecar/alternate namespace/changed
UID or inode/config/queued service start reject; forged/stale/replayed observer data reject; OOM and
protected-state drift stop; stale observer with live runner, observer/runner death, launcher/deadman restart and SSH loss stop the whole job; daemon escape is
prevented; cleanup waits for proven stop; unrelated files remain; new customer traffic after stop does
not become a false restoration failure. Treat inability to stop or restore as a hard incident, no retry.

### Initial canary ceilings (proposal to bind in the later approval packet)

- At most six sequential cases in one 20-minute window; no automatic retries after mutation.
- Dummy CPU workload only: `MemoryMax=256M`, `MemorySwapMax=0`, `CPUQuota=50%`, `TasksMax=16`,
  `RuntimeMaxSec=90`; private temporary storage at most 64 MiB, no network or GPU/device access.
- Observer: at most 128 MiB memory, 25% CPU and 32 tasks; lifetime at most the approved window.
- One-second poll, one-second complete observation deadline, maximum evidence age 1.5 seconds,
  two-second stop/absence-verification bound, 15 seconds each for cleanup and restoration checks.
  End-to-end detection/termination target is at most five seconds, verified under CPU/I/O pressure.
  If these limits cannot be met, reject the canary; do not increase them without a new packet.
- Preserve protected resident state; no synthetic request may silently switch/evict a protected model.
  Each inference/loading test needs a named model, endpoint, token/input and concurrency ceiling.
  OOM and protected-service failure cases are injected locally, never induced on production M5.

For the later real CPU installation, propose at most 8 GiB RAM/no swap, 200% CPU, 128 tasks and
20 minutes of work in a 30-minute envelope; require at least job maximum plus 16 GiB measured memory
headroom and 50% measured CPU idle before start. Stage immutable inputs before the run; keep network
disabled and use a separately bounded output filesystem. These are ceilings, not a reservation or
permission. Approve actual disk bounds/paths and exact workload only once the payload exists.

## Approval packets, deployment and rollback

There are three distinct M5 approvals before real installation: G1 observer qualification, G2
production telemetry/control rollout and G3 synthetic canary. They must not be bundled into a blanket
"continue" authorization. G4 is a separate future install envelope. Local implementation/tests/review
need no M5 authorization. Publishing code/PRs and merges retain their separate owner approval boundary.

Every packet and its strict validator must bind the explicit goal, named host, exact full accepted
release SHA, artifact/build/input and packet hashes, immutable runtime/model/gateway identities,
exact paths, unit prefix and full unit names, exact launcher, fixed commands and allowed mutations,
privileges, resource/time/count ceilings, expiry, prior resident/protected state, maintenance behavior,
cleanup and restoration procedures, verification commands (including OOM and protected-service
checks), rollback commands/artifacts, forbidden production/credential changes and stopping conditions.
Scope expansion, weaker safeguards, expiry, unexpected production/credential access, OOM or
protected-service/restoration anomalies require fresh confirmation; no automated retry after mutation.
Runtime paths and current
private config bytes belong in the private operator packet, not this public design. Verify actual
source/artifact bytes; do not derive an accepted release from whichever checkout happens to be current.

Use `scripts/deploy-gateway.sh deploy <accepted-full-sha>` and its `verify` mode for the gateway.
Extend reviewed repo-owned transactional tooling for observer/runtime/config operations; a gateway
source deployment must not silently install privileged units or change llama-swap/embedding flags.
The [G1 review-bundle checker](observer-review-bundle.md) now validates offline packet structure,
ceilings, expiry and supplied artifact hashes. It neither authenticates qualification receipts nor
executes the packet; the privileged packet/launcher tooling must still be built/tested at G0. Refuse execution
until every packet field is concrete. The merged diagnostic SHA is not the future integrated release.

### G2 bootstrap and availability impact

Choose an explicitly approved **stop-and-replace outage** to bootstrap telemetry. Before instrumentation
exists, neither the gateway maintenance fence nor current slot gauges can prove direct traffic drained.
G2 must enumerate affected direct/proxy/gateway routes, notify the owner of the bounded availability
loss and possibility of interrupting in-flight direct requests, and approve that impact explicitly.
Stop new gateway admissions, inhibit the exact accepted socket/timer/restart activation paths, stop
the affected old units, and prove their cgroups empty and listeners absent before replacing artifacts.
The packet names the exact inhibition/restoration operations; never apply broad masks or firewall rules.
Stage all verified binaries/configuration before the outage and set a maximum outage duration.

Start the exact replacements, verify health, route behavior and authoritative observations, then
restore only the accepted activation/admission state. Direct routes may resume with the approved
service starts; installation admission remains disabled throughout qualification. An unknown build,
unaccounted activation path, remaining old process or failed health check aborts replacement and invokes
the packet's rollback. Record approved model reloads and warm-up requests; do not claim resident state
survives service replacement. No request is injected or model reloaded without its packet's bounds.
Upgrade and qualify shared arbitration on every maintenance entry point before G3; the old gateway's
maintenance fence is not evidence that the new host arbitration protocol already exists.

G1 rollback stops/removes only the newly owned observer unit/profile/files and verifies target services
unchanged. G2 explicitly approves and qualifies the launcher/arbiter/deadman identities, units,
read/control sockets, policies, lock paths and cleanup; it does not permit a real installation.
G2 rollback first disables installation admission, stops/proves absence of owned runner work, then
removes or restores its exact control artifacts and restores previous runtime/config/unit
artifacts and prior gateway release using the fail-closed deployment path, then verifies health and
the explicitly approved resident-state restoration. If a restart disrupts MCP transports or residency,
that impact and the exact restoration actions must be included in G2's approval. G3 stops the owned
unit, proves its cgroup empty, removes its owned temporary files and verifies protected state and OOM
baselines. A failed rollback/restoration stops work and requires new owner direction; no broad cleanup.

## Evidence for the decisions

- [Existing controlled-install contract](controlled-install.md) and
  [guard implementation](../src/homeserver/controlled-install.ts): live collectors/host containment
  remain missing; exclusive maintenance conflicts with the CPU guard's current predicates.
- [Maintenance implementation](../src/homeserver/maintenance-window.ts): owns a GPU lease and
  gateway admission fence, not a complete direct-backend fence.
- [Linux discovery diagnostic](../src/homeserver/linux-host-inventory.ts): visible procfs is always
  unknown coverage; its presence does not resolve lifecycle or request accounting.
- [Official llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
  and [scheduler source](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-context.cpp):
  `--metrics` and `--no-slots` are separate; scheduler gauges do not supply the whole producer contract.
- [Official llama-swap configuration](https://github.com/mostlygeek/llama-swap/blob/main/docs/config.example.yaml):
  readiness waiting and preload belong to proxy/lifecycle observation, not backend slot gauges.
- [Kernel proc documentation](https://docs.kernel.org/filesystems/proc.html) and
  [systemd execution documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html):
  procfs, ptrace and namespace restrictions are independent; do not hide the host view and then call
  a readable subset complete. Upstream docs describe capability, not the deployed runtime revision.

Implementation must pin the source versions actually tested. Full approval requires a final
independent review of the implementation and immutable operational packet, not only this design.
