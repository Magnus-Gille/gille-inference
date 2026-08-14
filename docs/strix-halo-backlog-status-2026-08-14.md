# Strix Halo 128 GB backlog execution status

**Status date:** 14 August 2026

This is the execution ledger for the 25-ticket handoff. `Implemented` means the repository-owned
tooling is present and deterministically tested. It does **not** mean the hardware experiment has
passed. `Measured` requires reproducible Strix Halo evidence under the durable GPU lease and, where
needed, the exclusive maintenance fence tracked in issue #196.

## Current blockers

1. `Qwen/Qwen3.8-27B` is not publicly available through the anonymous official Hub API, so T17–T20
   cannot start from immutable official bytes.
2. The canonical Codex M5 profile is restored and `doctor` reports both public and private paths
   healthy. A bounded review call encountered `busy` and then timed out, so no local-review result
   was used; read-only M5 inventory remains available. Hardware experiments still require the
   canonical GPU lease and verified exclusive maintenance path.
3. Issue #196 is implemented and deterministically tested on this branch: the isolated gateway
   identity acquires the canonical GPU lease, explicit exclusive admission blocks both lanes,
   admitted/queued work drains, llama-swap residency must be stable and non-starting, and the
   client restores on completion/failure/signals with a server TTL backstop. It is not deployed or
   verified against the post-isolation live paths, so uncontaminated hardware experiments remain
   blocked until an accepted revision is deployed and the operator path is proven on M5.
4. Model downloads, runtime builds, live roster changes, service restarts, and OS/power changes are
   separate reviewed mutations. This branch performs none of them.

## Ticket matrix

