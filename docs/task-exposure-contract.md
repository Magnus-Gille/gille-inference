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

## Two identity kinds (#4)

The SAME `trim-utf8-sha256-v1` algorithm hashes two different byte domains, discriminated by
`identity_kind`, not by `fingerprint_version`:

- **`rendered-prompt`** — the exact gateway/runtime prompt text sent to a model (`task.prompt` /
  `req.instruction`). Recorded for every lane, stamped or not. This is the registry's original
  identity and remains the default query shape (`fingerprints`).
- **`canonical-raw`** — the logical task's identity *before* Hugin's context/system wrapping, taken
  directly from an admitted [LearningTaskContract](gateway-api-contract.md) Hugin request stamp's
  `raw_fingerprint.digest`. Gille never sees that raw text, only the already-hashed,
  already-authenticated digest Hugin stamped on the `/delegate` and `code_loop` paths. Recorded
  ADDITIONALLY, alongside (never instead of) the rendered-prompt row, only for stamped traffic.
- **`legacy-inexact`** (row data only, never a query kind) — rows written before this discriminator
  existed, or imported by the historical backfill importer. Real evidence, but never silently
  upgraded to look like first-class current-regime data; a rendered-prompt query still finds them
  and every matching result sets `includes_legacy_inexact: true`.

A context-wrapped Hugin task can therefore be found by its canonical identity even though its
rendered prompt (with Hugin's wrapping applied) never appears anywhere in the lookup request.

## Lookup API

`POST /admin/task-exposures/lookup` requires a real minted owner key. Guest, monitor, legacy static
admin, and implicit-admin principals are denied. The route is read-only: schema migration and
historical import happen before the gateway binds its port.

Request — `fingerprints` (0–100 unique rendered-prompt labels) and/or `canonical` (0–100 canonical
queries; at least one item across both fields is required):

```json
{
  "fingerprint_version": "trim-utf8-sha256-v1",
  "fingerprints": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  "canonical": [
    { "fingerprint_sha256": "<64-hex label, seen-only trust>" },
    {
      "fingerprint_sha256": "<64-hex label>",
      "exact_bytes": { "encoding": "utf-8", "byte_length": 42, "text": "the exact pre-wrapping task text" }
    }
  ]
}
```

`fingerprint_sha256` on a `canonical` item is NEVER trusted as a bare label for a negative claim.
When `exact_bytes` is supplied, gille independently recomputes `trim-utf8-sha256-v1` over `text` and
rejects the whole request (400, `param: "canonical"`) if the declared `byte_length` does not match
the exact UTF-8 length of `text`, or if the recomputed digest does not match `fingerprint_sha256` —
"mismatched byte vector" is a hard parse-time rejection, never a silently-accepted label.

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
    "incomplete_reasons": ["pre-capture direct-delegate prompts may be truncated in the legacy ledger"],
    "coverage_epoch_id": "epoch:...",
    "restart_count": 0,
    "total_restart_gap_ms": 0,
    "canonical_identity_capture_started_at": "2026-07-20T00:00:00.000Z",
    "direct_loopback_traffic": { "captured": false, "reason": "..." },
    "exact_match_semantics": { "contamination_proof": false, "scope": "..." }
  },
  "results": [{
    "fingerprint_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "identity_kind": "rendered-prompt",
    "seen": false,
    "first_seen_at": null,
    "last_seen_at": null,
    "lanes": [],
    "model_ids": [],
    "harness_ids": [],
    "unseen_claim_supported": true,
    "includes_legacy_inexact": false
  }]
}
```

The result order matches the request order (`fingerprints` results first, then `canonical`
results). `coverage_complete` applies only to the declared lanes and only from `coverage.from`
through `coverage.through`. It turns false after any detected live capture-write failure. Every
successful gateway start establishes a new contiguous live window before binding the port, so
recovery moves `coverage.from` forward instead of claiming across the gap. It does not claim
complete pre-capture history: legacy delegation excerpts of exactly 280 characters may be
truncated, old code-loop instructions were not independently retained, and direct loopback
llama-swap calls bypass the authenticated gateway entirely (`coverage.direct_loopback_traffic`
discloses this as a permanent exclusion, not a covered gap — see #4).

Hugin must therefore quarantine when `seen=true`. It may treat `seen=false` as a fresh holdout only
when **`unseen_claim_supported=true` on that specific result** — false for every bare-label
`canonical` query (no `exact_bytes`) and whenever live capture itself is unhealthy, regardless of
how healthy `coverage_complete` otherwise looks. When supported, the candidate must additionally
have been created at or after `coverage.from`, and every execution path it used must be in
`coverage.lanes`. Older or ambiguous candidates remain quarantined rather than being promoted from
incomplete history. `coverage.exact_match_semantics` additionally discloses that a `seen=false`
result is exact-byte-match freshness evidence only — never contamination proof against paraphrase,
translation, or other semantic exposure (embeddings are explicitly out of scope).

## Coverage epochs and restart-induced boundary loss (#4)

Every registry row and every lookup response carries `coverage_epoch_id`. A genuine gateway restart
(the `initializeTaskExposureRegistry` startup composition root, not an ordinary schema-ensure call)
mints a fresh epoch and measures the gap between the previous epoch's last known liveness (its last
recorded row, or its own start if it captured nothing) and the new epoch's start. `restart_count`
and `total_restart_gap_ms` in every response are the running, queryable counters for how much
restart-induced boundary movement this registry has ever had; `listTaskExposureCoverageEpochs()`
(exported from `src/homeserver/task-exposure.ts`) is the full queryable epoch-transition history for
anyone who needs more than the two rollup counters.

## Captured metadata and privacy

The registry stores only event key, timestamp, fingerprint version/digest, identity kind, coverage
epoch id, lane, canonical model id, and harness id. It has no task, prompt, answer, diff, file, or
completion column — including for the canonical-raw identity, which only ever stores the digest
Hugin already computed, never the raw text itself. Access logs record the templated route and
operational metadata, never the lookup body; the `canonical[].exact_bytes.text` field on an
inbound lookup request is hashed in memory and discarded, never logged or persisted.

Live capture covers all owner-tier chat and MCP `ask` traffic, primary gateway and declared on-box
CLI/benchmark `delegate()` attempts, disagreement/shadow secondary attempts, and accepted
`code_loop` jobs. The
lookup itself still requires a real minted owner key. Code-loop uses a stable work-id event key, so
a recovered `client_run_id` retry does not double-count exposure. Startup backfill is idempotent:
full retained owner chat/MCP messages and provably complete short delegation excerpts are imported;
ambiguous truncated rows are counted as skipped and the response continues to disclose incomplete
history. Every backfilled row is recorded as `identity_kind: "legacy-inexact"`, never upgraded to
look like first-class current-regime evidence.
