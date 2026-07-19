# Gate D & E — Local Agentic Coding + Local Orchestrator Evaluation Plan

**Status:** PLAN (authored 2026-06-24, not yet executed). Execution is gated on the box being free — the Gate C 4h soak is running now. Free arms (A1–A5, A7/A8 / A1–A3) run on the M5 at $0; the Claude-baseline arms and the blind judge are the only OpenRouter/Claude spend — run them **once** and reuse (per CLAUDE.md credit discipline).

## Where this fits

Gates **A + B + C are green** (usage coverage, router trustworthiness, serving holds) → **S1-Hybrid** (frontier brain + local hands) is supported by measured data end to end. Gates **D** (T6/T7) and **E** (T5) gate the *next* step only — **S2 (fully local**, frontier as backup): can an OSS harness drive a *local* model through real agentic coding loops (D), and can a *local* model hold the **orchestrator/brain** role (E)? Failing D or E does **not** block S1 — it just keeps the brain on frontier.

- **Gate D (T6/T7):** OSS coding harness × local model on a deterministic agentic-task battery. Does a local-model-driven loop complete multi-step coding work, and can it delegate/escalate through Hugin?
- **Gate E (T5):** the orchestrator bake-off — local brain (deterministic harness vs agentic vs the Advisor pattern) vs the frontier-brain reference. Directly challenges the standing "local can't orchestrate" finding (#40 Tongyi; the 80b's 2.92-on-raw-pages collapse).

## Harness landscape (research)

The eval drives an OSS harness pointed at the **box's OpenAI-compatible gateway** (`https://inference.example.com/v1`, models `qwen3-coder-next-80b` / `gpt-oss-120b` / `mellum`). Four harnesses researched (below). **Headline:** **pi** (`@mariozechner/pi-coding-agent`, pi.dev — the project's *prior-best* local driver: qwen3-coder **5-6/6**), **aider** (SEARCH/REPLACE sidesteps tool-call parsing), and **opencode** (native tool-calling) all drive the box over `/v1/chat/completions` — but **Codex CLI is BLOCKED**: it now uses the OpenAI **Responses API** (`/v1/responses`) exclusively, which the gateway doesn't serve. So **run arms A1–A5 + A7/A8 (pi + aider + opencode); treat A6 (Codex) as out of scope** unless a `/v1/responses` adapter is built (own task). pi is arguably the **co-primary** arm alongside aider (it had the best prior local score); the run-matrix table below lists A6 for completeness — it is gated on the responses-adapter.

### aider — **installed** (`/path/to/aider`, v0.86.2)

**Point at the box:** Three confirmed ways (aider 0.86.2 + 2026 docs). ENV: export OPENAI_API_BASE=https://inference.example.com/v1 (keep the /v1); export OPENAI_API_KEY=<real-gateway-key, NOT a dummy>; then aider --model openai/qwen3-coder-next-80b. The openai/ prefix is MANDATORY -- it routes via litellm's generic 'openai' provider to OPENAI_API_BASE. Other ids: openai/gpt-oss-120b, openai/mellum. FLAGS (no env): aider --openai-api-base https://inference.example.com/v1 --openai-api-key <key> --model openai/qwen3-coder-next-80b (equivalently env AIDER_OPENAI_API_BASE, or --api-key openai=<key>). CONFIG FILE .aider.conf.yml (repo root or ~) or auto-loaded .env: openai-api-base:, openai-api-key:, model: openai/qwen3-coder-next-80b. CRITICAL extras for this box (prior repo findings): the id after openai/ must match the gateway /v1/models label EXACTLY (mellum / qwen3-coder-next-80b / gpt-oss-120b); unknown models warn re missing metadata, so pass a litellm-shaped --model-metadata-file JSON (max_input_tokens etc.) so aider doesn't mis-truncate context; per-model knobs (edit_format, timeout, extra_params/extra_body) go in a --model-settings-file YAML -- repo finding sets timeout:1800 (litellm default 600s trips on slow local MoE inference). To bypass tool-call parsing entirely, force --edit-format diff (SEARCH/REPLACE) or --edit-format whole.

