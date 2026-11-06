"""Local capability-injection ordering; never Linux/root/native execution evidence."""
import importlib.util
import io as stdio
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

MODULE=Path(__file__).resolve().parents[1]/'scripts/lib/accounted_host_io.py'
spec=importlib.util.spec_from_file_location('release_entry_helper',MODULE)
io=importlib.util.module_from_spec(spec);sys.modules[spec.name]=io;spec.loader.exec_module(io)

class EntryReleaseBinding(unittest.TestCase):
    def invoke(self,operation,gate):
        config={'io':{'issuer_release_digest':'a'*64},'accepted':{'sourceRevision':'b'*40}}
        calls={n:Mock(return_value={}) for n in ('initialize_clock','read_clock','read_context','read_challenge','write_runtime_record','initialize_journal','publish_admission','collect_cgroup_envelope_v1','collect_cgroup_kernel_charges_v1')}
        stdout=SimpleNamespace(buffer=stdio.BytesIO())
        stdin=SimpleNamespace(buffer=Mock())
        from contextlib import ExitStack
        with ExitStack() as stack:
            for name,value in (('sys.platform','linux'),('os.geteuid',lambda:0),('signal.signal',Mock()),('signal.alarm',Mock()),('load_configuration',Mock(return_value=config)),('verify_configured_release',gate),('sys.stdout',stdout),('sys.stdin',stdin)):
                if '.' in name:
                    obj,attr=name.split('.');stack.enter_context(patch.object(getattr(io,obj),attr,value))
                else:stack.enter_context(patch.object(io,name,value,create=name=='verify_configured_release'))
            for name,fun in calls.items():stack.enter_context(patch.object(io,name,fun))
            rc=io.main(['/not-read','0'*64,operation])
        return rc,stdout.buffer.getvalue(),calls,stdin

    def test_missing_or_invalid_release_blocks_every_operation_before_write_or_stdin(self):
        for operation in ('configuration','initialize-clock','clock','context','challenge','publish','self-test-receipt','ready','initialize-journal','collect_cgroup_envelope_v1','collect_cgroup_kernel_charges_v1'):
            gate=Mock(side_effect=io.Refusal('release_manifest_digest'))
            rc,raw,calls,stdin=self.invoke(operation,gate)
            with self.subTest(operation=operation):
                self.assertEqual(rc,2);self.assertIn(b'release_manifest_digest',raw)
                gate.assert_called_once()
                for fun in calls.values():fun.assert_not_called()
                stdin.buffer.read.assert_not_called()

    def test_configuration_only_continues_after_successful_release_verification(self):
        gate=Mock(return_value={'status':'artifact_bytes_verified'})
        rc,raw,calls,stdin=self.invoke('configuration',gate)
        self.assertEqual(rc,0);gate.assert_called_once();self.assertIn(b'"status":"ok"',raw)
        for fun in calls.values():fun.assert_not_called()

    def test_cgroup_read_dispatch_is_fixed_and_does_not_read_stdin(self):
        gate=Mock(return_value={'status':'artifact_bytes_verified'})
        rc,raw,calls,stdin=self.invoke('collect_cgroup_envelope_v1',gate)
        self.assertEqual(rc,0);gate.assert_called_once()
        calls['collect_cgroup_envelope_v1'].assert_called_once()
        stdin.buffer.read.assert_not_called()
        for name,fun in calls.items():
            if name != 'collect_cgroup_envelope_v1':fun.assert_not_called()

    def test_cgroup_read_rejects_an_operation_specific_path_argument(self):
        with patch.object(io.sys,'platform','linux'),patch.object(io.os,'geteuid',return_value=0),patch.object(io.signal,'alarm'),patch.object(io,'load_configuration') as loader,patch.object(io.sys,'stdout',SimpleNamespace(buffer=stdio.BytesIO())):
            self.assertEqual(io.main(['/not-read','0'*64,'collect_cgroup_envelope_v1','/tmp/override']),2)
            loader.assert_not_called()

    def test_production_helper_path_must_match_configured_digest(self):
        config={'io':{'issuer_release_digest':'a'*64}}
        with patch.object(io,'__file__','/tmp/not-root-helper.py'),patch.object(io,'verify_release_artifacts') as verify:
            with self.assertRaises(io.Refusal) as caught:io.verify_configured_release(config)
            self.assertEqual(caught.exception.code,'release_helper_path');verify.assert_not_called()

    def test_production_verifier_uses_fixed_root_and_never_brokkrs_source_revision(self):
        config={'io':{'issuer_release_digest':'a'*64},'accepted':{'sourceRevision':'b'*40}}
        path=io.RELEASE_ROOT+'/'+'a'*64+'/accounted-host-io.py'
        with patch.object(io,'__file__',path),patch.object(io,'verify_release_artifacts',return_value={'ok':True}) as verify:
            self.assertEqual(io.verify_configured_release(config),{'ok':True})
            verify.assert_called_once_with('a'*64)

if __name__=='__main__':unittest.main()
