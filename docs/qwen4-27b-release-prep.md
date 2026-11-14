# Qwen 4 27B release-day checklist (pre-release preparation)

Status: preparation only. Nothing here is a release decision, a live roster entry, or evidence
about Qwen 4. The model is not public at the time of writing; names below marked *expected* must be
replaced with the official values. The precedent is
[`qwen38-27b-release-decision-2026-08-14.md`](./qwen38-27b-release-decision-2026-08-14.md).

Production steps (download to the M5, maintenance window, roster change, gateway deploy) each need
the owner's explicit confirmation under the global and repository authority rules. Exact operator
paths, backups, and canary transcripts go in the private Grimnir operations tracker, not here.

## 1. Detect and archive the release (metadata only)

```bash
npx tsx scripts/ingest-model-release.ts --model Qwen/<official-repo-name>
```

Exit 3 with `"status":"unavailable"` means not public yet. On success, read the archived
`REPORT.md`: immutable revision, `architectures`, parameter count, native MTP, multimodal parts,
context, and license.

## 2. Add the architecture family (code change, if new)

If `architectures` is not already in `FAMILIES` in
[`model-runtime-compatibility.ts`](../src/homeserver/model-runtime-compatibility.ts), add one
family entry from the official `config.json` and a pinned llama.cpp commit that supports it. Then
prove source-level support:

```bash
npx tsx scripts/check-model-runtime-compatibility.ts --release-json <archive>/release.json \
  --llama-dir <pinned llama.cpp checkout> --runtime-revision <40-char sha> --out-dir <dir>
```

A newer llama.cpp revision also means a new relocatable runtime bundle (origin-relative runpath,
checksums, `readelf -d`/`ldd` with nothing resolving through `scratch`); see
[`deploy/README.md`](../deploy/README.md#deploying-llama-swap-roster-changes).

### Runtime candidate (noted 2026-11-13, not a pin)

Start the runtime search at llama.cpp
[`v1.0.0`](https://github.com/ggml-org/llama.cpp/releases/tag/v1.0.0), commit
`b1b770d90d94cad9e9ea5b993bdbc383a522fb28`. Use a later commit instead if the official
architecture is not supported there. The version number marks C API versioning for libllama and
ggml; there is no release branch, so treat it like any other pinned commit.

- The Qwen3.8 runtime pin `9b05354ec6fb58b4e665e9a39ebc40285c015638` has no Qwen 4 architecture
  and is 1,926 commits behind this candidate. The candidate contains `qwen4exp`, which upstream
  added for a different model. Whether Qwen 4 27B uses it is unknown: do not add a family entry
  from this note.
- Evidence so far is a read of the upstream v0.9.0 to v1.0.0 release notes and one checker run on
  2026-11-13: `check-model-runtime-compatibility.ts` reports PASS for `Qwen/Qwen3.8-27B` at this
  commit. The run used Hub revision `37561816e66b5b9153b1b64c10968c18c1e6f4a0`, whose
  `config.json` is identical to the reviewed revision's. That proves source-level wiring for
  `Qwen3_5ForConditionalGeneration` only; the MoE family was not run. Nothing was built and
  nothing was measured on the M5.

Re-validate before relying on it (upstream llama.cpp pull request numbers):

- Native MTP: 32078 removes the non-fused GDN paths; 31660 and 31927 change MTP state handling.
  Repeat the MTP acceptance and parity checks instead of carrying over the Qwen3.8 results.
- Images: private media URLs now need `--media-allow-private-urls` (32115). Confirm how the image
  canary reaches the server before choosing flags.
- Build: the web UI takes brand assets from a GitHub tarball (32112). Confirm that
  `-DLLAMA_BUILD_UI=OFF -DLLAMA_USE_PREBUILT_UI=OFF` still fetches nothing.
- Q8 KV on Vulkan: upstream work (31526, 30487) may supersede the isolated backport in
  [`strix-kv-dequant-candidate-2026-08-15.md`](./strix-kv-dequant-candidate-2026-08-15.md).
  Compare the two before carrying the backport forward.

## 3. Stage weights (M5, owner-confirmed download)

```bash
npx tsx scripts/stage-model-release.ts --model Qwen/<official-repo-name> --revision <sha> \
  --out-root <operator model staging root>
```

## 4. Convert and quantize (M5, CPU-only)

```bash
npx tsx scripts/convert-model-release.ts --staged-dir <staged revision dir> \
  --llama-dir <pinned llama.cpp checkout> --out-dir <operator dir> --name Qwen4-27B \
  --quant Q4_K_M,Q8_0 --mmproj --dry-run
```

Drop `--dry-run` to execute. Omit `--mmproj` for a text-only release. Keep the resulting
`conversion-manifest.json` hashes for the spec and decision record. Before relying on Q4_K_M, repeat
the deterministic parity check from the Qwen3.8 record (reference vs BF16 vs Q4_K_M final text).
The run takes an output-folder lock, publishes only after every step succeeds (so a failed run can
simply be rerun), and requires a clean pinned llama.cpp checkout plus the staging manifest. A run
killed by a signal or host loss leaves `.conversion.lock` and a large `.conversion-run-*` directory
behind. To recover: confirm the PID recorded in the lock is gone and that no converter or quantizer
from that run is still running (`pgrep -f convert_hf_to_gguf.py`, `pgrep -x llama-quantize`; a
killed parent does not stop its children). Then remove only the files listed under
`plannedOutputs` in the lock (never other `.gguf` files in the folder), the run directory, and the
lock, and rerun.
Staged files are checked against `stage-manifest.json` by size; add `--verify-hashes` for a full
SHA-256 re-check. Tool identity is re-checked before publishing, so a llama.cpp checkout or binary
changed mid-run fails the run instead of being recorded.

## 5. Smoke test (maintenance window, no roster change)

```bash
npx tsx scripts/evaluate-model.ts --evaluation-id manual-eval-qwen4-27b-<yyyymmdd>-01 \
  --model-id Qwen/<official-repo-name> --gguf <models-dir>/qwen4-27b/Qwen4-27B-Q4_K_M.gguf \
  --quant Q4_K_M --dry-run
```

Then the real run per [`model-evaluation-runbook.md`](./model-evaluation-runbook.md). Also run one
short release canary of the exact serving profile (text, thinking off per request, image if
multimodal, MTP acceptance) under the GPU lease.

## 6. Customer release

1. Fill in [`deploy/specs/qwen4-27b.yaml`](../deploy/specs/qwen4-27b.yaml): key, paths, hashes, and
   any settings the canary changed. Write a short decision record next to the Qwen3.8 one.
2. Add the served ID where it is hand-maintained (`rg -n '"qwen38-27b"' src/homeserver`):
   `MODEL_META` and `MODEL_FAMILY` in `routing-table-generator.ts`, `MODEL_IDS` in
   `execution-feedback-report.ts`, and `KNOWN_MODEL_IDS` in `adoption-evidence-bundle.ts`.
3. Update `src/homeserver/portal.html` ("What's running", "How to use it") and
   `src/homeserver/README.md` in the same change.
4. Owner-confirmed roster transaction:
   `tsx scripts/promote-manual.ts --key qwen4-27b --spec <reviewed private spec> --dry-run`, then
   without `--dry-run` with `PROMOTE_MAX_SERVED` set to the current roster size plus one.
5. Owner-confirmed gateway deploy with `scripts/deploy-gateway.sh deploy <accepted-full-sha>`, then
   authenticated private and public edge canaries against the new ID and a tested rollback.

A roster addition is explicit use only. Automatic routing still needs task evidence.
