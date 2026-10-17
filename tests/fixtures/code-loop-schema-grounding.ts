/**
 * A deliberately reconstructed contract for the issue-260 schema-grounding exercise.
 *
 * This is an owner-supplied teaching fixture, not a copy of an original generated artifact or
 * evidence of the exact parser used by any historical run.  Keep that distinction explicit so a
 * future test cannot accidentally turn this reconstruction into provenance.
 */
export const RECONSTRUCTED = "RECONSTRUCTED" as const;

export const CODE_LOOP_SCHEMA_FIXTURE_PROVENANCE = {
  status: RECONSTRUCTED,
  source: "owner-supplied issue-260 contract reconstruction",
  originalArtifact: false,
  exactHistoricalParserClaim: false,
  purpose: "deterministically exercise schema-grounded generated tests",
} as const;

// Short aliases make the provenance difficult to omit when this fixture is reused.
export const PROVENANCE = CODE_LOOP_SCHEMA_FIXTURE_PROVENANCE;

/** The complete event/row contract used by the Python instruction and all generated suites. */
export const CODE_LOOP_USAGE_SCHEMA = {
  provenance: RECONSTRUCTED,
  input: {
    function: "extract_usage(events, from_iso) -> list[dict]",
    events: "A sequence of JSON-like event dictionaries.",
    timestamp: "event.timestamp is a canonical ISO-8601 UTC string ending in Z.",
    relevantEvent: {
      eventType: "event.type == 'event_msg'",
      payloadType: "event.payload.type == 'token_count'",
      usage: "event.payload.info.last_token_usage",
      sessionMetadata: "event.payload.session_meta.session_id",
      turnMetadata: "event.payload.turn_context.call_id",
      spawnMetadata: "event.payload.turn_context.source.subagent.thread_spawn",
    },
  },
  output: {
    cardinality: "exactly one row for each relevant token_count event/call",
    fields: [
      "session_id",
      "call_id",
      "timestamp",
      "fresh_input_tokens",
      "cached_input_tokens",
      "reasoning_output_tokens",
      "source_thread_spawn",
    ],
    forbiddenFields: ["input_tokens"],
    freshInput: "input_tokens - cached_input_tokens",
    ordering: ["timestamp ascending", "call_id ascending as deterministic tie-breaker"],
    filtering: "Ignore relevant events whose top-level event.timestamp is before from_iso.",
  },
} as const;

export const SCHEMA = CODE_LOOP_USAGE_SCHEMA;

/**
 * Self-contained instruction suitable for a generated Python implementation task.  It states
 * paths, cardinality, filtering, output fields, and ordering rather than relying on a model to
 * infer a schema from names such as `event` or `info`.
 */
export const CODE_LOOP_SCHEMA_TASK_INSTRUCTION = String.raw`
Implement this standalone Python function:

    def extract_usage(events, from_iso) -> list[dict]

The input is a sequence of dictionaries from a code-loop event stream.  Use only the following
closed contract; do not invent alternate paths or field names:

* A relevant event has the top-level shape {"type": "event_msg", "timestamp": <ISO-8601 UTC> ,
  "payload": {...}}.  The timestamp is event.timestamp (not payload.timestamp), and timestamps
  use canonical UTC strings ending in Z so chronological string comparison is deterministic.
* A relevant payload has payload.type == "token_count".
* Usage is at payload.info.last_token_usage.  It contains integer input_tokens,
  cached_input_tokens, and reasoning_output_tokens.
* Session metadata is at payload.session_meta.session_id.
* Call metadata is at payload.turn_context.call_id.
* Spawn metadata is at payload.turn_context.source.subagent.thread_spawn.
* Ignore events that are not event_msg/token_count events and ignore relevant events with
  event.timestamp earlier than from_iso.  from_iso uses the same canonical UTC representation.

Return exactly one dictionary per remaining token_count event/call, including multiple calls from
the same session.  Every returned dictionary has exactly these keys:

    session_id
    call_id
    timestamp
    fresh_input_tokens       # input_tokens - cached_input_tokens
    cached_input_tokens
    reasoning_output_tokens
    source_thread_spawn

Never return the legacy record.input_tokens key.  Sort the returned rows by timestamp ascending,
then by call_id ascending for equal timestamps.  The function must be deterministic and must not
deduplicate calls merely because their session_id is equal.
`.trim();

/** Correct reference implementation of the reconstructed contract. */
export const REFERENCE_PYTHON_IMPLEMENTATION = String.raw`
def extract_usage(events, from_iso):
    rows = []
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "event_msg":
            continue
        timestamp = event.get("timestamp")
        if not isinstance(timestamp, str) or timestamp < from_iso:
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "token_count":
            continue
        usage = payload["info"]["last_token_usage"]
        session_meta = payload["session_meta"]
        turn_context = payload["turn_context"]
        rows.append({
            "session_id": session_meta["session_id"],
            "call_id": turn_context["call_id"],
            "timestamp": timestamp,
            "fresh_input_tokens": usage["input_tokens"] - usage["cached_input_tokens"],
            "cached_input_tokens": usage["cached_input_tokens"],
            "reasoning_output_tokens": usage["reasoning_output_tokens"],
            "source_thread_spawn": turn_context["source"]["subagent"]["thread_spawn"],
        })
    rows.sort(key=lambda row: (row["timestamp"], row["call_id"]))
    return rows
`.trim() + "\n";

