# Strix Halo inference research and optimization checkpoint

**Date:** 15 August 2026

**Decision:** improve agent-benchmark telemetry and retain the current runtime profiles; no
production runtime or model deployment in this checkpoint.

## Live prefix-cache follow-up

A committed content-blind probe now exercises cold and warm plain prompts, cold and warm tool
turns, and an exact repeat after extending the tool conversation. It refuses live execution when
its source files are dirty, binds every result to the probe commit plus immutable server/model
provenance, separates declared quota waits from request latency, and retains neither prompts nor
model output. Raw private operational evidence remains mode 0600 under the gitignored
`data/strix-benchmarks/` tree.

The first live run is **LOCAL-MEASURED** on Qwen3.6-35B-A3B Q4_K_M, Vulkan/RADV, 131072
configured context, F16 KV, Flash Attention, one slot, no speculation, kernel 7.0.0-28, Mesa
26.0.3, and llama.cpp `8086439a4cea94c71a5dfb8fe4ad1546aebd640f`:

| Phase | Actual prompt | Cached | Evaluated | Server prefill |
|---|---:|---:|---:|---:|
| plain cold | 26,835 | 0 | 26,835 | 33,495 ms |
| plain exact warm | 26,835 | 26,819 | 16 | 110 ms |
| tool cold | 27,153 | 0 | 27,153 | 33,881 ms |
| tool exact warm | 27,153 | 27,137 | 16 | 111 ms |
| extended tool turn, first | 27,227 | 27,137 | 90 | 339 ms |
| extended tool turn, exact repeat | 27,227 | 27,137 | 90 | 338 ms |

The plain and tool warm controls are roughly 304–305 times faster in server prefill time than
their cold controls. The extended request pays a reproducible 74-token / roughly 228 ms tail over
the warm control, but this is inside the runtime's measured 256-token checkpoint-minimum policy.
The checkpoint-aware oracle therefore reports **healthy**, not a cache-invalidation regression.
Configured context is reported separately from the actually populated 26.8–27.2K tokens.

