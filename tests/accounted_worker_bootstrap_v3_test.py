import copy
import importlib.util
from pathlib import Path
import sys
import unittest

HELPER = Path(__file__).parents[1] / "scripts" / "lib" / "accounted_host_io.py"
spec = importlib.util.spec_from_file_location("accounted_host_io_bootstrap_tests", HELPER)
accounted_host_io = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = accounted_host_io
spec.loader.exec_module(accounted_host_io)

BINDING_TEST = Path(__file__).with_name("accounted_cgroup_binding_test.py")
binding_spec = importlib.util.spec_from_file_location("accounted_binding_fixture", BINDING_TEST)
binding_fixture = importlib.util.module_from_spec(binding_spec)
assert binding_spec.loader is not None
sys.modules[binding_spec.name] = binding_fixture
binding_spec.loader.exec_module(binding_fixture)

ATTEMPT = "a" * 32
WORKER_UNIT = f"brokkr-accounted-eval-{ATTEMPT}.service"
PARENT = f"brokkr_accounted_{ATTEMPT}.slice"
BOOT_ID = "11111111-1111-4111-8111-111111111111"
DESCRIPTOR = accounted_host_io.DESCRIPTOR


def fixture():
    body, _, release_id = binding_fixture.body_fixture()
    config_holder = binding_fixture.CgroupBindingTests()
    config_holder.body = body
    config_holder.release_id = release_id
    config = config_holder._config(body)
    config["io"]["host_boot_id"] = BOOT_ID
    identity = {
        "boot_id": BOOT_ID, "invocation_id": "1" * 32,
        "cgroup_path": f"/{PARENT}/{WORKER_UNIT}", "cgroup_device": 77,
        "cgroup_inode": 101,
        "namespace_inodes": {"mnt": 111, "net": 112, "ipc": 113, "pid": 114},
    }
    roles = []
    for role in ("worker", "observer", "recovery"):
        unit = f"brokkr-accounted-{'eval' if role == 'worker' else role}-{ATTEMPT}.service"
        inode = {"worker": 101, "observer": 102, "recovery": 103}[role]
        roles.append({
            "role": role, "unit": unit, "cgroup_path": f"/{PARENT}/{unit}",
            "cgroup_device": 77, "cgroup_inode": inode,
            "limits": {key: value for key, value in body["envelope"]["role_limits"][role].items()
                       if key != "address_space_limit_bytes"},
        })
    context = {
        "version": 3, "attempt_id": ATTEMPT, "unit": WORKER_UNIT,
        "source_revision": body["source_revision"], "release_id": release_id,
        "config_digest": config["io"]["brokkr_config_digest"], "descriptor_digest": DESCRIPTOR,
        "identity": identity, "limits": body["limits"],
        "native_envelope": {
            "version": 1, "unit": PARENT, "cgroup_path": f"/{PARENT}",
            "cgroup_device": 77, "cgroup_inode": 100,
            "limits": body["envelope"]["limits"],
        },
        "role_cgroups": roles,
        "worker_process_observation": {
            "version": 1, "kind": "owned_role_process_observation",
            "attempt_id": ATTEMPT, "role": "worker", "identity": copy.deepcopy(identity),
            "process_id": 1, "process_start_ticks": 1000, "clock_ticks_per_second": 100,
            "process_start_boottime_lower_ns": 10_000_000_000,
            "address_space_limit_bytes": body["address_space_limit_bytes"],
            "no_new_privileges": True, "scheduler_policy": 0,
            "observed_from_boottime_ns": 10_000_000_000,
            "observed_until_boottime_ns": 10_000_000_100,
        },
    }
    return config, body, context


