# Qwen3.8-27B vs Qwen3.6-A3B: Gate D agentic coding comparison

**Status:** measured on M5, 2026-08-15. This is routing evidence, not an automatic route
promotion.

## Decision

Keep `qwen36-a3b` as the default fast local coding lane. It completed about twice as many
correct Gate D runs per observed minute as `qwen38-27b`.

Use `qwen38-27b` as a quality/escalation lane for broad multi-file edits where the extra
correctness is worth the latency. It passed every run, including the four-file rename that was
the only stable task-class failure for Qwen3.6.

Do not promote Qwen3.8 as the universal default from this result alone. The r1 corpus is small,
and Qwen3.8 exhibited a 378-second long tail on one otherwise-correct TDD run.

## Method

- Machine: one production M5 / Strix Halo 128 GB node.
- Harness: Pi `0.84.1`, native read/edit/write/bash loop.
- Corpus: Gate D `gate-d-r1`, ten deterministic coding tasks.
- Seeds: three runs per model and task, 30 runs per model.
- Grading: Gate D G1-G5 only; no model judge.
- Execution: sequential, one model at a time, 900-second per-run cap.
- Holdouts: r2 tasks 11-14 were deliberately not consumed.
- Profiles: the live deployed profiles were compared, not architecture-isolated configurations.
  Qwen3.6 runs non-thinking and sparse; Qwen3.8 uses its deployed reasoning/MTP-capable profile.
- Gate D source tree: `255b38e6f4a5e108140ac621a40c52455b291890`, identical between
  benchmark checkout `4a632965e37c16cefb403d54fa885cd518ee07a6` and the then-current
  `origin/main`.

Observed wall time includes model/harness execution and any residency effects. It is therefore a
product-path measurement, not a pure token-generation microbenchmark.

## Aggregate results

| Metric | Qwen3.6-A3B | Qwen3.8-27B |
|---|---:|---:|
| Raw passes | 26/30 (86.7%) | **30/30 (100%)** |
| Task classes passing by 2/3 majority | 9/10 | **10/10** |
| Total observed wall time | **901 s** | 2,089 s |
| Median run wall time | **29.5 s** | 55.5 s |
| P95 run wall time | **49 s** | 112 s |
| Maximum run wall time | **52 s** | 378 s |
| Correct runs per observed minute | **1.73** | 0.86 |

Qwen3.8 gained 13.3 percentage points of raw correctness and one task class. Qwen3.6 delivered
2.01 times as many correct runs per observed minute. Qwen3.8's complete matrix took 2.32 times as
long.

## Per-task evidence

`P` means all deterministic gates passed. Other labels name the failing gate. Times are seconds
in seed order.

| Task | Qwen3.6 outcomes | Qwen3.6 times | Qwen3.8 outcomes | Qwen3.8 times |
|---|---|---:|---|---:|
| 01 implement stub | P / P / P | 26 / 17 / 13 | P / P / P | 63 / 55 / 72 |
| 02 fix parsing bug | P / P / P | 19 / 40 / 16 | P / P / P | 42 / 38 / 47 |
| 03 two-file implementation | G2-no-edit / P / P | 29 / 37 / 36 | P / P / P | 81 / 61 / 51 |
| 04 add CLI flag | P / P / P | 24 / 52 / 48 | P / P / P | 60 / 80 / 83 |
| 05 TDD + hidden oracle | G4-oracle / P / P | 30 / 46 / 43 | P / P / P | 112 / 111 / 378 |
| 06 fix off-by-one | P / P / P | 27 / 36 / 41 | P / P / P | 56 / 47 / 27 |
| 07 extract helper | P / P / P | 16 / 18 / 18 | P / P / P | 53 / 71 / 54 |
| 08 add validation | P / P / P | 14 / 30 / 12 | P / P / P | 35 / 34 / 33 |
| 09 four-file rename | P / G5-structural / G5-structural | 49 / 36 / 22 | P / P / P | 54 / 64 / 43 |
| 10 shared-util regression | P / P / P | 47 / 20 / 39 | P / P / P | 74 / 51 / 59 |

Qwen3.6's seed-one failures on tasks 03 and 05 did not survive the majority rule. Its task 09
failure did: two of three runs left the broad rename structurally incomplete. Qwen3.8 completed
that class in all three runs.

## Product interpretation

The result supports a routed system rather than a winner-takes-all replacement:

- `qwen36-a3b`: routine edits, rapid iteration, tool selection, and latency-sensitive local work.
- `qwen38-27b`: broad rename/refactor work, quality-critical multi-file changes, and escalation
  after a fast-lane verification failure.
- Deterministic verification remains mandatory for either lane.

The next promotion-quality study should use fresh real-repository tasks with pre-registered
scoring and should capture turns, generated tokens, and model-only inference time. A separately
declared holdout run may use Gate D r2; this run intentionally preserved it.

## Evidence integrity

The content-blind raw rows are preserved in
[`evidence/gate-d-qwen36-vs-qwen38-2026-08-15.jsonl`](./evidence/gate-d-qwen36-vs-qwen38-2026-08-15.jsonl).

- Rows: 60
- Raw JSONL SHA-256: `e145e23040960e2bc126060810c02dff41d8d20e839d7500129cd25108132db0`
- Console log SHA-256: `0d414bcba24013f50cdfd180eda9762cffb724cfecf7baee1cd16be808fb7362`
- Fixture/source corruption check: clean
- Residual Gate D work directories: zero
- Arm errors/timeouts: zero
