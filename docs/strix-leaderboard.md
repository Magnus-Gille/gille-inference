# Strix Halo 128 GB inference leaderboard

**Updated:** 15 August 2026

**Machine-readable source:** [`../benchmarks/strix-leaderboard.json`](../benchmarks/strix-leaderboard.json)

**Reference targets:** [`../configs/strix-reference-profiles.json`](../configs/strix-reference-profiles.json)

This leaderboard ranks measured utility, not model novelty. Configured context and actually
populated context are separate fields. A blank measurement means the cited artifact did not
capture it; it is never backfilled from a configured limit or an external report.

## Category leaders

| Category | Current leader | Qualification |
|---|---|---|
| Fastest useful model | Mellum2-12B-A2.5B | 123.62 tok/s and 94% verifier-backed pass rate over 276 narrow-leaf attempts; not a broad coding agent |
| Fastest strong coding model | Qwen3.6-35B-A3B | 26/30 Gate D passes and 1.73 correct runs/minute in the fresh three-seed comparison |
| Best coding agent | Qwen3.6-35B-A3B | Best completed correct work/minute; Qwen3.8 remains the broad-edit escalation |
| Strongest interactive model | Qwen3.8-27B | 30/30 Gate D correctness, but 0.86 correct runs/minute and a 378 s tail |
| Best long-context model | gpt-oss-120B | Qualified at 64K with 12/12 cold-context cases and 35.1 generation tok/s |
| Best VLM | **Unqualified** | Qwen3.8 passed a vision canary, but no repeatable VLM task score exists |
| Best maximum-capability model | gpt-oss-120B | Current standard large-model lane; this is task-specific, not a universal quality claim |

## Measured profiles

| Model | Quant | Backend | Configured / populated context | PP | TG | MTP/spec | RAM | Quality / task score |
|---|---|---|---|---:|---:|---|---:|---|
| Mellum2-12B-A2.5B | Q4_K_M | production llama.cpp; backend not restamped | 131K / not captured | — | 123.62 | none recorded | — | 94%, 276 verifier-backed attempts |
| Qwen3.6-35B-A3B | Q4_K_M | deployed llama.cpp; backend not restamped | 131K / not captured | — | — | thinking off | — | 26/30 Gate D; 1.73 correct runs/min |
| Qwen3.8-27B | Q4_K_M + BF16 mmproj | Vulkan/RADV | 64K / not captured in MTP canary | 95.82 | 23.21 | native MTP depth 2, 66.1% acceptance | — | 30/30 Gate D; 0.86 correct runs/min |
| Qwen3-Coder-Next-80B | Q4_K_M | production llama.cpp; backend not restamped | 131K / not captured | — | 62.4 | none recorded | — | 93%, 93 verifier-backed attempts; not in matched three-seed study |
| gpt-oss-120B | MXFP4 | pinned llama.cpp; backend not restamped | 64K / 80% and 92% matrix, max ≈60.3K | — | 52.2 normal; 35.1 at 64K | none recorded | 58.9 GiB server RSS | 63.1% strict, 86.5% pass+partial; 12/12 at 64K |

All rows are `LOCAL-MEASURED`. The evidence sources and machine-readable nulls are recorded in the
JSON file. Results from different batteries are not interchangeable: the category table states the
scope used for each winner.

## Missing promotion evidence

- Qwen3-Coder 30B-A3B does not yet have a current immutable-profile baseline in this repository.
- No candidate has a qualified repeatable VLM task score.
- The fresh Qwen3.6/Qwen3.8 Gate D result lacks turns, tokens, and model-only time because the old
  runner recorded wall time only. New Pi runs now capture those content-blind fields.
- Qwen3.8's 64K serving contract is configured capacity, not a 64K-populated agent benchmark.

The next useful update is a preregistered fresh real-repository coding study using the instrumented
Pi runner, with turns, tool calls, prompt/completion tokens, observed model-message time, total wall
time, and deterministic test outcomes.
