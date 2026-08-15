# Strix Halo release ingestion and benchmark runbook

This runbook owns the reproducible, non-deploying first steps for new model releases on the
128 GB Ryzen AI Max+ 395 / Radeon 8060S (`gfx1151`) node:

1. archive and inspect an official public model release without downloading weights;
2. stage the exact source-weight revision with size, hash, disk-reserve, and atomic-publication
   checks without changing the live roster; and
3. run a pinned, single-stream `llama-bench` PP/TG matrix that emits machine-readable JSON plus a
   human-readable Markdown report.

It does **not** convert weights, replace a runtime, alter llama-swap, restart the gateway, or
publish a performance conclusion. Reference-inference parity, conversion, live serving, and
deployment remain separate reviewed steps.

## Qwen3.8 release ingestion

The default command watches the Strix-relevant release target:

```bash
npm run release:ingest-model
```

The command queries only the public Hugging Face API. A public release is pinned to the immutable
40-character Hub revision before any file is fetched. The allow-list is limited to small control
files (`config.json`, generation/tokenizer config, chat template, special tokens, and the official
model card); weight-like or unknown filenames are rejected. Each archived source file receives a
SHA-256 in `manifest.json`.

Outputs are written beneath the gitignored directory:

```text
data/model-releases/<owner>--<model>/<immutable-revision>/
  config.json
  ...other available control files...
  manifest.json
  release.json
  REPORT.md
```

Exit status is deliberately automation-friendly:

- `0`: public release archived and inspected;
- `3`: not publicly available yet (`401`, `403`, or `404`); and
- `1`: malformed input or inconsistent/unsafe public metadata.

On 14 August 2026, `Qwen/Qwen3.8-27B` became publicly available and was pinned to Hub revision
`1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`. Its official config identifies a dense,
multimodal `Qwen3_5ForConditionalGeneration` model with hybrid linear/full attention, one native
MTP hidden layer, 262,144-token native context, and 27,781,427,952 BF16 parameters. The public
`Qwen/Qwen3.8-2.4T-A95B` control files remain the earlier pipeline smoke test at revision
`207bd685a7e3696cfaff12ded7c6a7ea0f88c996`:

```bash
npm run release:ingest-model -- --model Qwen/Qwen3.8-2.4T-A95B
```

That smoke test identified the flagship as a text-only hybrid linear/full-attention MoE with 512
experts, 10 routed experts per token, one MTP hidden layer, 262,144 native context, and 95B active
parameters. The active count comes from the archived official model card; the exact total tensor
count comes from Hub safetensors metadata. This is pipeline validation, not a claim that the 2.4T
model fits or should run on one Strix Halo.

If the official config or model card does not prove a field, `release.json` and `REPORT.md` retain
`unknown`. They do not infer a pre-release architecture from the model name.

## Source-weight staging (no live mutation)

After ingestion records the exact public revision, stage that revision into an explicitly chosen
non-live root on M5:

```bash
npm run release:stage-model -- \
  --model Qwen/Qwen3.8-27B \
  --revision <40-character-revision-from-release.json> \
  --out-root <non-live-staging-root>
```

The staging command rechecks that the official repository is explicitly public and ungated and
that its current immutable revision equals the requested revision. It follows only same-origin,
same-model, same-revision Hub tree pagination; rejects unsafe paths, unknown remote-code files,
missing index shards, malformed LFS metadata, and ambiguous weight layouts; and selects only
recognized config/tokenizer/processor controls plus the exact safetensors files named by the
official index.

Downloads are resumable under `.incoming-<revision>`. Every LFS artifact must match both the Hub
size and SHA-256 OID; controls receive recorded SHA-256 values. The completed deterministic
`stage-manifest.json` and artifacts become visible at the final revision path through one atomic
rename. Existing final directories are accepted only after every file is rehashed against their
manifest. The default disk guard preserves at least 128 GiB after the worst-case download; use
`--min-free-after-gib` only with an explicitly reviewed alternative reserve.

