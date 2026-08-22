# Harness research spike — OSS coding harnesses for local models on the M5

**Date:** 2026-08-22
**Status:** COMPLETE — research done; E2/E3/E4 executed, E1 killed on capability grounds
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
   discriminate between serving configurations. The KV-quantization question is therefore
   **unresolved**, not answered. (`measured`)
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
therefore compare a q8_0-KV model against an f16-KV model. If KV quantization affects tool-calling —
as secondary sources claim llama.cpp's own documentation warns for agent workloads — that is a live
confound in already-published conclusions.

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
5. **Decide explicitly about the KV confound.** `ornith-1.5-35b` and `qwen38-27b` run `q8_0` KV
   while `qwen36-a3b` runs `f16`, and both recorded head-to-heads inherit that asymmetry. Resolving
   it needs the r2 holdouts (consume-once). That is an owner decision, deliberately not taken here.
6. **E1′ (successor to the killed E1):** test the *mechanism*, not the harness — capture real
   malformed tool-call payloads from a pi × `gpt-oss-120b` run and replay them through a
   `fix-json`-class repairer. Cheap, and it answers the original question without needing an
   agentic Octofriend.
7. **Do not adopt `solutionInTranscript` as a gate.** Keep it as an observation field with the
   documented false-positive behaviour.
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

## Provenance

- Corpus: `gate-d-r1` (pinned). **No r2 holdouts consumed.**
- Harness changes: `gate-d/run.sh` (stdin fix, `qwen-code` arm, peek hook),
  `gate-d/peek-scan.py` (new).
- E3 rows carry the peek fields only from the point the hook landed; earlier archived rows do not.
  Archived invalid rows are retained under `data/e3/ARCHIVE-*.jsonl` as defect evidence.
