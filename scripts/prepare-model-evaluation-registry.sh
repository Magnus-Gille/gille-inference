#!/usr/bin/env bash
set -euo pipefail

# Prepare only the historical manual-evaluation registry and its immediate parent. This script
# runs as the unprivileged evaluation operator and uses sudo only for no-follow ownership transfer
# of an already-root-owned exact path. It never recursively changes data/ or its other live stores.

root=""
uid=""
gid=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --root) root="${2:-}"; shift 2 ;;
    --uid) uid="${2:-}"; shift 2 ;;
    --gid) gid="${2:-}"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$root" in
  /*) ;;
  *) echo "ERROR: --root must be an absolute live WorkingDirectory" >&2; exit 2 ;;
esac
if [ "$root" = "/" ] || [ -z "$uid" ] || [ -z "$gid" ]; then
  echo "ERROR: --root, --uid, and --gid are required" >&2
  exit 2
fi
case "$uid:$gid" in
  *[!0-9:]*|:*|*:) echo "ERROR: --uid and --gid must be numeric" >&2; exit 2 ;;
esac
if [ "$uid" != "$(id -u)" ] || [ "$gid" != "$(id -g)" ]; then
  echo "ERROR: target uid/gid must equal the effective unprivileged evaluator identity" >&2
  exit 2
fi
if [ -L "$root" ] || [ ! -d "$root" ]; then
  echo "ERROR: live WorkingDirectory is missing, not a directory, or a symlink" >&2
  exit 1
fi

data_dir="$root/data"
registry="$data_dir/model-scout-registry.jsonl"

chmod_nofollow() {
  local path="$1"
  local mode="$2"
  local kind="$3"
  node -e '
    const fs = require("node:fs");
    const [path, mode, kind] = process.argv.slice(1);
    const expectedDirectory = kind === "directory";
    const flags = fs.constants.O_NOFOLLOW |
      (expectedDirectory ? fs.constants.O_RDONLY | fs.constants.O_DIRECTORY : fs.constants.O_WRONLY);
    const fd = fs.openSync(path, flags);
    try {
      const stat = fs.fstatSync(fd);
      if (expectedDirectory ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error(`refusing to chmod non-${kind}: ${path}`);
      }
      fs.fchmodSync(fd, Number.parseInt(mode, 8));
    } finally {
      fs.closeSync(fd);
    }
  ' "$path" "$mode" "$kind"
}

if [ ! -e "$data_dir" ]; then
  mkdir -m 0700 "$data_dir"
fi
if [ -L "$data_dir" ] || [ ! -d "$data_dir" ]; then
  echo "ERROR: registry parent is not a real directory: $data_dir" >&2
  exit 1
fi
if [ ! -O "$data_dir" ]; then
  sudo chown -h "$uid:$gid" "$data_dir"
fi
if [ -L "$data_dir" ] || [ ! -d "$data_dir" ] || [ ! -O "$data_dir" ]; then
  echo "ERROR: registry parent ownership transfer was not safe: $data_dir" >&2
  exit 1
fi
chmod_nofollow "$data_dir" 0700 directory

if [ -L "$registry" ] || { [ -e "$registry" ] && [ ! -f "$registry" ]; }; then
  echo "ERROR: registry target is not a regular file: $registry" >&2
  exit 1
fi
if [ ! -e "$registry" ]; then
  umask 077
  set -o noclobber
  : > "$registry"
  set +o noclobber
fi
if [ ! -O "$registry" ]; then
  sudo chown -h "$uid:$gid" "$registry"
fi
if [ -L "$registry" ] || [ ! -f "$registry" ] || [ ! -O "$registry" ]; then
  echo "ERROR: registry target ownership transfer was not safe: $registry" >&2
  exit 1
fi
chmod_nofollow "$registry" 0600 file

echo "Prepared manual-evaluation registry: $registry (uid=$uid gid=$gid mode=0600; parent mode=0700)"
