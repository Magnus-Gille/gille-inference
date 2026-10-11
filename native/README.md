# Native observer boundary work for #409

This directory is the first Linux execution fixture for G0. It is not an installed observer,
a complete inventory collector, an authenticated evidence channel, or an executable G1 packet.
Counter parsers reject missing, duplicate, malformed and overflowing evidence; they do not
turn failed reads into zero. The fixture checks live read/parse access, not admission or OOM continuity.
Its output explicitly says `qualifiesObserver: false`. No fixture connects to M5.

The observer uses C and the distribution's systemd library instead of implementing D-Bus framing.
`observer/proc_stat.c` is a bounded, allocation-free metadata parser; it retains only PID, flags
and start ticks. The input may contain a process name, including spaces and parentheses; no name
is returned. It rejects overflow, malformed or oversized data without modifying its output.

`observer/service_census.c` decodes complete sealed systemd `ListUnits` and `ListJobs`
replies through libsystemd, preserving unit state/following and separate job type/state. It
rewinds the reply, bounds entries and retained fields, rejects duplicate identities and
clears the entire result on failure. Unit descriptions are validated then discarded. Synthetic
unit tests use a private socket pair without a bus daemon; the Linux fixture additionally tests
real replies under the existing method allowlist. These snapshots do not prove complete host
coverage, absence of socket activation or activity between samples. Callers must treat any
collection/decoding error as unknown, never an empty inventory.

`observer/unit_identity.c` decodes only complete typed `Properties.Get` replies for active
`InvocationID`, `MainPID`, `NRestarts` and canonical `ControlGroup`. Inactive/missing invocation or
PID, wrong variant types, extra payload or malformed paths are unusable evidence; all failures clear
output. These pure decoders neither authenticate a bus reply nor make several property reads atomic.
The fixed fixture checks a synthetic active service's invocation before/after, exact main PID,
cgroup and zero restarts under confinement. It requests individual constant properties; it never
uses `GetAll`, which could retrieve process arguments or environment. Type contracts follow the
[systemd v255 Unit implementation](https://github.com/systemd/systemd/blob/v255/src/core/dbus-unit.c)
and [Service implementation](https://github.com/systemd/systemd/blob/v255/src/core/dbus-service.c).

`observer/lockdown.c` installs a default-deny seccomp filter, requires no-new-privileges, limits new
sockets to AF_UNIX streams and denies process creation/execution, tracing, process-memory calls,
new executable mappings, namespaces and IP sockets. The filter alone cannot restrict file paths,
AF_UNIX peers or D-Bus methods: the enforcing AppArmor profile supplies that separate boundary.
The library's caller must exit on any installation failure. It is not wired into production yet.

## Disposable Linux fixture

### Producer receipt channel

`observer/producer_receipt.c` decodes at most 2048 bytes with exactly ten unique fields,
version 1, plain producer identifiers, lowercase SHA-256 identities and safe integer counters.
Any null counter makes all activity unknown; malformed input clears the whole output.
`observer/producer_client.c` consumes only `/run/llama-swap-observer/activity.sock` with
a 500 ms monotonic budget. It requires the expected kernel peer UID/PID, process start ticks
before and after the exchange, stable owned directory/socket metadata, expected producer
identities and a freshly generated 256-bit challenge echoed by the receipt. Errors never
become idle observations. The `requestNonceSha256` wire field carries that hex challenge,
matching the existing producer protocol.

The binding argument is internal trusted collector state, not a caller-facing request. A future
collector must derive it from the accepted manifest and live executable, configuration, unit and
invocation evidence in the correct host namespaces. Claimed build/configuration hashes are not
proof of the executable or files. This client is not yet connected to an observer executable,
MAC policy or admission decision, and does not establish complete traffic coverage.

The separate `producer-channel` CI job compiles the exact owned Go endpoint and this C client
without external Go modules. A root synthetic producer and UID 65534 client exercise busy,
idle, unknown, wrong peer/identity/start ticks, replay, malformed/oversized replies, timeout and
changed socket metadata. A compiled client with nonce checking removed must fail the replay
regression. Only this disposable GitHub-hosted VM creates the fixed fixture directory; existing
paths are refused and owned resources are removed. This tests protocol interoperability and
kernel peer binding, not observer confinement or deployment readiness.

### Observer confinement

The `native-boundary` job uses a fresh GitHub-hosted Ubuntu 24.04 VM. It installs only the requested
native development dependencies (`libsystemd-dev` and `libseccomp-dev`, with necessary distribution
dependencies), records their resolved versions/compiler and hashes both fixture executables and the policy.
These receipts describe that CI candidate; they do not establish a reproducible M5 release.
The existing digest-bound main CI workflow remains unchanged.

The root fixture script refuses ordinary local invocation and pre-existing fixture paths, accounts,
units or profile. These environment checks are accident guards, not an authentication boundary.
Only invoke it in the named disposable CI job. It creates two dedicated service UIDs and seven
exact units under `gi-observer-fixture-`, one temporary profile, one observer-specific polkit deny
rule, and files under `/run/gi-observer-fixture`. It performs no global procfs or ptrace changes.
The observer test unit uses restricted procfs, only CAP_SYS_PTRACE, 128 MiB/no swap, 25% CPU,
four tasks and a ten-second start timeout. CAP_DAC_READ_SEARCH is not granted by this fixture.

The test executable is a deliberately bounded fixture probe, not the eventual observer. It checks:

- Bounded memory-headroom and global/per-unit OOM metadata reads under the same confinement.
- Cross-UID process stat and executable-link access to a synthetic, credential-free sentinel.
- A readable synthetic-file control followed by denial under AppArmor; forbidden procfs paths
  are tested by open/close only, with no content read even if a policy is broken.
- Known synthetic pathname and abstract Unix peers connect in the control and are denied by MAC.
- Denied tracing, process memory, process creation, execution, new executable mappings and IP.
- Successful fixed systemd property/unit/job reads, decoded loaded-unit and job tuples,
  a known active cross-UID service and an ordered synthetic start job held in `waiting`; a harmless Ping control followed by denial
  under the method allowlist; denial of starting only the fixture's harmless canary unit.

No real service is targeted by a negative mutation test. All probe output is fixed check names and
pass/fail values; raw process, file and D-Bus reply/error contents are discarded. The profile's
Properties.Get allowance cannot constrain the property-name argument; a future observer must keep
that argument fixed in reviewed code, never expose caller-selected bus operations, and separately
review the final unit-property surface. The fixture reads Manager.Version and the four named identity properties of one exact synthetic
unit object. Its additional AppArmor rule permits only Properties.Get on that object; a harmless
unit-object Ping succeeds in the control and must be denied under confinement. No generic unit path
or service-control allowance is added. These tests do not prove activation/event continuity.

Cleanup cancels the owned pending job before its blocker, stops only owned units and checks
their job absence, PIDs and cgroup population before removing exact
files, unloading the owned profile and removing fixture identities. Unexpected cleanup state fails
the job; the hosted VM is then discarded. There is no recursive cleanup or host-wide policy reset.

## Remaining proof

Passing this fixture establishes only its tested Linux boundary. Complete accepted inventory,
systemd activation/event continuity, resource/OOM collection, producer binding, authenticated local
IPC, the host launcher/deadman and exact-candidate negative tests remain required by the
[integration plan](../docs/controlled-install-m5-integration-plan.md). CI privilege and package
installation authorization is not permission to install or change anything on M5.
