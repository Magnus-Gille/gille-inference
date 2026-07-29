# GPT-OSS-120B and Qwen3.5-122B-A10B production decision

Date: 2026-07-28

## Decision

Keep `gpt-oss-120b` as the standard large-model lane and preferred 64K tier. Add
`qwen35-122b-a10b` at 32K as an explicit authenticated model and a shadow-only precision
specialist for `code-review`. Do not replace GPT-OSS wholesale and do not create an enforced Qwen
route from this study.

The reason is a real production trade-off, not a single quality score. Qwen is more deterministic
and much less likely to invent review findings, while GPT-OSS is about twice as fast on normal
generation, faster at long context, smaller in memory, and has higher seeded-bug recall.

## Apples-to-apples method

Both candidates ran sequentially on the same 128 GB M5 under the FIFO GPU lease. The scored arms
used the same audited llama.cpp runtime (`9a3bf2b84`, binary SHA-256
`d1d8e90b90ff71c24897f80fe6b4d0034e16b1a2f1e912e22b50611343b7450d`), deterministic
temperature-zero requests, native chat parsing, one slot, flash attention, Jinja templates,
ubatch 512, and F16 KV.

The production candidates are deliberately not the same quantization or byte size:

- GPT-OSS-120B: MXFP4, three shards, 63,387,346,464 bytes
- Qwen3.5-122B-A10B: Q4_K_M, three shards, 76,536,964,608 bytes

Those are the artifacts actually available for deployment, so their size and quantization are
part of the replacement decision. Qwen ran in its supported reasoning-off mode. GPT-OSS kept
native reasoning for the primary arm, with a labelled reasoning-off sensitivity arm.

Every heavy arm used `MemoryMax=96G`, `MemorySwapMax=0`, `OOMPolicy=kill`, and a minimum 12 GiB
host-memory reserve. The benchmark process could not swap; pre-existing host-level swap use was
observed separately.

## Quality result

The primary battery was 74 deterministic probes repeated three times: 222 scored results per
model.

| Measure | GPT-OSS native reasoning | Qwen reasoning off |
|---|---:|---:|
| Strict pass | 140/222 (63.1%) | **157/222 (70.7%)** |
| Pass + partial | 192/222 (86.5%) | **216/222 (97.3%)** |
| Fail | 16/222 | **3/222** |
| Error | 14/222 | **3/222** |
| Average generation | **52.2 tok/s** | 26.0 tok/s |
| Review recall | **89.2%** | 77.5% |
| Review precision | 68.4% | **89.8%** |
| Clean-code confabulation | 10/18 (55.6%) | **0/18** |
| Unstable probes across repeats | 11 | **1** |
| Native tool-call smoke | pass | pass |

Qwen's quality advantage is repeat-stable and is especially important where false-positive review
findings are expensive. GPT-OSS remains the throughput and recall winner. Turning GPT reasoning
off in a one-repeat sensitivity arm removed the observed short-budget truncation and preserved the
six reason-hard passes, but did not fix the clean-review confabulation gap; that arm is sensitivity
evidence, not a route promotion.

## Context and capacity result

Each context size used twelve deterministic retrieval/synthesis cases, split between 80% and 92%
window fill, with prompt caching disabled to measure cold-context behavior.

| Window | GPT pass | GPT median latency | GPT gen | Qwen pass | Qwen median latency | Qwen gen |
|---|---:|---:|---:|---:|---:|---:|
| 16K | 12/12 | 28.4 s | 46.1 tok/s | 12/12 | 52.9 s | 25.0 tok/s |
| 32K | 11/12 | 68.4 s | 42.0 tok/s | 12/12 | 114.1 s | 24.4 tok/s |
| 48K | 12/12 | 124.7 s | 38.0 tok/s | 12/12 | 185.0 s | 23.3 tok/s |
| 64K | 12/12 | 208.0 s | 35.1 tok/s | 12/12 | 271.0 s | 22.6 tok/s |

