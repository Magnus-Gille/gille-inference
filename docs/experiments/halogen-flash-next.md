# Halogen Flash Next qualification (#317)

Status: **unqualified candidate**. Nothing in these files advertises a production model or
changes a roster. The owner has requested implementation through production readiness; each
qualification gate and the exact operations approvals still apply.

## Immutable candidate

`deploy/halogen-candidate.json` pins the public model repository revision, all eight required
files (checkpoint, quality overlay, tokenizer), container digest, and documentation revision.
The model payload totals 126,663,462,884 bytes. `scripts/stage-halogen.py` defaults to a read-only
plan. Its explicit `--download` action writes only a private revision directory, serializes
stagers, retains interrupted partials, and refuses certification until every file matches its
size and SHA-256. A corrupt final artifact is an error, never silently replaced.

```bash
python3 scripts/stage-halogen.py --manifest deploy/halogen-candidate.json \
  --directory /absolute/operator-selected/staging
node --import tsx scripts/print-halogen-profile.ts
```

Download execution requires the selected target and command to be previewed. Bound the process
externally and retain its receipt privately. Image retrieval is a separate pinned dependency
installation; this script does not execute the container, load a model, or mutate services.

## Initial experiment profile

`src/homeserver/halogen-profile.ts` binds the candidate identity and explicit request settings:
32K context, 16K total output allowance, one slot, one-context KV pool, no automatic fit-down,
16K prefill chunks, cache mode 1, MTP, sampled thinking at temperature 1/top-p .95/top-k 20,
min-p and presence penalty zero, xhigh effort, preserved thinking. Prompt lookup is off for
this sampled profile. Experimental composable context is off. The quality overlay is explicit.

A profile hash changes with context/cache settings; changing the profile during a scored run
requires a new identity. `halogenRequest` makes request settings explicit rather than trusting
server defaults. It is not yet integrated into production clients or automatic routing.

The output allowance includes reasoning. The historical Pi catalogue's 2K setting is not proof
of the actual old request budget. Do not claim that increasing it fixes the prior failures until
request/response evidence and completed-work checks demonstrate that.

## Synthetic compatibility gate

`scripts/qualify-halogen.py` is designed to execute inside the isolated candidate container,
using loopback only. It verifies the expected model and matching API/engine version, then checks
four conversation shapes and an actual function-call/result roundtrip. Its small deterministic,
non-thinking requests are deliberately a distinct synthetic profile; they are not scored as
agent quality. Evidence records request/response hashes and numeric usage, not text.

Run with the accepted runner commit and pilot profile hash under the approved evaluation
supervisor. Its success means **synthetic compatibility only**. Streaming/cancellation,
resource restoration, and actual agent usefulness require additional gates before promotion.

## Required runtime containment and restoration

Before any model load, prepare an exact private controlled-evaluation packet under AGENTS.md.
It must bind image/model/launcher/release identity, host and isolated paths, unit/network/container
names, resource/time/count ceilings, admission/maintenance and the durable GPU lease,
prior-resident set, cleanup, restoration and protected-service/OOM checks.

The initial runtime must have no external egress and no credential or owner-data mounts. Only
verified weights/tokenizer may be mounted read-only. Keep both engine and API inaccessible to
normal callers. A no-network container plus `podman exec` is sufficient for the first synthetic
gate; any later relay must retain an explicit route allow-list and a per-run capability.
No `--privileged`, arbitrary host mounts, kernel/driver/IOMMU/power changes, or relaxed memory
limits are authorized by these files. Preserve the production 96 GiB/no-swap ceiling unless a
separate approved decision changes it. Do not run a competing resident model.

A failure that touches restoration, OOM, or protected services ends the approved envelope.
Retain evidence; do not promote or repeat under weakened limits.

## Agent pilot and production decision

After compatibility and resource checks, run three preregistered semantic tasks, three repeats
each, using OS-confined model execution and verifiers. Include a multi-file change and sustained
tool history; isolate hidden oracles until the agent exits. Preregister a 45-minute ceiling and
report completed work at ten minutes separately. Record exact effective requests, context,
reasoning/truncation, first edit, pass/fail, scope violations, timings, and cleanup.

The evidence summarizer in `halogen-evidence.ts` is a structural/semantic-result aggregator,
not a trusted behavioral judge or production promoter. A supplied pass flag alone never qualifies
a row. Its pilot-qualified result is only an input to review, not automatic serving authority.

Only after evidence supports a useful profile should the production PR extend the manual
promotion transaction for this runtime, update portal/README and model/output limits, validate
caller access, and run an approved exact-SHA deployment. Keep explicit model availability
separate from automatic route selection. Green CI tests code; it cannot prove the model loaded,
completed a task, or was deployed.

## Sources and limits

- [Issue #317](https://github.com/Magnus-Gille/gille-inference/issues/317) contains the detailed
  study, historical evidence, external comparison and acceptance criteria.
- [Donato's video](https://www.youtube.com/watch?v=Nm_zN6RQ_eE) and
  [committed task results](https://kyuz0.github.io/terminal-bench-mini/) motivate the experiment.
- [Pinned Halogen documentation](https://github.com/peonist-ai/halogen-flash-server/tree/b9870bb5a3cd3c14ef1891c9cecbffa1225dab61)
  describes the runtime; verify actual image behavior rather than extrapolating version claims.

Public evidence contains reusable contracts and sanitized measurements. Exact live-state,
maintenance and durable operator tracking belongs in the private operations repository.
