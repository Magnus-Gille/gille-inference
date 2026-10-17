"""Reference implementation for aggregate and CSV output."""
import csv
import io

from events import iter_requests


def summarize(lines):
    records, invalid = iter_requests(lines)
    grouped = {}
    for record in records:
        model = record["model"]
        row = grouped.setdefault(model, {
            "model": model,
            "requests": 0,
            "inputTokens": 0,
            "outputTokens": 0,
        })
        row["requests"] += 1
        row["inputTokens"] += record["input_tokens"]
        row["outputTokens"] += record["output_tokens"]
    return {
        "invalidLines": invalid,
        "models": [grouped[key] for key in sorted(grouped)],
    }


def render_csv(report):
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(["model", "requests", "input_tokens", "output_tokens"])
    for row in report["models"]:
        writer.writerow([
            row["model"], row["requests"], row["inputTokens"], row["outputTokens"],
        ])
    return output.getvalue()
