#!/usr/bin/env bash
# Proves the checked-in configuration still rejects an invented, uncommitted
# token-shaped value. Keep the value assembled: a committed literal would be a
# false-positive fixture in the history scan this script protects.
set -euo pipefail

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

printf '%s%s\n' 'gitleaks-test-secret-' '0123456789abcdef0123456789abcdef' > "$test_dir/synthetic.txt"

set +e
gitleaks detect \
  --config .gitleaks.toml \
  --source "$test_dir" \
  --no-git \
  --redact \
  --exit-code 23 \
  >/dev/null
status=$?
set -e

if [[ "$status" -ne 23 ]]; then
  echo "gitleaks configuration did not reject the synthetic secret (exit $status)" >&2
  exit 1
fi
