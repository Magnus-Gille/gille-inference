#!/usr/bin/env python3
"""Single source of truth for Gate D revision and holdout enumeration."""

from __future__ import annotations

import argparse
import json
import os
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
    parser.add_argument("command", choices=("describe", "revision", "tasks", "contains", "task-metadata"))
    parser.add_argument("task_id", nargs="?")
    parser.add_argument("--include-holdout", action="store_true")
    parser.add_argument("--revision")
    args = parser.parse_args()
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
