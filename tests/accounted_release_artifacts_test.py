import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest


HELPER_PATH = Path(__file__).resolve().parents[1] / 'scripts/lib/accounted_host_io.py'
SPEC = importlib.util.spec_from_file_location("accounted_host_io_release_tests", HELPER_PATH)
accounted_host_io = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = accounted_host_io
SPEC.loader.exec_module(accounted_host_io)


OWNER_UID = os.geteuid()
SOURCE_A = "a" * 40
SOURCE_B = "b" * 40
ENTRY_A = b"export const issuer = 'a';\n"
ENTRY_B = b"export const issuer = 'b';\n"
HELPER_A = b"# accounted host io A\n"
HELPER_B = b"# accounted host io B\n"


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.scratch = Path(tempfile.mkdtemp(prefix="release-")).resolve()
        self.release_root = self.scratch / "releases"
        self.release_root.mkdir(mode=0o700)

    def tearDown(self):
        if self.scratch.exists():
            for root, dirs, files in os.walk(self.scratch, topdown=False, followlinks=False):
                for name in files:
                    path = Path(root) / name
                    if not path.is_symlink():
                        os.chmod(path, 0o600)
                for name in dirs:
                    path = Path(root) / name
                    if not path.is_symlink():
                        os.chmod(path, 0o700)
            os.chmod(self.scratch, 0o700)
            shutil.rmtree(self.scratch)

    @staticmethod
    def make_mutable(release):
        os.chmod(release, 0o700)

    @staticmethod
    def make_readonly(release):
        os.chmod(release, 0o555)

    def install(self, *, source_revision=SOURCE_A, entry=ENTRY_A, helper=HELPER_A, manifest=None):
        if manifest is None:
            manifest = accounted_host_io.build_release_manifest(source_revision, entry, helper)
        digest = hashlib.sha256(accounted_host_io.RELEASE_DOMAIN + manifest).hexdigest()
        release = self.release_root / digest
        release.mkdir(mode=0o700)
        files = {
            "issuer-release.json": manifest,
            "accounted-host-issuer.mjs": entry,
            "accounted-host-io.py": helper,
        }
        for name, value in files.items():
            path = release / name
            path.write_bytes(value)
            os.chmod(path, 0o444)
        os.chmod(release, 0o555)
        return digest, release

    def snapshot(self, digest):
        release = self.release_root / digest
        result = {}
        for path in sorted(release.iterdir()):
            st = path.lstat()
            result[path.name] = (
                path.read_bytes() if stat.S_ISREG(st.st_mode) else None,
                stat.S_IMODE(st.st_mode),
                st.st_ino,
                st.st_nlink,
                stat.S_IFMT(st.st_mode),
            )
        directory = release.stat()
        result["."] = (stat.S_IMODE(directory.st_mode), directory.st_ino)
        return result

    def assert_refusal(self, function, *args, **kwargs):
        with self.assertRaises(accounted_host_io.Refusal):
            function(*args, **kwargs)


class ManifestTests(ReleaseFixture):
    def test_manifest_build_is_deterministic_and_digest_is_domain_bound(self):
        first = accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A)
        second = accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A)
        self.assertEqual(first, second)
        digest = accounted_host_io.release_manifest_digest(first)
        self.assertEqual(
            digest,
            hashlib.sha256(accounted_host_io.RELEASE_DOMAIN + first).hexdigest(),
        )
        self.assertNotEqual(
            digest,
            accounted_host_io.release_manifest_digest(
                accounted_host_io.build_release_manifest(SOURCE_B, ENTRY_A, HELPER_A)
            ),
        )
        self.assertNotIn(b"\n", first)

    def test_manifest_declares_exact_members_and_positive_bounded_sizes(self):
        raw = accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A)
        value = accounted_host_io.parse_release_manifest(raw)
        self.assertEqual(set(value["files"]), {"accounted-host-issuer.mjs", "accounted-host-io.py"})
        self.assertEqual(value["files"]["accounted-host-issuer.mjs"]["size"], len(ENTRY_A))
        self.assertGreater(value["files"]["accounted-host-io.py"]["size"], 0)

    def test_manifest_parser_rejects_lf_duplicate_and_wrong_identity(self):
        raw = accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A)
        for candidate in (
            raw + b"\n",
            b'{"version":1,"version":1}',
            raw.replace(b"Magnus-Gille/gille-inference", b"other/repository"),
        ):
            self.assert_refusal(accounted_host_io.parse_release_manifest, candidate)

    def test_manifest_parser_rejects_zero_size_and_extra_file_entries(self):
        value = json.loads(accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A))
        value["files"]["accounted-host-io.py"]["size"] = 0
        zero_size = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")
        self.assert_refusal(accounted_host_io.parse_release_manifest, zero_size)
        value = json.loads(accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A))
        value["files"]["unexpected"] = {"sha256": "0" * 64, "size": 1}
        extra_file = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("ascii")
        self.assert_refusal(accounted_host_io.parse_release_manifest, extra_file)

    def test_manifest_builder_rejects_bad_revision_and_empty_or_oversize_payload(self):
        self.assert_refusal(accounted_host_io.build_release_manifest, "not-a-revision", ENTRY_A, HELPER_A)
        self.assert_refusal(accounted_host_io.build_release_manifest, SOURCE_A, b"", HELPER_A)
        self.assert_refusal(
            accounted_host_io.build_release_manifest,
            SOURCE_A,
            b"x" * (accounted_host_io.RELEASE_FILE_MAXIMUM + 1),
            HELPER_A,
        )


