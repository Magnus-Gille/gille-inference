#!/usr/bin/env python3
"""Single source of truth for Gate D revision and holdout enumeration.

By default the corpus is the in-repo one (``corpus.json`` + ``tasks/``). Setting
``GATE_D_TASKS_ROOT=<dir>`` selects an external corpus instead (INFER-521): the directory holds one
sub-directory per task plus a ``corpus-manifest.json`` written by its generator (for example
code-battle's gate-d-r3). Every task directory's content digest must equal the manifest's, the root
must live outside this checkout, and sealed (``holdout: true``) tasks need GATE_D_INCLUDE_HOLDOUT=1.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent
MANIFEST = ROOT / "corpus.json"
EXTERNAL_MANIFEST = "corpus-manifest.json"
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")


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


# ── External corpus (INFER-521) ──────────────────────────────────────────────────────────────

def same_or_inside(path: str, root: str) -> bool:
    """True if ``path`` (or its nearest existing ancestor) is ``root`` or lies under it.

    Compares directory identities, not spellings, so a case alias on a case-insensitive volume or a
    symlinked spelling cannot slip past (the run.sh #172 rule).
    """
    target = os.stat(root)
    p = os.path.realpath(path)
    while not os.path.exists(p):
        p = os.path.dirname(p)
    while True:
        st = os.stat(p)
        if (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino):
            return True
        parent = os.path.dirname(p)
        if parent == p:
            return False
        p = parent


def external_root_from_env() -> Optional[Path]:
    value = os.environ.get("GATE_D_TASKS_ROOT", "")
    if value == "":
        return None
    root = os.path.realpath(value)
    if not os.path.isdir(root):
        raise ValueError(f"GATE_D_TASKS_ROOT is not a directory: {value}")
    # check.sh and older helpers interpolate task paths into Python source; refuse quoting hazards.
    if re.search(r"[\x00-\x1f'\"\\$`]", root):
        raise ValueError(f"GATE_D_TASKS_ROOT contains a quote, backslash, $, backtick or control character: {root!r}")
    if same_or_inside(root, str(REPO_ROOT)) or same_or_inside(str(REPO_ROOT), root):
        raise ValueError(
            f"GATE_D_TASKS_ROOT ({root}) overlaps this checkout ({REPO_ROOT}); an external corpus "
            "must live outside it (a sealed holdout in a public repo is not sealed)")
    return Path(root)


def tree_digest(tdir: Path) -> str:
    """sha256 over the sorted ``relpath\\0sha256(file)\\n`` entries of every file under ``tdir``.

    Byte-compatible with code-battle gate-d-r3 ``generator.core.tree_digest``. Stricter than it in
    one way: any symlink or non-regular entry raises, because the generator writes neither and a
    link would let content change without the digest seeing it.
    """
    entries = []
    for dirpath, dirnames, filenames in os.walk(tdir, followlinks=False):
        for name in dirnames + filenames:
            full = os.path.join(dirpath, name)
            mode = os.lstat(full).st_mode
            if stat.S_ISLNK(mode):
                raise ValueError(f"symlink in external task tree: {os.path.relpath(full, tdir)}")
            if name in filenames and not stat.S_ISREG(mode):
                raise ValueError(f"non-regular file in external task tree: {os.path.relpath(full, tdir)}")
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = Path(os.path.relpath(full, tdir)).as_posix()
            with open(full, "rb") as handle:
                entries.append((rel, hashlib.sha256(handle.read()).hexdigest()))
    h = hashlib.sha256()
    # Path order (component-wise), as the generator's sorted(Path) uses — not plain string order,
    # which differs when a name sorts below "/" (for example "a-b/x" against "a/x").
    for rel, digest in sorted(entries, key=lambda e: e[0].split("/")):
        h.update(rel.encode() + b"\0" + digest.encode() + b"\n")
    return h.hexdigest()


def load_external(root: Path, in_repo: dict[str, Any]) -> dict[str, Any]:
    path = root / EXTERNAL_MANIFEST
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"external corpus has no regular {EXTERNAL_MANIFEST}: {root}")
    with path.open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    if not isinstance(manifest, dict):
        raise ValueError(f"{EXTERNAL_MANIFEST} must be a JSON object")
    revision = manifest.get("corpusRevision")
    if not isinstance(revision, str) or not TASK_ID_RE.match(revision):
        raise ValueError(f"{EXTERNAL_MANIFEST} has an invalid corpusRevision")
    # Rows are scoped by corpusRevision; an external corpus reusing r1/r2 would pool with them.
    if revision in in_repo.get("revisions", {}):
        raise ValueError(f"external corpusRevision {revision} collides with an in-repo revision")
    tasks = manifest.get("tasks")
    if not isinstance(tasks, list) or not tasks:
        raise ValueError(f"{EXTERNAL_MANIFEST} lists no tasks")
    if manifest.get("count", len(tasks)) != len(tasks):
        raise ValueError(f"{EXTERNAL_MANIFEST} count does not match its task list")
    digests: dict[str, str] = {}
    order: list[str] = []
    for entry in tasks:
        task_id = entry.get("id") if isinstance(entry, dict) else None
        digest = entry.get("digest") if isinstance(entry, dict) else None
        if not isinstance(task_id, str) or not TASK_ID_RE.match(task_id):
            raise ValueError(f"{EXTERNAL_MANIFEST} has an invalid task id: {task_id!r}")
        if not isinstance(digest, str) or not DIGEST_RE.match(digest):
            raise ValueError(f"{EXTERNAL_MANIFEST} has an invalid digest for {task_id}")
        if task_id in digests:
            raise ValueError(f"{EXTERNAL_MANIFEST} lists {task_id} twice")
        digests[task_id] = digest
        order.append(task_id)
    return {"root": root, "corpusRevision": revision, "tasks": order, "digests": digests}


def external_task_dir(corpus: dict[str, Any], task_id: str) -> Path:
    if task_id not in corpus["digests"]:
        raise ValueError(f"unknown Gate D task: {task_id}")
    tdir = corpus["root"] / task_id
    if tdir.is_symlink() or not tdir.is_dir():
        raise ValueError(f"external task {task_id} is missing or is not a plain directory")
    return tdir


def external_task_metadata(corpus: dict[str, Any], task_id: str) -> dict[str, Any]:
    tdir = external_task_dir(corpus, task_id)
    meta_path = tdir / "meta.json"
    if meta_path.is_symlink() or not meta_path.is_file():
        raise ValueError(f"external task {task_id} has no meta.json")
    with meta_path.open(encoding="utf-8") as handle:
        meta = json.load(handle)
    if not isinstance(meta, dict):
        raise ValueError(f"external task {task_id} meta.json is not an object")
    if meta.get("corpusRevision") != corpus["corpusRevision"]:
        raise ValueError(f"external task {task_id} corpusRevision does not match the manifest")
    if meta.get("id", task_id) != task_id:
        raise ValueError(f"external task {task_id} meta.json names another id")
    # External tasks must state holdout explicitly, and a sealed split must say true: a metadata
    # slip must never expose a fresh holdout without the opt-in (INFER-521 review).
    holdout = meta.get("holdout")
    if not isinstance(holdout, bool):
        raise ValueError(f"external task {task_id} must set holdout to true or false")
    if meta.get("split") == "sealed" and holdout is not True:
        raise ValueError(f"external task {task_id} is in the sealed split but does not set holdout: true")

    def opt_str(key: str) -> Optional[str]:
        value = meta.get(key)
        return value if isinstance(value, str) else None

    trap = meta.get("trap")
    return {
        "corpusRevision": corpus["corpusRevision"],
        "taskRevision": corpus["digests"][task_id],
        "holdout": holdout,
        "family": opt_str("family"),
        "split": opt_str("split"),
        "trap": trap if isinstance(trap, bool) else None,
    }


def verify_external_digest(corpus: dict[str, Any], task_id: str, expected: Optional[str] = None,
                           directory: Optional[str] = None) -> None:
    """Raise unless the task directory's content digest equals ``expected`` (default: the manifest's).

    ``directory`` binds the check to the exact path a runner seeds and grades from, so repointing a
    symlinked root mid-run cannot make the check read a different tree (INFER-521 review).
    """
    want = expected if expected is not None else corpus["digests"][task_id]
    tdir = external_task_dir(corpus, task_id)
    if directory is not None:
        given = Path(directory)
        if given.is_symlink() or not given.is_dir() or os.path.basename(os.path.normpath(directory)) != task_id:
            raise ValueError(f"--dir for {task_id} is not a plain directory named after the task")
        tdir = given
    got = tree_digest(tdir)
    if got != want:
        raise ValueError(f"external task {task_id} digest {got} != manifest {want}")


def select_external(corpus: dict[str, Any], include_holdout: bool) -> list[str]:
    """All manifest tasks, refusing sealed ones without the conspicuous opt-in."""
    if not include_holdout:
        sealed = [t for t in corpus["tasks"] if external_task_metadata(corpus, t)["holdout"]]
        if sealed:
            raise ValueError(
                f"{corpus['corpusRevision']} has {len(sealed)} sealed (holdout) task(s); "
                "holdouts require GATE_D_INCLUDE_HOLDOUT=1")
    return list(corpus["tasks"])


def external_from_env() -> Optional[dict[str, Any]]:
    root = external_root_from_env()
    return None if root is None else load_external(root, load_manifest())


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
    parser.add_argument("command", choices=(
        "describe", "revision", "tasks", "contains", "task-metadata",
        "tasks-root", "task-dir", "verify-digest"))
    parser.add_argument("task_id", nargs="?")
    parser.add_argument("--include-holdout", action="store_true")
    parser.add_argument("--revision")
    parser.add_argument("--expect", help="verify-digest: compare with this digest instead of the manifest's")
    parser.add_argument("--dir", help="verify-digest: digest exactly this task directory")
    args = parser.parse_args()
    try:
        manifest = load_manifest()
        include = args.include_holdout or include_holdout_from_env()
        external = external_from_env()
        if external is not None:
            if args.revision is not None:
                parser.error("--revision selects an in-repo revision; unset GATE_D_TASKS_ROOT")
            return external_main(parser, args, external, include)
        if args.command in ("tasks-root", "task-dir", "verify-digest"):
            if args.command == "tasks-root":
                print(ROOT / "tasks")
                return 0
            if args.command == "task-dir":
                if args.task_id is None or args.task_id not in revision_contract(
                        manifest, args.revision or active_revision(manifest, include))["tasks"]:
                    raise ValueError(f"unknown Gate D task: {args.task_id}")
                print(ROOT / "tasks" / args.task_id)
                return 0
            raise ValueError("verify-digest applies to an external corpus (GATE_D_TASKS_ROOT) only")
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
    except (ValueError, OSError, json.JSONDecodeError) as error:
        parser.exit(2, f"error: {error}\n")
    return 0


def external_main(parser: argparse.ArgumentParser, args: argparse.Namespace,
                  corpus: dict[str, Any], include: bool) -> int:
    command, task_id = args.command, args.task_id
    if command in ("contains", "task-metadata", "task-dir", "verify-digest") and task_id is None:
        parser.error(f"{command} requires task_id")
    if command == "tasks-root":
        print(corpus["root"])
    elif command == "revision":
        print(corpus["corpusRevision"])
    elif command == "tasks":
        print("\n".join(select_external(corpus, include)))
    elif command == "describe":
        tasks = select_external(corpus, include)
        print(json.dumps({
            "corpusRevision": corpus["corpusRevision"],
            "includeHoldout": include,
            "external": True,
            "tasksRoot": str(corpus["root"]),
            "tasks": tasks,
            "holdoutTasks": [t for t in tasks if external_task_metadata(corpus, t)["holdout"]],
            "acceptance": None,
        }, sort_keys=True))
    elif command == "contains":
        if task_id not in corpus["digests"]:
            return 1
        if external_task_metadata(corpus, task_id)["holdout"] and not include:
            return 1
        return 0
    elif command == "task-dir":
        print(external_task_dir(corpus, task_id))
    elif command == "task-metadata":
        print(json.dumps(external_task_metadata(corpus, task_id), sort_keys=True))
    else:
        verify_external_digest(corpus, task_id, args.expect, args.dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
