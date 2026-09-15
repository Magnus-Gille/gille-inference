"""Reference command line implementation for the JSONL report."""
import argparse
import json
import sys

from report import render_csv, summarize


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--format", choices=("json", "csv"), default="json")
    args = parser.parse_args(argv)
    try:
        if args.input == "-":
            report = summarize(sys.stdin)
        else:
            with open(args.input, encoding="utf-8") as stream:
                report = summarize(stream)
    except OSError as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.format == "csv":
        sys.stdout.write(render_csv(report))
    else:
        sys.stdout.write(json.dumps(report, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
