# M5 remote build/test — offline first

Run Linux-compatible checks on the M5 without gateway credentials or GPU inference:

```sh
m5 build -- cargo clippy --workspace --all-targets -- -D warnings
m5 build -- cargo test -p sagascript-core -p sagascript-cli
m5 build -- npm test
m5 build --toolchain 1.98.0 -- cargo check --workspace
m5 build --pull reports/test.xml -- npm test
```

The command preserves literal arguments after `--`, streams stdout/stderr and returns the remote
command's exit code. Infrastructure/protocol errors are distinct (125). Run from any Git worktree
or subdirectory: the snapshot covers the **whole owning worktree**, including unstaged/untracked
nonignored files and tracked deletions. No `.git` metadata is sent. Selected `.env*`, `secrets/**`,
ignored tracked files, links/hardlinks and special files fail closed. Ordinary ignored files are
excluded. Snapshot limit: 128 MiB. Local Python dirfd operations prevent ancestor-symlink traversal.

## One-time installation

Client `1.5.0` is a source release until published; do not substitute npm `latest`:

```sh
# Only after reviewed publication:
npm install --global gille-inference@1.5.0
```

Builds additionally need **Python 3.9+, Git and OpenSSH** locally. Configure SSH alias `m5-build`
for the named M5 host and dedicated `gille-build` user, with host-key verification enabled; never
use the gateway/operator identity for job execution. Optional local `~/.config/m5/build.json`:

```json
{"version":1,"sshTarget":"m5-build"}
```

Without this file, CLI builds use that alias. With the file present, the existing `m5 mcp` bridge
advertises **local** `build_run` (`cwd`, literal `command` array, optional `toolchain`/`pull`). Only
that call stays local; ordinary inference tools retain their existing gateway authentication.
There is no new gateway route or production gateway restart requirement. MCP captures at most
1 MiB per output channel and reports truncation; CLI output remains streamed.

**Host provisioning requires exact-release owner approval.** Before installing the worker, prepare:

- A dedicated unprivileged `gille-build` account (only its own group), subordinate UID/GID ranges,
  lingered user manager and home `/var/lib/gille-build` on a separate **≤64 GiB** filesystem.
  Disk formatting/account/key/image preparation is **not** performed by the installer.
- Rootless Podman, systemd cgroup v2 and a **preloaded immutable image digest**. The illustrative
  [`Containerfile`](../deploy/build/Containerfile) builds Rust 1.98.0/clippy, Node 22, sccache and
  Linux Tauri packages; resolve and approve both base-image digests and downloads separately.
  Image/default toolchain choice must match the repository's **current** CI pin, not an old ticket.
- Vendored dependencies or prewarmed **per-repository** Cargo/npm caches. Runtime networking is
  always `none`: missing dependencies/toolchains fail offline, never fetch via host credentials.
  This version does **not** implement registry allowlisted egress or automatic cache warming.
- Owner-attended SSH public-key provisioning. Never copy gateway/provider credentials, Cargo
  credentials or an operator home into the builder image/cache. The installed OpenSSH forced
  command disables shells, forwarding, TTYs, user rc, password and keyboard-interactive login.

From the clean accepted-release checkout, preview and then apply only after confirmation:

```sh
scripts/deploy-m5-build.sh dry-run <accepted-full-sha> <builder-image@sha256:digest>
# Explicitly approved host mutation; defaults to the m5 operator SSH alias:
scripts/deploy-m5-build.sh apply <accepted-full-sha> <builder-image@sha256:digest>
# Read-only host check of that already-staged release:
scripts/deploy-m5-build.sh preflight <accepted-full-sha> <builder-image@sha256:digest>
```

The transport ships only regular tracked worker/installer files from `git archive` of the accepted
SHA, into a private root-owned release stage; not mutable worktree bytes. The installer records
prior configs/pointer before mutation, refuses an existing release directory, and installs only
build-specific config, forced SSH command, dedicated slice limits and cleanup timer. It reloads
OpenSSH, **never** gateway/model/tunnel units. A failed apply is not certification: retain its
backup record and require explicit recovery approval. No automated rollback is claimed.

## Isolation, limits, outputs

At most three worktrees run concurrently; the same worktree refuses overlap. Each gets a private
source/target directory and shares only per-repository Cargo/npm/sccache caches. The installed
user slice caps aggregate CPU to six cores/RAM to 24 GiB/no swap; each container caps two
cores/8 GiB/512 pids, with low CPU/I/O weights, a read-only image, no capabilities, no GPU or
host home/production mounts, no credential environment and no network. Jobs have a 30-minute
wall limit and 256 MiB stream limit. Disconnect/timeout cleanup targets only the server-generated
container ID. Cache correctness remains the toolchain's responsibility, not a routing-quality claim.

`--pull` selects regular relative files only (16 MiB each, 32 MiB total); ignored **generated**
reports may be pulled, but protected paths and unsafe local destinations cannot. Rust's build
outputs live at `/target` (`CARGO_TARGET_DIR`), not inside the snapshot: copy selected binaries
into a workspace `reports/` path inside your sandboxed build command before pulling them.

## What runs where / acceptance / cleanup

**M5:** platform-independent/Linux Rust and Node checks, pinned Linux CI equivalents.
**Mac or GitHub macOS:** Swift/Core ML, Apple targets, ANE benchmarks, signing/notarization and
macOS Tauri bundles. Recognizable macOS-only commands are rejected locally and by the worker;
arbitrary scripts cannot be statically classified. Windows `cargo-xwin` is optional future image
work, not promised by this release.

Local protocol/security tests are **not live acceptance**. Before closing #347, run both Sagascript
commands above on the approved host/image, time a warm small-change rerun (target <2 minutes),
run three distinct worktrees concurrently, and record before/during/after gateway/model latency,
protected unit identity/health and OOM counters. Stop on any anomaly. Exact host facts and receipts
belong in the private operations tracker; publish only sanitized reusable evidence.

The daily timer removes only idle worktree source/target directories older than 14 days, under
locks; caches and lock files remain. The separate filesystem provides a hard capacity boundary;
new jobs refuse <1 GiB free. To roll back, disable only dedicated build SSH access, drain/stop its
own containers and restore the recorded root configs/pointer and dedicated slice settings with
an approved exact recovery command. Keep production services and caches untouched. Account,
filesystem, key, image, branch and worktree deletion each require scoped cleanup approval.
