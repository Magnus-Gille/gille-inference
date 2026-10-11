"""Require the real fixture to reject a reader with its filesystem check removed."""
import os
from pathlib import Path
import subprocess

actions = os.environ.get("GITHUB_ACTIONS", "")
runner = os.environ.get("RUNNER_ENVIRONMENT", "")
if actions != "true" or runner != "github-hosted":
    raise SystemExit("requires a disposable GitHub-hosted runner")

source = Path("native/launcher/cgroup_state.c").read_text()
before = " || filesystem.f_type != CGROUP2_SUPER_MAGIC"
assert source.count(before) == 1
scratch = Path(os.environ["RUNNER_TEMP"])
mutant = scratch / "cgroup-filesystem-mutant.c"
binary = scratch / "cgroup-filesystem-mutant"
mutant.write_text(source.replace(before, ""))
subprocess.run([
    "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
    "-I", str(Path("native/launcher").resolve()), str(mutant),
    "native/observer/cgroup_events.c", "native/tests/cgroup_state_fixture.c", "-o", str(binary)
], check=True, timeout=30)
result = subprocess.run([
    "sudo", "-n", "env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    f"GITHUB_ACTIONS={actions}", f"RUNNER_ENVIRONMENT={runner}", "timeout", "15", str(binary)
], capture_output=True, text=True, timeout=20, check=False)
if result.returncode != 1 or "unknown(fake, &fake_binding)" not in result.stderr:
    raise SystemExit("filesystem mutant did not fail the forged-kernel-evidence assertion")
print("red: regression rejects forged cgroup filesystem evidence")