At the hardest observed 64K/92%-fill edge, Qwen's maximum latency was 274.1 seconds: inside the
five-minute gate by only about 26 seconds. GPT's maximum was 212.4 seconds. Both are technically
usable at 64K, but Qwen does not have comfortable interactive latency margin there.

| 64K resource measure | GPT-OSS | Qwen |
|---|---:|---:|
| Peak server RSS | 58.9 GiB | 69.9 GiB |
| Peak benchmark cgroup | 59.4 GiB | 71.6 GiB |
| Minimum host `MemAvailable` | 57.5 GiB | 45.6 GiB |
| Resource breach / contamination | none | none |

This is why production Qwen is bounded to 32K even though 64K completed in isolation. GPT retains
more latency and memory headroom for a shared production box.

## Serving settings

The selected serving contract is:

- one slot, ubatch 512, flash attention, Jinja templates
- F16 KV and a 2 GiB prompt cache
- shared llama-swap cgroup at 96 GiB with no swap and kill-on-OOM
- GPT-OSS at 65,536 context
- Qwen at 32,768 context with reasoning off and the complete audited runtime bundle pinned

A 2 GiB prompt cache restored a displaced 22K-token prefix in about 2.2 seconds for both models,
versus about 47 seconds cold for GPT and 83 seconds cold for Qwen. A 512 MiB cache was too small.
Q8/Q4 KV saved less than 1 GiB of useful headroom and reduced prompt-processing speed by about
2–7%, so F16 KV won.

The formal Qwen production-config soak recorded 67.5 seconds from server startup to
`model loaded`, which grounds the portal's operator-facing expectation that the largest models can
take roughly 40–70 seconds to cold-load. This is load time, distinct from the cold prompt-cache
restore measurements above.

The deployable runtime was rebuilt from the same `9a3bf2b84` source and serving flags with an
origin-relative runpath, because the benchmark build embedded its scratch build directory. The
stable `llama-server` SHA-256 is
`7e1fa95bf414d8491166d9976a028555b2ebf12c481868a5582d63256865ee22`; `readelf` and
`ldd` show no scratch dependency. This relocation-safe rebuild is a distinct binary identity, so
the production canary must confirm the reported `b300-9a3bf2b84` runtime fingerprint before the
candidate is accepted.

## Production-config soak

The new Qwen serving contract completed the preregistered 45-minute mixed-load soak after the
comparison. It alternated short structured requests with 25.8K-token retrieval/synthesis requests
under the exact 32K, ubatch-512, F16-KV, 2-GiB-cache, reasoning-off configuration.

| Measure | Qwen 32K production config |
|---|---:|
| Short completions | 27/27 |
| Long answers correct | 27/27 |
| Median long latency | 98.8 s |
| Maximum long latency | 100.0 s |
| Median long generation | 24.1 tok/s |
| Minimum long generation | 22.2 tok/s |
| Peak benchmark cgroup | 71.6 GiB |
| Minimum host `MemAvailable` | 45.0 GiB |
| Benchmark-process swap | 0 |
| Contamination / resource breach | none |

This closes the full soak gate for the new Qwen production configuration. It does not relabel the
earlier 20-minute GPT soak as a matched 45-minute run; GPT remains the incumbent with separate
production history, while a new GPT formal soak would still need to be reported as a distinct arm.

## Authority and rollout boundary

Adding a model to llama-swap only makes it servable. It does not certify the model, change the
default, or authorize an enforced route.

The first production phase is therefore:

1. explicit authenticated Qwen calls (with the first deployment canary owner-only);
2. `code-review` shadow evidence, never returned to the caller and excluded from normal route
   rollups;
3. no automatic replacement of GPT-OSS;
4. later route consideration only from verifier-backed production evidence.

The public serving contract and generic release checks are in
[`../deploy/README.md`](../deploy/README.md). Exact live paths, roster bytes, backups, canary
commands, and rollback execution are tracked privately. Raw model artifacts, prompts, responses,
and local operator handoff state remain outside this public repository.
