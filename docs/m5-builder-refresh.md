# M5 builder image refresh policy

This policy covers drift in the separate, offline M5 build worker described in
[`m5-remote-build.md`](./m5-remote-build.md). It applies when the repository's CI toolchain or a
native build requirement changes. It does not change the gateway, model-serving, tunnel, or
autonomy services.

## Refresh decision

Refresh on demand when one of these changes makes the current image insufficient:

- the repository's accepted CI pin changes;
- a build needs a new compiler, runtime, linker, native header, or build utility; or
- the checked-in [`Containerfile`](../deploy/build/Containerfile) changes.

Do not schedule image updates and do not let the worker pull a newer base or final image during a
build. A refresh is an owner-attended preparation and installation of a new, digest-pinned image.
If the current preinstalled tools satisfy the accepted CI requirements, keep the current image.

The current [`Containerfile`](../deploy/build/Containerfile) carries these runner tools and native
packages:

- `rustc`, `cargo`, and `rustup` for Rust `1.99.0`, with `clippy` and `rustfmt` components;
- `node` `22.x`, with `npm` and `npx`;
- `sccache` `0.10.0`;
- Debian 13 (trixie) Rust/Node base variants, with glibc `>= 2.38` for native-library
  compatibility;
- Python 3, `pkg-config`, and the Debian build-essential toolchain;
- `cmake`, `clang`, and `libclang-dev` for native build scripts and bindgen;
- Linux Tauri/native-build packages `libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `libasound2-dev`, `file`, `xdotool`, and
  `patchelf`.

Git and OpenSSH are local client prerequisites documented in the remote-build guide. They are not
added to the builder image by this `Containerfile`.

`m5 build --toolchain <version>` selects a numeric Rust toolchain already present in the image for
a Cargo command. The worker inserts the equivalent `cargo +<toolchain>` selector, sets
`RUSTUP_AUTO_INSTALL=0`, and runs with no network. A missing selector therefore fails offline;
there is no fallback download. `stable` is supported only when the refreshed image actually
contains a preinstalled stable toolchain; the current `Containerfile` provisions `1.99.0` and does
not imply that `stable` exists. The same rule applies to repository-pinned dependencies: lockfiles,
vendored sources, and prewarmed per-repository caches select content that is already available, but
do not install an unavailable tool or dependency. Do not combine `--toolchain` with a Cargo
`+toolchain` argument.

A lightweight worker warning for a requested selector absent from an image manifest was considered
and is deferred. The supported behavior is the existing fail-closed execution error; no advisory
warning is promised or required for acceptance.

## Private refresh record

Keep one sanitized record per refresh in the private operations tracker at the operator-selected
record location `<private-ops>/m5-builder-refresh/<refresh-id>.json`. Do not put the record in this
repository. It must contain this schema, with placeholders until the refresh is actually prepared:

```json
{
  "schema": 1,
  "refresh_id": "<refresh-id>",
  "prepared_at_utc": "<YYYY-MM-DDTHH:MM:SSZ>",
  "source_release_sha": "<40 lowercase hex characters>",
  "base_images": {
    "node": {
      "variant": "node:22-trixie",
      "digest": "sha256:<64 lowercase hex characters>"
    },
    "rust": {
      "variant": "rust:1.99.0-trixie",
      "digest": "sha256:<64 lowercase hex characters>"
    }
  },
  "final_image": {
    "reference": "<image-name>@sha256:<64 lowercase hex characters>",
    "digest": "sha256:<64 lowercase hex characters>",
    "image_id": "sha256:<64 lowercase hex characters>",
    "platform": "linux/amd64",
    "glibc": ">= 2.38"
  },
  "tool_versions": {
    "rust": "<version>",
    "node": "<version>",
    "sccache": "<version>",
    "native_packages": "<approved package/version summary>"
  },
  "previous": {
    "baseline_record": "<prior-private-record-id>",
    "image": {
      "reference": "<previous-image>@sha256:<64 lowercase hex characters>",
      "digest": "sha256:<64 lowercase hex characters>",
      "image_id": "sha256:<64 lowercase hex characters>"
    },
    "worker_release_sha": "<40 lowercase hex characters>",
    "config_identity": "<sanitized hash or recorded identity>",
    "timer_enabled": "<enabled|disabled>",
    "runtime_slice_settings": {
      "CPUQuotaPerSecUSec": "<recorded value>",
      "CPUWeight": "<recorded value>",
      "IOWeight": "<recorded value>",
      "MemoryMax": "<recorded value>",
      "MemorySwapMax": "<recorded value>",
      "TasksMax": "<recorded value>"
    }
  },
  "rollback_record": "<prior-private-record-id>",
  "installer_backup_id": "<sanitized backup identifier>",
  "observations": {
    "protected_services": {
      "fields": [
        "active_state",
        "invocation_id",
        "main_pid",
        "active_enter_timestamp",
        "n_restarts",
        "sanitized_identity"
      ],
      "before": "<sanitized per-unit observation>",
      "during": "<sanitized per-unit observation>",
      "after": "<sanitized per-unit observation>"
    },
    "image": "<digest/id/platform/glibc observation>",
    "preflight": "<sanitized observation>",
    "offline_acceptance": "<sanitized observation>",
    "rollback": "<not-needed|sanitized recovery observation>"
  },
  "acceptance": {
    "offline_build": "<pass|fail>",
    "worker_preflight": "<pass|fail>",
    "protected_services": "<pass|fail>"
  }
}
```

The record contains sanitized identities, the installer backup ID, observations, and outcomes only.
Never copy credentials, environment files, prompts, responses, or host-specific paths from logs into
it or into this repository. The first refresh requires a baseline record of the current image,
worker release, configuration identity, cleanup timer enablement, and runtime slice settings before
the new image is staged. The `rollback_record` and `previous.baseline_record` point to that prior
record; they are required before changing the installed image.

## Preparation and installation

Use a clean checkout at the accepted source release. Set placeholders locally; do not replace them
in this document or publish the resulting values:

```sh
RELEASE_SHA='<accepted-full-40-character-sha>'
NODE_BASE_IMAGE='node:22-trixie@sha256:<approved-node-base-digest>'
RUST_BASE_IMAGE='rust:1.99.0-trixie@sha256:<approved-rust-base-digest>'
IMAGE_TAG='<builder-image-name>:<refresh-id>'
IMAGE_REF='<builder-image-name>@sha256:<final-image-digest>'
```

First confirm the source identity and prepare the image in an explicitly approved networked
preparation environment. Base-image acquisition and build downloads are separate owner-approved
inputs. After those inputs are present, the build itself must not update them:

```sh
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
EMPTY_CONTEXT="$(mktemp -d)"
trap 'rmdir "$EMPTY_CONTEXT"' EXIT
podman pull --platform linux/amd64 "$NODE_BASE_IMAGE"
podman pull --platform linux/amd64 "$RUST_BASE_IMAGE"
podman build --pull=never --platform linux/amd64 \
  --build-arg NODE_IMAGE="$NODE_BASE_IMAGE" \
  --build-arg RUST_IMAGE="$RUST_BASE_IMAGE" \
  --tag "$IMAGE_TAG" \
  --file "$(pwd -P)/deploy/build/Containerfile" "$EMPTY_CONTEXT"