**Edit protocol:** Aider does NOT use native function-calling/tool_use. It uses its own text edit conventions the model must emit verbatim, then aider applies them deterministically -- this is its key advantage for weak local models, sidestepping the brittle tool_calls/JSON-args path that breaks gpt-oss harmony channels and qwen3 thinking leakage under tool-loop harnesses. Formats: 'diff' (default for capable models) = fenced SEARCH/REPLACE blocks (filename then <<<<<<< SEARCH / exact old lines / ======= / new lines / >>>>>>> REPLACE); 'whole' = model returns the ENTIRE file in a fenced block (most forgiving, no context-matching, best for weak/quantized models per aider's own edit-errors doc); 'udiff' = unified-diff variant. File ops + command execution: aider itself reads files into context (--file writable, --read ref-only) and runs tests/lint via --auto-test/--test-cmd and --auto-lint/--lint-cmd, feeding failures back -- the MODEL does not call a shell tool, aider drives the loop. Survival on non-frontier local models: SEARCH/REPLACE survives FAR better than tool_use (no JSON schema to malform), but small models still fail SEARCH-block exact-match (whitespace/elided lines) -> aider's 'Failed to apply edit, retrying' loop. Escape hatches: --edit-format whole and --architect (a strong model plans, a cheap 'editor' model emits the edits via --editor-edit-format).

**Agentic loop:** Real multi-step loop, but a different shape from opencode/pi. Default loop: model emits SEARCH/REPLACE -> aider applies -> if --auto-test, runs test-cmd -> on failure feeds stderr back -> model revises -> repeat until tests pass or model stops. Bounded by: test/lint exit status (the natural stop), litellm per-request timeout (default 600s; bump to 1800), context-window truncation, and aider's apply-retry cap on malformed edits. KEY LIMITATION found in this repo (findings 5,6): in headless --message mode the loop only ITERATES AFTER a first successful edit -- if the model's opening turn is 'let me explore' with no SEARCH/REPLACE block, aider exits COLD with zero edits. aider has no autonomous file-discovery tool loop; the operator must pre-load scope with --file/--read. Repo result: aider+qwen3-coder-next jumped 2/6 -> 4/6 purely by adding per-task --file scoping. So any orchestrator (Hugin) using aider MUST pre-resolve file scope; 'send prompt and hope' yields ~25% useful-edit rate vs ~67% scoped.

**Local-model reliability:** Aider's own docs: 'Local models which have been quantized are more likely to have editing problems' because they can't follow the system prompts; the dominant failure mode is the model disobeying the edit-format instructions (emitting edits aider can't parse) -> repeated apply-retry. Community 2026 consensus: usable agent backend only at ~Qwen3.6-27B class and up on Q4/Q5; below that, edit-format adherence collapses, with --edit-format whole and architect mode as the recommended mitigations. THIS repo's empirical 6-task TS matrix (identical prompts) maps onto the box's 3 models: (a) qwen3-coder-next (box's qwen3-coder-next-80b) is the only validated strong driver -- 5-6/6 under pi, aider 4/6 once file-scoped; the agentic story rests on it. (b) gpt-oss-120b scored only ~1.5/6 even cloud-served at full precision; failure modes: CONFABULATION (claims done, 0 edits), UNDER-EDITING (touches 2-4 of ~15 files), REGRESSION (fixes target test, breaks others, never re-runs the suite). gpt-oss also leaks harmony <|channel|> tokens, but aider's SEARCH/REPLACE format dodges the tool_use parse bug that kills it under pi. (c) mellum = JetBrains Mellum2-12B-A2.5B-Instruct, a 2.5B-active FIM/completion-first MoE; never benchmarked as an aider DRIVER here -- expect the weakest edit-format adherence of the three; reserve for FIM/single-file --edit-format whole, not multi-file loops. Cross-cutting: even working configs are non-deterministic (a run occasionally trashes a file mid-edit), and small models hit aider's context limit on wide refactors (task-05 rename across ~15 files).

**Best driver:** qwen3-coder-next-80b is decisively the best driver. It is the ONLY model in the repo's matrix that reaches useful agentic edit quality (5-6/6 under a tool-loop harness; 4/6 under aider when file-scoped), it's a Coder-family MoE (~44GB @4-bit, fits a 128GB Studio with context headroom), and aider's SEARCH/REPLACE format plays to its strength while avoiding the tool_call parsing that trips the others. gpt-oss-120b is a distant second (~1.5/6, confabulates/under-edits) -- not worth running locally for code-edit even though 256GB could host it. mellum (2.5B-active completion model) is unsuitable as an agentic driver; reserve it for FIM/single-file fixups via --edit-format whole.

**Limitations:**
- Headless --message mode does not auto-explore: if the first model turn has no SEARCH/REPLACE block, aider exits with zero edits -- operator MUST pre-load file scope with --file/--read (repo: 2/6 -> 4/6 just from scoping). Unlike opencode/pi, aider has no model-driven glob/read/bash tool loop for autonomous discovery.
- litellm default 600s per-request timeout trips on slow local MoE inference; set timeout:1800 in a --model-settings-file. Unknown/custom model ids also need a --model-metadata-file or aider mis-estimates the context window.
- Edit-format adherence is the chief reliability risk on quantized/local models -- SEARCH blocks fail exact-match (whitespace/elided lines) causing apply-retry loops; mitigations (--edit-format whole, --architect with a cheap editor model) trade tokens/quality for parseability.
- gpt-oss-120b under aider: confabulation (claims done, 0 edits), under-editing (partial file coverage), and silent regressions (never re-runs the suite). mellum untested as a driver and architecturally a completion model -- likely the weakest of the three.
- Non-determinism: even validated configs occasionally emit a corrupt edit that dirties the worktree -- an orchestrator needs an 'unstage if tests fail' wrapper around any local-model aider run.
- Wide refactors (rename across ~15 files) blow aider's context limit on smaller models; mid-rename truncation observed (task-05).
- Gateway auth: aider needs a real per-key token in OPENAI_API_KEY/--openai-api-key (the box gateway 401s on a dummy); quota/admission 429/503 from the gateway surface to aider as litellm API errors.

### opencode — **installed** (`~/.opencode/bin/opencode`, v1.3.13 — upgrade to ≥1.17.9 before running)

**VIABLE against the box** (uses `/v1/chat/completions` via the Vercel AI SDK). Point it at the box with a custom provider in `opencode.json` (project-local or `~/.config/opencode/opencode.json`):
```json
{ "$schema": "https://opencode.ai/config.json",
  "provider": { "homebox": { "npm": "@ai-sdk/openai-compatible", "name": "Home Box",
    "options": { "baseURL": "https://inference.example.com/v1", "apiKey": "{env:HOMEBOX_API_KEY}" },
    "models": { "qwen3-coder-next-80b": {}, "gpt-oss-120b": {}, "mellum": { "tool_call": false } } } },
  "model": "homebox/qwen3-coder-next-80b" }
```
Headless: `HOMEBOX_API_KEY=<key> opencode run -m homebox/qwen3-coder-next-80b --dir <repo> --format json "<INSTRUCTION>"`.
- **Tool-use:** native function-calling ONLY — there is **no text/XML tool-call fallback**. A local model that emits malformed `tool_calls` JSON → the AI-SDK throws / the session stalls or loops (the primary failure mode to measure). Set `"tool_call": false` per model for mellum (FIM model — disable the tool path).
- **No turn-budget cap** → wrap every run in `timeout <N>` (a confused local model loops indefinitely).
- The gateway must return `usage` (it does) or opencode tracks 0 tokens. Known headless hang (sst/opencode#33319) under parallel startup — run serially.

### Codex CLI — **installed** (`/opt/homebrew/bin/codex`, v0.142.0) — ⚠️ **BLOCKED against the box**

**Codex now drives models EXCLUSIVELY via the OpenAI Responses API (`POST /v1/responses`)** — the `wire_api="chat"` option was removed (late 2025, codex#7782), and file edits go through an `apply_patch` function-call tool in Responses-API item format. **The box gateway only serves `/v1/chat/completions`, not `/v1/responses`** — so Codex **cannot drive the box models as-is**. Arm **A6 is blocked** pending one of: (a) a thin `/v1/responses`→`/v1/chat/completions` translation shim in `gateway.ts` (the documented fix; non-trivial — item-format + apply_patch translation), or (b) dropping A6. Config *shape* (for if/when a `/v1/responses` adapter exists): `codex exec -c "model_providers.box={base_url='…/v1', wire_api='responses', env_key='…'}" -c model_provider=box -m qwen3-coder-next-80b --dangerously-bypass-approvals-and-sandbox`. **Recommendation: run pi + aider + opencode for Gate D; treat A6 (Codex) as out of scope** unless the responses-adapter is built as its own task — the others test the same underlying local-agentic capability without the Responses-API blocker.

### pi — **installed** (`/opt/homebrew/bin/pi`, v0.70.2) — the project's prior-best local driver

**What it is:** `@mariozechner/pi-coding-agent` (Mario Zechner / badlogic, https://pi.dev, Earendil Inc; GitHub `badlogic/pi-mono`). A deliberately **minimal** OSS terminal coding harness — four built-in tools (`read`/`write`/`edit`/`bash`), a single read→think→tool→observe agent loop (no sub-agents), explicit "adapt pi to your workflow" philosophy. **This is the harness where this project's prior 6-task matrix saw qwen3-coder-next score its best (5-6/6)** — so it is a co-primary Gate D arm.

**VIABLE against the box** (uses `/v1/chat/completions` via its `openai-completions` provider path). Point it at the box by adding a provider stanza to **`~/.pi/agent/models.json`** (hot-reloads; already used on this laptop for Ollama/LM Studio/OpenRouter):
```json
{ "providers": { "inference-gille": {
  "baseUrl": "https://inference.example.com/v1", "api": "openai-completions",
  "apiKey": "$HS_API_KEY", "authHeader": true,
  "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
  "models": [ { "id": "qwen3-coder-next-80b" }, { "id": "gpt-oss-120b", "reasoning": true }, { "id": "mellum" } ] } } }
```
`apiKey` resolves an env-var name (here `$HS_API_KEY`) or a literal; `authHeader:true` → `Authorization: Bearer`. The `compat` flags exist precisely for local-server quirks (`supportsDeveloperRole:false`, `supportsReasoningEffort:false`, `maxTokensField:"max_tokens"`, `requiresToolResultName:true`).
Headless: `HS_API_KEY=<key> pi --provider inference-gille --model qwen3-coder-next-80b --no-session --print --mode json "<INSTRUCTION>"` (`--print` = single-shot run-to-completion+exit; `--mode json` = NDJSON event stream incl. tool traces; `--no-session` = clean slate).
- **Tool-use:** **native function-calling only** (`openai-completions` + standard tool defs; the `edit` tool returns a unified-diff `patch`). No SEARCH/REPLACE-style text fallback. This is exactly why **gpt-oss-120b dies under pi** (malformed tool-call JSON → loop stalls, no retry/repair) while **qwen3-coder-next serializes tool-calls reliably (5-6/6)**. So pi is the cleanest test of "can the *model* do tool-calling," with the harness held minimal.
- **No `--max-turns` flag** found → wrap every run in `timeout <N>` (a looping local model has no built-in bailout).
- Config: `~/.pi/agent/models.json` + auth `~/.pi/agent/auth.json`; docs in the package's `docs/models.md` + `custom-provider.md`.

## Gate D Agentic-Coding-Task Battery

**Answers:** T6 (harness loop reliability) and T7 (Hugin integration) from `docs/migration-go-no-go-plan.md`.
**Claim under test:** an OSS harness driving a **local** model can complete real multi-step coding loops as reliably as Claude Code.

### Why this is a NEW battery, not the existing probes

`src/homeserver/probes.ts` is a **single-shot** battery: one prompt → one model output → one `Verifier(output: string)`. Even its `code-edit` probes hand the model the snippet inline and grade the returned text. That measures *can the model emit a correct edit*, not *can a harness drive the model through a loop* (discover files → edit across files → run tests → read failure → revise → stop). Gate D needs:

- **A real repo on disk** (a tiny git working tree), not a string in a prompt.
- **A harness in the loop** (aider/opencode/Codex) applying edits and running tests, not `extractCodeBlock`.
- **A filesystem/exit-code pass check** run *after the harness exits*, not on the model's text. We keep the spirit of `verifier.ts` (deterministic, no model judge) but operate on the **resulting worktree** via `npm test` exit status.

So Gate D reuses the *philosophy* of `tsGate` (compile+run, exit 0 = pass) and `verifierName` bookkeeping, but the unit of evaluation is **"did the harness leave the repo in a passing state?"** — `git`-clean-or-not + `pnpm/npm test` exit code + a structural `git diff` assertion.

---

### Task fixtures: layout & invariants

Each task is a self-contained directory under `gate-d/tasks/<id>/`:

```
gate-d/tasks/<id>/
  repo/                 # the seed git working tree (committed at HEAD, tests RED or as noted)
    package.json        # "test": "tsx --test test/*.ts"  (node:test, zero deps, fast)
    tsconfig.json
    src/...             # source under edit
    test/...            # the deterministic oracle (the harness must NOT be allowed to delete/skip)
  INSTRUCTION.md        # the exact string handed to the harness (--message)
  scope.json            # { "edit": [...files], "read": [...files] }  ← aider --file/--read pre-scoping
  check.sh              # the verifier: exit 0 = PASS, non-0 = FAIL. NEVER calls a model.
  meta.json             # { id, taskType, kind, turnsBudget, costBudgetTok, baselineDifficulty }
```

**Shared `repo/package.json`:**
```json
{ "name": "gate-d-fixture", "type": "module",
  "scripts": { "test": "tsx --test test/*.ts", "lint": "tsc --noEmit -p tsconfig.json" },
  "devDependencies": { "tsx": "^4" } }
```
Tests use the built-in `node:test` + `node:assert` — no install needed beyond `tsx` (already present per CLAUDE.md tech stack). This makes `check.sh` a 3-line wrapper around `npm test`.

**Anti-cheat invariants enforced by `check.sh` for every task** (the hard-won failure modes from the harness research — confabulation, test-deletion, regression):
1. **Oracle integrity:** `git diff --quiet HEAD -- test/` against a recorded `test/.sha256` — if the harness modified/deleted the oracle test, **FAIL** (catches "make the test pass by deleting it").
2. **Edit actually happened:** `git diff --stat HEAD -- src/ | grep -q changed` — zero source edits ⇒ **FAIL** (catches gpt-oss *confabulation*: "done", 0 edits).
3. **Whole suite green, not just the target:** `npm test` must exit 0 over **all** test files (catches *regression*: fixed target test, broke a sibling, never re-ran).
4. **Worktree compiles:** `npm run lint` (tsc `--noEmit`) exit 0 (catches *corrupt-edit* dirtying — the research's "a run occasionally trashes a file mid-edit").

`check.sh` skeleton (identical across tasks):
```bash
#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/repo"
# 1. oracle untouched
sha256sum -c test/.sha256 >/dev/null 2>&1 || { echo "FAIL: oracle test modified"; exit 11; }
# 2. a source edit happened
git diff --stat HEAD -- src/ | grep -q '|' || { echo "FAIL: no src edit (confabulation)"; exit 12; }
# 3. + 4. structural assertion (task-specific, appended below), then full suite + typecheck
${TASK_STRUCTURAL_CHECK:-true} || { echo "FAIL: structural"; exit 13; }
npm run -s lint || { echo "FAIL: tsc"; exit 14; }
npm test >/dev/null 2>&1 || { echo "FAIL: suite red"; exit 15; }
echo PASS; exit 0
```

---

### The task corpus

The original 10-task revision remains byte-identical. Revision `gate-d-r2` appends four fresh,
model-unseen deterministic cases (11–14) for prompt-learning holdouts; see
`gate-d/CORPUS.md` for the pinned revision contract. No existing evidence should be relabelled as
fresh, and Hugin owns any later matched experiment. Routine consumers enumerate the manifest's r1
task list; r2 requires explicit holdout opt-in and result/resume/scoreboard paths are scoped to
`corpusRevision`.

### The original 10 tasks

Difficulty tiers: **E**(easy, single-file)·**M**(medium, 2 files)·**H**(hard, multi-file/discovery). Mix is deliberate — E/M tasks the research says qwen3-coder-next-80b should pass; H tasks probe the discovery limit (where aider's "no autonomous file-discovery" weakness bites and pre-scoping matters most).

| # | id | tier | kind | what it exercises |
|---|---|---|---|---|
| 1 | `make-failing-test-pass` | E | impl-to-green | classic red→green, one fn |
| 2 | `fix-bug-test-catches` | E | bugfix | read a failing assertion, fix logic |
| 3 | `impl-fn-across-2-files` | M | multi-file impl | implement + wire an import across 2 files |
| 4 | `add-cli-flag-e2e` | M | feature | parse a new `--json` flag through arg-parser→formatter |
| 5 | `add-test-then-impl` | M | tdd | write the test the instruction describes, *then* make it pass |
| 6 | `fix-off-by-one-loop` | E | bugfix | off-by-one in a paginator, oracle catches boundary |
| 7 | `refactor-extract-fn` | M | refactor | extract a helper, both call sites still green |
| 8 | `add-validation-guard` | M | feature | reject bad input with a thrown error the test asserts |
| 9 | `rename-symbol-across-files` | H | refactor | rename a type across **4** files (the aider context-limit probe) |
| 10 | `fix-regression-3-files` | H | bugfix | a bug whose fix touches 3 files; 2 sibling tests must stay green |

Below: setup / instruction / verifier for each. (Tasks 1–6 fully specified; 7–10 follow the identical shape — fixture sketch + structural assertion given.)

---

#### Task 1 — `make-failing-test-pass` (E)
**Setup** `repo/src/sum.ts`:
```ts
export function sum(_xs: number[]): number { return 0; } // stub
```
`repo/test/sum.test.ts` (RED at seed, committed):
```ts
import { test } from "node:test"; import assert from "node:assert";
import { sum } from "../src/sum.ts";
test("sums", () => { assert.equal(sum([1,2,3]), 6); assert.equal(sum([]), 0); assert.equal(sum([-1,1]), 0); });
```
**Instruction (`INSTRUCTION.md`):** "There is one failing test in `test/sum.test.ts`. Implement `sum` in `src/sum.ts` so the test passes. Do not modify the test."
**scope.json:** `{ "edit": ["src/sum.ts"], "read": ["test/sum.test.ts"] }`
**Verifier:** `check.sh` (shared). `TASK_STRUCTURAL_CHECK=true` (suite-green is sufficient). **PASS = `npm test` exit 0 + oracle untouched + src edited.**

#### Task 2 — `fix-bug-test-catches` (E)
**Setup** `repo/src/parse.ts`:
```ts
export function parsePort(s: string): number { return parseInt(s); } // bug: ignores radix + NaN guard
```
oracle asserts `parsePort("08")===8` (leading-zero) and `parsePort("x")` throws.
**Instruction:** "`test/parse.test.ts` fails. Fix the bug in `src/parse.ts` so all assertions pass. Do not touch the test."
**Verifier:** shared `check.sh`. **PASS = suite green + oracle sha matches.**

#### Task 3 — `impl-fn-across-2-files` (M)
**Setup:** `repo/src/geo.ts` exports `distance(a,b)` (stub `0`); `repo/src/index.ts` is supposed to `import { distance }` and export `nearest(point, points)` — but the import line is missing and `nearest` throws `notImplemented`. Oracle (`test/index.test.ts`) calls `nearest`.
**Instruction:** "Implement `distance` (Euclidean) in `src/geo.ts` and `nearest` in `src/index.ts` (returns the closest point). `index.ts` must import `distance` from `./geo.ts`. Make `test/index.test.ts` pass."
**scope.json:** `{ "edit": ["src/geo.ts","src/index.ts"], "read": ["test/index.test.ts"] }`
**Verifier:** shared `check.sh` **plus** `TASK_STRUCTURAL_CHECK='grep -q "from \"./geo" src/index.ts'` — forces the cross-file wiring (a model that inlines distance into index.ts and never touches geo.ts fails invariant #2 *and* this grep).

#### Task 4 — `add-cli-flag-e2e` (M)
**Setup:** `repo/src/cli.ts` has a hand-rolled arg loop producing a text report; `repo/src/format.ts` has `formatText(rows)`. Oracle (`test/cli.test.ts`) imports the `run(argv)` entry and asserts: `run(["report"])` → text; `run(["report","--json"])` → `JSON.parse`-able with `rows.length===2`.
**Instruction:** "Add a `--json` flag to the CLI. When present, `run` returns JSON (use a new `formatJson` in `src/format.ts`) instead of text. Wire it end-to-end so `test/cli.test.ts` passes."
**scope.json:** `{ "edit": ["src/cli.ts","src/format.ts"], "read": ["test/cli.test.ts"] }`
**Verifier:** shared `check.sh` + `TASK_STRUCTURAL_CHECK='grep -q "formatJson" src/format.ts && grep -q "\\-\\-json" src/cli.ts'`.

#### Task 5 — `add-test-then-impl` (M, TDD)
**Setup:** `repo/src/clamp.ts` stub; `repo/test/clamp.test.ts` exists but is **empty** (`test("todo", () => {})` — green at seed). A separate **hidden oracle** `gate-d/tasks/05/oracle/clamp.oracle.test.ts` is NOT in the repo.
**Instruction:** "Write tests in `test/clamp.test.ts` covering `clamp(n,lo,hi)` for in-range, below-lo, and above-hi, then implement `clamp` in `src/clamp.ts` to pass them."
**Verifier (two-stage, deterministic, no judge):**
1. Harness's own suite green (proves it didn't ship a non-compiling mess).
2. `check.sh` then **copies the hidden oracle in and re-runs**: `cp ../oracle/clamp.oracle.test.ts repo/test/ && npm test`. The hidden oracle is the ground truth for `clamp` — if the model's impl is wrong, it goes red. This catches the "wrote a vacuous test that its own impl trivially passes" cheat without any model in the loop.
**Structural:** harness-written `test/clamp.test.ts` must contain ≥3 `assert` calls (`grep -c assert ≥ 3`) — a non-empty test was actually authored.

#### Task 6 — `fix-off-by-one-loop` (E)
**Setup:** `repo/src/paginate.ts` `paginate(items, page, size)` uses `items.slice(page*size, page*size+size+1)` (off-by-one: pages overlap by one). Oracle asserts page 0 and page 1 of `[0..9]` size 5 are `[0..4]`/`[5..9]` with no overlap and `paginate(items,2,5)===[]`.
**Instruction:** "Fix the off-by-one bug in `src/paginate.ts`; `test/paginate.test.ts` must pass. Do not edit the test."
**Verifier:** shared `check.sh`.

#### Tasks 7–10 (sketch — same fixture shape, structural assertion given)

- **7 `refactor-extract-fn` (M):** `src/report.ts` has duplicated subtotal math in two functions; instruction: extract `subtotal(rows)` helper, both callers use it, behaviour unchanged. Oracle = existing characterization tests (green at seed). `TASK_STRUCTURAL_CHECK='grep -c "function subtotal\|const subtotal" src/report.ts | grep -q 1'` + suite stays green. (Tests green at seed → invariant #2 "src edited" + suite-green proves a *behaviour-preserving* refactor, not a no-op.)
- **8 `add-validation-guard` (M):** `src/account.ts` `withdraw(acc, amt)` lacks a negative/overdraft guard; oracle asserts it `throws` on `amt<0` and on `amt>balance`. Instruction: add the guards. Shared `check.sh`.
- **9 `rename-symbol-across-files` (H):** type `Widget` used in `src/{model,store,view,index}.ts` (4 files) + `test/*` references it by the new name `Gadget`. Instruction: "Rename the `Widget` type to `Gadget` everywhere." `TASK_STRUCTURAL_CHECK='! grep -rq "Widget" src/ && grep -rq "Gadget" src/'`. This is the **aider context-limit / partial-rename probe** — the research saw mid-rename truncation here; check #2's per-file requirement is satisfied only if all 4 files change, so a partial rename fails `tsc` (#4) anyway.
- **10 `fix-regression-3-files` (H):** a shared `normalize()` in `src/util.ts` is wrong; correct fix requires editing `util.ts` + two callers that each compensated for the bug. 3 oracle test files; **2 must stay green** while the target goes from red→green. This is the explicit **regression probe** (research: gpt-oss "never re-runs the suite"). Shared `check.sh` invariant #3 (whole suite) is the teeth.

---

### Run matrix

**Arms (harness × model):**

| Arm | Harness | Model | Edit format | Why |
|---|---|---|---|---|
| **A1** | aider 0.86.2 | `qwen3-coder-next-80b` | `diff` (SEARCH/REPLACE) | the research's only validated local driver; primary |
| **A2** | aider | `qwen3-coder-next-80b` | `whole` | fallback edit-format for parseability — does it lift completion? |
| **A3** | aider | `gpt-oss-120b` | `diff` | second-best per research; expect confabulation/under-edit |
| **A4** | aider | `mellum` | `whole` | weakest; **single-file E tasks only** (1,2,6,8) — FIM model, not a multi-file driver |
| **A5** | opencode | `qwen3-coder-next-80b` | native | cross-harness check (tool-loop vs SEARCH/REPLACE); T7 path |
| **A6** | Codex CLI | `qwen3-coder-next-80b` | native | ⚠️ **BLOCKED** — Codex requires `/v1/responses` (not served by the box); out of scope unless a responses-adapter is built (see Harness landscape) |
| **A7** | **pi** | `qwen3-coder-next-80b` | native | **co-primary** — the project's prior-best local driver (5-6/6); minimal harness → cleanest "can the model tool-call" signal |
| **A8** | pi | `gpt-oss-120b` | native | reproduce the prior "gpt-oss dies under pi" tool-call-serialization failure (control for the model-vs-harness attribution) |
| **B0** | **Claude Code** | Opus→Sonnet | native | **baseline arm** (denominator for the 80% relative threshold) |
| **B1** | aider | `anthropic/claude-sonnet` via gateway | diff | **harness-isolation control** — proves the *harness* viable with a frontier brain (the T6 fail→forward S1 path) |

Each arm runs **all applicable tasks ×3 seeds** (temp 0 is non-deterministic on the box per the research; 3 repeats expose the "occasionally trashes a file" tail). Runnable arms = A1–A5, A7, A8, B0, B1 (A6/Codex is blocked). Total: ~10 tasks × 3 seeds × ~8 runnable arms ≈ **240 runs** (fewer for A4/mellum which skips H/M-multi tasks).

**Cost discipline (per CLAUDE.md):** A1–A5 + A7/A8 (pi) are **free** (local M5 compute; A6/Codex is blocked, not run). **B0 and B1 are the only OpenRouter/Claude spend** — run them **once each**, save transcripts, never re-run to re-grade (the check.sh oracle re-grades offline for free). Budget estimate before running: B0 ≈ 10 tasks × 3 seeds × (Opus plan + Sonnet edits) — cap at ~$15; B1 ≈ Sonnet-only ~$5. Run B0/B1 **first** while weekly cap has headroom.

### Success metric

Per (arm, task): a run is **complete** iff `check.sh` exits 0. Per arm:
- **Completion rate** `C = passes / (tasks×seeds)` (a task counts pass if ≥2/3 seeds pass — majority, to absorb the non-determinism tail).
- **Turns/cost budget:** each run is bounded by `meta.json.turnsBudget` (E=6, M=10, H=16 harness turns) and `costBudgetTok` (E=20k, M=50k, H=120k local tokens). A run exceeding budget is scored **FAIL (over-budget)**, recorded separately from logic-fail.
- **Degenerate-loop rate** `D` = fraction of runs that hit the turn cap with no green and no forward progress (same diff twice / apply-retry storm).
- **Cold-start rate:** aider runs where the model's first turn had no SEARCH/REPLACE block ⇒ cold exit, 0 edits (the research's headline aider failure). Recorded per arm.
- **Human-rescue count:** 0 by construction (headless `--message`); any manual intervention voids the run.

**Pass thresholds (ratify before running, per the plan's T6/T7):**
- **T6 PASS:** best local arm `C ≥ 0.80 × C(B0)` AND `D ≤ 0.05` AND no task class with 0/3 across all seeds (no "cannot start" class). Record per-arm so we know *which* harness clears it, not just that one does.
- **T7 PASS (Hugin integration):** A5/A6 (or a dedicated arm) delegate ≥1 leaf sub-task through `/v1/delegate` (the `hugin-mcp` broker), one task **forces an escalation** (route an `sql`-shaped sub-step — `escalateToFrontier` per `docs/m5-routing.json`), and the error envelopes (`broker_network_error`, `alias_unavailable`, 429/503) surface to the harness **un-swallowed**; idempotent on retry. Smoke is binary clean/not.

### Exact "point the harness at the box" invocations

Common env (use a **real per-key gateway token**, not a dummy — the box 401s on dummies; mint via `bin/invite`):
```bash
export GW=https://inference.example.com/v1
export GW_KEY=<real-gateway-key>
export MODEL=qwen3-coder-next-80b     # exact /v1/models label; also: gpt-oss-120b, mellum
```

Per-task aider model-settings (`gate-d/aider-model-settings.yml`) — the research's two mandatory knobs for slow local MoE + unknown-id metadata:
```yaml
- name: openai/qwen3-coder-next-80b
  edit_format: diff
  use_repo_map: false
  extra_params: { timeout: 1800 }     # litellm default 600s trips on slow MoE
```
and `gate-d/aider-model-metadata.json` so aider doesn't mis-truncate context:
```json
{ "openai/qwen3-coder-next-80b": { "max_input_tokens": 200000, "max_output_tokens": 32000,
  "input_cost_per_token": 0, "output_cost_per_token": 0 } }
```

**A1 — aider × qwen3-coder-next-80b (primary), per task, file-scoped (the 2/6→4/6 lift):**
```bash
cd gate-d/tasks/<id>/repo
EDIT=$(jq -r '.edit[]' ../scope.json); READ=$(jq -r '.read[]' ../scope.json)
OPENAI_API_BASE=$GW OPENAI_API_KEY=$GW_KEY \
aider --model openai/$MODEL \
  --edit-format diff \
  --model-settings-file ../../../aider-model-settings.yml \
  --model-metadata-file ../../../aider-model-metadata.json \
  --no-auto-commit --yes \
  --auto-test --test-cmd "npm test" \
  $(printf -- '--file %s ' $EDIT) $(printf -- '--read %s ' $READ) \
  --message "$(cat ../INSTRUCTION.md)"
cd .. && bash check.sh; echo "exit=$?"
```
Notes: the `openai/` prefix is mandatory (routes via litellm generic provider to `OPENAI_API_BASE`); `--auto-test --test-cmd "npm test"` makes aider feed failures back (the loop); `--no-auto-commit` so `check.sh`'s `git diff HEAD` sees the harness's net edit. **A2** = same with `--edit-format whole` and the metadata `edit_format: whole`. **A3** = `MODEL=gpt-oss-120b`. **A4** = `MODEL=mellum --edit-format whole`, single-file tasks only.

**A5 — opencode × box:** `OPENAI_API_BASE`/`OPENAI_API_KEY` same; opencode reads an OpenAI-compatible base. Run headless against the same `INSTRUCTION.md` + repo; opencode does its own file discovery (no `--file` scoping needed — it's the tool-loop arm).

**A6 — Codex CLI × box:** point Codex's model provider at `$GW` (OpenAI-compatible base + `$GW_KEY`), `model = qwen3-coder-next-80b`, run headless with the instruction; Codex auth is its own (ChatGPT) — the OpenRouter cap does NOT gate it, but here we override its provider to the box so it drives the **local** model.

**B0 — Claude Code baseline:** run each task with Claude Code (Opus→Sonnet) given only `INSTRUCTION.md` + the repo dir, headless, same turn budget. Save the transcript; grade with the **same `check.sh`**.

**B1 — harness-isolation control:** A1 invocation but `MODEL=anthropic/claude-sonnet` (a frontier id the gateway proxies) — isolates "is the harness viable?" from "is the local model viable?", which is exactly the T6 fail→forward (S1-via-OSS) the plan calls for.

### Wrapper / orchestration

A `gate-d/run.sh <arm> <task-id|all>` driver that selects tasks from the pinned corpus manifest (r1 by default; r2 only with explicit holdout opt-in) and, per run: (1) creates a pristine isolated seed worktree, (2) invokes the arm with a hard wall-clock cap, (3) runs `check.sh`, and (4) appends a JSONL row including `{arm, model, task, corpusRevision, taskRevision, holdout, pass, exitClass, wallS}`. Resume and scoreboards filter on the selected revision. Results crunch into the per-arm completion-rate table offline — **no model in the grading path**, consistent with `verifier.ts`'s deterministic philosophy.

### Success criteria summary (thresholds with teeth)

| Metric | Threshold | Source |
|---|---|---|
| Best-local completion `C` | `≥ 0.80 × C(Claude-Code B0)` | T6 |
| Degenerate-loop rate `D` | `≤ 0.05` | T6 |
| "Cannot start" task classes | `0` | T6 |
| Over-budget rate (best arm) | `≤ 0.20` | added (budget teeth) |
| T7 broker smoke | clean e2e, all error envelopes surfaced, idempotent retry | T7 |
| Cold-start rate (aider arms) | reported per-arm; informs whether pre-scoping is mandatory | research |

If best-local fails T6 but **B1 (frontier-in-OSS-harness) passes**, the verdict is the plan's documented fail→forward: **harness is viable, local-as-hands is not yet** → adopt OSS harness with a frontier brain for S1, keep local-driver on the watch-list. If even B1 struggles, the harness itself is the blocker → try the next harness (A5/A6 cross-check tells you which).
## Gate E — Local-as-Orchestrator (T5, expanded into a runnable bake-off)

> **🛠 Implementation status (2026-06-24): HARNESS BUILT + OFFLINE-VERIFIED; the live A0–A3 run is the M5 phase.**
> The offline-testable core is complete and TDD'd green (58 Gate-E tests, tsc clean):
> - `scripts/gate-e-types.ts` — the frozen type contract (OrchTask / OrchTrace / TaskScore / GateEVerdict).
> - `scripts/gate-e-tasks.ts` (+ generated `scripts/gate-e-data.ts`, regen via `scripts/gen-gate-e-data.py`) — the 20 gold tasks (D1 FRAMES oracle, D2 tsGate, D3 pipeline, D4 sql-gap recovery); D3/D4 golds are **computed**, never hand-counted.
> - `scripts/gate-e-score.ts` — Tier-1 deterministic metrics (answer_pass, plan_coverage, gap-escalation + over-escalation, integration, collapse flags). The trust anchor.
> - `scripts/gate-e-verdict.ts` — the E1–E6 aggregator + S1/S2 recommendation.
> - `scripts/gate-e-bench.ts` — the four arms behind `--arm`, a unified plan→delegate→integrate loop sharing `orchestrator.delegate()` as the LOCAL leaf substrate; `--dry-run` runs a synthetic brain fully offline.
>
> **Run recipe** (Phase 2 — mostly free on the M5; only A0 once + A3 advisor + the judge spend OpenRouter):
> ```bash
> # offline mechanics check (no network):
> tsx scripts/gate-e-bench.ts --arm a1 --dry-run
> # live arms (RESEARCH_GATEWAY_URL → M5 :8091; HOMESERVER_USE_ROUTING_TABLE=on for sql escalation):
> tsx scripts/gate-e-bench.ts --arm a0 --save data/gate-e/    # Opus brain — RUN ONCE, reuse
> tsx scripts/gate-e-bench.ts --arm a1 --save data/gate-e/    # local 80b + deterministic harness (free)
> tsx scripts/gate-e-bench.ts --arm a3 --advisor-k 3 --save data/gate-e/   # Advisor (meter frontier share)
> tsx scripts/dr-judge-hybrid.ts data/gate-e A0,A1,A2,A3      # Tier-2 blind judge on SAVED reports
> # then apply E1–E6 via the verdict aggregator on the saved scores.
> ```
> **Note on E4 escalation:** leaf escalation is honoured TWO ways so E4 measures the brain's judgment — (1) the brain marking a step `escalate:true` runs it on the frontier; (2) otherwise the shared `delegate()` substrate escalates `sql` by the `m5-routing.json` policy. A3's leaf executor is substrate-only so the **capped advisor** is its only frontier path (protects the E6 token-share measure).

**Question this gates:** Can a LOCAL model (`qwen3-coder-next-80b` or `gpt-oss-120b`) hold the **brain** seat — decompose a goal, route/sequence sub-tasks, integrate results, and decide escalation — not merely execute leaf sub-tasks? Passing Gate E is the **only** thing separating **S1-Hybrid** (frontier brain + local hands, already supported by current evidence) from **S2** (fully local, frontier as backup-only). See `docs/migration-go-no-go-plan.md` §"three states" and §T5.

**Standing finding this challenges (must be falsified to pass):**
- The 80b scores **2.92 (catastrophic) on raw full pages** where Claude is fine (4.28) — it cannot hold raw, unstructured orchestration context (`docs/migration-go-no-go-plan.md` T5).
- **Tongyi agent-mode was the WORST of 13 systems (2.22, mean-rank 12.4)** — the model-driven specialist *under-reads* (2–4 of 11–15 sources), synthesises too early, hallucinates; "the **deterministic harness decisively beats the agentic specialist**" (`docs/dr-ablation-findings-2026-06-22.md` #40, finding 10).
- Live dogfood placed the **capability boundary exactly on the leaf/orchestrator line**: leaf sub-tasks local-viable (94.5%), but **orchestration roles — synthesis / gap-check / plan-decompose — escalated to frontier** (`migration-go-no-go-plan.md` T1).

The design's job is to test the standing finding *fairly* — giving the local brain the structural scaffolding (pre-digested context, a deterministic harness skeleton, an on-demand advisor) the prior negative proxies deliberately withheld — and to define the exact bar that would overturn it.

---

### 1. The orchestration task set (`ORCH_TASKS`)

Orchestration ≠ leaf work. A task qualifies only if the **brain must plan + route + integrate** — i.e. correctness depends on decisions *between* leaf calls, not on any single leaf output. Leaf execution is held **constant and local** across all arms (`mellum` / `qwen3-coder-next-80b` via `orchestrator.delegate()`), so the experiment isolates the *brain*, not the hands.

Build `scripts/gate-e-tasks.ts` exporting `ORCH_TASKS: OrchTask[]`, **20 tasks** across 4 families (5 each). Each task ships with a **machine-checkable spec** (the deterministic scorer, §3) so most scoring needs no judge.

| Family | Example task | What the brain must do | Deterministic anchor |
|---|---|---|---|
| **D1 — Deep research** (reuse FRAMES + dr corpus) | "What was the population of the capital of the country that won the 1998 World Cup, in the year of that win?" (multi-hop) | Plan sub-queries → route each to search/read/distill leaf → detect the numeric-reasoning step → **escalate the arithmetic** (the known gap) → integrate + cite | FRAMES gold answer + gold-source presence (`scripts/frames-grade.ts`, `frames-evidence.ts`); citation-verifier report-sentence pass rate (`citation-verifier.ts`) |
| **D2 — Multi-file feature** | "Add a `containsAll(...keywords)` verifier primitive to `verifier.ts`, wire it into a new probe in `probes.ts`, export it, and add a passing vitest." | Decompose into file-scoped chunks → sequence (primitive before probe before test) → route each chunk to a local code leaf → run the gate → repair on red | `tsc` clean + `vitest` green on the produced diff (`tsGate` verifier); # files touched vs required set |
| **D3 — Pipeline-of-tools** | "Given this 600-line access log, find the top-3 IPs by 5xx count, classify each as bot/human, and draft an incident summary." | Plan extract→aggregate→classify→summarize → route each stage to the right local model → integrate, no stage skipped | Exact top-3 IP set (regex/numeric verifier); stage-completion checklist (did each declared sub-task actually run?) |
| **D4 — Ambiguous / recovery** | A task with a deliberately *unviable* leaf (e.g. a `sql` JOIN+GROUP BY+HAVING sub-task, the one characterized hard-gap) embedded mid-plan | Plan → attempt local leaf → **verifier fails** → decide to escalate *that leaf only* (lazy, not eager) → continue the plan → integrate | Did it escalate the gap leaf? (binary); did it escalate *non-gap* leaves? (over-escalation penalty); final-answer correctness |

**Why these:** D1/D3 directly re-run the corpora where the negative proxies were measured (deep-research, frozen corpus), so a pass here *overturns the specific prior result*. D2 is the canonical "multi-file feature" the prompt asks for and maps to the real RQ6 agentic-delegation bulk. D4 makes **escalation judgment** first-class — the brain's hardest job and the one Gate B's router only approximates statically.

**Held constant across arms:** leaf models, the corpus (frozen — retrieval bypassed via the FRAMES oracle pattern so we test the *brain*, not the search box), token budgets per leaf, and the timeout guard in `orchestrator.delegate()`.

---

### 2. The four arms

All arms share the leaf substrate (`orchestrator.delegate()` + the `m5-routing.json` table). Only the **brain** changes. Build `scripts/gate-e-bench.ts` with a `--arm` switch.

| Arm | Brain | Loop driver | Context the brain sees | Frontier use | What it tests |
|---|---|---|---|---|---|
| **A0 — Frontier reference (S1 ceiling)** | Opus (via OpenRouter) | Deterministic harness (`deep-research.ts` 8-stage / `orchestrate.ts` chunk-gate) | Distilled (`rich-mellum`) | brain = frontier | The S1-Hybrid ceiling. **Run ONCE, save, reuse** (credit discipline). |
| **A1 — Local-brain + deterministic harness** | `qwen3-coder-next-80b` (then `gpt-oss-120b`) | **Same** deterministic harness as A0 | **Distilled** (`rich-mellum` pre-digest — the proven lever) | none | Can a local brain fill the planning/integration slots of a *code-driven* skeleton? Fair version of the "2.92 on raw pages" test — give it the distillation it was denied. |
| **A2 — Local-brain agentic (Tongyi-style)** | `qwen3-coder-next-80b` / Tongyi-DR | **Model-driven** ReAct (`deep-research-agent.ts`, `runAgentResearch`, native dialect) | raw observations | none | Re-tests the #40 finding *with a stronger/larger brain and the auto-citation + native-dialect fixes already landed*. The "is agentic-mode still worst?" rematch. |
| **A3 — Advisor pattern** | `qwen3-coder-next-80b` drives the loop; calls a **frontier advisor on demand** (bounded, per-decision, NOT per-leaf) | Deterministic harness, but the brain may emit an `ASK_ADVISOR(question)` action capped at **K calls/task** | Distilled | brain = local; **frontier consulted only on escalation-flagged decisions** | The headline challenger. Does local-drives + frontier-advises recover S1 quality at a fraction of S1's frontier *token* share? Directly tests the prior "Advisor pattern" / "local can't orchestrate" hypothesis. |

**Arm sequencing (credit-aware, per CLAUDE.md):** run **A0 first** while budget remains, save every report + plan trace to `data/gate-e/`, and **reuse** it as the reference across iterations. A1/A2 are **free** (local-only) — run them freely and repeatedly. A3 spends frontier *only* on advisor calls; **meter K** (default K=3/task) and price the advisor token share — that number IS the S2-vs-S1 cost argument.

**Advisor budget instrumentation (load-bearing):** log, per A3 task, `advisor_calls`, `advisor_prompt_tokens`, `advisor_completion_tokens`. A3 only "counts" as near-local if its frontier token share ≪ A0's. The pass criterion (§4) makes this explicit.

---

### 3. Scoring — deterministic where possible, blind judge only for the residual

**Tier 1 — Deterministic orchestration metrics (no judge, free, the trust anchor).** Compute per task, per arm:

1. **Final-answer correctness** — D1: `frames-grade.ts` exact/numeric match; D2: `tsGate` (tsc+vitest green); D3: exact top-3 set + stage checklist; D4: gold answer match. → **`answer_pass ∈ {0,1}`**.
2. **Plan adequacy (structural)** — parse the brain's emitted plan (each arm logs a structured plan/trace). Score `plan_coverage = |declared sub-tasks ∩ required sub-tasks| / |required|` against the task's gold sub-task set. Penalise missing required steps; this is the deterministic proxy for "did it decompose correctly."
3. **Routing/escalation judgment** (D4 + all) — **`gap_escalated ∈ {0,1}`** (did it escalate the genuine gap leaf?) and **`over_escalation_rate`** (non-gap leaves sent to frontier / total non-gap leaves). Lazy-not-eager is measured here, mirroring T3's `≤ true-gap + 5pts`.
4. **Integration soundness** — citation-verifier report-sentence pass rate (`citation-verifier.ts`) for D1; for D2/D3 the gate/checklist already covers it. Catches the #40 failure mode (synthesise-too-early / hallucinate).
5. **Collapse flags** (binary, any → task = FAIL regardless of score) — degenerate loop (repeated identical action), context-overflow blanking (empty/truncated final), under-read (D1: sources read < 60% of corpus, the exact #40 signature), timeout.

**Tier 2 — Blind cross-family judge (only for what determinism can't capture: synthesis prose quality + plan *quality* beyond coverage).** Reuse `scripts/dr-judge-hybrid.ts` exactly: **Opus-on-sub + o4-mini-on-OpenRouter, counterbalanced shuffle**, 5-pt rubric, on the **saved** A0/A1/A2/A3 reports. Judge dimensions: plan quality, integration coherence, citation quality, overall. **Never re-run a pipeline to re-judge** (credit rule). Budget: `4 arms × 20 tasks × 2 judges` ≈ 160 judge calls — estimate against the weekly cap *before* running; A0 reference reused, so the only frontier *inference* spend is A0 (once) + A3 advisor calls.

**Why two tiers:** the project's own hard-won lesson is that "the deterministic metric and the blind judge DIVERGE" (the atomic-sentence evaluation finding). Tier 1 anchors the verdict in machine-checkable truth (overturning a prior result requires a deterministic win, not just a judge preference); Tier 2 only adjudicates the genuinely subjective residual.

---

### 4. Pass criterion — what would justify S2 over S1-Hybrid

Gate E **PASSES** (unlock S2) iff a single local-brain arm clears **all** of the following, on the 20-task set, with the frontier arm A0 as the reference ceiling:

| # | Criterion | Threshold | Source / rationale |
|---|---|---|---|
| **E1** | **Deterministic answer correctness** vs frontier | `answer_pass` rate ≥ **A0 − 0.10** (i.e. solves ≥90% of what the frontier brain solves) | The brain must actually complete the work. |
| **E2** | **No collapse** | **0** collapse-flag tasks (degenerate loop / blanking / under-read / timeout) | This is the exact failure that sank the 80b-on-raw-pages (2.92) and Tongyi (2.22). Zero tolerance — one collapse = S2 not ready. |
| **E3** | **Plan coverage** | mean `plan_coverage ≥ 0.85`, no task < 0.6 | Decomposition is the brain's core job. |
| **E4** | **Escalation judgment (lazy not eager)** | `gap_escalated = 1` on **100%** of D4 gap leaves; `over_escalation_rate ≤ 0.10` | Mirrors Gate B's ≥98% gap-recall + T3's laziness bar — a local brain that escalates everything silently reverts to S1. |
| **E5** | **Judge quality delta** | blind-judge mean ≥ **A0 − 0.5** on the 5-pt rubric, no dimension < "acceptable" floor | The same bar as T5/T10 in `migration-go-no-go-plan.md`. |
| **E6 (S2-vs-S1 economic gate, A3 only)** | **Frontier token share** | A3's frontier (advisor) token share ≤ **25%** of A0's total frontier tokens, *while* clearing E1–E5 | This is the crux. If the Advisor pattern needs ~the same frontier tokens as a full frontier brain to hit quality, it is **not** a local orchestrator — it's S1 wearing a costume. S2 is justified only if local-drives genuinely shifts the *brain* token bulk off frontier. Cross-check the surviving advisor spend against T8's Claude-MAX headroom (134–1,134 SEK/mo). |

**Verdict logic:**
- **A1 (local + deterministic harness) clears E1–E5** → **S2 is viable with a frontier-free brain** — the strongest possible result; the standing "local can't orchestrate" finding is overturned for the *harness-scaffolded* case. Recommend S2.
- **Only A3 (Advisor) clears E1–E5 AND E6** → **S2 viable via the Advisor pattern** — local holds the loop, frontier is a bounded on-demand advisor. This is the realistic win and the direct vindication of the prior Advisor hypothesis. Recommend S2-Advisor.
- **A3 clears E1–E5 but FAILS E6** (advisor share too high) → **the standing finding holds**: local can't *independently* orchestrate; the quality came from the frontier it leaned on. **Stay S1-Hybrid.** (This is the expected first-pass outcome and a legitimate, money-clarifying result.)
- **A2 (agentic) remains worst / collapses** → re-confirms #40 (deterministic harness beats agentic specialist); agentic-mode is not the S2 path regardless.
- **All local arms fail E2 (collapse)** → standing finding fully confirmed; S2 blocked; way-forward = the T5 "context pre-digest" mini-project (generalize `rich-mellum-distill` into an orchestration-context digest) before re-testing.

**On fail → way-forward (per the plan's discipline):** Gate E failing **does NOT block S1** — it only blocks S2. Frontier stays the brain; S1-Hybrid (Gates A+B+C, already supported) is the steady state. The specific failing criterion names the next experiment: E2-collapse → context pre-digest; E6-overspend → tighten advisor-call policy (cheaper advisor model, fewer K, advise-only-on-verifier-fail); E3/E4 → a deterministic plan/route skeleton the brain fills rather than authors.

---

### 5. Executable plan (artifacts to build)

```bash
# 1. Task set + gold specs (free, local authoring)
scripts/gate-e-tasks.ts          # OrchTask[] : 20 tasks (D1–D4), each w/ deterministic scorer + gold sub-task set
scripts/gate-e-score.ts          # Tier-1 deterministic metrics (reuses frames-grade, citation-verifier, tsGate)

# 2. The four arms (A1/A2/A3 free on the box; A0 once, saved)
scripts/gate-e-bench.ts --arm a0 --save data/gate-e/   # Opus brain — RUN ONCE, reuse
scripts/gate-e-bench.ts --arm a1                        # local 80b + deterministic harness (free)
scripts/gate-e-bench.ts --arm a1 --brain gpt-oss-120b  # second local brain candidate (free)
scripts/gate-e-bench.ts --arm a2                        # Tongyi-style agentic (free; reuses runAgentResearch)
scripts/gate-e-bench.ts --arm a3 --advisor-k 3         # Advisor: local loop + bounded frontier advisor (meter spend)

# 3. Tier-2 blind judge on SAVED reports only (bounded OpenRouter spend)
tsx scripts/dr-judge-hybrid.ts --bundle data/gate-e/*.report.md   # Opus-sub + o4-mini, counterbalanced

# 4. Verdict
scripts/gate-e-verdict.ts        # applies E1–E6, emits PASS/FAIL per arm + recommendation
```

**Reuse, don't rebuild:** A0/A1 harness = `src/homeserver/deep-research.ts` + `orchestrate.ts` chunk-gate; A2 = `deep-research-agent.ts` `runAgentResearch` (native dialect, #46 auto-cite already landed); leaf substrate = `orchestrator.delegate()` + `m5-routing.json`; deterministic scorers = `frames-grade.ts`, `frames-evidence.ts`, `citation-verifier.ts`, `verifier.ts` (`tsGate`); judge = `dr-judge-hybrid.ts`. The **only genuinely new code** is the A3 advisor-call action + budget meter, the 20-task gold specs, and the verdict aggregator.

**Credit budget (check before running, per CLAUDE.md):** frontier inference = A0 once (~20 full pipelines) + A3 advisor calls (≤ K×20, metered) ; judge = ~160 calls (4×20×2). Estimate `(A0 depth) + (K×20) + 160` against the weekly cap and run A0 + A3 **first** while budget remains. A1/A2 are free — run them any time.

**Relevant files:** `docs/migration-go-no-go-plan.md` (T5/Gate E, S1/S2 framing), `docs/dr-ablation-findings-2026-06-22.md` (#40 Tongyi finding), `src/homeserver/orchestrator.ts` (leaf substrate), `src/homeserver/deep-research-agent.ts` (A2 agentic mode), `scripts/dr-ablation.ts` + `scripts/dr-judge-hybrid.ts` (A0/A1 distill arm + judge to clone), `docs/m5-routing.json` (routing table held constant).