/** Sanitized reconstruction of the issue-260 generated suite with the known schema errors. */
export const WRONG_GENERATED_PYTHON_SUITE = String.raw`
import unittest

from extractor import extract_usage


class WrongGeneratedSuite(unittest.TestCase):
    def test_usage(self):
        # These are the issue-260 mistakes: event/info are fabricated at the top level, calls are
        # treated as one output per session, and the legacy record.input_tokens is asserted.
        events = [
            {"event": "token_count", "timestamp": "2026-09-03T10:00:01.000Z",
             "info": {"input_tokens": 80}, "session_id": "session-a", "call_id": "call-1"},
            {"event": "token_count", "timestamp": "2026-09-03T10:00:02.000Z",
             "info": {"input_tokens": 100}, "session_id": "session-a", "call_id": "call-2"},
            {"event": "token_count", "timestamp": "2026-09-03T10:00:03.000Z",
             "info": {"input_tokens": 50}, "session_id": "session-b", "call_id": "call-3"},
        ]
        rows = extract_usage(events, "2026-09-03T10:00:00.000Z")
        # Wrongly expects one record per session rather than one per token_count call.
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["input_tokens"], 80)


if __name__ == "__main__":
    unittest.main()
`.trim() + "\n";

/** Grounded suite: its data exercises nesting, two sessions, repeated calls, filtering, and ties. */
export const GROUNDED_GENERATED_PYTHON_SUITE = String.raw`
import unittest

from extractor import extract_usage


def token_event(timestamp, session_id, call_id, thread_spawn, input_tokens, cached, reasoning):
    return {
        "type": "event_msg",
        "timestamp": timestamp,
        "payload": {
            "type": "token_count",
            "info": {"last_token_usage": {
                "input_tokens": input_tokens,
                "cached_input_tokens": cached,
                "reasoning_output_tokens": reasoning,
            }},
            "session_meta": {"session_id": session_id},
            "turn_context": {
                "call_id": call_id,
                "source": {"subagent": {"thread_spawn": thread_spawn}},
            },
        },
    }


class GroundedGeneratedSuite(unittest.TestCase):
    def test_usage_contract(self):
        from_iso = "2026-09-03T10:00:00.000Z"
        events = [
            # Deliberately out of order. call-2 and call-3 share a timestamp to pin the tie-breaker.
            token_event("2026-09-03T10:00:02.000Z", "session-a", "call-3", "spawn-c", 50, 10, 2),
            token_event("2026-09-03T10:00:01.000Z", "session-a", "call-1", "spawn-a", 80, 20, 3),
            token_event("2026-09-03T10:00:02.000Z", "session-b", "call-2", "spawn-b", 100, 40, 7),
            token_event("2026-09-03T10:00:03.000Z", "session-a", "call-4", "spawn-d", 60, 0, 5),
            token_event("2026-09-03T09:59:59.000Z", "old-session", "old-call", "old-spawn", 999, 0, 99),
            {"type": "event_msg", "timestamp": "2026-09-03T10:00:04.000Z",
             "payload": {"type": "message", "session_meta": {"session_id": "ignored"}}},
        ]
        rows = extract_usage(events, from_iso)
        expected = [
            {"session_id": "session-a", "call_id": "call-1", "timestamp": "2026-09-03T10:00:01.000Z",
             "fresh_input_tokens": 60, "cached_input_tokens": 20, "reasoning_output_tokens": 3,
             "source_thread_spawn": "spawn-a"},
            {"session_id": "session-b", "call_id": "call-2", "timestamp": "2026-09-03T10:00:02.000Z",
             "fresh_input_tokens": 60, "cached_input_tokens": 40, "reasoning_output_tokens": 7,
             "source_thread_spawn": "spawn-b"},
            {"session_id": "session-a", "call_id": "call-3", "timestamp": "2026-09-03T10:00:02.000Z",
             "fresh_input_tokens": 40, "cached_input_tokens": 10, "reasoning_output_tokens": 2,
             "source_thread_spawn": "spawn-c"},
            {"session_id": "session-a", "call_id": "call-4", "timestamp": "2026-09-03T10:00:03.000Z",
             "fresh_input_tokens": 60, "cached_input_tokens": 0, "reasoning_output_tokens": 5,
             "source_thread_spawn": "spawn-d"},
        ]
        self.assertEqual(rows, expected)
        self.assertEqual([row["call_id"] for row in rows], ["call-1", "call-2", "call-3", "call-4"])
        self.assertTrue(all("input_tokens" not in row for row in rows))


if __name__ == "__main__":
    unittest.main()
`.trim() + "\n";

