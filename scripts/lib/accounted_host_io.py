"""Accounted issuer I/O candidate; no installation, initialization or CLI on import.

All paths/owner identities are trusted configuration, never payload request data.
The owner must additionally attest ACL/MAC, local-filesystem durability and the
absence of hostile same-UID writers. These checks do not establish those facts.

Publication acknowledges only a completed durable rename before its deadline.
An interrupted/late rename is UNKNOWN and retains its files. A userspace check
cannot impose a kernel syscall deadline: the strict v2 consumer must ALSO reject
an expired publication deadline. This module alone is not execution authority.
"""
from __future__ import annotations

import ctypes
import datetime
import hashlib
import json
import os
import re
import resource
import secrets
import select
import signal
import stat
import sys
import time
from dataclasses import dataclass
from typing import Callable


class Refusal(Exception):
    def __init__(self, code: str, *, outcome: str = 'refused', phase: str = 'validation'):
        super().__init__(code)
        self.code, self.outcome, self.phase = code, outcome, phase


def require(condition, code):
    if not condition:
        raise Refusal(code)


def integer(value):
    require(type(value) is int and 0 <= value < 2**63, 'integer_bound')
    return value


def boottime_ns():
    require(sys.platform == 'linux' and hasattr(time, 'CLOCK_BOOTTIME'), 'linux_clock_unavailable')
    return integer(time.clock_gettime_ns(time.CLOCK_BOOTTIME))


@dataclass
class ClockBridge:
    """A sampled, bounded bridge, not an unrelated wall/monotonic clock pair."""
    offset_ns: int
    uncertainty_ns: int
    previous_ns: int | None = None

    def __post_init__(self):
        require(type(self.offset_ns) is int and abs(self.offset_ns) < 2**63, 'clock_offset')
        require(type(self.uncertainty_ns) is int and 0 <= self.uncertainty_ns <= 1000, 'clock_uncertainty')

    @classmethod
    def sample(cls, *, boottime=boottime_ns, realtime=time.time_ns):
        # Bounded local clock reads, never a process/host-operation retry.
        for _ in range(8):
            before = integer(boottime()); wall = integer(realtime()); after = integer(boottime())
            require(after >= before, 'clock_regression')
            span = after-before
            if span <= 2000:
                return cls(wall-(before+span//2), (span+1)//2)
        raise Refusal('clock_sample_uncertain')

    def read(self, *, boottime=boottime_ns, realtime=time.time_ns):
        before = integer(boottime()); wall = integer(realtime()); after = integer(boottime())
        require(after >= before and after-before <= 2000, 'clock_sample_uncertain')
        require(self.previous_ns is None or before >= self.previous_ns, 'clock_regression')
        # Both offset intervals must be within1us even in the worst case. Initial
        # sampling uncertainty consumes this budget; it must never enlarge it.
        require(wall-after >= self.offset_ns+self.uncertainty_ns-1000
                and wall-before <= self.offset_ns-self.uncertainty_ns+1000, 'clock_bridge_drift')
        self.previous_ns = after
        utc_ns = integer(after+self.offset_ns)
        seconds, fractional = divmod(utc_ns, 1_000_000_000)
        date = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
        return {'boottimeNs': str(after),
                'utc': date.strftime('%Y-%m-%dT%H:%M:%S') + f'.{fractional//1000:06d}Z'}


def _identity(s):
    return s.st_dev, s.st_ino, s.st_uid, s.st_mode


def _full_identity(s):
    return _identity(s) + (s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)


def rename_noreplace(directory_fd, source, target):
    """Linux libc renameat2, RENAME_NOREPLACE=1. No rename/link fallback.

    API/semantics: https://man7.org/linux/man-pages/man2/rename.2.html
    Filesystem support must be proved on the actual host, not inferred here.
    """
    require(sys.platform == 'linux', 'linux_noreplace_unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    function = getattr(libc, 'renameat2', None)
    require(function is not None, 'linux_noreplace_unavailable')
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(directory_fd, os.fsencode(source), directory_fd, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        raise OSError(error, 'rename_noreplace_failed')


class PinnedDirectory:
    """Dirfd traversal of an existing private directory, with path/FD rechecks.

    Never creates/adopts/repairs a directory. The CLI integration must always use
    root. Unprivileged tests explicitly select their own effective UID; a root
    caller cannot select an actor-owned path by changing a configuration option.
    """
    def __init__(self, path: str, *, owner_uid: int = 0, private_target: bool = True):
        require(type(path) is str and len(path) <= 512 and path.startswith('/')
                and path != '/' and not path.endswith('/') and os.path.normpath(path) == path
                and re.fullmatch(r'/[A-Za-z0-9_./-]+', path) is not None, 'directory_path')
        require(type(owner_uid) is int and 0 <= owner_uid < 2**31
                and os.geteuid() == owner_uid, 'owner_identity')
        require(type(private_target) is bool, 'directory_configuration')
        self.path, self.owner_uid, self.pins, self.closed = path, owner_uid, [], False
        self.private_target = private_target
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK
        try:
            fd = os.open('/', flags)
            self.pins.append((fd, None, None, os.fstat(fd)))
            self._directory(os.fstat(fd), False)
            parts = path[1:].split('/')
            for i, part in enumerate(parts):
                parent = fd
                fd = os.open(part, flags, dir_fd=parent)
                sample = os.fstat(fd)
                self.pins.append((fd, parent, part, sample))
                self._directory(sample, i == len(parts)-1)
                require(_identity(sample) == _identity(os.stat(part, dir_fd=parent, follow_symlinks=False)),
                        'directory_changed')
            self.fd = fd
            self.check()
        except Exception as error:
            self.close()
            if isinstance(error, Refusal):
                raise
            raise Refusal('directory_open_refused') from error

    def _directory(self, sample, target):
        require(stat.S_ISDIR(sample.st_mode) and sample.st_uid in (0, self.owner_uid), 'directory_owner_type')
        sticky_root = not target and sample.st_uid == 0 and bool(sample.st_mode & stat.S_ISVTX)
        require(not sample.st_mode & 0o022 or sticky_root, 'directory_writable')
        if target:
            require(sample.st_uid == self.owner_uid
                    and (not self.private_target or stat.S_IMODE(sample.st_mode) == 0o700), 'directory_private')

    def check(self):
        require(not self.closed, 'directory_closed')
        for i, (fd, parent, name, original) in enumerate(self.pins):
            current = os.fstat(fd)
            self._directory(current, i == len(self.pins)-1)
            require(_identity(current) == _identity(original), 'directory_changed')
            if parent is not None:
                require(_identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == _identity(current),
                        'directory_changed')

    @staticmethod
    def _name(name):
        require(type(name) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name) is not None,
                'file_name')

    def _file(self, sample, maximum):
        require(stat.S_ISREG(sample.st_mode) and sample.st_uid == self.owner_uid
                and stat.S_IMODE(sample.st_mode) == 0o600 and sample.st_nlink == 1
                and sample.st_dev == self.pins[-1][3].st_dev and 0 <= sample.st_size <= maximum,
                'file_identity_or_bound')

    def read_file(self, name, *, maximum, expected_sha256=None):
        self._name(name)
        require(type(maximum) is int and 0 < maximum <= 524800, 'read_bound')
        if expected_sha256 is not None:
            require(type(expected_sha256) is str and re.fullmatch('[0-9a-f]{64}', expected_sha256) is not None,
                    'digest_format')
        fd = None
        try:
            self.check()
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
            before = os.fstat(fd); self._file(before, maximum)
            chunks, size = [], 0
            while True:
                chunk = os.read(fd, min(65536, maximum+1-size))
                if not chunk:
                    break
                size += len(chunk); require(size <= maximum, 'read_bound'); chunks.append(chunk)
            after = os.fstat(fd); self._file(after, maximum)
            require(_full_identity(before) == _full_identity(after)
                    == _full_identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False))
                    and size == after.st_size, 'file_changed')
            self.check(); value = b''.join(chunks)
            require(expected_sha256 is None or hashlib.sha256(value).hexdigest() == expected_sha256,
                    'file_digest')
            return value
        except OSError as error:
            raise Refusal('file_read_refused') from error
        finally:
            if fd is not None:
                os.close(fd)

    def publish_once(self, name, value, deadline_ns, *, clock=boottime_ns, rename_noreplace=rename_noreplace):
        require(self.private_target, 'directory_readonly')
        self._name(name)
        require(type(value) is bytes and 0 < len(value) <= 65536, 'publication_bound')
        integer(deadline_ns)
        outcome, phase, fd = 'refused', 'before_write', None
        try:
            self.check(); require(integer(clock()) < deadline_ns, 'publication_expired')
            temporary = '.accounted-' + secrets.token_hex(32) + '.tmp'
            phase = 'temporary_create'
            # From first attempted create, retain all files on error. No retry/unlink.
            outcome = 'unknown'
            fd = os.open(temporary, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o600, dir_fd=self.fd)
            self._file(os.fstat(fd), 65536)
            offset = 0
            while offset < len(value):
                count = os.write(fd, value[offset:]); require(count > 0, 'publication_write_incomplete'); offset += count
            phase = 'temporary_sync'; os.fsync(fd)
            written = os.fstat(fd); self._file(written, 65536)
            require(written.st_size == len(value)
                    and _full_identity(written) == _full_identity(os.stat(temporary, dir_fd=self.fd, follow_symlinks=False)),
                    'temporary_changed')
            self.check(); phase = 'before_rename'
            require(integer(clock()) < deadline_ns, 'publication_expired')
            phase = 'rename_noreplace'; rename_noreplace(self.fd, temporary, name)
            # A late/failed acknowledgement is UNKNOWN even if the destination exists.
            # Only v2 consumer deadline checks prevent acting on late visible bytes.
            phase = 'after_rename'; require(integer(clock()) < deadline_ns, 'publication_expired')
            self.check(); phase = 'destination_verify'
            require(_identity(os.stat(name, dir_fd=self.fd, follow_symlinks=False)) == _identity(written),
                    'destination_changed')
            require(self.read_file(name, maximum=65536) == value, 'destination_changed')
            phase = 'directory_sync'; os.fsync(self.fd); self.check()
            require(integer(clock()) < deadline_ns, 'publication_expired')
            return {'status': 'published', 'sha256': hashlib.sha256(value).hexdigest()}
        except Exception as error:
            code = error.code if isinstance(error, Refusal) else 'publication_io_failed'
            raise Refusal(code, outcome=outcome, phase=phase) from error
        finally:
            if fd is not None:
                os.close(fd)

    def close(self):
        if self.closed:
            return
        self.closed = True
        first = None
        for fd, _, _, _ in reversed(self.pins):
            try:
                os.close(fd)
            except OSError as error:
                if first is None:
                    first = error
        self.pins.clear()
        if first is not None:
            raise Refusal('directory_close_failed') from first


DESCRIPTOR = '7d97cb1f350f1aaa25b9abfef518f5b8f5b42af77ace1dfa49216692e42f5bde'
CONFIGURATION_ROOT = '/etc/gille-inference-accounted/attempts'
ATTEMPT_ROOT = '/var/lib/brokkr-accounted/attempts'
ADMISSION_ROOT = '/run/brokkr-accounted/admissions'
BROKKR_CONFIGURATION_ROOT = '/etc/brokkr-accounted'
JOURNAL_ROOT = '/var/lib/brokkr-accounted/issuer'


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')


def decode_json(raw):
    require(type(raw) is bytes and 0 < len(raw) <= 524288
            and all(c in (9, 10, 13) or 32 <= c <= 126 for c in raw), 'json_bound_or_ascii')

    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, 'json_duplicate')
            out[key] = value
        return out

    def number(text):
        require(len(text) <= 20, 'json_integer_bound')
        value = int(text)
        require(-(2**63) <= value < 2**63, 'json_integer_bound')
        return value

    def unsupported(_):
        raise Refusal('json_number_unsupported')

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_int=number,
                           parse_float=unsupported, parse_constant=unsupported)
        require(canonical(value) == raw, 'json_noncanonical')
        return value
    except (ValueError, TypeError, RecursionError, UnicodeError) as error:
        raise Refusal('json_invalid') from error


