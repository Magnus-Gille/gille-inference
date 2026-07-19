# Achilles GLM-5.2 trained-probe follow-up

## Correction

The first Achilles evaluation tested plan-aware LRU driven by the model's existing router weights.
It did **not** test the separately trained delta-3 linear predictor loaded through `--probe`.
Achilles revision `e3749954cc790b076ac3059b769dde7169a03fa4` includes the trace writer, trainer,
and loader, but not the trace corpus or trained probe blob.

## Local training corpus

Two bounded `--dump` runs produced 386 parsed forward passes:

| Dump | Complete decode passes | Size | SHA-256 |
|---|---:|---:|---|
| `dump-technical.bin` | 192 | 692 MiB | `d68c6e6089088ea3f55b29c6aab17395bf89eeaf1964ba7f57e91484f9b18fe2` |
| `dump-code.bin` | 192 | 692 MiB | `e09e2a3941bef901e4e996fb72bf5bc378bb09eed738d8632f1f4fda022a1395` |

The trainer's deterministic random split yielded 329 training and 57 held-out passes. This is a
small calibration corpus across two prompts, not a production-quality representation of expected
traffic.

## Training

The checked-in `scripts/train_probe_glm52.py` ran in an isolated Python 3.14 environment with CPU
PyTorch 2.13, NumPy, and PyYAML. It recovered 76 router matrices of shape `256 × 6144` and reported:

```text
trained 61 probes; mean recall@8 delta=3: gate-ahead 0.512 -> probe 0.566
```

The training log SHA-256 is
`e7e56a2a10d42c0c5b916e0af04b3852b8a329ecec3f880927db77fcae133628`.

Generated local artifact:

- path: `/opt/achilles/models/glm52-probes-d3.bin`
- size: 469 MiB (`491 MB` decimal)
- header: `78 × 256 × 6144`
- nonzero layer probes: 61
- numeric validation: all finite
- SHA-256: `f4b7618a286589c973962064cc8171618e3f521f4314d873d24251f0e3a2b313`

The corpus and generated artifact remain local and are not redistributed.

## Runtime benchmark

The comparison used the same pinned model, raw prompt, 48-token decode, 20 GiB arena,
`MemoryHigh=32G`, `MemoryMax=36G`, `MemorySwapMax=2G`, `--policy lru --delta 3 --fetch 8`, and zero
fallback requirement.

| Predictor | Decode | Hit rate | io_uring successes | Fallback |
|---|---:|---:|---:|---:|
| Router-weight gate-ahead control | **0.586 tok/s** | **66.4%** | 77,043 | 0 |
| Trained delta-3 probe, fully isolated | **0.524 tok/s** | **56.7%** | 85,386 | 0 |

The clean probe log SHA-256 is
`5aee702f1ff2e5ea73cd5871907efe0e86f5e478218fc56286d7f91c6fac8a72`.

Two earlier probe attempts are excluded: real llama-swap models became resident during each sample.
For the accepted run, the gateway was stopped for roughly four minutes with both a shell recovery
trap and a ten-minute transient systemd recovery timer. The runtime was empty before and after the
sample. The gateway restarted successfully, M5 and Orin health passed, maintenance was off, and the
GPU lease was idle.

## Interpretation

The trained predictor improved its offline held-out mean but reduced end-to-end cache locality and
throughput. The most concrete implementation gap is missing-layer behavior:

1. The trainer writes a zero matrix when a layer's trained probe fails its per-layer holdout guard.
2. The loader enters global probe mode and clears layers whose matrix is zero.
3. Those layers do not fall back to the existing router-weight gate-ahead scorer.

This can turn partial high-quality probe coverage into worse whole-model routing. The next useful
experiment is not another run of this artifact. It is a source-level A/B that preserves the normal
router-weight predictor on untrained layers, evaluated with a larger task-diverse trace corpus and a
held-out-by-prompt split. Because Achilles had no explicit license at the evaluated revision, this
repository records the required modification but does not redistribute a derivative of its source.
