import importlib.util
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest


HELPER_PATH = Path(__file__).parents[1] / "scripts" / "lib" / "accounted_host_io.py"
SPEC = importlib.util.spec_from_file_location("accounted_host_io_cgroup_tests", HELPER_PATH)
accounted_host_io = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = accounted_host_io
SPEC.loader.exec_module(accounted_host_io)


OWNER_UID = os.geteuid()
ATTEMPT = "a" * 32
PARENT = f"brokkr_accounted_{ATTEMPT}.slice"
ROLE_UNITS = {
    "worker": f"brokkr-accounted-eval-{ATTEMPT}.service",
    "observer": f"brokkr-accounted-observer-{ATTEMPT}.service",
    "recovery": f"brokkr-accounted-recovery-{ATTEMPT}.service",
}
AGGREGATE = {
    "memory_bytes": 128 * 1024 * 1024,
    "cpu_quota_us": 9000,
    "cpu_period_us": 100000,
    "pids_max": 12,
    "swap_bytes": 0,
}
ROLES = {
    "worker": {"memory_bytes": 64 * 1024 * 1024, "cpu_quota_us": 2000, "cpu_period_us": 100000, "pids_max": 4, "swap_bytes": 0},
    "observer": {"memory_bytes": 32 * 1024 * 1024, "cpu_quota_us": 1000, "cpu_period_us": 100000, "pids_max": 4, "swap_bytes": 0},
    "recovery": {"memory_bytes": 32 * 1024 * 1024, "cpu_quota_us": 1000, "cpu_period_us": 100000, "pids_max": 4, "swap_bytes": 0},
}


class CgroupEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="accounted-cgroup-", dir="/private/tmp"))
        self.root = self.scratch / "root"
        self.root.mkdir(mode=0o700)
        self.parent = self.root / PARENT
        self.parent.mkdir(mode=0o700)
        self.children = {}
        for role, unit in ROLE_UNITS.items():
            child = self.parent / unit
            child.mkdir(mode=0o700)
            self.children[role] = child
        self.root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self._write_controls(self.parent, AGGREGATE, oom=0)
        for role, child in self.children.items():
            self._write_controls(child, ROLES[role], oom=1)

    def tearDown(self):
        if getattr(self, "root_fd", None) is not None:
            os.close(self.root_fd)
        if self.scratch.exists():
            for path in sorted(self.scratch.rglob("*"), reverse=True):
                if path.is_symlink():
                    path.unlink()
                elif path.is_file():
                    os.chmod(path, 0o600)
                elif path.is_dir():
                    os.chmod(path, 0o700)
            shutil.rmtree(self.scratch)

    @staticmethod
    def _write(path, value, mode=0o644):
        path.write_bytes(value.encode("ascii") if isinstance(value, str) else value)
        os.chmod(path, mode)

    def _write_controls(self, directory, limits, *, oom):
        self._write(directory / "memory.max", str(limits["memory_bytes"]))
        self._write(directory / "memory.swap.max", "0")
        self._write(directory / "pids.max", str(limits["pids_max"]))
        self._write(directory / "cpu.max", f"{limits['cpu_quota_us']} {limits['cpu_period_us']}")
        self._write(directory / "cpu.max.burst", "0")
        self._write(directory / "memory.oom.group", str(oom))
        self._write(directory / "cgroup.type", "domain")
        self._write(directory / "cgroup.events", "populated 1\nfrozen 0\n")
        self._write(directory / "cgroup.procs", b"")

    def _collect(self, clock_values=(100, 200, 300), *, aggregate=None, roles=None):
        values = iter(clock_values)
        return accounted_host_io._collect_cgroup_at(
            self.root_fd,
            ATTEMPT,
            AGGREGATE if aggregate is None else aggregate,
            ROLES if roles is None else roles,
            owner_uid=OWNER_UID,
            clock=lambda: next(values),
        )

    def assert_refusal(self, action):
        with self.assertRaises(accounted_host_io.Refusal):
            action()

    def test_valid_own_uid_fixture_returns_exact_snapshot_shape(self):
        result = self._collect()
        self.assertEqual(result["version"], 1)
        self.assertEqual(result["kind"], "cgroup_envelope_observation")
        self.assertEqual(result["attempt_id"], ATTEMPT)
        self.assertEqual(result["native_envelope"]["unit"], PARENT)
        self.assertEqual(result["native_envelope"]["cgroup_path"], "/" + PARENT)
        self.assertEqual(result["native_envelope"]["limits"], AGGREGATE)
        self.assertEqual([item["role"] for item in result["role_cgroups"]], ["worker", "observer", "recovery"])
        self.assertEqual([item["unit"] for item in result["role_cgroups"]], list(ROLE_UNITS.values()))
        self.assertEqual(result["observed_from_boottime_ns"], 100)
        self.assertEqual(result["observed_until_boottime_ns"], 300)

    def test_output_contains_no_as_invocation_or_authority_claim(self):
        result = self._collect()
        self.assertNotIn("address_space_limit_bytes", result)
        self.assertNotIn("invocation_id", result)
        self.assertNotIn("physicalEvidenceVerified", result)
        self.assertNotIn("executionAuthorized", result)

    def test_malformed_attempt_is_refused_before_filesystem_read(self):
        self.assert_refusal(lambda: accounted_host_io._collect_cgroup_at(
            self.root_fd, "../bad", AGGREGATE, ROLES, owner_uid=OWNER_UID, clock=lambda: 100
        ))

    def test_aggregate_bounds_are_refused(self):
        for key, value in (("memory_bytes", 1), ("cpu_quota_us", 0), ("cpu_period_us", 99999), ("pids_max", 3), ("swap_bytes", 1)):
            bad = dict(AGGREGATE, **{key: value})
            with self.subTest(key=key):
                self.assert_refusal(lambda bad=bad: self._collect(aggregate=bad))

    def test_role_shape_and_sum_bounds_are_refused(self):
        bad_roles = {role: dict(value) for role, value in ROLES.items()}
        bad_roles.pop("observer")
        self.assert_refusal(lambda: self._collect(roles=bad_roles))
        for key in ("memory_bytes", "cpu_quota_us", "pids_max"):
            bad_roles = {role: dict(value) for role, value in ROLES.items()}
            bad_roles["observer"][key] = AGGREGATE[key]
            with self.subTest(key=key):
                self.assert_refusal(lambda bad_roles=bad_roles: self._collect(roles=bad_roles))

    def test_wrong_controller_caps_are_refused(self):
        target = self.children["worker"] / "cpu.max"
        target.write_text("1999 100000", encoding="ascii")
        self.assert_refusal(self._collect)

    def test_missing_required_control_is_bounded_refusal(self):
        (self.children["worker"] / "memory.max").unlink()
        self.assert_refusal(self._collect)

    def test_missing_required_child_is_bounded_refusal(self):
        child = self.children["recovery"]
        for path in sorted(child.iterdir()):
            if path.is_file():
                os.chmod(path, 0o600)
                path.unlink()
        os.chmod(child, 0o700)
        child.rmdir()
        self.assert_refusal(self._collect)

    def test_wrong_oom_group_and_events_are_refused(self):
        self._write(self.children["recovery"] / "memory.oom.group", "0")
        self.assert_refusal(self._collect)
        self._write(self.children["recovery"] / "memory.oom.group", "1")
        self._write(self.parent / "cgroup.events", "populated 0\nfrozen 0\n")
        self.assert_refusal(self._collect)

    def test_parent_process_file_must_be_empty(self):
        self._write(self.parent / "cgroup.procs", "123\n")
        self.assert_refusal(self._collect)

    def test_extra_child_and_nested_subgroup_are_refused(self):
        extra = self.parent / "unexpected.service"
        extra.mkdir(mode=0o700)
        self.assert_refusal(self._collect)
        extra.rmdir()
        nested = self.children["worker"] / "nested.slice"
        nested.mkdir(mode=0o700)
        self.assert_refusal(self._collect)

    def test_symlink_child_and_symlink_control_are_refused(self):
        link = self.parent / "unexpected-link"
        link.symlink_to(self.children["worker"], target_is_directory=True)
        self.assert_refusal(self._collect)
        link.unlink()
        control = self.children["worker"] / "memory.max"
        control.unlink()
        control.symlink_to(self.parent / "memory.max")
        self.assert_refusal(self._collect)

    def test_wrong_control_permissions_and_hardlink_are_refused(self):
        os.chmod(self.children["worker"] / "pids.max", 0o666)
        self.assert_refusal(self._collect)
        os.chmod(self.children["worker"] / "pids.max", 0o644)
        duplicate = self.children["worker"] / "memory.max.link"
        os.link(self.children["worker"] / "memory.max", duplicate)
        self.assert_refusal(self._collect)

    def test_non_ascii_control_content_is_refused(self):
        self._write(self.children["worker"] / "memory.max", b"\xff")
        self.assert_refusal(self._collect)

    def test_oversize_control_content_is_refused(self):
        self._write(self.children["worker"] / "memory.max", b"1" * 65537)
        self.assert_refusal(self._collect)

    def test_clock_regression_and_one_second_bound_are_refused(self):
        self.assert_refusal(lambda: self._collect(clock_values=(100, 99, 100)))
        self.assert_refusal(lambda: self._collect(clock_values=(100, 1_000_000_101, 1_000_000_102)))

    def test_wrong_owner_uid_is_refused(self):
        self.assert_refusal(lambda: self._collect_with_owner(OWNER_UID + 1))

    def _collect_with_owner(self, owner_uid):
        return accounted_host_io._collect_cgroup_at(
            self.root_fd, ATTEMPT, AGGREGATE, ROLES, owner_uid=owner_uid, clock=lambda: 100
        )

    def test_directory_mode_and_device_identity_requirements_are_refused(self):
        os.chmod(self.children["observer"], 0o775)
        self.assert_refusal(self._collect)


if __name__ == "__main__":
    unittest.main()
