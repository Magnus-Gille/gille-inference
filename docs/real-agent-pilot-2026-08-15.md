# Real-repository agent benchmark checkpoint

**Date:** 15 August 2026

**Runner commit:** `96b7e98dcbeba0c900d8dde944560c438455a520`

**Corpus:** `strix-real-r1`

## What changed

A preregistered real-history task now reconstructs the repository at immutable base commit
`4f32c119a1ccd59fd7572da3fba127bdb23db1e4` and asks an agent to implement the Pi telemetry
contract later completed at `0ff110b0026ef51a3a6fbe868280c914f906fff6`. The model sees only the
sparse seed. Exact writable paths, a hidden oracle, deterministic checks, the instruction hash,
and both source commits are fixed in `benchmarks/real-agent/corpus.json`.

The runner records content-blind useful-work evidence: deterministic pass/fail, wall time, turns,
tool calls, prompt/completion tokens, harness-observed model-turn and assistant-stream spans,
changed/disallowed path counts, check result hashes, and immutable runner/corpus/source identity.
Raw Pi events and stderr are mode 0600 outside the scored Git tree and are deleted with the temp
root by default. Live execution fails closed if benchmark sources are not committed.

The Pi provider/model catalogue is also committed and copied into a throwaway Pi configuration.
It includes only `qwen36-a3b` and `qwen38-27b`, contains no credential, and prevents mutable laptop
configuration from changing an A/B arm.

## Why it matters

This closes the largest measurement gap left by the first Qwen3.6/Qwen3.8 Gate D study: realistic
repository work can now be scored by completed deterministic work and explained with content-blind
turn/token/timing evidence. The task is fresh with respect to the evaluated models; it is derived
from repository history rather than authored to match either model's observed behavior.

## Evidence

- Focused real-agent/telemetry/hidden-oracle tests: 9/9 passed before the first harness commit.
- Canonical `m5-auth` support and pinned-catalogue tests: red/green complete; 9/9 focused tests
  passed after the final catalogue change.
- TypeScript and constitutional typechecks: passed.
- Offline corpus/provenance validation: passed.
- Full repository suite: 276 files and 4,246 tests passed.
- Fake-Pi end-to-end smoke: one allowed edit, zero disallowed paths, expected hidden-check failure,
  telemetry captured, result mode 0600, exact committed runner identity, and zero residual temp
  worktrees.
- Authenticated read-only live roster: both `qwen36-a3b` and `qwen38-27b` were present.

## Local A/B result

**Not run.** The first live Qwen3.6 process was rejected before execution because direct Pi is not
OS-caged and would inherit the M5 bearer credential while retaining shell/file tools. No model turn
started, no result row was created, and no production setting changed.

The existing OS-caged `code_loop_start` path is materially safer, but its public contract binds all
runs to the single operator-configured `HOMESERVER_CODE_LOOP_MODEL`. It has no caller-selectable,
allow-listed model field, so it cannot perform a faithful Qwen3.6/Qwen3.8 comparison today.

## Decision

Do not bypass the credential boundary and do not present the missing live pilot as a measured A/B.
Keep the prior routing decision unchanged: Qwen3.6 remains the fast/default coding lane and
Qwen3.8 remains the broad-edit/quality escalation based on the earlier matched Gate D evidence.

## Deployed?

**No.** No gateway, model, route, runtime, driver, or service configuration changed.

## Before / after

| | Before | After |
|---|---|---|
| Real-history corpus | none | immutable sparse seed, reference revision, hidden oracle, exact writable scope |
| Durable result | pass/wall only in the older Gate D study | content-blind turns, tokens, tool calls, timing spans, checks, hashes, and provenance |
| Pi comparison config | mutable user catalogue | committed secret-free two-model catalogue copied into a temp Pi home |
| Credential boundary | direct Pi required bearer inheritance | live run fails operationally unless the owner explicitly accepts that risk or a model-selectable cage exists |

## Rollback

The repository-only changes are reversible with normal Git reverts of `a185697`, `f25bf83`, and
`96b7e98`; there is no production rollback. The previous known-good runtime and routing remain
untouched.

## Next most valuable experiment

Extend the existing OS-caged code-loop contract with a strictly allow-listed evaluation model
selector whose chosen model is included in request identity, durable execution evidence, readiness
checks, GPU lease identity, and ledger rows. This changes a security-sensitive execution boundary,
so implementation and deployment require explicit owner approval and an independent consequential
review. Once deployed, run `strix-real-r1` sequentially on Qwen3.6 and Qwen3.8 with the same caps and
deterministic oracle.
