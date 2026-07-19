# Achilles / GLM-5.2 cache sweep after UMA/TTM reconfiguration

- **Date:** 2026-07-13
- **Host:** Ryzen AI Max+ 395 M5, 128 GB physical unified memory
- **Inputs:** same pinned Achilles, llama.cpp, and seven-shard GLM-5.2 `UD-Q2_K_XL` artifact as the
  [main evaluation](achilles-glm52-m5-evaluation-2026-07-12.md)
- **Predictor/eviction:** model-router gate-ahead, plan-aware LRU, `--delta 3 --fetch 8`

## Question

Does replacing the original 64 GiB fixed UMA carveout with 512 MiB fixed UMA plus a 100 GiB
dynamic TTM/GTT limit create a credible path from the reproduced ~0.59 tok/s baseline toward the
upstream 2–5 tok/s target?

## Live configuration

After the physical BIOS change and the official AMD `amd-ttm --set 100` flow:

- Linux `MemTotal`: `128651032 kB` (~122.7 GiB)
- fixed VRAM: exactly `536870912` bytes (512 MiB)
- TTM `pages_limit`: `26214400` pages (100 GiB)
- swap: 8 GiB host swap, with every Achilles unit limited to `MemorySwapMax=2G`
- pre-run memory: 118 GiB available, zero memory PSI

The runner and manifest on the M5 matched the published SHA-256 values. All seven model shards were
complete, the GPU lease was idle, and no real user inference had occurred for about nine minutes.

## Isolation and recovery controls

The sweep:

1. engaged guest maintenance with a two-hour automatic expiry;
2. confirmed zero inflight and zero queued owner requests;
3. armed a transient 90-minute systemd gateway-recovery timer;
4. stopped `home-gateway` so owner traffic could not contaminate a sample;
5. acquired and released the FIFO GPU lease independently for every cold-process point;
6. required empty llama-swap residency and zero io_uring fallback after each accepted run; and
7. restored the gateway through a shell trap, independently backed by the recovery timer.

## Results

Each accepted point generated the same 48 raw tokens after a nine-token prefill. The raw output
again contained the correct multiplication (`17*19=323`) inside a factually contradictory passage;
this sweep measures paging behavior, not quality.

| Expert cache | MemoryHigh / MemoryMax | Prefill | Decode | Hit rate | io_uring successes | Fallback | Result |
|---:|---:|---:|---:|---:|---:|---:|---|
| 20 GiB | 32 / 36 GiB | 0.75 tok/s | **0.592 tok/s** | 66.4% | 77,043 | 0 | accepted |
| 60 GiB | 72 / 76 GiB | 0.76 tok/s | **0.943 tok/s** | 74.8% | 48,183 | 0 | accepted |
| 90 GiB | 102 / 106 GiB | 0.74 tok/s | **1.221 tok/s** | 77.6% | 36,771 | 0 | accepted |
| 100 GiB | 112 / 116 GiB | — | — | — | — | — | **host-level OOM; rejected** |

The 90 GiB point is 2.06× the 20 GiB throughput and removes 52% of successful io_uring completions. The
incremental return is already flattening: 20→60 GiB adds 0.351 tok/s, while 60→90 GiB adds
0.278 tok/s. At 1.221 tok/s, a 500-token answer still takes about 6.8 minutes after prefill.

The 100 GiB process completed arena replacement, then the kernel invoked the global OOM killer. It
killed only `achilles-arena`, which had `103660292 kB` anonymous RSS (~98.9 GiB), but this was a
**host-level** OOM rather than a clean `MemoryMax` rejection. The dense Vulkan/TTM allocation and
other host costs consumed memory outside the nominal arena budget. The point is excluded and must
not be retried under the same envelope.

## Storage sensitivity—not a performance promise

Across the three accepted points, a simple fit of decode seconds against successful io_uring
operations is:

```text
decode_seconds ≈ 0.963 + 0.0010396 × io_uring_successes   (R² = 0.99996, n = 3)
```

This is quantitatively consistent with the stock SSD dominating these three measurements. As a
sensitivity calculation, halving the I/O term at the 90 GiB point would imply roughly 2.4 tok/s. A dedicated
drive sustaining 4–5 GB/s at the actual 3–12 MiB random-direct ranges is therefore a **credible
next experiment**.

It is not proof that a faster drive will scale linearly: there is one short prompt per point, cache
size changes request ordering as well as I/O count, and queueing/overlap/thermal behavior may change
on another SSD. Repeat measurements and an actual expert-range storage benchmark are required
before a purchase or integration claim.

## Safety correction

The published runner previously required only `budget + 16 GiB` of host RAM, mirroring its process
`MemoryMax`. The 100 GiB OOM proves that arithmetic omitted non-arena GPU/runtime/service costs.
The runner now:

- defaults the sweep to the measured-feasible `20,60,90` GiB points; and
- reserves 28 GiB of host headroom before launch, which admits 90 GiB and refuses 100 GiB on this
  122 GiB Linux-visible host.

The cgroup, swap cap, lease, residency checks, maintenance acknowledgement, and timeouts remain in
place. The host-headroom guard prevents recurrence of this exact 100 GiB point on this host; it does
not reclassify the global OOM as an acceptable benchmark result or prove every intermediate budget
safe.

## Retained evidence

Raw logs remain owner-local on the M5:

| Log | SHA-256 |
|---|---|
| `20260713T074204Z-baseline-b20.log` | `0fad76efdc2876ccfb6400569b40cf24857764628f70b9467d2880a95b77f405` |
| `20260713T074534Z-baseline-b60.log` | `40af851ea5abd2f6fbf40146669ff13eb9cb5372a8e4d0540dafdf8841fefa78` |
| `20260713T074833Z-baseline-b90.log` | `156dd0a354b7d6fd1ecb04c016343f3cd99792521de5ca043a744e214594c333` |
| `20260713T075136Z-baseline-b100.log` | `72d9c57e5869baebdaf354fae7d9361cb4dccae6f1cbd9585bf517a16331b65d` |
| `20260713T075416Z-baseline-b100-kernel-oom.log` | `fa8a9a56a616d5cfae06b66c1dba86fc7cb7ffb8bd8f952c1d4bbdeba4558b35` |

The final two artifacts are negative safety evidence: the arena log contains no successful decode,
and the bounded kernel-journal excerpt preserves the OOM-killer diagnosis.

## Production recovery

After the rejected point:

- `home-gateway`, `llama-swap`, and `cloudflared` were active;
- maintenance was off, inflight/queued work was zero, and the GPU lease was idle;
- tailnet and public `/healthz` both reported the M5 and Orin healthy;
- a real post-OOM Mellum GPU smoke returned exactly `OK` at ~216 tok/s; and
- current memory PSI returned to zero. About 931 MiB of the 8 GiB host swap remained allocated,
  with 7.1 GiB free and no current swap pressure.

## Decision

The memory-layout modification worked and materially improved Achilles, but it did not make the
current implementation interactive. The overall verdict remains **B: viable only with further
modifications**.

The evidence now supports a bounded next step: repeat the 60/90 GiB points for variance, then test a
candidate high-end DRAM Gen4 SSD at actual expert sizes. It does **not** support gateway integration,
multi-user claims, another 100 GiB attempt, or buying storage on marketing sequential throughput
alone.
