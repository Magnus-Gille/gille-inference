import importlib.util
from pathlib import Path
import os
import sys
import unittest
from unittest import mock

HELPER = Path(__file__).parents[1] / "scripts" / "lib" / "accounted_host_io.py"
spec = importlib.util.spec_from_file_location("accounted_host_io_worker_tests", HELPER)
accounted_host_io = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = accounted_host_io
spec.loader.exec_module(accounted_host_io)

BOOTSTRAP_TEST = Path(__file__).with_name("accounted_worker_bootstrap_v3_test.py")
fixture_spec = importlib.util.spec_from_file_location("bootstrap_fixture", BOOTSTRAP_TEST)
bootstrap_fixture = importlib.util.module_from_spec(fixture_spec)
assert fixture_spec.loader is not None
sys.modules[fixture_spec.name] = bootstrap_fixture
fixture_spec.loader.exec_module(bootstrap_fixture)


def stat_raw(comm="worker", state="S", field21=111, field22=222):
    fields = ["0"] * 19
    fields[17] = str(field21)
    fields[18] = str(field22)
    return f"1 ({comm}) {state} " + " ".join(fields)


def valid_limits(address=64 * 1024 * 1024):
    return "\n".join((
        "Max core file size             0                    0 bytes",
        "Max open files                128                  128 files",
        f"Max address space       {address}             {address} bytes",
    ))


class WorkerKernelParserTests(unittest.TestCase):
    def assert_refusal(self, action):
        with self.assertRaises(accounted_host_io.Refusal):
            action()

    def test_start_uses_field22_and_discards_complex_comm(self):
        self.assertEqual(accounted_host_io._worker_v3_start(stat_raw("worker name (nested)", field21=111, field22=222)), 222)

    def test_start_rejects_wrong_pid_state_and_shape(self):
        for raw in ("2 (worker) S " + " ".join(["0"] * 20),
                    stat_raw(state="Z"), "1 (worker S " + " ".join(["0"] * 19),
                    "1 (worker) S " + " ".join(["0"] * 18)):
            self.assert_refusal(lambda raw=raw: accounted_host_io._worker_v3_start(raw))

    def test_start_rejects_overbound_and_bad_ticks(self):
        self.assert_refusal(lambda: accounted_host_io._worker_v3_start("1 (worker) S " + ("0 " * 2048)))
        self.assert_refusal(lambda: accounted_host_io._worker_v3_start(stat_raw(field22="bad")))

    def test_start_rejects_index21_substitution(self):
        raw = stat_raw(field21=987654, field22=123456)
        self.assertEqual(accounted_host_io._worker_v3_start(raw), 123456)

    def test_limits_accept_exact_core_nofile_and_as(self):
        self.assertIsNone(accounted_host_io._worker_v3_pid1_limits(valid_limits(), 64 * 1024 * 1024))

    def test_limits_reject_missing_duplicate_unlimited_and_units(self):
        valid = valid_limits()
        cases = (
            valid.replace("Max open files", "Missing open files"),
            valid + "\nMax open files                128                  128 files",
            valid.replace("0                    0 bytes", "unlimited              unlimited bytes"),
            valid.replace("128                  128 files", "128                  128 bytes"),
        )
        for raw in cases:
            self.assert_refusal(lambda raw=raw: accounted_host_io._worker_v3_pid1_limits(raw, 64 * 1024 * 1024))

    def test_limits_reject_soft_hard_and_address_mismatch(self):
        self.assert_refusal(lambda: accounted_host_io._worker_v3_pid1_limits(valid_limits().replace("128                  128 files", "127                  128 files"), 64 * 1024 * 1024))
        self.assert_refusal(lambda: accounted_host_io._worker_v3_pid1_limits(valid_limits(32 * 1024 * 1024), 64 * 1024 * 1024))

    def test_limits_reject_malformed_or_overbound_numbers(self):
        malformed = valid_limits().replace("128                  128 files", "x                    128 files")
        overbound = valid_limits().replace("128                  128 files", "99999999999999999999  99999999999999999999 files")
        self.assert_refusal(lambda: accounted_host_io._worker_v3_pid1_limits(malformed, 64 * 1024 * 1024))
        self.assert_refusal(lambda: accounted_host_io._worker_v3_pid1_limits(overbound, 64 * 1024 * 1024))