podman image inspect "$IMAGE_TAG" --format '{{.Digest}} {{.Id}} {{.Os}}/{{.Architecture}}'
podman run --rm --pull=never --platform linux/amd64 --entrypoint /usr/bin/getconf \
  "$IMAGE_TAG" GNU_LIBC_VERSION
```

The absolute Containerfile and empty context make the build input explicit; this `Containerfile`
copies no project files. Resolve the printed final digest and image ID into
`IMAGE_REF`, record the base variants/digests, final digest/ID, platform, glibc version, and
installed tool versions, then have the owner attend preloading of exactly `IMAGE_REF` into the
`gille-build` user's rootless Podman store on the M5. The existing installer does not build, pull,
or preload images. It checks that same rootless store with a sterile environment:

```sh
BUILD_UID="$(id -u gille-build)"
sudo -n runuser -u gille-build -- env -i \
  PATH=/usr/bin:/bin HOME=/var/lib/gille-build USER=gille-build \
  XDG_RUNTIME_DIR="/run/user/$BUILD_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$BUILD_UID/bus" \
  /usr/bin/podman image exists "$IMAGE_REF"
sudo -n runuser -u gille-build -- env -i \
  PATH=/usr/bin:/bin HOME=/var/lib/gille-build USER=gille-build \
  XDG_RUNTIME_DIR="/run/user/$BUILD_UID" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$BUILD_UID/bus" \
  /usr/bin/podman image inspect "$IMAGE_REF" \
  --format '{{.Digest}} {{.Id}} {{.Os}}/{{.Architecture}}'
