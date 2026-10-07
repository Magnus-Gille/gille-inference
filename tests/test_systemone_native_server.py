"""Contract checks for the local decision-runtime bridge without model weights."""

import http.client
import importlib.util
import json
import threading
import unittest
from http.server import HTTPServer
from pathlib import Path


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

    def decide(self, state, questions):
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
    def decide(self, state, questions):
        raise ValueError("model preparation failed")


class NativeBridgeTests(unittest.TestCase):
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

            wrong = json.dumps({"model": "clef-flash", "state": "x", "questions": QUESTIONS})
            connection.request("POST", "/systemone", wrong, {"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 400)
            self.assertEqual(backend.calls, 1)
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


if __name__ == "__main__":
    unittest.main()
