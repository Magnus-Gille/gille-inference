"""Offline behavior coverage for the unchanged M5 build installer.

The installer is executed only in a disposable Linux chroot inside the hosted CI
runner.  Local runs execute the pure protocol tests and skip every chroot case.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock


REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "scripts" / "install-m5-build.sh"
WORKER = REPO / "scripts" / "m5-build-worker.py"
FIXTURE_COMMAND = Path(__file__).with_name("fixtures") / "m5_build_installer_cmd.py"
RELEASE = "a" * 40
IMAGE = "registry.invalid/m5-builder@sha256:" + "b" * 64
BUILD_UID = 60001


class FixtureInterrupted(RuntimeError):
    """The hosted job was asked to stop; owned children must be reaped first."""


def _load_fixture_command():
    spec = importlib.util.spec_from_file_location("m5_build_installer_cmd", FIXTURE_COMMAND)
    if spec is None or spec.loader is None:
        raise RuntimeError("fixture command module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


fixture_command = _load_fixture_command()


def _hosted_linux_root() -> bool:
    return (
        sys.platform == "linux"
        and os.geteuid() == 0
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and not _hosted_missing_prerequisites()
    )


def _hosted_job() -> bool:
    return sys.platform == "linux" and os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"


def _hosted_missing_prerequisites() -> list[str]:
    missing = [command for command in ("unshare", "chroot", "ldd", "python3") if not shutil.which(command)]
    if os.geteuid() != 0:
        missing.append("root")
    return missing


def setUpModule() -> None:
    if _hosted_job():
        missing = _hosted_missing_prerequisites()
        if missing:
            raise RuntimeError("hosted installer fixture prerequisites unavailable: " + ", ".join(missing))
        def interrupt(_signum, _frame):
            raise FixtureInterrupted("received SIGTERM")
        signal.signal(signal.SIGTERM, interrupt)


def _ldd_paths(binary: Path) -> set[str]:
    output = subprocess.check_output(["ldd", str(binary)], text=True, stderr=subprocess.STDOUT)
    paths: set[str] = set()
    for line in output.splitlines():
        for token in line.replace("=>", " ").split():
            if token.startswith("/") and Path(token).exists():
                paths.add(token)
                break
    return paths


def _copy_binary(binary: Path, root: Path, destination: str, libraries: set[str]) -> None:
    source = binary.resolve()
    target = root / destination.lstrip("/")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    target.chmod(0o755)
    libraries.update(_ldd_paths(source))


def _copy_libraries(root: Path, libraries: set[str]) -> None:
    for library in sorted(libraries):
        target = root / library.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(library, target)


def _write_python_wrapper(root: Path) -> None:
    wrapper = root / "usr" / "bin" / "python3"
    wrapper.write_text(
        "#!/usr/bin/python3.real\n"
        "import os, sys\n"
        "if len(sys.argv) > 1 and sys.argv[1] == '-':\n"
        "    source = sys.stdin.read()\n"
        "    if 'shutil.disk_usage' in source:\n"
        "        raise SystemExit(0)\n"
        "    encoded = source.encode()\n"
        "    read_fd, write_fd = os.pipe()\n"
        "    while encoded:\n"
        "        written = os.write(write_fd, encoded)\n"
        "        encoded = encoded[written:]\n"
        "    os.close(write_fd)\n"
        "    os.dup2(read_fd, 0)\n"
        "    os.close(read_fd)\n"
        "os.execv('/usr/bin/python3.real', ['/usr/bin/python3.real', *sys.argv[1:]])\n",
        encoding="utf-8",
    )
    wrapper.chmod(0o755)


def _bootstrap_runtime(root: Path) -> None:
    libraries: set[str] = set()
    commands = {
        "bash": "/bin/bash",
        "cat": "/usr/bin/cat",
        "cut": "/usr/bin/cut",
        "env": "/usr/bin/env",
        "grep": "/usr/bin/grep",
        "install": "/usr/bin/install",
        "ln": "/usr/bin/ln",
        "mktemp": "/usr/bin/mktemp",
        "mv": "/usr/bin/mv",
        "rm": "/usr/bin/rm",
        "sha256sum": "/usr/bin/sha256sum",
        "chmod": "/usr/bin/chmod",
        "cp": "/usr/bin/cp",
        "flock": "/usr/bin/flock",
        "basename": "/usr/bin/basename",
        "dirname": "/usr/bin/dirname",
    }
    for name, path in commands.items():
        source = Path(shutil.which(name) or path)
        destination = "/bin/bash" if name == "bash" else f"/usr/bin/{name}"
        _copy_binary(source, root, destination, libraries)

    python = Path(shutil.which("python3") or "/usr/bin/python3").resolve()
    _copy_binary(python, root, "/usr/bin/python3.real", libraries)
    probe = subprocess.check_output(
        [str(python), "-c", "import sysconfig; print(sysconfig.get_paths()['stdlib'])"],
        text=True,
    ).strip()
    stdlib = Path(probe)
    shutil.copytree(stdlib, root / stdlib.as_posix().lstrip("/"), symlinks=True, dirs_exist_ok=True)
    dynload = stdlib / "lib-dynload"
    if dynload.is_dir():
        for extension in dynload.glob("*.so"):
            libraries.update(_ldd_paths(extension))
    _copy_libraries(root, libraries)
    _write_python_wrapper(root)


def _copy_fake_commands(root: Path) -> None:
    fake_commands = {
        "stat": "/usr/bin/stat",
        "id": "/usr/bin/id",
        "getent": "/usr/bin/getent",
        "mountpoint": "/usr/bin/mountpoint",
        "loginctl": "/usr/bin/loginctl",
        "runuser": "/usr/sbin/runuser",
        "podman": "/usr/bin/podman",
        "systemctl": "/usr/bin/systemctl",
        "sha256sum": "/usr/bin/sha256sum",
        "sshd": "/usr/sbin/sshd",
    }
    for name, destination in fake_commands.items():
        target = root / destination.lstrip("/")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(FIXTURE_COMMAND, target)
        target.chmod(0o755)


def _mkdirs(root: Path) -> None:
    for relative in (
        "dev",
        "etc/ssh/sshd_config.d",
        "etc/systemd/system",
        "etc/tmpfiles.d",
        "opt/gille-build/releases",
        "payload/scripts",
        "root/private0700",
        "run/gille-build",
        "run/user/60001",
        "sys/fs/cgroup",
        "usr/local/libexec",
        "var/lib/gille-build",
        "fixture",
    ):
        (root / relative).mkdir(parents=True, exist_ok=True)
    (root / "etc/passwd").write_text(
        "root:x:0:0:root:/root:/bin/bash\n"
        "gille-build:x:60001:60001:gille-build:/var/lib/gille-build:/bin/bash\n",
        encoding="utf-8",
    )
    (root / "etc/group").write_text("root:x:0:\ngille-build:x:60001:\n", encoding="utf-8")
    (root / "etc/nsswitch.conf").write_text("passwd: files\ngroup: files\n", encoding="utf-8")
    (root / "etc/subuid").write_text("gille-build:100000:65536\n", encoding="utf-8")
    (root / "etc/subgid").write_text("gille-build:100000:65536\n", encoding="utf-8")
    (root / "dev/null").touch()
    (root / "var/lib/gille-build").chmod(0o700)
    (root / "payload").chmod(0o700)
    (root / "root/private0700").chmod(0o700)


def _default_control(**overrides: object) -> dict[str, object]:
    result: dict[str, object] = {
        "podman_ps": "empty",
        "image_exists": True,
        "sshd_t_fail_count": 0,
        "sshd_T": "valid",
        "active_unit": "ssh.service",
        "systemctl_failure": False,
        "checksum": "normal",
        "checksum_calls": 0,
    }
    result.update(overrides)
    return result


@contextlib.contextmanager
def _fixture(**control_overrides: object):
    directory = Path(tempfile.mkdtemp(prefix="m5i-", dir="/tmp"))
    bus: socket.socket | None = None
    try:
        root = directory / "root"
        root.mkdir()
        _mkdirs(root)
        _bootstrap_runtime(root)
        _copy_fake_commands(root)
        payload_script = root / "payload/scripts/install-m5-build.sh"
        source_digest = hashlib.sha256(INSTALLER.read_bytes()).digest()
        shutil.copy2(INSTALLER, payload_script)
        payload_script.chmod(0o755)
        if hashlib.sha256(payload_script.read_bytes()).digest() != source_digest:
            raise AssertionError("installer fixture source changed while staging")
        shutil.copy2(WORKER, root / "payload/scripts/m5-build-worker.py")
        (root / "payload/.build-release").write_text(RELEASE + "\n", encoding="utf-8")

        control = _default_control(**control_overrides)
        control_path = root / "fixture/control.json"
        control_path.write_text(json.dumps(control), encoding="utf-8")
        control_path.chmod(0o666)
        log_path = root / "fixture/actions.jsonl"
        log_path.touch(mode=0o600)
        log_path.chmod(0o666)

        bus_path = root / "run/user/60001/bus"
        bus = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        bus.bind(str(bus_path))
        bus.listen(1)
        yield root
    finally:
        if bus is not None:
            bus.close()
        shutil.rmtree(directory)


def _run(root: Path, mode: str) -> subprocess.CompletedProcess[str]:
    command = [
        "unshare",
        "--net",
        "--pid",
        "--fork",
        "--kill-child",
        "chroot",
        str(root),
        "/bin/bash",
        "-c",
        f"cd /root/private0700; exec /payload/scripts/install-m5-build.sh {mode} {RELEASE} {IMAGE}",
    ]
    environment = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/root", "LC_ALL": "C", "LANG": "C"}
    process = subprocess.Popen(
        command,
        cwd="/",
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    def terminate_owned_process() -> None:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                process.kill()
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    try:
        stdout, stderr = process.communicate(timeout=30)
    except subprocess.TimeoutExpired:
        terminate_owned_process()
        stdout, stderr = process.communicate(timeout=5)
        raise AssertionError(f"installer fixture timed out: {stdout[-500:]} {stderr[-500:]}")
    except BaseException:
        terminate_owned_process()
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        raise
    process.wait(timeout=5)
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)


def _actions(root: Path) -> list[dict[str, object]]:
    lines = (root / "fixture/actions.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line]


class PureFixtureTests(unittest.TestCase):
    def test_command_name_and_control_defaults_are_local_only(self) -> None:
        self.assertEqual(fixture_command.command_name("/usr/bin/podman"), "podman")
        self.assertEqual(fixture_command.command_name(["/usr/sbin/sshd"]), "sshd")
        self.assertEqual(fixture_command._path_arg(["-c", "/fixture"]), "/fixture")

    def test_run_closes_owned_process_group_when_communication_is_interrupted(self) -> None:
        real_process = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            env={"PATH": "/usr/bin:/bin", "HOME": "/tmp"},
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        class InterruptedChild:
            def __init__(self, process: subprocess.Popen[bytes]) -> None:
                self.process = process
                self.pid = process.pid
                self.interrupt = True
                self.wait_calls = 0

            def poll(self):
                return self.process.poll()

            def communicate(self, timeout=None):
                if self.interrupt:
                    self.interrupt = False
                    raise KeyboardInterrupt()
                return self.process.communicate(timeout=timeout)

            def wait(self, timeout=None):
                self.wait_calls += 1
                return self.process.wait(timeout=timeout)

            def kill(self):
                return self.process.kill()

            @property
            def returncode(self):
                return self.process.returncode

        child = InterruptedChild(real_process)
        try:
            with mock.patch("subprocess.Popen", return_value=child):
                with self.assertRaises(KeyboardInterrupt):
                    _run(Path("/unused-fixture"), "preflight")
            self.assertGreaterEqual(child.wait_calls, 1)
            self.assertIsNotNone(real_process.poll())
        finally:
            if real_process.poll() is None:
                os.killpg(real_process.pid, signal.SIGKILL)
                real_process.wait(timeout=5)


@unittest.skipUnless(_hosted_linux_root(), "requires root on a disposable GitHub-hosted Linux runner")
class HostedInstallerTests(unittest.TestCase):
    def test_preflight_success_has_no_mutations(self) -> None:
        with _fixture() as root:
            result = _run(root, "preflight")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("PASS: dedicated build host preflight", result.stdout)
            self.assertFalse((root / "etc/gille-build.json").exists())
            self.assertFalse((root / "opt/gille-build/releases" / RELEASE).exists())
            for action in _actions(root):
                self.assertNotIn(str(root), str(action.get("cwd", "")))
            runuser_actions = [action for action in _actions(root) if action["argv0"] == "runuser"]
            self.assertTrue(runuser_actions)
            self.assertTrue(all(action["cwd"] == "/" for action in runuser_actions))

    def test_preflight_fails_closed_for_container_and_image_prerequisites(self) -> None:
        for overrides, message in (
            ({"podman_ps": "error"}, "Cannot list build containers"),
            ({"podman_ps": "nonempty"}, "Existing build containers"),
            ({"image_exists": False}, "Preload the approved builder image"),
        ):
            with self.subTest(message=message), _fixture(**overrides) as root:
                result = _run(root, "preflight")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((root / "etc/gille-build.json").exists())

    def test_apply_success_writes_exact_slice_and_quotas(self) -> None:
        with _fixture() as root:
            result = _run(root, "apply")
            self.assertEqual(result.returncode, 0, result.stderr)
            slice_file = root / "etc/systemd/system/user-60001.slice.d/70-gille-build.conf"
            self.assertEqual(
                slice_file.read_text(encoding="utf-8"),
                "[Slice]\nCPUQuota=600%\nCPUWeight=10\nIOWeight=10\nMemoryMax=24G\nMemorySwapMax=0\nTasksMax=1700\n",
            )
            cleanup_service = (root / "etc/systemd/system/gille-build-cleanup.service").read_text(encoding="utf-8")
            self.assertIn("Slice=user-60001.slice\n", cleanup_service)
            self.assertEqual(json.loads((root / "etc/gille-build.json").read_text(encoding="utf-8"))["image"], IMAGE)
            self.assertTrue((root / "usr/local/libexec/m5-build-worker").is_symlink())
            system_actions = [action for action in _actions(root) if action["argv0"] == "systemctl"]
            self.assertTrue(any(action["args"][-1] == "ssh.service" and "reload" in action["args"] for action in system_actions))
            self.assertFalse(any("home-gateway" in str(action) or "llama" in str(action) for action in system_actions))

    def test_apply_refuses_symlink_and_existing_release_before_backup(self) -> None:
        with _fixture() as root:
            dropin = root / "etc/ssh/sshd_config.d/70-gille-build.conf"
            target = root / "fixture/target"
            target.write_text("target\n", encoding="utf-8")
            dropin.symlink_to("/fixture/target")
            result = _run(root, "apply")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("symlink", result.stderr)
            backup_dir = root / "etc/gille-build-backups"
            self.assertFalse(backup_dir.exists())
            self.assertTrue(dropin.is_symlink())
            self.assertEqual(target.read_text(encoding="utf-8"), "target\n")

        with _fixture() as root:
            release_dir = root / "opt/gille-build/releases" / RELEASE
            release_dir.mkdir()
            sentinel = release_dir / "sentinel"
            sentinel.write_text("preserve\n", encoding="utf-8")
            result = _run(root, "apply")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Release already staged", result.stderr)
            backup_dir = root / "etc/gille-build-backups"
            self.assertFalse(backup_dir.exists())
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve\n")

    def test_checksum_failure_stops_before_ssh_validation(self) -> None:
        with _fixture(checksum="mismatch") as root:
            result = _run(root, "apply")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Worker copy identity mismatch", result.stderr)
            self.assertFalse(any(action["argv0"] == "sshd" for action in _actions(root)))

    def test_ssh_t_rejection_restores_old_or_absent_dropin_without_reload(self) -> None:
        for old in (True, False):
            with self.subTest(old=old), _fixture(sshd_t_fail_count=1) as root:
                dropin = root / "etc/ssh/sshd_config.d/70-gille-build.conf"
                if old:
                    dropin.write_text("old drop-in\n", encoding="utf-8")
                result = _run(root, "apply")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(dropin.read_text(encoding="utf-8") if old else dropin.exists(), "old drop-in\n" if old else False)
                self.assertFalse(any(action["argv0"] == "systemctl" and "reload" in action["args"] for action in _actions(root)))

    def test_ssh_T_rejection_restores_old_or_absent_dropin_without_reload(self) -> None:
        for old in (True, False):
            with self.subTest(old=old), _fixture(sshd_T="invalid") as root:
                dropin = root / "etc/ssh/sshd_config.d/70-gille-build.conf"
                if old:
                    dropin.write_text("old drop-in\n", encoding="utf-8")
                result = _run(root, "apply")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(dropin.read_text(encoding="utf-8") if old else dropin.exists(), "old drop-in\n" if old else False)
                self.assertFalse(any(action["argv0"] == "systemctl" and "reload" in action["args"] for action in _actions(root)))


if __name__ == "__main__":
    unittest.main()
