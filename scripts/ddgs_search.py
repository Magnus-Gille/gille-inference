#!/usr/bin/env python3
"""Docker-free web-search helper for the deep-research harness (search-provider.ts → DdgsProvider).

Uses the `ddgs` package (DuckDuckGo et al.) — no server, no API key. The Node side shells out to
this with the query as a SEPARATE argument (never a shell string), so there is no injection surface.

    ddgs_search.py "<query>" [max_results]

Prints a JSON array of {"url","title","snippet"} to stdout. Exit 1 on any error so the caller's
circuit breaker trips and falls back to the configured fallback provider.
"""
import json
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: ddgs_search.py <query> [max_results]", file=sys.stderr)
        sys.exit(2)
    query = sys.argv[1]
    try:
        n = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    except ValueError:
        n = 8

    try:
        from ddgs import DDGS
    except Exception as e:  # noqa: BLE001 — surface the cause to stderr, signal failure via exit code
        print(f"ddgs import failed: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        rows = DDGS().text(query, max_results=n)
    except Exception as e:  # noqa: BLE001
        print(f"ddgs search failed: {e}", file=sys.stderr)
        sys.exit(1)

    out = []
    for r in rows or []:
        url = r.get("href") or r.get("url") or ""
        if not url:
            continue
        out.append(
            {
                "url": url,
                "title": r.get("title") or "",
                "snippet": r.get("body") or r.get("snippet") or "",
            }
        )
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
