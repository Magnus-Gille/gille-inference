#!/usr/bin/env python3
"""Gate D work-root guard (#172, INFER-520): is <path> the directory <dir> or inside it?

Usage: path-inside.py <path> <dir>
Exit 0 only if <path> is outside <dir>. Any other status means inside (1) or an error such as an
unreadable <dir>, and callers must refuse on every non-zero status.

Directory identities (st_dev, st_ino) are compared rather than spellings, so a case alias on a
case-insensitive volume, or any other alternate spelling such as a symlinked ancestor, is caught.
"""
import os
import sys

if len(sys.argv) != 3:
    sys.exit("usage: path-inside.py <path> <dir>")
path, target = sys.argv[1], os.stat(sys.argv[2])
while not os.path.exists(path):
    path = os.path.dirname(path)
while True:
    st = os.stat(path)
    if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
        sys.exit(1)
    parent = os.path.dirname(path)
    if parent == path:
        sys.exit(0)
    path = parent
