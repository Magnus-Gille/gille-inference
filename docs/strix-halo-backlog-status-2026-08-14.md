# Strix Halo 128 GB backlog execution status

**Status date:** 14 August 2026

This is the execution ledger for the 25-ticket handoff. `Implemented` means the repository-owned
tooling is present and deterministically tested. It does **not** mean the hardware experiment has
passed. `Measured` requires reproducible Strix Halo evidence under the durable GPU lease and, where
needed, the exclusive maintenance fence tracked in issue #196.

## Current blockers

1. Qwen3.8 source staging, conversion, reference parity, the isolated Vulkan runtime, direct
   benchmarks, native-MTP canaries, Q8-KV selection, and multimodal serving have passed. The exact
   evidence and hashes are in `docs/qwen38-27b-release-decision-2026-08-14.md`.
2. Production promotion remains a separate reviewed mutation: copy the complete runtime and
   selected artifacts from staging to stable paths, verify hashes/runpaths/dependencies, back up
   and update the private roster, restart services, and run authenticated private/public canaries.
3. T20 still needs the common coding-agent suite before Qwen3.8 can become an automatic route.
   Explicit authenticated availability does not imply quality superiority or route promotion.

## Ticket matrix

| Ticket | State | Repository evidence / remaining proof |
|---:|---|---|
| T01 benchmark harness | **Implemented; first release measurements complete** | Direct `llama-bench` plus streaming server runners emit JSON/Markdown and cover PP, TG, TTFT, cache, speculation, concurrency, hashes, system/runtime fields, and useful completions/minute. Qwen3.8 pp512/tg128, pp8192, direct/MTP, and server canaries now provide the first controlled release evidence. Real power should come from a wall meter; hwmon is labelled explicitly. |
| T02 Qwen3-Coder baseline | **Blocked for measurement** | Harness ready. Exact 30B-A3B GGUFs/builds are not staged or verified in this session; live verification of #196 is still missing. |
| T03 Qwen3.6 direct baseline | **Blocked for measurement** | `qwen36-a3b` exists in the tracked roster at Q4_K_M, but the requested ROCmFP4 variants are not staged. Requires immutable build/model provenance and #196. |
| T04 native MTP | **Measured for Qwen3.8** | Native MTP depth 2 passed in the pinned Vulkan runtime: 21.68 tok/s with F16 KV and 23.21 tok/s with Q8 KV versus 12.84 tok/s direct in the matched short server workload. Draft acceptance was workload-dependent (57.6–66.1%). Broader adaptive-depth evidence remains T05. |
| T05 adaptive MTP | **Not implemented** | Requires measured cost/acceptance traces from T04 before a policy can satisfy “never materially slower.” Static guesswork is rejected. |
| T06 Vulkan vs HIP | **Comparison implemented; experiment blocked** | One-axis comparator enforces controlled provenance. Actual bake-off belongs to issue #129 and requires isolated builds plus deployed/verified #196. |
| T07 ROCmFPX | **Not integrated** | Requires reviewing/pinning the current external fork, compatible artifacts, and isolated Vulkan/HIP builds. No live runtime change is authorized. |
| T08 quant matrix | **Runner/comparator implemented; artifacts blocked** | `quant` is a controlled comparison axis; real Pareto evidence needs identical source revision, converted quants, and Gate D quality runs. |
| T09 KV matrix | **First Qwen3.8 F16/Q8 arm measured** | Q8 direct TG was within measurement noise of F16 (12.83 vs 12.87 tok/s), with similar pp512 (357.48 vs 361.40 tok/s), and won the sampled MTP canary (23.21 vs 21.68 tok/s). Q8 is selected for the 64K release profile. BF16/Q4 and broader model/context arms remain. |
| T10 persistent prefix cache | **In-memory path implemented; durability measurement blocked** | Gateway forces llama-server's exact-common-prefix cache, strips client-selected slot/reuse controls, and relies on token-prefix divergence to invalidate changed file/message suffixes without retaining repository paths or prompt content. Provenance and the `cache` A/B axis cover RAM cache/checkpoint settings and the runner records cache hits/end-to-end latency. Cache survival across model-process replacement is intentionally not claimed; exposing disk slot snapshots would require a separate private-content retention/authority contract. Issue #126 is a related context-compiler experiment, not a substitute for cache correctness. |
| T11 DFlash | **Upstream path verified; experiment blocked** | Current llama.cpp documents `draft-dflash`; runner can capture workload acceptance and speed. Exact target-specific drafter and M5 run remain. Glimmer tracking: issue #181. |
| T12 DSpark/DeepSpec | **Research premise updated; prototype not run** | Current llama.cpp already documents `draft-dspark`, so a new line-for-line CUDA port is no longer the first step. Benchmark the upstream backend path before writing AMD kernels. |
| T13 gfx1151 verification kernel | **Not started** | Only justified after T11/T12 profiling proves target verification is the bottleneck. Premature kernel work is explicitly deferred. |
| T14 HIP launch gaps | **Not started** | Requires paired rocprof/kernel-wall traces from isolated HIP build under issue #129. |
| T15 BF16 Flash Attention | **Not measured** | Runtime/feature revision must be pinned and compared through the KV/context matrix. |
| T16 Qwen3.8 ingest | **Implemented; release archived** | Official revision `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0` is public and ungated. Archived controls identify a dense multimodal `Qwen3_5ForConditionalGeneration` model with 27,781,427,952 BF16 parameters, hybrid linear/full attention, native MTP, and 262K context. The staging command remains fail-closed and non-live. |
| T17 Qwen3.8 conversion | **Complete for release artifacts** | All official source files were staged and hash-verified twice. BF16, Q8_0, Q6_K, Q5_K_M, Q4_K_M, and the separate BF16 mmproj were produced from the immutable revision with a pinned runtime. Transformers/BF16/Q4 parity produced the same deterministic final text; Q4_K_M and mmproj hashes are recorded in the release decision. |
| T18 first Qwen3.8 benchmark | **Measured** | Vulkan/RADV Q4_K_M produced 361.40 pp512 and 12.87 tg128 tok/s with F16 KV; Q8 produced 357.48/12.83. pp8192 measured 308.76 tok/s. The exact 64K server profile passed text, image, thinking, and non-thinking API canaries. |
| T19 Qwen3.8 speculation | **Native MTP measured and selected** | Native MTP depth 2 produced 21.68–23.21 tok/s in short text canaries and 21.33–23.68 tok/s in the final 64K text/vision profile, with 57.6–71.2% draft acceptance. It is selected for explicit production qualification; workload-aware/adaptive policy remains T05. |
| T20 Qwen3.8 vs Qwen3.6 | **Runtime evidence ready; quality A/B pending** | The verified Qwen3.8 artifact/runtime now exists and Gate D supplies deterministic coding tasks. Completed coding work per minute must still be compared before any automatic route change. Dense Qwen3.8's ~13 direct / ~21–25 MTP tok/s is much slower than the sparse Qwen3.6 throughput tier. |
| T21 Glimmer specialist | **Candidate only** | Existing gateway already passes multimodal `image_url` content and serves Gemma4+mmproj. Glimmer qualification/discovery remains issue #181; roster promotion is not authorized. |
| T22 model router | **Implemented as evidence-gated routing; profile qualification blocked** | The gateway/orchestrator already performs task-aware routing through the generated capability table and fails safe to the frontier for unsupported lanes. FAST/BALANCED/DEEP/VISION/MAX remain descriptive product tiers rather than static aliases: assigning them before the issue #124 model/profile experiments would bypass the repository's evidence-before-autonomy invariant. Glimmer/MAX qualification remains separate roster work. |
| T23 coding-agent suite | **Existing and verified** | Gate D has 14 isolated real-edit fixtures with deterministic compile/test/structural oracles and resumable model/harness runs. New models must run the same pinned corpus; no replacement suite is needed. |
| T24 concurrent agents | **Runner implemented; measurement blocked** | Streaming runner covers 1/2/4/8 and useful work/minute. Existing Gate C remains the admission/preemption/soak control. Requires M5 access/window. |
| T25 OS/power/memory profile | **Read-only capture implemented; Strix A/B blocked** | `npm run benchmark:strix-host` emits mode-0600 JSON/Markdown with the operator-observed BIOS UMA setting, kernel/Mesa/ROCm, memory, allow-listed AMD/TTM parameters, power profile, governor, DRM memory/clocks, and labelled hwmon observations. Missing sensors remain `null`, and raw kernel argv is never retained. A local non-Strix smoke test and deterministic tests prove the capture path; issue #195 still owns the one-variable M5 A/B after #196 is deployed and verified. BIOS/kernel/driver changes remain explicitly outside this branch. |

## Work order from this state

1. Review the Qwen3.8 release commit and exact production mutation object; after owner approval,
   promote the complete hashed runtime/model bundle to stable paths, update the private roster,
   restart, and run authenticated private/public rollback-aware canaries.
2. Run the common Gate D coding suite for T20 before considering an automatic Qwen3.8 route.
3. Run T02/T03/T06 and the remaining T09 arms under the controlled maintenance path.
4. Use the expanded traces to decide whether T05/T13/T14 kernel/runtime work is justified.
5. Qualify Glimmer through issue #181 before any separate T21/T22 production route change.
