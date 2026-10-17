#!/usr/bin/env python3
"""Compile a zero-PID acceptance mutant; require the decoder regression to reject it."""
from pathlib import Path
import shlex
import signal
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
output = Path(sys.argv[1]).resolve()
if not output.is_dir():
    raise SystemExit("existing build output directory required")
source = (root / "native/observer/unit_identity.c").read_text()
before = "if (parsed == 0U || (uint64_t)parsed > (uint64_t)INT_MAX)"
if source.count(before) != 1:
    raise SystemExit("expected reviewed PID guard missing")
mutant = output / "unit-identity-mutant.c"
binary = output / "unit-identity-mutant"
with mutant.open("x") as file:
    file.write(source.replace(before, "if ((uint64_t)parsed > (uint64_t)INT_MAX)"))
flags = shlex.split(subprocess.check_output(
    ["pkg-config", "--cflags", "--libs", "libsystemd"], text=True, timeout=10))
subprocess.run(["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
    "-I", str(root / "native/observer"), str(mutant),
    str(root / "native/observer/test_unit_identity.c"), *flags, "-o", str(binary)],
    check=True, timeout=30)
result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=15, check=False)
if result.returncode != -signal.SIGABRT or "gi_parse_service_main_pid" not in result.stderr:
    raise SystemExit("zero-PID mutant did not fail the expected behavioral assertion")
print("red: unit identity regression rejects zero-PID acceptance")
