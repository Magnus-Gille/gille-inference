#!/usr/bin/env bash
set -euo pipefail

# Prepare only the historical manual-evaluation registry and its immediate parent. This script is
# intended to run through sudo during deployment; it never recursively changes data/ or its other
# live stores.

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
if [ -L "$root" ] || [ ! -d "$root" ]; then
  echo "ERROR: live WorkingDirectory is missing, not a directory, or a symlink" >&2
  exit 1
fi

data_dir="$root/data"
registry="$data_dir/model-scout-registry.jsonl"
if [ -L "$data_dir" ] || { [ -e "$data_dir" ] && [ ! -d "$data_dir" ]; }; then
  echo "ERROR: registry parent is not a real directory: $data_dir" >&2
  exit 1
fi
install -d -m 0700 -o "$uid" -g "$gid" -- "$data_dir"

if [ -L "$registry" ] || { [ -e "$registry" ] && [ ! -f "$registry" ]; }; then
  echo "ERROR: registry target is not a regular file: $registry" >&2
  exit 1
fi
if [ ! -e "$registry" ]; then
  install -m 0600 -o "$uid" -g "$gid" -- /dev/null "$registry"
else
  chown "$uid:$gid" "$registry"
  chmod 0600 "$registry"
fi

echo "Prepared manual-evaluation registry: $registry (uid=$uid gid=$gid mode=0600; parent mode=0700)"
