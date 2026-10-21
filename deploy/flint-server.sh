#!/bin/sh
set -eu

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)

# The runtime bundle pins llama-server beside this launcher. Append the reviewed
# Flint defaults after caller arguments so they remain effective if a caller
# supplies conflicting llama.cpp flags.
exec "$script_dir/llama-server" "$@" \
  --cache-ram 0 \
  --temp 1 \
  --top-p 0.95 \
  --top-k 20 \
  --min-p 0
