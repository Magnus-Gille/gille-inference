# Gate D Execution — Findings (2026-06-24)

**Status:** ✅ pi + aider arms COMPLETE on `qwen3-coder-next-80b` (×1 seed) — **pi 10/10, aider 6/10
→ Gate D PASSES on the pi arm.** Harness hardened (4 bugs fixed) + a production-resilience finding.
Companion to `docs/gate-de-evaluation-plan.md` (the A–E gate plan). Gate D = the deterministic
agentic-coding battery (`gate-d/`, 10 tasks, model-free grading): can an OSS harness drive a
**local** model to make a stub repo's committed oracle pass?

This run executes the **free local arms** against the live box's `qwen3-coder-next-80b`
(`inference.example.com/v1`): **A1** (aider, `--edit-format diff`), **A7** (pi, native tool-calling).
opencode (A5) and the gpt-oss arms (A3/A8) are deferred (see Follow-ups). The Claude baseline
(B0/B1 — the only frontier spend) is deferred.

## Execution environment

- Harnesses run on the **laptop** (`pi` 0.x, `aider` 0.86.2, `opencode` 1.3.13 all installed),
  pointed at the box's OpenAI-compatible gateway over HTTPS. The box's GPU is **serial**
  (admission maxParallel=1), so arms run **strictly sequentially** — never in parallel.
- Gateway key: a guest key minted on the box with high limits (`--rpm 600 --tpm 4000000
  --daily 0`) so rate-limiting can't confound results. Stored only in the session scratchpad.
- pi provider stanza added to `~/.pi/agent/models.json` (`inference-gille`); opencode `homebox`
  provider added to `~/.config/opencode/opencode.json`; aider config in `gate-d/aider-*`.

## Harness hardening — 4 bugs found by smoke-testing `run.sh` before the sweep

The battery's *grading* (`check.sh`) was already proven (`verify-fixtures.sh` 14/14). But `run.sh`
— the arm *driver* — had never been exercised against the box. Smoke-testing it surfaced four
bugs, all fixed (commit `f2fcc01` + follow-up); each is a real defect that would have silently
corrupted results:

1. **macOS `timeout` portability.** `run.sh` hard-coded GNU `timeout`, which doesn't exist on the
   laptop that actually runs the harnesses. Now resolves `timeout`||`gtimeout` (works on the box
   *and* the dev mac via `brew install coreutils`).

2. **Fixture corruption via git-root escape (the dangerous one).** Work dirs live under
   `gate-d/.work/` (inside this repo — required so `check.sh`'s `npx --no-install` resolves
   `node_modules` upward). With no local `.git`, aider/opencode/pi detect the **parent repo's**
   git root and apply edits to the **pristine seed** (`gate-d/tasks/<id>/repo/...`). Verified:
   aider rewrote task 01's seed `sum.ts` into the reference solution. Restored from git; fixed by
   giving each work dir its **own committed git root** (`git init` per run) — which both contains
   the arm to `$W` and gives aider the `HEAD` baseline it diffs against.

3. **Dropped result rows.** The JSONL writer interpolated the bash bareword `true`/`false` into
   the Python source → `NameError: name 'true'` → the result row was never written. Fixed by
   passing values via env vars (also injection-safe for `$task`).

4. **Dangling `--file`/`--read` flag.** For a task with an empty `read` list (task 05),
   `printf -- '--read %s ' $read` emitted a bare `--read`, which swallowed `--message` →
   aider 2 s `arm-error`. Fixed by guarding empty lists. (pi/opencode are unaffected — they don't
   take `--file`/`--read`.)

