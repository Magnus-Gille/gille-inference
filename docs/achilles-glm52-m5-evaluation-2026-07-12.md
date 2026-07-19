# Achilles / GLM-5.2 on the M5 — evidence-led feasibility evaluation

- **Date:** 2026-07-12; UMA/TTM cache-sweep follow-up 2026-07-13
- **Achilles revision:** [`e374995`](https://github.com/menonakhilmenon/achilles/commit/e3749954cc790b076ac3059b769dde7169a03fa4)
- **GLM artifact revision:** `unsloth/GLM-5.2-GGUF@abc55e72527792c6e77069c99b4cb7de16fa9f23`, `UD-Q2_K_XL`

**Status:** complete through the first post-UMA/TTM cache sweep. Live M5 compatibility, Qwen
controls, exact pinned GLM-5.2 runs, trained-predictor correction, memory-layout sweep, claim audit,
and adversarial review are complete. Claude was unavailable (CLI spend limit; web signed out), so
the requested debate was replaced at the owner's direction by the explicit steelman/skeptic review
below.

**Reproduction:** see the [pinned runbook](achilles-glm52-m5-reproduction.md),
[post-UMA/TTM cache-sweep evidence](achilles-glm52-cache-sweep-2026-07-13.md),
[artifact digests](achilles-glm52-ud-q2-k-xl.sha256), and
[`scripts/achilles-glm52-m5.sh`](../scripts/achilles-glm52-m5.sh). These publish only our original
harness and evidence; unlicensed Achilles source and model weights are not redistributed.

## Final verdict

**B — viable only with specific modifications.** Achilles has demonstrated a real and useful
systems technique, and its managed expert arena works on our Strix Halo stack. The corrected
512 MiB UMA / 100 GiB TTM layout lifted the best safe point from ~0.59 to **1.221 tok/s**, but it is
not presently a viable production serving path and the stock SSD remains a binding bottleneck.

The meanings of "viable" must stay separate:

| Meaning | Measured M5 now | Further modified runtime |
|---|---|---|
| Produces coherent tokens | Yes with correct manual chat serialization; raw CLI output was self-contradictory | Yes, assuming server integration applies the embedded template |
| Interactive personal use | No: best safe result is 1.221 tok/s plus roughly two-minute cold install | A faster expert-range SSD has a credible ≥2 tok/s hypothesis, not a measurement |
| Bounded offline jobs | Technically yes; 0.59–1.22 tok/s keeps scope narrow | Plausible; long generations amortize setup/prefill |
| Production M5 gateway / multi-user | No | Not until Achilles becomes a persistent, tested server with admission and observability |

## Adversarial review: the case for and against

### Steelman: why Achilles may be the right primitive

1. **The core mechanism is real.** It replaces expert-tensor mappings with a bounded anonymous
   arena and demand-loads the exact quantized bytes. On our Qwen control, managed and resident paths
   produced identical teacher-forced NLL and perplexity. This is substantially stronger evidence
   than a paging simulator.
2. **It really runs the target artifact.** Our independently pinned, checksummed GLM-5.2 Q2 run
   completed safely at 0.587 tok/s with zero io_uring fallbacks. Manual application of the embedded
   chat template returned the exact answer `323`. This is not vaporware.
3. **The memory-layout hypothesis survived experiment.** Changing from a 64 GiB fixed carveout to
   512 MiB fixed UMA plus 100 GiB dynamic TTM/GTT made 60 and 90 GiB expert caches feasible. The
   90 GiB point doubled decode throughput to 1.221 tok/s and reached 77.6% hits without fallback.
4. **Our stock SSD is unusually weak for this workload.** Expert-sized random direct reads reached
   only ~1.25 GB/s. The available second M.2 slot means the storage bottleneck is modifiable.
5. **Persistence changes usability disproportionately.** The roughly two-minute install and cold
   cache occur on every invocation only because Achilles is a one-shot research CLI. A server that
   retains the model and arena could amortize both across many offline tasks.

### Skeptic: why this should not enter production now

1. **The useful-serving claim still misses.** The original exact result is 0.587 tok/s and the best
   safe large-cache result is 1.221 tok/s, versus the repo's 2–5 tok/s target. A 500-token answer at
   the best measured rate takes roughly 6.8 minutes after prefill, even ignoring the cold install.
2. **The current box remains storage-bound.** The 90 GiB cache reduced successful io_uring completions by
   52% and doubled throughput, but still missed 22.4% of expert accesses on a 1.25 GB/s drive.
   Prediction and more RAM reduce the byte budget; they do not eliminate it.
3. **The advertised architecture is ahead of the code.** Routed experts currently use RAM←SSD;
   the VRAM hot-expert cache remains backlog. The original long-horizon prediction story was revised
   by the author's own results toward plan-aware eviction, and our fetch-width experiment found no
   repeatable optimization.
4. **The harness is not a model server.** It omits chat-template application, hardcodes its sampler
   after accepting normal CLI sampling flags, does not stream, loses cache between invocations, and
   has no cancellation, batching, fairness, API, or recovery contract. The raw-prompt smoke was
   factually self-contradictory until we manually serialized the chat template.
5. **Correct paging is not sufficient quality evidence.** Q2 may preserve Achilles-vs-resident
   equivalence while still degrading the original BF16 model. One arithmetic answer cannot establish
   GLM-5.2-level coding, reasoning, tool use, or long-context capability.
6. **The project is a research spike.** It has no explicit license, tests, CI, pinned dependency,
   supported build, or complete retained benchmark record. Its short-read handling and abort-on-I/O
   paths are unacceptable for unattended gateway use.

### Resolution

| Disputed proposition | Resolution |
|---|---|
| “Achilles can run GLM-5.2 on the M5” | **Yes, technically proven.** |
| “It delivers the advertised 2–5 tok/s” | **No.** Best safe result is 1.221 tok/s; 2–5 remains a target. |
| “It is useful today” | **Only for unusually valuable, latency-insensitive offline work.** |
| “The current implementation belongs behind our gateway” | **No.** Missing serving and safety contracts. |
| “The UMA/TTM modification helps” | **Yes.** 90 GiB reached 1.221 tok/s / 77.6% hits versus 0.592 / 66.4% at 20 GiB. |
| “We should buy an SSD now” | **Not blindly.** The I/O curve supports an actual expert-range SSD benchmark, not a marketing-spec purchase. |

**Overall classification: B — viable with modifications, subject to hard gates.** If “viable” means
interactive or production use on the current configuration, the answer is C/no. If it means a
credible research path to persistent, latency-tolerant personal inference after storage and runtime
changes, the evidence supports B. The memory change made B more credible but did not itself cross
the interactive threshold.

## What was actually tested on our M5

Hardware observed live:

- Ryzen AI Max+ 395, 16C/32T, AVX-512, Radeon 8060S / RADV.
- 128 GB physical unified memory; originally exposed as about 61 GiB host RAM plus a 63 GiB fixed
  Vulkan heap, then reconfigured to ~122.7 GiB Linux-visible RAM, 512 MiB fixed UMA, and a 100 GiB
  dynamic TTM/GTT limit for the follow-up sweep.
- 2 TB YMTC PC41Q NVMe, PCIe 4.0 x4, DRAM-less; one additional M.2 socket is reported available.
- Ubuntu kernel 7.0, Mesa 26.0.3, Vulkan 1.4; production services were live before and after each
  experiment window, with the gateway deliberately stopped during fully isolated samples.

Reproducibility work required before Achilles would start:

- The repository ships dynamically linked binaries with an author-local RUNPATH and does not pin
  llama.cpp. The compatible dependency was recovered from benchmark metadata as llama.cpp
  `e3546c7948e3af463d0b401e6421d5a4c2faf565`.
- That revision configured and built natively with Vulkan cooperative-matrix support on the M5.
- `liburing-dev` was the only additional build package required. `src/arena.cpp` then compiled
  natively against the pinned runtime.

Managed-arena smoke on the existing Qwen3-30B-A3B Q4 model:

| Test | Result |
|---|---|
| Expert discovery | 48 layers × 128 experts; 16.3 GiB managed expert bytes |
| Arena | 8 GiB resident budget; anonymous `MAP_FIXED` replacement succeeded |
| I/O | 8,469 io_uring completions, zero fallback in first smoke |
| Locality | 6,696 hits / 3,968 misses = 0.628 first smoke; 0.796 in longer matched run |
| Throughput | 8.43 tok/s first smoke; 12.58 tok/s longer run |
| Output | Coherent and instruction-relevant; common prefix matched no-pager control |
| No-pager control | 39.35 tok/s decode, 69.84 tok/s prefill |
| Teacher-forced correctness | Managed and no-pager both mean NLL 3.69976 / perplexity 40.437 over identical 64-token input |

The control is important: Achilles preserved the useful output path, but paging imposed a large
penalty even on this much smaller model. Its one-shot process also discards the expert cache after
every invocation.

Exact pinned GLM-5.2 `UD-Q2_K_XL` baseline (all seven shard digests verified first):

The original run used plan-aware LRU with the model's existing router weights as its gate-ahead
predictor. The command supplied `--delta 3 --fetch 8`, which generates forward `plan_hint` entries,
and the pinned source defaults to LRU. The reproduction harness now also passes `--policy lru`
explicitly so the eviction policy is not left to an undocumented default.

After the upstream owner asked us to state this explicitly, the same 20 GiB run was repeated with
`--policy lru --delta 3 --fetch 8`. It produced **0.586 tok/s**, **66.4% hits**, 77,043 successful
io_uring completions, and zero fallback. This is an A/A confirmation of the original 0.587 tok/s,
66.4%, and 77,049 result: the router-weight plan-hint path was already active through the defaults
and positive fetch width. Making the policy explicit improves reproducibility but does not test the
separately trained predictor loaded through `--probe`.

### Trained predictor correction

The upstream owner clarified that "smart cache eviction" referred to the separately trained small
network, not merely router-weight gate-ahead hints. The pinned repository includes trace dumping,
the delta-3 linear-probe trainer, and the `--probe` loader, but it does **not** include the trace
corpus or trained probe blob. Our first two baselines therefore did not test that network.

We generated two local 192-token trace corpora (386 parsed forward passes; 329 train / 57 random
holdout) and ran the checked-in trainer. It retained 61 layer probes and improved mean held-out
recall@8 from **0.512 to 0.566** versus router-weight gate-ahead. The resulting 469 MiB blob has
header `78 × 256 × 6144`, 61 nonzero layers, all finite values, and SHA-256
`f4b7618a286589c973962064cc8171618e3f521f4314d873d24251f0e3a2b313`.

The clean, fully traffic-isolated 20 GiB inference run loaded all 61 retained probes but regressed to
**0.524 tok/s and 56.7% cache hits** (85,386 successful io_uring operations; zero fallback), versus
the router-weight control's **0.586 tok/s and 66.4% hits**. Two earlier probe attempts were rejected
because live llama-swap traffic became resident during the sample.

The likely implementation gap is coverage/fallback: the trainer writes zero matrices for rejected
layers, and probe mode clears those layers instead of falling back to the model-router predictor.
Thus an offline mean-recall improvement over eligible trained layers did not translate into better
end-to-end locality. The small network is real and trainable on the M5, but this corpus/artifact is
not a performance win. A larger, task-diverse corpus plus per-layer router fallback (or full probe
coverage) must beat the router-weight control before the trained predictor can support a viability
claim.

Exact corpus, artifact, exclusion, and recovery details are retained in the
[trained-probe follow-up](achilles-glm52-probe-training-2026-07-12.md).

### Post-UMA/TTM cache sweep

On 2026-07-13 the M5 was reconfigured through BIOS from a 64 GiB fixed UMA carveout to 512 MiB,
then the official AMD helper set TTM/GTT to 100 GiB. Linux reported ~122.7 GiB total RAM and the
new fixed/dynamic values were verified in sysfs before any model run.

The same raw 48-token router-weight baseline was repeated under a stopped gateway, guest
maintenance, a FIFO GPU lease, per-point cgroups, an automatic gateway-recovery timer, and empty
llama-swap residency:

| Expert cache | Decode | Hit rate | io_uring successes | Fallback | Outcome |
|---:|---:|---:|---:|---:|---|
| 20 GiB | **0.592 tok/s** | 66.4% | 77,043 | 0 | accepted; baseline replicated |
| 60 GiB | **0.943 tok/s** | 74.8% | 48,183 | 0 | accepted |
| 90 GiB | **1.221 tok/s** | 77.6% | 36,771 | 0 | accepted |
| 100 GiB | — | — | — | — | rejected; host-level OOM before decode |

The 90 GiB point is 2.06× the 20 GiB throughput and cuts successful SSD operations by 52%. The
100 GiB arena crossed the host safety boundary despite `MemoryMax=116G`: the global OOM killer
terminated only `achilles-arena` at ~98.9 GiB anonymous RSS. Production recovered through the
pre-armed trap/timer, maintenance was off, all services and both health paths were green, and a
post-OOM Mellum GPU smoke returned exactly `OK`.

The runner now defaults to 20/60/90 GiB and reserves 28 GiB of host headroom, refusing 100 GiB on
this 122 GiB Linux-visible host before launch. Full isolation details, raw-log checksums, and the
storage-sensitivity calculation are in the
[cache-sweep follow-up](achilles-glm52-cache-sweep-2026-07-13.md).

| Measurement | Result |
|---|---:|
| Routed experts discovered | 76 scanner-visible MoE layers × 256 experts; 221.8 GiB (includes an unused MTP auxiliary layer) |
| Expert arena installed | 218.6 GiB replaced; 20 GiB resident budget |
| Cold model/arena install | roughly 112–130 seconds |
| Raw 9-token prefill | 0.72 tok/s |
| Raw 48-token decode | **0.587 tok/s** |
| Raw-run locality | 22,667 hits / 11,469 misses = **0.664** |
| Raw-run I/O | 77,049 io_uring completions; zero fallback |
| Raw output quality | Included correct `17*19=323`, but falsely called 323 “the 51st prime” |
| Manually chat-templated control | Returned exactly **`323`** and stopped |
| Templated 28-token prefill | 0.47 tok/s |
| Templated two-token decode | 0.389 tok/s; too short/cold to treat as steady-state throughput |

The embedded GGUF Jinja template begins with `[gMASK]<sop>` and role tokens. Achilles does not apply
it: its generation loop tokenizes `params.prompt` directly. The templated control therefore proves
that the tiny arithmetic failure was chiefly a harness failure, while also proving that a proper
serving layer is mandatory. The loader additionally sees an auxiliary `blk.78` MTP layer, which
llama.cpp ignores for normal generation; Achilles counts its expert tensors during discovery and
then logs its three projections as unmappable. They were not part of the installed arena or normal
forward pass, but model-role discovery should explicitly exclude such unused auxiliary tensors.

Both GLM runs stayed inside `MemoryHigh=32G`, `MemoryMax=36G`, `MemorySwapMax=2G`. After the first
run, current memory PSI had returned to zero, host available memory was 57 GiB, and both production
services were active. After the templated control, 55 GiB remained available, both services were
active, and the GPU lease was free.

Measured bandwidth with Achilles' own harnesses:

| Resource | M5 result | Achilles author result | Consequence |
|---|---:|---:|---|
| RAM scalar read, 16 threads | 83.1 GB/s sustained; 95.6 best | 55.5 sustained | Better, but far below the repo's use of the 256 GB/s theoretical Strix figure |
| RAM scalar read, 32 threads | 72.1 GB/s sustained | n/a | More SMT threads hurt this kernel |
| NVMe random O_DIRECT, 12 MiB, QD2 | 1.23 GB/s | roughly 2.3–4.0 GB/s at 10–20 MiB before the author's cooling change | Current binding bottleneck |
| Same, QD4 / QD8 | 1.25 / 1.14 GB/s | up to 7.37 GB/s in the author's final 120 s cooled run | The PC41Q saturates early; more queue depth does not rescue it |

The Qwen runs were cgroup-bounded and GPU-lease-coordinated. Afterward, both production services
were active, the lease was free, host available memory was 56 GiB, and memory PSI was negligible.

### Storage-bound sanity check

GLM-5.2 routes 8 experts through each of 75 MoE layers. With roughly 225 GiB of routed-expert
weights spread over 75×256 experts, a token touches about 7.0 GiB (7.5 GB) before cache hits. At the
stock drive's measured 1.25 GB/s, a deliberately crude **serial-read** calculation at 70% hits gives
about 0.55 tok/s. This is not a hard ceiling: Achilles overlaps asynchronous prefetch/demand reads
with compute, and the measured 60/90 GiB points exceed the serial estimate. It remains a useful
warning that a 20 GiB cache over a ~225 GiB expert working set cannot be rescued by optimistic
RAM-bandwidth marketing alone.

The post-UMA/TTM sweep supplies the missing empirical check. Across the accepted 20/60/90 GiB
points, decode time is almost perfectly linear in successful io_uring operations
(`R²=0.99996`, `n=3`). A deliberately labeled sensitivity calculation says halving the I/O term at
the 90 GiB point would imply about 2.4 tok/s. That makes a faster expert-range storage test credible,
but one short prompt per cache size cannot prove linear scaling on a new SSD.

## Claim audit

### 1. "GLM-5.2 runs on a small-memory consumer box"

**Independently supported on the M5, in the narrow technical sense.** The repo contains a raw naive
GLM smoke at 0.3 tok/s with coherent beginning text. Commit history and prose report managed runs.
The newest safety commit reports **0.53 tok/s with a 20 GiB cache**. Earlier 34 GiB runs at
0.83/0.90/0.945 tok/s and 55.5% hit rate are visible in the commit patch, but the latest commit
cleared that result file when it changed the safe envelope.

Our exact pinned 20 GiB run reached **0.587 tok/s** over 48 generated tokens, with a 66.4% hit rate
and zero direct-I/O fallbacks. The modified-memory 90 GiB point reached **1.221 tok/s** / 77.6% hits,
also with zero fallback. A correctly serialized chat control returned the right answer. "Runs"
therefore means technically executes, not useful interactive service.

### 2. "VRAM ← RAM ← SSD is a three-tier routed-expert cache"

**Aspirational / overstated.** Current `arena.cpp` implements RAM←SSD paging for routed experts.
llama.cpp places the dense skeleton, attention, and KV on GPU via `-ngl 99 -ot exps=CPU`.
A hot-expert VRAM tier remains explicitly listed as backlog. All three storage classes participate
in the overall model, but VRAM is not currently the advertised cache for routed experts.

### 3. "Prediction hides I/O"

**Partly supported, with the original thesis revised.** Prediction cannot reduce required bytes.
The author's own final finding is that far-stage predictive fetching can make throughput worse on
an SSD-bound system. The measured win came from using within-token predictions as plan-aware
eviction hints; cross-token prediction was reported ineffective. On our slower SSD, fetch width and
plan width should be separate controls so useful eviction hints do not force speculative reads.

An isolated M5 variant added that separation. Hints-only (`fetch=0`, `plan=16`) was clearly worse
on the Qwen smoke (2.06 tok/s, 73.5% hits) than near prefetch. Widths 2/4 initially appeared to beat
the upstream width 8 under background download traffic, but an order-reversed width-8 confirmation
reached 14.38 tok/s and erased the apparent win. Treat the control separation as a useful tuning
surface, not as a demonstrated optimization; storage variance requires repeated GLM-specific runs.

### 4. "2–5 tok/s GLM-5.2"

**Not achieved.** Current safe upstream evidence is 0.53 tok/s; the best earlier less-constrained
runs were 0.83–0.94 tok/s. Our modified-memory best safe point is **1.221 tok/s**, 24–61% of the
target range. A storage-sensitivity fit makes ≥2 tok/s plausible on a materially faster drive, but
that remains a falsifiable next experiment rather than a measured result.

### 5. "Quality-exact"

**Supported on our Qwen control relative to the same quant; not established on GLM and not relative to the
full-precision model.** With routing bias disabled, Achilles intends to load identical quantized
bytes and preserve exact expert choice. A matched teacher-forced check on the M5 produced identical
mean NLL (`3.69976`) and perplexity (`40.437`) over the same 64 tokens for managed and no-pager
paths. The repo does not currently retain a complete deterministic GLM token-diff or perplexity
artifact for the latest safe configuration. Official GLM-5.2 benchmark claims do not transfer
automatically to a 254 GB Q2 quant. The correct templated arithmetic answer is a functional smoke,
not a quality equivalence test.

### 6. "Safe and reproducible"

**Experimental.** The latest commit adds necessary cgroup envelope discipline after repeated
OOM/freeze and page-cache-flood discoveries. Our bounded Qwen runs were safe. However, Achilles was
created one day ago and currently has no license, tests, CI, dependency lock, build recipe, stable
API, or failure-recovery contract. The core technique uses `MAP_FIXED` over llama.cpp mappings and
calls `abort()` on some I/O errors, which is reasonable for a research spike but not a service.
The io_uring completion path also treats every non-negative completion as success without checking
for a short read; a partial expert load could therefore be marked valid. This needs an exact-length
check plus retry/error propagation before unattended serving. The one-shot generation loop also
constructs a temperature-0.7, seed-42 sampler unconditionally after parsing the normal llama.cpp
sampling flags, so apparently accepted CLI sampling options do not actually control generation.

### 7. "GLM-5.2 capability" includes its 1M-token context

**Not on this path as currently budgeted.** The official config confirms a 1,048,576-token maximum,
but Achilles' own KV estimate is roughly 0.1 MB/token in BF16. A million-token KV allocation would
therefore consume around 100 GB before the expert cache and runtime workspace. This evaluation is
about running the model at practical short/medium contexts; the 1M-context headline must not be
carried into an M5 claim without a separate KV/sparse-attention memory and latency study.

## Memory-layout result and remaining bottleneck

Achilles stores experts in CPU-visible RAM. The original firmware layout reserved about half the
physical memory as fixed GPU-local memory, leaving only 61 GiB to Linux; Achilles could not use that
otherwise-idle reservation as an expert cache.

AMD's current Strix Halo guidance says fixed and shared memory are physically the same, recommends a
small BIOS reservation (for example 0.5 GB), and recommends increasing the dynamic TTM/GTT limit
instead. We applied that modification: 512 MiB fixed UMA, ~122.7 GiB Linux-visible memory, and a
100 GiB dynamic TTM/GTT limit. The safe 90 GiB arena proved that the extra CPU-visible memory works,
while the 100 GiB global OOM established the actual host boundary.

The second constraint is the stock SSD. At 1.2 GB/s expert-sized random reads it is several times
slower than the author's final cooled drive. DMI reports an available M.2 socket, making a dedicated
high-end Gen4 NVMe with DRAM and a heatsink a practical modification.

## Required modifications before a GO

1. **Completed — reconfigure unified memory:** 512 MiB BIOS UMA plus 100 GiB TTM/GTT; rebooted,
   revalidated production models, and measured the 20/60/90 GiB sweep. Do not retry 100 GiB.
2. **Use a fast dedicated model SSD:** target at least 4–5 GB/s sustained O_DIRECT at actual
   3–12 MiB expert ranges, not marketing sequential throughput.
3. **Make Achilles persistent:** integrate the arena into `llama-server` or equivalent so model,
   GPU skeleton, and expert cache survive requests; add chat-template handling and streaming.
4. **Separate prediction from reads:** independent plan-hint width and fetch width; tune on the
   M5's actual bandwidth instead of inheriting the author's values.
5. **Production safety:** admission/serialization, cancellation, cgroup envelope, SSD-temperature
   and wear metrics, cache/queue metrics, graceful I/O errors, and restart recovery.
6. **Quality gate:** exact token-diff with bias off; then a saved Q2 task battery judged against a
   frontier reference. Do not infer Q2 usefulness from the BF16 model card.
7. **Release hygiene:** obtain an explicit upstream license before carrying code into our gateway;
   pin llama.cpp; add a build manifest, CI, tests, and retained raw benchmark logs.

## Falsifiable go/no-go sequence

1. **Completed:** exact original-config GLM run under `MemoryHigh=32G`, `MemoryMax=36G`,
   `MemorySwapMax=2G`, `budget=20 GiB`: safe, 0.587 tok/s, 66.4% hits, correct arithmetic only when
   manually chat-templated.
2. **Partly completed:** three independent 20 GiB router-weight results (0.586/0.587/0.592 tok/s)
   establish a stable baseline; the trained probe was a negative result. Repeat the new 60/90 GiB
   points before treating their exact rates as medians.
3. **Completed:** after UMA/TTM reconfiguration, 60 GiB reached 0.943 tok/s / 74.8% hits and 90 GiB
   reached 1.221 tok/s / 77.6% hits; 100 GiB caused a host-level OOM and is rejected. The hit-rate
   gate passed, the current-drive ≥2 tok/s gate did not, and the I/O curve supports storage testing.
4. Benchmark a candidate SSD at actual expert ranges before moving the model. **GO to integration**
   only if projected and then measured decode is at least 2 tok/s with acceptable p99 inter-token
   latency.
5. Build persistent server mode and run representative 1K/8K/32K prompts plus the project's task
   battery. **GO to gateway shadow serving** only after quality, cancellation, memory, and thermal
   gates pass.
6. Multi-user remains a separate gate; Achilles currently provides neither batching nor fairness.

## Sources

- [Achilles repository](https://github.com/menonakhilmenon/achilles)
- [Achilles latest tested safety commit](https://github.com/menonakhilmenon/achilles/commit/e3749954cc790b076ac3059b769dde7169a03fa4)
- [GLM-5.2 official model card](https://huggingface.co/zai-org/GLM-5.2)
- [Pinned Unsloth GLM-5.2 GGUF repository](https://huggingface.co/unsloth/GLM-5.2-GGUF/tree/abc55e72527792c6e77069c99b4cb7de16fa9f23/UD-Q2_K_XL)
- [AMD Strix Halo system optimization](https://rocm.docs.amd.com/en/docs-7.2.0/how-to/system-optimization/strixhalo.html)
