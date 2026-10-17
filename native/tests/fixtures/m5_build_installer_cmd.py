#!/usr/bin/python3.real
"""Closed fixture commands for test_m5_build_installer.py.

These commands are copied into a temporary chroot and never run on the host.  They
only model host prerequisites; all state and logs live below /fixture in the chroot.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path


CONTROL = Path("/fixture/control.json")
LOG = Path("/fixture/actions.jsonl")


def command_name(argv0: str | list[str]) -> str:
    value = argv0[0] if isinstance(argv0, list) else argv0
    return Path(value).name


def load_control() -> dict[str, object]:
    return json.loads(CONTROL.read_text(encoding="utf-8"))


def save_control(control: dict[str, object]) -> None:
    CONTROL.write_text(json.dumps(control, sort_keys=True), encoding="utf-8")


def record(name: str, args: list[str]) -> None:
    entry = {
        "argv0": name,
        "args": args,
        "cwd": os.getcwd(),
        "uid": os.getuid(),
        "gid": os.getgid(),
    }
    with LOG.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(entry, sort_keys=True) + "\n")


def _path_arg(args: list[str]) -> str:
    return args[-1] if args else ""


def _stat(args: list[str]) -> int:
    if args[:2] == ["-fc", "%T"]:
        print("cgroup2fs")
        return 0
    if len(args) == 3 and args[0] == "-c" and args[1] in {"%u", "%a"}:
        path = args[2]
        if args[1] == "%u":
            print("60001" if path == "/var/lib/gille-build" else "0")
        else:
            print("700" if path in {"/payload", "/var/lib/gille-build"} else "755")
        return 0
    return 1


def _runuser(args: list[str]) -> int:
    if args[:2] != ["-u", "gille-build"] or "--" not in args:
        return 2
    command = args[args.index("--") + 1 :]
    if not command:
        return 2
    cwd = os.getcwd()
    record("runuser", args)
    try:
        os.setgroups([])
        os.setgid(60001)
        os.setuid(60001)
        os.chdir(cwd)
        if not os.access(cwd, os.R_OK | os.X_OK):
            return 1
        os.execv("/usr/bin/env", ["env", *command])
    except (OSError, PermissionError):
        return 1
    return 1


def _podman(args: list[str], control: dict[str, object]) -> int:
    if args[:2] == ["ps", "-q"]:
        state = control.get("podman_ps", "empty")
        if state == "error":
            return 1
        if state == "nonempty":
            print("fixture-container")
        return 0
    if args[:2] == ["image", "exists"]:
        return 0 if control.get("image_exists", True) else 1
    if args[:2] == ["info", "--format=json"]:
        print(json.dumps({"host": {"security": {"rootless": True}, "cgroupVersion": "v2", "cgroupManager": "systemd"}}))
        return 0
    return 2


def _sshd(args: list[str], control: dict[str, object]) -> int:
    if args == ["-t"]:
        remaining = int(control.get("sshd_t_fail_count", 0))
        if remaining:
            control["sshd_t_fail_count"] = remaining - 1
            save_control(control)
            return 1
        return 0
    if args and args[0] == "-T":
        if control.get("sshd_T", "valid") == "invalid":
            print("forcecommand /wrong/worker")
            return 0
        values = {
            "forcecommand": "/usr/local/libexec/m5-build-worker",
            "authenticationmethods": "publickey",
            "passwordauthentication": "no",
            "kbdinteractiveauthentication": "no",
            "permittty": "no",
            "permituserrc": "no",
            "allowtcpforwarding": "no",
            "allowstreamlocalforwarding": "no",
            "x11forwarding": "no",
            "permittunnel": "no",
            "gatewayports": "no",
        }
        print("\n".join(f"{key} {value}" for key, value in values.items()))
        return 0
    return 2


def _systemctl(args: list[str], control: dict[str, object]) -> int:
    if args[:1] == ["is-active"]:
        unit = args[-1]
        return 0 if unit == control.get("active_unit", "ssh.service") else 1
    if control.get("systemctl_failure"):
        return 1
    return 0


def _sha256sum(args: list[str], control: dict[str, object]) -> int:
    if len(args) != 1:
        return 2
    digest = hashlib.sha256(Path(args[0]).read_bytes()).hexdigest()
    mode = control.get("checksum", "normal")
    calls = int(control.get("checksum_calls", 0))
    control["checksum_calls"] = calls + 1
    save_control(control)
    if mode == "fail" and calls == 0:
        return 1
    if mode == "mismatch" and calls == 1:
        digest = "0" * 64
    print(f"{digest}  {args[0]}")
    return 0


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    name = command_name(sys.argv[0])
    record(name, args)
    control = load_control()

    if name == "stat":
        return _stat(args)
    if name == "id":
        if args == ["-u", "gille-build"]:
            print("60001")
            return 0
        if args == ["-Gn", "gille-build"]:
            print("gille-build")
            return 0
        return 1
    if name == "getent":
        if args == ["passwd", "gille-build"]:
            print("gille-build:x:60001:60001::/var/lib/gille-build:/bin/bash")
            return 0
        return 2
    if name == "mountpoint":
        return 0 if args[:1] == ["-q"] else 2
    if name == "loginctl":
        if args[:2] == ["show-user", "gille-build"]:
            print("yes")
            return 0
        return 2
    if name == "runuser":
        return _runuser(args)
    if name == "podman":
        return _podman(args, control)
    if name == "sshd":
        return _sshd(args, control)
    if name == "systemctl":
        return _systemctl(args, control)
    if name == "sha256sum":
        return _sha256sum(args, control)
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
