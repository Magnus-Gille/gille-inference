# llama-swap cold-swap latency matrix — measured results (2026-07-02)

**Status:** measured data. This is the measurement that
`docs/keep-warm-mellum-design-note-2026-07-01.md` (recommendation #5, "measure first") said was
missing for the keep-warm/pinning decision. That note had only two stale, informally-remembered
numbers (~38s and ~8-10s) from unrelated sessions; this doc replaces them with a controlled matrix.

## How it was measured

- **Tool:** `scripts/measure-swap-latency.ts` (this branch). Per model, one timed minimal chat
  completion while the model is cold (llama-swap has to swap it in) immediately followed by an
  identical warm call; `swap_cost_ms = cold_total_ms − warm_total_ms` isolates the swap+load tax
  from ordinary prefill. Strictly sequential — one request in flight ever.
- **Endpoint:** llama-swap loopback (`http://127.0.0.1:8091`), unauthenticated, on the box.
- **Run:** `--repeats 2` (two full passes, model order rotated between passes so different
  from→to swap pairs are sampled), quiet box, GPU-lease-wrapped, 2026-07-02.
- **Contamination guard:** `/running` checked before and after every sample; a foreign model
  resident afterward flags the sample contaminated and excludes it from the medians.
  **Zero contamination** in this run — every sample is clean.
- **Raw data:** `/srv/gille-inference/data/swap-latency-2026-07-02.jsonl` (data/ is gitignored;
  the JSONL stays on the box).
- **Caveat — warm call reuses the identical prompt.** The warm call sends the exact same
  `"hi"` message as the cold call. If llama.cpp's per-slot prefix cache hits on that identical
  prompt, `warm_ms` reflects "resident + cached prefill" rather than "resident + a typical
  fresh prefill," which would make `swap_cost_ms` a (probably marginal) overestimate of pure
  swap+load cost. Given the probe prompt is ~1–2 tokens, this effect is likely single-digit
  milliseconds against multi-second swap costs and doesn't change the conclusions below, but it
  is not controlled for — a future pass could vary the warm-call content to rule it out.

## Per-model medians

| model | median_cold_ms | median_warm_ms | median_swap_cost_ms |
|---|---|---|---|
| gemma4 | 13344 | 181 | 13163 |
| gpt-oss-120b | 51001 | 257 | 50744 |
| mellum | 10503 | 157 | 10346 |
| qwen3-30b-instruct | 17305 | 100 | 17205 |
| qwen3-coder-next-80b | 42042 | 194 | 41848 |
| qwen35-a3b | 34090 | 172 | 33918 |
| tongyi-dr | 23852 | 191 | 23661 |

### Per-sample spread worth noting

- `gpt-oss-120b` cold: 42.9s → 59.1s across the two passes.
- `qwen35-a3b` cold: 25.4s → 42.8s — second pass slower; likely page-cache eviction by the
  intervening loads (pass 2 swaps in after a different, larger predecessor has churned the cache).
- `mellum` cold: 6.2s → 14.9s.

So the medians above are mid-points of a real spread, not tight constants: the same swap can cost
noticeably more when the page cache has been churned by other models in between.

## Interpretation (ties back to the keep-warm design note)

1. **The note's 8–40s estimate is confirmed and refined.** The cheapest swap is ~6–15s (mellum);
   the worst is ~43–59s (gpt-oss-120b). The two stale historical numbers (~8-10s, ~38s) both fall
   inside the measured range — they were samples of different models' swap costs, not disagreement.
2. **Every cross-model swap costs real wall-clock time on the caller** — individual samples
   ranged from 6.1s (mellum, best case) up to 58.9s (gpt-oss-120b, worst case); per-model
   *medians* cluster 10–51s. A warm call, by contrast, is consistently ~0.1–0.3s — a
   **66–234× cold/warm ratio observed across samples**. A single misrouted or interleaved call
   doesn't "slightly slow" a session; it stalls it for seconds to nearly a minute.
3. **This strengthens the note's conclusion.** Pinning (a never-expire TTL) can't help
   multi-model traffic on a single-resident-model proxy — the very next non-pinned request still
   pays the full swap both ways. A **session-side warm-up call** (the note's "warm the caller's
   session, not the server's default") amortizes the 6–15s mellum cold-start once per session and
   costs other traffic nothing.
4. **Routing-table implication: batch by model.** Consecutive same-model delegation batches are
   50–500× cheaper per call than interleaved-model batches. Any multi-task client (the Broker's
   `delegate()` loop, batch harnesses, cron jobs) that sorts its work queue by target model before
   dispatch gets this win nearly for free — batch-by-model ordering is trivially implementable and
   clearly worth it at these ratios.

## Related

- `docs/keep-warm-mellum-design-note-2026-07-01.md` — the design note whose recommendation #5
  ("measure first") this doc answers (issue #121).
- `scripts/measure-swap-latency.ts` — the measurement tool (pure helpers unit-tested in
  `tests/measure-swap-latency.test.ts`).
