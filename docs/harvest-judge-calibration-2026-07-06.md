# Harvest judge calibration — 2026-07-06

Reproducible calibration of the harvest judge (`scripts/harvest-verdicts.ts`) against a committed,
ground-truth-authored labeled control. Fixes the prior "8/8 on the labeled faithfulness control"
claim, which lived only in an ephemeral session scratchpad and could not be re-run from the repo.

- **Harness:** `scripts/judge-calibrate.ts` — exercises the EXACT harvest path (`buildJudgePrompt` +
  `buildJudgeBody` + `parseJudgeVerdict` from `src/homeserver/harvest.ts`), no retry (raw per-call
  outcome is the measurement).
- **Control:** `tests/fixtures/judge-control.jsonl` — 22 labeled `(taskType, prompt, answer, gold)`
  examples across 10 task types (10 pass / 10 fail / 2 partial), including the adversarial traps the
  structural verifiers miss: inverted-negation summary, hallucinated fact, wrong-aggregate SQL
  (`COUNT` for `SUM` — passes a `containsAll` keyword check), spurious code-review, wrong-number
  reasoning, wrong-field extraction, wrong-label classify, wrong-fact QA, meaning-inverting translate.
- **Where:** live M5 llama-swap (`http://127.0.0.1:8091/v1`), GPU-leased, in an isolated scratch tree
  (production `/srv/gille-inference` untouched).

## Reproduce

```bash
# on the box, GPU-leased:
npx tsx src/homeserver/cli.ts gpu run --model gpt-oss-120b --eta 15m --purpose judge-calibrate \
  -- npx tsx scripts/judge-calibrate.ts --judge-model gpt-oss-120b --response-format on --json
```

## Results

| Judge | response_format | error rate | coverage | exact acc (3-way) | **fail-safety** | pass-recall |
|---|---|---|---|---|---|---|
| **gpt-oss-120b** | **ON** | **0%** (0/22) | 22/22 | 0.86 (19/22) | **1.00** (10/10) | 0.90 (9/10) |
| gpt-oss-120b | OFF | **63.6%** (28/44 HTTP 500) | 9/22 | — | — | — |
| qwen3-coder-next-80b | ON | 0% (0/22) | 22/22 | 0.91 (20/22) | **1.00** (10/10) | 0.90 (9/10) |

Metrics:
- **fail-safety** — of the 10 known-BAD answers, the fraction the judge did NOT pass. This is the
  metric that matters: a false `pass` writes spurious capability evidence and can route a task to a
  model that can't do it. Both judges are **1.00** — neither passed a single bad answer, including
  every adversarial trap.
- **error rate** — fraction of calls that returned HTTP 5xx / empty / unparseable. `response_format`
  {json_object} takes gpt-oss from **64% → 0%** (grammar-constrained decoding structurally prevents
  the harmony non-streaming 500, #166 / ggml-org/llama.cpp#25321). Without it, gpt-oss is unusable as
  a judge (only 9/22 rows graded).
- **pass-recall** — of the 10 known-GOOD answers, the fraction judged `pass`. Both 0.90 (each was
  over-conservative on exactly one good answer → `partial`, which is safe, just lower coverage).
- **exact acc** — 3-way verdict match. gpt-oss's 3 non-exact calls are all safe partial-boundary
  disagreements (fail-safety 1.0 proves none was a false pass); qwen-coder matched one more.

## Decision: default harvest judge → `gpt-oss-120b`

Both judges are equally SAFE (fail-safety 1.0). gpt-oss is chosen as the default because, now that
`response_format` makes it reliable (0% error, validated above):

1. **Coverage.** gpt-oss serves ~no real traffic, so the no-self-grading skip costs almost nothing and
   it can grade EVERY served model — including `qwen3-coder-next-80b`'s own rows, which were the
   coverage blind spot under the qwen-coder default (a workhorse can't grade itself).
2. **Code-review quality.** Per #158's sweep, gpt-oss-120b is a far better code-review judge
   (~82% vs ~23% real-bug recall) — the judgment-quality task type where the judge matters most.
3. The only cost is one extra example on fuzzy 3-way accuracy (0.86 vs 0.91), which is a
   partial-boundary artifact, not a safety regression.

Reversible: `--judge-model qwen3-coder-next-80b`, or `HARVEST_JUDGE=…` in the nightly cron. Harvest
stays in **shadow** mode (zero routing impact) until `HARVEST_MODE=on` is set deliberately.

## Addendum 2026-07-09 — the control set under-measured the token budget

The "0% error" above holds for the CONTROL SET but did not transfer to real traffic: the 2026-07-08
and 2026-07-09 nightlies showed 5 + 4 `judge-err: empty judge completion` and 1 parse-fail each.
Root cause (reproduced live on the box, row `#6132`): the judge call sent `max_tokens: 600`, and
gpt-oss-120b is a harmony/**reasoning** model whose `reasoning_content` is generated inside that
budget *before* any `content`. Control prompts are ≤171 chars, so 600 sufficed during calibration;
real owner traffic runs 5–24 KB and the judge's reasoning alone measured 600–1155 tokens:

| call | max_tokens | finish_reason | completion_tokens | content |
|---|---|---|---|---|
| row #6132 (nightly judge-err) | 600 | `length` | 600 | `""` (all reasoning) |
| row #6132, same input | 2000 | `stop` | 709 | valid verdict JSON |
| row #6127 (nightly judge-err) | 1500 | `stop` | 1155 | valid verdict JSON |

The parse-fail is the same failure at the boundary (verdict JSON truncated by the cap). Same-budget
retries could never recover it — reasoning length at temperature 0 is near-deterministic.

**Fix (PR for #harvest-HOLD):** `HARVEST_JUDGE_MAX_TOKENS_DEFAULT = 4000` (env
`HARVEST_JUDGE_MAX_TOKENS`), plus starvation-aware retry: `classifyJudgeCompletion` detects
`finish_reason: "length"` with no usable verdict and retries with a **doubled** budget
(`escalateJudgeMaxTokens`, cap 16000). Note for future calibrations: add long-prompt rows to the
control set, or treat control-set reliability as a lower bound only.
