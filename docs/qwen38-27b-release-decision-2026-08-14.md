# Qwen3.8-27B M5 release decision

Date: 2026-08-14

## Decision

Qualify `qwen38-27b` as an explicit authenticated M5 model using the reviewed 64K
Vulkan/RADV profile below. Do not make it an automatic route until the common coding-agent suite
has compared completed work per minute against Qwen3.6 and the existing production tiers.

The release replaces a stale public roster claim for the no-longer-live
`qwen35-122b-a10b`; the older model's decision record remains historical evidence.

## Immutable inputs

- Official model: `Qwen/Qwen3.8-27B`
- Model revision: `1d4bf0f2ff6012fd82039f2fa52739d0dd7c60c0`
- Architecture: dense multimodal `Qwen3_5ForConditionalGeneration`, 27,781,427,952 BF16
  parameters, hybrid linear/full attention, one native MTP layer, 262,144-token native config
- llama.cpp revision: `9b05354ec6fb58b4e665e9a39ebc40285c015638`
- llama.cpp source-archive SHA-256:
  `f59f3fe99e1b1e8f8b733a7e8c909d9da4cfb67ee357abc5b5842fd4772b2358`
- Relocatable Vulkan `llama-server` SHA-256:
  `ca3417ae3bd777f9e84a92f83dd2b64ea9e9cf95eebef5a4e78953f3cbd659d9`
- Q4_K_M GGUF SHA-256:
  `be20c011456d6d6ee76dd11aa63e54d3b5cd81c7dcef50965e379b24c78ee9f1`
- BF16 multimodal-projector SHA-256:
  `e7d0f41302a304ef614d62aaf65359439b6d56c38d6e1715581b729b52fa4806`

The complete runtime bundle is required: its binaries and shared libraries use an
origin-relative runpath. Copying only `llama-server` is invalid.

The sanitized staging evidence manifest has SHA-256
`f5a147e857e99a6b97921419e19ec9b9d907e37ae7ab93a7d1d7296c0802a280`; its exact operator path
remains private deployment state.

## Conversion and parity

All official source files were staged at the immutable revision and verified twice against their
Hub hashes before publication from the incoming directory. BF16, Q8_0, Q6_K, Q5_K_M, and Q4_K_M
GGUFs were created; the selected serving artifact is Q4_K_M. The separate BF16 projector is
required for image input.

A CPU Transformers reference pinned to commit
`a597f974857b3d92939971296bc0deb93d33d780` produced token IDs `[19, 248046]` and final text `4`
for the deterministic parity prompt. Both BF16 and Q4_K_M llama.cpp runs produced the same final
text. A Vulkan/RADV Q4_K_M canary also produced `4`.

## Measured M5 result

All GPU runs used the repository-owned FIFO lease. No live roster or service was changed.

| Arm | Prompt processing | Generation | Notes |
|---|---:|---:|---|
| Q4_K_M, F16 KV, direct, pp512/tg128 | 361.40 tok/s | 12.87 tok/s | 3 repeats |
| Q4_K_M, Q8 KV, direct, pp512/tg128 | 357.48 tok/s | 12.83 tok/s | 3 repeats |
| Q4_K_M, Q8 KV, pp8192/tg128 | 308.76 tok/s | 12.82 tok/s | one release canary |
| Q4_K_M, F16 KV, native MTP depth 2 | 95.03 prompt tok/s | 21.68 tok/s | 57.6% draft acceptance |
| Q4_K_M, Q8 KV, native MTP depth 2 | 95.82 prompt tok/s | 23.21 tok/s | 66.1% draft acceptance |

The server's exact proposed 64K/Q8/MTP/mmproj profile then passed, in one process:

- multimodal image request in thinking mode with the 1,024-token grounding floor:
  23.68 generation tok/s, 71.2% draft acceptance;
- text request in thinking mode: 21.33 generation tok/s, 58.1% draft acceptance;
- per-request non-thinking control: final content `4`, no reasoning content;
- health and process cleanup: passed, GPU lease released.

The direct `llama-bench` TG arm is a fresh decode test rather than generation after the paired PP
arm, so the pp8192 row is an 8K prompt-processing control, not a claim of 8K-populated decode.

## Serving contract

- ID: `qwen38-27b`
- Q4_K_M weights plus BF16 multimodal projector and a 1,024-token minimum per image for Qwen-VL
  grounding quality
- Vulkan / Mesa RADV, all layers offloaded
- 65,536 context, one slot, ubatch 512
- Q8_0 K and V cache, Flash Attention on, 2 GiB prompt cache
- native MTP, draft depth 2
- thinking on by default, matching the official template
- direct answers available per request through
  `chat_template_kwargs: {"enable_thinking": false}`

Q8 KV was selected because its short direct result was within measurement noise of F16, its MTP
canary was faster in the sampled workload, and it reduces long-context cache memory. MTP is enabled
because both text and vision canaries materially beat direct decode without errors. These short
release canaries do not establish broad quality superiority or long-context throughput.

## Remaining proof

Production promotion still requires the exact immutable code revision, stable non-staging runtime
and model paths, post-copy hashes/runpath/dependency checks, a reviewed live roster backup/change,
service restart, authenticated private and public edge canaries, and a tested rollback. The common
coding-agent suite must decide whether Qwen3.8's quality offsets dense-model throughput before any
automatic route changes.