def decode_brokkr_journal(raw):
    """Brokkr Journal.write uses canonical(value)+exactly one LF.

    Config/admission bytes retain their separate strict no-LF encoding. Native
    challenge identity/nonce hashes bind canonical JSON VALUE bytes, not this LF.
    """
    require(type(raw) is bytes and raw.endswith(b'\n') and not raw.endswith(b'\n\n'), 'brokkr_journal_newline')
    return decode_json(raw[:-1])


def _fields(value, fields, code):
    require(type(value) is dict and set(value) == set(fields), code)


def _hex(value, length=64):
    require(type(value) is str and re.fullmatch('[0-9a-f]{'+str(length)+'}', value) is not None, 'digest_or_identifier')
    return value


def _uuid(value):
    require(type(value) is str and re.fullmatch(
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value) is not None, 'uuid')
    return value


RELEASE_ROOT = '/opt/gille-inference-accounted/releases'
RELEASE_MANIFEST = 'issuer-release.json'
RELEASE_FILES = ('accounted-host-issuer.mjs', 'accounted-host-io.py')
RELEASE_DOMAIN = b'gille-inference/accounted/issuer-code-release/v1\n'
RELEASE_FILE_MAXIMUM = 524288


def parse_release_manifest(raw):
    """Code-only envelope. Its revision is declared, not compiler/Git proof."""
    require(type(raw) is bytes and 0 < len(raw) <= 4096, 'release_manifest_bound')
    value = decode_json(raw)
    _fields(value, ('version', 'kind', 'repository', 'source_revision', 'files'), 'release_manifest_fields')
    require(type(value['version']) is int and value['version'] == 1
            and value['kind'] == 'accounted-issuer-code-release'
            and value['repository'] == 'Magnus-Gille/gille-inference', 'release_manifest_identity')
    _hex(value['source_revision'], 40)
    _fields(value['files'], RELEASE_FILES, 'release_manifest_members')
    for name in RELEASE_FILES:
        entry = value['files'][name]
        _fields(entry, ('sha256', 'size'), 'release_file_fields')
        _hex(entry['sha256'])
        require(type(entry['size']) is int and 0 < entry['size'] <= RELEASE_FILE_MAXIMUM,
                'release_file_bound')
    return value


def build_release_manifest(source_revision, entry_bytes, helper_bytes):
    """Pure envelope builder, not a source archive, accepted release or permit."""
    _hex(source_revision, 40)
    values = (entry_bytes, helper_bytes)
    for raw in values:
        require(type(raw) is bytes and 0 < len(raw) <= RELEASE_FILE_MAXIMUM, 'release_file_bound')
    files = {name: {'sha256': hashlib.sha256(raw).hexdigest(), 'size': len(raw)}
             for name, raw in zip(RELEASE_FILES, values)}
    raw = canonical({'version': 1, 'kind': 'accounted-issuer-code-release',
                     'repository': 'Magnus-Gille/gille-inference',
                     'source_revision': source_revision, 'files': files})
    parse_release_manifest(raw)
    return raw


def release_manifest_digest(raw):
    parse_release_manifest(raw)
    return hashlib.sha256(RELEASE_DOMAIN + raw).hexdigest()


class ReleaseDirectory(PinnedDirectory):
    """Full read-only release verification, using the existing dirfd trust pins.

    No install/chmod/adoption. Root or the explicitly chosen actual test UID owns
    the 0555 target and 0444 files. ACL/MAC/sameUID/localFS assumptions remain.
    """
    def __init__(self, path, *, owner_uid=0):
        super().__init__(path, owner_uid=owner_uid, private_target=False)

    def _directory(self, sample, target):
        super()._directory(sample, target)
        if target:
            require(stat.S_IMODE(sample.st_mode) == 0o555, 'release_directory_mode')

    def _file(self, sample, maximum):
        require(stat.S_ISREG(sample.st_mode) and sample.st_uid == self.owner_uid
                and stat.S_IMODE(sample.st_mode) == 0o444 and sample.st_nlink == 1
                and sample.st_dev == self.pins[-1][3].st_dev and 0 < sample.st_size <= maximum,
                'release_file_identity_or_bound')

    def exact_members(self):
        self.check()
        found = set()
        with os.scandir(self.fd) as entries:
            for entry in entries:
                require(len(found) < 3, 'release_extra_member')
                found.add(entry.name)
        require(found == set(RELEASE_FILES) | {RELEASE_MANIFEST}, 'release_members')
        self.check()


def verify_release_artifacts(expected_digest, *, expected_source_revision=None,
                             release_root=RELEASE_ROOT, owner_uid=0):
    """Verify physical bytes against an externally accepted digest.

    Digest acceptance/source compilation/owner authority are NOT created here.
    Optional expected revision is a separate external binding, never Brokkr's
    accepted.sourceRevision. Roots/UID overrides are code capabilities only.
    """
    _hex(expected_digest)
    if expected_source_revision is not None:
        _hex(expected_source_revision, 40)
    require(type(release_root) is str and release_root.startswith('/')
            and release_root != '/' and not release_root.endswith('/')
            and os.path.normpath(release_root) == release_root, 'release_root')
    directory = ReleaseDirectory(release_root + '/' + expected_digest, owner_uid=owner_uid)
    try:
        before = os.fstat(directory.fd)
        directory.exact_members()
        raw = directory.read_file(RELEASE_MANIFEST, maximum=4096)
        manifest = parse_release_manifest(raw)
        require(release_manifest_digest(raw) == expected_digest, 'release_manifest_digest')
        require(expected_source_revision is None or manifest['source_revision'] == expected_source_revision,
                'release_source_binding')
        for name in RELEASE_FILES:
            entry = manifest['files'][name]
            content = directory.read_file(name, maximum=RELEASE_FILE_MAXIMUM,
                                          expected_sha256=entry['sha256'])
            require(len(content) == entry['size'], 'release_file_size')
        directory.exact_members()
        require(_full_identity(before) == _full_identity(os.fstat(directory.fd)), 'release_directory_changed')
        return {'status': 'artifact_bytes_verified', 'manifestDigest': expected_digest,
                'declaredSourceRevision': manifest['source_revision'],
                'compilationProvenanceVerified': False, 'executionAuthorized': False}
    finally:
        directory.close()


def verify_configured_release(config):
    """Production path pin; no CLI/configurable root or owner override."""
    digest = _hex(config['io']['issuer_release_digest'])
    expected_path = RELEASE_ROOT + '/' + digest + '/accounted-host-io.py'
    require(type(__file__) is str and __file__ == expected_path, 'release_helper_path')
    return verify_release_artifacts(digest)


def verify_recovery_artifacts(candidate_binding, recovery_binding, *, release_root=RELEASE_ROOT, owner_uid=0):
    """Read both immutable artifacts only. Never choose/activate/remove a release."""
    for binding in (candidate_binding, recovery_binding):
        _fields(binding, ('manifestDigest', 'sourceRevision'), 'release_binding_fields')
        _hex(binding['manifestDigest'])
        _hex(binding['sourceRevision'], 40)
    require(candidate_binding['manifestDigest'] != recovery_binding['manifestDigest'], 'recovery_same_artifact')
    receipts = [verify_release_artifacts(binding['manifestDigest'],
                expected_source_revision=binding['sourceRevision'], release_root=release_root, owner_uid=owner_uid)
                for binding in (candidate_binding, recovery_binding)]
    return {'status': 'recovery_artifact_bytes_verified', 'candidate': receipts[0], 'recovery': receipts[1],
            'rollbackPerformed': False, 'activationAuthorized': False,
            'configurationRecoveryVerified': False, 'nativeRestorationVerified': False}


