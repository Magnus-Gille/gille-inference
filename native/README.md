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

`observer/lockdown.c` installs a default-deny seccomp filter, requires no-new-privileges, limits new
sockets to AF_UNIX streams and denies process creation/execution, tracing, process-memory calls,
new executable mappings, namespaces and IP sockets. The filter alone cannot restrict file paths,
AF_UNIX peers or D-Bus methods: the enforcing AppArmor profile supplies that separate boundary.
The library's caller must exit on any installation failure. It is not wired into production yet.

## Disposable Linux fixture

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
review the final unit-property surface. The fixture currently reads only Manager.Version.

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
