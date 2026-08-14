# Strix Halo release ingestion and benchmark runbook

This runbook owns the reproducible, non-deploying first steps for new model releases on the
128 GB Ryzen AI Max+ 395 / Radeon 8060S (`gfx1151`) node:

1. archive and inspect an official public model release without downloading weights; and
2. run a pinned, single-stream `llama-bench` PP/TG matrix that emits machine-readable JSON plus a
   human-readable Markdown report.

It does **not** download or convert weights, replace a runtime, alter llama-swap, restart the
gateway, or publish a performance conclusion. Conversion, reference-inference parity, live
serving, and deployment remain separate reviewed steps.

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

On 14 August 2026, implementation validation found `Qwen/Qwen3.8-27B` not yet publicly available
(HTTP `401`). The public `Qwen/Qwen3.8-2.4T-A95B` control files were successfully pinned to Hub
revision `207bd685a7e3696cfaff12ded7c6a7ea0f88c996` and used as the live smoke test:

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

Supported axes are `backend`, `quant`, `kv`, `speculation`, `runtime`, and `parallelism`. The
comparator deliberately declares no automatic winner: the relevant issue's preregistered quality,
short/long-context, soak, memory, and stability gates still decide adoption.

For a Vulkan/HIP A/B, use separately reviewed binaries built from the intended revision, keep
model bytes and all flags identical, and change only `--llama-bench`, `--backend`, and the output
prefix. A backend claim requires repeated identical workloads; the label alone is not evidence.

## Qwen3.8 progression gate

Proceed from ingestion to conversion and hardware benchmarking only when all of these are true:

1. the official target is public and has an immutable revision;
2. `REPORT.md` resolves topology, attention, context, tokenizer, modality, and MTP from official
   artifacts, leaving unsupported facts explicit;
3. the selected transformers and llama.cpp revisions explicitly support the observed architecture;
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
