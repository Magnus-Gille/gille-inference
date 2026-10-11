"""Require the actual startup regression to reject an idle-on-restart mutant."""
import os
from pathlib import Path
import subprocess

source = Path("native/launcher/arbiter.cpp").read_text()
before = "state_ = State::quarantined;\n}\nArbiter::~Arbiter()"
assert source.count(before) == 1
scratch = Path(os.environ["RUNNER_TEMP"])
mutant = scratch / "arbiter-startup-mutant.cpp"
binary = scratch / "arbiter-startup-mutant"
mutant.write_text(source.replace(before, "state_ = State::idle;\n}\nArbiter::~Arbiter()"))
subprocess.run([
    "c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-pthread",
    "-I", str(Path("native/launcher").resolve()), str(mutant),
    "native/launcher/test_arbiter.cpp", "-o", str(binary)
], check=True, timeout=30)
result = subprocess.run([
    "sudo", "-n", "env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "GITHUB_ACTIONS=true", "RUNNER_ENVIRONMENT=github-hosted", "timeout", "15", str(binary)
], capture_output=True, text=True, timeout=20, check=False)
if result.returncode != 1 or "arbiter.check() == State::quarantined" not in result.stderr:
    raise SystemExit("startup mutant did not fail the quarantine assertion")
print("red: startup regression rejects bypassed reconciliation")
