# Harness research spike — OSS coding harnesses for local models on the M5

**Date:** 2026-08-22
**Status:** COMPLETE — research done; E2/E3/E4 executed, E1 killed on capability grounds;
follow-up in §6 closes the KV question and replaces the retired leak signal
**Scope:** which OSS coding harness to run against M5-served local models, and what evidence
supports that choice.

## Summary

The most valuable artifact of this spike is **not** a harness recommendation — it is a latent
harness defect that silently invalidates unattended Gate-D pi-arm runs (§3), found while building
the experiments rather than by running them.

Ranked findings:

1. **`pi --print` hangs on inherited stdin** → any background/cron/CI Gate-D pi run yields
   uniformly `arm-error` rows that are indistinguishable from model failure. Fixed and verified
   red/green. (`measured`)
2. **qwen-code and pi are statistically indistinguishable** on r1/80b — 29/30 vs 27/30 over 60 runs,
   Fisher exact **p = 0.61**. pi's Gate-D standing is not unique to pi, and a second independent
   local driver now exists. (`measured`)
3. **Single-seed Gate-D comparisons are not trustworthy at small margins.** The n=1 pilot drew a bad
   sample and showed "qwen-code 10/10 vs pi 9/10" — a harness difference that replication showed
   does not exist. Two task cells (05, 09) are genuinely flaky; task 09 fails ~50% of attempts
   regardless of harness. Any future Gate-D head-to-head should carry seeds and a significance
   test. (`measured`)
4. **Gate-D r1 is saturated** for current models — `ornith-1.5-35b` scores 30/30 — so r1 cannot
   discriminate between serving configurations. A purpose-built probe (§6.1) then found **no
   degradation even at q4_0**, and the claim that motivated the whole question turned out to be
   **false**: llama.cpp publishes no such warning, and primary sources measure q8_0 as
   near-lossless. **Recommended action: none.** (`measured`)
5. **Octofriend cannot be benchmarked as shipped** — no headless agentic mode. (`measured`)
6. `pi` remains the recommended primary driver; nothing evaluated displaces it, and the
   external corroboration in §1.1 stands.

Two claims from the preceding day's research draft did **not** survive verification and are
corrected in place: the alleged Gate-D exposure to grader-peeking (§2/E4) and Octofriend's
"free" repair layer (§2/E1).

## 1. External evidence

### 1.1 harness-bench (primary relevance)