class WorkerBootstrapV3Tests(unittest.TestCase):
    def setUp(self):
        self.config, self.body, self.context = fixture()
        self.now = 10_000_000_200

    def validate(self, context=None, body=None, config=None, now=None):
        return accounted_host_io.validate_worker_bootstrap_v3(
            self.config if config is None else config,
            self.body if body is None else body,
            self.context if context is None else context,
            self.now if now is None else now,
        )

    def assert_refusal(self, action):
        with self.assertRaises(accounted_host_io.Refusal):
            action()

    def test_valid_context_is_returned_as_copy_without_authority_flags(self):
        result = self.validate()
        self.assertEqual(result, self.context)
        self.assertIsNot(result, self.context)
        self.assertNotIn("physicalEvidenceVerified", result)
        self.assertNotIn("executionAuthorized", result)

    def test_context_is_closed_and_versioned(self):
        for candidate in (dict(self.context, version=2), dict(self.context, extra=True)):
            self.assert_refusal(lambda candidate=candidate: self.validate(context=candidate))
        missing = dict(self.context)
        del missing["worker_process_observation"]
        self.assert_refusal(lambda: self.validate(context=missing))

    def test_attempt_unit_source_release_config_and_descriptor_bindings_refuse_drift(self):
        for key, value in (("attempt_id", "e" * 32), ("unit", "wrong.service"),
                           ("source_revision", "e" * 40), ("release_id", "e" * 64),
                           ("config_digest", "e" * 64), ("descriptor_digest", "e" * 64)):
            candidate = dict(self.context, **{key: value})
            with self.subTest(key=key):
                self.assert_refusal(lambda candidate=candidate: self.validate(context=candidate))

    def test_identity_and_worker_cgroup_binding_refuse_counterfeit_values(self):
        for key, value in (("boot_id", "not-a-uuid"), ("invocation_id", "not-hex"),
                           ("cgroup_path", "/tmp/fake"), ("cgroup_device", 0), ("cgroup_inode", 0)):
            identity = dict(self.context["identity"], **{key: value})
            candidate = dict(self.context, identity=identity)
            with self.subTest(key=key):
                self.assert_refusal(lambda candidate=candidate: self.validate(context=candidate))

    def test_worker_limits_and_parent_envelope_refuse_drift(self):
        bad_limits = dict(self.context, limits={**self.context["limits"], "pids_max": 5})
        self.assert_refusal(lambda: self.validate(context=bad_limits))
        envelope = dict(self.context["native_envelope"], cgroup_device=78)
        bad_parent = dict(self.context, native_envelope=envelope)
        self.assert_refusal(lambda: self.validate(context=bad_parent))

    def test_body_source_and_registry_binding_refuse_drift(self):
        changed_body = copy.deepcopy(self.body)
        changed_body["source_revision"] = "e" * 40
        self.assert_refusal(lambda: self.validate(body=changed_body))
        bad_config = copy.deepcopy(self.config)
        bad_config["registry"]["cgroupEnvelopeV3"]["version"] = 2
        self.assert_refusal(lambda: self.validate(config=bad_config))

    def test_role_context_closed_fields_refuse_extra_or_missing(self):
        extra = copy.deepcopy(self.context)
        extra["role_cgroups"][0]["extra"] = True
        self.assert_refusal(lambda: self.validate(context=extra))
        missing = copy.deepcopy(self.context)
        del missing["role_cgroups"][1]["limits"]
        self.assert_refusal(lambda: self.validate(context=missing))

    def test_identity_namespace_shape_and_types_refuse(self):
        for key, value in (("mnt", 0), ("net", True), ("ipc", "113")):
            candidate = copy.deepcopy(self.context)
            candidate["identity"]["namespace_inodes"][key] = value
            with self.subTest(key=key):
                self.assert_refusal(lambda candidate=candidate: self.validate(context=candidate))

    def test_observation_numeric_types_and_negative_clock_refuse(self):
        bad_ticks = copy.deepcopy(self.context)
        bad_ticks["worker_process_observation"]["process_start_ticks"] = True
        self.assert_refusal(lambda: self.validate(context=bad_ticks))
        self.assert_refusal(lambda: self.validate(now=-1))

    def test_native_envelope_closed_fields_refuse_extra_or_missing(self):
        extra = copy.deepcopy(self.context)
        extra["native_envelope"]["source"] = "synthetic"
        self.assert_refusal(lambda: self.validate(context=extra))
        missing = copy.deepcopy(self.context)
        del missing["native_envelope"]["limits"]
        self.assert_refusal(lambda: self.validate(context=missing))

    def test_observation_start_end_order_refuses(self):
        reversed_window = copy.deepcopy(self.context)
        reversed_window["worker_process_observation"]["observed_until_boottime_ns"] = 9_999_999_999
        self.assert_refusal(lambda: self.validate(context=reversed_window))

    def test_role_order_membership_caps_and_aliases_refuse(self):
        reordered = dict(self.context, role_cgroups=list(reversed(self.context["role_cgroups"])))
        self.assert_refusal(lambda: self.validate(context=reordered))
        bad_path = copy.deepcopy(self.context)
        bad_path["role_cgroups"][1]["cgroup_path"] += "/nested"
        self.assert_refusal(lambda: self.validate(context=bad_path))
        bad_limit = copy.deepcopy(self.context)
        bad_limit["role_cgroups"][2]["limits"]["memory_bytes"] += 1
        self.assert_refusal(lambda: self.validate(context=bad_limit))
        aliased = copy.deepcopy(self.context)
        aliased["role_cgroups"][1]["cgroup_inode"] = aliased["role_cgroups"][0]["cgroup_inode"]
        self.assert_refusal(lambda: self.validate(context=aliased))

    def test_process_observation_requires_exact_role_pid_and_flags(self):
        for key, value in (("version", 2), ("kind", "fake"), ("role", "observer"),
                           ("process_id", 2), ("no_new_privileges", False), ("scheduler_policy", 1)):
            observation = dict(self.context["worker_process_observation"], **{key: value})
            candidate = dict(self.context, worker_process_observation=observation)
            with self.subTest(key=key):
                self.assert_refusal(lambda candidate=candidate: self.validate(context=candidate))

    def test_process_observation_bad_as_ticks_and_lower_bound_refuse(self):
        for key, value in (("address_space_limit_bytes", self.body["address_space_limit_bytes"] + 1),
                           ("process_start_ticks", -1), ("clock_ticks_per_second", 0),
                           ("process_start_boottime_lower_ns", 1)):
            observation = dict(self.context["worker_process_observation"], **{key: value})
            candidate = dict(self.context, worker_process_observation=observation)
            with self.subTest(key=key):
                self.assert_refusal(lambda candidate=candidate: self.validate(context=candidate))

    def test_process_observation_shape_rejects_extra_and_missing_fields(self):
        extra = copy.deepcopy(self.context)
        extra["worker_process_observation"]["comm"] = "worker"
        self.assert_refusal(lambda: self.validate(context=extra))
        missing = copy.deepcopy(self.context)
        del missing["worker_process_observation"]["observed_until_boottime_ns"]
        self.assert_refusal(lambda: self.validate(context=missing))

    def test_window_rejects_future_end_and_more_than_one_second(self):
        future = copy.deepcopy(self.context)
        future["worker_process_observation"]["observed_until_boottime_ns"] = self.now + 1
        self.assert_refusal(lambda: self.validate(context=future))
        wide = copy.deepcopy(self.context)
        wide["worker_process_observation"]["observed_until_boottime_ns"] = wide["worker_process_observation"]["observed_from_boottime_ns"] + 1_000_000_001
        self.assert_refusal(lambda: self.validate(context=wide, now=wide["worker_process_observation"]["observed_until_boottime_ns"]))

    def test_window_requires_lease_start_and_strict_lease_end(self):
        before_lease = copy.deepcopy(self.context)
        before_lease["worker_process_observation"]["observed_from_boottime_ns"] = 50
        before_lease["worker_process_observation"]["observed_until_boottime_ns"] = 60
        self.assert_refusal(lambda: self.validate(context=before_lease, now=60))
        at_end = copy.deepcopy(self.context)
        at_end["worker_process_observation"]["observed_from_boottime_ns"] = self.body["envelope"]["allocated_until_boottime_ns"] - 1
        at_end["worker_process_observation"]["observed_until_boottime_ns"] = self.body["envelope"]["allocated_until_boottime_ns"]
        self.assert_refusal(lambda: self.validate(context=at_end, now=at_end["worker_process_observation"]["observed_until_boottime_ns"]))

    def test_now_before_lease_end_and_observation_identity_match_are_required(self):
        self.assert_refusal(lambda: self.validate(now=self.body["envelope"]["allocated_until_boottime_ns"]))
        mismatch = copy.deepcopy(self.context)
        mismatch["worker_process_observation"]["identity"]["cgroup_inode"] = 999
        self.assert_refusal(lambda: self.validate(context=mismatch))


if __name__ == "__main__":
    unittest.main()
