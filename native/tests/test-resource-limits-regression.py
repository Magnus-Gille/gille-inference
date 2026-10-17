"""The actual kernel fixture must reject a reader ignoring its approved task limit."""
import os
from pathlib import Path
import subprocess

actions = os.environ.get("GITHUB_ACTIONS", "")
runner = os.environ.get("RUNNER_ENVIRONMENT", "")
if actions != "true" or runner != "github-hosted":
    raise SystemExit("requires a disposable GitHub-hosted runner")
source = Path("native/launcher/resource_limits.c").read_text()
before = "value != values[i]"
assert source.count(before) == 1
scratch = Path(os.environ["RUNNER_TEMP"])
mutant = scratch / "resource-limits-mutant.c"
binary = scratch / "resource-limits-mutant"
mutant.write_text(source.replace(before, "(i != 2 && value != values[i])"))
subprocess.run([
    "cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic",
    "-I", str(Path("native/launcher").resolve()), str(mutant),
    "native/observer/cgroup_limits.c", "native/observer/cgroup_events.c",
    "native/launcher/cgroup_state.c", "native/tests/cgroup_state_fixture.c", "-o", str(binary)
], check=True, timeout=30)
result = subprocess.run([
    "sudo", "-n", "env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    f"GITHUB_ACTIONS={actions}", f"RUNNER_ENVIRONMENT={runner}", "timeout", "15", str(binary)
], capture_output=True, text=True, timeout=20, check=False)
if result.returncode != 1 or "gi_verify_bound_resource_limits(tree, &binding, &wrong_limits) != 0" not in result.stderr:
    raise SystemExit("resource mutant did not fail the changed task-limit assertion")
print("red: resource regression rejects an unbound task limit")
