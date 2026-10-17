# Bound cgroup population evidence

Local G0 component for #409; no production launcher, stop service or deadman is enabled here.
The C reader borrows an already opened directory descriptor and the trusted launcher's expected
device/inode. It reads only `cgroup.events`, checks the real cgroup-v2 filesystem and stable root-owned
identities, and returns a bounded parsed snapshot. It does not close the caller's directory descriptor.

The strict parser requires one canonical `populated` line and one `frozen` line, each with value 0 or 1.
Missing, duplicate, malformed, additional or oversized fields produce unknown with a fully cleared
output. A future kernel adding fields therefore needs explicit compatibility review. Missing paths,
removed cgroups, wrong bindings, forged regular files and failed reads never prove an empty job.

According to the [kernel cgroup-v2 contract](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html),
`populated` covers all live processes in the subtree, including descendants, and `cgroup.kill` kills
the subtree with SIGKILL while handling concurrent forks. The hosted-only fixture creates its own
previously absent synthetic parent/nested cgroups, puts two harmless UID-65534 processes only in the
nested group, checks the parent's populated state despite empty parent `cgroup.procs`, performs an
owned-cgroup kill, and requires a known empty snapshot afterward. It also rejects a valid-looking
ordinary file; the compiled mutant without a cgroup-filesystem check must fail that assertion.

These fixture mutations happen only on disposable GitHub-hosted Linux, with explicit environment
and root guards, a minimal environment allowlist, and owned-path cleanup on normal exit. The
workflow and mutation driver check and forward the actual runner identity before invoking root;
these are accident guards, not authentication. An external timeout can interrupt cleanup, so the
disposable runner's teardown remains the final recovery boundary. No M5 connection,
service restart, dependency installation or production stop API is involved.

The directory binding is internal trusted input, not authenticated RPC data or proof of an accepted
job. The fixed launcher still must bind it to the accepted run, boot, unit invocation, namespace,
limits and immutable payload. This is a point-in-time sample; new work can appear afterward unless
launch/restart/migration paths remain fenced. A parsed empty snapshot alone does not authorize
cleanup or restoration. The integrated independent deadman must stop only owned work, bound its
wait, verify identity/whole-cgroup absence and keep arbitration quarantined on uncertainty. The byte
bound and nonblocking opens do not replace an independent operation deadline if the kernel stalls.

## Prepared resource check

`resource_limits.c` checks the same bound root-owned cgroup before a trusted caller releases a
prepared workload. It reads only six constant kernel files: finite `memory.max`, zero
`memory.swap.max`, finite `pids.max`, grouped OOM, and an exact finite CPU quota/period with zero
burst. It repeats the complete check and verifies file/directory identities around every read.
The pure parsers reject unlimited, malformed, overflowing or truncated values; the supported CPU
period is 1,000–1,000,000 microseconds. No paths, unit properties or commands come from a request.

The hosted fixture configures only its newly owned cgroup. It refuses missing controllers instead
of enabling host-wide controllers. The child remains blocked on its pipe while the parent verifies
the actual limits, then the fixture releases its harmless work. Mismatched memory, task or CPU
limits, swap, OOM grouping and burst are tested before release; a compiled mutant ignoring the task
limit must fail. The verifier itself neither configures limits nor releases a gate.

This is a bound local-limit snapshot, not a complete containment verdict. The fixed service launcher
still must stage the real non-root workload, bind its invocation/payload/cgroup membership and prove
device, filesystem, network, syscall and scheduler restrictions. The
[kernel contract](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) limits CPU quota
enforcement to supported scheduler classes, and stricter ancestor limits can also apply. Two reads
are not atomic against a privileged writer: only the trusted launcher may change this group, and
operator changes invalidate the accepted packet. Independent expiry and ongoing observation remain
mandatory; a successful resource check is not an installation permit.
