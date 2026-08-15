# Strix Q8 KV Flash-Attention candidate

**Date:** 15 August 2026
**Status:** isolated backport and M5 build passed; Vulkan execution and local A/B are pending an
explicit exclusive maintenance window. Nothing was deployed.

## What changed upstream

llama.cpp issue [#25491](https://github.com/ggml-org/llama.cpp/issues/25491) reports an exact
Ryzen AI Max+ 395 / Radeon 8060S / RADV result for a Vulkan coopmat1 Flash-Attention patch. For
Q8 K/V it dequantizes and reorders the cache once into F16 scratch instead of repeating the Q8
dequantization in each query workgroup. The reported Qwen3-Coder-30B-A3B Q6_K `pp512` result rose
from 200.17 to 281.99 tok/s at 32K actual depth and from 99.08 to 166.17 tok/s at 64K; generation
was reported unchanged. This is **EXTERNAL-MEASURED**, not a local result.

The implementation is an eight-commit public branch in
[Nathanw1014/llama.cpp](https://github.com/Nathanw1014/llama.cpp/tree/vulkan-coopmat1-fa-dequant-transpose).
It changes four files (98 insertions, 10 deletions), adds the Q8 dequantize/transpose shader,
guards storage-buffer limits and cache layout, skips coopmat2, and adds contiguous quantized K/V
backend coverage.

## Local preparation

The eight commits cherry-picked without conflicts onto the exact production llama.cpp revision
`8086439a4cea94c71a5dfb8fe4ad1546aebd640f`. The isolated backport commit is
`300d1192718c6746f108afcab893d208d43ea94e`. M5 configured and built `llama-server`,
`llama-bench`, and `test-backend-ops` with Vulkan, native CPU tuning, Release mode, GCC 15.2,
CMake 4.2.3, and Vulkan SDK 1.4.341. Shader compilation passed. The build changed no live binary,
model, service, or configuration.

Exact commits, source files, archive and binary hashes, build options, model identity, reported
reference values, and the local experiment contract are in
[`configs/strix-kv-dequant-qwen36.json`](../configs/strix-kv-dequant-qwen36.json).

The temporary upstream UI build invoked its pinned npm build step and reported 23 dependency
audit findings. Those assets are not production evidence and will not be promoted. The inference
binaries built successfully; dependency audit state is recorded here so it is not mistaken for a
clean supply-chain signal.

## Causal A/B design

The current Qwen3.6 production profile uses F16 KV, while this patch only optimizes Q8 KV. A direct
F16-versus-patched-Q8 comparison would confound KV precision with runtime implementation. The
required matrix is therefore:

| Arm | Runtime | KV | Question |
|---|---|---|---|
| production-f16-kv | exact production | F16/F16 | What is the current semantic/performance baseline? |
| production-q8-kv | exact production | Q8_0/Q8_0 | What does KV quantization itself change? |
| candidate-q8-kv | exact backport | Q8_0/Q8_0 | What does the patch change at fixed KV precision? |

Each arm uses the same Qwen3.6 Q4_K_M artifact, Vulkan/RADV, Flash Attention, batch 2048, ubatch
512, one sequence, no speculation, five repetitions, and actual populated 8K, 32K, 64K, and 128K
depths. The repository `benchmark:strix` runner records PP/TG separately, runtime/model hashes,
actual depth, RSS/available RAM, kernel/Mesa/ROCm, and readable temperature/power telemetry.

Before model execution, the candidate must pass focused Vulkan `FLASH_ATTN_EXT` backend tests.
The complete matrix runs twice before promotion. It must improve populated-context PP materially
over stock Q8 without a meaningful TG, output, stability, memory-pressure, or thermal regression.
Q8 must remain acceptable against the production F16 control, and a representative agent workload
must preserve or improve completed useful work per minute.

## Decision and rollback

**Decision: prepared, not deployed.** This candidate outranks broader runtime upgrades because it
has a narrow mechanism, exact-hardware evidence, and an exact-production backport. It does not yet
have local GPU correctness or performance evidence.

Running the backend tests or benchmark would compete for the serial GPU and requires unloading and
restoring the resident llama-swap target. That exact outage remains subject to just-in-time owner
confirmation. The run must bind the starting target by immutable model artifact and restore it on
success, error, or catchable signal.

Rollback before deployment is deletion of the isolated candidate build. If it later passes every
gate and is promoted, rollback is replacement with the retained production binaries at revision
`8086439a4cea94c71a5dfb8fe4ad1546aebd640f`, restoration of the previous F16 profile, and the
standard gateway/runtime verification sequence.

## Combined maintenance runner

`npm run benchmark:strix-combined` now binds this candidate to the existing mmap ABBA and direct
Strix benchmark runners. It is deliberately not a standalone production command: invoke it only as
the child of `maintenance:run`, after resolving and receiving exact approval for the current
resident model and immutable artifacts.

Before the first unload it validates both configs, hashes the model, source archive, production
server/benchmark/Vulkan library, candidate server/benchmark/backend-test/Vulkan library, checks
executable file types, and requires both server version strings to name their pinned commits. It
then:

1. runs two mmap ABBA cycles and restores the starting resident model;
2. treats mmap promote/reject as complete independent evidence, not as a KV gate;
3. unloads residency and runs focused serial Vulkan `FLASH_ATTN_EXT` correctness;
4. runs production-F16, production-Q8, candidate-Q8 and then the mirrored order in cycle two;
5. requires PP/TG cells at short, 8K, 32K, 64K, and 128K actual depth with exact runtime/model/KV
   provenance;
6. restores the exact starting model and requires a deterministic `OK` inference before accepting
   ready state; and
7. emits mode-0600 aggregate JSON/Markdown without model content.

The automatic microbenchmark decision is either `advance-to-agent-gate` or `reject`. Advancement
requires at least 10% candidate-over-stock-Q8 PP gain at both 32K and 64K, no PP/TG cell more than
5% behind stock Q8 or production F16, and no candidate peak-RSS increase above stock Q8 beyond 5%.
It never authorizes deployment. A representative agent workload remains mandatory.

On any infrastructure, correctness, benchmark, provenance, or interruption failure, the runner
attempts required residency restoration and writes `combined-failure.json`. If both the operation
and restoration fail, it preserves both errors. The outer maintenance runner independently closes
the exclusive fence; operators must inspect live residency before further action.
