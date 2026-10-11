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
and root guards, an empty environment allowlist, and exact owned-path cleanup. No M5 connection,
service restart, dependency installation or production stop API is involved.

The directory binding is internal trusted input, not authenticated RPC data or proof of an accepted
job. The fixed launcher still must bind it to the accepted run, boot, unit invocation, namespace,
limits and immutable payload. This is a point-in-time sample; new work can appear afterward unless
launch/restart/migration paths remain fenced. A parsed empty snapshot alone does not authorize
cleanup or restoration. The integrated independent deadman must stop only owned work, bound its
wait, verify identity/whole-cgroup absence and keep arbitration quarantined on uncertainty. The byte
bound and nonblocking opens do not replace an independent operation deadline if the kernel stalls.
