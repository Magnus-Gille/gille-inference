import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest


HELPER_PATH = Path(__file__).parents[1] / "scripts" / "lib" / "accounted_host_io.py"
SPEC = importlib.util.spec_from_file_location("accounted_host_io_binding_tests", HELPER_PATH)
accounted_host_io = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
import sys
sys.modules[SPEC.name] = accounted_host_io
SPEC.loader.exec_module(accounted_host_io)


OWNER_UID = os.geteuid()
ATTEMPT = "a" * 32
SOURCE = "b" * 40
DESCRIPTOR = accounted_host_io.DESCRIPTOR
ISSUER_RELEASE = "c" * 64
CONFIG_DIGEST = "d" * 64
AS_LIMIT = 64 * 1024 * 1024


def limits(memory, cpu, pids):
    return {"memory_bytes": memory, "cpu_quota_us": cpu, "cpu_period_us": 100000, "pids_max": pids, "swap_bytes": 0}


def body_fixture():
    parent = limits(128 * 1024 * 1024, 9000, 12)
    roles = {
        "worker": {**limits(64 * 1024 * 1024, 2000, 4), "address_space_limit_bytes": AS_LIMIT},
        "observer": {**limits(32 * 1024 * 1024, 1000, 4), "address_space_limit_bytes": AS_LIMIT},
        "recovery": {**limits(32 * 1024 * 1024, 1000, 4), "address_space_limit_bytes": AS_LIMIT},
    }
    files = [{"path": "/usr/bin/podman", "sha256": "1" * 64}]
    manifest_files = {name: hashlib.sha256((name + "\n").encode()).hexdigest() for name in accounted_host_io.BROKKR_V3_FILES}
    manifest = {"source_revision": SOURCE, "files": manifest_files}
    release_id = hashlib.sha256(accounted_host_io.canonical(manifest)).hexdigest()
    body = {
        "version": 3, "attempt_id": ATTEMPT, "release_id": release_id, "source_revision": SOURCE,
        "descriptor_digest": DESCRIPTOR, "executable_path": "/usr/bin/podman", "executable_sha256": "1" * 64,
        "actor_uid": 1000, "actor_gid": 1000, "limits": {key: roles["worker"][key] for key in ("memory_bytes", "cpu_quota_us", "cpu_period_us", "pids_max")},
        "read_files": files, "read_trees": [], "read_dirs": [], "target_host": "m5", "execution_kind": "diagnostic",
        "issuer": {"node_path": "/usr/bin/node", "node_sha256": "2" * 64, "release_digest": ISSUER_RELEASE,
                   "entry_sha256": "3" * 64, "helper_sha256": "4" * 64, "mandate_id": "11111111-1111-4111-8111-111111111111"},
        "address_space_limit_bytes": AS_LIMIT,
        "envelope": {"limits": parent, "role_limits": roles, "lease_id": "5" * 64,
                      "allocated_from_boottime_ns": 100, "allocated_until_boottime_ns": 35_000_000_100,
                      "owner_authorization_digest": "6" * 64, "producer_release_digest": "7" * 64,
                      "producer_config_digest": "8" * 64},
    }
    return body, manifest, release_id


