"""Hidden semantic oracle for the synthetic interval-report task."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / "app"))

from intervals import normalize, parse_intervals, peak_concurrency  # noqa: E402
from report import build_report  # noqa: E402


class IntervalReportOracle(unittest.TestCase):
    def test_union_is_sorted_and_merges_overlap_adjacency_and_negative_ranges(self):
        intervals = parse_intervals([
            [5, 7], [1, 3], [2, 5], [10, 12], [12, 15],
            [-4, -1], [-2, 0], [1, 3],
        ])
        self.assertEqual(normalize(intervals), [[-4, 0], [1, 7], [10, 15]])

    def test_report_totals_union_but_peak_counts_duplicate_original_intervals(self):
        value = [[5, 9], [0, 2], [2, 5], [3, 7], [5, 9], [9, 10]]
        self.assertEqual(build_report(value), {
            "intervals": [[0, 10]],
            "totalDuration": 10,
            "peakConcurrency": 3,
        })

    def test_ends_before_starts_at_ties_and_empty_input(self):
        touching = parse_intervals([[0, 1], [1, 2]])
        duplicates = parse_intervals([[0, 2], [0, 2]])
        self.assertEqual(peak_concurrency(touching), 1)
        self.assertEqual(peak_concurrency(duplicates), 2)
        self.assertEqual(build_report([]), {
            "intervals": [],
            "totalDuration": 0,
            "peakConcurrency": 0,
        })

    def test_validation_rejects_nonlists_bools_nonintegers_and_nonpositive_ranges(self):
        invalid = [
            None, {}, "[]", [1, 2], [[0]], [[0, 1, 2]],
            [[True, 2]], [[0, False]], [[0, 2.0]], [[0, "2"]],
            [[1, 1]], [[2, 1]],
        ]
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    parse_intervals(value)

    def test_cli_file_and_stdin_emit_one_stable_json_report(self):
        value = [[5, 9], [-1, 2], [2, 5], [0, 1]]
        payload = json.dumps(value) + "\n"
        expected = json.dumps(build_report(value), separators=(",", ":")) + "\n"
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "intervals.json"
            input_path.write_text(payload)
            file_run = subprocess.run(
                [sys.executable, "-B", "app/cli.py", str(input_path)],
                capture_output=True, text=True, check=False,
            )
            stdin_run = subprocess.run(
                [sys.executable, "-B", "app/cli.py", "-"],
                input=payload, capture_output=True, text=True, check=False,
            )
        self.assertEqual(file_run.returncode, 0, file_run.stderr)
        self.assertEqual(stdin_run.returncode, 0, stdin_run.stderr)
        self.assertEqual(file_run.stdout, expected)
        self.assertEqual(stdin_run.stdout, expected)
        self.assertEqual(file_run.stderr, "")
        self.assertEqual(stdin_run.stderr, "")

    def test_cli_invalid_input_has_no_partial_json_or_traceback(self):
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "invalid.json"
            input_path.write_text("[[0, 1], [true, 2]]\n")
            run = subprocess.run(
                [sys.executable, "-B", "app/cli.py", str(input_path)],
                capture_output=True, text=True, check=False,
            )
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, "")
        self.assertTrue(run.stderr.startswith("error:"), run.stderr)
        self.assertNotIn("Traceback", run.stderr)


if __name__ == "__main__":
    unittest.main()