This command does not select a transformers/llama.cpp revision, run reference inference, convert
to GGUF, quantize, edit llama-swap, or restart the gateway. Those remain subsequent proof gates.

## Pinned llama.cpp source-compatibility gate

Before installing dependencies or starting a build, prove that an explicitly pinned llama.cpp
checkout contains both conversion and runtime wiring for the architecture in archived
`release.json`:

```bash
npm run release:check-runtime -- \
  --release-json <archive>/release.json \
  --llama-dir <separate-pinned-llama.cpp-checkout> \
  --runtime-revision <exact-40-character-llama.cpp-commit> \
  --out-dir <compatibility-report-directory>
```

The command verifies that checkout `HEAD` equals the requested commit and reads and hashes the
bounded source files directly from that immutable commit object, never from mutable or untracked
working-tree files. For supported dense or MoE Qwen3.5 text and multimodal wrapper configs it
independently requires the converter registry/class, GGUF architecture mapping, runtime architecture/factory,
model implementation, and—when the official release declares it—the native MTP driver and graph.
Unknown, ambiguous, converter-only, runtime-only, commit-mismatched, or missing-MTP configurations
produce a machine-readable `compatibility.json`, a human-readable `REPORT.md`, and exit status `2`.
Malformed input produces exit `1`; only a fully proven source path exits `0`.

The live smoke test used official flagship release revision
`207bd685a7e3696cfaff12ded7c6a7ea0f88c996` and pinned llama.cpp revision
`4c1a0af40d88c7fbb3b15c85bf2e8016d1d5b64c`. It proved source-level
`Qwen3_5MoeForCausalLM` plus native-MTP wiring. This does not qualify the 4.89 TB source model for
M5 and does not prove compilation, tensor compatibility, reference parity, backend correctness,
performance, or deployment readiness. The 27B release was checked independently against its own
immutable config and upstream llama.cpp revision `9b05354ec6fb58b4e665e9a39ebc40285c015638`.
The gate proved the exact `Qwen3_5ForConditionalGeneration` wrapper registration, dense Qwen3.5
converter/GGUF/runtime path, and native-MTP wiring. Build, tensor conversion, reference parity,
backend correctness, performance, and deployment remain separate proof gates.

## Reproducible direct benchmark

Use a reviewed, already-built llama.cpp binary and an already-staged GGUF. For an uncontaminated
run, use the repository-owned exclusive window. It makes the isolated gateway identity acquire
the canonical lease, fences owner and guest inference, drains admitted work, and verifies stable
llama-swap residency before it runs the supplied command. `M5_MAINTENANCE_KEY` must come from the
approved private operator credential source and is never accepted in argv.

```bash
npm run maintenance:run -- \
  --base-url http://127.0.0.1:8080 \
  --ttl-seconds 7200 \
  --drain-timeout-seconds 60 \
  --evidence data/strix-benchmarks/qwen3-coder-window.json \
  -- npm run benchmark:strix -- \
    --llama-bench /home/magnus/llama.cpp/build/bin/llama-bench \
    --model /home/magnus/models/qwen3-coder-30b-a3b/model-Q4_K_S.gguf \
    --model-id Qwen/Qwen3-Coder-30B-A3B \
    --quant Q4_K_S \
    --backend vulkan \
    --kv-k q8_0 \
    --kv-v q8_0 \
    --fa on \
    --batch 2048 \
    --ubatch 512 \
    --contexts 8192,32768,65536,131072 \
    --out data/strix-benchmarks/qwen3-coder-q4ks-vulkan
```

The base URL above is an example, not a listener assumption: supply the gateway origin verified by
the live deployment runbook. The evidence file is mode/timestamps/exit/restoration/residency only;
it contains neither the admin credential, release token, command argv, prompt, nor model output.

The harness:

- computes the GGUF SHA-256 before execution;
- invokes `llama-bench` directly as argv, never through a shell;
- runs `pp512` and `tg128` at short context plus populated depths 8K, 32K, 64K, and 128K;
- accepts 256K only in addition to the required four depths;
- records the runtime commit/build, measured backend, CPU/GPU identity, kernel, Mesa, ROCm,
  quant, KV types, FA, batch/ubatch, parallelism, model size, and parameter count;
