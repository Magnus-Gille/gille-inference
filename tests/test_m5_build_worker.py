#!/usr/bin/env python3
"""Offline contract checks: no SSH, containers, credentials or live services."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock
import sys

SPEC = importlib.util.spec_from_file_location('worker', Path(__file__).resolve().parents[1] / 'scripts/m5-build-worker.py')
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)


def header(**changes):
    value = dict(version=1, repo_id='a'*64, worktree_id='b'*64,
                 command=['cargo', 'test', '--workspace'], pull=[], archive_bytes=10240)
    value.update(changes)
    return value


def archive(entries):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as tar:
        for name, kind, body in entries:
            info = tarfile.TarInfo(name)
            if kind == 'file':
                info.size = len(body)
                tar.addfile(info, io.BytesIO(body))
            else:
                info.type = kind
                info.linkname = 'outside'
                tar.addfile(info)
    out.seek(0)
    return out


class WorkerContract(unittest.TestCase):
    def test_header_preserves_literal_argv(self):
        h = w.validate_request(header(command=['npm', 'test', '--', '--profile', 'a;$(whoami)']))
        self.assertEqual(h['command'][-1], 'a;$(whoami)')

    def test_header_fails_closed(self):
        for change in [dict(version=2), dict(extra='ignored'), dict(repo_id='../x'),
                       dict(command=[]), dict(command=['a\0']), dict(pull=['../x']),
                       dict(toolchain='1;sh'), dict(archive_bytes=True),
                       dict(archive_bytes=w.MAX_ARCHIVE+1), dict(command='cargo test')]:
            with self.subTest(change=change), self.assertRaises(w.BuildError):
                w.validate_request(header(**change))

    def test_protected_and_unsafe_paths(self):
        for path in ['.env', 'a/.env.example', 'a/.ENV.local', 'secrets/key', '.git/config',
                     '/tmp/x', '../x', 'a/../x', 'a//x', 'a\\x', 'a\0x', 'a/./x']:
            with self.subTest(path=path), self.assertRaises(w.BuildError):
                w.safe_path(path)
        self.assertEqual(w.safe_path('src/main.rs'), 'src/main.rs')

    def test_no_links_devices_or_duplicates_enter_snapshot(self):
        for entries in [[('link', tarfile.SYMTYPE, b'')], [('link', tarfile.LNKTYPE, b'')],
                        [('device', tarfile.CHRTYPE, b'')], [('.env', 'file', b'private')],
                        [('secrets/key', 'file', b'private')], [('../escape', 'file', b'x')],
                        [('same', 'file', b'a'), ('same', 'file', b'b')]]:
            with tempfile.TemporaryDirectory() as tmp:
                with self.subTest(entries=entries), self.assertRaises(w.BuildError):
                    w.extract_snapshot(archive(entries), Path(tmp))

    def test_regular_snapshot_and_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            w.extract_snapshot(archive([('src/a.rs', 'file', b'hello')]), Path(tmp))
            self.assertEqual((Path(tmp)/'src/a.rs').read_bytes(), b'hello')
            self.assertEqual((Path(tmp)/'src/a.rs').stat().st_mode & 0o777, 0o600)

    def test_pull_refuses_symlinks_and_hardlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'ok').write_bytes(b'report')
            (root/'link').symlink_to(root/'ok')
            (root/'dir').symlink_to(root, target_is_directory=True)
            os.link(root/'ok', root/'hard')
            for path in ['link', 'dir/ok', 'hard']:
                with self.subTest(path=path), self.assertRaises(w.BuildError):
                    w.read_artifact(root, path)
            (root/'hard').unlink()
            self.assertEqual(w.read_artifact(root, 'ok'), b'report')

    def test_podman_security_flags_no_host_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = dict(image='localhost/gille-build@sha256:'+'a'*64, podman='/usr/bin/podman')
            command = w.container_command(config, Path(tmp), 'build-test', header(toolchain='1.98.0'))
            rendered = ' '.join(command)
            for flag in ['--network=none', '--pull=never', '--read-only', '--cap-drop=ALL',
                         '--security-opt=no-new-privileges', '--cpus=2', '--memory=8g',
                         '--memory-swap=8g', '--pids-limit=512', '--userns=keep-id']:
                self.assertIn(flag, command)
            self.assertNotIn('/home/magnus', rendered)
            self.assertNotIn('--privileged', command)
            self.assertNotIn('--device', command)
            self.assertIn('CARGO_NET_OFFLINE=true', command)
            self.assertIn('RUSTUP_AUTO_INSTALL=0', command)
            self.assertEqual(command[command.index('--entrypoint') + 1], 'cargo')
            self.assertEqual(command[-3:], ['+1.98.0', 'test', '--workspace'])

    def test_mac_only_rejected_at_worker_too(self):
        for command in [['xcodebuild'], ['swift', 'build'], ['cargo', 'test', '--target=aarch64-apple-darwin'],
                        ['cargo', 'tauri', 'build']]:
            with self.subTest(command=command), self.assertRaises(w.BuildError):
                w.validate_request(header(command=command))

    def test_framing_and_truncated_upload(self):
        request = header(archive_bytes=2)
        stream = io.BytesIO(json.dumps(request).encode()+b'\nab')
        got, payload = w.read_request(stream)
        self.assertEqual(got, request)
        self.assertEqual(payload.read(), b'ab')
        payload.close()
        for stream in [io.BytesIO(b'x'*8193), io.BytesIO(json.dumps(request).encode()+b'\na')]:
            with self.assertRaises(w.BuildError):
                w.read_request(stream)

    def test_lock_denies_same_worktree_and_fourth_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            with w.job_locks(Path(tmp), 'b'*64):
                with self.assertRaises(w.BuildError):
                    with w.job_locks(Path(tmp), 'b'*64):
                        pass
                with w.job_locks(Path(tmp), 'c'*64), w.job_locks(Path(tmp), 'd'*64):
                    with self.assertRaises(w.BuildError):
                        with w.job_locks(Path(tmp), 'e'*64):
                            pass

    def test_runtime_streams_both_channels_and_preserves_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = Path(tmp)/'podman'
            runtime.write_text('#!' + sys.executable + '\nimport json,sys\n'
                'if sys.argv[1]=="info": print(json.dumps({"host":{"security":{"rootless":True},"cgroupVersion":"v2","cgroupManager":"systemd"}}))\n'
                'elif sys.argv[1]=="run":\n print("out",flush=True)\n print("err",file=sys.stderr,flush=True)\n sys.exit(7)\n')
            runtime.chmod(0o700)
            events = []
            with mock.patch.object(w, 'emit', side_effect=lambda kind, **kw: events.append((kind, kw))):
                code = w.run_container(dict(podman=str(runtime), image='x@sha256:'+'a'*64), Path(tmp), header())
            self.assertEqual(code, 7)
            self.assertEqual({kind for kind, _ in events}, {'stdout', 'stderr'})

    def test_execution_sync_removes_deleted_files_and_collects_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            request = header(pull=['report.txt'])
            repo = root/'state'/'repos'/request['repo_id']
            workspace = repo/'worktrees'/request['worktree_id']/'source'
            workspace.mkdir(parents=True)
            (workspace/'deleted.rs').write_text('old')
            def build(_config, _repo, _request):
                self.assertFalse((workspace/'deleted.rs').exists())
                self.assertEqual((workspace/'new.rs').read_text(), 'new')
                (workspace/'report.txt').write_text('report')
                return 3
            events = []
            with mock.patch.object(w, 'ROOT', root), mock.patch.object(w, 'run_container', side_effect=build), \
                 mock.patch.object(w, 'emit', side_effect=lambda kind, **kw: events.append((kind, kw))):
                # Existing server-owned ancestor dirs are always private.
                for parent in [root/'state', root/'state'/'repos', repo, repo/'worktrees', workspace.parent]:
                    parent.chmod(0o700)
                code = w.execute(request, archive([('new.rs', 'file', b'new')]), {})
            self.assertEqual(code, 3)
            self.assertEqual(events[0][0], 'artifact')
            self.assertEqual(events[0][1]['path'], 'report.txt')

    def test_runtime_preflight_requires_rootless_v2(self):
        good = dict(host=dict(security=dict(rootless=True), cgroupVersion='v2', cgroupManager='systemd'))
        w.validate_runtime_info(good)
        for bad in [{}, dict(host=dict(security=dict(rootless=False), cgroupVersion='v2', cgroupManager='systemd')),
                    dict(host=dict(security=dict(rootless=True), cgroupVersion='v1', cgroupManager='systemd'))]:
            with self.assertRaises(w.BuildError):
                w.validate_runtime_info(bad)


if __name__ == '__main__':
    unittest.main()
