#!/usr/bin/env python3
"""Stage #317's pinned public artifacts; never run models or change services.
Default is read-only planning. --download resumes private partial files and
certifies only exact size + SHA-256. Run under an externally bounded timeout.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import urllib.request


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def validate(manifest):
    if manifest.get('schemaVersion') != 1 or manifest.get('repository') != 'peonist-ai/halogen-qwen3.8-flash-next':
        raise ValueError('unexpected manifest or repository')
    if not re.fullmatch(r'[0-9a-f]{40}', manifest.get('revision', '')):
        raise ValueError('model revision must be immutable')
    if not re.fullmatch(r'ghcr.io/peonist-ai/halogen-flash-server@sha256:[0-9a-f]{64}', manifest.get('image', '')):
        raise ValueError('image must be pinned by digest')
    allowed = {'qwen38-flash-next-w4b.hgn', 'qwen38-flash-next-w4b.overlay.hgn',
               'tokenizer/chat_template.jinja', 'tokenizer/generation_config.json',
               'tokenizer/merges.txt', 'tokenizer/tokenizer.json',
               'tokenizer/tokenizer_config.json', 'tokenizer/vocab.json'}
    files = manifest.get('files', [])
    if len(files) != len(allowed) or {f.get('path') for f in files} != allowed:
        raise ValueError('require exactly checkpoint, quality overlay and tokenizer')
    for f in files:
        if type(f.get('bytes')) is not int or f['bytes'] <= 0:
            raise ValueError('invalid file size')
        if not re.fullmatch(r'[0-9a-f]{64}', f.get('sha256', '')):
            raise ValueError('invalid file hash')
    return files


def private_directory(path):
    for ancestor in reversed([path, *path.parents]):
        if ancestor.is_symlink():
            raise ValueError('symlink in staging directory')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    s = path.stat()
    if s.st_uid != os.getuid() or stat.S_IMODE(s.st_mode) != 0o700:
        raise ValueError('staging directory must be owned by caller and mode 0700')


def verify_file(path, spec):
    return (not path.is_symlink() and path.is_file() and
            path.stat().st_size == spec['bytes'] and digest(path) == spec['sha256'])


def stage(manifest, parent, download=False, verify=False):
    files = validate(manifest)
    receipt = {'mode': 'plan', 'revision': manifest['revision'], 'files': len(files),
               'bytes': sum(f['bytes'] for f in files), 'image': manifest['image']}
    if verify:
        root = parent.absolute() / manifest['revision']
        for ancestor in [root, *root.parents]:
            if ancestor.is_symlink():
                raise ValueError('symlink in staging directory')
        for f in files:
            target = root / f['path']
            if target.parent.is_symlink() or not verify_file(target, f):
                raise ValueError('artifact verification failed: ' + f['path'])
        receipt['mode'] = 'verified'
        return receipt
    if not download:
        return receipt
    root = parent.absolute() / manifest['revision']
    private_directory(root)
    fd = os.open(root / '.stage.lock', os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        required = sum(f['bytes'] for f in files if not (root / f['path']).is_file())
        if shutil.disk_usage(root).free < required + 16 * 1024**3:
            raise ValueError('insufficient disk space including 16 GiB reserve')
        for f in files:
            target = root / f['path']
            private_directory(target.parent)
            if target.exists() or target.is_symlink():
                if not verify_file(target, f):
                    raise ValueError('existing final artifact mismatch: ' + f['path'])
                print(json.dumps({'verified': f['path']}), flush=True)
                continue
            partial = target.with_name(target.name + '.part')
            if partial.is_symlink() or (partial.exists() and not partial.is_file()):
                raise ValueError('unsafe partial artifact')
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > f['bytes']:
                raise ValueError('oversized partial artifact')
            if offset < f['bytes']:
                url = ('https://huggingface.co/' + manifest['repository'] + '/resolve/'
                       + manifest['revision'] + '/' + f['path'])
                req = urllib.request.Request(url, headers={'Range': 'bytes=%d-' % offset} if offset else {})
                with urllib.request.urlopen(req, timeout=120) as response:
                    if offset and (response.status != 206 or not response.headers.get('Content-Range', '').startswith('bytes %d-' % offset)):
                        raise ValueError('server did not honor exact resume range')
                    outfd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(outfd, 'ab') as output:
                        count = offset
                        while True:
                            block = response.read(8 * 1024 * 1024)
                            if not block:
                                break
                            count += len(block)
                            if count > f['bytes']:
                                raise ValueError('download exceeded pinned size')
                            output.write(block)
                        output.flush()
                        os.fsync(output.fileno())
            if not verify_file(partial, f):
                raise ValueError('download hash/size mismatch: ' + f['path'])
            os.rename(partial, target)
            print(json.dumps({'verified': f['path']}), flush=True)
    receipt['mode'] = 'verified'
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--directory', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--download', action='store_true')
    mode.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(stage(json.loads(args.manifest.read_text()), args.directory, args.download, args.verify)))
