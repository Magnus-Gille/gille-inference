# Observer Linux test-host prerequisites

G0 needs a disposable Linux fixture to test the native observer across service UIDs,
restricted procfs, systemd activation and enforcing AppArmor. The existing Ubuntu CI job
runs a read-only prerequisite inventory before its normal checks:

```sh
python3 scripts/check-observer-test-host.py
python3 tests/test_observer_test_host.py -v
```

The diagnostic uses Python's standard library. It installs nothing, loads no profiles,
starts no services and uses no elevated privileges. Its output is a fixed JSON object
with `qualifiesObserver: false`. It reports tool availability, selected kernel interfaces,
the systemd development header/library metadata and access to one read-only systemd bus
property. Commands have fixed arguments, a minimal environment and bounded execution;
their raw output is discarded. No process arguments, environment contents or host
identifiers are collected.

Each check reports `present`, `missing`, `unknown` or `unsupported`. `missing` means the
specific lookup did not find its prerequisite. Tool lookup uses only
`/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`; a tool installed elsewhere can therefore
be reported missing. `unknown` includes access failures,
timeouts and unsuccessful bus/library probes; it must not be interpreted as absence.
On non-Linux systems all checks are `unsupported` and no host probes run. Missing or
unknown prerequisites do not fail CI: this inventory is a diagnostic, not a readiness
gate. Its unit tests still must pass.

An installed compiler, a readable AppArmor interface or a responding system bus does
not prove that the eventual observer is confined. Nor does missing development metadata
prove that no alternative build is possible. Use the result to choose and review the
build/test environment; do not silently install packages or weaken the proposed policy.

Qualification still requires the exact candidate binary and policies, distinct service
UIDs, positive cross-UID visibility and negative filesystem/syscall/bus tests. Service
starts, queued jobs, socket/timer activation and changing process identities must be
covered. These operations belong to a separately reviewed disposable fixture. The
preflight neither performs nor authorizes them, and it says nothing about M5's current
state. See the [integration plan](controlled-install-m5-integration-plan.md).
