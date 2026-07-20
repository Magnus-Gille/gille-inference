# Provenance of Vendored Test Fixtures

Source: `Magnus-Gille/grimnir` (GitHub)
Source Commit: `bc8cf09` (full: `bc8cf09f7c5f2b42ac7baa895aead0cb0fc351c7`) — grimnir's `origin/main` head,
the squash-merge commit for PR #89 "docs: define LearningTaskContract v1"
Source Path: `tests/fixtures/learning-task-contract/`
Sync Date: 2026-07-20

Vendored files (copied byte-for-byte via `git show bc8cf09:tests/fixtures/learning-task-contract/<name>`,
verified with a sha256 comparison against the grimnir checkout at sync time):

- `jcs-conformance-vectors.json`
- `negative.json`
- `positive-derived.json`
- `positive-erased.json`
- `positive.json`
- `raw-fingerprint-vectors.json`
- `source-document-negative.json`
- `source-documents.json`
- `validation-context.json`

These are Grimnir's normative fixtures for the LearningTaskContract v1 schema/record, vendored so
gille-inference's tests can validate its own implementation against Grimnir's authoritative vectors
instead of parallel bespoke mocks (issue #2, acceptance criterion 7).

Not every vector applies to gille-inference: gille only implements the Hugin-request-stamp/preflight/
gateway-echo transport slice and the `trim-utf8-sha256-v1` raw fingerprint and `jcs-rfc8785-utf8-v1`
canonicalization algorithms. Grimnir-side consumer concerns (full joined-record governance, tombstone/
erasure, pipeline accounting, source-document digest cross-verification) have no gille implementation to
run against. See the header comment in
`tests/homeserver-learning-task-contract-vendored.test.ts` for the exact applicable/skipped breakdown.

Any re-sync MUST update the commit pin in this document (and in any test file that references it) to the
new source commit, and re-verify byte-for-byte equality against the new commit before merging.

These files must not be hand-edited. Changes should only ever come from a fresh sync from grimnir.
