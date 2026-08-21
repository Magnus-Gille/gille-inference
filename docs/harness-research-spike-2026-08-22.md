# Harness research spike — OSS coding harnesses for local models on the M5

**Date:** 2026-08-22
**Status:** IN PROGRESS — research complete, experiments partially executed
**Scope:** which OSS coding harness to run against M5-served local models, and what evidence
supports that choice.

## Summary

The project's incumbent harness (`pi`) is **independently corroborated as the best available
local-model coding harness**, so the spike's operational recommendation is *do not switch*. The
value delivered here is not a new harness — it is (a) external corroboration of an
existing single-site result, (b) two harness candidates evaluated and one killed on capability
grounds, and (c) a **latent harness bug that silently invalidates unattended Gate-D pi-arm runs**,
found while building the experiments rather than by running them.

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

### E2 — qwen-code as a second local driver → **ARM BUILT, RUN PENDING**

**Hypothesis.** qwen-code lands within noise of pi (harness-bench: 75.0 vs 76.9), giving a second
independent local driver and de-confounding "pi" from "local agentic capability".

qwen-code **0.21.15** provides everything the arm needs, including bounding controls pi lacks:
positional one-shot prompt, `--yolo`, `-m`, `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL`,
`--max-session-turns`, `--max-tool-calls`, `--max-wall-time`, `--output-format json`. It has no
`--dir`, so the arm `cd`s into the work dir exactly as the pi arm does.

Implemented as a `qwen-code` arm in `gate-d/run.sh`.

### E3 — KV-cache quantization vs tool-calling accuracy → **RUNNING**

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

### E4 — Grader-leak detection → **INSTRUMENTED; FRAMING CORRECTED**

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

1. **Keep pi as the primary local driver.** Corroborated by independent benchmark; no candidate
   evaluated here displaces it.
2. **Land the stdin fix regardless of the experiments' outcome.** It is the highest-value artifact
   of this spike.
3. **E1′ (successor to the killed E1):** test the *mechanism*, not the harness — capture real
   malformed tool-call payloads from a pi × `gpt-oss-120b` run and replay them through a
   `fix-json`-class repairer. Cheap, and it answers the original question without needing an
   agentic Octofriend.
4. **Do not adopt `solutionInTranscript` as a gate.** Keep it as an observation field with the
   documented false-positive behaviour.
5. Steal, don't adopt: [Reasonix](https://github.com/esengine/deepseek-reasonix) is built around
   prefix-cache stability (stable environment preamble, stale tool output pruned before compaction,
   versioned tool-schema contracts). On a serial leased GPU that is a serving-economics concern.
   Measuring prefix-cache hit rate across a Gate-D sweep would show whether headroom exists.

## 5. Results

*(pending — E3 f16/q8_0 arms and E2 qwen-code arm)*

## Provenance

- Corpus: `gate-d-r1` (pinned). **No r2 holdouts consumed.**
- Harness changes: `gate-d/run.sh` (stdin fix, `qwen-code` arm, peek hook),
  `gate-d/peek-scan.py` (new).
- E3 rows carry the peek fields only from the point the hook landed; earlier archived rows do not.
  Archived invalid rows are retained under `data/e3/ARCHIVE-*.jsonl` as defect evidence.