def load_configuration(path, expected_sha256, *, owner_uid=0, configuration_root=CONFIGURATION_ROOT):
    """Hash-bound owner configuration. No providers/functions or arbitrary IO paths."""
    _hex(expected_sha256)
    require(type(path) is str and path.startswith(configuration_root+'/'), 'configuration_path')
    name = path[len(configuration_root)+1:]
    require(re.fullmatch('[0-9a-f]{32}\\.json', name) is not None, 'configuration_path')
    directory = PinnedDirectory(configuration_root, owner_uid=owner_uid)
    try:
        raw = directory.read_file(name, maximum=65536, expected_sha256=expected_sha256)
    finally:
        directory.close()
    config = decode_json(raw)
    _fields(config, ('version', 'io', 'accepted', 'policy', 'registry'), 'configuration_fields')
    require(type(config['version']) is int and config['version'] == 1, 'configuration_version')
    io = config['io']
    _fields(io, ('attempt_id', 'issuer_release_digest', 'brokkr_config_digest', 'descriptor_digest',
                 'protected_manifest_digest', 'host_boot_id'), 'configuration_io_fields')
    require(_hex(io['attempt_id'], 32) == name[:-5], 'configuration_attempt')
    for key in ('issuer_release_digest', 'brokkr_config_digest', 'protected_manifest_digest'):
        _hex(io[key])
    require(io['descriptor_digest'] == DESCRIPTOR, 'configuration_descriptor')
    require(type(io['host_boot_id']) is str and re.fullmatch(
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', io['host_boot_id']) is not None,
        'configuration_boot')
    require(all(type(config[key]) is dict for key in ('accepted', 'policy', 'registry')), 'configuration_records')
    return config


def read_brokkr_configuration(config, *, configuration_root=BROKKR_CONFIGURATION_ROOT, owner_uid=0):
    # Brokkr's installed config parent is root0755, with a private root0600 file.
    # This read-only handle cannot be used by any publisher/bootstrap method.
    directory = PinnedDirectory(configuration_root, owner_uid=owner_uid, private_target=False)
    try:
        raw = directory.read_file(config['io']['attempt_id']+'.json', maximum=65536)
    finally:
        directory.close()
    body = decode_brokkr_journal(raw)
    require(type(body) is dict and type(body.get('version')) is int and body['version'] == 2
            and body.get('attempt_id') == config['io']['attempt_id']
            and hashlib.sha256(canonical(body)).hexdigest() == config['io']['brokkr_config_digest'], 'brokkr_configuration_binding')
    mode = config['policy'].get('mode')
    require(mode in ('self-test', 'diagnostic') and body.get('execution_kind') == ('fixture' if mode == 'self-test' else 'diagnostic'),
            'brokkr_execution_kind')
    if mode == 'diagnostic':
        journal = config['registry'].get('journal')
        require(type(journal) is dict and type(body.get('issuer')) is dict
                and body['issuer'].get('mandate_id') == _uuid(journal.get('mandate_id')), 'journal_mandate_binding')
    return body


def read_kernel_file(path, maximum):
    """Only internal fixed /proc or cgroup metadata calls use this function.

    No requester-selected path, argv, environment or process content is supported.
    /proc/<ownPID> is used instead of traversing the /proc/self magic symlink.
    """
    require(type(maximum) is int and 0 < maximum <= 65536, 'kernel_read_bound')
    require(path == '/proc/sys/kernel/random/boot_id'
            or path == f'/proc/{os.getpid()}/cgroup'
            or re.fullmatch(r'/sys/fs/cgroup/system\.slice/brokkr-accounted-eval-[0-9a-f]{32}\.service/'
                            r'(memory\.max|memory\.swap\.max|memory\.oom\.group|cpu\.max|pids\.max|cgroup\.type|cgroup\.subtree_control)', path),
            'kernel_path')
    fd = None
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and not before.st_mode & 0o022,
                'kernel_file_identity')
        raw = os.read(fd, maximum+1)
        require(0 < len(raw) <= maximum and os.read(fd, 1) == b'', 'kernel_read_bound')
        require(_identity(os.fstat(fd)) == _identity(before)
                == _identity(os.stat(path, follow_symlinks=False)), 'kernel_file_changed')
        return raw.decode('ascii').strip()
    except (OSError, UnicodeError) as error:
        raise Refusal('kernel_read_refused') from error
    finally:
        if fd is not None:
            os.close(fd)


def validate_context(config, context):
    """Compare a root-PID1 bootstrap witness with THIS process's kernel facts.

    This authenticates neither the complete protected inventory nor allocation,
    controls or six shared components. Those remain independent verifier inputs.
    """
    _fields(context, ('version', 'attempt_id', 'unit', 'source_revision', 'release_id', 'config_digest',
                      'descriptor_digest', 'identity', 'limits'), 'context_fields')
    require(type(context['version']) is int and context['version'] == 1, 'context_version')
    io, accepted = config['io'], config['accepted']
    _hex(context['source_revision'], 40); _hex(context['release_id'])
    request = accepted.get('request')
    require(type(request) is dict and type(request.get('limits')) is dict, 'context_request_limits')
    request_limits = request['limits']
    address_space = integer(request_limits.get('addressSpaceLimitBytes'))
    require(0 < address_space <= 2**53-1, 'context_address_space')
    attempt = io['attempt_id']; unit = 'brokkr-accounted-eval-'+attempt+'.service'
    require(context['attempt_id'] == attempt and context['unit'] == unit
            and context['config_digest'] == io['brokkr_config_digest']
            and context['descriptor_digest'] == DESCRIPTOR
            and context['source_revision'] == accepted.get('sourceRevision')
            and context['release_id'] == accepted.get('releaseId'), 'context_binding')
    identity = context['identity']
    _fields(identity, ('boot_id', 'invocation_id', 'cgroup_device', 'cgroup_inode', 'cgroup_path',
                       'namespace_inodes'), 'context_identity_fields')
    _hex(identity['invocation_id'], 32)
    require(identity['boot_id'] == io['host_boot_id'] == read_kernel_file('/proc/sys/kernel/random/boot_id', 64),
            'context_boot')
    group = '/system.slice/'+unit
    require(identity['cgroup_path'] == group
            and read_kernel_file(f'/proc/{os.getpid()}/cgroup', 4096) == '0::'+group, 'context_cgroup')
    group_stat = os.stat('/sys/fs/cgroup'+group, follow_symlinks=False)
    require(stat.S_ISDIR(group_stat.st_mode) and group_stat.st_uid == 0
            and group_stat.st_dev == integer(identity['cgroup_device'])
            and group_stat.st_ino == integer(identity['cgroup_inode']), 'context_cgroup_identity')
    _fields(identity['namespace_inodes'], ('mnt', 'net', 'ipc', 'pid'), 'context_namespace_fields')
    for name, inode in identity['namespace_inodes'].items():
        require(os.stat(f'/proc/{os.getpid()}/ns/{name}').st_ino == integer(inode), 'context_namespace')
    limits = context['limits']
    _fields(limits, ('memory_bytes', 'cpu_quota_us', 'cpu_period_us', 'pids_max'), 'context_limit_fields')
    for value in limits.values():
        integer(value)
    require(16777216 <= limits['memory_bytes'] <= 536870912
            and 1 <= limits['cpu_quota_us'] <= 10000 and limits['cpu_period_us'] == 100000
            and 4 <= limits['pids_max'] <= 64, 'context_limit_ceiling')
    if config.get('policy', {}).get('mode') == 'diagnostic':
        for native, policy in [('memory_bytes', 'chargedMemoryMaxBytes'), ('cpu_quota_us', 'cpuQuotaMicros'),
                               ('cpu_period_us', 'cpuPeriodMicros'), ('pids_max', 'tasksMax')]:
            require(type(request_limits.get(policy)) is int and request_limits[policy] == limits[native],
                    'context_request_limits')
    expected = {'memory.max': str(limits['memory_bytes']), 'memory.swap.max': '0',
                'memory.oom.group': '1', 'pids.max': str(limits['pids_max']),
                'cpu.max': f"{limits['cpu_quota_us']} {limits['cpu_period_us']}",
                'cgroup.type': 'domain', 'cgroup.subtree_control': ''}
    for field, value in expected.items():
        require(read_kernel_file('/sys/fs/cgroup'+group+'/'+field, 256) == value, 'context_effective_limit')
    soft, hard = resource.getrlimit(resource.RLIMIT_AS)
    require(address_space > 0 and soft == hard == address_space, 'context_address_space')
    return context


def read_context(config, *, state_root=ATTEMPT_ROOT, owner_uid=0):
    directory = PinnedDirectory(state_root+'/'+config['io']['attempt_id'], owner_uid=owner_uid)
    try:
        context = decode_brokkr_journal(directory.read_file('issuer-context.json', maximum=16384))
    finally:
        directory.close()
    validated = validate_context(config, context)
    brokkr = read_brokkr_configuration(config, owner_uid=owner_uid)
    require(type(brokkr.get('address_space_limit_bytes')) is int
            and brokkr['address_space_limit_bytes'] == config['accepted']['request']['limits']['addressSpaceLimitBytes'],
            'brokkr_address_space_binding')
    return validated


def validate_journal_bootstrap(config):
    """Validate the exact pure-planner bytes, never adopt existing replay state."""
    require(config['policy'].get('mode') == 'diagnostic', 'journal_bootstrap_mode')
    journal = config['registry'].get('journal')
    _fields(journal, ('mandate_id', 'observer_instance_sha256', 'origin_version', 'bytes_sha256', 'bytes'), 'journal_bootstrap_fields')
    mandate = _uuid(journal['mandate_id'])
    for key in ('observer_instance_sha256', 'origin_version', 'bytes_sha256'):
        _hex(journal[key])
    require(type(journal['bytes']) is str and journal['bytes'].isascii(), 'journal_bootstrap_bytes')
    raw = journal['bytes'].encode('ascii'); require(len(raw) <= 65536, 'journal_bootstrap_bound')
    require(hashlib.sha256(raw).hexdigest() == journal['bytes_sha256']
            and hashlib.sha256(b'gille-inference/accounted/file-journal/v1\n'+raw).hexdigest() == journal['origin_version'],
            'journal_bootstrap_digest')
    record = decode_json(raw)
    boot = _uuid(config['io']['host_boot_id'])
    state = {'schemaVersion': 1, 'hostBootIdSha256': hashlib.sha256(boot.encode('ascii')).hexdigest(),
             'observerInstanceSha256': journal['observer_instance_sha256'], 'lastSequence': 0,
             'seenEvidenceDigests': [], 'seenAttempts': [], 'claims': []}
    expected = {'schemaVersion': 1, 'revision': '0', 'originVersion': None, 'parentVersion': None,
                'state': state, 'stateDigest': hashlib.sha256(canonical(state)).hexdigest()}
    require(canonical(record) == canonical(expected), 'journal_bootstrap_nonempty_or_unbound')
    return JOURNAL_ROOT+'/'+mandate, raw, journal['origin_version']


