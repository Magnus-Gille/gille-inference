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
