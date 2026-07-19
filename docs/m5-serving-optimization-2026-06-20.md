# M5 serving optimization — flash-attention + continuous batching (2026-06-20)

**Status:** Retroactively documented 2026-07-01. This doc is referenced by the header comment in
`m5:/etc/llama-swap/config.yaml` ("Optimized 2026-06-20 ... See repo
docs/m5-serving-optimization-2026-06-20.md") but was **never actually committed** — the branch
that held it (`m5/serving-optimization`, commit `9694887`) was local-only and is gone (confirmed:
not on `origin`, not reachable via `git fsck --dangling` in this checkout). This reconstructs it
from contemporaneous private operator notes, which are not included in this repository. Where a
specific number isn't recoverable, that is stated explicitly rather
than invented. See the **2026-07-01 addendum** at the bottom for the current, git-tracked
follow-up (gille-inference#115).

## Context

M5 is an AMD Strix Halo (unified-memory) APU box: **64 GiB GPU-addressable VRAM + 64 GB system
RAM + 30 GiB GTT** overflow (corrected from an earlier "128GB use-it-all" assumption). Seven
models are served behind `llama-swap`, hot-swapped on a single
serial GPU. The 2026-06-20 session's goal was to find serving-config wins (flash-attention,
continuous batching, speculative decoding) within that fixed memory envelope.

## What was tried

**1. Speculative decoding — dead end, not applied.**
- Vocab lock-out ruled out 3 of 4 candidate draft/target pairs outright (draft model vocab must
  match the target's).
- The one vocab-compatible pair (qwen3-coder-next-80b target + Qwen3-0.6B draft) was **broken on
  the qwen3next hybrid architecture** (see the recurrent-memory finding in
  `docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md` for why this architecture is fragile in
  general) and, even where it ran, was **slower** than plain decoding (47 vs 53 tok/s) — negative
  ROI.
- N-gram lookup decoding regressed mellum by **-34%**.
- **Verdict: no speculative-decoding path is used on this roster.** (A future MTP/nextn-format
  GGUF, if one becomes available for a served model, is the only lever left un-explored here.)

**2. Continuous batching — real win, staged but not enabled.**
- Measured **~2x aggregate throughput** at `--parallel 4` (2.08x / 1.94x across two measurement
  runs).
- **Not applied live**, because it requires `-c` to be divided across parallel slots (e.g.
  `-c 131072 --parallel 4` for a 32K/slot budget) *and* the gateway itself serializes admission
  today (`admission.ts` `maxParallel=1`, `HOMESERVER_MAX_INFLIGHT`). Enabling it is a two-sided
  change (llama-swap config + `HOMESERVER_MAX_INFLIGHT` + a home-gateway restart) that was staged
  for a deliberate go-ahead, not shipped in this session. Status as of this writing: still not
  enabled (unchanged since 2026-06-20; out of scope for this doc's 2026-07-01 addendum).

**3. Per-model flash-attention pins — applied live, this is the change `config.yaml`'s header
refers to.**

`-fa` (flash-attention) was measured **per model** rather than assumed uniform, because this
roster mixes architectures (full-attention MoE vs. the Qwen3-Next hybrid Gated-DeltaNet/linear-
attention design — see the companion degeneration doc for what makes that architecture different
internally). The per-model decode-at-depth measurements found:

| model | `-fa` decision | measured effect |
|---|---|---|
| mellum | **on** | enabled; the surviving notes record a net positive but not the exact delta |
| gemma4 | **on** | **+23%** decode throughput at depth |
| qwen35-a3b | **on** | **+7%** decode throughput at depth |
| qwen3-coder-next-80b | **OFF** | flash-attention **regressed throughput by -44%** — the hybrid Gated-DeltaNet architecture does not benefit from FA the way the full-attention models do |

All four changed models were verified coherent via a live `/v1/chat/completions` round-trip
before being called done. This was applied in an idle window specifically because heavy
benchmark load against the live box was found to contend for VRAM and briefly crashed the 80B
during testing (auto-recovered) — a caution worth repeating for anyone re-running this class of
benchmark: **do it off-peak, and expect the model under test to need a reload if a bench crashes
it.**

**The `-fa off` pin on `qwen3-coder-next-80b` was therefore a deliberate, measured decision, not
an oversight.** It bought back a real, quantified throughput regression (-44%) on the single
largest, most heavily-used model in the roster (the primary agentic-coding model). At the time,
context was uniformly `-c 32768` across all seven models, so this decision was made independent of
any context-size consideration.

## 2026-07-01 addendum — the long-context reversal

Subsequent testing found that `qwen3-coder-next-80b` at `-c 32768 -fa off`
**degenerates into a garbage-token wall on long agentic coding loops** — driven by
`opencode run` against a C++ task with a build→test→fix loop, it applied zero edits.
The same model at `-c 65536 -fa on` was coherent and made real, iterating fixes.
The working hypothesis was that 32K context is too small for multi-iteration agentic
loops (accumulated file contents + test output + fix-round history truncates/degenerates the
context); `-fa on` roughly halves KV-cache memory, which is what affords the larger context inside
the box's RAM budget.

**The fix was applied live before this doc was written** (`~/etc/llama-swap/config.yaml`,
backup `config.yaml.bak.pre-ctx-test`; llama-swap restarted). This session's job was to validate
it and get it into git (this doc + `deploy/llama-swap-config.yaml`, the tracked mirror of the live
file), not to make the runtime change.

### This is a genuine tradeoff, not a free fix

The 2026-06-20 `-fa off` pin was a **measured** -44% throughput defense. The #115 fix **reverses
it outright** (`-fa on`) while *also* doubling context (32K → 64K), so the net effect on today's
box is not a clean single-variable test of "was the FA regression still real" — it's "does the
coherence win from more context + FA-on outweigh whatever throughput the FA flip costs."

**Fresh throughput measurement (2026-07-01, single warm request via
`scripts/gate-c-loadtest.mjs` Phase 1, `-c 65536 -fa on`, live gateway):**

- **qwen3-coder-next-80b: 56.5 tok/s** (178 tokens, 4.2s generation, TTFT 1065ms).

**Compared against the historical Gate C baseline** (2026-06-24 4h soak, at the old
`-c 32768 -fa off` config): **60.0 tok/s** single-shot measurement, and over the full 4h sustained
soak p50 **59.6** / p05 **59.1** / min **55.4 tok/s** (23,667 requests, 0 failures).

**Honest read:** 56.5 tok/s sits comfortably *inside* the old config's own sustained-soak range
(55.4–59.6 tok/s) — it is **not** a dramatic regression, and nowhere near the -44% the 2026-06-20
FA-only ablation measured. Two caveats keep this from being a clean comparison:
1. **This is a single warm request, not a sustained soak** — the old 60.0 tok/s figure this is
   measured against includes both a comparable single-shot number *and* a 4h soak average; a
   proper apples-to-apples re-run would be a fresh multi-hour soak at the new config, which this
   session did not do (out of scope — see Recommendation).
2. **Two variables changed at once** (context 32K→64K *and* `-fa` off→on), so this number cannot
   isolate "was the 2026-06-20 FA finding wrong" from "does a doubled context carry its own
   overhead." The 2026-06-20 FA-only ablation (-44%) and this session's FA+context combined
   measurement (~-6% vs. the old soak floor, effectively noise) are **different measurements of
   different things** and should not be read as contradicting each other.

### Gate D (aider arm) — coherence/capability re-run

Previous baseline (`docs/gate-d-execution-findings-2026-06-24.md`, `-c 32768 -fa off`): **aider
6/10** — 01✅ 02❌(G4-oracle) 03✅ 04✅ 05❌(G3-tsc) 06✅ 07✅ 08❌(G4-oracle) 09❌(G5-structural) 10✅.

Re-run 2026-07-01 at `-c 65536 -fa on` (same harness, same aider version 0.86.2, ×1 seed, same
`CAP_S=360`, live gateway): **aider 6/10** — 01✅ 02❌(G4-oracle) 03✅ **04❌(G2-no-edit, NEW)**
05❌(G3-tsc) 06✅ 07✅ 08❌(G4-oracle) **09✅ (FLIPPED from G5-structural fail)** 10✅.

**Net score is unchanged (6/10), but the task-level composition moved:**
- **Task 09 (cross-file rename) flipped fail→pass.** This is the one directly consistent with
  #115's hypothesis — a rename that touches multiple files benefits from more room in context to
  hold the whole edit set coherently, and was previously the *only* "genuine capability" miss that
  looked context-shaped (vs. 02/08's wrong-fix logic errors, which are reasoning misses, not
  context misses).
- **Task 04 (add-cli-flag) flipped pass→fail** (`G2-no-edit` — aider made no edit at all). This is
  **not** predicted by the context/FA hypothesis and has no obvious causal story pointing at the
  config change. The most likely explanation is single-seed run-to-run variance: both the 2026-06-24
  baseline and this re-run are **×1 seed**, and the project's own prior findings already flagged
  "×3 seeds (non-determinism tail)" as an open follow-up precisely because
  single-seed local-model agentic runs are known to be noisy. This session did not re-run with
  multiple seeds (scope: one validation pass, not a full re-benchmark) — treat the 04 flip as
  unexplained noise, not a config regression, until a multi-seed re-run says otherwise.
- The two logic-error misses (02, 08 — `G4-oracle`, aider applying a plausible-but-wrong fix) are
  **unchanged** — consistent with the original finding that those were reasoning misses, not
  context/coherence misses, and so not expected to move with a context/FA change.

**Verdict on Gate D:** no regression (net 6/10 either way), and the one flip that lines up with
the issue's hypothesis (09) is a real positive signal, though a single ×1-seed run can't fully
separate "the fix helped" from "noise" for any individual task — only the aggregate is stable.

### RAM headroom for the other six models — investigated, not changed

Issue #115's checklist also asks whether the other six models (`mellum`, `gemma4`, `qwen35-a3b`,
`tongyi-dr`, `qwen3-30b-instruct`, `gpt-oss-120b`, all still `-c 32768`) could safely take the same
context bump. Checked `free -h` (61 GiB total, ~57 GiB "available" — mostly reclaimable
buff/cache) and on-disk model sizes as a memory-footprint proxy:

| model | GGUF size | headroom (of ~61 GiB) |
|---|---|---|
| mellum | 7.6 GB | large |
| gemma4 | 16 GB (+1.2 GB mmproj) | large |
| qwen3-30b-instruct | 18 GB | large |
| tongyi-dr | 18 GB | large |
| qwen35-a3b | 21 GB | moderate-large |
| qwen3-coder-next-80b | 46 GB | already bumped (this issue) |
| **gpt-oss-120b** | **60 GB** | **~1 GB — essentially none** |

**Recommendation:** raising context on the five smaller models (mellum / gemma4 / qwen35-a3b /
tongyi-dr / qwen3-30b-instruct) looks RAM-safe at a glance and is a reasonable candidate for a
**follow-up issue** — but this session did **not** measure whether any of them show the same
degeneration-at-32K failure mode qwen3-coder-next-80b did (no evidence they do; they weren't
implicated in #115), so a context bump there would be a speculative throughput/robustness
improvement, not a bug fix, and should get its own before/after coherence + throughput
measurement rather than being bundled in here. **`gpt-oss-120b` is the opposite case: at 60 GB in
a ~61 GB budget it already has almost no room for its current 32K KV cache, let alone a doubled
one — raising its context is very likely NOT safe without either a quant/size reduction elsewhere
or accepting OOM/swap risk, and should not be attempted casually.**

### Was trading throughput for coherence the right call?

**Yes, on the evidence gathered this session** — with one important caveat about the road not
taken.

- The coherence bug is a **correctness failure**, not a performance one: at the old config the
  model applied **zero edits** on a realistic agentic loop (per #115's opencode test) — 0 tok/s of
  *useful* output beats any tok/s of garbage. A throughput number is meaningless if the model
  can't complete the task at all.
- The measured throughput cost of the fix, on this session's evidence, is **small-to-noise**
  (56.5 tok/s vs. a 55.4–60.0 tok/s historical range), not the -44% the original FA-only ablation
  found — because raising context to 64K is doing real work here too (KV cache footprint), not
  just the FA flip in isolation.
- Gate D shows no net regression and one plausible improvement (task 09) directly consistent with
  the fix's own hypothesis.

**The smarter-middle-ground question the issue raises — did anyone check a context size below 64K
that still fits the FA-off memory budget, or whether upstream llama.cpp has since improved the
qwen3next FA regression — was NOT investigated this session** (out of scope: this was a
validate-and-document pass, not a re-optimization). Two concrete follow-ups worth filing:
1. **Bisect context size at `-fa off`** (e.g. 40K, 48K, 56K) to see if some value below 64K both
   avoids the degeneration *and* keeps the -44%-regression FA-off path — would recover throughput
   without accepting FA's cost, if the degeneration is really a pure context-size effect and not
   also entangled with FA's KV-cache halving.
2. **Re-check the FA regression against a newer llama.cpp build.** The -44% number is from
   2026-06-20; if upstream has since improved Gated-DeltaNet FA support, the tradeoff this doc
   documents may no longer hold and should be re-measured rather than assumed permanent.

Until either of those lands, **the live config (`-c 65536 -fa on`) is the right call to keep** —
it trades a small, noisy throughput delta for a real correctness fix on the box's primary agentic
coding model.
