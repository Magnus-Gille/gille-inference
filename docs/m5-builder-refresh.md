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
- Python 3, `pkg-config`, and the Debian build-essential toolchain;
- `cmake`, `clang`, and `libclang-dev` for native build scripts and bindgen;
- Linux Tauri/native-build packages `libwebkit2gtk-4.1-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `libasound2-dev`, `file`, `xdotool`, and
  `patchelf`.

Git and OpenSSH are local client prerequisites documented in the remote-build guide. They are not
added to the builder image by this `Containerfile`.

`m5 build --toolchain <stable|version>` selects a Rust toolchain already present in the image for
a Cargo command. The worker inserts the equivalent `cargo +<toolchain>` selector, sets
`RUSTUP_AUTO_INSTALL=0`, and runs with no network. A missing selector therefore fails offline;
there is no fallback download. The same rule applies to repository-pinned dependencies: lockfiles,
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
    "node": "node@sha256:<64 lowercase hex characters>",
    "rust": "rust@sha256:<64 lowercase hex characters>"
  },
  "final_image": "<image-name>@sha256:<64 lowercase hex characters>",
  "tool_versions": {
    "rust": "<version>",
    "node": "<version>",
    "sccache": "<version>",
    "native_packages": "<approved package/version summary>"
  },
  "previous": {
    "image": "<previous-image>@sha256:<64 lowercase hex characters>",
    "worker_release_sha": "<40 lowercase hex characters>",
    "config_identity": "<sanitized hash or recorded identity>"
  },
  "rollback_record": "<prior-private-record-id>",
  "acceptance": {
    "offline_build": "<pass|fail>",
    "worker_preflight": "<pass|fail>",
    "protected_services": "<pass|fail>"
  }
}
```

The record contains identities and outcomes only. Never copy credentials, environment files,
prompts, responses, or host-specific paths from logs into it or into this repository. The
`rollback_record` points to the prior record that names the previous image, worker release, and
configuration identity; it is required before changing the installed image.

## Preparation and installation

Use a clean checkout at the accepted source release. Set placeholders locally; do not replace them
in this document or publish the resulting values:

```sh
RELEASE_SHA='<accepted-full-40-character-sha>'
NODE_BASE_IMAGE='node@sha256:<approved-node-base-digest>'
RUST_BASE_IMAGE='rust@sha256:<approved-rust-base-digest>'
IMAGE_TAG='<builder-image-name>:<refresh-id>'
IMAGE_REF='<builder-image-name>@sha256:<final-image-digest>'
```

First confirm the source identity and prepare the image in an explicitly approved networked
preparation environment. Base-image acquisition and build downloads are separate owner-approved
inputs. After those inputs are present, the build itself must not update them:

```sh
test -z "$(git status --porcelain)"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
podman pull "$NODE_BASE_IMAGE"
podman pull "$RUST_BASE_IMAGE"
podman build --pull=never \
  --build-arg NODE_IMAGE="$NODE_BASE_IMAGE" \
  --build-arg RUST_IMAGE="$RUST_BASE_IMAGE" \
  --tag "$IMAGE_TAG" \
  --file deploy/build/Containerfile .
podman image inspect "$IMAGE_TAG" --format '{{.Digest}}'
```

Resolve the printed final digest into `IMAGE_REF`, record the base digests, final digest, and
installed tool versions, then have the owner attend preloading of exactly `IMAGE_REF` onto the M5. The
existing installer does not build, pull, or preload images. Verify on the M5 that the preloaded
image resolves to the recorded digest before changing the worker configuration.

Each refresh needs an accepted source release whose staging directory has not already
been used. If that SHA is already staged, stop and prepare a fresh reviewed release;
do not overwrite or rename an existing stage to bypass the identity gate.

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
and must pass against the already staged release and preloaded image.

Before `apply`, and again after `preflight`, perform the protected-service check from the release
operator's approved host procedure. At minimum, compare the identity and health of each protected
unit and run the authoritative gateway verification:

```sh
# On the M5, through the approved read-only operator connection:
for unit in home-gateway.service llama-swap.service cloudflared.service; do
  systemctl is-active --quiet "$unit"
  systemctl show "$unit" --property=Id,ActiveState,SubState,FragmentPath
done
```

From the release operator checkout, with its configured verification environment:

```sh
scripts/deploy-gateway.sh verify
```

The before/after identities and closed health result belong in the private refresh record. A
changed, inactive, or unverified protected service stops the refresh and requires recovery review.
Run the relevant offline CI-equivalent build from the remote-build guide after installation,
including an explicit `--toolchain` smoke when the refresh changes Rust tooling. Acceptance is the
combination of a passing offline build, worker preflight, and unchanged protected-service state;
do not describe an image as accepted from a successful image build alone.

## Rollback and image retention

The installer has no rollback subcommand. Do not invent one and do not call `apply` with an old
release as a rollback shortcut: installation refuses an already staged release and is not a
general state-restoration mechanism.

If acceptance fails, stop new builder jobs, drain or stop only the dedicated build containers, and
use the prior private `rollback_record` plus the installer-created backup record to restore the
exact previous state:

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
