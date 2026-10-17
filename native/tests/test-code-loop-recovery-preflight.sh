#!/usr/bin/env bash
# Unit-level collision regression only: no systemd/native fixture execution.
set -euo pipefail
SOURCE=$(cd -- "$(dirname -- "$0")" && pwd)/run-code-loop-recovery.sh
SLICE=girecovery.slice
die() { printf '%s\n' "$*" >&2; exit 1; }
# Load just the pure preflight function; never source the privileged launcher.
eval "$(sed -n '/^require_unused_slice() {$/,/^}$/p' "$SOURCE")"
systemctl() {
  case "$4" in
    LoadState) printf '%s\n' "$TEST_LOAD" ;;
    FragmentPath) printf '%s\n' "$TEST_FRAGMENT" ;;
    DropInPaths) printf '%s\n' "$TEST_DROPINS" ;;
    ActiveState) printf '%s\n' "$TEST_ACTIVE" ;;
    Transient) printf '%s\n' "$TEST_TRANSIENT" ;;
    *) return 2 ;;
  esac
}
TEST_LOAD=loaded TEST_FRAGMENT='' TEST_DROPINS='' TEST_ACTIVE=inactive TEST_TRANSIENT=no
require_unused_slice
TEST_LOAD=not-found
require_unused_slice
TEST_LOAD=loaded
TEST_ACTIVE=active
if (require_unused_slice) >/dev/null 2>&1; then die 'active slice accepted'; fi
TEST_ACTIVE=inactive TEST_FRAGMENT=/etc/systemd/system/existing.slice
if (require_unused_slice) >/dev/null 2>&1; then die 'explicit slice accepted'; fi
TEST_FRAGMENT='' TEST_DROPINS=/etc/systemd/system/existing.slice.d/override.conf
if (require_unused_slice) >/dev/null 2>&1; then die 'configured slice accepted'; fi
TEST_DROPINS='' TEST_TRANSIENT=yes
if (require_unused_slice) >/dev/null 2>&1; then die 'transient slice accepted'; fi
TEST_TRANSIENT=no TEST_LOAD=masked
if (require_unused_slice) >/dev/null 2>&1; then die 'masked slice accepted'; fi
printf '%s\n' 'Slice collision preflight: implicit inactive accepted; active, explicit, configured, transient and masked refused.'
