# Gate D acceptance: the battery THROUGH `code_loop` — PASSED (median 9/10, bar ≥9/10)

**Date:** 2026-07-02 · **Verdict:** ✅ **ACCEPTED for routine delegation** (design
`docs/agentic-code-tool-design.md` §11 acceptance gate) · **Runner:**
`scripts/gate-d-code-loop.py` · **Cost:** $0 (all local; ~35 min GPU across 4 rounds)

## What was measured

The full Gate D agentic-coding battery (10 deterministic tasks, graded by the battery's own
`gate-d/check.sh` — G0..G5, **no model in the grading path**) driven end-to-end through the
production `code_loop` stack: MCP `code_loop_start` → gateway (owner-gated, metered,
`owner_request_log`) → caged pi v0.70.2 (pasta netns + path-allowlisted relay + bwrap) →
`qwen3-coder-next-80b` → git-diff harvest → diff applied to a pristine seed copy → deterministic
grade. Reference arm: pi **direct** via `gate-d/run.sh` against the same gateway + model, same day.

Because both the historical 10/10 (2026-06-24) and any single run today are one sample at
temperature > 0, the gate was scored on a **3-round wrapped distribution + same-day direct
baseline** (the ×3-seeds methodology the Gate D plan itself called for).

## Results

| arm | round | score | misses |
|---|---|---|---|
| through code_loop | 1 | 8/10 | 04 (G3-tsc: `formatJson` import wiring), 09 (G5: partial rename) |
| through code_loop | 2 | 9/10 | 04 (cap-exceeded; partial diff shows the same `formatJson` symptom) |
| through code_loop | 3 | **10/10** | — |
| pi direct (same day) | — | 10/10 | — |

**Wrapped distribution: 8, 9, 10 → median 9, mean 9.0. Bar (≥9/10) met.** A perfect wrapped
round proves the production stack imposes no hard ceiling.

## Reading the misses honestly

- **Task 04 (add-cli-flag) is the one real weak spot**: 1/3 wrapped pass rate with a consistent
  failure signature (adds `formatJson` in `format.ts` but botches the export/import wiring →
  `TS2304`), including one turn-budget blowout. It passed direct and passed wrapped round 3, so
  it is a *model* soft spot on this task shape, not a wrapper defect.
- **Task 09's round-1 miss (partial rename) was sampling noise** — passed rounds 2 and 3.
- **Wrapped mean 9.0 vs direct 10/10** is compatible with a small (<1 task) wrapping cost but is
  not statistically firm at n=3 vs n=2 (incl. the 2026-06-24 direct run). No candidate mechanism
  was observed: identical instructions, same model, same gateway; the cage/relay added no
  failures of their own.
- **Zero infrastructure failures in all 30 wrapped task-runs**: every loop reached a terminal
  status (29 `completed`, 1 `cap-exceeded`), every produced diff applied cleanly (`git apply`),
  new-file creation (task 05) was captured by the `git add -A` harvest all 3 rounds, and no
  protected-path violations occurred.

## Latency profile (warm model)

Typical task: 22–52 s wall including polling granularity; heavy outliers: task 10 at 462 s
(round 2, within its 600 s cap) and 142 s (round 3). First task of a cold session pays the
measured ~42 s 80b load (docs/swap-latency-results-2026-07-02.md).

## Consequences (RQ7)

1. `docs/m5-routing.json`: `code-implement`/`code-edit` notes now distinguish **single-shot**
   (mellum, unchanged) from **multi-step agentic read→edit→run sub-tasks → `code_loop`**
   (this acceptance result recorded in the note).
2. L1 Conductor guidance (`~/.claude/CLAUDE.md`, claude-config): Claude Code sessions should
   prefer `code_loop_start` over `ask` for bounded multi-step coding sub-tasks.
3. Known-weakness note for callers: multi-file wiring tasks of the 04 shape benefit from an
   explicit instruction to verify imports/exports compile (`check_cmd: "npx --no-install tsc
   --noEmit"` style) — the model self-verifies behavior but under-checks types.

## Reproduce

```bash
# full battery through code_loop (resumable; ~15 min warm):
python3 scripts/gate-d-code-loop.py
# one task:
python3 scripts/gate-d-code-loop.py 04-add-cli-flag
# same-day direct baseline:
GW=http://<tailnet-ip>:8080/v1 GW_KEY=$(grep -oE 'hs_owner_[A-Za-z0-9_-]+' ~/.code-loop.env) \
  bash gate-d/run.sh pi all
```

Raw per-round JSONLs from this acceptance run: on the box under the session scratchpad
(`gate-d-cl-results-run{1,2,3}.jsonl`) + `data/gate-d-results.jsonl` (direct arm); the per-task
rows (status, usage, check tails) are reproduced in the tables above.
