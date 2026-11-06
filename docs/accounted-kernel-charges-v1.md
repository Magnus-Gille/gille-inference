# Selected cgroup kernel-charge channel

Local component source only. No complete global-kernel accounting, allocation,
owner authority, production installation or native acceptance follows from this
channel. Active outside-parent service-manager/transport paths remain separate
mandatory requirements. Parent and child counters overlap and are never added as
independent budgets.

The fixed helper operation is `collect_cgroup_kernel_charges_v1`, with the same
three helper arguments and no extra paths, callbacks or requester data. It uses
the existing v3 source/config/bootstrap/PID1/interpreter/kernel gates before and
after collection, including the final lease check after all trailing readback.
Its cgroup2 root, parent and three role FDs are pinned exactly as in the cgroup
envelope operation. Both controller/member checks still run twice. The old
operation neither reads nor requires the new files.

Each scope additionally reads six fixed files through the same FD and paired
file-identity checks: `cpu.stat`, `memory.stat`, `memory.current`,
`memory.events.local`, `pids.current` and `pids.events.local`. Every read is bounded
to65536 bytes; enumerations remain bounded to1024 entries, with two passes and
a maximum one-second observation window. Read refusal is not an arbitrary kernel
I/O deadline guarantee. Missing/empty/drifted/symlink/writable/unsupported files
refuse; no missing value becomes zero.

The inner canonical native packet has channel `cgroup_kernel_charges_v1`, kind
`cgroup_kernel_charges_observation`, the existing parent/role facts and overall
window, plus exactly two `passes`. Each pass has its enclosing window and exactly
four `scope_samples` in parent/worker/observer/recovery order. Each sample binds
its actual device/inode and the six raw file strings. Total inner wire size is
at most65536 bytes. The helper returns `{bytes:<canonical inner JSON>}` so raw
kernel TAB/LF remains escaped inside printable JSON. Existing strict helper/native
codecs are unchanged. The fixed bridge verifies the inner packet and preserves
UNKNOWN on ambiguous transport; no automatic retry occurs.

The typed verifier selects CPU usage/user/system microseconds and the five fair
controller counters; memory anon/file/kernel/sock bytes; six local memory event
counts; the local PID limit event; and current charged-memory/task gauges.
Selected fields are mandatory. Flat files reject duplicates, malformed or
negative/nonintegral/oversized values and more than256 rows. Additional numeric
keys are explicitly unclaimed metadata, with a sorted key profile that must stay
unchanged. Their values never acquire an invented meaning or completeness label.

Selected CPU/event counters cannot decrease within a packet or across two fresh
packets. Memory and task gauges may change in either direction within accepted
bounds. Source readbacks are not atomic multi-file snapshots; no exact
CPU-user-plus-system sum or parent-plus-child gauge equality is inferred.
Identity, limits, run/config/challenge binding and lease/freshness must stay valid.
Stable projection is explicit; fresh counter/timestamp bytes may differ.

These meanings follow the [Linux7.0 cgroup-v2 contract](https://docs.kernel.org/7.0/admin-guide/cgroup-v2.html).
Local events avoid changing the meaning with the hierarchical-events mount
option. The PID gauge counts kernel tasks, including threads. This channel
measures charges represented by these sources; it does not claim every causal
global kernel operation, HugeTLB attribution, protected inventory or external
manager costs. Both pure verifier result flags remain false for physical
authentication and execution authority. A fixed accepted physical channel and
the complete real registry remain necessary before any admission.
