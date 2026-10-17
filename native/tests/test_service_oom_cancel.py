"""Exercise the real parent TERM handler without systemd, root or memory pressure."""
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


class CancellationTests(unittest.TestCase):
    def test_parent_term_unwinds_cleanup_before_exit(self):
        fixture = Path(__file__).with_name('test_service_oom_continue.py')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            # Replace only privileged work. The fixture's real main and signal handler run.
            source = '''import importlib.util,pathlib,sys,time
spec=importlib.util.spec_from_file_location('oom_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
root=pathlib.Path(sys.argv[2])
def harmless_fixture():
 try:
  (root/'ready').touch()
  while True:time.sleep(.05)
 finally:(root/'cleanup').touch()
module.fixture=harmless_fixture
sys.argv=['fixture']
module.main()
'''
            child = subprocess.Popen([sys.executable, '-c', source, str(fixture), str(root)],
                                     env={'PATH': '/usr/bin:/bin', 'LANG': 'C'},
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 5
                while not (root / 'ready').exists() and time.monotonic() < deadline:
                    if child.poll() is not None:
                        self.fail('harmless fixture failed to start')
                    time.sleep(0.02)
                self.assertTrue((root / 'ready').exists())
                child.send_signal(signal.SIGTERM)
                self.assertNotEqual(child.wait(timeout=5), 0)
                self.assertTrue((root / 'cleanup').exists())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
