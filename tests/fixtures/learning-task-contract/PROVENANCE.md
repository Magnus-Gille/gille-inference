# Provenance of Vendored Test Fixture

Source: `Magnus-Gille/grimnir` (GitHub)
Source Commit: `bc8cf09` (full: `bc8cf09f7c5f2b42ac7baa895aead0cb0fc351c7`) — grimnir's `origin/main` head,
the squash-merge commit for PR #89 "docs: define LearningTaskContract v1"
Source Path: `tests/fixtures/learning-task-contract/raw-fingerprint-vectors.json`
Sync Date: 2026-07-20

Vendored file (copied byte-for-byte via
`git -C <grimnir checkout> show bc8cf09:tests/fixtures/learning-task-contract/raw-fingerprint-vectors.json`,
verified with a sha256 comparison against the grimnir checkout at sync time — both sides hash to
`853d445367c7e0a35d275f535b033b9e38c50fd58b37e7edb4650bfeeb3e5c08`):

- `raw-fingerprint-vectors.json`

This is grimnir's normative ASCII/Unicode `trim-utf8-sha256-v1` fixture for the LearningTaskContract
v1 `raw_fingerprint` field (issue #4, acceptance criterion "add a real cross-repository Hugin
serialization → gille capture → lookup fixture with exact UTF-8 byte/hash vectors"). Only this one
file is vendored here — issue #4 needs the raw-fingerprint byte-exactness vectors specifically, not
grimnir's full fixture set (JCS canonicalization, positive/negative contract records, source
documents, etc.), which belongs to issue #2's contract-parsing scope
(see `agent/2-contract-fixture-provenance` on this repo's `canonical` remote, not merged into `main`
as of this sync).

Any re-sync MUST update the commit pin in this document to the new source commit, and re-verify
byte-for-byte equality against the new commit before merging.

This file must not be hand-edited. Changes should only ever come from a fresh sync from grimnir.
