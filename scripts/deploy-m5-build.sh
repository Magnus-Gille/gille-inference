#!/usr/bin/env bash
# Exact-release installer transport for the separate offline build runtime.
# dry-run is offline. apply requires just-in-time owner approval of host, release,
# immutable image, prerequisites, verification and rollback (see the build guide).
set -euo pipefail
usage() {
  printf '%s\n' 'deploy-m5-build.sh dry-run|preflight|apply <accepted-full-sha> <image@sha256:digest>' \
    'M5_BUILD_DEPLOY_HOST defaults to m5 (owner/operator SSH, NOT m5-build).' \
    'No production gateway/model deployment, disk formatting, package/image pull or key copy.'
}
[[ ${1:-} != --help && ${1:-} != -h ]] || { usage; exit 0; }
[[ $# == 3 ]] || { usage >&2; exit 2; }
mode=$1 release=$2 image=$3 host=${M5_BUILD_DEPLOY_HOST:-m5}
[[ $mode == dry-run || $mode == preflight || $mode == apply ]] || exit 2
[[ $release =~ ^[a-f0-9]{40}$ ]] || { printf 'ERROR: accepted full release required.\n' >&2; exit 2; }
[[ $image =~ ^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$ ]] || { printf 'ERROR: immutable image reference required.\n' >&2; exit 2; }
[[ $host =~ ^[a-zA-Z0-9][a-zA-Z0-9._@-]*$ ]] || { printf 'ERROR: unsafe SSH selector.\n' >&2; exit 2; }
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ $(pwd -P) == "$root" && $(git rev-parse --show-toplevel) == "$root" && $(git rev-parse HEAD) == "$release" ]] || {
  printf 'ERROR: invoked source, cwd and HEAD must match the approved release.\n' >&2; exit 1;
}
[[ -z $(git status --porcelain) ]] || { printf 'ERROR: source worktree must be clean.\n' >&2; exit 1; }
# Only these regular, tracked files enter the root-owned remote payload.
files=(scripts/install-m5-build.sh scripts/m5-build-worker.py)
for file in "${files[@]}"; do
  entry=$(git ls-tree "$release" -- "$file")
  [[ $entry == 100644\ blob\ * || $entry == 100755\ blob\ * ]] || {
    printf 'ERROR: installer payload must consist of regular tracked files.\n' >&2; exit 1;
  }
done
printf 'Plan: %s separate M5 build runtime at release %s; digest-pinned offline image.\n' "$mode" "$release"
[[ $mode != dry-run ]] || exit 0
stage=/opt/gille-build/staged/$release
ssh_args=(-T -o BatchMode=yes -o ForwardAgent=no -o ClearAllForwardings=yes
  -o 'SendEnv=-*' -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2)
run_ssh() (
  # Keep only local OpenSSH authentication/connection inputs; provider/API and
  # application credential environments may not enter the operator transport.
  for name in $(compgen -e); do
    case "$name" in HOME|PATH|SSH_AUTH_SOCK|USER|LOGNAME) ;; *) unset "$name" ;; esac
  done
  ssh "${ssh_args[@]}" -- "$host" "$@"
)
if [[ $mode == preflight ]]; then
  # No upload, temporary remote directory, privileged copy or host mutation.
  # Requires the exact payload already present from an owner-approved stage/apply.
  run_ssh "sudo -n bash '$stage/scripts/install-m5-build.sh' preflight '$release' '$image'"
  exit
fi
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
chmod 700 "$scratch"
git archive --format=tar "$release" "${files[@]}" | tar -xf - -C "$scratch"
printf '%s\n' "$release" > "$scratch/.build-release"
# Root extracts an allowlisted archive from stdin, not worktree bytes or a
# caller-writable remote stage. No credential is accepted or forwarded.
# Refuse an existing release stage rather than overwrite an uncertain payload.
tar -cf - -C "$scratch" .build-release "${files[@]}" | run_ssh \
  "sudo -n /bin/bash -c 'set -euo pipefail; umask 077; test ! -e $stage; mkdir -p /opt/gille-build/staged; mkdir -m700 $stage; tar --no-same-owner -xf - -C $stage; chmod -R go-w $stage; bash $stage/scripts/install-m5-build.sh apply $release $image'"
printf '%s\n' 'Runtime installation completed. Verify protected inference and owner-attended SSH/build acceptance before declaring issue #347 complete.'
