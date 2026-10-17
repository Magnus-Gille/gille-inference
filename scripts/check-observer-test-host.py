#!/usr/bin/env python3
"""Emit a content-blind prerequisite diagnostic for the Linux observer fixture.

This is an inventory prerequisite only.  It does not establish cross-UID or MAC
enforcement, start services, load profiles, or run a compiler.
"""

import json
import platform
import shutil
import subprocess
import sys


FIXED_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
FIXED_ENV = {"PATH": FIXED_PATH, "LANG": "C"}
COMMAND_TIMEOUT_SECONDS = 2
MAX_FILE_CHARS = 4096

TOOLS = (
    "rustc",
    "cargo",
    "cc",
    "pkg-config",
    "apparmor_parser",
    "aa-status",
    "busctl",
    "systemctl",
)

CHECKS = (
    *TOOLS,
    "systemd",
    "apparmor_enabled",
    "apparmor_lsm",
    "apparmor_profiles",
    "systemd_header",
    "libsystemd",
    "systemd_bus",
)

SYSTEMD_COMM = "/proc/1/comm"
APPARMOR_ENABLED = "/sys/module/apparmor/parameters/enabled"
APPARMOR_LSM = "/sys/kernel/security/lsm"
APPARMOR_PROFILES = "/sys/kernel/security/apparmor/profiles"
SYSTEMD_HEADER = "/usr/include/systemd/sd-bus.h"


def _result(platform_name, checks):
    """Build the closed output shape used by both normal and failure paths."""
    return {
        "schemaVersion": 1,
        "source": "observer-test-host-preflight",
        "qualifiesObserver": False,
        "platform": platform_name,
        "checks": {name: checks[name] for name in CHECKS},
    }


def _unsupported_result():
    return _result("unsupported", {name: "unsupported" for name in CHECKS})


def _unknown_result(platform_name="linux"):
    return _result(platform_name, {name: "unknown" for name in CHECKS})


def _read_bounded(path):
    """Read at most the fixed bound; callers convert errors to fixed statuses."""
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read(MAX_FILE_CHARS)


def _probe_readable(path):
    """Check readability without reading profile contents."""
    handle = open(path, "rb")
    handle.close()


def _tool_available(name):
    # The returned path is deliberately discarded so it cannot enter the output.
    return shutil.which(name, path=FIXED_PATH) is not None


def _run_command(args):
    """Run one fixed read-only command with no shell or inherited environment."""
    return subprocess.run(
        args,
        shell=False,
        check=False,
        timeout=COMMAND_TIMEOUT_SECONDS,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=dict(FIXED_ENV),
    )


def _read_status(path, predicate, false_status="unknown"):
    try:
        value = _read_bounded(path)
    except FileNotFoundError:
        return "missing"
    except (OSError, UnicodeError):
        return "unknown"
    return "present" if predicate(value) else false_status


def _readability_status(path):
    try:
        _probe_readable(path)
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "unknown"
    return "present"


def _command_status(tool_present, args):
    if tool_present is False:
        return "missing"
    if tool_present is None:
        return "unknown"
    try:
        completed = _run_command(args)
    except FileNotFoundError:
        return "missing"
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return "present" if completed.returncode == 0 else "unknown"


def diagnose():
    """Collect the fixed prerequisite checks without changing host state."""
    if platform.system().lower() != "linux":
        return _unsupported_result()

    checks = {}
    tool_state = {}
    for name in TOOLS:
        try:
            tool_state[name] = _tool_available(name)
            checks[name] = "present" if tool_state[name] else "missing"
        except OSError:
            tool_state[name] = None
            checks[name] = "unknown"

    checks["systemd"] = _read_status(
        SYSTEMD_COMM,
        lambda value: value.strip() == "systemd",
        false_status="unknown",
    )
    try:
        apparmor_enabled = _read_bounded(APPARMOR_ENABLED).strip()
        checks["apparmor_enabled"] = {
            "Y": "present",
            "N": "missing",
        }.get(apparmor_enabled, "unknown")
    except FileNotFoundError:
        checks["apparmor_enabled"] = "missing"
    except (OSError, UnicodeError):
        checks["apparmor_enabled"] = "unknown"
    checks["apparmor_lsm"] = _read_status(
        APPARMOR_LSM,
        lambda value: "apparmor" in {item.strip() for item in value.split(",")},
        false_status="missing",
    )
    checks["apparmor_profiles"] = _readability_status(APPARMOR_PROFILES)
    checks["systemd_header"] = _readability_status(SYSTEMD_HEADER)
    checks["libsystemd"] = _command_status(
        tool_state.get("pkg-config"),
        ["pkg-config", "--exists", "libsystemd"],
    )
    checks["systemd_bus"] = _command_status(
        tool_state.get("busctl"),
        [
            "busctl",
            "--system",
            "get-property",
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
            "Version",
        ],
    )
    return _result("linux", checks)


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]
    if argv == ["--help"]:
        print("usage: check-observer-test-host.py")
        return 0
    if argv:
        sys.stderr.write("error: no arguments accepted\n")
        return 2

    try:
        result = diagnose()
        exit_code = 0
    except Exception:
        # Keep an unexpected failure content-blind and make it visible through
        # the process status without printing exception text or a traceback.
        result = _unknown_result()
        exit_code = 1
    print(json.dumps(result, separators=(",", ":")))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
