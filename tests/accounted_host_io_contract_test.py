"""Contract tests for the accounted-host I/O helper.

These tests use only caller-owned temporary directories and synthetic kernel
facts.  They do not establish native Linux, root, filesystem-durability, or
production service evidence.
"""

import contextlib
import hashlib
import importlib.util
import io as text_io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch


MODULE = Path(__file__).resolve().parents[1] / "scripts/lib/accounted_host_io.py"
spec = importlib.util.spec_from_file_location("accounted_host_io_contract", MODULE)
io_helper = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = io_helper
spec.loader.exec_module(io_helper)


class CanonicalJsonTests(unittest.TestCase):
    def test_brokkr_journal_requires_exactly_one_lf_and_preserves_large_integers(self):
        raw = b'{"inode":9007199254740993,"ns":9007199254740997}\n'
        parsed = io_helper.decode_brokkr_journal(raw)
        self.assertEqual(parsed['ns'], 9007199254740997)
        self.assertEqual(io_helper.canonical(parsed), raw[:-1])
        for bad in [raw[:-1], raw+b'\n', raw[:-1]+b'\r\n', b' {"inode":1}\n']:
            with self.subTest(raw=bad), self.assertRaises(io_helper.Refusal):
                io_helper.decode_brokkr_journal(bad)
        with self.assertRaises(io_helper.Refusal):
            io_helper.decode_json(raw)
    def test_accepts_only_the_closed_ascii_canonical_form(self):
        raw = b'{"items":[true,null,"ok"],"version":1}'
        self.assertEqual(
            io_helper.decode_json(raw),
            {"items": [True, None, "ok"], "version": 1},
        )

    def test_rejects_duplicate_keys_and_numeric_forms_that_are_not_closed(self):
        cases = {
            b'{"a":1,"a":2}': "json_duplicate",
            b'{"a":1.0}': "json_number_unsupported",
            b'{"a":9223372036854775808}': "json_integer_bound",
            b'{"a":123456789012345678901}': "json_integer_bound",
        }
        for raw, code in cases.items():
            with self.subTest(raw=raw, code=code), self.assertRaises(io_helper.Refusal) as caught:
                io_helper.decode_json(raw)
            self.assertEqual(caught.exception.code, code)

    def test_rejects_noncanonical_whitespace_order_and_escaping(self):
        cases = [
            b'{"a": 1}',
            b'{"b":1,"a":2}',
            b'{"a":"\\u0061"}',
        ]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(io_helper.Refusal) as caught:
                io_helper.decode_json(raw)
            self.assertEqual(caught.exception.code, "json_noncanonical")