class PhysicalVerificationTests(ReleaseFixture):
    def test_valid_release_returns_readonly_receipt_and_declared_claim(self):
        digest, release = self.install()
        self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o555)
        self.assertEqual(release.stat().st_uid, OWNER_UID)
        for name in ("issuer-release.json", "accounted-host-issuer.mjs", "accounted-host-io.py"):
            self.assertEqual(stat.S_IMODE((release / name).stat().st_mode), 0o444)
            self.assertEqual((release / name).stat().st_uid, OWNER_UID)
        receipt = accounted_host_io.verify_release_artifacts(
            digest,
            expected_source_revision=SOURCE_A,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )
        self.assertEqual(receipt["status"], "artifact_bytes_verified")
        self.assertEqual(receipt["manifestDigest"], digest)
        self.assertEqual(receipt["declaredSourceRevision"], SOURCE_A)
        self.assertFalse(receipt["compilationProvenanceVerified"])
        self.assertFalse(receipt["executionAuthorized"])

    def test_expected_revision_mismatch_refuses(self):
        digest, _ = self.install()
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            expected_source_revision=SOURCE_B,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_manifest_digest_mismatch_refuses(self):
        digest, _ = self.install()
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            "0" * 64,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_release_root_and_owner_arguments_are_constrained(self):
        digest, _ = self.install()
        for root in ("relative/releases", str(self.release_root) + "/"):
            self.assert_refusal(
                accounted_host_io.verify_release_artifacts,
                digest,
                release_root=root,
                owner_uid=OWNER_UID,
            )
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID + 1,
        )

    def test_tampered_bytes_refuse_without_mutating_release(self):
        digest, release = self.install()
        before = self.snapshot(digest)
        target = release / "accounted-host-issuer.mjs"
        self.make_mutable(release)
        os.chmod(target, 0o644)
        target.write_bytes(b"export const issuer = 'tampered';\n")
        os.chmod(target, 0o444)
        self.make_readonly(release)
        tampered = self.snapshot(digest)
        self.assertNotEqual(before["accounted-host-issuer.mjs"][0], tampered["accounted-host-issuer.mjs"][0])
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )
        self.assertEqual(self.snapshot(digest), tampered)

    def test_replaced_file_with_changed_bytes_refuses(self):
        digest, release = self.install()
        self.make_mutable(release)
        target = release / "accounted-host-io.py"
        replacement = release / ".replacement"
        replacement.write_bytes(b"# replacement bytes\n")
        os.chmod(replacement, 0o444)
        target.unlink()
        os.rename(replacement, target)
        self.make_readonly(release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_missing_manifest_refuses(self):
        digest, release = self.install()
        self.make_mutable(release)
        (release / "issuer-release.json").unlink()
        self.make_readonly(release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_manifest_size_tamper_refuses_even_when_file_hash_matches(self):
        manifest = json.loads(accounted_host_io.build_release_manifest(SOURCE_A, ENTRY_A, HELPER_A))
        manifest["files"]["accounted-host-issuer.mjs"]["size"] += 1
        raw = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("ascii")
        digest, _ = self.install(manifest=raw)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_wrong_file_mode_refuses(self):
        digest, release = self.install()
        os.chmod(release / "accounted-host-io.py", 0o400)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_hardlink_and_symlink_refuse(self):
        digest, release = self.install()
        target = release / "accounted-host-io.py"
        self.make_mutable(release)
        target.unlink()
        os.link(release / "accounted-host-issuer.mjs", target)
        os.chmod(target, 0o444)
        self.make_readonly(release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

        digest, release = self.install(source_revision=SOURCE_B, entry=ENTRY_B, helper=HELPER_B)
        target = release / "accounted-host-io.py"
        self.make_mutable(release)
        target.unlink()
        os.symlink("accounted-host-issuer.mjs", target)
        self.make_readonly(release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_extra_missing_and_replaced_members_refuse(self):
        digest, release = self.install()
        self.make_mutable(release)
        extra = release / "unexpected"
        extra.write_bytes(b"extra")
        os.chmod(extra, 0o444)
        self.make_readonly(release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

        digest, release = self.install(source_revision=SOURCE_B, entry=ENTRY_B, helper=HELPER_B)
        self.make_mutable(release)
        (release / "accounted-host-io.py").unlink()
        self.make_readonly(release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

    def test_wrong_release_directory_mode_and_symlinked_directory_refuse(self):
        digest, release = self.install()
        os.chmod(release, 0o755)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )

        digest, release = self.install(source_revision=SOURCE_B, entry=ENTRY_B, helper=HELPER_B)
        moved = release.with_name(release.name + "-real")
        os.rename(release, moved)
        os.symlink(moved.name, release)
        self.assert_refusal(
            accounted_host_io.verify_release_artifacts,
            digest,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )


class RecoveryVerificationTests(ReleaseFixture):
    def install_pair(self):
        candidate_digest, _ = self.install(source_revision=SOURCE_A, entry=ENTRY_A, helper=HELPER_A)
        recovery_digest, _ = self.install(source_revision=SOURCE_B, entry=ENTRY_B, helper=HELPER_B)
        candidate = {"manifestDigest": candidate_digest, "sourceRevision": SOURCE_A}
        recovery = {"manifestDigest": recovery_digest, "sourceRevision": SOURCE_B}
        return candidate, recovery

    def test_recovery_verifies_both_physical_artifacts_without_authorizing_actions(self):
        candidate, recovery = self.install_pair()
        before = {digest: self.snapshot(digest) for digest in (candidate["manifestDigest"], recovery["manifestDigest"])}
        result = accounted_host_io.verify_recovery_artifacts(
            candidate,
            recovery,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )
        self.assertEqual(result["status"], "recovery_artifact_bytes_verified")
        self.assertEqual(result["candidate"]["status"], "artifact_bytes_verified")
        self.assertEqual(result["recovery"]["status"], "artifact_bytes_verified")
        self.assertFalse(result["rollbackPerformed"])
        self.assertFalse(result["activationAuthorized"])
        self.assertFalse(result["configurationRecoveryVerified"])
        self.assertFalse(result["nativeRestorationVerified"])
        after = {digest: self.snapshot(digest) for digest in (candidate["manifestDigest"], recovery["manifestDigest"])}
        self.assertEqual(before, after)

    def test_recovery_refuses_identical_or_malformed_bindings(self):
        candidate, recovery = self.install_pair()
        identical = dict(candidate)
        self.assert_refusal(
            accounted_host_io.verify_recovery_artifacts,
            candidate,
            identical,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )
        for malformed in (
            {"manifestDigest": candidate["manifestDigest"]},
            {**candidate, "unexpected": True},
            {"manifestDigest": "z" * 64, "sourceRevision": SOURCE_A},
            {"manifestDigest": candidate["manifestDigest"], "sourceRevision": "z" * 40},
        ):
            self.assert_refusal(
                accounted_host_io.verify_recovery_artifacts,
                malformed,
                recovery,
                release_root=str(self.release_root),
                owner_uid=OWNER_UID,
            )

    def test_recovery_refuses_wrong_revision_and_missing_release(self):
        candidate, recovery = self.install_pair()
        wrong_revision = dict(candidate, sourceRevision=SOURCE_B)
        self.assert_refusal(
            accounted_host_io.verify_recovery_artifacts,
            wrong_revision,
            recovery,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )
        missing = dict(recovery, manifestDigest="f" * 64)
        self.assert_refusal(
            accounted_host_io.verify_recovery_artifacts,
            candidate,
            missing,
            release_root=str(self.release_root),
            owner_uid=OWNER_UID,
        )


if __name__ == "__main__":
    unittest.main()
