"""Contract tests for the pure Harness² candidate profile renderer.

These tests intentionally exercise the declaration boundary and the rendered
argv.  They do not start Podman, systemd, or any candidate process.
"""

from __future__ import annotations

import importlib.util
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path


_PROFILE_PATH = Path(__file__).with_name("profile.py")
_SPEC = importlib.util.spec_from_file_location("harness2_profile_renderer", _PROFILE_PATH)
assert _SPEC is not None and _SPEC.loader is not None
profile = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(profile)


NOW = datetime(2026, 10, 22, 12, 0, tzinfo=timezone.utc)
IMAGE_DIGEST = "a" * 64
HASH = "b" * 64
RUN_ID = "c" * 32


def declaration(**changes):
    value = {
        "version": 1,
        "run_id": RUN_ID,
        "image": f"registry.example/harness2-candidate@sha256:{IMAGE_DIGEST}",
        "source_sha256": HASH,
        "runner_sha256": "d" * 64,
        "verifier_sha256": "e" * 64,
        "pi_version": "1.2.3",
        "harness_sha": "f" * 40,
        "model": "gpt-5.4-sol",
        "effort": "high",
        "provider": "openai",
        "auth": "subscription-oauth",
        "expires_at": (NOW + timedelta(hours=1)).isoformat().replace("+00:00", "Z"),
        "limits": {
            "memory_mib": 2048,
            "workspace_mib": 256,
            "tmp_mib": 64,
            "pids": 64,
            "cpus": 1,
            "seconds": 120,
        },
    }
    for key, value_change in changes.items():
        if key == "limits":
            value["limits"].update(value_change)
        else:
            value[key] = value_change
    return value