```

Compare the digest, image ID and `linux/amd64` platform with the private record. The matching
image ID binds the transferred bytes to the preparation-time Debian trixie/glibc observation. If the M5 digest differs, stop before
`apply`. Re-transfer with a method that preserves both digest and image ID, or explicitly
re-resolve `IMAGE_REF` on the M5 after confirming the image ID matches, prepare a revised private
record and obtain approval of that exact replacement identity before `apply`. A record update
alone does not authorize a changed digest.

Before any mutation, record the current baseline, including cleanup-timer enablement and effective
runtime slice settings:

```sh
BUILD_UID="$(id -u gille-build)"
systemctl is-enabled gille-build-cleanup.timer
systemctl show "user-$BUILD_UID.slice" \
  --property=CPUQuotaPerSecUSec,CPUWeight,IOWeight,MemoryMax,MemorySwapMax,TasksMax
```

Quiesce normal build submissions before `apply` and keep them quiesced through successful
`preflight` and offline acceptance. The acceptance commands below are the only owner-attended jobs
permitted during that window; preflight itself refuses to run while build containers exist.

Each refresh needs an accepted source release whose staging directory has not already been used. If
that SHA is already staged, stop and prepare a fresh reviewed release; do not overwrite or rename
an existing stage to bypass the identity gate. Do not retry an `apply` failure with another release
until the failed attempt's backup and any partial mutation have been handled through the rollback
path below.

From that same clean checkout, run the repository-owned transport in this order:

```sh
scripts/deploy-m5-build.sh dry-run "$RELEASE_SHA" "$IMAGE_REF"
scripts/deploy-m5-build.sh apply "$RELEASE_SHA" "$IMAGE_REF"
scripts/deploy-m5-build.sh preflight "$RELEASE_SHA" "$IMAGE_REF"
```

`dry-run` checks the accepted full SHA, immutable image reference, clean worktree, repository root,
and `HEAD` identity without contacting the host. `apply` is the explicit host mutation: it archives
only the tracked worker and installer at the accepted SHA, refuses an existing release directory,
records the prior build config/worker and build-specific systemd state, and installs the new image
reference. It does not restart gateway, model, tunnel, or autonomy units. `preflight` is read-only
and must pass against the already staged release and preloaded image. A nonzero `apply` can occur
after `/etc/gille-build.json` and the worker link have switched; retain the printed installer
backup ID and enter the rollback path rather than retrying over that baseline. If it fails before
printing a backup ID, preserve the failure and staged-release evidence and still do not retry until
the owner-approved rollback/recovery review is complete.

Before `apply`, immediately after `preflight`, and again after the acceptance build, perform the
protected-service check from the release operator's approved host procedure. The approved set must
include `home-gateway.service`, `llama-swap.service`, `cloudflared.service`, and every autonomy
protected unit named by the approved host procedure; identify the complete set before `apply`.
Record the expected health state for timers and any normally inactive one-shot units. Capture each phase as `before`, `during`, and `after` in the private observations.
At each phase, fail closed if a unit differs from its approved health state and capture the
restart-sensitive identity fields:

```sh
# On the M5, through the approved read-only operator connection. Define this helper once;
# execute exactly one labelled call at each phase below, rather than running all three calls
# as one uninterrupted command.
PROTECTED_UNITS=(home-gateway.service llama-swap.service cloudflared.service)
PROTECTED_STATES=(active active active)
# Append each approved protected autonomy unit and its expected state to these paired arrays.
capture_protected_state() {
  phase="$1"
  [ "${#PROTECTED_UNITS[@]}" = "${#PROTECTED_STATES[@]}" ] || return 1
  for index in "${!PROTECTED_UNITS[@]}"; do
    unit="${PROTECTED_UNITS[$index]}"
    state="$(systemctl is-active "$unit")" || true
    if [ "$state" != "${PROTECTED_STATES[$index]}" ]; then
      printf 'STOP: %s differs from its approved health state during %s\n' "$unit" "$phase" >&2
      return 1
    fi
    printf 'protected phase=%s unit=%s\n' "$phase" "$unit"
    systemctl show "$unit" \
      --property=Id,LoadState,ActiveState,SubState,FragmentPath,InvocationID,MainPID,ActiveEnterTimestamp,NRestarts || return 1
  done
}
# Before apply, after recording the baseline and before quiescing submissions:
capture_protected_state before
# While the offline acceptance command is running, from another approved read-only connection:
capture_protected_state during
# After the offline acceptance command and its verification:
capture_protected_state after
```

Compare the `before`, `during`, and `after` tuples for every protected unit. Any change in
`InvocationID`, `MainPID`, `ActiveEnterTimestamp`, or `NRestarts` counts as a restart/change even
when the unit returns healthy; changes in active state or load/fragment identity also fail the
refresh. The `systemctl is-active` result is a gate, not a discarded status line. Keep literal
`FragmentPath` values out of the private record; retain only the approved sanitized identity or a
hash of the identity fields.

From the release operator checkout, with its configured verification environment, run the
authoritative gateway verification at each phase as required by the approved procedure:

```sh
scripts/deploy-gateway.sh verify
```

The before/during/after observations and closed health result belong in the private refresh record.
A changed, inactive, or unverified protected service stops the refresh and requires recovery review.
Run the relevant offline CI-equivalent build from the remote-build guide after installation,
including an explicit numeric `--toolchain` smoke only when that numeric toolchain is recorded as
preinstalled in the image. Acceptance is the combination of a passing offline build, worker
preflight, unchanged protected-service observations, and a successful after-phase check; do not
describe an image as accepted from a successful image build alone.

## Rollback and image retention

The installer has no rollback subcommand. Do not invent one and do not call `apply` with an old
release as a rollback shortcut: installation refuses an already staged release and is not a
general state-restoration mechanism.

If `apply` exits nonzero or acceptance fails, stop new builder jobs, drain or stop only the
dedicated build containers, and use the prior private `rollback_record` plus the installer-created
backup record to restore the exact previous state. A failed `apply` may already have switched the
image config and worker link, so treat its backup as the only baseline and do not retry an apply
that would replace or obscure it:

1. verify that the previous image digest is still preloaded;
2. restore the previous `/etc/gille-build.json` image identity;
3. restore the previous worker release and `/usr/local/libexec/m5-build-worker` identity;
4. restore the recorded build SSH drop-in, cleanup units, and dedicated slice settings as a
   single owner-approved recovery action; and
5. rerun the worker preflight and protected-service verification, recording the result.

The private operations tracker owns the exact recovery command and backup location for the host;
this document defines the required identities and checks without claiming an installer restore
behavior that does not exist. Keep the old image and its rollback record until offline acceptance,
preflight, and protected-service verification pass. Deleting the old image is a separate,
explicitly scoped owner approval after acceptance; no refresh step or cleanup timer may delete it.