A `KEEP_WORK=1` debug mode was also added to `run.sh` to preserve work dirs + arm logs for
diagnosis (they're deleted by default).

## The degeneration incident — root cause + a production-resilience finding

After the harness was working (task 01 passed on both aider **and** pi), the sweep showed every
task **beyond 01** failing — aider with `G2-no-edit` (~230 s) or 600 s timeouts, pi with a 600 s
timeout. Rather than trust those numbers, a `KEEP_WORK` re-run captured the arm log: the box's
`qwen3-coder-next-80b` was emitting a **degenerate token loop — endless `?????`** instead of code
or tool calls. A minimal **direct curl** (prompt_tokens 36, real usage) reproduced it: 300
completion tokens of pure `?`. **mellum was fine** the entire time, so it was isolated to the 80b.

**Root cause:** the model file (48.5 GB, Jun 17) and llama.cpp (Jun 17) were unchanged, and the
Gate C soak ran 23,667 clean requests on this model the day before — so it was not a bad config or
a corrupt file. The journal showed `recovered from upstream disconnection during streaming` lines
coinciding exactly with **my own mid-stream kills** (`TaskStop`/gtimeout abruptly disconnecting
harness runs). Abruptly disconnecting mid-generation left the running llama-server process in a
degenerate state that **persisted across subsequent requests**. The timeline confirms it: task 01
passed (healthy 80b) at 15:08–15:09; the first kill was ~15:11; everything after was `?????`.

**Fix:** because llama-swap keeps a model resident, the corrupted *process* had to be replaced. A
`mellum` request swaps the 80b out; the next 80b request **fresh-loads** it. After the reload the
80b returned clean output, and a **clean pi/02 run then passed in 28 s with the 80b still healthy
afterward** — proving (a) the healthy model + harness works, and (b) **clean completions do NOT
corrupt it; only abrupt mid-stream disconnects do.**

**Two consequences:**
- **All "02+" results from the first sweep are invalid** — confounded by the degenerate model.
  Only `aider/01`, `pi/01`, `pi/02` (run on a healthy model) are kept. The battery was re-run
  clean.
- **Production-resilience finding (worth a fix):** an abrupt client disconnect mid-stream can put
  this box's 80b into a persistent degenerate state — which means **live friends hitting the 80b
  during such an event get `?????` until the model is reloaded.** This is a llama.cpp/llama-swap
  slot-recovery gap on this arch, independent of the eval. (See Follow-ups.)

## Clean-run methodology

The re-run is **corruption-safe**: arms run sequentially, are **never manually killed**, and after
any run that ends in `arm-error` (the gtimeout-kill class — the only corruption trigger) the sweep
**resets the model** (swap to mellum, warm a fresh 80b) before the next task. `CAP_S=360 s` bounds
aider's loop-on-failure while leaving ample headroom for success (the passing runs finish in
5–30 s). Grading remains 100% deterministic (`check.sh`, no model in the loop).

## Results

Clean run, `qwen3-coder-next-80b`, ×1 seed. Grading 100% deterministic (`check.sh`). All runs
completed cleanly (no timeouts → **0 model resets needed**); **all seeds verified intact** after;
the **80b was healthy before and after** the battery.

| task | aider (`diff`) | pi (native tools) |
|---|---|---|
| 01-make-failing-test-pass | PASS 5s | PASS 24s |
| 02-fix-bug-test-catches | G4-oracle 29s | PASS 28s |
| 03-impl-fn-across-2-files | PASS 18s | PASS 38s |
| 04-add-cli-flag | PASS 25s | PASS 48s |
| 05-tdd-write-test-then-impl | G3-tsc 15s | PASS 91s |
| 06-fix-off-by-one | PASS 17s | PASS 27s |
| 07-refactor-extract-fn | PASS 19s | PASS 35s |
| 08-add-validation-guard | G4-oracle 25s | PASS 25s |
| 09-rename-across-files | G5-structural 15s | PASS 42s |
| 10-fix-shared-util-regression | PASS 21s | PASS 93s |
| **completion** | **6/10** | **10/10** |

