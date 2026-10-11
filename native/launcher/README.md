# Fixed host arbitration primitive

This is an opt-in Linux/root library for local G0 #409. It is not a running launcher, authenticated
control service, host reconciler or independent deadman. No gateway maintenance route or installer
uses it yet; no service or policy is installed by this change.

The broker exclusively opens the preprovisioned root-owned directory `/run/gille-install-arbiter`
(mode 0700) and regular file `arbiter.lock` (mode 0600, one link). No paths are accepted as inputs.
It refuses symlinks, unsafe ownership/modes, and changed path/descriptor identity. It neither creates
nor reads/writes/unlinks the lock file. It holds a nonblocking exclusive `flock` for the whole object
lifetime, including idle and restoration, so competing broker instances never queue or manage separate
leases on the same inode. Keeping one broker's lock across idle avoids an unlock/reopen interval;
installation and maintenance ownership are serialized inside that broker under a mutex.

Every construction begins quarantined. Process exit releases file descriptors, but does not prove
that a surviving job or maintenance fence has been restored. Only the trusted host reconciler may
call `acceptReconciliation`, after independently proving outstanding-work absence, protected-state
restoration and restored maintenance/GPU/fence state. The function verifies the library's state and
fixed lock identity, not those external facts. It must never be exposed as a caller-supplied boolean
or direct RPC. While an active lease remains, reconciliation cannot bypass its restoration path.

An internal opaque lease binds a monotonic sequence to a fresh random broker instance. One owner
holds either installation or maintenance mode. Its heartbeat TTL is 1–5000 ms and cannot exceed the
immutable owner deadline supplied from the accepted packet, in the broker's CLOCK_MONOTONIC domain.
Invalid/foreign/replayed handles do not renew ownership. Expiry or revocation quarantines the broker
and retains ownership. The holder must enter restoration; failed verification stays quarantined,
while verified restoration clears ownership and permits the next acquisition. Restoration has no
heartbeat release: a lost restorer must be reconciled, never silently considered complete.

All state transitions recheck fixed inode identity and monotonic clock continuity. An identity change
makes the object permanently unavailable. A forked copy cannot operate the original broker object.
No lock descriptor is exposed or deliberately inherited across exec. Root remains trusted: this
primitive is not protection against a root operator deliberately replacing the control boundary.

The owner heartbeat is **not an execution permit** and does not prove fresh backend evidence. The
future authenticated launcher must bind callers/run/boot/manifest, prove actual restoration, integrate
every maintenance entry point before GPU/fence acquisition, and independently enforce the separate
short-lived execution permit from accepted observations. Broker loss must stop work through that
independent mechanism. This primitive alone neither stops a process nor grants installation admission.

The disposable hosted-Linux suite exercises both acquisition orders, simultaneous contenders, expired
and foreign handles, restoration retention, owner-deadline capping, process exit without destructors,
startup quarantine, inherited-object rejection and unsafe/changed paths. Fixture guards fail unless
running as root in explicitly identified ephemeral GitHub CI; fixtures refuse preexisting paths and
remove only their own identities. A compiled startup-idle mutant must fail the behavioral regression.
No dependencies are installed and no M5 host is contacted. See the Linux
[`flock(2)` reference](https://github.com/mkerrisk/man-pages/blob/master/man2/flock.2) for open-file
and fork/close semantics; those semantics motivate the explicit startup quarantine and process binding.