class ConfigurationTests(unittest.TestCase):
    ATTEMPT = "0123456789abcdef0123456789abcdef"
    HASH = "a" * 64
    HOST_BOOT = "01234567-89ab-cdef-0123-456789abcdef"

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.root = Path(self.scratch.name).resolve()
        os.chmod(self.root, 0o700)

    def tearDown(self):
        self.scratch.cleanup()

    def configuration(self):
        return {
            "version": 1,
            "io": {
                "attempt_id": self.ATTEMPT,
                "issuer_release_digest": self.HASH,
                "brokkr_config_digest": self.HASH,
                "descriptor_digest": io_helper.DESCRIPTOR,
                "protected_manifest_digest": self.HASH,
                "host_boot_id": self.HOST_BOOT,
            },
            "accepted": {},
            "policy": {},
            "registry": {},
        }

    def write_configuration(self, value=None):
        raw = io_helper.canonical(self.configuration() if value is None else value)
        path = self.root / (self.ATTEMPT + ".json")
        path.write_bytes(raw)
        path.chmod(0o600)
        return path, hashlib.sha256(raw).hexdigest()

    def load(self, path, digest):
        return io_helper.load_configuration(
            str(path), digest, owner_uid=os.geteuid(), configuration_root=str(self.root)
        )

    def test_loads_hash_bound_closed_configuration_from_owned_temp_root(self):
        path, digest = self.write_configuration()
        loaded = self.load(path, digest)
        self.assertEqual(loaded["io"]["attempt_id"], self.ATTEMPT)
        self.assertEqual(loaded["io"]["descriptor_digest"], io_helper.DESCRIPTOR)

    def test_rejects_wrong_hash_attempt_descriptor_and_closed_keys(self):
        path, digest = self.write_configuration()
        with self.assertRaises(io_helper.Refusal) as caught:
            self.load(path, "b" * 64)
        self.assertEqual(caught.exception.code, "file_digest")

        for label, mutate, code in (
            ("attempt", lambda value: value["io"].__setitem__("attempt_id", "f" * 32), "configuration_attempt"),
            ("descriptor", lambda value: value["io"].__setitem__("descriptor_digest", "0" * 64), "configuration_descriptor"),
            ("top-level extra", lambda value: value.__setitem__("extra", 1), "configuration_fields"),
            ("io extra", lambda value: value["io"].__setitem__("extra", 1), "configuration_io_fields"),
        ):
            with self.subTest(label=label):
                value = self.configuration()
                mutate(value)
                changed_path, changed_digest = self.write_configuration(value)
                with self.assertRaises(io_helper.Refusal) as changed:
                    self.load(changed_path, changed_digest)
                self.assertEqual(changed.exception.code, code)

    def test_rejects_paths_outside_the_exact_configuration_root(self):
        path, digest = self.write_configuration()
        outside = Path(self.scratch.name).parent / path.name
        for candidate in (
            str(outside),
            str(self.root / "nested" / path.name),
            str(self.root / ".." / self.root.name / path.name),
        ):
            with self.subTest(candidate=candidate), self.assertRaises(io_helper.Refusal) as caught:
                self.load(candidate, digest)
            self.assertEqual(caught.exception.code, "configuration_path")


class CliGateTests(unittest.TestCase):
    def call_main(self):
        output = text_io.StringIO()
        with contextlib.redirect_stdout(output):
            result = io_helper.main(["/not-read", "0" * 64, "clock"])
        return result, output.getvalue()

    def test_non_linux_refuses_before_loader_or_other_operation(self):
        loader = Mock()
        with patch.object(io_helper.sys, "platform", "darwin"), \
                patch.object(io_helper.os, "geteuid", return_value=0), \
                patch.object(io_helper, "load_configuration", loader):
            result, output = self.call_main()
        self.assertEqual(result, 78)
        loader.assert_not_called()
        self.assertEqual(output, '{"reason":"root_linux_required","status":"refused"}\n')


    def test_nonroot_linux_refuses_before_loader_or_other_operation(self):
        loader = Mock()
        with patch.object(io_helper.sys, "platform", "linux"), \
                patch.object(io_helper.os, "geteuid", return_value=1000), \
                patch.object(io_helper, "load_configuration", loader):
            result, output = self.call_main()
        self.assertEqual(result, 78)
        loader.assert_not_called()
        self.assertEqual(output, '{"reason":"root_linux_required","status":"refused"}\n')


class JournalWireTests(unittest.TestCase):
    def test_actual_journal_bytes_are_read_and_normalized_without_losing_nanoseconds(self):
        attempt = 'a'*32
        context = {'version': 1, 'attempt_id': attempt, 'identity': {'cgroup_inode': 9007199254740993}}
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve(); root.chmod(0o700)
            directory = root/attempt; directory.mkdir(mode=0o700)
            for name, body in [('issuer-context.json', context), ('challenge.json', {
                    **context, 'observed_boottime_ns': 9007199254740997})]:
                file = directory/name
                # Exactly the Brokkr Journal.write byte rule, not bare canonical JSON.
                file.write_bytes(io_helper.canonical(body)+b'\n'); file.chmod(0o600)
            config = {'io': {'attempt_id': attempt}, 'accepted': {'request': {'limits': {'addressSpaceLimitBytes': 1000}}}}
            with patch.object(io_helper, 'validate_context', side_effect=lambda _c, value: value), \
                    patch.object(io_helper, 'read_brokkr_configuration', return_value={'address_space_limit_bytes': 1000}), \
                    patch.object(io_helper, 'boottime_ns', return_value=9007199254740998):
                actual = io_helper.read_context(config, state_root=str(root), owner_uid=os.geteuid())
                challenge = io_helper.read_challenge(config, state_root=str(root), owner_uid=os.geteuid())
            self.assertEqual(actual['identity']['cgroup_inode'], 9007199254740993)
            self.assertFalse(challenge.endswith('\n'))
            self.assertEqual(io_helper.decode_json(challenge.encode())['observed_boottime_ns'], 9007199254740997)