- **pi (A7) — 10/10.** The minimal native-tool-calling harness drives the box's local 80b to
  complete **every** task, including the Hard cross-file rename (09) and the shared-util
  regression (10). pi's read→think→edit→bash loop lets the model run the oracle, see the failure,
  and iterate to correctness. This reproduces (and exceeds) the project's prior-best "pi 5-6/6".
- **aider (A1) — 6/10.** Its 4 misses are **genuine capability errors, not harness failures**:
  wrong fix (02, 08 → `G4-oracle`), code that doesn't typecheck (05 → `G3-tsc`), and an incomplete
  rename (09 → `G5-structural`). All four are **fast (15–29 s) single-shot attempts** — aider's
  SEARCH/REPLACE format applied fine on the healthy model; the model simply got the logic wrong
  with no oracle-feedback loop to recover. (Contrast the discarded corrupted-model run, where the
  *same* tasks all showed `no-edit`/timeout — that was the `?????` degeneration, not aider.)
- **pi solved all four tasks aider missed** (02, 05, 08, 09) — the difference is the agentic
  loop: pi can run the oracle and self-correct; aider-`diff` here was effectively one-shot.

## Verdict vs T6

T6 PASS = best-local `C ≥ 0.80 × C(B0)` **and** degenerate-rate `D ≤ 0.05` **and** no task class
0/3 across seeds.

- **Completion:** pi `C = 1.0` (10/10). The Claude-Code baseline B0 is not yet run (deferred
  frontier spend) — but since `C(B0) ≤ 1.0`, the relative bar `0.80 × C(B0) ≤ 0.80 < 1.0`, so
  **pi clears the 80%-of-baseline threshold for *any* plausible B0.** The ceiling result makes B0
  moot for the pass/fail decision (B0 is still worth running to size the *margin*).
- **Degenerate rate:** `D = 0` in the clean run (≤ 0.05). ✔ — with the explicit caveat that the
  `?????` degeneration is **disconnect-induced** (a box-resilience issue), not intrinsic to the
  model on these tasks.
- **No zero-class:** pi 10/10 → no zero-class. ✔ (This is ×1 seed; the literal "0/3" form of the
  criterion needs the ×3 seed expansion — see Follow-ups.)

**→ Gate D PASSES on the pi arm.** A local model (`qwen3-coder-next-80b`) under a minimal OSS
harness completes the full deterministic agentic-coding battery — the S2 "local-as-hands" leaf
capability the migration plan needs. aider is a **viable-but-weaker** second harness (6/10),
limited here by the lack of an auto-test feedback loop rather than by edit-format adherence.

**Caveats:** ×1 seed (the plan wants ×3 to expose the non-determinism tail — temp is non-zero on
the box); B0/B1 not run (relative bar cleared regardless by pi's ceiling); opencode (A5) +
gpt-oss arms (A3/A8) deferred.

## Follow-ups

- **opencode (A5):** its first run opened a stream, waited 125 s, then errored. The `homebox`
  provider loads fine ("using bundled provider") — the issue is opencode injecting its **full**
  plugin/skill/permission context (huge) into the prompt, overwhelming the local 80b. Retry with
  `opencode run --pure` (drops external plugins) to slim the context. NOTE: opencode also fires a
  *title* stream concurrently with the *build* stream — two concurrent requests to the serial GPU,
  an additional corruption risk; isolate carefully.
- **gpt-oss arms (A3 aider, A8 pi):** test the second model; expect confabulation/under-edit
  (A3) and tool-call-serialization failure (A8) per the plan's research.
- **aider `--edit-format whole` (A2):** if aider-`diff` shows apply-reject failures on the
  healthy model, the more forgiving `whole` format is the documented mitigation.
- **Claude baseline (B0/B1):** the denominator for the 80% relative T6 threshold — the only
  frontier spend; run once, save transcripts.
- **Box resilience:** investigate hardening llama.cpp/llama-swap against mid-stream-disconnect
  degeneration (affects production, not just the eval).
