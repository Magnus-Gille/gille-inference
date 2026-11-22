#!/usr/bin/env python3
"""Single source of truth for Gate D revision and holdout enumeration.

Two task sources exist:

* the committed corpus under ``gate-d/tasks/``, described by ``corpus.json`` (r1, r2), and
* an external task root (INFER-521), selected only by an explicit ``--tasks-root DIR``. It holds
  ``corpus-manifest.json`` plus one directory per task, as written by code-battle's ``gate-d-r3``
  generator. Its sealed tasks must never live in this public repository, so the runner reads them
  from outside the checkout and protects them with the manifest's content digest instead of
  ``git status``.

The external root is never picked up from the environment here, so a stray ``GATE_D_TASKS_ROOT``
cannot silently redirect ``verify-fixtures.sh`` or any other caller of the committed corpus. The
shell runners translate that variable into ``--tasks-root`` themselves.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "corpus.json"


def load_manifest() -> dict[str, Any]:
    with MANIFEST.open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("schemaVersion") != 1:
        raise ValueError("unsupported Gate D corpus schema")
    return manifest


def include_holdout_from_env() -> bool:
    value = os.environ.get("GATE_D_INCLUDE_HOLDOUT", "0")
    if value not in ("", "0", "1"):
        raise ValueError("GATE_D_INCLUDE_HOLDOUT must be 0 or 1")
    return value == "1"


def active_revision(manifest: dict[str, Any], include_holdout: bool) -> str:
    key = "holdoutRevision" if include_holdout else "defaultRevision"
    revision = manifest.get(key)
    if not isinstance(revision, str) or revision not in manifest.get("revisions", {}):
        raise ValueError(f"invalid {key} in Gate D corpus manifest")
    return revision


def revision_contract(manifest: dict[str, Any], revision: str) -> dict[str, Any]:
    contract = manifest.get("revisions", {}).get(revision)
    if not isinstance(contract, dict):
        raise ValueError(f"unknown Gate D corpus revision: {revision}")
    tasks = contract.get("tasks")
    acceptance = contract.get("acceptance")
    if not isinstance(tasks, list) or not all(isinstance(task, str) for task in tasks):
        raise ValueError(f"revision {revision} has invalid tasks")
    if not isinstance(acceptance, dict) or acceptance.get("denominator") != len(tasks):
        raise ValueError(f"revision {revision} acceptance denominator must equal task count")
    return contract


def task_metadata(task_id: str) -> dict[str, Any]:
    path = ROOT / "tasks" / task_id / "meta.json"
    if not path.is_file():
        raise ValueError(f"unknown Gate D task: {task_id}")
    with path.open(encoding="utf-8") as handle:
        meta = json.load(handle)
    return {
        "taskRevision": meta.get("corpusRevision", "gate-d-r1"),
        "holdout": meta.get("holdout", False) is True,
    }


# ── External task root (INFER-521) ─────────────────────────────────────────────────────────────

EXTERNAL_MANIFEST = "corpus-manifest.json"
TASK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
DIGEST = re.compile(r"[0-9a-f]{64}")
# Fields copied from a verified task's meta.json into every result row, so analysis needs no join.
IDENTITY_STRINGS = ("family", "split")


class ExternalCorpusError(ValueError):
    """The external task root or one of its tasks is unusable; the runner must not run it."""


def _same_or_inside(path: Path, root: Path) -> bool:
    """True when ``path`` is ``root`` or lies below it, compared by directory identity.

    Identities (device, inode), not spellings: on a case-insensitive volume a differently
    capitalized path can name a directory inside the checkout. Missing tails are skipped by
    walking up to the nearest existing ancestor.
    """
    target = os.stat(root)
    current = os.path.abspath(path)
    while not os.path.exists(current):
        current = os.path.dirname(current)
    while True:
        st = os.stat(current)
        if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
            return True
        parent = os.path.dirname(current)
        if parent == current:
            return False
        current = parent


def tree_digest(task_dir: Path) -> str:
    """Content digest of a task directory, identical to code-battle's ``core.tree_digest``.

    sha256 over ``relpath \0 sha256(file) \n`` for every file, in pathlib order (component-wise,
    which differs from plain string order when a name contains a character below ``/``).
    Symlinks, sockets, FIFOs and devices are refused rather than followed or skipped: the generator
    never writes them, and following one would let the digest vouch for bytes outside the task.
    """
    entries: list[tuple[tuple[str, ...], str, Path]] = []
    for dirpath, dirnames, filenames in os.walk(task_dir, followlinks=False):
        for name in list(dirnames):
            full = Path(dirpath) / name
            if full.is_symlink():
                raise ExternalCorpusError(f"{full} is a symlink; external tasks must contain regular files only")
        for name in filenames:
            full = Path(dirpath) / name
            mode = os.lstat(full).st_mode
            if stat.S_ISLNK(mode):
                raise ExternalCorpusError(f"{full} is a symlink; external tasks must contain regular files only")
            if not stat.S_ISREG(mode):
                raise ExternalCorpusError(f"{full} is not a regular file; external tasks must contain regular files only")
            rel = full.relative_to(task_dir).as_posix()
            entries.append((tuple(rel.split("/")), rel, full))
    entries.sort(key=lambda entry: entry[0])
    digest = hashlib.sha256()
    for _parts, rel, full in entries:
        digest.update(rel.encode() + b"\0" + hashlib.sha256(full.read_bytes()).hexdigest().encode() + b"\n")
    return digest.hexdigest()


def external_root(raw: str, repo_root: Path = ROOT.parent) -> Path:
    """Resolve and vet an external task root: absolute, physical, a directory, outside the checkout."""
    if not raw:
        raise ExternalCorpusError("the external task root is empty")
    root = Path(os.path.realpath(raw))
    if not root.is_dir():
        raise ExternalCorpusError(f"external task root {root} is not a directory")
    if _same_or_inside(root, repo_root) or _same_or_inside(repo_root, root):
        # Inside: sealed tasks would sit in a public checkout. Containing: the root would include
        # this checkout, its own committed tasks and every work dir path a harness can reach.
        raise ExternalCorpusError(
            f"external task root {root} overlaps this checkout ({repo_root}); keep sealed tasks outside the repository")
    return root


def load_external_manifest(root: Path) -> dict[str, Any]:
    path = root / EXTERNAL_MANIFEST
    if not path.is_file() or path.is_symlink():
        raise ExternalCorpusError(f"{path} is missing or not a regular file")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExternalCorpusError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(manifest, dict):
        raise ExternalCorpusError(f"{path} must hold a JSON object")
    revision = manifest.get("corpusRevision")
    if not isinstance(revision, str) or not TASK_ID.fullmatch(revision):
        raise ExternalCorpusError(f"{path} has no valid corpusRevision")
    if revision in load_manifest().get("revisions", {}):
        # r3 rows must never pool with r1/r2 rows, which resume and summaries key on.
        raise ExternalCorpusError(f"external corpusRevision {revision} collides with a committed Gate D revision")
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ExternalCorpusError(f"{path} lists no tasks")
    seen: set[str] = set()
    for entry in tasks:
        if not isinstance(entry, dict):
            raise ExternalCorpusError(f"{path} has a malformed task entry")
        task_id, digest = entry.get("id"), entry.get("digest")
        if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id) or task_id in seen:
            raise ExternalCorpusError(f"{path} has an invalid or duplicate task id: {task_id!r}")
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise ExternalCorpusError(f"{path} has an invalid digest for {task_id}")
        seen.add(task_id)
    if manifest.get("count", len(tasks)) != len(tasks):
        raise ExternalCorpusError(f"{path} count does not match its task list")
    return manifest


def _read_meta(task_dir: Path) -> dict[str, Any]:
    path = task_dir / "meta.json"
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExternalCorpusError(f"cannot read {path}: {error}") from error
    if not isinstance(meta, dict):
        raise ExternalCorpusError(f"{path} must hold a JSON object")
    return meta


def _is_holdout(manifest: dict[str, Any], meta: dict[str, Any]) -> bool:
    # Either signal seals a task: a sealed manifest whose generator forgot the flag must still
    # need the opt-in, and so must a flagged task listed in a non-sealed manifest.
    return meta.get("holdout") is True or manifest.get("split") == "sealed"


def external_tasks(root: Path, manifest: dict[str, Any], include_holdout: bool) -> list[str]:
    """Runnable task ids in manifest order; sealed tasks only with the holdout opt-in.

    Holdout status is read from the unverified meta.json here, for enumeration only; the runner
    re-derives it from the digest-verified copy before it runs a task.
    """
    selected = []
    for entry in manifest["tasks"]:
        meta = _read_meta(root / entry["id"])
        if include_holdout or not _is_holdout(manifest, meta):
            selected.append(entry["id"])
    return selected


def verify_external_task(root: Path, manifest: dict[str, Any], task_id: str,
                         include_holdout: bool) -> dict[str, Any]:
    """Digest-check one task and return its row identity; raise if it must not run."""
    entry = next((t for t in manifest["tasks"] if t["id"] == task_id), None)
    if entry is None:
        raise ExternalCorpusError(f"unknown Gate D task '{task_id}' in {root / EXTERNAL_MANIFEST}")
    task_dir = root / task_id
    if task_dir.is_symlink() or not task_dir.is_dir():
        raise ExternalCorpusError(f"{task_dir} is missing or not a plain directory")
    actual = tree_digest(task_dir)
    if actual != entry["digest"]:
        raise ExternalCorpusError(
            f"task {task_id} content digest {actual} does not match the manifest ({entry['digest']})")
    meta = _read_meta(task_dir)
    if meta.get("corpusRevision") != manifest["corpusRevision"]:
        raise ExternalCorpusError(
            f"task {task_id} meta.json corpusRevision {meta.get('corpusRevision')!r} "
            f"differs from the manifest's {manifest['corpusRevision']!r}")
    holdout = _is_holdout(manifest, meta)
    if holdout and not include_holdout:
        raise ExternalCorpusError(f"task {task_id} is sealed (holdout); it requires GATE_D_INCLUDE_HOLDOUT=1")
    identity: dict[str, Any] = {
        "corpusRevision": manifest["corpusRevision"],
        "taskRevision": entry["digest"],
        "holdout": holdout,
    }
    for key in IDENTITY_STRINGS:
        value = meta.get(key)
        identity[key] = value if isinstance(value, str) else None
    trap = meta.get("trap")
    identity["trap"] = trap if isinstance(trap, bool) else None
    return identity


def manifest_sha256(root: Path) -> str:
    return "sha256:" + hashlib.sha256((root / EXTERNAL_MANIFEST).read_bytes()).hexdigest()


def external_main(args: argparse.Namespace, parser: argparse.ArgumentParser) -> int:
    include = args.include_holdout or include_holdout_from_env()
    root = external_root(args.tasks_root)
    manifest = load_external_manifest(root)
    if args.command == "root":
        print(root)
    elif args.command == "revision":
        print(manifest["corpusRevision"])
    elif args.command == "manifest-sha256":
        print(manifest_sha256(root))
    elif args.command in ("tasks", "describe"):
        tasks = external_tasks(root, manifest, include)
        if not tasks:
            raise ExternalCorpusError(
                f"{root} has no runnable tasks; sealed tasks require GATE_D_INCLUDE_HOLDOUT=1")
        if args.command == "tasks":
            print("\n".join(tasks))
        else:
            print(json.dumps({
                "corpusRevision": manifest["corpusRevision"],
                "includeHoldout": include,
                "tasksRoot": str(root),
                "manifestSha256": manifest_sha256(root),
                "split": manifest.get("split"),
                "tasks": tasks,
                "taskRevisions": {t["id"]: t["digest"] for t in manifest["tasks"] if t["id"] in tasks},
            }, sort_keys=True))
    elif args.command == "contains":
        if args.task_id is None:
            parser.error("contains requires task_id")
        if args.task_id not in [t["id"] for t in manifest["tasks"]]:
            print(f"error: unknown Gate D task '{args.task_id}' in {root / EXTERNAL_MANIFEST}", file=sys.stderr)
            return 1
        if args.task_id not in external_tasks(root, manifest, include):
            print(f"error: task '{args.task_id}' is sealed; holdouts require GATE_D_INCLUDE_HOLDOUT=1", file=sys.stderr)
            return 1
    elif args.command in ("verify-task", "task-metadata"):
        if args.task_id is None:
            parser.error(f"{args.command} requires task_id")
        print(json.dumps(verify_external_task(root, manifest, args.task_id, include), sort_keys=True))
    else:
        parser.error(f"{args.command} is not available for an external task root")
    return 0


def describe(include_holdout: bool) -> dict[str, Any]:
    manifest = load_manifest()
    revision = active_revision(manifest, include_holdout)
    contract = revision_contract(manifest, revision)
    return {
        "corpusRevision": revision,
        "includeHoldout": include_holdout,
        "tasks": contract["tasks"],
        "holdoutTasks": contract.get("holdoutTasks", []),
        "acceptance": contract["acceptance"],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("describe", "revision", "tasks", "contains", "task-metadata",
                                            "verify-task", "root", "manifest-sha256"))
    parser.add_argument("task_id", nargs="?")
    parser.add_argument("--include-holdout", action="store_true")
    parser.add_argument("--revision")
    parser.add_argument("--tasks-root", help="external task root with corpus-manifest.json (INFER-521)")
    args = parser.parse_args()
    if args.tasks_root is not None:
        if args.revision is not None:
            parser.error("--revision selects a committed revision and cannot be combined with --tasks-root")
        try:
            return external_main(args, parser)
        except (ValueError, OSError) as error:
            parser.exit(2, f"error: {error}\n")
    if args.command in ("verify-task", "root", "manifest-sha256"):
        parser.error(f"{args.command} requires --tasks-root")
    try:
        manifest = load_manifest()
        include = args.include_holdout or include_holdout_from_env()
        revision = args.revision or active_revision(manifest, include)
        contract = revision_contract(manifest, revision)
        if args.command == "describe":
            print(json.dumps({
                "corpusRevision": revision,
                "includeHoldout": include,
                "tasks": contract["tasks"],
                "holdoutTasks": contract.get("holdoutTasks", []),
                "acceptance": contract["acceptance"],
            }, sort_keys=True))
        elif args.command == "revision":
            print(revision)
        elif args.command == "tasks":
            print("\n".join(contract["tasks"]))
        elif args.command == "contains":
            if args.task_id is None:
                parser.error("contains requires task_id")
            return 0 if args.task_id in contract["tasks"] else 1
        else:
            if args.task_id is None:
                parser.error("task-metadata requires task_id")
            print(json.dumps(task_metadata(args.task_id), sort_keys=True))
    except ValueError as error:
        parser.exit(2, f"error: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
