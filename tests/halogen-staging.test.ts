import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pythonContract = String.raw`
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

SCRIPT_PATH, MANIFEST_PATH = map(Path, __import__("sys").argv[1:3])
spec = importlib.util.spec_from_file_location("stage_halogen_under_test", SCRIPT_PATH)
stage_halogen = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(stage_halogen)
BASE_MANIFEST = json.loads(MANIFEST_PATH.read_text())


def tiny_manifest():
    manifest = copy.deepcopy(BASE_MANIFEST)
    for index, item in enumerate(manifest["files"]):
        content = ("fixture-%d-%s" % (index, item["path"])).encode()
        item["bytes"] = len(content)
        item["sha256"] = hashlib.sha256(content).hexdigest()
    return manifest


def content_for(item):
    index = next(i for i, candidate in enumerate(BASE_MANIFEST["files"])
                 if candidate["path"] == item["path"])
    return ("fixture-%d-%s" % (index, item["path"])).encode()


def first_item(manifest):
    return manifest["files"][0]


def disk_space():
    return SimpleNamespace(free=20 * 1024**3)


class Response:
    def __init__(self, content=b"", status=200, headers=None):
        self.content = content
        self.status = status
        self.headers = headers or {}
        self.reads = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, _size):
        if self.reads:
            return b""
        self.reads += 1
        return self.content


class StagingContract(unittest.TestCase):
    def test_plan_is_read_only_and_never_networks(self):
        manifest = tiny_manifest()
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            with mock.patch.object(stage_halogen.urllib.request, "urlopen",
                                   side_effect=AssertionError("plan performed network I/O")) as urlopen:
                receipt = stage_halogen.stage(manifest, parent)
            self.assertEqual(receipt, {
                "mode": "plan",
                "revision": manifest["revision"],
                "files": len(manifest["files"]),
                "bytes": sum(item["bytes"] for item in manifest["files"]),
                "image": manifest["image"],
            })
            self.assertEqual(list(parent.iterdir()), [])
            urlopen.assert_not_called()

    def test_verify_is_read_only_and_rejects_missing_or_corrupt(self):
        manifest = tiny_manifest()

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            before = sorted(parent.rglob("*"))
            with mock.patch.object(stage_halogen.urllib.request, "urlopen",
                                   side_effect=AssertionError("verify performed network I/O")) as urlopen:
                with self.assertRaisesRegex(ValueError, "artifact verification failed"):
                    stage_halogen.stage(manifest, parent, verify=True)
            self.assertEqual(sorted(parent.rglob("*")), before)
            urlopen.assert_not_called()

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            root.mkdir(mode=0o700)
            for index, item in enumerate(manifest["files"]):
                output = root / item["path"]
                output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                output.write_bytes(b"corrupt" if index == 0 else content_for(item))
            before = [(path.relative_to(root), path.read_bytes()) for path in root.rglob("*") if path.is_file()]
            with mock.patch.object(stage_halogen.urllib.request, "urlopen",
                                   side_effect=AssertionError("verify performed network I/O")) as urlopen:
                with self.assertRaisesRegex(ValueError, "artifact verification failed"):
                    stage_halogen.stage(manifest, parent, verify=True)
            after = [(path.relative_to(root), path.read_bytes()) for path in root.rglob("*") if path.is_file()]
            self.assertEqual(after, before)
            urlopen.assert_not_called()

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            for item in manifest["files"]:
                output = root / item["path"]
                output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                output.write_bytes(content_for(item))
            before = [(path.relative_to(root), path.read_bytes()) for path in root.rglob("*") if path.is_file()]
            with mock.patch.object(stage_halogen.urllib.request, "urlopen",
                                   side_effect=AssertionError("verify performed network I/O")) as urlopen:
                receipt = stage_halogen.stage(manifest, parent, verify=True)
            after = [(path.relative_to(root), path.read_bytes()) for path in root.rglob("*") if path.is_file()]
            self.assertEqual(receipt["mode"], "verified")
            self.assertEqual(after, before)
            urlopen.assert_not_called()
    def test_manifest_rejects_traversal_missing_overlay_and_duplicates(self):
        manifest = tiny_manifest()
        invalid = []

        traversal = copy.deepcopy(manifest)
        traversal["files"][0]["path"] = "../escape.hgn"
        invalid.append(traversal)

        missing_overlay = copy.deepcopy(manifest)
        missing_overlay["files"] = [item for item in missing_overlay["files"]
                                     if not item["path"].endswith(".overlay.hgn")]
        invalid.append(missing_overlay)

        duplicate = copy.deepcopy(manifest)
        duplicate["files"][-1]["path"] = duplicate["files"][-2]["path"]
        invalid.append(duplicate)

        for candidate in invalid:
            with self.subTest(files=[item["path"] for item in candidate["files"]]):
                with self.assertRaises(ValueError):
                    stage_halogen.validate(candidate)

    def test_resume_requires_exact_range_response(self):
        manifest = tiny_manifest()
        item = first_item(manifest)
        payload = content_for(item)
        for status, headers in ((200, {}), (206, {"Content-Range": "bytes 1-9/*"})):
            with self.subTest(status=status, headers=headers), tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
                parent = Path(directory)
                root = parent / manifest["revision"]
                root.mkdir(mode=0o700)
                target = root / item["path"]
                partial = target.with_name(target.name + ".part")
                partial.write_bytes(payload[:2])
                seen = []

                def urlopen(request, timeout):
                    seen.append((request, timeout))
                    return Response(payload[2:], status=status, headers=headers)

                with mock.patch.object(stage_halogen.shutil, "disk_usage", return_value=disk_space()), \
                     mock.patch.object(stage_halogen.urllib.request, "urlopen", side_effect=urlopen):
                    with self.assertRaisesRegex(ValueError, "exact resume range"):
                        stage_halogen.stage(manifest, parent, download=True)
                self.assertEqual(seen[0][0].get_header("Range"), "bytes=2-")
                self.assertEqual(partial.read_bytes(), payload[:2])
                self.assertFalse(target.exists())

    def test_mismatching_final_and_partial_are_never_certified(self):
        manifest = tiny_manifest()
        item = first_item(manifest)

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            root.mkdir(mode=0o700)
            target = root / item["path"]
            target.write_bytes(b"wrong final")
            with mock.patch.object(stage_halogen.shutil, "disk_usage", return_value=disk_space()), \
                 mock.patch.object(stage_halogen.urllib.request, "urlopen") as urlopen:
                with self.assertRaisesRegex(ValueError, "existing final artifact mismatch"):
                    stage_halogen.stage(manifest, parent, download=True)
            urlopen.assert_not_called()
            self.assertEqual(target.read_bytes(), b"wrong final")

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            root.mkdir(mode=0o700)
            target = root / item["path"]
            partial = target.with_name(target.name + ".part")
            response = Response(b"wrong partial")
            with mock.patch.object(stage_halogen.shutil, "disk_usage", return_value=disk_space()), \
                 mock.patch.object(stage_halogen.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(ValueError, "download hash/size mismatch"):
                    stage_halogen.stage(manifest, parent, download=True)
            self.assertTrue(partial.is_file())
            self.assertFalse(target.exists())

    def test_complete_partial_is_promoted_without_redownload(self):
        manifest = tiny_manifest()
        item = first_item(manifest)
        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            root.mkdir(mode=0o700)
            target = root / item["path"]
            partial = target.with_name(target.name + ".part")
            partial.write_bytes(content_for(item))
            for other in manifest["files"][1:]:
                output = root / other["path"]
                output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                output.write_bytes(content_for(other))

            with mock.patch.object(stage_halogen.shutil, "disk_usage", return_value=disk_space()), \
                 mock.patch.object(stage_halogen.urllib.request, "urlopen", side_effect=AssertionError("complete partial was redownloaded")) as urlopen:
                receipt = stage_halogen.stage(manifest, parent, download=True)
            self.assertEqual(receipt["mode"], "verified")
            self.assertTrue(target.is_file())
            self.assertFalse(partial.exists())
            urlopen.assert_not_called()

    def test_symlink_staging_directory_and_artifact_are_rejected(self):
        manifest = tiny_manifest()
        item = first_item(manifest)

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            outside = parent / "outside"
            outside.mkdir(mode=0o700)
            os.symlink(outside, parent / manifest["revision"])
            with self.assertRaisesRegex(ValueError, "symlink in staging directory"):
                stage_halogen.stage(manifest, parent, download=True)

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            root.mkdir(mode=0o700)
            outside = parent / "outside.hgn"
            outside.write_bytes(content_for(item))
            os.symlink(outside, root / item["path"])
            with mock.patch.object(stage_halogen.shutil, "disk_usage", return_value=disk_space()):
                with self.assertRaisesRegex(ValueError, "existing final artifact mismatch"):
                    stage_halogen.stage(manifest, parent, download=True)
            self.assertTrue((root / item["path"]).is_symlink())

    def test_lock_prevents_concurrent_staging(self):
        manifest = tiny_manifest()
        item = first_item(manifest)
        payload = content_for(item)

        with tempfile.TemporaryDirectory(dir="/private/tmp") as directory:
            parent = Path(directory)
            root = parent / manifest["revision"]
            root.mkdir(mode=0o700)
            for other in manifest["files"][1:]:
                output = root / other["path"]
                output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                output.write_bytes(content_for(other))

            started = threading.Event()
            release = threading.Event()
            calls = []

            class BlockingResponse(Response):
                def read(self, _size):
                    if self.reads:
                        return b""
                    self.reads += 1
                    started.set()
                    if not release.wait(5):
                        raise AssertionError("first staging operation did not release")
                    return payload

            response = BlockingResponse()

            def urlopen(request, timeout):
                calls.append((request, timeout))
                return response

            first_errors = []

            def run_first():
                try:
                    stage_halogen.stage(manifest, parent, download=True)
                except BaseException as error:
                    first_errors.append(error)

            with mock.patch.object(stage_halogen.shutil, "disk_usage", return_value=disk_space()), \
                 mock.patch.object(stage_halogen.urllib.request, "urlopen", side_effect=urlopen):
                thread = threading.Thread(target=run_first)
                thread.start()
                self.assertTrue(started.wait(2), "first staging operation never acquired the lock")
                with self.assertRaises(BlockingIOError):
                    stage_halogen.stage(manifest, parent, download=True)
                release.set()
                thread.join(5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(first_errors, [])
            self.assertEqual(len(calls), 1)
            self.assertTrue((root / item["path"]).is_file())


if __name__ == "__main__":
    unittest.main(argv=[__import__("sys").argv[0]])
`;

describe("Halogen staging script", () => {
  it("enforces the staging contract", () => {
    const testDirectory = dirname(fileURLToPath(import.meta.url));
    const repositoryRoot = resolve(testDirectory, "..");
    const result = spawnSync("python3", ["-c", pythonContract, resolve(repositoryRoot, "scripts/stage-halogen.py"), resolve(repositoryRoot, "deploy/halogen-candidate.json")], { cwd: repositoryRoot, encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});
