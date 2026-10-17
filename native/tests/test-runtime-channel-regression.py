"""Compile one deliberately unauthenticated endpoint and require behavioral rejection."""
import os
from pathlib import Path
import subprocess

source = Path("native/producer/endpoint.cpp").read_text()
before = "size != sizeof peer || peer.uid != observerUid_"
assert source.count(before) == 1
scratch = Path(os.environ["RUNNER_TEMP"])
mutant = scratch / "endpoint-unauthorized-mutant.cpp"
binary = scratch / "endpoint-unauthorized-mutant"
mutant.write_text(source.replace(before, "size != sizeof peer"))
subprocess.run([
    "c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pthread",
    "-I", str(Path("native/producer").resolve()), str(mutant),
    "native/producer/activity.cpp", "native/producer/receipt.cpp",
    "native/tests/runtime_channel_fixture.cpp", "-o", str(binary)
], check=True, timeout=30)
result = subprocess.run([
    "sudo", "-n", "env", "-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "GITHUB_ACTIONS=true", "RUNNER_ENVIRONMENT=github-hosted",
    "timeout", "15", str(binary), str(scratch / "runtime-native-probe")
], capture_output=True, text=True, timeout=20, check=False)
if result.returncode != 1 or "runtime channel: denied" not in result.stderr:
    raise SystemExit("authorization mutant did not fail the cross-UID assertion")
print("red: cross-UID regression rejects missing producer authorization")
