# Changelog

## 2026-08-02

- Tightened staged credential-rotation proof so only successful authenticated protected routes advance replacement-key preflight. Public `200` routes (`/healthz`, `/hs`, `/portal*`) plus anonymous `401` and forbidden `403` requests no longer satisfy the proof gate.
- `GET /ledger/{id}` now exposes bounded `reviewerUsefulnessHidden:true` plus note presence/count summaries when reviewer-usefulness columns are populated but legacy/malformed/ineligible, instead of silently dropping that state. Verdict, reviewer identity, timestamp, and note bytes remain hidden until a later valid write replaces it.
- Verifier kind/admissibility now treat known base names and `none` sentinel variants case-insensitively for classification; fully ungraded combinations such as `none+NONE(ungraded)` normalize to `ungraded`/`null` without silently merging non-null mixed-case verifier buckets.

## 2026-08-01

- Added owner-admin `PUT /ledger/{id}/reviewer-usefulness` for validated `review-bounded` rows only. It records the authenticated logical alias as reviewer identity, accepts only `pass|partial|redo|wrong`, keeps notes bounded to content-blind `key:value` tokens, makes exact retries idempotent, and rejects differing overwrites with `409 reviewer_usefulness_conflict`.
- Extended `GET /v1/capabilities/review-lane` to advertise reviewer-usefulness recording availability (`reviewerUsefulnessRecording`) without treating that advertisement as model ground truth.
- Added direct handler gateway tests for reviewer-usefulness writes and review-lane capability reporting so the contract stays runnable in sandboxes that cannot bind a loopback port.
