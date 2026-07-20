# Harvest-judge calibration HOLD/GO gate — 2026-07-20 (issue #6)

The 2026-07-06 calibration (`docs/harvest-judge-calibration-2026-07-06.md`) measured the harvest
judge against a 22-row, hand-authored synthetic control set. That is a real, useful safety check
(fail-safety, error rate, exact accuracy), but it is not what issue #6 asks for: a calibration
against a **representative, human-audited sample of real production traffic**, with confidence
intervals, explicit denominators, and a machine-readable decision that gates whether harvest
evidence may ever affect routing.

This note documents the harness that closes that gap, and — honestly — why its current output is
**HOLD**, not GO.

## What was built

| Module | Responsibility |
|---|---|
| `src/homeserver/calibration-policy.ts` | Content-addressed, versioned calibration policy (judge prompt/model/sampling/context/rubric + HOLD/GO thresholds). A policy change mints a new id; it never rewrites an old one. |
| `src/homeserver/calibration-sample.ts` | Stratified sample specification over content-blind ledger rows: task type × prompt-size bucket × model × verifier class × harness surface × pass/fail uncertainty. Deterministic seeded draw (no `Math.random`). |
| `src/homeserver/calibration-quality-receipts.ts` | Content-blind join to independent Hugin Quality Receipts (hugin#231) by opaque binding key. An unmatched row is honestly "unmatched," never treated as passing. |
| `src/homeserver/calibration-metrics.ts` | Precision/recall/disagreement per lane and per verifier class, with Wilson-score confidence intervals and explicit denominators. Format-only and unclassified verifier evidence is structurally excluded from gate-trusted evidence (`GroupMetrics.trustedForGate`). |
| `src/homeserver/calibration-gate.ts` | Pure HOLD/GO evaluation from measured metrics, plus `attachReviewedDecision` — the only way "enabled" is ever recorded, and only on a measured GO. |
| `scripts/harvest-judge-calibration-gate.ts` | CLI that wires the above against the real ledger (read-only) and an optional Quality Receipts export, and writes the decision artifact. |
| `src/homeserver/ledger.ts`'s `listCalibrationSampleRows` | New read-only, content-blind ledger reader (no prompt, prompt hash, prompt excerpt, or notes — see its doc comment) feeding the harness. |
| `src/homeserver/harvest.ts`'s `bandVerdictFromScore` | Recovers a `harvest-shadow` row's intended verdict from its numeric `score` column, content-blind — never parses the free-text `notes` field. |

## Design decisions worth flagging

- **Format-only evidence is untrusted by construction, not by convention.** `calibration-metrics.ts`'s
  `GroupMetrics.trustedForGate` is `true` only for `llm-judge` and an explicit `truth-oriented:*`
  allowlist (`tsGate`, `sqlExec` today). A `mechanical-format`-verified or `unclassified:*`-verified
  stratum is always reported (transparency) but can never itself satisfy the gate — even a perfect
  10/10 "precision" on a mechanical-format stratum stays untrusted. This is a deliberate, documented
  divergence from `verifier-classification.ts`'s `classifyVerifierKind`, whose *routing-weight*
  default treats an unrecognised verifier as `truth-oriented` (conservative for routing, but the
  wrong default for calibration trust). Nothing here changes routing — issue #6's explicit non-goal.
- **`byLane` is restricted to trusted-verifier-class rows.** A lane (chat/mcp-ask/delegate/...) mixes
  judge-graded and format-verified traffic; an earlier draft of this harness computed lane precision
  over ALL of a lane's rows and, separately, made every lane's `trustedForGate` permanently `false`
  by deriving it from a `null` `verifierClass` — a caught-in-dogfooding bug that made the per-lane
  gate check vacuous (see the regression tests in `tests/calibration-metrics.test.ts` and
  `tests/calibration-gate.test.ts`). Fixed: `byLane` and the long-context rollup both pre-filter to
  trusted rows before computing their own precision/recall, and `trustedForGate` is passed in
  explicitly rather than derived from a nullable field.
- **HOLD is the honest default, not a placeholder.** `evaluateCalibrationGate` can only ever compute
  GO from evidence that measurably clears every threshold — CI *lower* bound for precision/recall,
  CI *upper* bound for disagreement, `n >= minStratumN` — for every trusted lane, every trusted
  verifier class, and the long-context stratum. An empty trusted population, a tiny sample, or zero
  joined receipts all fail closed to HOLD with a specific reason, never a generic one.
- **Enabling is a separate, human act.** `attachReviewedDecision` is the only function that can ever
  populate `CalibrationGateDecision.enabling`, it refuses to run on a non-GO gate, and nothing in this
  repository calls it automatically. Flipping harvest's verdict-impacting behavior on is issue #7's
  job, and only from a GO this gate actually measured.

## Current verdict: **HOLD**

Running the harness for real today — `npx tsx scripts/harvest-judge-calibration-gate.ts` against the
live ledger, with no `--receipts` export supplied — reports `HOLD` with the reason
`"0 of N sampled rows joined to an independent Quality Receipt — insufficient audited sample"` (or,
against a fresh/empty ledger, `"no trusted truth-quality evidence sampled at all"`). That is expected,
not a bug: only a handful of real Hugin Quality Receipts exist from dogfooding today, issue #3
(durable accounting with trustworthy denominators) is not built, and this repository does not own —
and must not fabricate — the Hugin receipt export (see `docs/learning-task-contract.md`'s normative
ownership table). No committed "example" run is checked in here for that reason: a fabricated
receipts fixture dressed up as a real measurement would be exactly the overclaim this issue exists to
prevent. `tests/calibration-gate.test.ts` demonstrates both the HOLD path (seeded, near-empty and
tiny-sample scenarios) and that a large, well-labeled, mostly-correct seeded sample *can* reach GO —
proving the machinery works, without asserting it has ever measured real production traffic.

## What would move this to GO

1. **#3** (durable accounting with trustworthy denominators) landing, so the sampled population's
   denominators are themselves durable and auditable rather than whatever happens to be in the local
   ledger at CLI-run time.
2. **hugin#231** Quality Receipts accumulating past a handful of dogfooding examples — specifically,
   enough receipts landing on the exact strata this harness draws (including the long-context /
   starvation stratum) to clear `minStratumN` (default 30) per trusted lane and verifier class.
3. Running `scripts/harvest-judge-calibration-gate.ts --receipts <real Hugin export>` against that
   population and seeing every trusted group clear precision/recall/disagreement at the *conservative*
   confidence-interval bound.
4. Only then: a human reviewer calling `attachReviewedDecision` on that exact measured `GO` gate, and
   issue #7 wiring that reviewed decision into an actual routing change — never automatic, never from
   a HOLD.
