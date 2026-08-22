#!/usr/bin/env python3
"""KV-cache-quantization tool-call fidelity probe.

WHY THIS EXISTS
---------------
Gate-D r1 saturates (30/30 for both `-ctk f16` and `-ctk q8_0`), so it cannot answer whether KV
quantization degrades tool calling. This probe is a higher-resolution instrument aimed at the
claimed mechanism directly, and it scales the one variable that should matter — context length,
since KV quantization error accumulates over cached tokens.

DESIGN
------
Each trial embeds a unique "needle" (an activation code) at a known depth inside filler text of a
target token length, then asks the model to report it *via a tool call*. That yields three
independent, deterministic measurements per trial:

  toolCallEmitted  did the model emit a well-formed tool call at all?
  argsValidJson    were the arguments parseable JSON conforming to the schema?
  valueCorrect     did it recover the exact needle (retrieval fidelity through the KV cache)?

Sampling is greedy (temperature 0, fixed seed) so differences are attributable to the serving
configuration rather than sampling noise. The needle is a high-entropy token that cannot be guessed
or independently derived, so `valueCorrect` has no convergence-false-positive path.

USAGE
  kv-toolcall-probe.py --base-url http://127.0.0.1:18099/v1 --model m --label f16 \
      --out data/kv-probe/f16.jsonl [--contexts 2000,8000,32000] [--trials 15]
"""

from __future__ import annotations

import argparse
import json
import random
import string
import sys
import time
import urllib.error
import urllib.request

# ~4 chars/token is a good enough approximation for filler sizing; the exact prompt token count is
# read back from the server's usage report and recorded per trial, so analysis uses real numbers.
CHARS_PER_TOKEN = 4

FILLER_SENTENCES = [
    "The maintenance log records routine inspection of the auxiliary cooling loop.",
    "Operators noted nominal pressure across all monitored subsystems this cycle.",
    "Scheduled recalibration of the telemetry array completed without incident.",
    "The archival subsystem reported consistent checksums for all stored volumes.",
    "Ambient temperature in the equipment bay remained within tolerance overnight.",
    "A routine firmware audit found no deviations from the approved manifest.",
    "The backup generator completed its monthly load test at rated capacity.",
    "Signal attenuation on the secondary bus stayed below the reporting threshold.",
]

TOOL_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "report_activation_code",
            "description": "Report the activation code found in the maintenance log.",
            "parameters": {
                "type": "object",
                "properties": {
                    "sector": {"type": "integer", "description": "The sector number."},
                    "code": {"type": "string", "description": "The activation code, verbatim."},
                },
                "required": ["sector", "code"],
            },
        },
    }
]


def make_needle(rng: random.Random) -> tuple[int, str]:
    sector = rng.randint(100, 999)
    code = "{}{}-{}".format(
        rng.choice(string.ascii_uppercase),
        rng.choice(string.ascii_uppercase),
        "".join(rng.choice(string.digits) for _ in range(4)),
    )
    return sector, code


def build_prompt(rng: random.Random, target_tokens: int, depth: float) -> tuple[str, int, str]:
    sector, code = make_needle(rng)
    needle = f"IMPORTANT: The activation code for sector {sector} is {code}."
    target_chars = target_tokens * CHARS_PER_TOKEN
    body: list[str] = []
    total = 0
    while total < target_chars:
        s = rng.choice(FILLER_SENTENCES)
        body.append(s)
        total += len(s) + 1
    insert_at = max(0, min(len(body), int(len(body) * depth)))
    body.insert(insert_at, needle)
    return "\n".join(body), sector, code


def post(url: str, payload: dict, api_key: str, timeout: int) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def evaluate(body: dict, sector: int, code: str) -> dict:
    """Extract the three fidelity measurements from a chat-completion response."""
    out = {
        "toolCallEmitted": False,
        "argsValidJson": False,
        "valueCorrect": False,
        "sectorCorrect": False,
        "raw": None,
    }
    try:
        msg = body["choices"][0]["message"]
    except (KeyError, IndexError):
        return out
    calls = msg.get("tool_calls") or []
    if not calls:
        # Some runtimes emit the call in content when the template misfires — record the text so a
        # malformed-but-present call is distinguishable from no attempt at all.
        out["raw"] = (msg.get("content") or "")[:400]
        return out
    out["toolCallEmitted"] = True
    fn = calls[0].get("function") or {}
    args_raw = fn.get("arguments")
    out["raw"] = (args_raw or "")[:400]
    try:
        args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
    except (json.JSONDecodeError, TypeError):
        return out
    if not isinstance(args, dict):
        return out
    out["argsValidJson"] = True
    got_code = str(args.get("code", "")).strip().upper()
    out["valueCorrect"] = got_code == code.upper()
    try:
        out["sectorCorrect"] = int(args.get("sector")) == sector
    except (TypeError, ValueError):
        out["sectorCorrect"] = False
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--label", required=True, help="serving-config label recorded on every row")
    ap.add_argument("--out", required=True)
    ap.add_argument("--contexts", default="2000,8000,32000")
    ap.add_argument("--depths", default="0.1,0.5,0.9")
    ap.add_argument("--trials", type=int, default=15)
    ap.add_argument("--seed", type=int, default=20260822)
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--api-key", default="")
    args = ap.parse_args()

    contexts = [int(x) for x in args.contexts.split(",")]
    depths = [float(x) for x in args.depths.split(",")]
    url = args.base_url.rstrip("/") + "/chat/completions"

    with open(args.out, "a") as fh:
        for ctx in contexts:
            for depth in depths:
                for trial in range(args.trials):
                    # Seed per cell+trial so f16 and q8_0 arms see IDENTICAL prompts — this is a
                    # paired design; any difference is attributable to the serving config alone.
                    rng = random.Random(f"{args.seed}-{ctx}-{depth}-{trial}")
                    prompt, sector, code = build_prompt(rng, ctx, depth)
                    payload = {
                        "model": args.model,
                        "messages": [
                            {
                                "role": "user",
                                "content": prompt
                                + "\n\nFind the activation code in the log above and report it by "
                                "calling report_activation_code with the sector number and the "
                                "exact code.",
                            }
                        ],
                        "tools": TOOL_SCHEMA,
                        "tool_choice": "auto",
                        "temperature": 0,
                        "seed": 1234,
                        "max_tokens": 512,
                    }
                    t0 = time.time()
                    err = None
                    try:
                        body = post(url, payload, args.api_key, args.timeout)
                    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
                        body, err = {}, f"{type(e).__name__}: {e}"[:200]
                    dt = time.time() - t0
                    res = evaluate(body, sector, code) if body else {
                        "toolCallEmitted": False, "argsValidJson": False,
                        "valueCorrect": False, "sectorCorrect": False, "raw": None,
                    }
                    usage = (body or {}).get("usage") or {}
                    row = {
                        "label": args.label,
                        "model": args.model,
                        "targetCtx": ctx,
                        "depth": depth,
                        "trial": trial,
                        "promptTokens": usage.get("prompt_tokens"),
                        "completionTokens": usage.get("completion_tokens"),
                        "wallMs": int(dt * 1000),
                        "error": err,
                        **res,
                    }
                    fh.write(json.dumps(row) + "\n")
                    fh.flush()
                    flag = "ok" if res["valueCorrect"] else ("CALL" if res["toolCallEmitted"] else "NOCALL")
                    print(f"[{args.label}] ctx={ctx} depth={depth} trial={trial} -> {flag} ({dt:.1f}s)",
                          flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
