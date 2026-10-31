"""Contract checks for the local decision-runtime bridge without model weights."""

import http.client
import importlib.util
import json
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path
from types import SimpleNamespace


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "systemone-native-server.py"
SPEC = importlib.util.spec_from_file_location("systemone_native_server", SCRIPT)
assert SPEC and SPEC.loader
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)


QUESTIONS = {
    "urgent": {"type": "noul", "instructions": "Is it urgent?"},
    "team": {"type": "choice", "instructions": "Which team?", "criteria": {
        "billing": "Invoices", "support": "Technical help",
    }},
    "impact": {"type": "score", "instructions": "How severe?", "criteria": ["none", "some", "severe"]},
}


class FakeBackend:
    def __init__(self, tokens=37):
        self.tokens = tokens
        self.calls = 0

    def decide(self, state, questions, input_token_limit=bridge.MAX_TOKENS_PER_QUESTION):
        self.calls += 1
        return {
            "urgent": {"type": "noul", "noul": 0.9},
            "team": {"type": "choice", "choice": "support", "probabilities": {
                "billing": 0.1, "support": 0.9,
            }, "confidence": 0.8},
            "impact": {"type": "score", "score": 1.2, "probabilities": {
                "0": 0.1, "1": 0.6, "2": 0.3,
            }, "confidence": 0.5},
        }, self.tokens


class BrokenBackend:
    def decide(self, state, questions, input_token_limit=bridge.MAX_TOKENS_PER_QUESTION):
        raise ValueError("model preparation failed")


class ContextLengthBackend:
    def decide(self, state, questions, input_token_limit=bridge.MAX_TOKENS_PER_QUESTION):
        raise bridge.ContextLengthExceeded("the prompt includes customer content")


class FakeBackend3tuple:
    def __init__(self, tokens=37, shared_prefix_tokens=4):
        self.tokens = tokens
        self.shared_prefix_tokens = shared_prefix_tokens
        self.calls = 0

    def decide(self, state, questions, input_token_limit=bridge.MAX_TOKENS_PER_QUESTION):
        self.calls += 1
        return {
            "urgent": {"type": "noul", "noul": 0.9},
            "team": {"type": "choice", "choice": "support", "probabilities": {
                "billing": 0.1, "support": 0.9,
            }, "confidence": 0.8},
            "impact": {"type": "score", "score": 1.2, "probabilities": {
                "0": 0.1, "1": 0.6, "2": 0.3,
            }, "confidence": 0.5},
        }, self.tokens, self.shared_prefix_tokens


class FakeNimbleModel:
    def __init__(self):
        self.score_calls = 0

    def score(self, context, schema, score_fields):
        self.score_calls += 1
        return {"fields": {
            "urgent": {"probabilities": {"false": 0.1, "true": 0.9}},
            "team": {"probabilities": {"billing": 0.1, "support": 0.9}},
            "impact": {"probabilities": {"0": 0.1, "1": 0.6, "2": 0.3}},
        }}


def fake_nimble_backend(prompt_lengths):
    backend = object.__new__(bridge.NimbleBackend)
    backend.model = FakeNimbleModel()
    backend.model.tokenizer = object()
    prepare_calls = []

    def prepare_prompts(tokenizer, context, schema, max_length):
        prepare_calls.append(max_length)
        return SimpleNamespace(full_ids=[list(range(length)) for length in prompt_lengths])

    backend.prepare_prompts = prepare_prompts
    return backend, prepare_calls