- samples process RSS and host available RAM; hwmon temperature uses the highest readable channel,
  while power averages the highest readable channel per sample and is not wall power; and
- refuses to write a report if any required PP/TG/context cell is missing or if the measured
  backend does not match `--backend`.

It writes `<out>.json` and `<out>.md` atomically. `llama-bench` explicitly excludes tokenization
and sampling time, so this direct mode records TTFT as unmeasured. Speculation is disabled and
acceptance is therefore not applicable. Use the streaming server/agent benchmark for TTFT,
acceptance rate, prefix-cache benefit, and completed useful tasks per minute.

## Streaming server and agent-shaped matrix

The streaming runner complements `llama-bench`; it does not replace the direct PP/TG control. It
uses deterministic public fixtures from `benchmarks/strix-agent-fixtures.json`, stores output
SHA-256 rather than model text, and exercises code, reasoning, JSON, native tool-call, and prose
responses at 1, 2, 4, and 8 concurrent requests.

First capture the already-running server's immutable provenance. The process id and every serving
field must be explicit; the command hashes the model artifact, running executable, and raw process
argv but stores neither paths nor argv contents:

```bash
npm run benchmark:strix-provenance -- \
  --pid 12345 \
  --model-artifact /srv/models/Qwen3.6-35B-A3B-Q4_K_M.gguf \
  --runtime-commit 0123456789012345678901234567890123456789 \
  --backend vulkan --quant Q4_K_M --context 131072 \
  --kv-k q8_0 --kv-v q8_0 --fa on --batch 2048 --ubatch 512 \
  --parallelism 1 --speculation none --draft-depth none \
  --cache-ram-mib 8192 --ctx-checkpoints 32 --checkpoint-min-step 8192 \
  --cache-idle-slots on \
  --out data/strix-benchmarks/qwen36-direct-provenance.json
```

Then run against an already-reviewed OpenAI-compatible endpoint. Loopback llama-server exposes its
content-blind speculative counters at `/metrics` when started with `--metrics`; remote metrics are
disabled by default unless `--metrics-url` is supplied explicitly. Credentials are accepted only
through a named environment variable, never argv.

```bash
npm run benchmark:strix-server -- \
  --base-url http://127.0.0.1:8091/v1 \
  --model qwen36-a3b \
  --fixtures benchmarks/strix-agent-fixtures.json \
  --provenance data/strix-benchmarks/qwen36-direct-provenance.json \
  --concurrency 1,2,4,8 --repetitions 3 --max-tokens 128 \
  --out data/strix-benchmarks/qwen36-direct-server
```

The JSON/Markdown pair records measured TTFT, total latency, internal llama.cpp PP/TG rates when
returned, prompt-cache hits, speculative accepted/draft token deltas, aggregate throughput,
deterministic oracle pass rate, and useful completions per minute. A transport-complete run with
any failed request exits `2`; malformed setup exits `1`.

Compare exactly one declared axis. The comparator rejects changed control fields and unequal
fixture/concurrency cells before calculating deltas:

```bash
npm run benchmark:strix-compare -- \
  --control data/strix-benchmarks/qwen36-direct-server.json \
  --candidate data/strix-benchmarks/qwen36-mtp2-server.json \
  --axis speculation \
  --out data/strix-benchmarks/qwen36-direct-vs-mtp2
```

Supported axes are `backend`, `quant`, `kv`, `cache`, `speculation`, `runtime`, and `parallelism`.
The `cache` axis permits only RAM-cache size, checkpoint count/minimum step, idle-slot caching, and
the resulting argv hash to change. Set all four cache fields explicitly, including zero/off control
arms, so server defaults cannot silently invalidate the experiment. `--cache-ram-mib -1` records
llama-server's documented unlimited mode; values below `-1` are rejected. The
comparator deliberately declares no automatic winner: the relevant issue's preregistered quality,
short/long-context, soak, memory, and stability gates still decide adoption.

