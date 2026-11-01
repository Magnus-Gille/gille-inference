# Decision choice limits

Source inspection on 2026-11-01 distinguishes upstream serving support from the gateway's
configured API bounds and production qualification. A question's option count is separate
from the request's maximum of 16 questions.

| Model | Pinned upstream serving ceiling | Gateway in this change | Production qualification for 31 options |
| --- | --- | --- | --- |
| Bespoke Nimble 9B | 255 | 2–255 | Not measured |
| Clef Flash | 255 | 2–255 | Not measured |
| Perplexity Decider 27B | 255 | 2–255 | Not measured |

The pre-change gateway ceiling was 26 for all three models. The new configured limits follow each
model's pinned source-enforced ceiling. Unknown future model IDs retain the gateway's legacy
26-option maximum. No seven-option limit was found in these source contracts; the origin of the
reported seven-option restriction remains unknown.

## Pinned primary sources

- **Nimble:** revision `bd792f44ec8e265be861bfcdf4e05967ffe0e858`,
  [serving_schema.py](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B/blob/bd792f44ec8e265be861bfcdf4e05967ffe0e858/serving_schema.py)
  sets `MAX_CHOICES = 255`. Above 26 choices it uses
  [extended_schema.py](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B/blob/bd792f44ec8e265be861bfcdf4e05967ffe0e858/extended_schema.py).
  [inference.py](https://huggingface.co/bespokelabs/Bespoke-Nimble-9B/blob/bd792f44ec8e265be861bfcdf4e05967ffe0e858/inference.py)
  validates the extended codebook and token IDs at startup. This is the repository's existing
  model pin; this change does not update weights, the adapter, or runtime configuration.
- **Clef:** the configured GGUF revision is
  `4a192915ef971886004b5b13294f2b4c7a7fc39d`. Its configured llama.cpp v0.6.0 runtime resolves to
  `d81235049384534c167caea52b85a694f6103d14`.
  [server-decision.cpp](https://github.com/ggml-org/llama.cpp/blob/d81235049384534c167caea52b85a694f6103d14/tools/server/server-decision.cpp)
  assigns Clef a 255-option maximum and rejects requests above it.
- **Decider:** the [release at revision
  5117a6c7fe73b19308dc1a6b0fb529a40c2ecad4](https://huggingface.co/perplexity-ai/pplx-decider-v1-27b/commit/5117a6c7fe73b19308dc1a6b0fb529a40c2ecad4)
  contains `source/src/autojev/model.py`, which sets `MAX_OPTIONS = 255`, validates option
  counts and single-token codes, and uses a 255-output readout. Its `server.py` also caps criteria
  at 255.

These are source-enforced ceilings, not evidence of decision quality, active runtime versions,
or production availability. Regression tests validate all three named model contracts at 26, 27,
31 and 255 options, rejection at 256, and complete synthetic 31-option probability distributions.
The Nimble adapter translation test also verifies all 255 option IDs and descriptions survive
schema conversion. These tests do not run model inference. Existing body, token, quota and question
limits still apply; a large option list can exhaust the complete-prompt token allowance.