class ProfileContractTests(unittest.TestCase):
    def test_exact_valid_plan_is_networkless_and_has_no_host_bind_or_credential_env(self):
        rendered = profile.plan(declaration(), NOW)
        argv = rendered["argv"]
        self.assertEqual(rendered["status"], "planned-not-qualified")
        self.assertIn("--network=none", argv)
        self.assertFalse(any(arg.startswith(("--mount=", "--volume=", "-v")) for arg in argv))

        env = [arg.removeprefix("--env=") for arg in argv if arg.startswith("--env=")]
        self.assertEqual(
            set(env),
            {
                "HOME=/work/home",
                "PATH=/usr/bin:/bin",
                "LANG=C.UTF-8",
                "GIT_CONFIG_NOSYSTEM=1",
                "GIT_CONFIG_GLOBAL=/dev/null",
                "GIT_TERMINAL_PROMPT=0",
                "PYTHONNOUSERSITE=1",
                "PYTHONDONTWRITEBYTECODE=1",
            },
        )
        self.assertFalse(any(name.startswith(("AWS_", "OPENAI_", "ANTHROPIC_", "GITHUB_")) for name in env))
        self.assertNotIn("--env-host", argv)
        self.assertNotIn("--env-file", argv)

    def test_host_proxy_environment_is_not_inherited(self):
        self.assertIn("--http-proxy=false", profile.plan(declaration(), NOW)["argv"])

    def test_short_image_names_are_rejected(self):
        with self.assertRaises(ValueError):
            profile.plan(declaration(image="candidate@sha256:" + IMAGE_DIGEST), NOW)

    def test_image_declared_volumes_cannot_add_unbounded_writes(self):
        self.assertIn("--image-volume=ignore", profile.plan(declaration(), NOW)["argv"])

    def test_resource_ceilings_are_closed_and_enforced(self):
        bounds = {
            "memory_mib": (512, 8192),
            "workspace_mib": (64, 4096),
            "tmp_mib": (32, 512),
            "pids": (16, 512),
            "cpus": (1, 2),
            "seconds": (30, 10800),
        }
        for key, (low, high) in bounds.items():
            with self.subTest(key=key, edge="low"):
                candidate = declaration(limits={key: low})
                self.assertIs(profile.validate(candidate, NOW), candidate)
            with self.subTest(key=key, edge="high"):
                candidate = declaration(limits={key: high}, expires_at=(NOW + timedelta(hours=4)).isoformat())
                # Keep the aggregate tmpfs invariant valid while testing a high
                # individual ceiling.
                if key == "memory_mib":
                    candidate["limits"].update(workspace_mib=4096, tmp_mib=512)
                elif key == "workspace_mib":
                    candidate["limits"].update(memory_mib=8192)
                self.assertIs(profile.validate(candidate, NOW), candidate)
            for invalid in (low - 1, high + 1):
                with self.subTest(key=key, invalid=invalid):
                    with self.assertRaises(ValueError):
                        profile.validate(declaration(limits={key: invalid}), NOW)

        with self.assertRaises(ValueError):
            profile.validate(declaration(limits={"workspace_mib": 1024, "tmp_mib": 1024, "memory_mib": 2048}), NOW)

    def test_boolean_limits_and_version_are_rejected_as_booleans(self):
        for key in profile.LIMITS:
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    profile.validate(declaration(limits={key: True}), NOW)
        with self.assertRaises(ValueError):
            profile.validate(declaration(version=True), NOW)

    def test_declaration_and_limits_use_closed_key_sets(self):
        extra = declaration()
        extra["unexpected"] = "reject"
        with self.assertRaisesRegex(ValueError, "closed version-1"):
            profile.validate(extra, NOW)

        missing = declaration()
        del missing["provider"]
        with self.assertRaisesRegex(ValueError, "closed version-1"):
            profile.validate(missing, NOW)

        extra_limit = declaration(limits={"unexpected": 1})
        with self.assertRaisesRegex(ValueError, "closed resource limits"):
            profile.validate(extra_limit, NOW)

        missing_limit = declaration()
        del missing_limit["limits"]["tmp_mib"]
        with self.assertRaisesRegex(ValueError, "closed resource limits"):
            profile.validate(missing_limit, NOW)

    def test_immutable_hashes_and_exact_versions_are_required(self):
        for key in ("source_sha256", "runner_sha256", "verifier_sha256"):
            for invalid in ("A" * 64, "a" * 63, "g" * 64):
                with self.subTest(key=key, invalid=invalid):
                    with self.assertRaises(ValueError):
                        profile.validate(declaration(**{key: invalid}), NOW)

        with self.assertRaises(ValueError):
            profile.validate(declaration(image="registry.example/candidate:latest"), NOW)
        with self.assertRaises(ValueError):
            profile.validate(declaration(harness_sha="1" * 39), NOW)
        with self.assertRaises(ValueError):
            profile.validate(declaration(pi_version="1.2"), NOW)
        with self.assertRaises(ValueError):
            profile.validate(declaration(model="gpt-sol"), NOW)

    def test_malformed_wrong_timezone_expired_and_too_far_expiry_are_rejected(self):
        for expires_at in (
            "not-a-time",
            "2026-10-22T13:00:00",
            "2026-10-22T13:00:00+01:00",
            "2026-10-22T11:59:59Z",
            "2026-10-23T12:00:01Z",
        ):
            with self.subTest(expires_at=expires_at):
                with self.assertRaises(ValueError):
                    profile.validate(declaration(expires_at=expires_at), NOW)

    def test_expiry_must_cover_runtime_and_thirty_second_cleanup_margin(self):
        runtime = declaration()["limits"]["seconds"]
        expires_at = NOW + timedelta(seconds=runtime + 29)
        candidate = declaration(expires_at=expires_at.isoformat().replace("+00:00", "Z"))
        with self.assertRaisesRegex(ValueError, "expiry"):
            profile.validate(candidate, NOW)

    def test_plan_requires_preloaded_image_environment_inspection(self):
        rendered = profile.plan(declaration(), NOW)
        self.assertIn("preloaded approved image and verified image environment", rendered["requires"])
        self.assertNotIn("--env-host", rendered["argv"])
        self.assertNotIn("--env-file", rendered["argv"])

    def test_declaration_hash_is_stable_and_changes_when_declaration_changes(self):
        first = profile.plan(declaration(), NOW)
        second = profile.plan(deepcopy(declaration()), NOW)
        self.assertEqual(first["declaration_sha256"], second["declaration_sha256"])

        changed = declaration(run_id="1" * 32)
        self.assertNotEqual(first["declaration_sha256"], profile.plan(changed, NOW)["declaration_sha256"])

    def test_rendered_commands_have_immutable_systemd_podman_topology(self):
        rendered = profile.plan(declaration(), NOW)
        argv = rendered["argv"]
        separator = argv.index("--")
        self.assertEqual(
            argv[:separator],
            [
                "/usr/bin/systemd-run",
                "--user",
                "--wait",
                "--pipe",
                "--quiet",
                "--service-type=exec",
                "--expand-environment=no",
                "--unit=harness2-eval-" + RUN_ID,
                "-p",
                "MemoryMax=2048M",
                "-p",
                "MemorySwapMax=0",
                "-p",
                "TasksMax=64",
                "-p",
                "CPUQuota=100%",
                "-p",
                "CPUWeight=25",
                "-p",
                "RuntimeMaxSec=120",
                "-p",
                "TimeoutStopSec=10",
                "-p",
                "KillMode=control-group",
                "-p",
                "OOMPolicy=kill",
            ],
        )
        podman = argv[separator + 1 :]
        self.assertEqual(podman[:2], ["/usr/bin/podman", "run"])
        self.assertIn("--rm", podman)
        self.assertIn("--name=harness2-eval-" + RUN_ID, podman)
        self.assertIn("--entrypoint=/usr/bin/sleep", podman)
        self.assertEqual(podman[-2:], [declaration()["image"], "infinity"])
        self.assertNotIn("bash", podman)
        self.assertNotIn("sh", podman)


if __name__ == "__main__":
    unittest.main()