// Keep each mutant independently runnable: the helper is embedded rather than imported from a
// second fixture module that a caller could accidentally forget to install beside the mutant.
const PYTHON_REFERENCE_HELPER = String.raw`
def _correct_extract_usage(events, from_iso):
    rows = []
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "event_msg":
            continue
        timestamp = event.get("timestamp")
        if not isinstance(timestamp, str) or timestamp < from_iso:
            continue
        payload = event.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "token_count":
            continue
        usage = payload["info"]["last_token_usage"]
        turn_context = payload["turn_context"]
        rows.append({
            "session_id": payload["session_meta"]["session_id"],
            "call_id": turn_context["call_id"],
            "timestamp": timestamp,
            "fresh_input_tokens": usage["input_tokens"] - usage["cached_input_tokens"],
            "cached_input_tokens": usage["cached_input_tokens"],
            "reasoning_output_tokens": usage["reasoning_output_tokens"],
            "source_thread_spawn": turn_context["source"]["subagent"]["thread_spawn"],
        })
    rows.sort(key=lambda row: (row["timestamp"], row["call_id"]))
    return rows
`;

const pythonModule = (body: string): string => `${PYTHON_REFERENCE_HELPER.trim()}\n\n${body.trim()}\n`;

/** Mutant: fabricates event/info at the top level instead of following event.payload. */
export const MUTANT_TOP_LEVEL_EVENT_INFO = pythonModule(String.raw`
def extract_usage(events, from_iso):
    rows = []
    for event in events:
        if event.get("event") != "token_count" or event.get("timestamp", "") < from_iso:
            continue
        info = event.get("info", {})
        rows.append({
            "session_id": event.get("session_id"),
            "call_id": event.get("call_id"),
            "timestamp": event.get("timestamp"),
            "fresh_input_tokens": info.get("input_tokens"),
            "cached_input_tokens": info.get("cached_input_tokens", 0),
            "reasoning_output_tokens": info.get("reasoning_output_tokens", 0),
            "source_thread_spawn": event.get("thread_spawn"),
        })
    return rows
`);

/** Mutant: reads the session metadata from a made-up top-level session_id. */
export const MUTANT_WRONG_SESSION_NESTING = pythonModule(String.raw`
def extract_usage(events, from_iso):
    return [{**row, "session_id": None} for row in _correct_extract_usage(events, from_iso)]
`);

/** Mutant: reads call metadata from a made-up top-level call_id. */
export const MUTANT_WRONG_CALL_NESTING = pythonModule(String.raw`
def extract_usage(events, from_iso):
    return [{**row, "call_id": None} for row in _correct_extract_usage(events, from_iso)]
`);

/** Mutant: collapses all calls from a session to one output row. */
export const MUTANT_ONE_OUTPUT_PER_SESSION = pythonModule(String.raw`
def extract_usage(events, from_iso):
    rows = _correct_extract_usage(events, from_iso)
    seen = set()
    result = []
    for row in rows:
        if row["session_id"] in seen:
            continue
        seen.add(row["session_id"])
        result.append(row)
    return result
`);

/** Mutant: emits the legacy aggregate input_tokens field instead of fresh/cache fields. */
export const MUTANT_LEGACY_INPUT_TOKENS = pythonModule(String.raw`
def extract_usage(events, from_iso):
    rows = _correct_extract_usage(events, from_iso)
    return [{**row, "input_tokens": row["fresh_input_tokens"] + row["cached_input_tokens"]}
            for row in rows]
`);

/** Mutant: treats the complete input count as fresh input, ignoring the cache count. */
export const MUTANT_FRESH_EQUALS_INPUT = pythonModule(String.raw`
def extract_usage(events, from_iso):
    rows = _correct_extract_usage(events, from_iso)
    return [{**row, "fresh_input_tokens": row["fresh_input_tokens"] + row["cached_input_tokens"]}
            for row in rows]
`);

/** Mutant: ignores the lower bound and includes pre-from_iso rows. */
export const MUTANT_IGNORES_TIMESTAMP_FILTER = pythonModule(String.raw`
def extract_usage(events, from_iso):
    return _correct_extract_usage(events, "")
`);

/** Mutant: reverses the correctly shaped rows, violating deterministic ascending order. */
export const MUTANT_REVERSE_ORDER = pythonModule(String.raw`
def extract_usage(events, from_iso):
    return list(reversed(_correct_extract_usage(events, from_iso)))
`);

/** Every named source is a complete importable extractor module for the focused Vitest harness. */
export const MUTANT_IMPLEMENTATIONS = {
  topLevelEventInfo: MUTANT_TOP_LEVEL_EVENT_INFO,
  wrongSessionNesting: MUTANT_WRONG_SESSION_NESTING,
  wrongCallNesting: MUTANT_WRONG_CALL_NESTING,
  oneOutputPerSession: MUTANT_ONE_OUTPUT_PER_SESSION,
  legacyInputTokens: MUTANT_LEGACY_INPUT_TOKENS,
  freshEqualsInput: MUTANT_FRESH_EQUALS_INPUT,
  ignoresTimestampFilter: MUTANT_IGNORES_TIMESTAMP_FILTER,
  reverseOrder: MUTANT_REVERSE_ORDER,
} as const;

export const NAMED_MUTANT_IMPLEMENTATIONS = MUTANT_IMPLEMENTATIONS;
