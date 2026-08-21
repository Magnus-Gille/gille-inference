#!/usr/bin/env python3
"""Gate-D oracle-peek scanner — PURE OBSERVATION, never affects pass/fail.

Emits JSON with four booleans describing what grader-side content, if any, showed up in a
harness arm's own transcript:

  oracleContentInTranscript  visible oracle content (declared in meta.oracleFiles[], shipped in
                             the seed). For most r1 tasks the oracle is visible BY DESIGN and the
                             harness is meant to read and satisfy it — a hit here is NORMAL and is
                             not evidence of cheating. Retained for comparability across arms.
  oracleCmdInTranscript      meta.oracleCmd appeared. Also normal for visible-oracle tasks: the
                             harness is expected to run the grader while iterating.
  hiddenOracleInTranscript   content of meta.hiddenOracle (staged at grade time, physically ABSENT
                             from the work dir) reached the transcript. This is the real signal —
                             it should be impossible, so a hit means staging leaked.
  solutionInTranscript       content of the reference solution/ tree reached the transcript. Also
                             should be impossible; the reference solution is never shown to a
                             harness.

Usage: peek-scan.py <task-dir> <transcript-path>
Exits 0 and prints JSON on stdout even on internal error (fails OPEN — this must never break a run).
"""

from __future__ import annotations

import json
import os
import sys

MIN_LEN = 25
BOILERPLATE_PREFIXES = ("import ", "export {", "//", "/*", "*", "#")
BOILERPLATE_EXACT = {"}", "};", "{", "});", ")", "return;"}


def distinctive_lines(path: str) -> list[str]:
    """Lines specific enough that a verbatim match implies the content was actually seen."""
    out: list[str] = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for raw in fh:
                line = raw.strip()
                if len(line) < MIN_LEN:
                    continue
                if line in BOILERPLATE_EXACT:
                    continue
                if line.startswith(BOILERPLATE_PREFIXES):
                    continue
                out.append(line)
    except OSError:
        return []
    return out


def any_line_present(paths: list[str], haystack: str) -> bool:
    for p in paths:
        for line in distinctive_lines(p):
            if line in haystack:
                return True
    return False


def tree_files(root: str) -> list[str]:
    found: list[str] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            found.append(os.path.join(dirpath, fn))
    return found


def main() -> int:
    result = {
        "oracleContentInTranscript": False,
        "oracleCmdInTranscript": False,
        "hiddenOracleInTranscript": False,
        "solutionInTranscript": False,
    }
    try:
        task_dir, transcript_path = sys.argv[1], sys.argv[2]
        with open(transcript_path, "r", encoding="utf-8", errors="replace") as fh:
            haystack = fh.read()
        with open(os.path.join(task_dir, "meta.json"), "r", encoding="utf-8") as fh:
            meta = json.load(fh)

        oracle_cmd = meta.get("oracleCmd") or ""
        if oracle_cmd and oracle_cmd in haystack:
            result["oracleCmdInTranscript"] = True

        visible = [
            os.path.join(task_dir, "repo", f)
            for f in meta.get("oracleFiles", [])
            if os.path.isfile(os.path.join(task_dir, "repo", f))
        ]
        result["oracleContentInTranscript"] = any_line_present(visible, haystack)

        hidden_rel = meta.get("hiddenOracle")
        if hidden_rel:
            hidden_abs = os.path.join(task_dir, hidden_rel)
            if os.path.isfile(hidden_abs):
                result["hiddenOracleInTranscript"] = any_line_present([hidden_abs], haystack)

        solution_root = os.path.join(task_dir, "solution")
        if os.path.isdir(solution_root):
            result["solutionInTranscript"] = any_line_present(tree_files(solution_root), haystack)
    except Exception:  # noqa: BLE001 — observation must never break a graded run
        pass
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
