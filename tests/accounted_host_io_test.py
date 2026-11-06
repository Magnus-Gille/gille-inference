"""Unprivileged local I/O tests; no native Linux, root or M5 evidence."""
import errno
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'scripts/lib/accounted_host_io.py'
spec = importlib.util.spec_from_file_location('accounted_host_io', MODULE)
io = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = io
spec.loader.exec_module(io)


class FileTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.path = Path(self.scratch.name).resolve()
        os.chmod(self.path, 0o700)
        self.directory = io.PinnedDirectory(str(self.path), owner_uid=os.geteuid())
        self.now = 10

    def tearDown(self):
        self.directory.close()
        self.scratch.cleanup()

    def publish(self, name='record.json', value=b'{"version":1}', **kw):
        # Fake adapter exercises ordering/file behavior only. Linux renameat2 is NOT proved.
        def no_replace(fd, source, target):
            try:
                os.stat(target, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                os.rename(source, target, src_dir_fd=fd, dst_dir_fd=fd)
            else:
                raise FileExistsError(errno.EEXIST, 'exists')
        return self.directory.publish_once(name, value, 100, clock=lambda: self.now,
                                           rename_noreplace=kw.pop('rename_noreplace', no_replace), **kw)

    def test_publishes_complete_singlelink_private_file_and_never_replaces(self):
        result = self.publish()
        target = self.path / 'record.json'
        self.assertEqual(target.read_bytes(), b'{"version":1}')
        self.assertEqual(target.stat().st_mode & 0o7777, 0o600)
        self.assertEqual(target.stat().st_nlink, 1)
        self.assertEqual(result['status'], 'published')
        with self.assertRaises(io.Refusal):
            self.publish(value=b'{"changed":1}')
        self.assertEqual(target.read_bytes(), b'{"version":1}')

    def test_expiry_before_work_creates_nothing(self):
        self.now = 100
        with self.assertRaises(io.Refusal) as e:
            self.publish()
        self.assertEqual(e.exception.outcome, 'refused')
        self.assertEqual(list(self.path.iterdir()), [])

    def test_late_rename_is_unknown_and_retained_never_acknowledged(self):
        def delayed(fd, source, target):
            os.rename(source, target, src_dir_fd=fd, dst_dir_fd=fd)
            self.now = 100
        with self.assertRaises(io.Refusal) as e:
            self.publish(rename_noreplace=delayed)
        self.assertEqual(e.exception.outcome, 'unknown')
        self.assertEqual((self.path/'record.json').read_bytes(), b'{"version":1}')
        # Consumer deadline validation remains mandatory. This is not a kernel deadline.

    def test_failed_rename_preserves_preexisting_target_and_quarantines_temp(self):
        target = self.path/'record.json'; target.write_bytes(b'unknown'); target.chmod(0o600)
        with self.assertRaises(io.Refusal):
            self.publish()
        self.assertEqual(target.read_bytes(), b'unknown')
        self.assertTrue(any(p.name.startswith('.accounted-') for p in self.path.iterdir()))

    def test_missing_native_noreplace_has_no_fallback(self):
        with patch.object(io.sys, 'platform', 'darwin'):
            with self.assertRaises(io.Refusal):
                self.directory.publish_once('record.json', b'{}', 100, clock=lambda: 10)
        self.assertFalse((self.path/'record.json').exists())

    def test_refuses_writable_foreign_or_linked_files(self):
        target = self.path/'record.json'; target.write_bytes(b'{}'); target.chmod(0o644)
        with self.assertRaises(io.Refusal):
            self.directory.read_file('record.json', maximum=100)
        target.chmod(0o600); os.link(target, self.path/'second.json')
        with self.assertRaises(io.Refusal):
            self.directory.read_file('record.json', maximum=100)

    def test_symlink_fifo_and_oversize_refused_without_blocking(self):
        (self.path/'link.json').symlink_to('/dev/null')
        os.mkfifo(self.path/'pipe.json', 0o600)
        p = self.path/'large.json'; p.write_bytes(b'a'*101); p.chmod(0o600)
        for name in ['link.json', 'pipe.json', 'large.json']:
            with self.subTest(name=name), self.assertRaises(io.Refusal):
                self.directory.read_file(name, maximum=100)

    def test_ancestor_or_target_replacement_refused(self):
        old = self.path.with_name(self.path.name+'-old')
        self.path.rename(old); self.path.mkdir(mode=0o700)
        try:
            with self.assertRaises(io.Refusal):
                self.publish()
            self.assertEqual(list(self.path.iterdir()), [])
        finally:
            self.path.rmdir(); old.rename(self.path)

    def test_rejects_noncanonical_names_and_payload_types(self):
        for name in ['../x', 'x/y', '', '.hidden', 'x\x00y']:
            with self.subTest(name=name), self.assertRaises(io.Refusal):
                self.publish(name=name)
        for value in [b'', b'x'*65537, 'text']:
            with self.subTest(value_type=type(value).__name__), self.assertRaises(io.Refusal):
                self.publish(value=value)

    def test_read_hash_and_closed_handle_fail_closed(self):
        self.publish()
        self.assertEqual(self.directory.read_file('record.json', maximum=100), b'{"version":1}')
        with self.assertRaises(io.Refusal):
            self.directory.read_file('record.json', maximum=100, expected_sha256='0'*64)
        self.directory.close()
        with self.assertRaises(io.Refusal):
            self.directory.read_file('record.json', maximum=100)

    def test_public_config_directory_can_only_be_opened_for_reading(self):
        self.directory.close(); os.chmod(self.path, 0o755)
        reader = io.PinnedDirectory(str(self.path), owner_uid=os.geteuid(), private_target=False)
        try:
            file = self.path/'config.json'; file.write_bytes(b'{}'); file.chmod(0o600)
            self.assertEqual(reader.read_file('config.json', maximum=100), b'{}')
            with self.assertRaises(io.Refusal) as failure:
                reader.publish_once('new.json', b'{}', 100, clock=lambda: 10)
            self.assertEqual(failure.exception.code, 'directory_readonly')
            self.assertFalse((self.path/'new.json').exists())
        finally:
            reader.close()


class ClockTests(unittest.TestCase):
    def test_post_initialization_read_failure_is_unknown_after_the_file_was_written(self):
        state = {'written': False}
        class Directory:
            def __init__(self, _): pass
            def publish_once(self, *_): state['written'] = True
            def close(self): pass
        class Bridge:
            offset_ns = 1000
            uncertainty_ns = 1
            def read(self): raise io.Refusal('clock_bridge_drift')
        with patch.object(io, 'read_context'), patch.object(io.ClockBridge, 'sample', return_value=Bridge()), \
                patch.object(io, 'PinnedDirectory', Directory), patch.object(io, 'boottime_ns', return_value=10):
            with self.assertRaises(io.Refusal) as failure:
                io.initialize_clock({'io': {'attempt_id': 'a'*32, 'host_boot_id': 'fake-boot'}})
        self.assertTrue(state['written'])
        self.assertEqual(failure.exception.outcome, 'unknown')

    def test_bridge_uses_actual_boottime_and_exact_integer_utc(self):
        b = io.ClockBridge(offset_ns=1_700_000_000_000_000_000, uncertainty_ns=100)
        sample = b.read(boottime=lambda: 123456789, realtime=lambda: 1_700_000_000_123456789)
        self.assertEqual(sample['boottimeNs'], '123456789')
        self.assertEqual(sample['utc'], '2023-11-14T22:13:20.123456Z')

    def test_refuses_clock_drift_or_regression(self):
        b = io.ClockBridge(offset_ns=1_000_000_000, uncertainty_ns=100)
        b.read(boottime=lambda: 1000, realtime=lambda: 1_000_001_000)
        with self.assertRaises(io.Refusal):
            b.read(boottime=lambda: 999, realtime=lambda: 1_000_000_999)
        with self.assertRaises(io.Refusal):
            b.read(boottime=lambda: 2000, realtime=lambda: 1_000_004_001)

    def test_bounded_sample_refuses_wide_or_invalid_clock_reads(self):
        ticks = iter([0, 5000]*8)
        with self.assertRaises(io.Refusal):
            io.ClockBridge.sample(boottime=lambda: next(ticks), realtime=lambda: 1000)
        for bad in [True, -1, 2**63]:
            with self.subTest(bad=bad), self.assertRaises(io.Refusal):
                io.ClockBridge.sample(boottime=lambda: bad, realtime=lambda: 1000)

    def test_initial_uncertainty_does_not_expand_the_one_microsecond_drift_budget(self):
        b = io.ClockBridge(offset_ns=1_000_000_000, uncertainty_ns=1000)
        with self.assertRaises(io.Refusal):
            b.read(boottime=lambda: 1000, realtime=lambda: 1_000_001_001)


class PublicationModeTests(unittest.TestCase):
    def test_cleanup_failure_after_publication_never_changes_unknown_to_refused(self):
        attempt = 'a'*32
        identity = {'boot_id': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'invocation_id': 'b'*32,
                    'cgroup_device': 1, 'cgroup_inode': 2, 'namespace_inodes': {'mnt': 3, 'net': 4, 'ipc': 5, 'pid': 6}}
        challenge = {'attempt_id': attempt, 'config_digest': 'c'*64, 'descriptor_digest': io.DESCRIPTOR,
                     'limits': {}, 'identity': identity, 'observed_boottime_ns': 10}
        record = {'version': 2, **{k: challenge[k] for k in ['attempt_id', 'config_digest', 'descriptor_digest', 'limits']},
                  **identity, 'coverage': {}, 'issued_boottime_ns': 10, 'expires_boottime_ns': 30_000_000_010,
                  'publication_deadline_boottime_ns': 20, 'protected_manifest_digest': 'd'*64, 'issuer_release_digest': 'e'*64}
        config = {'policy': {'mode': 'diagnostic'}, 'io': {'attempt_id': attempt,
                  'protected_manifest_digest': 'd'*64, 'issuer_release_digest': 'e'*64}}
        state = {'published': False}
        class Directory:
            def __init__(self, _): pass
            def publish_once(self, *_): state['published'] = True; return {'status': 'published'}
            def close(self): raise io.Refusal('directory_close_failed')
        with patch.object(io, 'read_challenge', return_value=io.canonical(challenge).decode()), \
                patch.object(io, 'boottime_ns', return_value=10), patch.object(io, 'PinnedDirectory', Directory):
            with self.assertRaises(io.Refusal) as failure:
                io.publish_admission(config, {'bytes': io.canonical(record).decode(), 'deadline_boottime_ns': 20})
        self.assertTrue(state['published'])
        self.assertEqual(failure.exception.outcome, 'unknown')

    def test_self_test_configuration_cannot_reach_admission_reads_or_writes(self):
        record = dict.fromkeys(['attempt_id', 'config_digest', 'descriptor_digest', 'boot_id', 'invocation_id',
                                'cgroup_device', 'cgroup_inode', 'namespace_inodes', 'issued_boottime_ns',
                                'expires_boottime_ns', 'limits', 'coverage', 'protected_manifest_digest',
                                'issuer_release_digest'], 1)
        record.update(version=2, publication_deadline_boottime_ns=123)
        with patch.object(io, 'read_challenge', side_effect=AssertionError('must not read')) as reader:
            with self.assertRaises(io.Refusal) as failure:
                io.publish_admission({'policy': {'mode': 'self-test'}},
                                     {'bytes': io.canonical(record).decode(), 'deadline_boottime_ns': 123})
        self.assertEqual(failure.exception.code, 'publication_mode')
        reader.assert_not_called()


if __name__ == '__main__':
    unittest.main()
