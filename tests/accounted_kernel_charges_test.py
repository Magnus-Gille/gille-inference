import importlib.util
import os
from pathlib import Path
import sys
import unittest


# Reuse the already bounded own-UID cgroup fixture without importing or running
# its test suite a second time.  The helper itself is seeded from the parent
# worktree and performs no host discovery at import time.
FIXTURE_PATH = Path(__file__).with_name("accounted_cgroup_envelope_test.py")
SPEC = importlib.util.spec_from_file_location("accounted_cgroup_envelope_fixture", FIXTURE_PATH)
fixture = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = fixture
SPEC.loader.exec_module(fixture)
accounted_host_io = fixture.accounted_host_io


KERNEL_FILES = (
    "cpu.stat",
    "memory.stat",
    "memory.current",
    "memory.events.local",
    "pids.current",
    "pids.events.local",
)
RAW_VALUES = {
    "cpu.stat": "usage_usec 100\n",
    "memory.stat": "anon 4096\n",
    "memory.current": "4096\n",
    "memory.events.local": "oom 0\n",
    "pids.current": "1\n",
    "pids.events.local": "max 0\n",
}


class KernelChargesTests(unittest.TestCase):
    _write = staticmethod(fixture.CgroupEnvelopeTests._write)
    _write_controls = fixture.CgroupEnvelopeTests._write_controls

    def setUp(self):
        fixture.CgroupEnvelopeTests.setUp(self)
        for directory in [self.parent, *self.children.values()]:
            for name, value in RAW_VALUES.items():
                self._write(directory / name, value)

    def tearDown(self):
        fixture.CgroupEnvelopeTests.tearDown(self)

    def _collect(self, clock_values=(100, 200, 300), *, aggregate=None, roles=None):
        values = iter(clock_values)
        return accounted_host_io._collect_cgroup_at(
            self.root_fd, fixture.ATTEMPT,
            fixture.AGGREGATE if aggregate is None else aggregate,
            fixture.ROLES if roles is None else roles,
            owner_uid=fixture.OWNER_UID, clock=lambda: next(values),
        )

    def _kernel_dirs(self):
        return [self.parent, *self.children.values()]

    def _collect_kernel(self, clock_values=(100, 200, 300)):
        values = iter(clock_values)
        return accounted_host_io._collect_kernel_at(
            self.root_fd,
            fixture.ATTEMPT,
            fixture.AGGREGATE,
            fixture.ROLES,
            owner_uid=fixture.OWNER_UID,
            clock=lambda: next(values),
        )

    def _assert_code(self, code, action):
        with self.assertRaises(accounted_host_io.Refusal) as raised:
            action()
        self.assertIn(raised.exception.code, code if isinstance(code, tuple) else (code,))

    def test_valid_two_pass_shape_and_fixed_raw_fields(self):
        result = self._collect_kernel()
        self.assertEqual(
            set(result),
            {
                "version", "kind", "attempt_id", "native_envelope", "role_cgroups",
                "observed_from_boottime_ns", "observed_until_boottime_ns", "passes",
            },
        )
        self.assertEqual(result["kind"], "cgroup_kernel_charges_observation")
        self.assertEqual(result["observed_from_boottime_ns"], 100)
        self.assertEqual(result["observed_until_boottime_ns"], 300)
        self.assertEqual([(p["observed_from_boottime_ns"], p["observed_until_boottime_ns"]) for p in result["passes"]], [(100, 200), (200, 300)])
        expected_scopes = ["parent", "worker", "observer", "recovery"]
        for passed in result["passes"]:
            self.assertEqual([sample["scope"] for sample in passed["scope_samples"]], expected_scopes)
            for sample in passed["scope_samples"]:
                self.assertEqual(set(sample), {"scope", "cgroup_device", "cgroup_inode", "cpu_stat", "memory_stat", "memory_current", "memory_events_local", "pids_current", "pids_events_local"})
                for field in KERNEL_FILES:
                    output_field = field.replace(".", "_")
                    self.assertEqual(sample[output_field], RAW_VALUES[field].strip())

    def test_normal_counter_raw_change_is_observed_without_python_semantic_parsing(self):
        calls = 0
        target = self.parent / "memory.current"

        def clock():
            nonlocal calls
            calls += 1
            if calls == 2:
                self._write(target, "8192\n")
            return (100, 200, 300)[calls - 1]

        result = accounted_host_io._collect_kernel_at(
            self.root_fd, fixture.ATTEMPT, fixture.AGGREGATE, fixture.ROLES,
            owner_uid=fixture.OWNER_UID, clock=clock,
        )
        parent_samples = [passed["scope_samples"][0]["memory_current"] for passed in result["passes"]]
        self.assertEqual(parent_samples, ["4096", "8192"])

    def test_legacy_envelope_collector_does_not_require_kernel_files(self):
        for directory in self._kernel_dirs():
            for name in KERNEL_FILES:
                (directory / name).unlink()
        result = self._collect()
        self.assertEqual(result["kind"], "cgroup_envelope_observation")
        self.assertNotIn("passes", result)

    def test_missing_each_fixed_kernel_file_is_refused(self):
        for name in KERNEL_FILES:
            with self.subTest(name=name):
                path = self.parent / name
                path.unlink()
                self._assert_code("kernel_io_refused", self._collect_kernel)
                self._write(path, RAW_VALUES[name])

    def test_missing_kernel_file_on_role_scope_is_refused(self):
        path = self.children["worker"] / "pids.current"
        path.unlink()
        self._assert_code("kernel_io_refused", self._collect_kernel)

    def test_empty_and_non_ascii_kernel_files_are_refused(self):
        self._write(self.parent / "cpu.stat", "")
        self._assert_code("kernel_raw_empty", self._collect_kernel)
        self._write(self.parent / "cpu.stat", b"\xff")
        self._assert_code("cgroup_control_encoding", self._collect_kernel)

    def test_oversized_kernel_file_is_refused(self):
        self._write(self.parent / "memory.stat", b"x" * 65537)
        self._assert_code("cgroup_control_bound", self._collect_kernel)

    def test_nested_role_subgroup_is_still_refused(self):
        nested = self.children["observer"] / "nested.slice"
        nested.mkdir(mode=0o700)
        self._assert_code("cgroup_role_subgroup", self._collect_kernel)

    def test_symlink_hardlink_and_writable_kernel_files_are_refused(self):
        path = self.parent / "cpu.stat"
        path.unlink()
        path.symlink_to(self.parent / "memory.stat")
        self._assert_code(("cgroup_symlink", "kernel_io_refused"), self._collect_kernel)
        path.unlink()
        self._write(path, RAW_VALUES["cpu.stat"])
        os.chmod(path, 0o666)
        self._assert_code("cgroup_control_identity", self._collect_kernel)
        os.chmod(path, 0o644)
        os.link(path, self.parent / "cpu.stat.link")
        self._assert_code("cgroup_control_identity", self._collect_kernel)

    def test_file_inode_replacement_between_passes_is_bounded_drift(self):
        calls = 0
        path = self.parent / "cpu.stat"

        def clock():
            nonlocal calls
            calls += 1
            if calls == 2:
                # Create the replacement before the old file is gone so the
                # inode number cannot be reused (Linux reuses freed inodes).
                replacement = path.with_name("cpu.stat.replacement")
                self._write(replacement, "usage_usec 101\n")
                os.replace(replacement, path)
            return (100, 200, 300)[calls - 1]

        self._assert_code(
            "cgroup_control_drift",
            lambda: accounted_host_io._collect_kernel_at(
                self.root_fd, fixture.ATTEMPT, fixture.AGGREGATE, fixture.ROLES,
                owner_uid=fixture.OWNER_UID, clock=clock,
            ),
        )

    def test_observation_window_is_bounded(self):
        self._assert_code("cgroup_observation_window", lambda: self._collect_kernel((100, 99, 100)))

    def test_raw_kernel_values_are_trimmed_strings(self):
        self._write(self.parent / "cpu.stat", " usage_usec 123 \n")
        result = self._collect_kernel()
        self.assertEqual(result["passes"][0]["scope_samples"][0]["cpu_stat"], "usage_usec 123")

    def test_old_member_and_control_guards_still_run_for_kernel_observation(self):
        self._write(self.parent / "cgroup.procs", "123\n")
        self._assert_code("cgroup_internal_process", self._collect_kernel)
        self._write(self.parent / "cgroup.procs", b"")
        self._write(self.children["observer"] / "memory.oom.group", "0")
        self._assert_code("cgroup_effective_limit", self._collect_kernel)

    def test_kernel_output_has_no_allocation_or_authority_claims(self):
        result = self._collect_kernel()
        self.assertNotIn("address_space_limit_bytes", result)
        self.assertNotIn("allocation", result)
        self.assertNotIn("physicalEvidenceVerified", result)
        self.assertNotIn("executionAuthorized", result)


if __name__ == "__main__":
    unittest.main()