class BootstrapTests(unittest.TestCase):
    def configuration(self):
        boot = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        state = {'schemaVersion': 1, 'hostBootIdSha256': hashlib.sha256(boot.encode()).hexdigest(),
                 'observerInstanceSha256': 'b'*64, 'lastSequence': 0, 'seenEvidenceDigests': [], 'seenAttempts': [], 'claims': []}
        record = {'schemaVersion': 1, 'revision': '0', 'originVersion': None, 'parentVersion': None,
                  'state': state, 'stateDigest': hashlib.sha256(io_helper.canonical(state)).hexdigest()}
        raw = io_helper.canonical(record)
        journal = {'mandate_id': '7d195545-ccb9-40c9-9d19-577150de149d', 'observer_instance_sha256': 'b'*64,
                   'origin_version': hashlib.sha256(b'gille-inference/accounted/file-journal/v1\n'+raw).hexdigest(),
                   'bytes_sha256': hashlib.sha256(raw).hexdigest(), 'bytes': raw.decode()}
        return {'policy': {'mode': 'diagnostic'}, 'registry': {'journal': journal}, 'io': {'host_boot_id': boot}}

    def test_bootstrap_is_exact_empty_state_bound_to_origin_boot_and_observer(self):
        config = self.configuration(); path, raw, origin = io_helper.validate_journal_bootstrap(config)
        self.assertEqual(path, '/var/lib/brokkr-accounted/issuer/7d195545-ccb9-40c9-9d19-577150de149d')
        self.assertEqual(raw.decode(), config['registry']['journal']['bytes'])
        self.assertEqual(origin, config['registry']['journal']['origin_version'])
        for field in ['host_boot_id', 'observer']:
            changed = self.configuration()
            if field == 'host_boot_id': changed['io']['host_boot_id'] = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
            else: changed['registry']['journal']['observer_instance_sha256'] = 'd'*64
            with self.subTest(field=field), self.assertRaises(io_helper.Refusal):
                io_helper.validate_journal_bootstrap(changed)

    def test_rehashed_nonempty_replay_or_unsafe_path_cannot_become_bootstrap(self):
        for mutation in ['claim', 'directory', 'self-test']:
            changed = self.configuration(); journal = changed['registry']['journal']
            if mutation == 'claim':
                record = json.loads(journal['bytes']); record['state']['claims'] = [{'reserved': True}]
                record['stateDigest'] = hashlib.sha256(io_helper.canonical(record['state'])).hexdigest()
                raw = io_helper.canonical(record); journal['bytes'] = raw.decode()
                journal['bytes_sha256'] = hashlib.sha256(raw).hexdigest()
                journal['origin_version'] = hashlib.sha256(b'gille-inference/accounted/file-journal/v1\n'+raw).hexdigest()
            elif mutation == 'directory': journal['mandate_id'] = '../other'
            else: changed['policy']['mode'] = 'self-test'
            with self.subTest(mutation=mutation), self.assertRaises(io_helper.Refusal):
                io_helper.validate_journal_bootstrap(changed)

    def test_initialization_creates_once_and_never_adopts_or_resets_existing_state(self):
        config = self.configuration(); mandate = config['registry']['journal']['mandate_id']
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve(); root.chmod(0o755); target = root/mandate; target.mkdir(mode=0o700)
            original_class = io_helper.PinnedDirectory; original_publish = original_class.publish_once
            def own_directory(path, **kw):
                return original_class(path, owner_uid=os.geteuid(), **kw)
            def synthetic_rename(fd, source, destination):
                try: os.stat(destination, dir_fd=fd, follow_symlinks=False)
                except FileNotFoundError: os.rename(source, destination, src_dir_fd=fd, dst_dir_fd=fd)
                else: raise FileExistsError('exists')
            def publish(instance, name, value, deadline):
                # The fake adapter tests protocol only, never actual Linux atomicity.
                return original_publish(instance, name, value, deadline, clock=lambda: 10,
                                        rename_noreplace=synthetic_rename)
            with patch.object(io_helper, 'JOURNAL_ROOT', str(root)), \
                    patch.object(io_helper, 'PinnedDirectory', side_effect=own_directory), \
                    patch.object(original_class, 'publish_once', new=publish), \
                    patch.object(io_helper, 'read_kernel_file', return_value=config['io']['host_boot_id']), \
                    patch.object(io_helper, 'read_brokkr_configuration'), \
                    patch.object(io_helper, 'boottime_ns', return_value=10):
                result = io_helper.initialize_journal(config)
                self.assertEqual(result['status'], 'initialized')
                self.assertEqual((target/'journal.json').read_text(), config['registry']['journal']['bytes'])
                with self.assertRaises(io_helper.Refusal) as duplicate:
                    io_helper.initialize_journal(config)
                self.assertEqual(duplicate.exception.code, 'journal_bootstrap_not_empty')
                self.assertEqual(duplicate.exception.outcome, 'unknown')
                self.assertEqual([p.name for p in target.iterdir()], ['journal.json'])
                (root/'prior-epoch').mkdir(mode=0o700)
                with self.assertRaises(io_helper.Refusal) as other:
                    io_helper.initialize_journal(config)
                self.assertEqual(other.exception.code, 'journal_other_epoch_requires_reconciliation')

    def test_root_owned_brokkr_config_has_its_own_exact_journal_format_and_value_digest(self):
        body = {'version': 2, 'attempt_id': 'a'*32, 'execution_kind': 'fixture', 'address_space_limit_bytes': 1000}
        raw = io_helper.canonical(body)
        config = {'io': {'attempt_id': 'a'*32, 'brokkr_config_digest': hashlib.sha256(raw).hexdigest()},
                  'policy': {'mode': 'self-test'}}
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch).resolve(); root.chmod(0o755)
            file = root/('a'*32+'.json'); file.write_bytes(raw+b'\n'); file.chmod(0o600)
            self.assertEqual(io_helper.read_brokkr_configuration(config, configuration_root=str(root), owner_uid=os.geteuid()), body)
            file.write_bytes(io_helper.canonical({**body, 'address_space_limit_bytes': 2000})+b'\n')
            with self.assertRaises(io_helper.Refusal):
                io_helper.read_brokkr_configuration(config, configuration_root=str(root), owner_uid=os.geteuid())

