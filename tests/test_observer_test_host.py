"""Focused contract tests for the content-blind observer host preflight."""

import contextlib
import importlib.util
import io
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check-observer-test-host.py"
SPEC = importlib.util.spec_from_file_location("check_observer_test_host", SCRIPT)
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class ObserverTestHostPreflightTests(unittest.TestCase):
    def test_linux_output_is_closed_and_commands_use_fixed_boundary(self):
        which_calls = []
        run_calls = []

        def fake_which(name, path=None):
            which_calls.append((name, path))
            return "/fixed/bin/tool"

        def fake_run(*args, **kwargs):
            run_calls.append((args, kwargs))
            return subprocess.CompletedProcess(args[0], 0)

        file_values = {
            preflight.SYSTEMD_COMM: "systemd\n",
            preflight.APPARMOR_ENABLED: "Y\n",
            preflight.APPARMOR_LSM: "lockdown,apparmor,bpf\n",
            preflight.SYSTEMD_HEADER: "header\n",
        }

        def fake_read(path):
            return file_values[path]

        with mock.patch.object(preflight.platform, "system", return_value="Linux"), \
                mock.patch.object(preflight.shutil, "which", side_effect=fake_which), \
                mock.patch.object(preflight, "_read_bounded", side_effect=fake_read), \
                mock.patch.object(preflight, "_probe_readable"), \
                mock.patch.object(preflight.subprocess, "run", side_effect=fake_run):
            result = preflight.diagnose()

        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(result["source"], "observer-test-host-preflight")
        self.assertFalse(result["qualifiesObserver"])
        self.assertEqual(result["platform"], "linux")
        self.assertEqual(set(result), {"schemaVersion", "source", "qualifiesObserver", "platform", "checks"})
        self.assertEqual(set(result["checks"]), set(preflight.CHECKS))
        self.assertTrue(all(value == "present" for value in result["checks"].values()))
        self.assertEqual(which_calls, [(name, preflight.FIXED_PATH) for name in preflight.TOOLS])
        self.assertEqual([call[0][0] for call in run_calls], [
            ["pkg-config", "--exists", "libsystemd"],
            ["busctl", "--system", "get-property", "org.freedesktop.systemd1",
             "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Version"],
        ])
        for args, kwargs in run_calls:
            self.assertIs(kwargs.get("shell"), False)
            self.assertIs(kwargs.get("check"), False)
            self.assertEqual(kwargs["timeout"], 2)
            self.assertIs(kwargs["stdin"], preflight.subprocess.DEVNULL)
            self.assertIs(kwargs["stdout"], preflight.subprocess.DEVNULL)
            self.assertIs(kwargs["stderr"], preflight.subprocess.DEVNULL)
            self.assertEqual(kwargs["env"], {"PATH": preflight.FIXED_PATH, "LANG": "C"})

        encoded = json.dumps(result)
        self.assertNotIn("/fixed/bin/tool", encoded)
        self.assertNotIn("header\n", encoded)
        self.assertNotIn("systemd\n", encoded)

    def test_missing_and_failed_probes_are_distinct_without_inference(self):
        def fake_which(name, path=None):
            return None if name in {"rustc", "pkg-config"} else "/fixed/bin/tool"

        def fake_read(path):
            if path == preflight.SYSTEMD_COMM:
                raise FileNotFoundError(path)
            if path == preflight.APPARMOR_ENABLED:
                raise PermissionError("private path")
            if path == preflight.APPARMOR_LSM:
                return "lockdown,bpf\n"
            return "header\n"

        def fake_run(*args, **kwargs):
            if args[0][0] == "busctl":
                return subprocess.CompletedProcess(args[0], 1)
            raise subprocess.TimeoutExpired(args[0], 2)

        with mock.patch.object(preflight.platform, "system", return_value="Linux"), \
                mock.patch.object(preflight.shutil, "which", side_effect=fake_which), \
                mock.patch.object(preflight, "_read_bounded", side_effect=fake_read), \
                mock.patch.object(preflight, "_probe_readable"), \
                mock.patch.object(preflight.subprocess, "run", side_effect=fake_run):
            result = preflight.diagnose()

        self.assertEqual(result["checks"]["rustc"], "missing")
        self.assertEqual(result["checks"]["pkg-config"], "missing")
        self.assertEqual(result["checks"]["systemd"], "missing")
        self.assertEqual(result["checks"]["apparmor_enabled"], "unknown")
        self.assertEqual(result["checks"]["apparmor_lsm"], "missing")
        self.assertEqual(result["checks"]["libsystemd"], "missing")
        self.assertEqual(result["checks"]["systemd_bus"], "unknown")

    def test_file_not_found_command_is_missing_and_other_failures_unknown(self):
        with mock.patch.object(preflight, "_run_command", side_effect=FileNotFoundError):
            self.assertEqual(preflight._command_status(True, ["tool"]), "missing")
        with mock.patch.object(preflight, "_run_command", side_effect=PermissionError):
            self.assertEqual(preflight._command_status(True, ["tool"]), "unknown")
        with mock.patch.object(preflight, "_run_command", side_effect=subprocess.TimeoutExpired(["tool"], 2)):
            self.assertEqual(preflight._command_status(True, ["tool"]), "unknown")

    def test_unknown_tool_discovery_keeps_derived_checks_unknown(self):
        def fake_which(name, path=None):
            if name in {"pkg-config", "busctl"}:
                raise OSError("permission denied")
            return "/fixed/bin/tool"

        with mock.patch.object(preflight.platform, "system", return_value="Linux"), \
                mock.patch.object(preflight.shutil, "which", side_effect=fake_which), \
                mock.patch.object(preflight, "_read_bounded", return_value="systemd\n"), \
                mock.patch.object(preflight, "_probe_readable"), \
                mock.patch.object(preflight, "_run_command") as run:
            result = preflight.diagnose()

        self.assertEqual(result["checks"]["pkg-config"], "unknown")
        self.assertEqual(result["checks"]["libsystemd"], "unknown")
        self.assertEqual(result["checks"]["busctl"], "unknown")
        self.assertEqual(result["checks"]["systemd_bus"], "unknown")
        run.assert_not_called()

    def test_file_bound_and_readability_probes_do_not_leak_contents(self):
        bounded_handle = mock.mock_open(read_data="x")
        with mock.patch("builtins.open", bounded_handle):
            self.assertEqual(preflight._read_bounded("/fixed/header"), "x")
        bounded_handle.assert_called_once_with("/fixed/header", "r", encoding="utf-8")
        bounded_handle.return_value.read.assert_called_once_with(4096)

        readable_handle = mock.MagicMock()
        with mock.patch("builtins.open", return_value=readable_handle) as opener:
            preflight._probe_readable(preflight.APPARMOR_PROFILES)
            preflight._probe_readable(preflight.SYSTEMD_HEADER)
        opener.assert_has_calls([
            mock.call(preflight.APPARMOR_PROFILES, "rb"),
            mock.call(preflight.SYSTEMD_HEADER, "rb"),
        ])
        self.assertEqual(opener.call_count, 2)
        readable_handle.read.assert_not_called()
        self.assertEqual(readable_handle.close.call_count, 2)
        with mock.patch.object(preflight, "_probe_readable", side_effect=PermissionError):
            self.assertEqual(preflight._readability_status(preflight.SYSTEMD_HEADER), "unknown")

    def test_unsupported_platform_does_no_probe(self):
        with mock.patch.object(preflight.platform, "system", return_value="Darwin"), \
                mock.patch.object(preflight.shutil, "which") as which, \
                mock.patch.object(preflight, "_read_bounded") as read, \
                mock.patch.object(preflight, "_probe_readable") as readable, \
                mock.patch.object(preflight.subprocess, "run") as run:
            result = preflight.diagnose()

        self.assertEqual(result["platform"], "unsupported")
        self.assertTrue(all(value == "unsupported" for value in result["checks"].values()))
        which.assert_not_called()
        read.assert_not_called()
        readable.assert_not_called()
        run.assert_not_called()

    def test_main_sanitizes_unexpected_failure_and_rejects_arguments(self):
        with mock.patch.object(preflight, "diagnose", side_effect=RuntimeError("secret /tmp/raw")), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(preflight.main([]), 1)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["platform"], "linux")
        self.assertTrue(all(value == "unknown" for value in payload["checks"].values()))
        self.assertNotIn("secret", stdout.getvalue())
        self.assertNotIn("/tmp/raw", stdout.getvalue())

        error = io.StringIO()
        with contextlib.redirect_stderr(error):
            self.assertEqual(preflight.main(["--raw-secret"]), 2)
        self.assertEqual(error.getvalue(), "error: no arguments accepted\n")


if __name__ == "__main__":
    unittest.main()
