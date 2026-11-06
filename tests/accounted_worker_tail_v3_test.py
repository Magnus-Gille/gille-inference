"""Hermetic regression flows; no native, host, source-auth or allocation proof."""
import contextlib
import importlib.util
import io as stdio
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

PATH = Path(__file__).with_name('accounted_worker_kernel_v3_test.py')
spec = importlib.util.spec_from_file_location('worker_tail_fixtures', PATH)
fixtures = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = fixtures
spec.loader.exec_module(fixtures)
helper = fixtures.accounted_host_io


class WorkerTailTests(unittest.TestCase):
    def setUp(self):
        self.config, self.body, self.context = fixtures.bootstrap_fixture.fixture()
        self.config['registry']['workerBootstrapV3'] = {'version': 1, 'python_sha256': 'f'*64}
        self.now = self.context['worker_process_observation']['observed_until_boottime_ns']
        self.end = self.body['envelope']['allocated_until_boottime_ns']
        self.poller = SimpleNamespace(register=Mock(), poll=Mock(return_value=[]))

    def clock(self):
        return self.now

    @contextlib.contextmanager
    def fake_runtime(self, *, status=None):
        """Only branch/clock wiring is real. Every host capability is a stub."""
        fake_lib = SimpleNamespace(prctl=Mock(return_value=1))
        observation = self.context['worker_process_observation']
        group = self.context['identity']['cgroup_path']
        status = status or 'NoNewPrivs:\t1\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n'

        def proc(path):
            if path == '/proc/1/stat':
                return fixtures.stat_raw(field22=observation['process_start_ticks'])
            if path.endswith('/cgroup'):
                return '0::'+group+'\n'
            if path == '/proc/1/limits':
                return fixtures.valid_limits(self.body['address_space_limit_bytes'])
            if path.endswith('/status'):
                return status
            raise AssertionError('unexpected proc path')

        def limits(resource):
            if resource == helper.resource.RLIMIT_CORE:
                return (0, 0)
            if resource == helper.resource.RLIMIT_NOFILE:
                return (128, 128)
            raise AssertionError('unexpected resource')

        with contextlib.ExitStack() as stack:
            bindings = ((helper.sys, 'platform', 'linux'), (helper.os, 'geteuid', lambda: 0),
                        (helper.os, 'getpid', lambda: 2), (helper, 'boottime_ns', self.clock),
                        (helper, '_native_v3_worker', Mock()),
                        (helper.resource, 'getrlimit', Mock(side_effect=limits)),
                        (helper.os, 'sched_getscheduler', Mock(return_value=0)),
                        (helper.os, 'sysconf', Mock(return_value=observation['clock_ticks_per_second'])),
                        (helper.ctypes, 'CDLL', Mock(return_value=fake_lib)),
                        (helper.os, 'pidfd_open', Mock(return_value=99)),
                        (helper, 'select', SimpleNamespace(poll=lambda: self.poller, POLLIN=1)),
                        (helper.os, 'close', Mock()), (helper, '_worker_v3_proc', proc),
                        (helper, '_worker_v3_namespaces', Mock(return_value=self.context['identity']['namespace_inodes'])),
                        (helper, '_worker_v3_binary', Mock(return_value=(1, 2, 0, 0))),
                        (helper.os, 'open', Mock(side_effect=AssertionError('real filesystem forbidden'))))
            for obj, name, value in bindings:
                stack.enter_context(patch.object(obj, name, value, create=True))
            stack.enter_context(patch.dict(helper.os.environ, {'INVOCATION_ID': self.context['identity']['invocation_id']}))
            yield

    def test_nonroot_pid1_effective_uid_cannot_authenticate(self):
        for ids in ('1000 1000 1000 1000', '0 1000 0 0'):
            with self.subTest(ids=ids), self.fake_runtime(status='NoNewPrivs:\t1\nUid:\t'+ids+'\nGid:\t1000 1000 1000 1000\n'):
                with self.assertRaises(helper.Refusal) as caught:
                    helper.authenticate_worker_bootstrap_v3(self.config, self.body, self.context)
                self.assertEqual(caught.exception.code, 'worker_v3_pid1_effective_uid')

    def test_root_status_requires_single_complete_uid_gid_records(self):
        valid = 'NoNewPrivs:\t1\nUid:\t0 0 0 0\nGid:\t0 0 0 0\n'
        for raw in (valid.replace('Uid:', 'Absent:'), valid.replace('Gid:', 'Absent:'),
                    valid+'Uid:\t0 0 0 0\n', valid+'Gid:\t0 0 0 0\n',
                    valid.replace('Uid:\t0 0 0 0', 'Uid:\t0 0 0'),
                    valid.replace('Gid:\t0 0 0 0', 'Gid:\t0 x 0 0'),
                    valid.replace('Uid:\t0 0 0 0', 'Uid:\t4294967296 0 0 0')):
            with self.subTest(raw=raw):
                with self.assertRaises(helper.Refusal) as caught:
                    helper._worker_v3_root_status(raw)
                self.assertEqual(caught.exception.code, 'worker_v3_pid1_status')

    def test_root_status_checks_nnp_and_does_not_invent_gid_or_realuid_zero(self):
        valid = 'NoNewPrivs:\t1\nUid:\t1000 0 1000 1000\nGid:\t1000 1000 1000 1000\n'
        helper._worker_v3_root_status(valid)
        for raw in (valid.replace('NoNewPrivs:\t1', 'NoNewPrivs:\t0'), valid+'NoNewPrivs:\t1\n'):
            with self.assertRaises(helper.Refusal) as caught:
                helper._worker_v3_root_status(raw)
            self.assertEqual(caught.exception.code, 'worker_v3_pid1_no_new_privileges')

    def test_hermetic_root_guard_wiring_reaches_the_final_live_check(self):
        # This is a synthetic capability flow, not a real native success.
        with self.fake_runtime():
            fd = helper.authenticate_worker_bootstrap_v3(self.config, self.body, self.context)
            self.assertEqual(fd, 99)
            self.assertEqual(self.poller.poll.call_count, 2)
            helper.os.close(fd)

    @contextlib.contextmanager
    def fake_collection(self, *, expire_source=False, expire_config=False):
        directory = SimpleNamespace(close=Mock(), check=Mock())
        context_raw = helper.canonical(self.context)+b'\n'
        body_raw = helper.canonical(self.body)+b'\n'
        directory.read_file = Mock(side_effect=lambda name, **kw: context_raw if name == 'issuer-context-v3.json' else body_raw)
        source_count = 0
        config_count = 0

        def source_verify(_body):
            nonlocal source_count
            source_count += 1
            if expire_source and source_count == 2:
                self.now = self.end

        def config_read(*_args):
            nonlocal config_count
            config_count += 1
            if expire_config and config_count > 1:
                self.now = self.end
            return self.config

        source = SimpleNamespace(close=Mock(), verify=Mock(side_effect=source_verify))
        own = SimpleNamespace(close=Mock(), read_file=Mock(return_value=b'not-native'))
        files = {'accounted-host-issuer.mjs': {'sha256': self.body['issuer']['entry_sha256']},
                 'accounted-host-io.py': {'sha256': self.body['issuer']['helper_sha256']}}
        root = SimpleNamespace(close=Mock(), check=Mock(), fd=101)

        def collect(*args, **kwargs):
            return {'version': 1, 'kind': 'cgroup_envelope_observation', 'attempt_id': self.body['attempt_id'],
                    'native_envelope': self.context['native_envelope'], 'role_cgroups': self.context['role_cgroups'],
                    'observed_from_boottime_ns': self.now, 'observed_until_boottime_ns': self.now}

        def authenticate(config, body, context):
            # The real lease/context validator runs at both original auth sites.
            helper.validate_worker_bootstrap_v3(config, body, context, self.now)
            return 99

        stdout = SimpleNamespace(buffer=stdio.BytesIO())
        with self.fake_runtime(), contextlib.ExitStack() as stack:
            bindings = (('verify_configured_release', Mock()),
                        ('PinnedDirectory', Mock(side_effect=lambda path, **kw: root if path == '/sys/fs/cgroup' else directory)),
                        ('BrokkrV3ReleaseDirectory', Mock(return_value=source)),
                        ('ReleaseDirectory', Mock(return_value=own)),
                        ('parse_release_manifest', Mock(return_value={'files': files})),
                        ('authenticate_worker_bootstrap_v3', authenticate), ('_require_cgroup2', Mock()),
                        ('_collect_cgroup_at', collect), ('load_configuration', config_read))
            for name, value in bindings:
                stack.enter_context(patch.object(helper, name, value))
            stack.enter_context(patch.object(helper.signal, 'signal'))
            stack.enter_context(patch.object(helper.signal, 'alarm'))
            stack.enter_context(patch.object(helper.sys, 'stdout', stdout))
            yield stdout

    def test_expiry_during_trailing_source_verification_refuses(self):
        with self.fake_collection(expire_source=True):
            with self.assertRaises(helper.Refusal) as caught:
                helper.collect_cgroup_envelope_v1(self.config)
            self.assertEqual(caught.exception.code, 'worker_v3_observation_window')

    def test_expiry_during_final_config_readback_cannot_produce_cli_success(self):
        with self.fake_collection(expire_config=True) as stdout:
            rc = helper.main(['/not-read', '0'*64, 'collect_cgroup_envelope_v1'])
            self.assertEqual(rc, 2)
            self.assertIn(b'worker_v3_observation_window', stdout.buffer.getvalue())
            self.assertNotIn(b'"status":"ok"', stdout.buffer.getvalue())


if __name__ == '__main__':
    unittest.main()