class CgroupBindingTests(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="accounted-binding-", dir=os.path.realpath("/tmp")))
        self.release_root = self.scratch / "releases"
        self.release_root.mkdir(mode=0o700)
        self.body, self.manifest, self.release_id = body_fixture()
        self._install_release()

    def tearDown(self):
        if self.scratch.exists():
            for root, dirs, files in os.walk(self.scratch, topdown=False, followlinks=False):
                for name in files:
                    path = Path(root) / name
                    if not path.is_symlink():
                        os.chmod(path, 0o600)
                for name in dirs:
                    path = Path(root) / name
                    if not path.is_symlink():
                        os.chmod(path, 0o700)
            shutil.rmtree(self.scratch)

    def _install_release(self):
        release = self.release_root / self.release_id
        release.mkdir(mode=0o755)
        for name in accounted_host_io.BROKKR_V3_FILES:
            (release / name).write_bytes((name + "\n").encode())
            os.chmod(release / name, 0o644)
        manifest_raw = accounted_host_io.canonical(self.manifest) + b"\n"
        (release / "release.json").write_bytes(manifest_raw)
        os.chmod(release / "release.json", 0o644)
        self.release = release

    def _config(self, body=None):
        body = self.body if body is None else body
        return {
            "io": {"attempt_id": ATTEMPT, "descriptor_digest": DESCRIPTOR,
                   "brokkr_config_digest": hashlib.sha256(accounted_host_io.canonical(body)).hexdigest(),
                   "issuer_release_digest": ISSUER_RELEASE},
            "accepted": {"sourceRevision": SOURCE, "releaseId": self.release_id,
                         "request": {"limits": {"addressSpaceLimitBytes": AS_LIMIT}}},
            "policy": {"mode": "diagnostic"},
            "registry": {"cgroupEnvelopeV3": {"version": 1, "parent_limits": self.body["envelope"]["limits"],
                "role_limits": {role: {key: value for key, value in spec.items() if key != "address_space_limit_bytes"}
                                for role, spec in self.body["envelope"]["role_limits"].items()}}},
        }

    def assert_refusal(self, action):
        with self.assertRaises(accounted_host_io.Refusal):
            action()

    def test_valid_config_binding_and_release_verify(self):
        validated = accounted_host_io.validate_brokkr_v3_configuration(self.body)
        self.assertEqual(validated["version"], 3)
        self.assertEqual(accounted_host_io.validate_cgroup_v3_binding(self._config(), self.body), validated)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assertIsNone(directory.verify(self.body))
        finally:
            directory.close()

    def test_v2_and_unknown_top_level_shapes_refuse(self):
        for value in ({**self.body, "version": 2}, {**self.body, "unexpected": True}):
            self.assert_refusal(lambda value=value: accounted_host_io.validate_brokkr_v3_configuration(value))

    def test_boolean_and_range_substitutions_refuse(self):
        for key, value in (("actor_uid", True), ("address_space_limit_bytes", 0), ("limits", {**self.body["limits"], "pids_max": 3}),
                           ("limits", {**self.body["limits"], "cpu_period_us": 1})):
            candidate = dict(self.body, **{key: value})
            with self.subTest(key=key):
                self.assert_refusal(lambda candidate=candidate: accounted_host_io.validate_brokkr_v3_configuration(candidate))

    def test_actor_target_and_executable_identity_ranges_refuse(self):
        for candidate in (
            dict(self.body, actor_gid=0),
            dict(self.body, target_host="bad host"),
            dict(self.body, executable_path="/usr/bin/python3"),
            dict(self.body, executable_sha256="9" * 64),
        ):
            self.assert_refusal(lambda candidate=candidate: accounted_host_io.validate_brokkr_v3_configuration(candidate))

    def test_read_rules_reject_secrets_duplicates_and_wrong_tree(self):
        secret = dict(self.body, read_files=[*self.body["read_files"], {"path": "/home/magnus/.env", "sha256": "9" * 64}])
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(secret))
        duplicate = dict(self.body, read_files=[*self.body["read_files"], dict(self.body["read_files"][0])])
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(duplicate))
        wrong_tree = dict(self.body, read_trees=["/etc"])
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(wrong_tree))

    def test_read_rules_require_executable_hash_and_bound_paths(self):
        missing = dict(self.body, read_files=[])
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(missing))
        wrong = dict(self.body, executable_path="/tmp/tool")
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(wrong))

    def test_fixture_mode_requires_null_issuer_but_diagnostic_requires_issuer(self):
        fixture = dict(self.body, execution_kind="fixture", issuer=None)
        self.assertEqual(accounted_host_io.validate_brokkr_v3_configuration(fixture)["execution_kind"], "fixture")
        missing = dict(self.body, issuer=None)
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(missing))

    def test_role_address_space_and_budget_refuse(self):
        bad_as = json.loads(json.dumps(self.body))
        bad_as["envelope"]["role_limits"]["observer"]["address_space_limit_bytes"] += 1
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(bad_as))
        bad_budget = json.loads(json.dumps(self.body))
        bad_budget["envelope"]["role_limits"]["recovery"]["memory_bytes"] = self.body["envelope"]["limits"]["memory_bytes"]
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(bad_budget))
        bad_swap = json.loads(json.dumps(self.body))
        bad_swap["envelope"]["role_limits"]["worker"]["swap_bytes"] = 1
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(bad_swap))

    def test_lease_reversal_short_and_long_refuse(self):
        reversed_lease = json.loads(json.dumps(self.body))
        reversed_lease["envelope"]["allocated_until_boottime_ns"] = 100
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(reversed_lease))
        short = json.loads(json.dumps(self.body))
        short["envelope"]["allocated_until_boottime_ns"] = 29_000_000_100
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(short))
        long = json.loads(json.dumps(self.body))
        long["envelope"]["allocated_until_boottime_ns"] = 91_000_000_100
        self.assert_refusal(lambda: accounted_host_io.validate_brokkr_v3_configuration(long))

    def test_registry_parent_and_role_mismatch_refuse(self):
        config = self._config()
        config["registry"]["cgroupEnvelopeV3"]["parent_limits"] = {**config["registry"]["cgroupEnvelopeV3"]["parent_limits"], "pids_max": 11}
        self.assert_refusal(lambda: accounted_host_io.validate_cgroup_v3_binding(config, self.body))
        config = self._config()
        config["registry"]["cgroupEnvelopeV3"]["role_limits"]["observer"]["pids_max"] = 3
        self.assert_refusal(lambda: accounted_host_io.validate_cgroup_v3_binding(config, self.body))

    def test_registry_version_and_config_digest_mismatch_refuse(self):
        config = self._config()
        config["registry"]["cgroupEnvelopeV3"]["version"] = 2
        self.assert_refusal(lambda: accounted_host_io.validate_cgroup_v3_binding(config, self.body))
        config = self._config()
        config["io"]["brokkr_config_digest"] = "9" * 64
        self.assert_refusal(lambda: accounted_host_io.validate_cgroup_v3_binding(config, self.body))

    def test_binding_config_attempt_source_release_descriptor_and_address_refuse(self):
        for label, config in (
            ("attempt", {**self._config(), "io": {**self._config()["io"], "attempt_id": "e" * 32}}),
            ("descriptor", {**self._config(), "io": {**self._config()["io"], "descriptor_digest": "e" * 64}}),
            ("address", {**self._config(), "accepted": {**self._config()["accepted"], "request": {"limits": {"addressSpaceLimitBytes": AS_LIMIT + 1}}}}),
        ):
            with self.subTest(label=label):
                self.assert_refusal(lambda config=config: accounted_host_io.validate_cgroup_v3_binding(config, self.body))
        changed = dict(self.body, source_revision="e" * 40)
        self.assert_refusal(lambda: accounted_host_io.validate_cgroup_v3_binding(self._config(), changed))

    def test_release_source_revision_hash_and_member_tamper_refuse(self):
        changed = dict(self.body, source_revision="e" * 40)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(changed))
        finally:
            directory.close()
        path = self.release / accounted_host_io.BROKKR_V3_FILES[0]
        os.chmod(path, 0o644)
        path.write_bytes(b"tampered\n")
        os.chmod(path, 0o644)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()

    def test_release_extra_missing_and_wrong_mode_refuse(self):
        extra = self.release / "unexpected.py"
        extra.write_bytes(b"x\n")
        os.chmod(extra, 0o644)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()
        extra.unlink()
        path = self.release / accounted_host_io.BROKKR_V3_FILES[1]
        path.unlink()
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()
        path = self.release / accounted_host_io.BROKKR_V3_FILES[2]
        path.write_bytes((accounted_host_io.BROKKR_V3_FILES[2] + "\n").encode())
        os.chmod(path, 0o600)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()

    def test_release_hardlink_symlink_and_manifest_newline_refuse(self):
        source = self.release / accounted_host_io.BROKKR_V3_FILES[0]
        target = self.release / accounted_host_io.BROKKR_V3_FILES[1]
        target.unlink()
        os.link(source, target)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()
        target.unlink()
        target.symlink_to(source.name)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()
        target.unlink()
        target.write_bytes((accounted_host_io.BROKKR_V3_FILES[1] + "\n").encode())
        os.chmod(target, 0o644)
        manifest = self.release / "release.json"
        manifest.write_bytes(accounted_host_io.canonical(self.manifest))
        os.chmod(manifest, 0o644)
        directory = accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)
        try:
            self.assert_refusal(lambda: directory.verify(self.body))
        finally:
            directory.close()

    def test_release_directory_mode_and_owner_path_refuse(self):
        os.chmod(self.release, 0o775)
        with self.assertRaises(accounted_host_io.Refusal):
            accounted_host_io.BrokkrV3ReleaseDirectory(str(self.release), owner_uid=OWNER_UID)


if __name__ == "__main__":
    unittest.main()
