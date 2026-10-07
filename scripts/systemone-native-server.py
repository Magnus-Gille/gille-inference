#!/usr/bin/env python3
"""Loopback System One adapter for pinned, locally installed decision checkpoints.

The launcher is owned by llama-swap, which admits one GPU model at a time. All
model code and weights must already be present in the supplied checkpoint. The
Nimble base must also be present in Hugging Face's offline cache. This process
never downloads a model or accepts a non-loopback listener.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Protocol

NIMBLE_ID = "bespoke-nimble-9b"
DECIDER_ID = "pplx-decider-v1-27b"
MAX_BODY_BYTES = 256 * 1024
MAX_QUESTIONS = 16
MAX_TOKENS_PER_QUESTION = 8192


class DecisionBackend(Protocol):
    def decide(self, state: str | dict[str, Any], questions: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], int]: ...


def _state_text(state: str | dict[str, Any]) -> str:
    return state if isinstance(state, str) else json.dumps(state, ensure_ascii=False, allow_nan=False)


def _schema_for_nimble(questions: dict[str, dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    schema: dict[str, dict[str, Any]] = {}
    score_fields: list[str] = []
    for name, question in questions.items():
        kind = question["type"]
        field: dict[str, Any] = {"description": question["instructions"]}
        if kind == "noul":
            field["type"] = "boolean"
            criteria = question.get("criteria") or {}
            if criteria:
                field["choice_descriptions"] = criteria
        elif kind == "choice":
            field["type"] = "enum"
            field["choices"] = list(question["criteria"])
            descriptions = {key: value for key, value in question["criteria"].items() if value is not None}
            if descriptions:
                field["choice_descriptions"] = descriptions
        elif kind == "score":
            field["type"] = "enum"
            field["choices"] = [str(index) for index in range(len(question["criteria"]))]
            field["choice_descriptions"] = dict(zip(field["choices"], question["criteria"]))
            score_fields.append(name)
        else:
            raise ValueError("invalid question type")
        schema[name] = field
    return schema, score_fields


def _answer_from_probabilities(question: dict[str, Any], probabilities: dict[str, float]) -> dict[str, Any]:
    if question["type"] == "noul":
        return {"type": "noul", "noul": probabilities["true"]}
    keys = list(question["criteria"]) if question["type"] == "choice" else [
        str(index) for index in range(len(question["criteria"]))
    ]
    values = [probabilities[key] for key in keys]
    if not values or any(not math.isfinite(value) or value < 0 or value > 1 for value in values):
        raise ValueError("invalid decision probabilities")
    if abs(sum(values) - 1) > 0.02:
        raise ValueError("invalid decision probability mass")
    best = max(range(len(values)), key=values.__getitem__)
    if question["type"] == "choice":
        confidence = (values[best] - 1 / len(values)) / (1 - 1 / len(values))
        return {"type": "choice", "choice": keys[best], "probabilities": probabilities,
                "confidence": max(0.0, min(1.0, confidence))}
    distance = sum(value * abs(index - best) for index, value in enumerate(values))
    midpoint = (len(values) - 1) / 2
    baseline = sum(abs(index - midpoint) for index in range(len(values))) / len(values)
    return {"type": "score", "score": sum(index * value for index, value in enumerate(values)),
            "probabilities": probabilities, "confidence": max(0.0, 1 - distance / baseline)}


class NimbleBackend:
    def __init__(self, checkpoint: Path) -> None:
        sys.path.insert(0, str(checkpoint))
        from inference import NimbleModel  # type: ignore[import-not-found]
        from serving_schema import prepare_prompts  # type: ignore[import-not-found]

        self.model = NimbleModel(checkpoint)
        self.prepare_prompts = prepare_prompts
        self.max_length = self.model.contract["max_length"]
        if self.max_length != MAX_TOKENS_PER_QUESTION or self.model.temperature != 1.0:
            raise RuntimeError("Nimble serving contract changed")

    def decide(self, state: str | dict[str, Any], questions: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], int]:
        context = _state_text(state)
        schema, score_fields = _schema_for_nimble(questions)
        prepared = self.prepare_prompts(self.model.tokenizer, context, schema, self.max_length)
        tokens = sum(map(len, prepared.full_ids))
        result = self.model.score(context, schema, score_fields=score_fields)
        fields = result["fields"]
        answers = {name: _answer_from_probabilities(question, fields[name]["probabilities"])
                   for name, question in questions.items()}
        return answers, tokens


class DeciderBackend:
    def __init__(self, checkpoint: Path) -> None:
        sys.path.insert(0, str(checkpoint / "source" / "src"))
        from autojev.model import DecisionModel, answer  # type: ignore[import-not-found]

        self.model = DecisionModel(checkpoint=checkpoint, device="cuda")
        self.model.eval()
        self.answer = answer
        import torch
        self.torch = torch

    def decide(self, state: str | dict[str, Any], questions: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], int]:
        answers: dict[str, Any] = {}
        input_tokens = 0
        with self.torch.inference_mode():
            for name, question in questions.items():
                batch = self.model.prepare([{"state": state, "question": question}], max_length=MAX_TOKENS_PER_QUESTION)
                probabilities = (self.model.forward(batch) / self.model.temperature).softmax(-1)[0]
                answers[name] = self.answer(question, probabilities[:batch.counts[0]].cpu().tolist())
                input_tokens += batch.input_tokens
        return answers, input_tokens


def _valid_request(value: Any, model_id: str) -> bool:
    if not isinstance(value, dict) or set(value) != {"model", "state", "questions"} or value["model"] != model_id:
        return False
    state = value["state"]
    if not isinstance(state, (str, dict)) or (isinstance(state, str) and not state):
        return False
    questions = value["questions"]
    if not isinstance(questions, dict) or not 1 <= len(questions) <= MAX_QUESTIONS:
        return False
    for name, question in questions.items():
        if not isinstance(name, str) or not isinstance(question, dict):
            return False
        if question.get("type") not in ("noul", "choice", "score") or not isinstance(question.get("instructions"), str):
            return False
    return True


def make_handler(model_id: str, backend: DecisionBackend) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:
            # Request content, query values, and model output never enter shared logs.
            return

        def _json(self, code: int, value: dict[str, Any]) -> None:
            body = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._json(200, {"status": "ok"})
            else:
                self._json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path not in ("/systemone", "/v1/systemone"):
                self._json(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self._json(400, {"error": "invalid_request"})
                return
            if not 0 < length <= MAX_BODY_BYTES:
                self._json(413, {"error": "request_too_large"})
                return
            try:
                value = json.loads(self.rfile.read(length), parse_constant=lambda _value: (_ for _ in ()).throw(ValueError()))
                if not _valid_request(value, model_id):
                    raise ValueError("invalid request")
            except (ValueError, KeyError, TypeError):
                self._json(400, {"error": "invalid_request"})
                return
            try:
                answers, input_tokens = backend.decide(value["state"], value["questions"])
                if (set(answers) != set(value["questions"]) or not isinstance(input_tokens, int)
                        or not 0 < input_tokens <= len(answers) * MAX_TOKENS_PER_QUESTION):
                    raise RuntimeError("invalid backend response")
                self._json(200, {"model": model_id, "answers": answers,
                                 "usage": {"input_tokens": input_tokens, "output_tokens": 0}})
            except Exception as exc:
                # Only the error class is logged; upstream exception messages can contain prompts.
                print(f"systemone backend failure: {type(exc).__name__}", file=sys.stderr)
                self._json(503, {"error": "backend_unavailable"})

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=(NIMBLE_ID, DECIDER_ID))
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    if not args.checkpoint.is_dir() or not 1 <= args.port <= 65535:
        parser.error("checkpoint must be a local directory and port must be valid")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import torch
    if torch.version.hip is None or not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("this release requires an AMD ROCm device with BF16 support")
    backend = NimbleBackend(args.checkpoint) if args.model == NIMBLE_ID else DeciderBackend(args.checkpoint)
    HTTPServer(("127.0.0.1", args.port), make_handler(args.model, backend)).serve_forever()


if __name__ == "__main__":
    main()
