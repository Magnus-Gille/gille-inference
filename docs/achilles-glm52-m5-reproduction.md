# Reproducing the Achilles / GLM-5.2 M5 experiment

This runbook reproduces the measurements in
[`achilles-glm52-m5-evaluation-2026-07-12.md`](achilles-glm52-m5-evaluation-2026-07-12.md)
without vendoring unlicensed Achilles source or model weights.

## Pinned inputs

- Achilles: `menonakhilmenon/achilles@e3749954cc790b076ac3059b769dde7169a03fa4`
- llama.cpp: `ggml-org/llama.cpp@e3546c7948e3af463d0b401e6421d5a4c2faf565`
- Model: `unsloth/GLM-5.2-GGUF@abc55e72527792c6e77069c99b4cb7de16fa9f23`
- Quant: `UD-Q2_K_XL`, seven shards, about 237 GiB on disk
- Digests: [`achilles-glm52-ud-q2-k-xl.sha256`](achilles-glm52-ud-q2-k-xl.sha256)

Achilles had no explicit license at the evaluated revision. Clone and inspect it for the experiment,
but do not redistribute its source or carry derivatives into another product without permission.

## Build prerequisites

The tested host used Ubuntu 26.04, kernel 7.0.0-27, Mesa 26.0.3, and Vulkan 1.4 on a Ryzen AI
Max+ 395. The additional build dependency was `liburing-dev`.

Build the pinned llama.cpp revision with Vulkan enabled, then compile Achilles' `src/arena.cpp`
against that build. The exact local binary path is supplied to the harness through `ACHILLES_BIN`;
the script intentionally makes no claim that upstream currently provides a stable build interface.

## Safety model

[`scripts/achilles-glm52-m5.sh`](../scripts/achilles-glm52-m5.sh) enforces the controls used in the
study:

- the repository's FIFO GPU lease;
- explicit per-run systemd memory limits;
- no more than 2 GiB process swap;
- an empirical 28 GiB host-memory reserve for dense Vulkan/TTM allocations, runtime workspace,
  page tables, and production services outside the nominal expert arena;
- llama-swap resident-model unload after acquiring the lease;
- refusal to use a large expert cache unless host RAM and TTM are large enough;
- separately named router-weight and trained-probe predictor modes feeding plan-aware LRU;
- an explicit acknowledgement if the production gateway remains live, because ordinary gateway
  traffic does not participate in the batch-job GPU lease;
- logs under `data/achilles-glm52/`, which is ignored by git.

The harness does not change BIOS, TTM, GRUB, initramfs, service configuration, or model files. It
does not stop services, but it deliberately unloads any resident llama-swap model before a measured
run and verifies that the runtime is empty afterward.

## Commands

Set the paths used on the test box (these are the defaults shown explicitly):

```bash
export ACHILLES_BIN=/opt/achilles/bin/achilles-arena
export GLM52_DIR=/srv/models/glm52-achilles/UD-Q2_K_XL
```

Verify all seven pinned shards once. This reads the full 237 GiB artifact:

```bash
bash scripts/achilles-glm52-m5.sh verify
```

Reproduce the measured raw 48-token throughput baseline at a 20 GiB expert-cache budget:

```bash
bash scripts/achilles-glm52-m5.sh baseline --budget-gib 20 --ack-live-traffic-risk
```

This selects plan-aware LRU using the model's existing router weights for gate-ahead prediction. In
the pinned source, predictions populate a `plan_hint` table; the LRU evictor then protects experts
predicted for later layers in the current token. This is the reproducible no-extra-artifact control,
not the separately trained predictor.

The explicit-policy confirmation run measured 0.586 tok/s, 66.4% hits, 77,043 successful io_uring
completions, and zero fallback, matching the original implicit-default result within measurement
noise.

### Train and test the separate predictor

The evaluated Achilles revision does not include its GLM trace corpus or trained
`glm52-probes-d3.bin`. Its checked-in `scripts/train_probe_glm52.py` expects:

- at least 200 training and 20 held-out single-token forward passes per eligible layer;
- dumps written by `achilles-arena --dump` under `traces/glm52/dump*.bin`;
- the seven shards under its hard-coded `models/glm52-gguf/UD-Q2_K_XL` path;
- Python with NumPy, PyTorch, and PyYAML.

Our local calibration used two diverse 192-token dumps. After creating an isolated venv and a local
symlink from the trainer's expected model path to `GLM52_DIR`, run the upstream trainer from the
pinned Achilles checkout:

```bash
.venv-probe/bin/python scripts/train_probe_glm52.py
```

Do not accept file creation alone as success. Confirm that the trainer reports nonzero retained
layers and held-out recall, then validate the blob dimensions and finite values. Point this harness
at the resulting local artifact and run the separate mode:

```bash
export ACHILLES_PROBE_PATH=/opt/achilles/models/glm52-probes-d3.bin
bash scripts/achilles-glm52-m5.sh probe-baseline \
  --budget-gib 20 \
  --ack-live-traffic-risk
```

The current M5 artifact retained 61 probes and improved mean held-out recall@8 from 0.512 to 0.566,
but the fully isolated runtime result regressed from 0.586 tok/s / 66.4% hits to 0.524 tok/s / 56.7%
hits. Treat it as negative evidence, not as the default. The trace corpus, venv, and generated blob
remain local; they are not redistributed with this repository.

See the [trained-probe follow-up](achilles-glm52-probe-training-2026-07-12.md) for checksums,
excluded contaminated attempts, and the implementation-gap analysis.

Run the manually serialized chat-template smoke that should answer `323`:

```bash
bash scripts/achilles-glm52-m5.sh quality --budget-gib 20 --ack-live-traffic-risk
```

After the documented small-UMA / 100 GiB-TTM reconfiguration, run the measured-feasible
cold-process cache sweep:

```bash
bash scripts/achilles-glm52-m5.sh sweep \
  --budgets 20,60,90 \
  --ack-live-traffic-risk
```

The 2026-07-13 sweep measured 0.592 / 0.943 / 1.221 tok/s at 20 / 60 / 90 GiB, with
66.4% / 74.8% / 77.6% hits and zero fallback. An explicit 100 GiB attempt completed arena
replacement but triggered the host-level OOM killer before decode at ~98.9 GiB anonymous RSS.
That point is rejected. The runner's 28 GiB host-reserve preflight now refuses it on this
122 GiB Linux-visible host. See the
[cache-sweep evidence](achilles-glm52-cache-sweep-2026-07-13.md) for isolation, checksums, recovery,
and interpretation.

Inspect commands without touching the GPU:

```bash
bash scripts/achilles-glm52-m5.sh baseline --budget-gib 20 --dry-run
bash scripts/achilles-glm52-m5.sh probe-baseline --budget-gib 20 --dry-run
bash scripts/achilles-glm52-m5.sh sweep --budgets 20,60,90 --dry-run
```

Each sweep point is intentionally a cold process. That measures cache-budget effects but does not
simulate the persistent server Achilles would need for interactive use.

## Interpreting results

Use `ACHILLES decode` as the primary throughput value, `ACHILLES arena` for hit rate, and
`ACHILLES io` to reject fallback-contaminated runs. Reject a run if:

- it times out or exits non-zero;
- it reaches a host-level or cgroup OOM (the partial log is retained as negative safety evidence);
- io_uring fallback is non-zero;
- memory PSI remains elevated after completion;
- another llama-swap model became resident during the sample;
- output is malformed or the templated quality smoke does not return `323`.

Do not infer full-model quality from paging equivalence or from the arithmetic smoke. The Q2 model
still needs a representative saved task battery before it earns any routing role.
