"""Reference command line implementation for interval reports."""
import argparse
import json
import sys

from report import build_report


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    args = parser.parse_args(argv)
    try:
        if args.input == "-":
            value = json.load(sys.stdin)
        else:
            with open(args.input, encoding="utf-8") as stream:
                value = json.load(stream)
        output = build_report(value)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    sys.stdout.write(json.dumps(output, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
