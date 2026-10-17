# M3 qualification decision — 2026-09-08

**Decision: HOLD (analysis-only).** This is the current decision record for [#286](https://github.com/Magnus-Gille/gille-inference/issues/286), reviewed against source SHA `0e6922dd585428d29b489ba59014de19d72846ee`. No fresh candidate-bound evidence bundle is available and the trial has not started. This document is not a deployed inventory or a qualification receipt.

All live node, model, lane, artifact, and runtime identities are unknown. The observation window, opportunity and attempt counts, useful/feedback counts, quality, error, latency, busy, calibration, safety, and cost measurements are unknown. Therefore `selectedCandidate` is `null`, `enablingDecision` is `null`, and the analysis verdict remains `HOLD`.

## Current candidate decision matrix

These are source-defined task/verifier shapes only. They do not assert that a node, model, artifact, runtime, or lane is deployed or ready.

| Task and verifier | Current assessment | Basis |
| --- | --- | --- |
| `extract` + `answerIs` | **REJECTED** | `answerIs` is classified as `mechanical-format`; M3 requires a truth-oriented verifier. See the [probe definition](../src/homeserver/probes.ts#L254) and [verifier classification](../src/homeserver/verifier-classification.ts#L204). |
| `code-implement` + `tsGate` | **HOLD / unqualified** | This is a source-defined truth-oriented shape, but all live evidence and identity bindings are unknown. See the [probe definition](../src/homeserver/probes.ts#L422). |
| `sql` + `sqlExec` | **HOLD / unqualified** | This is a source-defined truth-oriented shape, but all live evidence and identity bindings are unknown. See the [probe definition](../src/homeserver/probes.ts#L646). |

## Why this remains HOLD

- No reviewed numeric production thresholds are supplied. M3 treats thresholds as input evidence and does not invent production defaults; missing numeric thresholds hold the decision. See the [qualification contract](m3-qualification.md) and the [threshold checks](../src/homeserver/m3-qualification.ts#L40).
- The current evidence path has no candidate identity binding, and no fresh candidate-bound bundle is supplied. A snapshot digest may be present, but it does not bind candidate identity by itself. That is a **collector gap**, not evidence that a candidate is deployed or measured. See the [qualification contract](m3-qualification.md).
- M2 remains incomplete and M3 remains shadow. Test fixtures and the runnable example are readiness illustrations, not permission or production evidence. See the [qualification contract](m3-qualification.md) and [test fixture](../tests/homeserver-m3-qualification.test.ts).

**Smallest next step:** Specify and review numeric production thresholds, then collect a future candidate-bound observation carrying the required identity bindings before rerunning the offline report. The source-only examples above remain illustrative and are not a production candidate inventory.

## Compatibility references

The current task taxonomy is defined in the [taxonomy](../src/homeserver/taxonomy.ts#L29); canonical identity normalization is in [task-type identity](../src/homeserver/task-type-identity.ts#L33). Verifier trust and kind semantics are in [verifier classification](../src/homeserver/verifier-classification.ts#L142) and [kind classification](../src/homeserver/verifier-classification.ts#L231), with policy use in [config](../src/homeserver/config.ts#L145) and [delegate policy](../src/homeserver/delegate-policy.ts#L176). The canonical harvest policy stamp is generated as `ctx-tools-parts-v1|ctx=<effectiveContextChars>` in [harvest](../src/homeserver/harvest.ts#L630).

The offline report can be run with:

```bash
npx tsx scripts/qualify-m3.ts --input ./qualification-input.json
```

See the [M3 qualification contract](m3-qualification.md) for the evaluator and report contract. Related issue trail: [#85](https://github.com/Magnus-Gille/gille-inference/issues/85), [#287](https://github.com/Magnus-Gille/gille-inference/issues/287), [#245](https://github.com/Magnus-Gille/gille-inference/issues/245), [#82](https://github.com/Magnus-Gille/gille-inference/issues/82), and [#293](https://github.com/Magnus-Gille/gille-inference/issues/293).