def initialize_journal(config):
    path, raw, origin = validate_journal_bootstrap(config)
    require(read_kernel_file('/proc/sys/kernel/random/boot_id', 64) == config['io']['host_boot_id'], 'journal_bootstrap_boot')
    read_brokkr_configuration(config)
    parent = PinnedDirectory(JOURNAL_ROOT, private_target=False)
    try:
        parent.check()
        require(os.listdir(parent.fd) == [config['registry']['journal']['mandate_id']], 'journal_other_epoch_requires_reconciliation')
        parent.check()
    finally:
        parent.close()
    directory = PinnedDirectory(path)
    try:
        try:
            directory.check()
            require(os.listdir(directory.fd) == [], 'journal_bootstrap_not_empty')
            result = directory.publish_once('journal.json', raw, boottime_ns()+1_000_000_000)
            response = {'status': 'initialized', 'originVersion': origin, 'sha256': result['sha256']}
        finally:
            directory.close()
        return response
    except Exception as error:
        code = error.code if isinstance(error, Refusal) else 'journal_bootstrap_unresolved'
        raise Refusal(code, outcome='unknown', phase='initialize-journal') from error


def _bridge_record(config, bridge):
    return {'version': 1, 'attempt_id': config['io']['attempt_id'],
            'host_boot_id': config['io']['host_boot_id'], 'offset_ns': str(bridge.offset_ns),
            'uncertainty_ns': bridge.uncertainty_ns}


def initialize_clock(config):
    read_context(config)
    bridge = ClockBridge.sample()
    directory = PinnedDirectory(ATTEMPT_ROOT+'/'+config['io']['attempt_id'])
    try:
        try:
            directory.publish_once('clock-bridge.json', canonical(_bridge_record(config, bridge)),
                                   boottime_ns()+1_000_000_000)
            result = bridge.read()
        finally:
            directory.close()
        return result
    except Exception as error:
        # Initialization may have durably created its one-shot file before a
        # failed final read/close/ack. Never advertise this as a safe refusal.
        code = error.code if isinstance(error, Refusal) else 'clock_initialize_unresolved'
        raise Refusal(code, outcome='unknown', phase='clock_initialize') from error


def read_clock(config):
    require(read_kernel_file('/proc/sys/kernel/random/boot_id', 64) == config['io']['host_boot_id'], 'clock_boot')
    directory = PinnedDirectory(ATTEMPT_ROOT+'/'+config['io']['attempt_id'])
    try:
        record = decode_json(directory.read_file('clock-bridge.json', maximum=2048))
    finally:
        directory.close()
    _fields(record, ('version', 'attempt_id', 'host_boot_id', 'offset_ns', 'uncertainty_ns'), 'clock_record_fields')
    require(type(record['version']) is int and record['version'] == 1
            and record['attempt_id'] == config['io']['attempt_id']
            and record['host_boot_id'] == config['io']['host_boot_id']
            and type(record['offset_ns']) is str
            and re.fullmatch(r'-?(0|[1-9][0-9]{0,18})', record['offset_ns']) is not None, 'clock_record_binding')
    return ClockBridge(int(record['offset_ns']), record['uncertainty_ns']).read()


def read_challenge(config, *, state_root=ATTEMPT_ROOT, owner_uid=0):
    context = read_context(config, state_root=state_root, owner_uid=owner_uid)
    directory = PinnedDirectory(state_root+'/'+config['io']['attempt_id'], owner_uid=owner_uid)
    try:
        raw = directory.read_file('challenge.json', maximum=16384)
    finally:
        directory.close()
    challenge = decode_brokkr_journal(raw)
    require(type(challenge) is dict and set(challenge) == set(context) | {'observed_boottime_ns'}, 'challenge_fields')
    require(all(canonical(challenge[key]) == canonical(value) and type(challenge[key]) is type(value)
                for key, value in context.items()), 'challenge_changed')
    observed = integer(challenge['observed_boottime_ns']); now = boottime_ns()
    require(observed <= now < observed+5_000_000_000, 'challenge_expired')
    return canonical(challenge).decode('ascii')


def publish_admission(config, request):
    require(config['policy'].get('mode') == 'diagnostic', 'publication_mode')
    _fields(request, ('bytes', 'deadline_boottime_ns'), 'publication_request_fields')
    require(type(request['bytes']) is str and request['bytes'].isascii(), 'publication_bytes')
    raw = request['bytes'].encode('ascii'); require(len(raw) <= 65536, 'publication_bound')
    admission = decode_json(raw)
    _fields(admission, ('version', 'attempt_id', 'config_digest', 'descriptor_digest', 'boot_id', 'invocation_id',
                        'cgroup_device', 'cgroup_inode', 'namespace_inodes', 'issued_boottime_ns',
                        'expires_boottime_ns', 'limits', 'coverage', 'protected_manifest_digest',
                        'issuer_release_digest', 'publication_deadline_boottime_ns'), 'admission_v2_fields')
    require(type(admission['version']) is int and admission['version'] == 2, 'admission_v2_required')
    deadline = integer(request['deadline_boottime_ns'])
    require(type(admission['publication_deadline_boottime_ns']) is int
            and admission['publication_deadline_boottime_ns'] == deadline, 'publication_deadline_binding')
    challenge = decode_json(read_challenge(config).encode('ascii'))
    for key in ('attempt_id', 'config_digest', 'descriptor_digest', 'limits'):
        require(canonical(admission[key]) == canonical(challenge[key]), 'admission_binding')
    for key, value in challenge['identity'].items():
        if key != 'cgroup_path':
            require(canonical(admission[key]) == canonical(value), 'admission_identity')
    require(admission['issuer_release_digest'] == config['io']['issuer_release_digest']
            and admission['protected_manifest_digest'] == config['io']['protected_manifest_digest'], 'admission_owner_binding')
    issued = integer(admission['issued_boottime_ns']); expires = integer(admission['expires_boottime_ns'])
    now = boottime_ns()
    require(issued <= now < deadline <= issued+5_000_000_000
            and deadline <= challenge['observed_boottime_ns']+5_000_000_000
            and expires-issued <= 35_000_000_000 and expires-now >= 30_000_000_000, 'admission_window')
    directory = PinnedDirectory(ADMISSION_ROOT+'/'+config['io']['attempt_id'])
    try:
        try:
            result = directory.publish_once('admission.json', raw, deadline)
        finally:
            directory.close()
        return result
    except Exception as error:
        code = error.code if isinstance(error, Refusal) else 'publication_unresolved'
        raise Refusal(code, outcome='unknown', phase='publish') from error


def write_runtime_record(config, configuration_digest, kind):
    """One-shot fixed acknowledgement, not host/allocation/admission evidence."""
    _hex(configuration_digest)
    require(kind in ('self-test-receipt', 'ready'), 'runtime_record_kind')
    require(config['policy'].get('mode') == ('self-test' if kind == 'self-test-receipt' else 'diagnostic'),
            'runtime_record_mode')
    if kind == 'self-test-receipt':
        require(config['registry'] == {}, 'self_test_registry')
    context = read_context(config)
    read_clock(config)
    record = {'version': 1, 'attempt_id': config['io']['attempt_id'],
              'issuer_release_digest': config['io']['issuer_release_digest'],
              'issuer_config_digest': configuration_digest, 'boot_id': context['identity']['boot_id'],
              'invocation_id': context['identity']['invocation_id']}
    if kind == 'self-test-receipt':
        record.update(self_test=True, admission_evidence=False)
    value = canonical(record)
    directory = PinnedDirectory(ATTEMPT_ROOT+'/'+config['io']['attempt_id'])
    try:
        try:
            result = directory.publish_once('issuer-selftest.json' if kind == 'self-test-receipt' else 'issuer-ready.json',
                                            value, boottime_ns()+1_000_000_000)
            response = {'status': 'recorded', 'sha256': result['sha256'], 'bytes': value.decode('ascii')}
        finally:
            directory.close()
        return response
    except Exception as error:
        code = error.code if isinstance(error, Refusal) else 'runtime_record_unresolved'
        raise Refusal(code, outcome='unknown', phase=kind) from error


CGROUP_ROLES = ('worker', 'observer', 'recovery')
CGROUP_LIMIT_FIELDS = ('memory_bytes', 'cpu_quota_us', 'cpu_period_us', 'pids_max', 'swap_bytes')
BROKKR_RELEASE_ROOT = '/opt/brokkr-accounted/releases'
BROKKR_V3_FILES = ('accounted_supervisor.py', 'accounted_capture.py', 'accounted_linux.py',
                   'accounted_fixture.py', 'accounted_recovery.py', 'accounted_recovery_unit.py',
                   'accounted_issuer.py', 'accounted_envelope_unit.py',
                   'accounted_envelope_linux.py', 'accounted_envelope_protocol.py')


def _cgroup_limits(value, *, aggregate=False):
    _fields(value, CGROUP_LIMIT_FIELDS, 'cgroup_limit_fields')
    for item in value.values():
        integer(item)
    require((16777216 if aggregate else 1) <= value['memory_bytes'] <= 536870912
            and 1 <= value['cpu_quota_us'] <= 10000 and value['cpu_period_us'] == 100000
            and (4 if aggregate else 1) <= value['pids_max'] <= 64
            and value['swap_bytes'] == 0, 'cgroup_limit_range')


def _cgroup_plan(attempt, aggregate, roles):
    _hex(attempt, 32)
    _cgroup_limits(aggregate, aggregate=True)
    _fields(roles, CGROUP_ROLES, 'cgroup_roles')
    for role in CGROUP_ROLES:
        _cgroup_limits(roles[role])
    for name in ('memory_bytes', 'cpu_quota_us', 'pids_max'):
        require(sum(roles[role][name] for role in CGROUP_ROLES) <= aggregate[name], 'cgroup_role_sum')


def _cgroup_unit(attempt, role):
    return 'brokkr-accounted-' + ('eval' if role == 'worker' else role) + '-' + attempt + '.service'


def _cgroup_directory(fd, owner_uid, device=None):
    sample = os.fstat(fd)
    require(stat.S_ISDIR(sample.st_mode) and sample.st_uid == owner_uid
            and not sample.st_mode & 0o022
            and (device is None or sample.st_dev == device), 'cgroup_directory_identity')
    return sample


def _cgroup_children(fd, owner_uid, device):
    found = set()
    with os.scandir(fd) as entries:
        for count, entry in enumerate(entries, 1):
            require(count <= 1024, 'cgroup_entry_bound')
            sample = entry.stat(follow_symlinks=False)
            require(not stat.S_ISLNK(sample.st_mode), 'cgroup_symlink')
            if stat.S_ISDIR(sample.st_mode):
                require(sample.st_uid == owner_uid and sample.st_dev == device
                        and not sample.st_mode & 0o022, 'cgroup_child_identity')
                found.add(entry.name)
    return found


