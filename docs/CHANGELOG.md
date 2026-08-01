# Changelog

## 2026-08-01

- Added owner-admin `PUT /ledger/{id}/reviewer-usefulness` for validated `review-bounded` rows only. It records the authenticated logical alias as reviewer identity, accepts only `pass|partial|redo|wrong`, keeps notes bounded to content-blind `key:value` tokens, makes exact retries idempotent, and rejects differing overwrites with `409 reviewer_usefulness_conflict`.
- Extended `GET /v1/capabilities/review-lane` to advertise reviewer-usefulness recording availability (`reviewerUsefulnessRecording`) without treating that advertisement as model ground truth.
- Added direct handler gateway tests for reviewer-usefulness writes and review-lane capability reporting so the contract stays runnable in sandboxes that cannot bind a loopback port.
