# Native producer activity primitive

This C++17 component is a local G0 building block for #409. It is not wired into a runtime,
does not open an endpoint, and does not establish backend coverage or M5 readiness.

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
