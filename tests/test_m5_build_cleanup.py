#!/usr/bin/env python3
"""Cleanup capacity policy tests with mocked install state."""
import importlib.util
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location(
    'worker_cleanup', Path(__file__).resolve().parents[1] / 'scripts/m5-build-worker.py')
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)


def usage(total, free):
    return {'total_bytes': total, 'used_bytes': total - free, 'free_bytes': free}


class CleanupCapacity(unittest.TestCase):
    def fixture(self, days):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state = Path(tmp.name)
        tree = state / 'repos' / ('a' * 64) / 'worktrees' / ('b' * 64)
        for part in ('source', 'target'):
            (tree / part).mkdir(parents=True)
        (tree / 'source' / 'source.rs').write_text('source')
        (tree / 'target' / 'binary').write_text('large rebuildable output')
        stamp = tree / '.last-used'
        stamp.touch()
        old = time.time() - days * 86400
        os.utime(stamp, (old, old))
        return state, tree

    def run_cleanup(self, observed):
        events = []
        with mock.patch.object(w, 'load_config', return_value={}) as load_config, \
             mock.patch.object(w, 'observe_capacity', return_value=observed), \
             mock.patch.object(w, 'emit', side_effect=lambda kind, **fields: events.append((kind, fields))), \
             mock.patch.object(w, 'private_directory', return_value=Path('/private/state')) as private_directory, \
             mock.patch.object(w, 'cleanup_stale') as cleanup, \
             mock.patch.object(w.os, 'open', return_value=9), \
             mock.patch.object(w.os, 'fstat', return_value=mock.Mock(st_uid=0, st_mode=stat.S_IFREG | 0o600)), \
             mock.patch.object(w.os, 'close'), \
             mock.patch.object(w.fcntl, 'flock'), \
             mock.patch.object(w.signal, 'signal'), \
             mock.patch.object(w.signal, 'alarm'), \
             mock.patch.object(w.sys, 'argv', ['m5-build-worker', '--cleanup']):
            result = w.main()
        return result, events, load_config, private_directory, cleanup

    def test_cleanup_runs_below_one_gibibyte(self):
        result, events, load_config, private_directory, cleanup = self.run_cleanup(
            usage(64 * 1024 ** 3, 512 * 1024 ** 2))
        self.assertEqual(result, 0)
        self.assertEqual(events, [])
        load_config.assert_called_once_with(check_capacity=False)
        private_directory.assert_called_once_with(w.ROOT / 'state')
        cleanup.assert_called_once_with(Path('/private/state'))

    def test_cleanup_refuses_filesystem_over_64_gibibytes_before_deletion(self):
        result, events, load_config, private_directory, cleanup = self.run_cleanup(
            usage(65 * 1024 ** 3, 512 * 1024 ** 2))
        self.assertEqual(result, 125)
        self.assertEqual(events, [('error', {'message': 'Build filesystem must be at most 64 GiB.', 'code': 125})])
        load_config.assert_called_once_with(check_capacity=False)
        private_directory.assert_not_called()
        cleanup.assert_not_called()

    def test_idle_targets_reclaimed_after_seven_days_source_retained(self):
        state, tree = self.fixture(8)
        w.cleanup_stale(state)
        self.assertFalse((tree / 'target').exists())
        self.assertTrue((tree / 'source' / 'source.rs').exists())

    def test_recent_worktree_preserved(self):
        state, tree = self.fixture(6)
        w.cleanup_stale(state)
        self.assertTrue((tree / 'target' / 'binary').exists())

    def test_whole_idle_tree_reclaimed_after_fourteen_days(self):
        state, tree = self.fixture(15)
        w.cleanup_stale(state)
        self.assertFalse(tree.exists())

    def test_busy_worktree_never_evicted(self):
        state, tree = self.fixture(15)
        with mock.patch.object(w, 'job_locks', side_effect=w.BuildError('This worktree already has a build; retry after it finishes.')):
            w.cleanup_stale(state)
        self.assertTrue((tree / 'target' / 'binary').exists())

    def test_missing_or_future_stamp_never_evicted(self):
        state, tree = self.fixture(-1)
        w.cleanup_stale(state)
        self.assertTrue((tree / 'target').exists())
        (tree / '.last-used').unlink()
        w.cleanup_stale(state)
        self.assertTrue((tree / 'target').exists())


if __name__ == '__main__':
    unittest.main()