def _cgroup_read(fd, name, owner_uid, device, pins):
    # Names are internal literals, not paths supplied by a requester. Virtual
    # cgroup files have st_size=0, so only actual read bytes determine the bound.
    opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=fd)
    try:
        before = os.fstat(opened)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == owner_uid
                and before.st_dev == device and before.st_nlink == 1
                and not before.st_mode & 0o022, 'cgroup_control_identity')
        key = (os.fstat(fd).st_ino, name)
        stamp = _identity(before) + (before.st_gid, before.st_nlink)
        require(key not in pins or pins[key] == stamp, 'cgroup_control_drift')
        pins[key] = stamp
        chunks, size = [], 0
        while True:
            chunk = os.read(opened, min(4096, 65537-size))
            if not chunk:
                break
            size += len(chunk)
            require(size <= 65536, 'cgroup_control_bound')
            chunks.append(chunk)
        after = os.fstat(opened)
        named = os.stat(name, dir_fd=fd, follow_symlinks=False)
        require(stamp == _identity(after) + (after.st_gid, after.st_nlink)
                == _identity(named) + (named.st_gid, named.st_nlink), 'cgroup_control_drift')
        try:
            return b''.join(chunks).decode('ascii').strip()
        except UnicodeError as error:
            raise Refusal('cgroup_control_encoding') from error
    finally:
        os.close(opened)


def _collect_cgroup_at_impl(root_fd, attempt, aggregate, roles, *, owner_uid, clock, kernel_charges=False):
    """Real fd-relative filesystem observations, not native trust authentication.

    The private library core permits real own-UID test files. Production supplies
    only the fixed root cgroup2 directory and UID0, never a requester capability.
    No invocation, namespace, AS, inventory or allocation claim is returned.
    """
    _cgroup_plan(attempt, aggregate, roles)
    require(type(kernel_charges) is bool, 'cgroup_channel_selector')
    require(type(owner_uid) is int and owner_uid == os.geteuid(), 'cgroup_owner')
    # Detach mutable desired values before any filesystem operation.
    aggregate, roles = decode_json(canonical(aggregate)), decode_json(canonical(roles))
    start = integer(clock())
    root = _cgroup_directory(root_fd, owner_uid)
    parent_name = 'brokkr_accounted_' + attempt + '.slice'
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    parent_fd = os.open(parent_name, flags, dir_fd=root_fd)
    handles = []
    try:
        parent = _cgroup_directory(parent_fd, owner_uid, root.st_dev)
        names = {_cgroup_unit(attempt, role) for role in CGROUP_ROLES}
        require(_cgroup_children(parent_fd, owner_uid, root.st_dev) == names, 'cgroup_member_set')
        for role in CGROUP_ROLES:
            unit = _cgroup_unit(attempt, role)
            fd = os.open(unit, flags, dir_fd=parent_fd)
            handles.append((role, unit, fd, None))
            sample = _cgroup_directory(fd, owner_uid, root.st_dev)
            handles[-1] = (role, unit, fd, sample)
        require(len({parent.st_ino} | {item.st_ino for _, _, _, item in handles}) == 4, 'cgroup_scope_alias')
        pins = {}

        def check_limits(fd, limits, oom):
            wanted = {'memory.max': str(limits['memory_bytes']), 'memory.swap.max': '0',
                      'pids.max': str(limits['pids_max']),
                      'cpu.max': f"{limits['cpu_quota_us']} {limits['cpu_period_us']}",
                      'cpu.max.burst': '0', 'memory.oom.group': str(oom), 'cgroup.type': 'domain'}
            for field, value in wanted.items():
                require(_cgroup_read(fd, field, owner_uid, root.st_dev, pins) == value, 'cgroup_effective_limit')
            events = _cgroup_read(fd, 'cgroup.events', owner_uid, root.st_dev, pins).splitlines()
            require(len(events) == 2 and set(events) == {'populated 1', 'frozen 0'}, 'cgroup_events')

        previous = start; passes = []

        def kernel_sample(scope, fd, original):
            value = {'scope': scope, 'cgroup_device': original.st_dev, 'cgroup_inode': original.st_ino}
            for field, name in (('cpu_stat', 'cpu.stat'), ('memory_stat', 'memory.stat'),
                                ('memory_current', 'memory.current'), ('memory_events_local', 'memory.events.local'),
                                ('pids_current', 'pids.current'), ('pids_events_local', 'pids.events.local')):
                raw = _cgroup_read(fd, name, owner_uid, root.st_dev, pins)
                require(raw != '', 'kernel_raw_empty')
                value[field] = raw
            return value

        for _ in range(2):
            samples = []
            check_limits(parent_fd, aggregate, 0)
            require(_cgroup_read(parent_fd, 'cgroup.procs', owner_uid, root.st_dev, pins) == '', 'cgroup_internal_process')
            require(_cgroup_children(parent_fd, owner_uid, root.st_dev) == names, 'cgroup_member_set')
            if kernel_charges:
                samples.append(kernel_sample('parent', parent_fd, parent))
            for role, unit, fd, original in handles:
                require(_cgroup_children(fd, owner_uid, root.st_dev) == set(), 'cgroup_role_subgroup')
                check_limits(fd, roles[role], 1)
                if kernel_charges:
                    samples.append(kernel_sample(role, fd, original))
                require(_identity(original) == _identity(_cgroup_directory(fd, owner_uid, root.st_dev))
                        == _identity(os.stat(unit, dir_fd=parent_fd, follow_symlinks=False)), 'cgroup_role_drift')
            require(_identity(parent) == _identity(_cgroup_directory(parent_fd, owner_uid, root.st_dev))
                    == _identity(os.stat(parent_name, dir_fd=root_fd, follow_symlinks=False)), 'cgroup_parent_drift')
            require(_identity(root) == _identity(_cgroup_directory(root_fd, owner_uid)), 'cgroup_root_drift')
            now = integer(clock())
            require(previous <= now <= start+1_000_000_000, 'cgroup_observation_window')
            if kernel_charges:
                passes.append({'observed_from_boottime_ns': previous, 'observed_until_boottime_ns': now,
                               'scope_samples': samples})
            previous = now
        value = {'version': 1, 'kind': 'cgroup_kernel_charges_observation' if kernel_charges else 'cgroup_envelope_observation',
                'attempt_id': attempt,
                'native_envelope': {'version': 1, 'unit': parent_name, 'cgroup_path': '/'+parent_name,
                                    'cgroup_device': parent.st_dev, 'cgroup_inode': parent.st_ino, 'limits': aggregate},
                'role_cgroups': [{'role': role, 'unit': unit, 'cgroup_path': '/'+parent_name+'/'+unit,
                                  'cgroup_device': sample.st_dev, 'cgroup_inode': sample.st_ino, 'limits': roles[role]}
                                 for role, unit, _, sample in handles],
                'observed_from_boottime_ns': start, 'observed_until_boottime_ns': now}
        if kernel_charges:
            value['passes'] = passes
        return value
    finally:
        for _, _, fd, _ in reversed(handles):
            os.close(fd)
        os.close(parent_fd)


def _collect_cgroup_at(root_fd, attempt, aggregate, roles, *, owner_uid, clock=boottime_ns):
    try:
        return _collect_cgroup_at_impl(root_fd, attempt, aggregate, roles, owner_uid=owner_uid, clock=clock)
    except OSError as error:
        raise Refusal('cgroup_io_refused') from error


def _collect_kernel_at(root_fd, attempt, aggregate, roles, *, owner_uid, clock=boottime_ns):
    try:
        return _collect_cgroup_at_impl(root_fd, attempt, aggregate, roles, owner_uid=owner_uid,
                                      clock=clock, kernel_charges=True)
    except OSError as error:
        raise Refusal('kernel_io_refused') from error


