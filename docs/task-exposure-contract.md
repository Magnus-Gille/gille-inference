# Content-blind task exposure contract

This is the cross-client freshness oracle for Hugin's daily evaluation factory. It answers one
question without returning task content: **has this exact task text already been admitted for an
owned-runtime attempt through a gateway-controlled lane?** A positive result quarantines the task
from fresh holdout use. A negative result is meaningful only within the response's coverage window.

## Fingerprint v1

`fingerprint_version = "trim-utf8-sha256-v1"` means:

1. Apply JavaScript `String.trim()` to the exact task text.
2. Do not normalize Unicode or internal whitespace.
3. Encode the result as UTF-8.
4. Return the lowercase SHA-256 hex digest.

Hugin's producer and this gateway must use that exact contract. A version mismatch fails with
`400 invalid_request_error`; there is no silent fallback.

## Lookup API

`POST /admin/task-exposures/lookup` requires a real minted owner key. Guest, monitor, legacy static
admin, and implicit-admin principals are denied. The route is read-only: schema migration and
historical import happen before the gateway binds its port.

Request (1–100 unique fingerprints):

```json
{
  "fingerprint_version": "trim-utf8-sha256-v1",
  "fingerprints": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"]
}
```

Response:

```json
{
  "schema_version": 1,
  "fingerprint_version": "trim-utf8-sha256-v1",
  "coverage": {
    "coverage_complete": true,
    "from": "2026-07-14T20:00:00.000Z",
    "through": "2026-07-14T21:00:00.000Z",
    "lanes": ["chat", "mcp-ask", "delegate", "delegate-disagreement", "delegate-shadow", "code-loop"],
    "historical_backfill_complete": false,
    "historical_backfill_from": "2026-06-01T00:00:00.000Z",
    "historical_backfill_through": "2026-07-14T19:59:59.000Z",
    "historical_events_imported": 120,
    "historical_rows_skipped_inexact": 7,
    "incomplete_before": "2026-07-14T20:00:00.000Z",
    "incomplete_reasons": ["pre-capture direct-delegate prompts may be truncated in the legacy ledger"]
  },
  "results": [{
    "fingerprint_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "seen": false,
    "first_seen_at": null,
    "last_seen_at": null,
    "lanes": [],
    "model_ids": [],
    "harness_ids": []
  }]
}
```

The result order matches the request order. `coverage_complete` applies only to the declared lanes
and only from `coverage.from` through `coverage.through`. It turns false after any detected live
capture-write failure. Every successful gateway start establishes a new contiguous live window
before binding the port, so recovery moves `coverage.from` forward instead of claiming across the
gap. It does not claim complete pre-capture history: legacy delegation excerpts of exactly 280
characters may be truncated, old code-loop instructions were not independently retained, and
direct loopback llama-swap calls bypass the authenticated gateway.

Hugin must therefore quarantine when `seen=true`. It may treat `seen=false` as a fresh holdout only
when the candidate was created at or after `coverage.from`, `coverage_complete=true`, and every
execution path used by the candidate is included in `coverage.lanes`. Older or ambiguous candidates
remain quarantined rather than being promoted from incomplete history.

## Captured metadata and privacy

The registry stores only event key, timestamp, fingerprint version/digest, lane, canonical model id,
and harness id. It has no task, prompt, answer, diff, file, or completion column. Access logs record
the templated route and operational metadata, never the lookup body.

Live capture covers all owner-tier chat and MCP `ask` traffic, primary gateway and declared on-box
CLI/benchmark `delegate()` attempts, disagreement/shadow secondary attempts, and accepted
`code_loop` jobs. The
lookup itself still requires a real minted owner key. Code-loop uses a stable work-id event key, so
a recovered `client_run_id` retry does not double-count exposure. Startup backfill is idempotent:
full retained owner chat/MCP messages and provably complete short delegation excerpts are imported;
ambiguous truncated rows are counted as skipped and the response continues to disclose incomplete
history.
