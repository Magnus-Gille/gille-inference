#!/usr/bin/env python3
"""Gate D work-root guard (#172, INFER-520): is <path> the directory <dir> or inside it?

Usage: path-inside.py <path> <dir>
Exit 0 only if <path> is outside <dir>. Any other status means inside (1) or an error (2), and
callers must refuse on every non-zero status.

A relative <path> is taken against the current directory. Only a missing suffix may be absent:
the nearest existing ancestor must be a directory, and any other lookup error (a regular file
used as a directory, a permission failure) is an error rather than "outside". That ancestor is
resolved to its physical path before its parents are walked, so a symlink pointing anywhere
inside <dir> is caught. Directory identities (st_dev, st_ino) are compared rather than spellings,
so a case alias on a case-insensitive volume is caught too.
"""
import os
import stat
import sys


def fail(message):
    print(f"path-inside.py: {message}", file=sys.stderr)
    sys.exit(2)


if len(sys.argv) != 3:
    fail("usage: path-inside.py <path> <dir>")
try:
    target = os.stat(sys.argv[2])
except OSError as e:
    fail(f"cannot stat {sys.argv[2]}: {e}")
path = sys.argv[1]
if not os.path.isabs(path):
    path = os.path.join(os.getcwd(), path)
while True:
    try:
        st = os.stat(path)
        break
    except FileNotFoundError:
        parent = os.path.dirname(path)
        if parent == path:
            fail(f"no existing ancestor of {sys.argv[1]}")
        path = parent
    except OSError as e:
        fail(f"cannot look up {path}: {e}")
if not stat.S_ISDIR(st.st_mode):
    fail(f"{path} exists but is not a directory")
path = os.path.realpath(path)
while True:
    try:
        st = os.stat(path)
    except OSError as e:
        fail(f"cannot stat {path}: {e}")
    if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
        sys.exit(1)
    parent = os.path.dirname(path)
    if parent == path:
        sys.exit(0)
    path = parent