def validate_brokkr_v3_configuration(body):
    """Independent closed projection of the frozen B v3 parser; no B imports.

    These are desired values only. Byte/source/native checks are separate and
    mandatory. The legacy worker reserve ceiling is intentionally preserved.
    """
    _fields(body, ('version', 'attempt_id', 'release_id', 'source_revision', 'descriptor_digest',
                  'executable_path', 'executable_sha256', 'actor_uid', 'actor_gid', 'limits',
                  'read_files', 'read_trees', 'read_dirs', 'target_host', 'execution_kind',
                  'issuer', 'address_space_limit_bytes', 'envelope'), 'brokkr_v3_fields')
    require(len(canonical(body)) <= 65536, 'brokkr_v3_configuration_bound')
    require(type(body['version']) is int and body['version'] == 3, 'brokkr_v3_version')
    _hex(body['attempt_id'], 32); _hex(body['source_revision'], 40)
    for key in ('release_id', 'descriptor_digest', 'executable_sha256'):
        _hex(body[key])
    for key in ('actor_uid', 'actor_gid'):
        require(type(body[key]) is int and 1 <= body[key] < 2**31, 'brokkr_actor_identity')
    require(type(body['target_host']) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9.-]{0,252}', body['target_host']),
            'brokkr_target_host')

    def path(value):
        require(type(value) is str and re.fullmatch(r'/[A-Za-z0-9_./-]+', value)
                and value != '/' and os.path.normpath(value) == value
                and '..' not in value.split('/'), 'brokkr_path')
        return value

    executable = path(body['executable_path'])
    require(executable in ('/usr/bin/podman', '/usr/local/bin/podman'), 'brokkr_executable')
    limits = body['limits']
    _fields(limits, CGROUP_LIMIT_FIELDS[:-1], 'brokkr_worker_limit_fields')
    _cgroup_limits({**limits, 'swap_bytes': 0}, aggregate=True)
    require(limits['memory_bytes'] <= 469762048 and limits['cpu_quota_us'] <= 9000
            and limits['pids_max'] <= 56, 'brokkr_worker_reserve_ceiling')
    files = body['read_files']
    require(type(files) is list and 1 <= len(files) <= 128, 'brokkr_read_files')
    seen = set()
    for rule in files:
        _fields(rule, ('path', 'sha256'), 'brokkr_read_file_fields')
        item = path(rule['path']); _hex(rule['sha256'])
        require(item not in seen, 'brokkr_duplicate_read_file'); seen.add(item)
        parts = item.split('/')
        require(not any(p in ('.ssh', '.aws', '.gnupg', 'secrets') or p.startswith('.env') for p in parts)
                and parts[-1] not in ('shadow', 'gshadow', 'auth.json', 'credentials', 'credentials.json'), 'brokkr_secret_path')
    require({'path': executable, 'sha256': body['executable_sha256']} in files, 'brokkr_executable_rule')
    for key, maximum in (('read_trees', 8), ('read_dirs', 32)):
        values = body[key]
        require(type(values) is list and len(values) <= maximum, 'brokkr_read_paths')
        checked = [path(value) for value in values]
        require(len(set(checked)) == len(checked), 'brokkr_duplicate_read_path')
        if key == 'read_trees':
            require(all(p in ('/usr/lib', '/usr/lib64', '/usr/local/lib', '/lib', '/lib64') for p in checked), 'brokkr_read_tree')
    require(body['execution_kind'] in ('fixture', 'diagnostic'), 'brokkr_execution_kind')
    address = integer(body['address_space_limit_bytes']); require(address > 0, 'brokkr_address_space')
    issuer = body['issuer']
    if not (body['execution_kind'] == 'fixture' and issuer is None):
        _fields(issuer, ('node_path', 'node_sha256', 'release_digest', 'entry_sha256', 'helper_sha256', 'mandate_id'), 'brokkr_issuer_fields')
        require(issuer['node_path'] in ('/usr/bin/node', '/usr/local/bin/node'), 'brokkr_node_path')
        _uuid(issuer['mandate_id'])
        for key in ('node_sha256', 'release_digest', 'entry_sha256', 'helper_sha256'):
            _hex(issuer[key])
    envelope = body['envelope']
    _fields(envelope, ('limits', 'role_limits', 'lease_id', 'allocated_from_boottime_ns', 'allocated_until_boottime_ns',
                       'owner_authorization_digest', 'producer_release_digest', 'producer_config_digest'), 'brokkr_envelope_fields')
    for key in ('lease_id', 'owner_authorization_digest', 'producer_release_digest', 'producer_config_digest'):
        _hex(envelope[key])
    _fields(envelope['role_limits'], CGROUP_ROLES, 'brokkr_role_set')
    projected = {}
    for role in CGROUP_ROLES:
        spec = envelope['role_limits'][role]
        _fields(spec, CGROUP_LIMIT_FIELDS + ('address_space_limit_bytes',), 'brokkr_role_fields')
        require(integer(spec['address_space_limit_bytes']) == address, 'brokkr_role_address_space')
        projected[role] = {key: spec[key] for key in CGROUP_LIMIT_FIELDS}
    _cgroup_plan(body['attempt_id'], envelope['limits'], projected)
    require({key: projected['worker'][key] for key in limits} == limits, 'brokkr_worker_limits')
    start = integer(envelope['allocated_from_boottime_ns']); end = integer(envelope['allocated_until_boottime_ns'])
    require(end > start and 30 <= (end-start+999999999)//1000000000 <= 90, 'brokkr_lease_interval')
    return decode_json(canonical(body))


def validate_cgroup_v3_binding(config, body):
    """Bind the accepted static registry, never promote it to observed facts."""
    body = validate_brokkr_v3_configuration(body)
    io, accepted = config['io'], config['accepted']
    require(config['policy'].get('mode') == 'diagnostic' and body['execution_kind'] == 'diagnostic'
            and body['attempt_id'] == io['attempt_id'] and body['source_revision'] == accepted.get('sourceRevision')
            and body['release_id'] == accepted.get('releaseId') and body['descriptor_digest'] == io['descriptor_digest'] == DESCRIPTOR
            and body['actor_uid'] == 1000
            and hashlib.sha256(canonical(body)).hexdigest() == io['brokkr_config_digest'], 'cgroup_v3_config_binding')
    spec = config['registry'].get('cgroupEnvelopeV3')
    _fields(spec, ('version', 'parent_limits', 'role_limits'), 'cgroup_v3_registry_fields')
    require(type(spec['version']) is int and spec['version'] == 1, 'cgroup_v3_registry_version')
    _cgroup_plan(io['attempt_id'], spec['parent_limits'], spec['role_limits'])
    actual_spec = {'version': 1, 'parent_limits': body['envelope']['limits'],
                   'role_limits': {role: {key: body['envelope']['role_limits'][role][key] for key in CGROUP_LIMIT_FIELDS}
                                   for role in CGROUP_ROLES}}
    require(canonical(spec) == canonical(actual_spec), 'cgroup_v3_registry_binding')
    request = accepted.get('request')
    require(type(request) is dict and type(request.get('limits')) is dict
            and type(request['limits'].get('addressSpaceLimitBytes')) is int
            and request['limits']['addressSpaceLimitBytes'] == body['address_space_limit_bytes'], 'cgroup_v3_address_space_binding')
    issuer = body['issuer']
    require(issuer['release_digest'] == io['issuer_release_digest'], 'cgroup_v3_issuer_binding')
    return body


class BrokkrV3ReleaseDirectory(PinnedDirectory):
    """B's distinct root0644 source format; not the INFER0444 format."""
    def __init__(self, path, *, owner_uid=0):
        super().__init__(path, owner_uid=owner_uid, private_target=False)

    def _file(self, sample, maximum):
        require(stat.S_ISREG(sample.st_mode) and sample.st_uid == self.owner_uid
                and stat.S_IMODE(sample.st_mode) == 0o644 and sample.st_nlink == 1
                and sample.st_dev == self.pins[-1][3].st_dev and 0 < sample.st_size <= maximum,
                'brokkr_release_file_identity')

    def verify(self, body):
        self.check()
        found = set()
        with os.scandir(self.fd) as entries:
            for count, entry in enumerate(entries, 1):
                require(count <= 11, 'brokkr_release_members')
                found.add(entry.name)
        require(found == set(BROKKR_V3_FILES) | {'release.json'}, 'brokkr_release_members')
        raw = self.read_file('release.json', maximum=131072)
        manifest = decode_brokkr_journal(raw)
        _fields(manifest, ('source_revision', 'files'), 'brokkr_release_manifest_fields')
        _fields(manifest['files'], BROKKR_V3_FILES, 'brokkr_release_manifest_members')
        require(manifest['source_revision'] == body['source_revision']
                and hashlib.sha256(canonical(manifest)).hexdigest() == body['release_id'], 'brokkr_release_binding')
        for name in BROKKR_V3_FILES:
            self.read_file(name, maximum=131072, expected_sha256=_hex(manifest['files'][name]))
        self.check()


def _require_cgroup2(fd):
    require(sys.platform == 'linux' and os.geteuid() == 0, 'cgroup_root_linux_required')
    buffer = ctypes.create_string_buffer(256)
    function = ctypes.CDLL(None, use_errno=True).fstatfs
    function.argtypes = [ctypes.c_int, ctypes.c_void_p]; function.restype = ctypes.c_int
    require(function(fd, ctypes.byref(buffer)) == 0
            and ctypes.c_long.from_buffer(buffer).value == 0x63677270, 'cgroup2_required')


def _native_v3_worker(config, body):
    # No argv, environment, foreign process or requester-selected kernel paths.
    require(read_kernel_file('/proc/sys/kernel/random/boot_id', 64) == config['io']['host_boot_id'], 'cgroup_v3_boot')
    group = '/brokkr_accounted_'+body['attempt_id']+'.slice/'+_cgroup_unit(body['attempt_id'], 'worker')
    require(read_kernel_file(f'/proc/{os.getpid()}/cgroup', 4096) == '0::'+group, 'cgroup_v3_worker_placement')
    require(resource.getrlimit(resource.RLIMIT_AS) == (body['address_space_limit_bytes'],)*2, 'cgroup_v3_effective_address_space')
    now = boottime_ns()
    require(body['envelope']['allocated_from_boottime_ns'] <= now < body['envelope']['allocated_until_boottime_ns'], 'cgroup_v3_lease_expired')


def _worker_v3_identity(value):
    _fields(value, ('boot_id', 'invocation_id', 'cgroup_path', 'cgroup_device', 'cgroup_inode',
                    'namespace_inodes'), 'worker_v3_identity_fields')
    _uuid(value['boot_id']); _hex(value['invocation_id'], 32)
    for key in ('cgroup_device', 'cgroup_inode'):
        require(integer(value[key]) > 0, 'worker_v3_identity_integer')
    _fields(value['namespace_inodes'], ('mnt', 'net', 'ipc', 'pid'), 'worker_v3_namespace_fields')
    for inode in value['namespace_inodes'].values():
        require(integer(inode) > 0, 'worker_v3_namespace_inode')


def validate_worker_bootstrap_v3(config, body, context, now_ns):
    """Closed bootstrap consistency only; authentication requires live kernel I/O."""
    body = validate_cgroup_v3_binding(config, body)
    now_ns = integer(now_ns)
    _fields(context, ('version', 'attempt_id', 'unit', 'source_revision', 'release_id', 'config_digest',
                      'descriptor_digest', 'identity', 'limits', 'native_envelope', 'role_cgroups',
                      'worker_process_observation'), 'worker_v3_context_fields')
    require(type(context['version']) is int and context['version'] == 3, 'worker_v3_context_version')
    attempt = body['attempt_id']; parent = 'brokkr_accounted_'+attempt+'.slice'
    unit = _cgroup_unit(attempt, 'worker'); group = '/'+parent+'/'+unit
    require(context['attempt_id'] == attempt and context['unit'] == unit
            and context['source_revision'] == body['source_revision']
            and context['release_id'] == body['release_id']
            and context['config_digest'] == config['io']['brokkr_config_digest']
            and context['descriptor_digest'] == DESCRIPTOR
            and canonical(context['limits']) == canonical(body['limits']), 'worker_v3_context_binding')
    identity = context['identity']; _worker_v3_identity(identity)
    require(identity['boot_id'] == config['io']['host_boot_id'] and identity['cgroup_path'] == group,
            'worker_v3_context_identity')
    envelope = context['native_envelope']
    _fields(envelope, ('version', 'unit', 'cgroup_path', 'cgroup_device', 'cgroup_inode', 'limits'), 'worker_v3_parent_fields')
    require(type(envelope['version']) is int and envelope['version'] == 1
            and envelope['unit'] == parent and envelope['cgroup_path'] == '/'+parent
            and integer(envelope['cgroup_device']) > 0 and integer(envelope['cgroup_inode']) > 0
            and envelope['cgroup_device'] == identity['cgroup_device']
            and canonical(envelope['limits']) == canonical(body['envelope']['limits']), 'worker_v3_parent_binding')
    roles = context['role_cgroups']
    require(type(roles) is list and len(roles) == 3, 'worker_v3_role_count')
    inodes = {envelope['cgroup_inode']}
    for name, role in zip(CGROUP_ROLES, roles):
        _fields(role, ('role', 'unit', 'cgroup_path', 'cgroup_device', 'cgroup_inode', 'limits'), 'worker_v3_role_fields')
        role_unit = _cgroup_unit(attempt, name)
        require(role['role'] == name and role['unit'] == role_unit and role['cgroup_path'] == '/'+parent+'/'+role_unit
                and integer(role['cgroup_device']) == envelope['cgroup_device'] and integer(role['cgroup_inode']) > 0
                and role['cgroup_inode'] not in inodes
                and canonical(role['limits']) == canonical({key: body['envelope']['role_limits'][name][key]
                                                          for key in CGROUP_LIMIT_FIELDS}), 'worker_v3_role_binding')
        inodes.add(role['cgroup_inode'])
    require(roles[0]['cgroup_inode'] == identity['cgroup_inode'], 'worker_v3_worker_inode')
    observation = context['worker_process_observation']
    _fields(observation, ('version', 'kind', 'attempt_id', 'role', 'identity', 'process_id', 'process_start_ticks',
                         'clock_ticks_per_second', 'process_start_boottime_lower_ns', 'address_space_limit_bytes',
                         'no_new_privileges', 'scheduler_policy', 'observed_from_boottime_ns',
                         'observed_until_boottime_ns'), 'worker_v3_observation_fields')
    require(type(observation['version']) is int and observation['version'] == 1
            and observation['kind'] == 'owned_role_process_observation'
            and observation['attempt_id'] == attempt and observation['role'] == 'worker'
            and canonical(observation['identity']) == canonical(identity)
            and integer(observation['process_id']) == 1
            and integer(observation['address_space_limit_bytes']) == body['address_space_limit_bytes']
            and observation['no_new_privileges'] is True
            and type(observation['scheduler_policy']) is int and observation['scheduler_policy'] == 0,
            'worker_v3_process_binding')
    ticks = integer(observation['process_start_ticks']); hz = integer(observation['clock_ticks_per_second'])
    lower = integer(observation['process_start_boottime_lower_ns'])
    require(hz > 0 and lower == ticks*1000000000//hz, 'worker_v3_process_start')
    start = integer(observation['observed_from_boottime_ns']); end = integer(observation['observed_until_boottime_ns'])
    lease = body['envelope']
    require(lower <= start <= end <= now_ns and end-start <= 1000000000
            and lease['allocated_from_boottime_ns'] <= start
            and end < lease['allocated_until_boottime_ns'] and now_ns < lease['allocated_until_boottime_ns'],
            'worker_v3_observation_window')
    return decode_json(canonical(context))


def _worker_v3_fs(fd, magic):
    buffer = ctypes.create_string_buffer(256)
    function = ctypes.CDLL(None, use_errno=True).fstatfs
    function.argtypes = [ctypes.c_int, ctypes.c_void_p]; function.restype = ctypes.c_int
    require(function(fd, ctypes.byref(buffer)) == 0
            and ctypes.c_long.from_buffer(buffer).value == magic, 'worker_v3_filesystem')


def _worker_v3_proc(path):
    allowed = {f'/proc/{pid}/{field}' for pid in (1, os.getpid())
               for field in ('stat', 'status', 'limits', 'cgroup')}
    require(path in allowed, 'worker_v3_proc_path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and not before.st_mode & 0o022, 'worker_v3_proc_identity')
        _worker_v3_fs(fd, 0x9fa0)  # PROC_SUPER_MAGIC, not a regular-file fixture.
        raw = os.read(fd, 4097)
        require(0 < len(raw) <= 4096 and os.read(fd, 1) == b'', 'worker_v3_proc_bound')
        require(_identity(before) == _identity(os.fstat(fd))
                == _identity(os.stat(path, follow_symlinks=False)), 'worker_v3_proc_drift')
        try:
            return raw.decode('ascii')
        except UnicodeError as error:
            raise Refusal('worker_v3_proc_encoding') from error
    finally:
        os.close(fd)


def _worker_v3_start(raw):
    # Only fixed PID1's field22 is retained. The bounded comm field is discarded,
    # including embedded spaces/parentheses; neither argv nor environ is read.
    require(type(raw) is str and 0 < len(raw) <= 4096 and raw.startswith('1 ('), 'worker_v3_stat_pid')
    end = raw.rfind(') ')
    require(end >= 3, 'worker_v3_stat_shape')
    fields = raw[end+2:].split()
    require(len(fields) >= 20 and fields[0] in ('R', 'S', 'D', 'T', 't', 'K', 'W', 'P', 'I'), 'worker_v3_pid1_not_live')
    require(re.fullmatch(r'[0-9]{1,19}', fields[19]) is not None, 'worker_v3_start_ticks')
    return integer(int(fields[19]))


def _worker_v3_namespaces(pid):
    require(type(pid) is int and pid in (1, os.getpid()), 'worker_v3_namespace_pid')
    values = {}
    for name in ('mnt', 'net', 'ipc', 'pid'):
        path = f'/proc/{pid}/ns/{name}'
        # Only these kernel namespace magic-links may be followed; regular files
        # cannot substitute because the FD must refer to NSFS.
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        try:
            _worker_v3_fs(fd, 0x6e736673)  # NSFS_MAGIC
            sample = os.fstat(fd)
            named = os.stat(path)
            require(sample.st_uid == 0 and sample.st_ino > 0
                    and (sample.st_dev, sample.st_ino)
                    == (named.st_dev, named.st_ino), 'worker_v3_namespace_drift')
            values[name] = integer(sample.st_ino)
        finally:
            os.close(fd)
    return values


def _worker_v3_binary(pid, expected_sha256):
    require(type(pid) is int and pid in (1, os.getpid()), 'worker_v3_binary_pid')
    _hex(expected_sha256)
    path = f'/proc/{pid}/exe'
    # Fixed kernel exe magic-link only. No requester path, ptrace, argv or memory.
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == 0
                and not before.st_mode & 0o022 and before.st_nlink == 1
                and 0 < before.st_size <= 16777216, 'worker_v3_interpreter_identity')
        digest = hashlib.sha256(); size = 0
        while True:
            chunk = os.read(fd, min(65536, 16777217-size))
            if not chunk:
                break
            size += len(chunk); require(size <= 16777216, 'worker_v3_interpreter_bound'); digest.update(chunk)
        require(size == before.st_size and _full_identity(before) == _full_identity(os.fstat(fd))
                == _full_identity(os.stat(path)) and digest.hexdigest() == expected_sha256, 'worker_v3_interpreter_binding')
        return _identity(before)
    finally:
        os.close(fd)


def _worker_v3_pid1_limits(raw, address):
    for label, suffix, wanted in (('Max core file size', 'bytes', 0), ('Max open files', 'files', 128),
                                   ('Max address space', 'bytes', address)):
        matches = [line for line in raw.splitlines() if line.startswith(label)]
        require(len(matches) == 1, 'worker_v3_pid1_limits')
        match = re.fullmatch(re.escape(label)+r'\s+([0-9]{1,19})\s+([0-9]{1,19})\s+'+suffix+r'\s*', matches[0])
        require(match is not None and int(match[1]) == int(match[2]) == wanted, 'worker_v3_pid1_limits')


def _worker_v3_root_status(raw):
    require(type(raw) is str and 0 < len(raw) <= 4096, 'worker_v3_pid1_status')
    identities = {}
    for label in ('Uid', 'Gid'):
        rows = [line for line in raw.splitlines() if line.startswith(label+':')]
        require(len(rows) == 1, 'worker_v3_pid1_status')
        match = re.fullmatch(label+r':\s+([0-9]{1,10})\s+([0-9]{1,10})\s+([0-9]{1,10})\s+([0-9]{1,10})\s*', rows[0])
        require(match is not None, 'worker_v3_pid1_status')
        identities[label] = tuple(int(value) for value in match.groups())
        require(all(value < 2**32 for value in identities[label]), 'worker_v3_pid1_status')
    # The accepted root profile requires effective UID0. It does not promise
    # extra real/saved/fs UID or GID restrictions; do not invent those limits.
    require(identities['Uid'][1] == 0, 'worker_v3_pid1_effective_uid')
    rows = [line for line in raw.splitlines() if line.startswith('NoNewPrivs:')]
    require(len(rows) == 1 and re.fullmatch(r'NoNewPrivs:\s+1\s*', rows[0]) is not None,
            'worker_v3_pid1_no_new_privileges')


def _authenticate_worker_bootstrap_v3(config, body, context):
    """Authenticate this live child/PID1 channel; returns an owned live pidfd.

    No test overrides or callbacks. The caller keeps the returned FD until its
    operation ends and closes it. This is not a complete host/allocation proof.
    """
    require(sys.platform == 'linux' and os.geteuid() == 0 and os.getpid() > 1, 'worker_v3_root_linux_child')
    context = validate_worker_bootstrap_v3(config, body, context, boottime_ns())
    profile = config['registry'].get('workerBootstrapV3')
    _fields(profile, ('version', 'python_sha256'), 'worker_v3_profile_fields')
    require(type(profile['version']) is int and profile['version'] == 1, 'worker_v3_profile_version')
    _hex(profile['python_sha256'])
    # INVOCATION_ID is the one explicitly public systemd field. No environment
    # enumeration, credential field or /proc/*/environ access exists here.
    require(os.environ.get('INVOCATION_ID') == context['identity']['invocation_id'], 'worker_v3_invocation')
    _native_v3_worker(config, body)
    require(resource.getrlimit(resource.RLIMIT_CORE) == (0, 0)
            and resource.getrlimit(resource.RLIMIT_NOFILE) == (128, 128), 'worker_v3_helper_limits')
    scheduler = getattr(os, 'sched_getscheduler', None)
    require(scheduler is not None and scheduler(0) == scheduler(1) == 0, 'worker_v3_scheduler')
    function = ctypes.CDLL(None, use_errno=True).prctl
    function.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    function.restype = ctypes.c_int
    require(function(39, 0, 0, 0, 0) == 1, 'worker_v3_no_new_privileges')  # PR_GET_NO_NEW_PRIVS
    pidfd_open = getattr(os, 'pidfd_open', None)
    require(pidfd_open is not None and hasattr(select, 'poll'), 'worker_v3_pidfd_unavailable')
    fd = pidfd_open(1, 0)
    try:
        poller = select.poll(); poller.register(fd, select.POLLIN)
        require(not poller.poll(0), 'worker_v3_pid1_not_live')
        observation = context['worker_process_observation']
        before = _worker_v3_start(_worker_v3_proc('/proc/1/stat'))
        require(before == observation['process_start_ticks']
                and os.sysconf('SC_CLK_TCK') == observation['clock_ticks_per_second'], 'worker_v3_actual_start')
        group = context['identity']['cgroup_path']
        require(_worker_v3_proc('/proc/1/cgroup').strip() == '0::'+group
                and _worker_v3_proc(f'/proc/{os.getpid()}/cgroup').strip() == '0::'+group, 'worker_v3_actual_cgroup')
        wanted = context['identity']['namespace_inodes']
        require(_worker_v3_namespaces(1) == _worker_v3_namespaces(os.getpid()) == wanted, 'worker_v3_actual_namespaces')
        _worker_v3_pid1_limits(_worker_v3_proc('/proc/1/limits'), body['address_space_limit_bytes'])
        _worker_v3_root_status(_worker_v3_proc('/proc/1/status'))
        require(_worker_v3_binary(1, profile['python_sha256'])
                == _worker_v3_binary(os.getpid(), profile['python_sha256']), 'worker_v3_interpreter_identity')
        require(before == _worker_v3_start(_worker_v3_proc('/proc/1/stat'))
                and not poller.poll(0), 'worker_v3_pid1_replaced')
        validate_worker_bootstrap_v3(config, body, context, boottime_ns())
        return fd
    except BaseException:
        os.close(fd)
        raise


def authenticate_worker_bootstrap_v3(config, body, context):
    try:
        return _authenticate_worker_bootstrap_v3(config, body, context)
    except OSError as error:
        raise Refusal('worker_v3_kernel_refused') from error


def _cgroup_v3_observation_bracket(before_ns, value, after_ns):
    before_ns = integer(before_ns); after_ns = integer(after_ns)
    start = integer(value['observed_from_boottime_ns']); end = integer(value['observed_until_boottime_ns'])
    require(before_ns <= start <= end <= after_ns and end-start <= 1000000000,
            'cgroup_v3_outer_observation_window')


def _collect_v3_channel(config, *, kernel_charges):
    """Fixed production operation. No paths, test overrides or callbacks in CLI.

    Full source/config/native gates bracket the actual two-pass cgroup read. B
    code is hash-pinned but never imported. Success proves only these cgroup
    observations, not source compilation, all six channels or full admission.
    """
    require(sys.platform == 'linux' and os.geteuid() == 0, 'cgroup_root_linux_required')
    require(type(kernel_charges) is bool, 'cgroup_channel_selector')
    verify_configured_release(config)
    directory = PinnedDirectory(BROKKR_CONFIGURATION_ROOT, private_target=False)
    source = root = context_directory = None
    pidfds = []
    try:
        name = _hex(config['io']['attempt_id'], 32)+'.json'
        raw = directory.read_file(name, maximum=65536)
        body = validate_cgroup_v3_binding(config, decode_brokkr_journal(raw))
        _native_v3_worker(config, body)
        context_directory = PinnedDirectory(ATTEMPT_ROOT+'/'+body['attempt_id'])
        context_raw = context_directory.read_file('issuer-context-v3.json', maximum=65536)
        context = validate_worker_bootstrap_v3(config, body, decode_brokkr_journal(context_raw), boottime_ns())
        source = BrokkrV3ReleaseDirectory(BROKKR_RELEASE_ROOT+'/'+body['release_id'])
        source.verify(body)
        own = ReleaseDirectory(RELEASE_ROOT+'/'+config['io']['issuer_release_digest'])
        try:
            manifest = parse_release_manifest(own.read_file(RELEASE_MANIFEST, maximum=4096))
            require(manifest['files']['accounted-host-issuer.mjs']['sha256'] == body['issuer']['entry_sha256']
                    and manifest['files']['accounted-host-io.py']['sha256'] == body['issuer']['helper_sha256'], 'cgroup_v3_issuer_code_binding')
        finally:
            own.close()
        pidfds.append(authenticate_worker_bootstrap_v3(config, body, context))
        root = PinnedDirectory('/sys/fs/cgroup', private_target=False)
        _require_cgroup2(root.fd)
        spec = config['registry']['cgroupEnvelopeV3']
        before_collect = boottime_ns()
        collector = _collect_kernel_at if kernel_charges else _collect_cgroup_at
        value = collector(root.fd, body['attempt_id'], spec['parent_limits'], spec['role_limits'], owner_uid=0)
        _cgroup_v3_observation_bracket(before_collect, value, boottime_ns())
        require(canonical(value['native_envelope']) == canonical(context['native_envelope'])
                and canonical(value['role_cgroups']) == canonical(context['role_cgroups']), 'worker_v3_live_cgroup_drift')
        require(body['envelope']['allocated_from_boottime_ns'] <= value['observed_from_boottime_ns']
                <= value['observed_until_boottime_ns'] <= body['envelope']['allocated_until_boottime_ns'], 'cgroup_v3_observation_lease')
        packet = {'version': 1, 'status': 'observed',
                  'channel': 'cgroup_kernel_charges_v1' if kernel_charges else 'cgroup_envelope_v1',
                  'brokkr_config_digest': config['io']['brokkr_config_digest'], 'value': value}
        # Encode control-character-containing counter text BEFORE final checks.
        # The generic helper transport receives a printable ASCII JSON string,
        # so its existing strict native/helper codecs are not weakened.
        encoded_packet = canonical(packet)
        require(len(encoded_packet) <= 65536, 'cgroup_channel_packet_bound')
        root.check(); source.verify(body)
        require(raw == directory.read_file(name, maximum=65536), 'cgroup_v3_configuration_drift')
        require(context_raw == context_directory.read_file('issuer-context-v3.json', maximum=65536), 'worker_v3_context_drift')
        verify_configured_release(config)
        # main already authenticated these exact canonical bytes against its
        # caller's accepted hash. Recheck them here, BEFORE the final native/
        # lease validation, rather than doing potentially slow I/O after it.
        configuration_path = CONFIGURATION_ROOT+'/'+body['attempt_id']+'.json'
        configuration_digest = hashlib.sha256(canonical(config)).hexdigest()
        require(canonical(load_configuration(configuration_path, configuration_digest)) == canonical(config),
                'cgroup_v3_root_configuration_drift')
        pidfds.append(authenticate_worker_bootstrap_v3(config, body, context))
        validate_worker_bootstrap_v3(config, body, context, boottime_ns())
        for fd in pidfds:
            poller = select.poll(); poller.register(fd, select.POLLIN)
            require(not poller.poll(0), 'worker_v3_pid1_not_live')
        # Last cheap clock check follows even pure validation and pidfd polls.
        # This does not promise a deadline on a later blocked output syscall.
        require(body['envelope']['allocated_from_boottime_ns'] <= boottime_ns()
                < body['envelope']['allocated_until_boottime_ns'], 'worker_v3_observation_window')
        return {'bytes': encoded_packet.decode('ascii')} if kernel_charges else packet
    except OSError as error:
        raise Refusal('cgroup_io_refused') from error
    finally:
        for fd in reversed(pidfds):
            os.close(fd)
        if context_directory is not None:
            context_directory.close()
        if root is not None:
            root.close()
        if source is not None:
            source.close()
        directory.close()


def collect_cgroup_envelope_v1(config):
    return _collect_v3_channel(config, kernel_charges=False)


def collect_cgroup_kernel_charges_v1(config):
    return _collect_v3_channel(config, kernel_charges=True)


def main(argv=None):
    # This production entrypoint has no unprivileged/test mode or configurable
    # owner/path roots. Tests call bounded library functions on their own files.
    if sys.platform != 'linux' or os.geteuid() != 0:
        print('{"reason":"root_linux_required","status":"refused"}')
        return 78
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        require(len(args) == 3 and args[2] in ('configuration', 'initialize-clock', 'clock', 'context', 'challenge',
                                             'publish', 'self-test-receipt', 'ready', 'initialize-journal',
                                             'collect_cgroup_envelope_v1', 'collect_cgroup_kernel_charges_v1'), 'arguments')
        # Outer service/resource watchdog remains required. No new isolation is
        # claimed from this per-operation timeout, and timeout never rearms state.
        def expired(_signum, _frame):
            raise Refusal('helper_timeout', outcome='unknown', phase='operation')
        signal.signal(signal.SIGALRM, expired); signal.alarm(1)
        config = load_configuration(args[0], args[1])
        # Accepted rootconfig binds code bytes, never host allocation or authority.
        verify_configured_release(config)
        if args[2] == 'configuration':
            result = {'bytes': canonical(config).decode('ascii')}
        elif args[2] == 'initialize-clock':
            result = initialize_clock(config)
        elif args[2] == 'clock':
            result = read_clock(config)
        elif args[2] == 'context':
            result = read_context(config)
        elif args[2] == 'challenge':
            result = {'bytes': read_challenge(config)}
        elif args[2] in ('self-test-receipt', 'ready'):
            result = write_runtime_record(config, args[1], args[2])
        elif args[2] == 'initialize-journal':
            result = initialize_journal(config)
        elif args[2] == 'collect_cgroup_envelope_v1':
            result = collect_cgroup_envelope_v1(config)
        elif args[2] == 'collect_cgroup_kernel_charges_v1':
            result = collect_cgroup_kernel_charges_v1(config)
        else:
            data = sys.stdin.buffer.read(262145)
            require(len(data) <= 262144, 'publication_input_bound')
            result = publish_admission(config, decode_json(data))
        sys.stdout.buffer.write(canonical({'status': 'ok', 'result': result})+b'\n')
        return 0
    except Refusal as error:
        sys.stdout.buffer.write(canonical({'status': error.outcome, 'reason': error.code, 'phase': error.phase})+b'\n')
        return 2
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        # Runtime diagnosis retains the exception as a cause in library calls;
        # the narrow CLI never emits source paths, raw records or error values.
        sys.stdout.buffer.write(canonical({'status': 'unknown', 'reason': 'helper_io_unresolved'})+b'\n')
        return 2
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())
