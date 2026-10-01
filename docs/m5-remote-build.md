# Offline-first M5 remote builds

`m5 build` runs an explicitly supplied command in a bounded Linux container on a dedicated M5
build worker. It is an optional build/check facility, not inference: it does not use a gateway
credential or profile, call the gateway, route through MCP to the gateway, or use GPU inference.
The first version is deliberately offline-first; it does **not** implement a network registry
allowlist or permit network fallback.

## Install and configure

Provisioning is an operator action, not part of client installation. The documented host
provisioner is `scripts/install-m5-build.sh`; it is not included in this documentation-only change,
so do not attempt provisioning until that exact-release script is available and its host scope is
approved. Host provisioning must install a root-owned fixed `m5-build-worker` forced SSH command
and `/etc/gille-build.json`; the SSH alias `m5-build` uses a dedicated unprivileged `gille-build`
identity. The SSH key is restricted to that forced command, with forwarding disabled. The
root-managed worker config pins an immutable builder image digest (Rust toolchain such as 1.98.0,
Node 22, and optional Linux Tauri packages). Do not substitute a mutable image tag. The Python
worker `scripts/m5-build-worker.py` uses rootless Podman.

Locally, optionally create `~/.config/m5/build.json`:

```json
{"version":1,"sshTarget":"m5-build"}
```

`sshTarget` is optional and defaults to the `m5-build` SSH alias. Keep this local configuration
out of Git. The build command needs neither `m5`'s gateway profile nor its Keychain credential.

## Use

Run from a Git worktree. Pull paths are relative to the repository root; `--pull` can be repeated
for explicit, bounded artifact retrieval. The toolchain selector is optional.

```sh
m5 build -- cargo test --workspace --locked --offline
m5 build --toolchain 1.98.0 -- cargo check --locked --offline
m5 build --pull target/release/my-tool -- cargo build --release --offline
```

The client synchronizes a strict, clean worktree snapshot (maximum 128 MiB); protected paths and
unsafe/dirty inputs are refused. A same-worktree lock prevents overlapping runs. Each worktree
gets its own target directory; repositories may share the Cargo registry and `sccache`. Job data
lives under a dedicated worker home/state, not an operator or production home. Each job is limited
to two CPUs, 8 GiB memory, and 512 processes; at most three jobs run concurrently. Containers receive no GPU devices, secrets,
production paths, or host home. Networking is always disabled. Dependencies must already be
vendored or present in the prewarmed image/cache: missing dependencies fail explicitly, never
retry online. Output streams with the command's exit status. Artifact retrieval is opt-in via each
`--pull` path and is bounded; it does not expose an arbitrary worker filesystem.

The optional MCP `build_run` tool is a **local client bridge tool**, available only when local
build configuration is present. It invokes this same build facility; it is not sent to an M5
`/mcp` endpoint and does not grant an inference route.

## Limits, evidence, and cleanup

This checks Linux-compatible Rust/npm build and test paths. macOS Swift/CoreML, signing, and macOS
Tauri bundles cannot be validated on this Linux worker. Optional Windows cross-compilation via
`xwin` is not promised. Live Sagascript runs, warm builds under two minutes, three-worktree
parallelism, and protected inference latency/OOM checks have **not** been performed; do not claim
those acceptance results until provisioning and dependencies/image preparation are approved and
the checks are run.

To roll back, disable the dedicated build SSH access and wait for or stop only this build service's
own jobs. Preserve production services and caches; any broader cleanup requires separate approval.
There is no production gateway deployment requirement for a local bridge/worker change. This
documentation does not establish that the client bridge, worker, or provisioner has been installed
or tested.