| Ticket | State | Repository evidence / remaining proof |
|---:|---|---|
| T01 benchmark harness | **Implemented; not yet measured** | Direct `llama-bench` plus streaming server runners emit JSON/Markdown and cover PP, TG, TTFT, cache, speculation, concurrency, hashes, system/runtime fields, and useful completions/minute. Real power should come from a wall meter; hwmon is labelled explicitly. |
| T02 Qwen3-Coder baseline | **Blocked for measurement** | Harness ready. Exact 30B-A3B GGUFs/builds are not staged or verified in this session; M5 access and live verification of #196 are missing. |
| T03 Qwen3.6 direct baseline | **Blocked for measurement** | `qwen36-a3b` exists in the tracked roster at Q4_K_M, but the requested ROCmFP4 variants are not staged. Requires immutable build/model provenance and #196. |
| T04 native MTP | **Runner implemented; experiment blocked** | Server runner records acceptance from official llama.cpp metrics and supports speculation comparisons. Target/MTP artifact and reviewed runtime must be built under issue #130. |
| T05 adaptive MTP | **Not implemented** | Requires measured cost/acceptance traces from T04 before a policy can satisfy “never materially slower.” Static guesswork is rejected. |
| T06 Vulkan vs HIP | **Comparison implemented; experiment blocked** | One-axis comparator enforces controlled provenance. Actual bake-off belongs to issue #129 and requires isolated builds plus deployed/verified #196. |
| T07 ROCmFPX | **Not integrated** | Requires reviewing/pinning the current external fork, compatible artifacts, and isolated Vulkan/HIP builds. No live runtime change is authorized. |
| T08 quant matrix | **Runner/comparator implemented; artifacts blocked** | `quant` is a controlled comparison axis; real Pareto evidence needs identical source revision, converted quants, and Gate D quality runs. |
| T09 KV matrix | **Runner/comparator implemented; measurement blocked** | Direct runner accepts F16/BF16/Q8/Q4 and context tiers; `kv` comparison is fail-closed. Requires model/runtime arms on M5. |
| T10 persistent prefix cache | **In-memory path implemented; durability measurement blocked** | Gateway forces llama-server's exact-common-prefix cache, strips client-selected slot/reuse controls, and relies on token-prefix divergence to invalidate changed file/message suffixes without retaining repository paths or prompt content. Provenance and the `cache` A/B axis cover RAM cache/checkpoint settings and the runner records cache hits/end-to-end latency. Cache survival across model-process replacement is intentionally not claimed; exposing disk slot snapshots would require a separate private-content retention/authority contract. Issue #126 is a related context-compiler experiment, not a substitute for cache correctness. |
| T11 DFlash | **Upstream path verified; experiment blocked** | Current llama.cpp documents `draft-dflash`; runner can capture workload acceptance and speed. Exact target-specific drafter and M5 run remain. Glimmer tracking: issue #181. |
| T12 DSpark/DeepSpec | **Research premise updated; prototype not run** | Current llama.cpp already documents `draft-dspark`, so a new line-for-line CUDA port is no longer the first step. Benchmark the upstream backend path before writing AMD kernels. |
| T13 gfx1151 verification kernel | **Not started** | Only justified after T11/T12 profiling proves target verification is the bottleneck. Premature kernel work is explicitly deferred. |
| T14 HIP launch gaps | **Not started** | Requires paired rocprof/kernel-wall traces from isolated HIP build under issue #129. |
| T15 BF16 Flash Attention | **Not measured** | Runtime/feature revision must be pinned and compared through the KV/context matrix. |
| T16 Qwen3.8 ingest | **Implemented; target unavailable** | Public-only immutable ingestion archives control files, hashes them, and reports architecture without fetching weights or guessing unknowns. A separate fail-closed source staging command follows bounded pinned pagination, verifies exact indexed LFS size/SHA-256, preserves a disk reserve, resumes interrupted downloads, and atomically publishes only complete revisions without touching the live roster. |
| T17 Qwen3.8 conversion | **Source staging implemented; release blocked** | No official 27B source bytes/config. Once public, the exact source revision can be staged and hash-verified; conversion still requires a pinned transformers/llama.cpp architecture path and reference parity. |
| T18 first Qwen3.8 benchmark | **Blocked** | Depends on T17 and an uncontaminated M5 window. Both direct and streaming runners are ready. |
| T19 Qwen3.8 speculation | **Blocked** | Depends on official architecture and T17. Current runner supports MTP/DFlash/DSpark measurements without assuming availability. |
| T20 Qwen3.8 vs Qwen3.6 | **Blocked** | Gate D already supplies deterministic coding tasks; the new server comparator supplies latency/throughput controls. Requires actual Qwen3.8 artifact. |
| T21 Glimmer specialist | **Candidate only** | Existing gateway already passes multimodal `image_url` content and serves Gemma4+mmproj. Glimmer qualification/discovery remains issue #181; roster promotion is not authorized. |
| T22 model router | **Implemented as evidence-gated routing; profile qualification blocked** | The gateway/orchestrator already performs task-aware routing through the generated capability table and fails safe to the frontier for unsupported lanes. FAST/BALANCED/DEEP/VISION/MAX remain descriptive product tiers rather than static aliases: assigning them before the issue #124 model/profile experiments would bypass the repository's evidence-before-autonomy invariant. Glimmer/MAX qualification remains separate roster work. |
| T23 coding-agent suite | **Existing and verified** | Gate D has 14 isolated real-edit fixtures with deterministic compile/test/structural oracles and resumable model/harness runs. New models must run the same pinned corpus; no replacement suite is needed. |
| T24 concurrent agents | **Runner implemented; measurement blocked** | Streaming runner covers 1/2/4/8 and useful work/minute. Existing Gate C remains the admission/preemption/soak control. Requires M5 access/window. |
| T25 OS/power/memory profile | **Read-only capture implemented; Strix A/B blocked** | `npm run benchmark:strix-host` emits mode-0600 JSON/Markdown with the operator-observed BIOS UMA setting, kernel/Mesa/ROCm, memory, allow-listed AMD/TTM parameters, power profile, governor, DRM memory/clocks, and labelled hwmon observations. Missing sensors remain `null`, and raw kernel argv is never retained. A local non-Strix smoke test and deterministic tests prove the capture path; issue #195 still owns the one-variable M5 A/B after #196 is deployed and verified. BIOS/kernel/driver changes remain explicitly outside this branch. |

## Work order from this state

1. Restore the canonical Codex M5 credential, review/deploy this branch, and verify issue #196's
   exclusive maintenance path against the actual post-isolation listener and lease directory.
2. Stage reviewed, hashed target/runtime artifacts without changing the live roster.
3. Run T02/T03/T06/T09 controls, then T04 and T10; publish raw reports before conclusions.
4. Use those traces to decide whether T05/T13/T14 kernel/runtime work is justified.
5. Poll T16; start T17–T20 only after the official 27B revision is public.
6. Qualify Glimmer through issue #181 before any T21/T22 production route change.