class ContextValidationTests(unittest.TestCase):
    ATTEMPT = "0123456789abcdef0123456789abcdef"
    CONFIG_DIGEST = "a" * 64
    HOST_BOOT = "01234567-89ab-cdef-0123-456789abcdef"
    ADDRESS_SPACE = 9_000_000
    UNIT = "brokkr-accounted-eval-" + ATTEMPT + ".service"
    GROUP = "/system.slice/" + UNIT

    def setUp(self):
        self.config = {
            "io": {
                "attempt_id": self.ATTEMPT,
                "brokkr_config_digest": self.CONFIG_DIGEST,
                "descriptor_digest": io_helper.DESCRIPTOR,
                "host_boot_id": self.HOST_BOOT,
            },
            "accepted": {
                "sourceRevision": "e" * 40,
                "releaseId": "f" * 64,
                "request": {"limits": {"addressSpaceLimitBytes": self.ADDRESS_SPACE}},
            },
        }
        self.context = {
            "version": 1,
            "attempt_id": self.ATTEMPT,
            "unit": self.UNIT,
            "source_revision": "e" * 40,
            "release_id": "f" * 64,
            "config_digest": self.CONFIG_DIGEST,
            "descriptor_digest": io_helper.DESCRIPTOR,
            "identity": {
                "boot_id": self.HOST_BOOT,
                "invocation_id": "f" * 32,
                "cgroup_device": 123,
                "cgroup_inode": 456,
                "cgroup_path": self.GROUP,
                "namespace_inodes": {"mnt": 11, "net": 12, "ipc": 13, "pid": 14},
            },
            "limits": {
                "memory_bytes": 16777216,
                "cpu_quota_us": 500,
                "cpu_period_us": 100000,
                "pids_max": 10,
            },
        }

    def mocked_kernel(self):
        limits = {
            "memory.max": "16777216",
            "memory.swap.max": "0",
            "memory.oom.group": "1",
            "pids.max": "10",
            "cpu.max": "500 100000",
            "cgroup.type": "domain",
            "cgroup.subtree_control": "",
        }

        def read(path, maximum):
            if path == "/proc/sys/kernel/random/boot_id":
                return self.HOST_BOOT
            if path == f"/proc/{os.getpid()}/cgroup":
                return "0::" + self.GROUP
            for field, value in limits.items():
                if path.endswith("/" + field):
                    return value
            raise AssertionError("unexpected synthetic kernel path: " + path)

        def fake_stat(path, **kwargs):
            if path == "/sys/fs/cgroup" + self.GROUP:
                return types.SimpleNamespace(
                    st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_dev=123, st_ino=456
                )
            for name, inode in self.context["identity"]["namespace_inodes"].items():
                if path == f"/proc/{os.getpid()}/ns/{name}":
                    return types.SimpleNamespace(st_ino=inode)
            raise AssertionError("unexpected synthetic stat path: " + path)

        return read, fake_stat

    def validate_with_mocks(self, context=None, rlimit=None):
        read, fake_stat = self.mocked_kernel()
        if rlimit is None:
            rlimit = (self.ADDRESS_SPACE, self.ADDRESS_SPACE)
        with patch.object(io_helper, "read_kernel_file", side_effect=read) as kernel, \
                patch.object(io_helper.os, "stat", side_effect=fake_stat), \
                patch.object(io_helper.resource, "getrlimit", return_value=rlimit):
            result = io_helper.validate_context(self.config, context or self.context)
        return result, kernel

    def test_valid_context_uses_only_synthetic_kernel_facts(self):
        result, kernel = self.validate_with_mocks()
        self.assertIs(result, self.context)
        self.assertTrue(kernel.called)
        self.assertTrue(all(call.args[0].startswith(("/proc/", "/sys/fs/cgroup/")) for call in kernel.call_args_list))

    def test_rejects_binding_namespace_limit_and_address_space_failures(self):
        cases = []
        binding = dict(self.context)
        binding["attempt_id"] = "f" * 32
        cases.append(("binding", binding, None, "context_binding"))

        namespace = json.loads(json.dumps(self.context))
        namespace["identity"]["namespace_inodes"]["net"] = 999
        cases.append(("namespace", namespace, None, "context_namespace"))

        limits = json.loads(json.dumps(self.context))
        limits["limits"]["memory_bytes"] = 16777217
        cases.append(("limit", limits, None, "context_effective_limit"))

        for label, context, rlimit, code in cases:
            with self.subTest(label=label), self.assertRaises(io_helper.Refusal) as caught:
                self.validate_with_mocks(context, rlimit)
            self.assertEqual(caught.exception.code, code)

        with self.assertRaises(io_helper.Refusal) as caught:
            self.validate_with_mocks(rlimit=(self.ADDRESS_SPACE, self.ADDRESS_SPACE - 1))
        self.assertEqual(caught.exception.code, "context_address_space")


if __name__ == "__main__":
    unittest.main()
