# Hugin role validation — timed deprecation trial

**Status:** governing trial

**Window:** 2026-07-11 through 2026-08-22

## Decision under test

The architecture gives Hugin a coherent role: secure, durable intake and macro-routing for bounded
work that should decouple from or outlive the initiating L1 interaction. Architecture alone does
not prove sufficient demand to justify the implementation and maintenance surface.

During this trial, Hugin is provisionally a **durable supervisor**, not a second general-purpose
Conductor. Feature expansion is frozen except for reliability or security fixes on exercised paths.
The internal mini-Conductor is on a deletion clock.

This decision incorporates the 2026-07-11 design review. The private discussion transcript is not
part of this repository; this document is the complete public decision record.

## Counted task

A counted task must:

- be non-probe and non-smoke-test work;
- produce a useful project, client, research, maintenance, or operational outcome;
- be submitted because it should outlive or decouple from its originating interaction; and
- use Hugin's existing task/lifecycle role rather than workload manufactured to raise the count.

Hugin validation, deployment smoke tests, Hugin's own daily analysis, and ordinary direct M5
inference do not count.

## Trial rules

- Add one concise L1 handoff rule describing when to use the existing Hugin interface; do not invent
  a new protocol for the trial.
- Freeze new providers, runtimes, routing sophistication, and widened task authority.
- Permit reliability/security fixes on paths exercised by real qualifying work.
- Label internal orchestration and savings figures experimental.
- Retain raw telemetry needed to evaluate the hypothesis, but make no ROI claim.
- Do not force interactive work through Hugin; revealed demand must be real.

## Outcomes on 2026-08-22

### Keep the secure-supervisor core only if all hold

- At least 10 substantive tasks.
- At least two independent producers or recurring workflows.
- At least 70% useful completion without synchronous human rescue.
- At least five jobs complete after the originating L1 session closes.
- Zero lost/duplicated tasks and zero security-boundary failures.
- Under two hours of operator maintenance during the window, excluding final evaluation.

### Reduce to Ratatoskr/schedules only

Three to nine substantive tasks, or 40–70% useful completion, with at least one recurring durable
producer.

### Remove and replace

- Fewer than three substantive tasks; or
- no recurring producer; or
- maintenance burden outweighs successful substantive work; or
- a simpler vendor-native or scripted path preserves the actually required privacy and durability
  properties.

### Delete the internal mini-Conductor unless

It records at least five substantive uses and demonstrates at least one:

- at least 50% lower measured frontier cost at comparable usefulness on matched work;
- successful work during an availability gap where L1 could not continue; or
- a repeatable bounded-fanout workflow with at least 70% useful completion and less human
  intervention than L1-managed fanout.

## Evidence to record

For each counted task:

- producer/workflow;
- why durability or macro-routing mattered;
- task class and sensitivity policy;
- actual node/provider/model/harness;
- whether the originating L1 session was still open at completion;
- useful completion and required human rescue;
- retries, duplicate/lost-work incidents, and policy failures;
- operator maintenance attributable to Hugin;
- measured cost where a matched baseline exists.

This is Hugin product evidence, not the M5 model-capability ledger. Model/task/verifier capability
continues to belong to the gateway ledger.
