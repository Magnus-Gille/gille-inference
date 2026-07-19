# gpt-oss-120b flakiness under load — grammar-constrained structured output (#166)

**Date:** 2026-07-06 · **Issue:** #166 (robust prevention) · **Predecessor:** #164 (retry band-aid, PR #167)

## Symptom

`gpt-oss-120b` — the box's best code reviewer and a strong served-triage model — was the **least
reliable model to reach under load**. The dominant failure was a structured-output HTTP 500: 27/120
triage `/delegate` calls returned `500 "output does not match the expected peg-native format"`. Free-text
(code-review) traffic triggered 0 such errors; only JSON-shaped requests broke.

## Root cause (from #164's read-only investigation)

`gpt-oss-120b` uses the OpenAI **harmony** format. llama.cpp parses assistant turns with a strict PEG
grammar (`COMMON_CHAT_FORMAT_PEG_NATIVE`, `common_chat_params_init_gpt_oss`) that requires every turn
wrapped in channel markup (`<|start|>assistant<|channel|>final<|message|>…`). The `/delegate` path sent
**no** `response_format` → decoding was unconstrained. When a triage system prompt says "output ONLY JSON,
no channel markup," the model (a strong instruction-follower) sometimes emits **bare JSON with no harmony
scaffold** → the PEG parse fails → `chat.cpp` throws → llama-server returns a bare **HTTP 500**. It is
**non-deterministic** on identical requests (strict prompt reproduced it 5/5; a `response_format` request
returned 200 every time). Cold-swap is **not** the trigger (gateway `callTimeoutMs` default is 600 s).

## Fix — two layers, both now shipped

| # | Layer | What |
|---|-------|------|
| #164 | **Resilience** (already shipped, PR #167) | One retry of the local call on a transient format-500. Recovers the majority, but a twice-failed call still errors → escalates to frontier. |
| #166 | **Prevention** (this change) | Thread a `response_format` through the delegate path so JSON-shaped tasks get **grammar-constrained decoding**. The malformed generation never happens — no 500 to retry. |

### #166 mechanics

- `runLmStudioInference` (`src/runner/lmstudio-client.ts`) forwards `InferenceOptions.responseFormat` to
  the llama.cpp OpenAI endpoint. Omitted when absent (unconstrained default preserved).
- `orchestrator.resolveResponseFormat(taskType, explicit, autoJson)` — pure precedence rule:
  1. an **explicit** `task.responseFormat` (or an HTTP `responseFormat`) always wins;
  2. else a **JSON-shaped task type** (taxonomy `jsonOutput` — `triage`, `source-distill`) defaults to
     `{ type: "json_object" }` when `config.autoJsonResponseFormat` is on (default; env
     `HOMESERVER_AUTO_JSON_RESPONSE_FORMAT=off` disables);
  3. else no format.
  The resolved value is shared by the primary call **and** the disagreement-gate secondary call.
- `gateway.parseResponseFormat()` validates the untrusted `/delegate` `responseFormat` to an allow-list of
  the three OpenAI shapes (`text` | `json_object` | `json_schema{name,schema,strict?}`), reconstructing a
  minimal value so unknown fields never reach llama.cpp. A json_schema is the strongest guarantee (a hard
  well-formed-JSON contract for callers like ratatoskr triage).

Existing triage callers get the `json_object` default automatically — **no call-site change required.**

## Why `json_object` is enough (and json_schema is stronger)

`response_format: {type:"json_object"}` returned 200 on every repro in #164 — engaging the constrained
decoder stops the harmony drift. A full `json_schema` additionally pins the exact object shape. Both are
supported by llama.cpp's OpenAI server for all served models, so the default is a strict reliability win.

## How to validate on the box (owner, free — loopback llama-swap, no OpenRouter spend)

The premise (`response_format` → no 500) was established empirically in #164. To re-confirm on real
hardware, hit the loopback llama-swap directly (wrap in `homeserver gpu run` so the swap doesn't thrash):

```bash
# ON the box. Strict-JSON prompt that reproduced the 500 5/5 WITHOUT a response_format:
SYS='Output ONLY a JSON object {"verdict":"ready"|"clarify"}. No reasoning, no channel markup.'
# (a) unconstrained — expect an occasional peg-native 500 across a few reps
# (b) + "response_format":{"type":"json_object"} — expect 200 every rep
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8091/v1/chat/completions \
  -H 'content-type: application/json' \
  -d "{\"model\":\"gpt-oss-120b\",\"messages\":[{\"role\":\"system\",\"content\":\"$SYS\"},{\"role\":\"user\",\"content\":\"triage: please add dark mode\"}],\"response_format\":{\"type\":\"json_object\"}}"
```

## Tests

- `tests/taxonomy-json-output.test.ts` — which task types are JSON-shaped (pins triage + source-distill).
- `tests/orchestrator-response-format.test.ts` — `resolveResponseFormat` precedence + the format reaches
  the primary, the #164 retry, and the gate secondary; kill-switch and explicit-override honored.
- `tests/lmstudio-response-format.test.ts` — `runLmStudioInference` forwards / omits `response_format`.
- `tests/gateway-response-format.test.ts` — the `/delegate` `responseFormat` validator.
