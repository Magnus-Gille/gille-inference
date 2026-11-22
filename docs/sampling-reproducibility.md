# Sampling reproducibility: effective temperature and seed

Status: accepted (2026-11-22). Scope: LM Studio / llama.cpp client, Ollama client, OpenRouter
client, the batch runner (`npm run run:eval`), the probe runner used by `scripts/evaluate-model.ts`,
and the `/delegate` ledger.

## Problem

`runLmStudioInference` rewrote any requested `temperature <= 0` to `0.6` and sent no seed. Every
caller asked for temperature 0, so runs described as "temperature 0" actually ran unseeded at 0.6.
Nothing in a result row said so. Two runs of the same configuration therefore differed, and the
records claimed a sampling setting that was never used.

Related, but not bugs: VibeThinker deliberately runs at temperature 1 (`sampling-profile.ts`), and
the Strix harness already pins `temperature 0, seed 1`.

## Decision

1. **Keep the 0.6 floor as the default, but make it explicit.** `InferenceOptions.temperatureFloor`
   (default `0.6`, `false` = send literal 0). The LM Studio client logs once per model when the floor
   changes a request.
2. **Return what was sent.** Every client result carries `sampling: EffectiveSampling`
   (`requestedTemperature`, `temperature`, `temperatureFloorApplied`, `seed`, `topP`, `topK`, `minP`;
   `src/runner/sampling.ts`), on success and on failure.
3. **Explicit seed everywhere.** `InferenceOptions.seed`, `/delegate` body `seed`, `Probe.seed`,
   `RunProbesOpts.seed`. Forwarded as `seed` (OpenAI-compatible, llama.cpp) or `options.seed`
   (Ollama).
4. **Seed policy per surface.**
   - Batch runner: seed `1` by default (`--seed <n>` / `--seed none`).
   - Model evaluation: `EVAL_MODEL_SEED`, default `1`; repeat *r* uses `seed + r - 1`.
   - `/delegate`: no default seed. With an explicit seed, the single #164 format retry uses `seed + 1`.
5. **Store it.**
   - `runs`: `requested_temperature`, `effective_temperature`, `seed`, `sampling_json`.
   - `delegations`: `effective_sampling_json`.
   - Probe results: `sampling` per result. Model-registry `evalServingConfig`: `seed` and the
     model-aware `sampling` profile. An exact retry must match the seed as well.
   - Rows written before this change keep NULL / absent values. NULL means *unknown*, not
     "temperature 0".

## Why, and why not the alternatives

- **Why not remove the floor?** Greedy decoding sends some reasoning/MoE models (Mellum2,
  qwen35-a3b) into repetition loops that run to the token cap. Production delegation evidence was
  gathered with the floor on. Removing it silently would be the same bug in the other direction: a
  sampling change nobody recorded. Callers that want greedy decoding now say so (`temperatureFloor:
  false`, `--no-temperature-floor`), and the result records it.
- **Why not raise every request to 0.6 in the caller instead?** The floor has to be applied where
  the request is sent, so it holds for every caller. Having the client report what it sent covers
  every caller without duplicating the rule.
- **Why a seed instead of temperature 0 for reproducibility?** Temperature 0.6 with a fixed seed is
  reproducible on the same build, hardware and batch configuration, and it avoids the degenerate
  loops. True greedy decoding stays available. Neither gives bit-exact results across llama.cpp
  builds or different batch sizes, so `configEpoch` and the served provenance still matter.
- **Why no default seed on `/delegate`?** The #164 retry depends on an identical request being able
  to produce a different sample. A fixed default seed would make that retry pointless. Production
  rows record `seed: null` honestly.
- **Why does an explicit-seed retry use `seed + 1`?** It is still reproducible, and it keeps the
  retry's purpose. The ledger records the seed that produced the stored result.
- **Why default seed 1 for eval runners?** It matches the Strix harness. The evals hub policy is
  one trial by default, with extra trials only near a decision, and those trials must vary the seed
  or the prompt explicitly. Repeats in `evaluate-model` get `seed + r - 1` automatically. A batch
  rerun needs a new batch id and `--seed`.
- **Why not change `evidenceIdentity.sampling`?** That field mirrors the admitted Hugin stamp, and
  the ledger fails closed when the two differ. The effective sampling goes in its own column so the
  admission invariant is unchanged.

## Not changed here

- The Orin (Jetson Ollama) path sends no seed and returns no `sampling`. Its rows record NULL.
- The shadow lane, disagreement-gate secondary and review-cascade calls get the floor reporting
  through the client but do not yet store it on their rows.
