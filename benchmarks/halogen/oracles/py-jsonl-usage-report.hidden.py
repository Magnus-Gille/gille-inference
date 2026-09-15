"""Hidden semantic oracle for the synthetic JSONL usage-report task."""
import contextlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path.cwd()
sys.path.insert(0, str(ROOT / "app"))

from events import iter_requests  # noqa: E402
from report import render_csv, summarize  # noqa: E402


class JsonlUsageReportOracle(unittest.TestCase):
    def test_parser_counts_invalid_lines_and_last_valid_id_wins(self):
        lines = [
            "\n",
            json.dumps({"kind": "request", "id": "r1", "model": "z", "input_tokens": 2, "output_tokens": 3}),
            "not json\n",
            json.dumps({"kind": "request", "id": "r2", "model": "a", "input_tokens": 4, "output_tokens": 5}),
            json.dumps({"kind": "request", "id": "r1", "model": "z", "input_tokens": 8, "output_tokens": 1}),
            json.dumps({"kind": "other", "id": "r3", "model": "a", "input_tokens": 1, "output_tokens": 1}),
            json.dumps({"kind": "request", "id": "r4", "model": "a", "input_tokens": 1, "output_tokens": 2}),
            json.dumps({"kind": "request", "id": "r5", "model": "a", "input_tokens": True, "output_tokens": 2}),
            "",
        ]
        records, invalid = iter_requests(lines)
        self.assertEqual(invalid, 3)
        self.assertEqual([record["id"] for record in records], ["r1", "r2", "r4"])
        self.assertEqual(records[0]["input_tokens"], 8)

    def test_summary_has_numeric_totals_and_stable_model_order(self):
        lines = [
            json.dumps({"kind": "request", "id": "z", "model": "z", "input_tokens": 8, "output_tokens": 1}),
            json.dumps({"kind": "request", "id": "a", "model": "a", "input_tokens": 4, "output_tokens": 5}),
            json.dumps({"kind": "request", "id": "a2", "model": "a", "input_tokens": 1, "output_tokens": 2}),
            json.dumps({"kind": "request", "id": "comma", "model": "a,b", "input_tokens": 0, "output_tokens": 0}),
            json.dumps({"kind": "request", "id": "newline", "model": "line\nbreak", "input_tokens": 3, "output_tokens": 4}),
            "{bad",
        ]
        self.assertEqual(summarize(lines), {
            "invalidLines": 1,
            "models": [
                {"model": "a", "requests": 2, "inputTokens": 5, "outputTokens": 7},
                {"model": "a,b", "requests": 1, "inputTokens": 0, "outputTokens": 0},
                {"model": "line\nbreak", "requests": 1, "inputTokens": 3, "outputTokens": 4},
                {"model": "z", "requests": 1, "inputTokens": 8, "outputTokens": 1},
            ],
        })

    def test_csv_is_quoted_and_newline_stable(self):
        report = {
            "invalidLines": 0,
            "models": [
                {"model": "a,b", "requests": 1, "inputTokens": 0, "outputTokens": 0},
                {"model": "line\nbreak", "requests": 1, "inputTokens": 3, "outputTokens": 4},
            ],
        }
        self.assertEqual(render_csv(report), (
            "model,requests,input_tokens,output_tokens\n"
            '"a,b",1,0,0\n'
            '"line\nbreak",1,3,4\n'
        ))

    def test_cli_supports_file_and_stdin_json_output(self):
        payload = "\n".join([
            json.dumps({"kind": "request", "id": "b", "model": "b", "input_tokens": 9, "output_tokens": 1}),
            json.dumps({"kind": "request", "id": "a", "model": "a", "input_tokens": 2, "output_tokens": 3}),
        ]) + "\n"
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "events.jsonl"
            input_path.write_text(payload)
            file_run = subprocess.run(
                [sys.executable, "-B", "app/cli.py", str(input_path), "--format", "json"],
                capture_output=True, text=True, check=False,
            )
            stdin_run = subprocess.run(
                [sys.executable, "-B", "app/cli.py", "-", "--format", "json"],
                input=payload, capture_output=True, text=True, check=False,
            )
        self.assertEqual(file_run.returncode, 0, file_run.stderr)
        self.assertEqual(stdin_run.returncode, 0, stdin_run.stderr)
        expected = json.dumps(summarize(payload.splitlines()), separators=(",", ":")) + "\n"
        self.assertEqual(file_run.stdout, expected)
        self.assertEqual(stdin_run.stdout, expected)
        self.assertEqual(file_run.stderr, "")
        self.assertEqual(stdin_run.stderr, "")

    def test_cli_reports_bad_arguments_without_traceback(self):
        run = subprocess.run(
            [sys.executable, "-B", "app/cli.py", "missing.jsonl", "--format", "yaml"],
            capture_output=True, text=True, check=False,
        )
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(run.stdout, "")
        self.assertNotIn("Traceback", run.stderr)


if __name__ == "__main__":
    unittest.main()
