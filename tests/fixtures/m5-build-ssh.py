"""An offline fake SSH endpoint using the REAL archive/framing/pull worker code."""
import importlib.util
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
w.ROOT = Path(sys.argv[2])


def stub_container(_config, repo, request):
    workspace = repo/'worktrees'/request['worktree_id']/'source'
    assert (workspace/'tracked.txt').read_text() == 'tracked'
    assert not (workspace/'deleted.txt').exists()
    assert request['command'] == ['npm', 'test', '--', '--profile', 'literal;$(no-shell)']
    w.emit('stdout', data=w.base64.b64encode(b'S'*(48*1024)).decode())
    w.emit('stderr', data=w.base64.b64encode(b'E'*(48*1024)).decode())
    (workspace/'reports').mkdir(exist_ok=True)
    (workspace/'reports'/'test.txt').write_bytes(b'report from remote')
    (workspace/'reports'/'second.txt').write_bytes(b'second remote report')
    return 7


w.run_container = stub_container
try:
    request, payload = w.read_request(sys.stdin.buffer)
    with payload:
        code = w.execute(request, payload, {})
    w.emit('exit', code=code)
    sys.exit(code)
except w.BuildError as exc:
    w.emit('error', message=str(exc), code=125)
    sys.exit(125)