Upstream llama.cpp PR [#24891](https://github.com/ggml-org/llama.cpp/pull/24891) claims a distinct
multi-tool-turn checkpoint invalidation fix and reports large external prefill reductions. It is
open, review-required, and has no substantive CI beyond the labeler at this checkpoint.

The stronger local control is now complete. Sixteen sequential tool cycles generated 7,786 tokens;
all sixteen generations crossed the 256-token interval. The 8,955-token initial prompt already
spanned more than 32 checkpoint intervals, and the long generations added roughly 30 more:

| Stress result | LOCAL-MEASURED |
|---|---:|
| Final actual prompt | 18,466 tokens |
| Final cached prefix | 18,419 tokens |
| Final exact-audit evaluation | **47 tokens / 219 ms** |
| Checkpoint-aware failure bound | 280 tokens |
| Crossing generations | 16/16 |

Each full-size cycle extended the input by 624 tokens while the next request cached 624 additional
tokens and evaluated a stable 671-token suffix; the 47-token difference is exactly what the final
audit retained as its uncached tail. No progressive invalidation appeared as the conversation grew.
This does not disprove #24891 for every template/runtime/workload, but it falsifies the deployment
premise for this exact Qwen3.6 production profile and synthetic multi-tool control. **Decision: do
not patch or build #24891 for promotion.** Revisit only if an organic trace or a stronger exact
reproducer turns the control red.

**Deployment decision: no.** No model, runtime, driver, route, or live configuration changed. The
rollback for the new probe is a normal Git revert; the benchmark itself is read-only apart from
ordinary prompt-cache state.

## Next selected mechanism: iGPU mmap policy

llama.cpp PR [#26081](https://github.com/ggml-org/llama.cpp/pull/26081), merged 11 August 2026,
adds a backend capability and makes automatic model loading avoid mmap on iGPUs where weights are
copied into device-visible shared memory. This is **REPORTED/upstream mechanism evidence**, not a
local performance result. It is directly relevant to Strix Halo model swaps and routing because
duplicated host/device-visible residency can increase peak memory and cold-load time.

The current Qwen3.6 runtime predates the automatic policy but already exposes explicit `--mmap`
and `--no-mmap`. A repository-owned ABBA harness now tests those flags on the same pinned binary,
model, Vulkan backend, 131K context, and serving arguments; it records startup, memory pressure,
first/warm TTFT, PP/TG, exact output hashes, and automatic llama-swap residency restoration. This
isolates the mechanism from the much larger confound of upgrading two months of llama.cpp changes.

**Local A/B result: not run yet.** The experiment unloads the currently resident production model
inside a bounded all-traffic maintenance window, so its exact mutation object requires a fresh
operator confirmation. No config or service was changed while preparing the harness.

## Adaptive speculation preparation

The server benchmark already captured useful completions/minute, quality-oracle results, draft
acceptance, and per-concurrency cells, but its pairwise comparator deliberately stopped short of a
promotion decision. A new offline policy synthesizer now consumes one direct report plus any number
of speculative-depth reports. It changes no runtime configuration. Per measured workload and
concurrency cell, it selects the highest useful-work arm only when quality is non-inferior, draft
acceptance is observable, and the arm clears an explicit useful-work margin. Missing evidence,
inferior quality, and slower speculation all select direct decoding.

The promotion artifact now also requires at least three repeated batches per cell by default,
request count equal to batches times concurrency, internally consistent success/oracle counters,
acceptance bounded to zero through one, and exactly balanced direct/candidate exposure. A malformed
or under-sampled direct arm marks the cell's evidence insufficient; a malformed or under-sampled
candidate is rejected while direct remains selected. This closes the possibility of promoting from
a one-batch speed spike, but it deliberately does not claim statistical confidence or immunity to
thermal/runtime drift; the hardware design still needs mirrored cycles.

The selector now validates and pairs the raw content-blind repetition batches as well. Aggregate
useful-work gain is insufficient when any individual candidate repetition loses successful or
oracle-passing requests or falls below direct useful completions/minute. It rejects missing,
duplicate, hidden, non-contiguous, and summary-inconsistent repetition evidence, and requires draft
acceptance in every speculative batch. This is a deterministic “no observed repetition slower”
gate, not a statistical claim about unobserved workloads.

This is repository-local enforcement of the evaluation rule “speculation must not remain selected
when it is slower”; it is **not** an online rolling controller and does not complete T05. The next
hardware run must capture direct, depth-1, depth-2, and any deeper supported arm against the same
agent fixtures and concurrency matrix before a policy can be synthesized for production review.

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
| Vulkan coopmat1 Q8 KV dequantize-once path ([#25494](https://github.com/ggml-org/llama.cpp/pull/25494)) | **EXTERNAL-MEASURED:** exact Strix/RADV report shows pp512 +41% at 32K and +68% at 64K actual depth with Q8 K/V; TG unchanged | High for prompt-heavy agents and long populated contexts; the current eight-commit upstream head still matches the pinned backport | Highest-value runtime candidate; isolated M5 build and fail-closed two-cycle combined runner pass deterministic checks, GPU A/B pending exact maintenance confirmation |
| Long-generation corruption signal ([community report](https://www.reddit.com/r/StrixHalo/comments/1vjopen/psa_llamacpp_currently_broken_on_strix_halo/)) | **REPORTED:** Qwen3.6-27B output reportedly degrades after roughly 1–2K generated tokens; the evolving report mixes MTP, mmap, HIP launch ordering, sampling, and Vulkan observations | Exact hardware but not an isolated reproduction or upstream bug report | Do not change production from this report. Add a stock-versus-candidate 4K deterministic generation gate so short smoke tests cannot advance a corrupt runtime |
| HIP unsafe-math determinism fix ([#26696](https://github.com/ggml-org/llama.cpp/pull/26696)) | **UPSTREAM/EXTERNAL-MEASURED:** merged 13 August after gfx1151 MTP greedy divergence was reproduced with unsafe FP reassociation; maintainers note other batch/numeric causes can also diverge | Relevant correctness precedent, but the pinned production revision predates the unsafe-math regression and this candidate is Vulkan/direct | No production change. Preserve direct same-batch long-generation comparison as a candidate-specific fail-closed gate |
| backend split scheduler race ([#26040](https://github.com/ggml-org/llama.cpp/pull/26040)) | **UPSTREAM:** open fix for asynchronous backend split reuse/overwrite, including Vulkan-sensitive scheduling | A plausible class of late-output corruption, but no evidence ties it to the pinned single-GPU profile | Track; do not backport without a local red reproducer and one-variable A/B |
| llama.cpp iGPU automatic no-mmap load policy ([#26081](https://github.com/ggml-org/llama.cpp/pull/26081)) | **REPORTED/upstream:** merged capability change targets iGPUs that copy weights into device-visible shared memory | High for Strix cold model swaps and peak memory; deployed runtime supports an exact-flag mechanism A/B | Selected next; ABBA runner implemented and locally tested, hardware mutation pending exact maintenance confirmation |
| llama.cpp many-expert Vulkan threshold patch ([#25356](https://github.com/ggml-org/llama.cpp/issues/25356)) | **EXTERNAL-MEASURED:** exact 128 GB Strix/RADV report shows no change through batch 8, then +56% at batch 9, +34% at 16, +20% at 32 | High only for nine or more simultaneous sequences | Reject for current one-slot / practical two-user production workload; revisit if concurrency policy changes |
| llama.cpp DFlash on quantized MoE HIP ([#25117](https://github.com/ggml-org/llama.cpp/issues/25117)) | **EXTERNAL-MEASURED:** exact Strix report shows 19.5 tok/s direct versus 9.4 DFlash | Exact hardware, but a clear regression in the reported arm | Do not implement this HIP path; require a different drafter/backend or new upstream evidence |
| DFlash concurrency corruption ([#27117](https://github.com/ggml-org/llama.cpp/issues/27117)) | **EXTERNAL-MEASURED:** exact gfx1151/ROCm report on current master shows acceptance collapsing at 16 active sequences; depth 15 delivered roughly 17–21 tok/s versus 37 direct, while depth 1 recovered to roughly 80 tok/s | Direct evidence that method/depth must be workload- and concurrency-specific on Strix | Do not promote a static deep-DFlash profile. Add depth 1 and all intended concurrency cells to the controlled policy matrix; direct is the fail-closed fallback |
| MTP acceptance regression after b10430 ([#27106](https://github.com/ggml-org/llama.cpp/issues/27106)) | **REPORTED/upstream issue:** CUDA and SYCL users report Qwen3.6/Qwen3.8 MTP acceptance falling from roughly 0.7 to roughly 0.5 | Not reproduced on gfx1151, but relevant to any future llama.cpp runtime uplift | Require direct/MTP acceptance and useful-work A/B on the exact candidate commit; do not carry the existing depth-2 assumption across runtime upgrades |
| Native BF16 Flash-Attention tiles ([#26856](https://github.com/ggml-org/llama.cpp/pull/26856)) | **EXTERNAL-MEASURED:** exact Strix Qwen3.5-4B report shows +13.5% pp1024 at 8K and +11.4% at 16K versus F16 KV, generation parity; gfx1151-specific BF16 instructions are used | Strong prompt-heavy HIP candidate with a precision benefit at depth, but open and not measured on the production models | Rank behind the already-built Q8-Vulkan candidate; pin and test as the next HIP/KV matrix arm rather than assuming backend-wide superiority |
| Shared target/drafter thread pools ([#27143](https://github.com/ggml-org/llama.cpp/pull/27143)) | **UPSTREAM mechanism only:** draft PR removes separate pools because target and drafter do not compute concurrently; no performance data supplied | Could reduce speculative setup/resource overhead, but the current patch touches only the example and depends on another open PR | Track; do not build until the common server path lands and an exact-hardware benchmark claim exists |
| HIP APU memory accounting ([#27083](https://github.com/ggml-org/llama.cpp/pull/27083)) | **UPSTREAM correctness:** open PR keeps HIP APUs on `hipMemGetInfo` instead of a DGX-oriented UMA override that can over-promise memory | Exact topology relevance; protects residency/admission rather than inference speed | Carry into any future HIP uplift review; not a standalone performance candidate |
| Vulkan versus HIP and MTP Strix observations ([discussion #20856](https://github.com/ggml-org/llama.cpp/discussions/20856)) | **REPORTED/EXTERNAL-MEASURED:** recent builds show Vulkan ahead for batch-one decode, HIP ahead for prompt processing, and workload-sensitive MTP gains | Matches hypotheses H1, H2, H4 but is not our immutable local A/B | Retain Vulkan as the interactive reference; keep a controlled HIP prompt-heavy bake-off on the backlog |
| large-context Vulkan decay ([#24483](https://github.com/ggml-org/llama.cpp/issues/24483)) | **EXTERNAL-MEASURED:** generation falls materially as actual context fills; Q8 KV remains close to F16 in the cited arm | Directly challenges configured-context shorthand | Require actual populated context in every leaderboard and promotion record |
| Mesa 26.2.0 ([release notes](https://docs.mesa3d.org/relnotes/26.2.0.html)) | **UPSTREAM:** new RADV work, but the release is marked development and advises stability users to wait for 26.2.1 | Potentially relevant, no cited llama.cpp/gfx1151 win | Do not upgrade production for novelty; wait for stable point release plus a one-variable A/B candidate |
| ROCm 7.2.3 ([release page](https://github.com/ROCm/ROCm/releases)) | **UPSTREAM:** current line includes gfx1151 support | Support does not prove batch-one decode parity | No backend promotion without local decode, prompt, concurrency, and correctness A/B |

### Model-release triage

The official Hugging Face metadata/config sweep found several new or freshly updated artifacts, but
none is a single-128-GB candidate:

| Artifact | Immutable metadata | Architecture / active path | Strix fit decision |
|---|---|---|---|
| [Qwen3.8-2.4T-A95B](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B) | **UPSTREAM:** `207bd685...`; 2.446T BF16 parameters; updated 12 August | 512 experts, 10 routed/token, one shared expert, 92 layers, one MTP layer, 262K context | Reject for this node. Even an idealized uniform 2-bit weight image is roughly 612 GB before runtime/KV overhead; active bytes/token do not remove the total-residency requirement |
| [DeepSeek-V4-Pro-0813](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813) / [NVIDIA NVFP4 DSpark](https://huggingface.co/nvidia/DeepSeek-V4-Pro-nvfp4-DSpark) | **UPSTREAM:** official model has 1.650T parameters; NVIDIA artifact updated 15 August and reports roughly 944 GB repository storage | 384 routed experts, 6/token, one shared expert, one next-token layer, DSpark metadata, 1M context | Monitor the DSpark mechanism, not this artifact. It is NVIDIA NVFP4 and cannot reside on 128 GB |
| [Kimi-K3 NVFP4](https://huggingface.co/nvidia/Kimi-K3-NVFP4) | **UPSTREAM:** `1ec10fa...`; 1.419T parameters; updated 15 August | multimodal linear-attention/MoE, 896 experts, 16/token, 93 layers, 1M context; NVIDIA mixed NVFP4/FP8 | Reject artifact for this node: wrong backend format and far beyond residency. Revisit only if an AMD/llama-compatible protected quant demonstrates a sub-128-GB image, which current parameter accounting makes implausible |
| [Nemotron Labs Teacher STEM](https://huggingface.co/nvidia/NVIDIA-Nemotron-Labs-Teacher-STEM) | **UPSTREAM:** `cf8545f...`; 560.5B BF16 parameters; created 14 August | latent MoE/Mamba hybrid, 512 experts, 22/token, one MTP layer, 262K context | Reject for deployment. The idealized 2-bit weights alone are roughly 140 GB, leaving no runtime or KV headroom |

These are discovery signals, not leaderboard entrants. Their sparse active paths remain technically
interesting, but total model residency is the first eligibility gate on this machine.

No exact-hardware development discovered in this sweep has yet cleared the bar for a reversible
production runtime change. The Q8 KV dequantize-once path remains the strongest test candidate: it
has a narrow mechanism, exact-hardware evidence, a clean exact-production backport, and a passing
M5 build, but no local GPU correctness or A/B result. Its combined experiment now requires a
content-blind 4K-token production/candidate equivalence check before performance measurements. See
[`strix-kv-dequant-candidate-2026-08-15.md`](strix-kv-dequant-candidate-2026-08-15.md).

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
| Speculation A/B | pairwise metrics with no fail-closed selection artifact | content-blind per-workload/concurrency policy selects only quality-safe useful-work winners; all other cells use direct |

## Deployment and rollback

**Deployed? No.** No live model, backend, driver, kernel, service, route, or production
configuration changed. The telemetry and offline speculation policy affect only future benchmark
and review workflows.

Rollback is a normal Git revert of the telemetry commit. It restores the old Pi redirection and
result schema; there is no production state to restore.

## Verification

- focused server-benchmark, comparator, and speculation-policy tests: 39/39 passed;
- TypeScript and constitutional typechecks: passed;
- full repository suite: 286 files, 4,293 tests passed (including the long-generation gate);
- Bash syntax and `git diff --check`: passed;
- direct recorder CLI smoke: passed with mode-0600 raw and summary files.

## Next most valuable experiment

The pinned Vulkan Q8-KV dequantize-once candidate remains first: its exact-Strix external result is
the largest narrow prompt-processing gain in the current queue, the exact-production backport
already builds, and the combined correctness/long-generation/ABBA runner is ready. Execute it only
under the repository-owned exclusive window and exact mutation confirmation; the current Tailscale
SSH session requires an interactive owner check, so no hardware result is claimed here.

When live access is restored, capture a separate direct/depth-1/depth-2 speculation matrix across
the intended workload/concurrency cells and feed it to the new fail-closed policy tool. This is the
smallest evidence path toward T05 and directly tests the fresh gfx1151 concurrency failure instead
of assuming that the current depth-2 profile generalizes.

The BF16 Flash-Attention PR is the next isolated HIP/KV build candidate after Q8-KV. The fresh
`strix-real-r1` comparison still needs an allow-listed model selector in the OS cage; that
security-boundary change remains approval- and independent-review-gated. No broad “latest is
better” runtime or model promotion is allowed.
