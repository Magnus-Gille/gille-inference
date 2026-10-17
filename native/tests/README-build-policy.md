# Build installer and OOM behavior proofs

The `cgroup-stop-proof` hosted job runs both fixtures with a cleared environment.
Neither fixture may run privileged operations on a workstation or production host.

`test_m5_build_installer.py` runs the byte-identical installer in a disposable
chroot and private PID/network namespaces. Real shell/file operations stay inside
that root. Synthetic identity, bounded-filesystem, Podman, SSH and systemd
prerequisites are explicit test doubles; this does not qualify a real build host
or a container runtime. Cases cover preflight failures, generated aggregate limits
and cleanup slice, copy identity and rejected SSH-policy restoration. The starting
directory is inaccessible to the synthetic build UID, exercising the installer's
own change to `/`.

On other hosts, only the fixture's pure helper checks run; integration cases are
reported as skipped. A hosted job with missing privileges/tools fails instead.

`test_service_oom_continue.py` reads the tracked llama-swap template's OOM policy
and score. It starts one unique temporary unit capped at 64MiB with no swap, checks
effective kernel limits before releasing a bounded 128MiB allocator, then proves
that a local cgroup OOM killed that child while its parent and sibling kept running.
It stops only its own unit and verifies the cgroup is empty. RuntimeMaxSec also
bounds the test workload. The parent unwinds cleanup on TERM; a separate harmless
subprocess test exercises that real signal handler without systemd or allocation.
This is CPU-memory evidence for `OOMPolicy=continue`,
not a host/GPU OOM, guaranteed victim ordering, model recovery or host reserve proof.

No M5 service, account, model, production unit, controller or SSH configuration is
installed or changed by these tests. Installer deployment remains a separate
owner-attended operation.
