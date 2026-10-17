#!/usr/bin/env python3
"""Stage a byte-preserving, hash-gated gateway unit dependency change.

The output is a private staging file, not an installed systemd unit. The
operator must review its hash and one-line diff, then install and verify it
under a separately approved production change.
"""

import argparse
import hashlib
import os
from pathlib import Path
import stat
import sys


OLD = b"Requires=llama-swap.service"
NEW = b"Wants=llama-swap.service"


def transform(source: bytes) -> bytes:
    lines = source.splitlines(keepends=True)
    in_unit = False
    hits = []
    wants = []
    after = []
    for index, line in enumerate(lines):
        value = line.rstrip(b"\r\n")
        if value.startswith(b"[") and value.endswith(b"]"):
            in_unit = value == b"[Unit]"
        elif in_unit and value.startswith(b"Requires="):
            hits.append((index, value))
        elif in_unit and value.startswith(b"Wants="):
            wants.append(value)
        elif in_unit and value.startswith(b"After="):
            after.extend(value.split(b"=", 1)[1].split())
    if [value for _, value in hits] != [OLD] or any(
        b"llama-swap.service" in value.split(b"=", 1)[1].split() for value in wants
    ):
        raise ValueError("unexpected [Unit] backend dependency directives")
    if b"llama-swap.service" not in after:
        raise ValueError("expected backend ordering is absent")
    index, _ = hits[0]
    ending = lines[index][len(OLD):]
    lines[index] = NEW + ending
    return b"".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args()
    if len(args.expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in args.expected_sha256):
        parser.error("expected SHA-256 must be 64 lowercase hexadecimal characters")
    source_stat = args.source.lstat()
    if not stat.S_ISREG(source_stat.st_mode) or stat.S_ISLNK(source_stat.st_mode):
        raise ValueError("source must be a regular, non-symlink file")
    source = args.source.read_bytes()
    old_hash = hashlib.sha256(source).hexdigest()
    if old_hash != args.expected_sha256:
        raise ValueError("source SHA-256 differs from approved baseline")
    target = transform(source)
    if args.output.resolve() == args.source.resolve():
        raise ValueError("output must differ from source")
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(target)
            output.flush()
            os.fsync(output.fileno())
    except BaseException:
        args.output.unlink(missing_ok=True)
        raise
    print(f"source_sha256={old_hash}")
    print(f"output_sha256={hashlib.sha256(target).hexdigest()}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
