# Incumbent model audit — runbook (issue #11)

This is a separate, advisory lane for models that are already served. Weekly Model Scout remains
candidate discovery only. An incumbent audit never loads, unloads, adopts, culls, or edits a route.

Run it when the probe corpus/version, a route role, observed artifact/configuration, or the
evidence-age policy changes. The operator owns the decision and must review the append-only JSONL
record before proposing keep/standby/cull through the existing reviewed routing lifecycle.

On M5, use the shared GPU lease and a bounded audit of a model that is already `ready`; it will
refuse to invent evidence for an unloaded/unobservable model:

```bash
npx tsx src/homeserver/cli.ts gpu run --model <served-model> --eta 30m --purpose incumbent-audit -- \
  npx tsx scripts/incumbent-model-audit.ts --model <served-model> --trigger evidence-age
```

The runner appends `data/incumbent-audits.jsonl`. Each row is source-attributed as
`live-served-model` and retains the exact observed llama-swap command, its artifact/configuration
identity, probe/corpus version, per-probe verifier/HTTP errors, finish reasons, empty/truncated
output signals, latency, and outcome. If `/running` does not observe the model, it appends an
explicit `unavailable` reason and sends no probe.

Use gateway authentication through the configured environment only (for example, a dedicated
least-privilege audit key); never put a key in the command, registry, or Git. Schedule only after
an owner chooses an evidence-age cadence. The GPU lease serializes cooperating heavy jobs; it does
not replace the gateway's production admission controls. Run off-peak and use maintenance mode
when local contention needs to be declared to guests.

Stale or configuration-mismatched evidence is not inherited: the record's observed identity is a
new evidence boundary. Route generation must treat a missing, unavailable, or mismatched current
identity as a reason to escalate/hold rather than silently reuse the old bucket. A human-reviewed
proposal may subsequently use the routing lifecycle; this lane itself cannot mutate it.