For a Vulkan/HIP A/B, use separately reviewed binaries built from the intended revision, keep
model bytes and all flags identical, and change only `--llama-bench`, `--backend`, and the output
prefix. A backend claim requires repeated identical workloads; the label alone is not evidence.

### Tool-turn prefix-cache regression probe

Use the same immutable server-provenance artifact to measure cold/warm plain prompts, cold/warm
tool turns, and an exact repeat after extending a tool conversation. The runner refuses dirty
probe sources, accepts credentials only through a named environment variable, honors bounded
`Retry-After`, and writes no prompt or completion content:

```bash
npm run benchmark:strix-prefix-cache -- \
  --base-url http://127.0.0.1:8091/v1 \
  --model qwen36-a3b \
  --provenance data/strix-benchmarks/qwen36-direct-provenance.json \
  --out data/strix-benchmarks/qwen36-prefix-cache \
  --api-key-env M5_API_KEY \
  --stable-items 1800 --max-tokens 1
```

Exit `0` means the exact extended repeat stayed inside the warm-control tail plus the captured
runtime's checkpoint-minimum window. Exit `1` means it exceeded that checkpoint-aware bound; exit
`2` means the result was unobservable or setup failed. The JSON/Markdown pair is mode 0600 and
separates gateway quota wait from the successful request and server prefill timings. This short
probe does not replace a checkpoint-crossing, long-generation multi-tool test when evaluating a
generation-checkpoint patch.

## Read-only host reproducibility snapshot

Capture the host state beside every benchmark series. The firmware UMA setting is not reliably
observable from Linux, so it must be supplied from the operator's BIOS observation (use `unknown`
when it was not checked):

```bash
npm run benchmark:strix-host -- \
  --bios-uma 64G \
  --out data/strix-benchmarks/host-profile-before
```

The command performs no tuning and writes mode-0600 JSON plus Markdown. It records kernel,
Mesa/ROCm, memory and swap, CPU/platform power policy, DRM VRAM/GTT/clocks, and available hwmon
temperature/power observations. Only explicitly allow-listed AMD/TTM memory parameters are copied
from the kernel command line; the raw command line is never stored. Missing or unreadable values
remain `null` rather than being reported as zero. Hwmon power is a point observation, not wall
energy, so publish wall-meter evidence for efficiency claims.

Use issue #195's one-variable A/B contract for any BIOS, kernel, memory, clock, or power change.
The snapshot does not authorize those mutations and does not make a non-Strix capture a hardware
result.

## Qwen3.8 progression gate

Proceed from ingestion to conversion and hardware benchmarking only when all of these are true:

1. the official target is public and has an immutable revision;
2. `REPORT.md` resolves topology, attention, context, tokenizer, modality, and MTP from official
   artifacts, leaving unsupported facts explicit;
3. `release:check-runtime` passes for the selected exact llama.cpp revision, followed by a clean
   build of that separate checkout; the selected exact transformers revision supports the same
   observed architecture;
4. converted output matches saved reference transformers inference before speed measurement; and
5. the GGUF, runtime binary, backend, and system state can be named by hash/version in the report.

Do not publish “Qwen3.8 is faster” or “Qwen3.8 is better” from a lone microbenchmark. The product
decision remains completed correct coding work per minute against the same repository task suite.

## Primary references

- [Qwen3.8 flagship model and immutable control files](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B)
- [Official llama-bench syntax and JSON output](https://github.com/ggml-org/llama.cpp/tree/master/tools/llama-bench)
- [Official llama-server timings, cache, metrics, and speculative options](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)
- [Official llama.cpp speculative-decoding guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md)
- [AMD Strix Halo system optimization](https://rocm.docs.amd.com/en/latest/how-to/system-optimization/strixhalo.html)
- [Existing Vulkan/HIP experiment contract, issue #129](https://github.com/Magnus-Gille/gille-inference/issues/129)