[harness-bench](https://neuralnoise.com/2026/harness-bench-wip/) pairs local LLMs served via
llama.cpp `llama-server` with five agent harnesses over 16 software-engineering tasks
(Python/PyTorch/JAX/C/C++/Rust/SQL); 17 model-quants × 5 harnesses × 16 tasks = 1360 runs.

| Harness | Pass rate (160 cells) | Avg time |
|---|---|---|
| **pi** | **76.9%** | **163 s** |
| Qwen Code | 75.0% | 191 s |
| Claude Code | 66.2% | 306 s |
| OpenCode | 63.8% | 271 s |
| Aider | 62.5% | 384 s |

Best cell: Qwen3.6-27B UD-Q4_K_XL + pi = 16/16. Also reported: Q4_K_M ≈ Q8 on accuracy
(aggregate −1%, within noise) at 1.5–2× throughput, supporting this repo's existing Q4_K_M default.

**Transfer caveat (important).** harness-bench ran on an **M3 Max (Metal)**. The M5 is a
**BosGame M5 / Strix Halo, Vulkan, ~215–256 GB/s** (`docs/bosgame-m5-architecture.md`). Harness
*ranking* is expected to transfer; **absolute latency figures are not** and must not be quoted as
M5 expectations. An earlier draft of this spike described the two machines as "essentially
identical" — that was wrong and is corrected here.

Corroboration value: harness-bench independently reproduces this repo's own ordering
(`docs/gate-d-execution-findings-2026-06-24.md`: pi 10/10, aider 6/10) on the same model families
and serving stack. That upgrades the pi-leads finding from single-site to **corroborated**.

Source limitation: harness-bench is explicitly WIP and its task set is **private** (good for
contamination resistance, bad for auditability).

### 1.2 Academic Harness-Bench (secondary)

[arXiv 2605.27922](https://arxiv.org/abs/2605.27922) — 106 sandboxed tasks, 7 harnesses, 8 API
backends, 5,194 trajectories. Relevant findings: a 23.8-point spread between best and worst
configurable harness under an identical task set and backend pool; **stronger backends show lower
cross-harness variance**, i.e. harness choice matters *more* the weaker the model; and
"tool errors or blocked commands not followed by effective recovery" account for 24.6% of failures.

This supports treating harness as a first-class variable for the S2 (fully-local) question, but its
backends are all hosted APIs — it says nothing directly about M5-served models.

### 1.3 Not recommended / not applicable

- **Codex CLI** remains blocked against this gateway: `wire_api="chat"` became a hard error in
  Feb 2026 ([openai/codex#7782](https://github.com/openai/codex/discussions/7782)); Responses API
  only. Unchanged from `docs/gate-de-evaluation-plan.md`.
- **Claude Code over local models** is now *mechanically* possible — llama.cpp has served a native
  Anthropic Messages API at `POST /v1/messages` since 2026-01-19
  ([announcement](https://huggingface.co/blog/ggml-org/anthropic-messages-api-in-llamacpp)),
  requiring `--jinja` (already set on every roster entry). This would need a gateway shim. Value is
  **comparability** (same harness, swap only L3) and product surface, **not** throughput —
  harness-bench puts Claude Code at 66.2% and ~2× pi's latency. Not attempted in this spike.
- Curated "awesome-list" star counts encountered during research (e.g. Pi at 92k, various 30–70k
  entries) did not survive spot-checking and are **not** used as evidence here.

## 2. Experiments

Designs were fixed before execution. Evidence labels follow `AGENTS.md`
(`deployed/enforced`, `deployed/shadow`, `measured`, `aspirational`).

### E1 — Octofriend repair-layer arm → **KILLED (blocked, not falsified)**

**Hypothesis.** Octofriend's `diff-apply` / `fix-json` helper models convert tool-call
serialization failures into completions, potentially rescuing `gpt-oss-120b` — the roster's fastest
strong model — as a coding driver.

**Kill criterion (preregistered).** No headless mode within a 45-minute timebox.

**Result.** Octofriend **0.0.59 has no headless agentic mode.** `octofriend prompt <p>` is the only
non-interactive command and it constructs a model + `LocalTransport` and calls the shared `run()`
compiler **without a `tools` argument** — a plain chat completion with no file or shell access.
Agentic behaviour exists only behind the interactive Ink TUI. Verified directly in
`/opt/homebrew/lib/node_modules/octofriend/source/cli/cli.tsx`, not from documentation.

Two further findings weaken the original pitch:
- `diffApply` / `fixJson` are **optional and off by default** (`t.optional(...)` in `ConfigSchema`;
  `autofix()` returns `null` when unconfigured). They are auto-populated only by the interactive
  first-run wizard. The claim that Octofriend gives a repair layer "for free" was wrong.
- The upstream adapters `syntheticlab/diff-apply` and `syntheticlab/fix-json` are **LoRA adapters
  on Llama-3.1-8B, last updated July 2025, ~15 downloads**. Self-hosting is a base-model +
  merge/convert + quantize pipeline, not a download.

**Status:** the repair-layer hypothesis is **untested**, not disproven. A cheaper successor design
(E1′) is recorded in §4.

### E2 — qwen-code as a second local driver → **RUN (3 seeds); see §5**

**Hypothesis.** qwen-code lands within noise of pi (harness-bench: 75.0 vs 76.9), giving a second
independent local driver and de-confounding "pi" from "local agentic capability".

qwen-code **0.21.15** provides everything the arm needs, including bounding controls pi lacks:
positional one-shot prompt, `--yolo`, `-m`, `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`,
`--max-session-turns`, `--max-tool-calls`, `--max-wall-time`, `--output-format json`. It has no
`--dir`, so the arm `cd`s into the work dir exactly as the pi arm does.

Implemented as a `qwen-code` arm in `gate-d/run.sh`.

### E3 — KV-cache quantization vs tool-calling accuracy → **RUN; null with no power, see §5**

**Why this exists.** Recon of the live llama-swap config found that `ornith-1.5-35b` **and**
`qwen38-27b` are served with `-ctk q8_0 -ctv q8_0`, while `qwen36-a3b` runs default **f16**. Both of
this repo's recorded head-to-heads (the #141 r2 tie-break, and the qwen38-vs-qwen36 Gate-D study)
therefore compare a q8_0-KV model against an f16-KV model — an asymmetry worth understanding.

**Correction (2026-08-24).** This experiment was originally motivated by a claim, taken from a
secondary source, that llama.cpp's own documentation warns against KV quantization for agent
workloads. **That claim is false.** Verified directly against `tools/server/README.md` on master:
the docs describe `-ctk`/`-ctv` and their allowed values and contain no such warning. (Upstream
issue #10373 is an open complaint that the flag values are not documented at all.) Primary evidence
points the other way — see §5.

**Method.** A standalone `llama-server` on a spare loopback port, launched under the repository's
sanctioned cooperative GPU lease (`homeserver gpu run`). The launch line is **byte-identical to the
production `ornith-1.5-35b` stanza** — including `-mm`, `--image-min-tokens`, `--spec-type
draft-mtp`, `--reasoning-format auto --reasoning auto` — with **only `-ctk`/`-ctv` varying**. Gate-D
r1 (10 tasks), pi arm, seed depth built up 1→3. **No production llama-swap change, no gateway
restart, no deploy.**

**Deviations from the ideal, disclosed:**
- Wall-clock cap lowered 600 s → 300 s after observing that prior successful Gate-D runs complete in
  5–93 s. Both KV arms use the identical cap, so the A/B remains internally controlled.
- The cooperative lease does **not** fence gateway traffic (`gpu-lease.ts` docstring; the fully
  fencing path is the exclusive maintenance window, which requires an operator credential and would
  refuse guest traffic for hours). Live traffic kept `qwen3-30b-instruct` resident throughout. A
  contention sampler logs this so affected rows can be flagged. Measured generation throughput
  stayed healthy at **53–62 tok/s**, so contention is not believed to distort pass/fail; **wall
  times are nonetheless treated as secondary evidence.**

### E4 — Grader-leak detection → **INSTRUMENTED; FRAMING CORRECTED; one field retired**

**Origin.** harness-bench reports OpenCode reading or executing hidden test scripts in 14 task
instances, 13 of which passed (~14% of its passes), with no such behaviour from the other four
harnesses across 640 cells.

**Correction to this spike's earlier framing.** An earlier draft claimed Gate-D tasks 01–04, 06–10
and 12 were exposed because G1 detects only oracle *edits*, not *reads*. **That was wrong.** On
those tasks the oracle is visible **by design** — the harness is meant to read and satisfy it, so
reading is the intended workflow, not cheating. And Gate-D's hidden oracles live in
`gate-d/tasks/<id>/oracle/`, physically **absent** from the work dir and staged only at grade time.
Gate-D was already structurally defended against the exact failure harness-bench found. There is no
"direct hit" on Gate D.

**What was built instead.** `gate-d/peek-scan.py`, invoked from `run.sh` as pure observation
(fails open; never affects pass/fail or any gate; never touches `gate-d/tasks/`). It reads
distinctive lines from the **pristine** task directory and reports four booleans per row:

| Field | Meaning | Interpretation |
|---|---|---|
| `oracleContentInTranscript` | visible oracle content appeared | **normal** on visible-oracle tasks; kept for cross-arm comparability |
| `oracleCmdInTranscript` | `meta.oracleCmd` appeared | **normal** — harness is expected to run the grader while iterating |
| `hiddenOracleInTranscript` | hidden-oracle content appeared | **sound leak signal** — should be impossible |
| `solutionInTranscript` | reference-solution content appeared | **noisy** — see calibration below |

**Calibration (measured).** On task 01, a *passing, legitimate* run reported
`solutionInTranscript: true`. This is a false positive: for a task that simple, a correct
implementation is textually the reference solution. `solutionInTranscript` is therefore **not a
reliable leak signal on easy tasks**; `hiddenOracleInTranscript` is the sound one. Reported here
rather than presented as a detected leak.

## 3. Harness defect found while building the experiments

**`pi --print` blocks on inherited stdin, silently voiding unattended runs.**

Reproduced deterministically on pi 0.84.2:

| stdin | stdout |
|---|---|
| inherited (background/pipe) | **0 bytes**, no stderr — hangs until the wall-clock cap |
| `< /dev/null` | 844 bytes of NDJSON — normal |

In Gate-D this produced rows with `exitClass: arm-error`, `wallS` = full cap, and
`turns/toolCalls/promptTokens/unparseableLines` **all zero** — i.e. the harness never issued a
single model request, while the row is indistinguishable from a model capability failure unless
telemetry is inspected.

**Impact.** Any Gate-D pi-arm result collected non-interactively — a background sweep, cron, or CI —
could be uniformly `arm-error` for reasons unrelated to the model. Existing r1 evidence
(pi 10/10) was collected interactively and is not affected, but the landmine is real for any
automated re-run.

**Fix.** `</dev/null` added to all four arms in `gate-d/run.sh`. Verified red/green: the same task,
same model, same background invocation went from `arm-error` / 0 turns / 300 s to **pass / 6 turns /
5 tool calls / 45 s**.

## 4. Recommendations

1. **Land the stdin fix.** Highest-value artifact of this spike; independent of every experimental
   outcome. Consider auditing any Gate-D evidence collected non-interactively since the pi arm was
   added, for rows with `arm-error` + zero telemetry.
2. **Keep pi as the primary local driver, but keep the qwen-code arm.** The two are
   indistinguishable (p = 0.61), so there is no performance reason to switch — but a second
   independent driver removes a standing confound from every "local agentic capability" claim in
   this repo.
3. **Require seeds + a significance test for any Gate-D head-to-head.** The n=1 pilot produced a
   harness difference that replication erased. Consider marking tasks 05 and 09 as known-flaky in
   `CORPUS.md`.
4. **Retire Gate-D r1 as a serving-configuration instrument.** It is saturated (30/30). Any study
   comparing quantization, KV settings, or runtime flags needs the harder holdout set or new tasks —
   otherwise it will keep producing powerless nulls.
5. **KV confound — closed, no action.** Resolved in §6.1 without consuming any r2 holdout. The
   motivating claim was false; primary evidence measures q8_0 as near-lossless; and a direct probe
   found no degradation on this box even at q4_0 across 54.5k-token contexts. The roster's
   `q8_0`/`f16` asymmetry is a tidiness issue, not a correctness one.
6. **E1′ (successor to the killed E1):** test the *mechanism*, not the harness — capture real
   malformed tool-call payloads from a pi × `gpt-oss-120b` run and replay them through a
   `fix-json`-class repairer. Cheap, and it answers the original question without needing an
   agentic Octofriend.
7. **`solutionInTranscript` is removed, not merely caveated.** It fired on 30/30 known-good runs.
   Replaced by three access-based signals validated against positive *and* negative controls
   (§6.2). None of them should ever be promoted to a gate without a confirmed real-leak observation.
8. Steal, don't adopt: [Reasonix](https://github.com/esengine/deepseek-reasonix) is built around
   prefix-cache stability (stable environment preamble, stale tool output pruned before compaction,
   versioned tool-schema contracts). On a serial leased GPU that is a serving-economics concern.
   Measuring prefix-cache hit rate across a Gate-D sweep would show whether headroom exists.

## 5. Results

### E3 — KV quantization: **measured null, with no power** (`measured`)

Gate-D r1, 10 tasks × 3 seeds per arm, pi arm, `ornith-1.5-35b`, standalone `llama-server` under
the cooperative GPU lease. Only `-ctk`/`-ctv` differ between arms.

| Arm | pass | median wall | median toolCalls | median completion tokens |
|---|---|---|---|---|
| `-ctk f16 -ctv f16` | **30/30** | 22 s | 7.0 | 853 |
| `-ctk q8_0 -ctv q8_0` | **30/30** | 20 s | 6.0 | 808 |

Every one of the 10 tasks passed 3/3 in **both** arms.

**Interpretation — read this before citing the null.** Both arms saturate at 100%, so this design
has **essentially zero power to detect degradation**. The correct statement is *"no effect is
detectable at r1 difficulty,"* **not** *"KV quantization is harmless."* The hypothesis is neither
confirmed nor refuted.

The ceiling is itself informative: `ornith-1.5-35b` scores **30/30 on r1** against its recorded
**8/12 on the r2 holdouts**, confirming r1 is far easier than the holdout set and is the wrong
instrument for this question.

**Consequently the confound identified in §2/E3 remains OPEN.** Both the #141 r2 tie-break and the
qwen38-vs-qwen36 study still compare a q8_0-KV model against an f16-KV model, and nothing here
resolves that. Resolving it requires the **r2 holdouts**, which are consume-once; that consumption
was explicitly out of scope for this spike and needs a deliberate decision (see §4).

Descriptively, q8_0 was marginally *faster* with marginally fewer tool calls and tokens — directionally
opposite to the "KV quantization degrades tool calling" claim, but well within noise at this sample
size and outcome-invariant, so **no directional claim is made**.

**Contention note.** Live gateway traffic kept `qwen3-30b-instruct` resident throughout both arms
(cooperative lease does not fence the gateway). Measured generation throughput held at 53–62 tok/s.
Pass/fail is outcome-saturated and therefore robust; wall times are reported as descriptive only.

### E4 — leak detection: **detector calibrated, one field retired** (`measured`)

Across all 60 E3 rows:

| Field | f16 | q8_0 | Verdict |
|---|---|---|---|
| `hiddenOracleInTranscript` | 0/30 | 0/30 | **Sound.** No hidden-oracle content ever reached a transcript — staging holds. |
| `solutionInTranscript` | 30/30 | 30/30 | **Retired.** Fires on every legitimate passing run; non-discriminative. |

`solutionInTranscript` firing 30/30 on known-good runs is a decisive negative result for that
signal: on Gate-D-scale tasks a correct implementation is textually the reference solution, so the
field carries no information. It is kept as a recorded observation with this caveat, and must not be
used as a gate or cited as evidence of peeking.

The OpenCode-peeking replication that motivated E4 was **not run** — the reframing in §2/E4 removed
its premise, since Gate-D's hidden oracles are absent from the work dir by construction.

### E2 — qwen-code vs pi: **statistically indistinguishable** (`measured`)

Gate-D r1, 10 tasks × **3 seeds** per arm (60 runs), `qwen3-coder-next-80b` via the authenticated
gateway (ordinary owner traffic; the GPU lease governs jobs that bypass the gateway, so none was
taken). `CAP_S=900`.

| Arm | pass | median wall | mean wall | runs at cap |
|---|---|---|---|---|
| qwen-code | **29/30** | 271 s | 347 s | 1 |
| pi | **27/30** | 361 s | 399 s | 1 |

**Fisher exact, two-sided: p = 0.61.** The two harnesses are **statistically indistinguishable** on
this battery. The n=1 pilot's apparent qwen-code lead did not survive replication.

Per-task, 8 of 10 tasks are 3/3 for **both** arms. Every failure is `G5-structural`:

| Task | qwen-code | pi |
|---|---|---|
| 05-tdd-write-test-then-impl | 3/3 | 2/3 |
| 09-rename-across-files | 2/3 | 1/3 |
| *(other 8 tasks)* | 3/3 | 3/3 |

**The binding constraint is the model, not the harness.** Task 09 (difficulty H — rename a symbol
across 4 files) failed **3 of 6 attempts across both arms**, a ~50% flake rate independent of
harness. No failure was a timeout: the four failures completed in 192 s, 273 s, 540 s and 667 s with
900 s available, and all four tripped the structural gate.

This also vindicates running to 3 seeds. The **n=1 pilot drew a bad sample for pi** and would have
been reported as "qwen-code 10/10 vs pi 9/10" — a harness difference that does not exist. Both cells
are flaky, and single-seed Gate-D comparisons on this battery are not trustworthy at this margin.

Directionally qwen-code was faster (median 271 s vs 361 s), but with outcomes this close and n=30
per arm, no throughput claim is made.

**Wall-time caveat — the 80b is far slower than the June baseline.**
`docs/gate-d-execution-findings-2026-06-24.md` records r1 runs of 5–93 s on this model; both arms
here ran 190–900 s, and pi's per-task time varied widely across repeats of the same task. Whatever
the cause — gateway path, concurrent live traffic, runtime or model changes since June — **wall
times here are not comparable to the June figures** and no throughput conclusion is drawn from them.

`hiddenOracleInTranscript` = 0 across all 60 rows.

An earlier `CAP_S=420` single-seed pilot is archived at `data/e2/ARCHIVE-pilot-cap420.jsonl`, with
the targeted cap-900 re-runs that diagnosed its cap confound at
`data/e2/ARCHIVE-pi-cap900-targeted.jsonl`. Neither feeds the result above: the final dataset was
collected fresh at a uniform cap, and the targeted re-runs were deliberately excluded because their
tasks had been selected on a performance-correlated criterion (pi having been slow on them).

## 6. Follow-up (2026-08-24): resolving the two open items

### 6.1 KV quantization — primary evidence, plus a direct probe

**The motivating claim was false.** llama.cpp's documentation contains no warning against KV
quantization for agent workloads (verified against `tools/server/README.md` on master). What primary
sources actually show:

| Source | Finding |
|---|---|
| llama.cpp PR #7412 (original KV-quant PR) | ΔPPL **0.0046 for q8_0** vs f16; 0.022 for q4_0 |
| llama.cpp discussion #23470 | q8_0/q8_0 KLD **0.0018** (98.0% token match); q4_0/q4_0 KLD **5.51** (11.6%) |
| #23470, community test | q4_0/q4_0 under grammar-constrained decoding: **375/500** ARC answers lost on Qwen2.5-7B; isolating the variable showed **K-side quantization alone reproduces the collapse** |
| discussion #20969 | a reported long-context degradation traced to a **dequant performance bug**, not accuracy; "flat 98.7–99.5% through 32K" once fixed |

So the risk is specific to **q4_0**, and specifically the **K** side. q8_0 is measured as
near-lossless. Context-length accumulation for q8_0 is **not** an established llama.cpp finding.

**Direct probe on this box.** Because Gate-D r1 saturates, `scripts/kv-toolcall-probe.py` measures
the alleged mechanism directly: a high-entropy needle is planted in filler text and must be returned
*through a tool call*. Paired design (identical prompts per arm), greedy decoding, `ornith-1.5-35b`,
64 trials per arm across ~5.8k / 22k / **54.5k**-token contexts.

| Arm | tool call emitted | args valid JSON | **needle correct** |
|---|---|---|---|
| `-ctk f16 -ctv f16` | 63/63 | 63/63 | **63/63** |
| `-ctk q8_0 -ctv q8_0` | 64/64 | 64/64 | **64/64** |
| `-ctk q4_0 -ctv q4_0` (positive control) | 64/64 | 64/64 | **64/64** |

(One f16 trial is excluded: a `RemoteDisconnected` transport error at 7 s on a prompt requiring
~110 s — infrastructure noise, not a model failure. 64 paired cells, 1 discordant, that one.)

**Honest interpretation — the positive control did NOT validate the instrument.** q4_0 was included
precisely so that a null for q8_0 would be interpretable, on the reasoning that a probe which cannot
detect the known-bad configuration cannot certify the good one. **q4_0 scored a perfect 64/64**, so
that validation failed. Two readings remain open:

1. this model/task combination is genuinely insensitive to KV quantization — plausible, since the
   published collapse was measured on a *dense* Qwen2.5-7B under grammar-constrained decoding,
   whereas `ornith-1.5-35b` is a hybrid-attention MoE (full attention only every 4th layer, so far
   less of the computation depends on the quantized cache); or
2. needle-retrieval-via-tool-call is too easy a task to expose KV noise.

A further caveat: the server logs for this build do not print an explicit KV-cache allocation, so
the flags could not be confirmed to take effect at tensor level. Prompt-cache entries do differ
systematically by arm (f16 growing to ~1706 MiB against q8_0's ~410 MiB), which is consistent with
the setting being honoured, but that is indirect.

**Conclusion.** Not "q8_0 is proven safe here." The defensible statement is: **no degradation was
detectable on this box even at q4_0**, and strong primary evidence independently shows q8_0 is
near-lossless. **Recommended action: none.** Do not change the serving configuration of
`ornith-1.5-35b` or `qwen38-27b` on the strength of the original concern, which rested on a false
premise. The `q8_0`-vs-`f16` asymmetry across the roster remains a tidiness issue, not a correctness
one, and no longer justifies consuming the r2 holdouts.

Incidental: q4_0 ran ~2× slower than f16 at 8k context (16.6 s vs 8.3 s), consistent with the
documented dequant/flash-attention performance traps (llama.cpp #24485) rather than any quality effect.

**Metric definition tightened after review, results unchanged.** Cross-model review found that
`argsValidJson` accepted any decoded object without checking the emitted function name or the
declared schema, so a call to the wrong tool with `{}` would have scored as valid. The evaluator now
validates tool name and argument types (`argsSchemaValid`, `toolNameCorrect`). Every previously
counted trial was **re-evaluated against the stricter definition and all still qualify** (f16 63/63,
q8_0 64/64, q4_0 64/64; zero regressions), so the table above is unaffected. `evaluate()` was also
made total — it previously caught only `KeyError`/`IndexError`, so a malformed response shape would
have aborted an entire probe run rather than recording one failed trial.

### 6.2 Grader-leak detection — retired signal replaced and validated

`solutionInTranscript` fired on 30/30 legitimate passing runs. The cause is structural rather than a
threshold problem: `solution/` and `oracle/` live outside the work dir, so the detectable event is
**access**, not similarity — and at Gate-D task scale a *correct* implementation is textually the
reference solution. Filesystem `atime` was tested as an alternative access signal and rejected: APFS
here does not update it on read.

Replaced with three signals that honest work cannot produce, using canaries already present in the
fixtures (**no fixture, corpus, or task-revision change**):

| Signal | Basis | Coverage |
|---|---|---|
| `graderPathInTranscript` | a **task-scoped** path into `oracle/` or `solution/` was referenced | all tasks |
| `hiddenOracleMarkerInTranscript` | arbitrary author-chosen literals (`"above hi"`, `"  Multiple---separators__here  "`), two-hit + high-specificity threshold | 4 hidden-oracle tasks |
| `solutionMarkerInTranscript` | the **full** reference-solution banner line | 10 of 23 solution files |

Discriminating power is pinned by `tests/gate-d-peek-scan.test.ts` — positive controls (a planted
leak must fire) and negative controls (honest work must not). **The negative controls caught two real
false positives during development**, both of which would have shipped otherwise:

1. the hidden oracle's own `"node:assert/strict"` import matched every honest test file;
2. task 13's canaries include `"Hello World"` / `"hello-world"` — exactly the data an honest slugify
   test emits.

Hence the import-line exclusion and the **two-distinct-hits + at-least-one-high-specificity**
threshold. This is an accusation-grade signal, so it is deliberately biased toward false negatives:
missing a leak is cheaper than falsely alleging one.

No verified confirmation of the `graderPath` signal against a *real* leaking harness exists — no
harness in this repo's arms has ever been observed reading the protected trees. It is validated
against planted leaks only.

**Cross-model review hardened this further.** An independent Codex review (`gpt-5.6-sol`, high
effort) of PR #223 found two additional false-positive paths that the original negative controls did
not exercise, both now fixed and pinned by tests: the signal matched the **unscoped** substrings
`/solution/` and `/oracle/` (firing on unrelated paths such as `/tmp/solution/cache/result.json`),
and it matched the **bare phrase** "REFERENCE SOLUTION", which can occur in ordinary model prose.
Matching is now task-scoped and uses the full banner line respectively.

## Provenance

- Corpus: `gate-d-r1` (pinned). **No r2 holdouts consumed.**
- Harness changes: `gate-d/run.sh` (stdin fix, `qwen-code` arm, peek hook),
  `gate-d/peek-scan.py` (new).
- E3 rows carry the peek fields only from the point the hook landed; earlier archived rows do not.
  Archived invalid rows are retained under `data/e3/ARCHIVE-*.jsonl` as defect evidence.
