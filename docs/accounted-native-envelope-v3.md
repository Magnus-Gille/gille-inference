# Accounted v3 envelope and cgroup channel candidate

This is local component source, not a release, host allocation or accepted native
provider. The existing v2 issuer/publisher and frozen R4 policy retain their
meaning. The diagnostic entrypoint remains unavailable for normal admission.

`accounted-native-envelope-v3.ts` parses explicit challenge v2, native parent and
three role scopes, and a closed run binding. Parent limits describe the aggregate;
challenge limits describe the worker. Role sums fit the parent, role address-space
limits match the policy, and the worker PID namespace differs from the shared
observer/recovery PID namespace. Worker reserve ceilings remain 448MiB/9000/56;
aggregate ceilings remain 512MiB/10000/64. Ceilings are not actual allocations.

Lease duration includes resident waiting and is rounded up once. Its absolute end
must fit owner/host deadlines and the complete 35-second permit for every role.
No fresh full-duration interval is added again to the current time.

`accounted-cgroup-channel-v3.ts` accepts only the closed cgroup envelope channel.
It checks config/challenge/run/parent/role bindings, a maximum one-second read
window, freshness and the lease. Two windows must be ordered and have identical
explicit stable projections. Changing sample timestamps are allowed. These pure
checks return `physicalEvidenceVerified:false` and `executionAuthorized:false`.

The fixed Python operation `collect_cgroup_envelope_v1` accepts no extra argument
or requester path/provider. It verifies the INFER two-file immutable code release
and root configuration, the distinct Brokkr v3 ten-file root0644 source release,
and the exact static registry projection. It checks its own boot, worker cgroup
placement and effective RLIMIT_AS. It then pins the fixed root cgroup2 directory,
the parent and exactly three direct children, reads eight fixed controls plus the
empty parent `cgroup.procs`, and rechecks identities/limits twice. Parent OOM group
is zero; child OOM groups are one. Extra members/subgroups, symlinks, changed
identities, swap/burst, frozen/unpopulated groups, mismatched limits and incomplete
reads refuse. Reads are bounded to 65536 bytes and enumerations to 1024 entries.
The one-second observation/outer-helper limit is not a kernel I/O deadline claim.
Config, source and native bindings are rechecked before returning facts.

The helper bridge uses Python `-I -S -B`, an explicit minimal environment and
existing output/time bounds. The cgroup operation forwards only the explicitly
public, lower-hex `INVOCATION_ID` in addition to PATH/LANG/LC_ALL. It does not retry.
An ambiguous cgroup transport or
invalid acknowledgement stays UNKNOWN; no success or durable replay transition
is inferred from it.

The explicit bootstrap channel reads only root0600 singlelink
`issuer-context-v3.json` under the root0700 attempt directory. Its version3 value
binds the B config/source, actual parent/role cgroups and worker process
observation. The helper correlates the live private PID1's field22 start ticks,
cgroup, namespace FDs and resource limits with its own namespace/cgroup/profile.
It verifies PROCFS/NSFS, scheduler, NNP, CORE0/NOFILE128/AS, public invocation,
live pidfds and accepted interpreter bytes before and after collection. The
PID1 status must report effective UID0 directly; proc-file ownership is not an
effective-identity witness. UID/GID records must be unique and well-formed, with
no additional zero-GID/real-UID policy inferred. All trailing source/config/
context readback finishes before the final native and lease checks.
The
static `registry.workerBootstrapV3` has exactly `version:1` and `python_sha256`;
both fixed PID1 and helper exe magic-links must match this accepted binary hash,
with a 16MiB streaming bound. No argv, environ, process memory, arbitrary PID or
ptrace privilege is read or granted. The context bytes are reread unchanged;
outer clock samples must bracket the cgroup observation.

The production integration is not accepted until the actual B bootstrap producer,
source/build/installation and independent native channel proof are accepted.
Hermetic branch tests do not establish those facts. The cgroup result itself contains no namespace,
InvocationID, AS, start/deadline, first-instruction, full-inventory, lease-ledger or
six-path-accounting attestation. Other mandatory channels remain unavailable.
No configured number, digest, root JSON or callback substitutes for their physical
sources. Full v3 issuer/publisher/runtime/installation/native acceptance remains
separate required work before a live approval can be complete.

Tests use real own-UID private files for the fd core and physical source manifest
checks, and synthetic values for wire/transport checks. Paired local B/G readers
can be compared on the same files with different clocks; that is neither a native
cgroup2 test nor a completed admission. No host invocation occurs on import.
