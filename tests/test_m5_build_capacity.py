#!/usr/bin/env python3
"""Focused capacity/status protocol tests with no host or container access."""
import importlib.util
import io
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'worker_capacity', Path(__file__).resolve().parents[1] / 'scripts/m5-build-worker.py')
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)


def capacity(**changes):
    value = {
        'total_bytes': 64 * 1024 ** 3,
        'used_bytes': 32 * 1024 ** 3,
        'free_bytes': 32 * 1024 ** 3,
    }
    value.update(changes)
    return value


class Input:
    def __init__(self, value):
        self.buffer = io.BytesIO(value)


class CapacityProtocol(unittest.TestCase):
    def test_status_request_requires_exact_header_and_no_trailing_data(self):
        line, value = w.read_header_line(io.BytesIO(b'{"version":1,"operation":"status"}\n'))
        self.assertEqual(line, b'{"version":1,"operation":"status"}\n')
        w.read_status_request(io.BytesIO(b''), value)
        for trailing in (b'x', b'\n', b'{}'):
            with self.subTest(trailing=trailing), self.assertRaises(w.BuildError):
                w.read_status_request(io.BytesIO(trailing), value)
        for value in ({'version': 1, 'operation': 'status', 'extra': 1},
                      {'version': 1, 'operation': 'build'},
                      {'version': True, 'operation': 'status'}):
            with self.subTest(value=value), self.assertRaises(w.BuildError):
                w.read_status_request(io.BytesIO(), value)

    def test_capacity_observation_rejects_malformed_bounded_counters(self):
        usage = mock.Mock(total=100, used=50, free=50)
        with mock.patch.object(w.shutil, 'disk_usage', return_value=usage):
            observed = w.observe_capacity()
        self.assertEqual(observed['free_bytes'], 50)
        self.assertEqual(observed['minimum_free_bytes'], 1024 ** 3)
        self.assertEqual(observed['warning_free_bytes'], 8 * 1024 ** 3)
        for values in [
            dict(total=100, used=101, free=1),
            dict(total=100, used=1, free=101),
            dict(total=-1, used=0, free=0),
            dict(total=1 << 53, used=0, free=1),
            dict(total=True, used=0, free=1),
        ]:
            with self.subTest(values=values), mock.patch.object(w.shutil, 'disk_usage', return_value=mock.Mock(**values)), self.assertRaises(w.BuildError):
                w.observe_capacity()

    def test_status_path_is_read_only_and_emits_capacity_then_success(self):
        observed = capacity(free_bytes=512 * 1024 ** 2)
        events = []
        with mock.patch.object(w, 'sys', wraps=sys) as system, \
             mock.patch.object(w, 'load_config', return_value={}) as load_config, \
             mock.patch.object(w, 'observe_capacity', return_value=observed), \
             mock.patch.object(w, 'emit', side_effect=lambda kind, **fields: events.append((kind, fields))), \
             mock.patch.object(w, 'private_directory') as private_directory, \
             mock.patch.object(w, 'cleanup_stale') as cleanup, \
             mock.patch.object(w, 'read_request') as read_request, \
             mock.patch.object(w, 'run_container') as run_container, \
             mock.patch.object(w.os, 'open', return_value=9), \
             mock.patch.object(w.os, 'fstat', return_value=mock.Mock(st_uid=0, st_mode=stat.S_IFREG | 0o600)), \
             mock.patch.object(w.os, 'close'), \
             mock.patch.object(w.fcntl, 'flock'), \
             mock.patch.object(w.signal, 'signal'), \
             mock.patch.object(w.signal, 'alarm'), \
             mock.patch.object(system, 'argv', ['m5-build-worker']), \
             mock.patch.object(system, 'stdin', Input(b'{"version":1,"operation":"status"}\n')):
            result = w.main()
        self.assertEqual(result, 0)
        load_config.assert_called_once_with(check_capacity=False, create_root=False)
        private_directory.assert_not_called()
        cleanup.assert_not_called()
        read_request.assert_not_called()
        run_container.assert_not_called()
        self.assertEqual([kind for kind, _ in events], ['capacity', 'exit'])
        self.assertEqual(events[0][1], observed)
        self.assertEqual(events[1][1], {'code': 0})

    def test_low_capacity_build_refusal_has_numeric_capacity_and_no_work(self):
        observed = capacity(free_bytes=512 * 1024 ** 2)
        events = []
        request = b'{"version":1,"repo_id":"' + b'a' * 64 + b'","worktree_id":"' + b'b' * 64 + b'","command":["true"],"pull":[],"archive_bytes":1}\n'
        with mock.patch.object(w, 'load_config', return_value={}), \
             mock.patch.object(w, 'observe_capacity', return_value=observed), \
             mock.patch.object(w, 'emit', side_effect=lambda kind, **fields: events.append((kind, fields))), \
             mock.patch.object(w, 'read_request') as read_request, \
             mock.patch.object(w, 'execute') as execute, \
             mock.patch.object(w, 'private_directory') as private_directory, \
             mock.patch.object(w.os, 'open', return_value=9), \
             mock.patch.object(w.os, 'fstat', return_value=mock.Mock(st_uid=0, st_mode=stat.S_IFREG | 0o600)), \
             mock.patch.object(w.os, 'close'), \
             mock.patch.object(w.fcntl, 'flock'), \
             mock.patch.object(w.signal, 'signal'), \
             mock.patch.object(w.signal, 'alarm'), \
             mock.patch.object(w.sys, 'argv', ['m5-build-worker']), \
             mock.patch.object(w.sys, 'stdin', Input(request)):
            result = w.main()
        self.assertEqual(result, 125)
        self.assertEqual(events[0], ('capacity', observed))
        self.assertEqual(events[1][1]['diagnostic_code'], 'build_capacity_low')
        self.assertEqual(events[1][1]['capacity']['free_bytes'], 512 * 1024 ** 2)
        read_request.assert_not_called()
        execute.assert_not_called()
        private_directory.assert_not_called()

    def test_healthy_build_keeps_legacy_protocol_without_capacity_record(self):
        observed = capacity()
        events = []
        request = b'{"version":1,"repo_id":"' + b'a' * 64 + b'","worktree_id":"' + b'b' * 64 + b'","command":["true"],"pull":[],"archive_bytes":1}\n'
        with mock.patch.object(w, 'load_config', return_value={}), \
             mock.patch.object(w, 'observe_capacity', return_value=observed), \
             mock.patch.object(w, 'emit', side_effect=lambda kind, **fields: events.append((kind, fields))), \
             mock.patch.object(w, 'read_request', return_value=({'version': 1}, io.BytesIO(b'x'))) as read_request, \
             mock.patch.object(w, 'execute', return_value=7) as execute, \
             mock.patch.object(w.os, 'open', return_value=9), \
             mock.patch.object(w.os, 'fstat', return_value=mock.Mock(st_uid=0, st_mode=stat.S_IFREG | 0o600)), \
             mock.patch.object(w.os, 'close'), \
             mock.patch.object(w.fcntl, 'flock'), \
             mock.patch.object(w.signal, 'signal'), \
             mock.patch.object(w.signal, 'alarm'), \
             mock.patch.object(w.sys, 'argv', ['m5-build-worker']), \
             mock.patch.object(w.sys, 'stdin', Input(request)):
            result = w.main()
        self.assertEqual(result, 7)
        self.assertEqual(events, [('exit', {'code': 7})])
        read_request.assert_called_once()
        execute.assert_called_once()

    def test_load_config_status_branch_checks_root_without_creating_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'build-root'
            root.mkdir(mode=0o700)
            config_path = Path(tmp) / 'config.json'
            config_path.write_text('{"version":1,"image":"builder@sha256:' + 'a' * 64 + '","podman":"/usr/bin/podman"}')
            regular = mock.Mock(st_uid=0, st_mode=stat.S_IFREG | 0o600)
            account = mock.Mock(pw_uid=w.os.getuid(), pw_dir=str(root))
            config = mock.Mock(lstat=mock.Mock(return_value=regular), read_text=config_path.read_text)
            directory = mock.Mock(st_uid=account.pw_uid, st_mode=stat.S_IFDIR | 0o700)
            with mock.patch.object(w, 'ROOT', root), \
                 mock.patch.object(w, 'CONFIG', config), \
                 mock.patch.object(w.Path, 'lstat', return_value=directory), \
                 mock.patch.object(w.Path, 'stat', return_value=regular), \
                 mock.patch.object(w.pwd, 'getpwnam', return_value=account), \
                 mock.patch.object(w.os.path, 'ismount', return_value=True), \
                 mock.patch.object(w, 'private_directory') as private_directory, \
                 mock.patch.object(w, 'observe_capacity') as observe_capacity:
                value = w.load_config(check_capacity=False, create_root=False)
        self.assertEqual(value['version'], 1)
        private_directory.assert_not_called()
        observe_capacity.assert_not_called()


if __name__ == '__main__':
    unittest.main()
