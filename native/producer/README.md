# Native producer activity primitive

This C++17 component is a local G0 building block for #409. It is not wired into a runtime,
and does not establish backend coverage or M5 readiness. The optional Linux endpoint described below
requires explicit construction; no runtime enables it yet.

One long-lived tracker belongs to each producer instance and must outlive every token. Before
work can run, `begin` advances `workStarted` and records queued, active or loading ownership.
Transitioning does not create new work; finishing releases the record while retaining the start
sequence. A mutex makes each operation and copied snapshot atomic. The fixed array holds at most
4096 live records without per-work allocation, and sequences stop at JavaScript's safe-integer ceiling.

Opaque tokens bind their sequence to the creating tracker. Foreign, stale or duplicate nonzero
handles, invalid stages, capacity exhaustion and sequence overflow permanently make the tracker
unknown. Token zero is inert so rejected telemetry accounting need not stop inference. There is
no reset. Callers must continue underlying work after an accounting failure and treat unknown as
inadmissible installation evidence; when serialized into the shared producer contract, every count
must be null if `known` is false. Default-constructed snapshots are unknown. A standard-library mutex
failure may throw `std::system_error`; runtime integration must preserve diagnostic context and
invalidate evidence rather than claim a successful idle observation.

The test-only friend implementation lowers limits to exercise boundaries. It is not linked into
production. Tests cover lifetime ownership, queue transitions, work shorter than one observation
interval, overflow after completed work, slot reuse and synchronized concurrent snapshots. The
`cpp-activity` CI job uses the existing compiler in a disposable Ubuntu VM, with AddressSanitizer and
UndefinedBehaviorSanitizer. Its foreign-owner-check mutant must compile and fail the regression
assertion; the reviewed implementation must pass. No dependencies are installed by this job.

Runtime integration remains separate: account for accepted HTTP/body/dispatch waits, task queues,
actual settlement after cancellation/disconnect, and model load/unload/preload. Do not clear a
runtime's work merely because a caller disconnected. Combine producers as busy/unknown predicates;
these are ownership counts, not a sum of inference requests. Pinned source/build identity, private
peer-authenticated snapshots, direct/proxied tests and independent integration review are still required.


## Private runtime receipt channel

`receipt.cpp` encodes a fixed-size, allocation-free snapshot using the same ten-field JSON contract
as the Go proxy and native C decoder. IDs are bounded ASCII; identities and challenges are exactly
64 lowercase hexadecimal characters. Known counts must be safe integers with ownership totals no
larger than `workStarted`. Unknown snapshots serialize all four counts as null. Invalid encoding
clears the complete output buffer. The serializer does not hash or attest identity inputs.

`Endpoint` is Linux-only and opt-in. The caller must provide a long-lived Activity, immutable
identity, and the one authorized observer UID. It opens only
`/run/gille-producer-observer-<producerId>/activity.sock`; the service-owned parent must already
exist and must not be group/world writable or a symlink. `/run` must be root owned and non-writable
by other users. The endpoint never creates a directory or adopts/removes an existing socket.
The socket is mode 0666 to permit cross-UID connection; kernel `SO_PEERCRED` restricts receipt
access before reading any request. Use a dedicated observer UID. Authentication does not protect
against root or another process with the producer's own trusted UID.

One worker serves bounded requests serially, with a 500 ms connection deadline and eight-entry
listen backlog. Each request is `snapshot <64 lowercase hexadecimal challenge>\n`, at most 74
bytes, and returns one bounded receipt before closure. Invalid or unauthorized requests get no
receipt and do not poison accounting. The separate native client generates a fresh challenge and
checks the expected process PID/UID/start ticks, immutable identities and stable socket/parent
inodes. Its runtime API accepts only a validated producer ID, never an arbitrary path; this remains
an internal collector API. The existing proxy path and contract are unchanged.

Only one start attempt is allowed per Endpoint. The caller serializes start/close; Activity must
outlive the endpoint. Close invalidates evidence, stops and joins the worker, then removes only the
recorded socket inode. A replacement path is preserved and cleanup failure is reported. Internal
startup/worker/cleanup faults retain their first error category and invalidate evidence. Kernel
resource exhaustion can close the observer channel while inference continues; absence is unknown,
never idle. There is no reset or automatic restart. This channel cannot establish complete traffic
coverage, source/build provenance, service invocation or manifest acceptance by itself.

The C++ runtime channel CI compiles the C decoder separately and tests actual Linux socket I/O,
malformed/slow/unauthorized requests, preserved existing paths and cleanup. A hosted-only synthetic
root producer is queried by a UID 65534 C client; busy, idle, unknown, mismatched identities and
authorization rejection are checked. A compiled missing-UID-check mutant must fail that regression.
These disposable-host checks do not modify or qualify M5, and install no new dependencies.
