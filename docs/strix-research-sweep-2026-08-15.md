# Strix Halo inference research and optimization checkpoint

**Date:** 15 August 2026

**Decision:** improve agent-benchmark telemetry and retain the current runtime profiles; no
production runtime or model deployment in this checkpoint.

## What changed

Gate D's Pi arm now records content-blind turns, tool calls, prompt tokens, completion tokens,
observed model-turn time, post-first-event assistant stream time, timing coverage counts, and
unparseable event lines. It keeps raw model/tool events inside the throwaway task directory and
deletes them after grading unless bounded diagnosis is explicitly requested.

The matched Qwen3.6/Qwen3.8 result and raw content-blind evidence are now carried with this branch,
and the current leaderboard is recorded in both JSON and Markdown.

## Why it matters

The primary objective is useful agentic work per minute. Gate D previously emitted only pass/fail
and wall time, so it could not separate model inference, prompt growth, tool-loop overhead, and
extra turns. That gap would make an adaptive-speculation or routing experiment hard to explain and
easy to overclaim.

The recorder deliberately separates Pi's `turn_start`→assistant `message_end` span
(`modelTurnMs`) from its first-assistant-event→assistant `message_end` span
(`assistantStreamMs`). The former includes gateway/queue/prefill/decode latency plus small client
overhead and excludes tool execution; the latter excludes TTFT. Missing spans stay null. Neither is
mislabelled as pure on-device inference time, and total wall time is never relabelled as model-only
time.

## Research triage

| Candidate | Evidence | Exact-hardware relevance | Decision |
|---|---|---|---|
| llama.cpp many-expert Vulkan threshold patch ([#25356](https://github.com/ggml-org/llama.cpp/issues/25356)) | **EXTERNAL-MEASURED:** exact 128 GB Strix/RADV report shows no change through batch 8, then +56% at batch 9, +34% at 16, +20% at 32 | High only for nine or more simultaneous sequences | Reject for current one-slot / practical two-user production workload; revisit if concurrency policy changes |
| llama.cpp DFlash on quantized MoE HIP ([#25117](https://github.com/ggml-org/llama.cpp/issues/25117)) | **EXTERNAL-MEASURED:** exact Strix report shows 19.5 tok/s direct versus 9.4 DFlash | Exact hardware, but a clear regression in the reported arm | Do not implement this HIP path; require a different drafter/backend or new upstream evidence |
| Vulkan versus HIP and MTP Strix observations ([discussion #20856](https://github.com/ggml-org/llama.cpp/discussions/20856)) | **REPORTED/EXTERNAL-MEASURED:** recent builds show Vulkan ahead for batch-one decode, HIP ahead for prompt processing, and workload-sensitive MTP gains | Matches hypotheses H1, H2, H4 but is not our immutable local A/B | Retain Vulkan as the interactive reference; keep a controlled HIP prompt-heavy bake-off on the backlog |
| large-context Vulkan decay ([#24483](https://github.com/ggml-org/llama.cpp/issues/24483)) | **EXTERNAL-MEASURED:** generation falls materially as actual context fills; Q8 KV remains close to F16 in the cited arm | Directly challenges configured-context shorthand | Require actual populated context in every leaderboard and promotion record |
| Mesa 26.2.0 ([release notes](https://docs.mesa3d.org/relnotes/26.2.0.html)) | **UPSTREAM:** new RADV work, but the release is marked development and advises stability users to wait for 26.2.1 | Potentially relevant, no cited llama.cpp/gfx1151 win | Do not upgrade production for novelty; wait for stable point release plus a one-variable A/B candidate |
| ROCm 7.2.3 ([release page](https://github.com/ROCm/ROCm/releases)) | **UPSTREAM:** current line includes gfx1151 support | Support does not prove batch-one decode parity | No backend promotion without local decode, prompt, concurrency, and correctness A/B |

No exact-hardware development discovered in this sweep cleared the bar for a reversible production
runtime change. The batch-nine Vulkan patch is the largest reported gain, but it optimizes a load
shape the current serialized GPU policy does not serve.

## Local A/B result

The already completed matched Gate D run is **LOCAL-MEASURED**:

| Profile | Correctness | Observed wall | Correct runs/minute | Decision |
|---|---:|---:|---:|---|
| Qwen3.6-35B-A3B | 26/30 | 901 s | **1.73** | default fast coding lane |
| Qwen3.8-27B | **30/30** | 2,089 s | 0.86 | broad-edit / quality escalation |

Qwen3.6 delivered 2.01 times as many correct runs per observed minute. Qwen3.8 gained one stable
task class—the four-file rename—but had a 378-second correct-run tail. See
[`qwen38-vs-qwen36-gate-d-2026-08-15.md`](qwen38-vs-qwen36-gate-d-2026-08-15.md).

This was a deployed-profile product comparison, not an architecture-isolated microbenchmark. Its
old rows do not contain the new token/turn/model-time telemetry, so those fields are not
retroactively inferred.

## Before and after

| | Before | After |
|---|---|---|
| Gate D result row | pass, exit class, total wall time | same fields plus turns, tool calls, prompt/completion tokens, model-turn time, assistant-stream time, timing coverage, parse gaps |
| Model-only time when unavailable | absent | explicit `null` |
| Raw Pi content | temporary mixed stdout/stderr log | temporary mode-0600 NDJSON and separate stderr, deleted after grading by default |
| Routing decision | Qwen comparison stranded on an unpublished branch | reproducible report/evidence carried with this optimization branch |
| Leaderboard | no single current Strix artifact | machine-readable JSON plus scoped human-readable categories |

## Deployment and rollback

**Deployed? No.** No live model, backend, driver, kernel, service, route, or production
configuration changed. The telemetry affects only future benchmark runs.

Rollback is a normal Git revert of the telemetry commit. It restores the old Pi redirection and
result schema; there is no production state to restore.

## Verification

- focused telemetry tests: 3/3 passed;
- TypeScript and constitutional typechecks: passed;
- full repository suite outside the restricted sandbox: 273 files, 4,237 tests passed;
- Bash syntax and `git diff --check`: passed;
- direct recorder CLI smoke: passed with mode-0600 raw and summary files.

## Next most valuable experiment

Run fresh, preregistered real-repository coding tasks through Qwen3.6 and Qwen3.8 using the new
telemetry. Capture deterministic success, wall time, turns, tool calls, prompt/completion tokens,
model-turn time, assistant-stream time, retries, and test outcomes. This directly tests H8: whether
dense Qwen3.8's extra correctness reduces total iterations enough to beat the faster MoE on
realistic work.