class WorkerAuthenticationRefusalTests(unittest.TestCase):
    def setUp(self):
        self.config, self.body, self.context = bootstrap_fixture.fixture()
        self.config["registry"]["workerBootstrapV3"] = {"version": 1, "python_sha256": "f" * 64}

    def auth(self, config=None):
        return accounted_host_io.authenticate_worker_bootstrap_v3(
            self.config if config is None else config, self.body, self.context
        )

    def assert_code(self, action, code):
        with self.assertRaises(accounted_host_io.Refusal) as caught:
            action()
        self.assertEqual(caught.exception.code, code)

    def good_rlimits(self, core=(0, 0), nofile=(128, 128)):
        def getrlimit(resource_id):
            if resource_id == accounted_host_io.resource.RLIMIT_CORE:
                return core
            if resource_id == accounted_host_io.resource.RLIMIT_NOFILE:
                return nofile
            raise AssertionError(f"unexpected rlimit query: {resource_id}")
        return getrlimit

    def test_wrong_platform_uid_and_pid_have_exact_early_code(self):
        for platform, uid, pid in (("darwin", 0, 2), ("linux", 501, 2), ("linux", 0, 1)):
            with self.subTest(platform=platform, uid=uid, pid=pid), \
                 mock.patch.object(accounted_host_io.sys, "platform", platform), \
                 mock.patch.object(accounted_host_io.os, "geteuid", return_value=uid), \
                 mock.patch.object(accounted_host_io.os, "getpid", return_value=pid):
                self.assert_code(self.auth, "worker_v3_root_linux_child")

    def test_missing_static_profile_has_exact_code_and_no_native_call(self):
        config = dict(self.config, registry={})
        with mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
             mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
             mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
             mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
             mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
             mock.patch.object(accounted_host_io, "_native_v3_worker") as native:
            self.assert_code(lambda: self.auth(config), "worker_v3_profile_fields")
            native.assert_not_called()

    def test_profile_version_and_digest_have_exact_codes(self):
        for profile, code in (({"version": 2, "python_sha256": "f" * 64}, "worker_v3_profile_version"),
                              ({"version": 1, "python_sha256": "bad"}, "digest_or_identifier")):
            config = dict(self.config, registry={"workerBootstrapV3": profile})
            with self.subTest(code=code), \
                 mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
                 mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
                 mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
                 mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
                 mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
                 mock.patch.object(accounted_host_io, "_native_v3_worker") as native:
                self.assert_code(lambda: self.auth(config), code)
                native.assert_not_called()

    def test_public_invocation_mismatch_has_exact_code(self):
        with mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
             mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
             mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
             mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
             mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
             mock.patch.object(accounted_host_io, "_native_v3_worker") as native, \
             mock.patch.dict(accounted_host_io.os.environ, {"INVOCATION_ID": "wrong"}, clear=False):
            self.assert_code(self.auth, "worker_v3_invocation")
            native.assert_not_called()

    def test_core_and_nofile_guards_reach_their_exact_code(self):
        for core, nofile in (((1, 1), (128, 128)), ((0, 0), (127, 127))):
            with self.subTest(core=core, nofile=nofile), \
                 mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
                 mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
                 mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
                 mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
                 mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
                 mock.patch.object(accounted_host_io, "_native_v3_worker") as native, \
                 mock.patch.object(accounted_host_io.resource, "getrlimit", side_effect=self.good_rlimits(core, nofile)), \
                 mock.patch.dict(accounted_host_io.os.environ, {"INVOCATION_ID": self.context["identity"]["invocation_id"]}, clear=False):
                self.assert_code(self.auth, "worker_v3_helper_limits")
                native.assert_called_once()

    def test_scheduler_guard_is_reached_and_proc_is_not_touched(self):
        fake_lib = mock.Mock()
        with mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
             mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
             mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
             mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
             mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
             mock.patch.object(accounted_host_io, "_native_v3_worker") as native, \
             mock.patch.object(accounted_host_io.resource, "getrlimit", side_effect=self.good_rlimits()), \
             mock.patch.object(accounted_host_io.os, "sched_getscheduler", return_value=1, create=True), \
             mock.patch.object(accounted_host_io.ctypes, "CDLL", return_value=fake_lib) as cdll, \
             mock.patch.object(accounted_host_io, "_worker_v3_proc", side_effect=AssertionError("proc reached")), \
             mock.patch.dict(accounted_host_io.os.environ, {"INVOCATION_ID": self.context["identity"]["invocation_id"]}, clear=False):
            self.assert_code(self.auth, "worker_v3_scheduler")
            native.assert_called_once()
            cdll.assert_not_called()

    def test_nnp_guard_reaches_prctl_and_not_pidfd_or_proc(self):
        fake_lib = mock.Mock()
        fake_lib.prctl = mock.Mock(return_value=0)
        with mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
             mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
             mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
             mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
             mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
             mock.patch.object(accounted_host_io, "_native_v3_worker") as native, \
             mock.patch.object(accounted_host_io.resource, "getrlimit", side_effect=self.good_rlimits()), \
             mock.patch.object(accounted_host_io.os, "sched_getscheduler", return_value=0, create=True), \
             mock.patch.object(accounted_host_io.ctypes, "CDLL", return_value=fake_lib), \
             mock.patch.object(accounted_host_io.os, "pidfd_open", side_effect=AssertionError("pidfd reached"), create=True), \
             mock.patch.object(accounted_host_io, "_worker_v3_proc", side_effect=AssertionError("proc reached")), \
             mock.patch.dict(accounted_host_io.os.environ, {"INVOCATION_ID": self.context["identity"]["invocation_id"]}, clear=False):
            self.assert_code(self.auth, "worker_v3_no_new_privileges")
            native.assert_called_once()
            fake_lib.prctl.assert_called_once()

    def test_pidfd_guard_reaches_and_no_proc_is_read(self):
        fake_lib = mock.Mock()
        fake_lib.prctl = mock.Mock(return_value=1)
        with mock.patch.object(accounted_host_io.sys, "platform", "linux"), \
             mock.patch.object(accounted_host_io.os, "geteuid", return_value=0), \
             mock.patch.object(accounted_host_io.os, "getpid", return_value=2), \
             mock.patch.object(accounted_host_io, "boottime_ns", return_value=10_000_000_200), \
             mock.patch.object(accounted_host_io, "validate_worker_bootstrap_v3", return_value=self.context), \
             mock.patch.object(accounted_host_io, "_native_v3_worker") as native, \
             mock.patch.object(accounted_host_io.resource, "getrlimit", side_effect=self.good_rlimits()), \
             mock.patch.object(accounted_host_io.os, "sched_getscheduler", return_value=0, create=True), \
             mock.patch.object(accounted_host_io.ctypes, "CDLL", return_value=fake_lib), \
             mock.patch.object(accounted_host_io.os, "pidfd_open", None, create=True), \
             mock.patch.object(accounted_host_io, "_worker_v3_proc", side_effect=AssertionError("proc reached")), \
             mock.patch.dict(accounted_host_io.os.environ, {"INVOCATION_ID": self.context["identity"]["invocation_id"]}, clear=False):
            self.assert_code(self.auth, "worker_v3_pidfd_unavailable")
            native.assert_called_once()


class OuterCgroupWindowTests(unittest.TestCase):
    def test_actual_outer_samples_must_bracket_the_full_inner_observation(self):
        accounted_host_io._cgroup_v3_observation_bracket(100, {
            'observed_from_boottime_ns': 100, 'observed_until_boottime_ns': 200}, 200)
        for before, start, end, after in ((100, 99, 200, 201), (100, 100, 202, 201),
                                           (100, 200, 199, 201), (100, 100, 1000000101, 1000000200)):
            with self.subTest(before=before, start=start, end=end, after=after):
                with self.assertRaises(accounted_host_io.Refusal) as caught:
                    accounted_host_io._cgroup_v3_observation_bracket(before, {
                        'observed_from_boottime_ns': start, 'observed_until_boottime_ns': end}, after)
                self.assertEqual(caught.exception.code, 'cgroup_v3_outer_observation_window')


if __name__ == "__main__":
    unittest.main()
