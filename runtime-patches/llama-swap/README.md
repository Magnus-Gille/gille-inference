# Pinned llama-swap observation candidate for #409

This directory prepares an optional private activity channel against upstream commit
`079c35ae82fb2816d319f7bd16936675597b262d` (v262). `upstream.json` pins the repository,
commit and source tree. The owned overlay and context-checked patch are applied only to
that source in disposable CI. They are not applied to M5 or an upstream working repository.

The process-wide counter follows public handler/body waiting, router waiting, runtime HTTP
handlers, preload, swaps, process start/stop, event backlog and automatic capability probes. Handles remain until their owning operation
settles; caller cancellation alone does not settle another operation. Starts increment a latched
sequence. Counter inconsistency, capacity/sequence overflow, configuration reload, shutdown or
an unexpected child exit makes evidence unknown until process restart. Serving still proceeds.
Counts may overlap across layers and must never be summed into unique requests.

Only GET/HEAD `/health` and `/wol-health` are excluded: their pinned upstream handler returns a
constant HTTP 200 with no routing or lifecycle work. Other public requests remain conservatively
counted. The observation channel is separate from public HTTP, metrics and Tailcat routes.

The opt-in `-install-observer-uid` startup flag enables one fixed Linux socket at
`/run/llama-swap-observer/activity.sock`; default `-1` keeps it disabled. A future approved service
configuration must prepare its service-owned directory, with no group/world write permission.
The socket accepts cross-UID connections but checks kernel `SO_PEERCRED` against the exact allowed
UID before reading or replying. It accepts only `snapshot <64 lowercase hex nonce>\n`, returns
fixed identity/count fields and the same nonce, permits at most four concurrent handlers, and
bounds each connection to 500 ms. No request can select a path, PID, command or URL.
Explicit fatal exits invalidate evidence and close the endpoint before terminating; Linux CI exercises
a listener-start failure twice and proves the missing-cleanup regression with a built mutant.
Cleanup checks the original socket inode before unlinking; replacement files are preserved.

A later G2 unit must use a dedicated systemd-managed `RuntimeDirectory=llama-swap-observer`,
`RuntimeDirectoryMode=0755` and `RuntimeDirectoryPreserve=no`, reviewed against any existing
runtime-directory settings. This is mandatory for SIGKILL/crash recovery, where no process cleanup
can run. Do not enable the flag until the exact unit proves directory removal on stop/failure and
recreation with the correct service ownership on restart. The binary deliberately refuses existing
paths; it never guesses that a socket is stale or deletes it to make startup pass.

Identity includes a new random process-instance identifier, the SHA256 of `/proc/self/exe`, and
the SHA256 of serialized effective configuration. No configuration values, prompts, responses,
raw paths or operational errors appear in receipts. The host observer must independently bind the
peer, executable/config identity, boot and accepted manifest; JSON validation is not authentication.

## Verification and remaining work

The standard-library counter tests run locally with the Go race detector. Linux-only endpoint
fixtures test credential rejection, exact protocol, bounds and owned cleanup. CI additionally
requires a behavioral red result on uninstrumented upstream, then green targeted and existing
router/process/server tests. The candidate includes the upstream UI using its pinned lockfile;
the resulting binary is hashed but not published or deployed.

This is a candidate patch, not a complete producer-coverage claim. Full event/lifecycle auditing,
all active downstream producers, actual running-byte/source identity on the target, integration
with the native observer and the accepted manifest, and G1–G4 approvals remain required. This
channel alone cannot authorize an installation or establish full G0 completion.