class NativeBridgeTests(unittest.TestCase):
    def test_shared_prefix_length_uses_token_ids(self):
        self.assertEqual(bridge.shared_prefix_length([[1, 2, 3], [1, 2, 4], [1, 2]]), 2)
        self.assertEqual(bridge.shared_prefix_length([[1, 2], [1, 2]]), 2)
        self.assertEqual(bridge.shared_prefix_length([[], []]), 0)
        self.assertEqual(bridge.shared_prefix_length([]), 0)
        self.assertEqual(bridge.shared_prefix_length([[7, 8, 9]]), 3)

    def test_nimble_schema_preserves_ids_options_and_score_order(self):
        schema, score_fields = bridge._schema_for_nimble(QUESTIONS)
        self.assertEqual(schema["urgent"]["type"], "boolean")
        self.assertEqual(schema["team"]["choices"], ["billing", "support"])
        self.assertEqual(schema["team"]["choice_descriptions"]["support"], "Technical help")
        self.assertEqual(schema["impact"]["choices"], ["0", "1", "2"])
        self.assertEqual(score_fields, ["impact"])

    def test_probability_mapping_matches_typed_gateway_contract(self):
        self.assertEqual(bridge._answer_from_probabilities(QUESTIONS["urgent"], {
            "false": 0.1, "true": 0.9,
        }), {"type": "noul", "noul": 0.9})
        choice = bridge._answer_from_probabilities(QUESTIONS["team"], {
            "billing": 0.1, "support": 0.9,
        })
        self.assertEqual(choice["choice"], "support")
        self.assertAlmostEqual(choice["confidence"], 0.8)
        score = bridge._answer_from_probabilities(QUESTIONS["impact"], {
            "0": 0.1, "1": 0.6, "2": 0.3,
        })
        self.assertAlmostEqual(score["score"], 1.2)

    def test_nimble_prepares_all_prompts_at_full_bound_before_scoring(self):
        backend, prepare_calls = fake_nimble_backend([5, 4, 3])
        answers, tokens, shared = backend.decide("x", QUESTIONS, input_token_limit=5)
        self.assertEqual(tokens, 12)
        self.assertEqual(shared, 3)
        self.assertEqual(prepare_calls, [bridge.MAX_BODY_BYTES * 8])
        self.assertEqual(backend.model.score_calls, 1)
        self.assertEqual(answers["team"]["choice"], "support")

    def test_nimble_overbound_is_typed_and_does_not_score(self):
        backend, prepare_calls = fake_nimble_backend([5, 6, 3])
        with self.assertRaises(bridge.ContextLengthExceeded):
            backend.decide("x", QUESTIONS, input_token_limit=5)
        self.assertEqual(prepare_calls, [bridge.MAX_BODY_BYTES * 8])
        self.assertEqual(backend.model.score_calls, 0)

    def test_http_success_and_rejection_without_backend_call(self):
        backend = FakeBackend()
        server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(bridge.NIMBLE_ID, backend))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            body = json.dumps({"model": bridge.NIMBLE_ID, "state": "Checkout unavailable", "questions": QUESTIONS})
            connection.request("POST", "/v1/systemone", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            payload = json.loads(response.read())
            self.assertEqual(response.status, 200)
            self.assertEqual(payload["usage"], {"input_tokens": 37, "output_tokens": 0})
            self.assertEqual(payload["answers"]["team"]["choice"], "support")
            self.assertEqual(backend.calls, 1)

            limited = json.dumps({"model": bridge.NIMBLE_ID, "state": "x", "questions": QUESTIONS,
                                  "input_token_limit": 8192})
            connection.request("POST", "/v1/systemone", limited, {"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(backend.calls, 2)

            wrong = json.dumps({"model": "clef-flash", "state": "x", "questions": QUESTIONS})
            connection.request("POST", "/systemone", wrong, {"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 400)
            self.assertEqual(backend.calls, 2)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_http_shared_prefix_usage_is_explicit_and_billable(self):
        backend = FakeBackend3tuple(tokens=30, shared_prefix_tokens=5)
        server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(bridge.NIMBLE_ID, backend))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            body = json.dumps({"model": bridge.NIMBLE_ID, "state": "x", "questions": QUESTIONS})
            connection.request("POST", "/systemone", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            payload = json.loads(response.read())
            self.assertEqual(payload["usage"], {
                "input_tokens": 30,
                "output_tokens": 0,
                "shared_prefix_tokens": 5,
                "billable_input_tokens": 20,
            })
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_invalid_backend_usage_fails_closed(self):
        backend = FakeBackend(tokens=3 * bridge.MAX_TOKENS_PER_QUESTION + 1)
        server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(bridge.NIMBLE_ID, backend))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            body = json.dumps({"model": bridge.NIMBLE_ID, "state": "x", "questions": QUESTIONS})
            connection.request("POST", "/systemone", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 503)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_empty_json_object_state_is_valid(self):
        backend = FakeBackend()
        server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(bridge.NIMBLE_ID, backend))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            body = json.dumps({"model": bridge.NIMBLE_ID, "state": {}, "questions": QUESTIONS})
            connection.request("POST", "/systemone", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(backend.calls, 1)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_backend_value_error_is_unavailable_not_bad_customer_request(self):
        server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(bridge.NIMBLE_ID, BrokenBackend()))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            body = json.dumps({"model": bridge.NIMBLE_ID, "state": "x", "questions": QUESTIONS})
            connection.request("POST", "/systemone", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 503)
            self.assertEqual(json.loads(response.read()), {"error": "backend_unavailable"})
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_backend_context_length_is_a_sanitized_bad_request(self):
        server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(bridge.NIMBLE_ID, ContextLengthBackend()))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            body = json.dumps({"model": bridge.NIMBLE_ID, "state": "x", "questions": QUESTIONS})
            connection.request("POST", "/systemone", body, {"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read()), {"error": {"code": "context_length_exceeded"}})
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_input_token_limit_is_nimble_only_and_bounded(self):
        for model_id, limit in ((bridge.DECIDER_ID, 100), (bridge.NIMBLE_ID, 0),
                                (bridge.NIMBLE_ID, bridge.MAX_TOKENS_PER_QUESTION + 1),
                                (bridge.NIMBLE_ID, True)):
            backend = FakeBackend()
            server = HTTPServer(("127.0.0.1", 0), bridge.make_handler(model_id, backend))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
                body = json.dumps({"model": model_id, "state": "x", "questions": QUESTIONS,
                                   "input_token_limit": limit})
                connection.request("POST", "/systemone", body, {"Content-Type": "application/json"})
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 400)
                self.assertEqual(backend.calls, 0)
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
