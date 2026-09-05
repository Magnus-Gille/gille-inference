#!/usr/bin/env bash
# Proves the checked-in configuration still rejects an invented, uncommitted
# token-shaped value. Keep the value assembled: a committed literal would be a
# false-positive fixture in the history scan this script protects.
set -euo pipefail

test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT
config_path="$(pwd)/.gitleaks.toml"

scan_status() {
  local source_dir="$1"
  local status

  set +e
  (cd "$source_dir" && gitleaks detect \
    --config "$config_path" \
    --source . \
    --no-git \
    --redact=100 \
    --no-banner \
    --log-level error \
    --exit-code 23 \
    >/dev/null)
  status=$?
  set -e
  printf '%s\n' "$status"
}

expect_scan_status() {
  local label="$1"
  local source_dir="$2"
  local expected="$3"
  local actual

  actual="$(scan_status "$source_dir")"
  if [[ "$actual" -ne "$expected" ]]; then
    echo "gitleaks $label expected exit $expected, got $actual" >&2
    exit 1
  fi
}

synthetic_dir="$test_dir/synthetic"
mkdir -p "$synthetic_dir"
printf '%s%s\n' 'gitleaks-test-secret-' '0123456789abcdef0123456789abcdef' > "$synthetic_dir/synthetic.txt"
expect_scan_status "synthetic secret" "$synthetic_dir" 23

# Keep the historical generic-api-key match assembled: a committed contiguous literal here
# would make this test source itself a finding during the full-history scan.
column_quote='"'
column_name='total_tokens'
column_separator='", "'
cost_column='m5_'
cost_column_suffix='marginal_cost_usd"'
benign_columns="${column_quote}${column_name}${column_separator}${cost_column}${cost_column_suffix}"
wrong_cost_column='m5_'
wrong_cost_column_suffix='A1b2C3d4E5f6G7h8J9k0LmNopQrStUvW"'
wrong_columns="${column_quote}${column_name}${column_separator}${wrong_cost_column}${wrong_cost_column_suffix}"

exact_dir="$test_dir/exact-path"
mkdir -p "$exact_dir/src/homeserver"
printf 'const columns = [%s];\n' "$benign_columns" > "$exact_dir/src/homeserver/adoption-evidence-bundle.ts"
expect_scan_status "exact benign schema" "$exact_dir" 0

elsewhere_dir="$test_dir/elsewhere"
mkdir -p "$elsewhere_dir"
printf 'const columns = [%s];\n' "$benign_columns" > "$elsewhere_dir/other.ts"
expect_scan_status "same fragment elsewhere" "$elsewhere_dir" 23

changed_dir="$test_dir/changed-second-column"
mkdir -p "$changed_dir/src/homeserver"
printf 'const columns = [%s];\n' "$wrong_columns" > "$changed_dir/src/homeserver/adoption-evidence-bundle.ts"
expect_scan_status "changed second column" "$changed_dir" 23

suffix_dir="$test_dir/changed-suffix"
mkdir -p "$suffix_dir/src/homeserver"
suffix_value='marginal_cost_usd_wrong"'
suffix_columns="${column_quote}${column_name}${column_separator}${cost_column}${suffix_value}"
printf 'const columns = [%s];\n' "$suffix_columns" > "$suffix_dir/src/homeserver/adoption-evidence-bundle.ts"
expect_scan_status "same prefix with changed suffix" "$suffix_dir" 23

marker_dir="$test_dir/marker-with-benign"
mkdir -p "$marker_dir/src/homeserver"
marker_prefix='gitleaks-test-secret-'
marker_suffix='0123456789abcdef0123456789abcdef'
{
  printf '%s%s\n' "$marker_prefix" "$marker_suffix"
  printf 'const columns = [%s];\n' "$benign_columns"
} > "$marker_dir/src/homeserver/adoption-evidence-bundle.ts"
expect_scan_status "synthetic marker with benign schema" "$marker_dir" 23
