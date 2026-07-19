/**
 * TDD suite for routing-table-generator.ts — the WRITER for docs/m5-routing.json.
 *
 * Written BEFORE the implementation (red→green). Issue #145: the routing table had readers
 * (routing-table.ts) but no writers — it was a hand-edited snapshot. This generator emits the
 * table from the evidence the system already collects (ledger verdicts + cartography runs +
 * model-scout registry), with a freshness stamp and a source manifest.
 *
 * The loader (routing-table.ts) is the CONTRACT: whatever this generator emits MUST be consumable
 * by loadRoutingTable()/routingTarget(). The round-trip test below pins that seam.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateRoutingTable,
  summarizeEvidence,
  MODEL_META,
  EXCLUDED_FROM_ROUTING,
  type GenerateInputs,
} from "../src/homeserver/routing-table-generator.js";
import type { LedgerReportRow } from "../src/homeserver/ledger.js";
import {
  loadRoutingTable,
  routingTarget,
  FRONTIER,
  UNKNOWN_ROUTE,
} from "../src/homeserver/routing-table.js";

// ── Test helpers ────────────────────────────────────────────────────────────────

type Recommendation = LedgerReportRow["recommendation"];

/** Build a synthetic ledgerReport() row. */
function row(
  taskType: string,
  modelId: string,
  opts: {
    successRate: number;
    attempts: number;
    recommendation: Recommendation;
    avgTokPerSec?: number | null;
    verdict?: LedgerReportRow["verdict"];
    frozen?: boolean;
  }
): LedgerReportRow {
  const passes = Math.round(opts.successRate * opts.attempts);
  return {
    taskType,
    modelId,
    verdict: opts.verdict ?? (opts.successRate >= 0.7 ? "viable" : opts.successRate >= 0.4 ? "marginal" : "not_viable"),
    attempts: opts.attempts,
    passes,
    partials: 0,
    fails: opts.attempts - passes,
    errors: 0,
    successRate: opts.successRate,
    frozen: opts.frozen ?? true,
    recommendation: opts.recommendation,
    avgLatencyMs: 100,
    avgTokPerSec: opts.avgTokPerSec ?? null,
  };
}

function baseInputs(verdicts: LedgerReportRow[]): GenerateInputs {
  return {
    verdicts,
    registry: [],
    sources: [],
    generatedAt: "2026-07-04T00:00:00.000Z",
    policy: { minSamples: 3 },
  };
}

// ── Selection ───────────────────────────────────────────────────────────────────

describe("generateRoutingTable — per-task-type selection", () => {
  it("routes a task type to its viable model (delegate-local)", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("classify", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 200 }),
      ])
    );
    expect(doc.routing["classify"]?.model).toBe("mellum");
    expect(doc.routing["classify"]?.verdict).toBe("delegate-local");
    expect(doc.routing["classify"]?.passRate).toBe(1);
    expect(doc.routing["classify"]?.tokPerSec).toBe(200);
  });

  it("escalates a task type to FRONTIER when every local model is not viable (sql)", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("sql", "mellum", { successRate: 0.5, attempts: 4, recommendation: "escalate-frontier" }),
        row("sql", "qwen3-coder-next-80b", { successRate: 0.33, attempts: 3, recommendation: "escalate-frontier" }),
      ])
    );
    expect(doc.routing["sql"]?.model).toBeNull();
    expect(doc.routing["sql"]?.verdict).toBe("escalate-frontier");
    expect(doc.escalateToFrontier).toContain("sql");
  });

  it("prefers the FASTER model when two are viable (tiebreak by tok/s)", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("summarize", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 130 }),
        row("summarize", "qwen3-coder-next-80b", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 60 }),
      ])
    );
    expect(doc.routing["summarize"]?.model).toBe("mellum");
  });

  it("prefers a NON-THINKING model over a thinking one at equal pass-rate/speed", () => {
    const doc = generateRoutingTable(
      baseInputs([
        // gemma4 is thinking; qwen3-coder-next-80b is not. Equal rate + speed → non-thinking wins.
        row("extract", "gemma4", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 62 }),
        row("extract", "qwen3-coder-next-80b", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 62 }),
      ])
    );
    expect(doc.routing["extract"]?.model).toBe("qwen3-coder-next-80b");
  });

  it("SAFETY OVERRIDE: never routes reason-hard to mellum even when mellum passes the probe", () => {
    // Reproduces the curated judgment in the current table: mellum passes reason-hard 10/10 but is
    // routed to the 80b because its documented math weakness makes mellum-for-hard-reasoning unsafe.
    const doc = generateRoutingTable(
      baseInputs([
        row("reason-hard", "mellum", { successRate: 1, attempts: 10, recommendation: "delegate-local", avgTokPerSec: 138 }),
        row("reason-hard", "qwen3-coder-next-80b", { successRate: 1, attempts: 10, recommendation: "delegate-local", avgTokPerSec: 69 }),
      ])
    );
    expect(MODEL_META["mellum"]?.unsafeFor).toContain("reason-hard");
    expect(doc.routing["reason-hard"]?.model).toBe("qwen3-coder-next-80b");
  });

  it("does not route to a model with stale evidence when it is not currently servable", () => {
    const inputs = baseInputs([
      row("reason-math", "qwen35-a3b", {
        successRate: 1,
        attempts: 12,
        recommendation: "delegate-local",
        avgTokPerSec: 62,
      }),
      row("reason-math", "qwen3-coder-next-80b", {
        successRate: 1,
        attempts: 12,
        recommendation: "delegate-local",
        avgTokPerSec: 40,
      }),
    ]);
    inputs.servableModelIds = ["qwen3-coder-next-80b"];

    const doc = generateRoutingTable(inputs);

    expect(doc.routing["reason-math"]?.model).toBe("qwen3-coder-next-80b");
    expect(doc.routing["reason-math"]?.note).toContain("unavailable: qwen35-a3b");
    expect(doc.modelProfiles["qwen35-a3b"]).toBeDefined();
  });

  it("falls back to an EXPLORE (marginal) local route when no model is viable but one is marginal", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("instruction-multi-constraint", "qwen3-coder-next-80b", {
          successRate: 0.67,
          attempts: 3,
          recommendation: "explore",
          avgTokPerSec: 69,
          verdict: "marginal",
        }),
      ])
    );
    expect(doc.routing["instruction-multi-constraint"]?.model).toBe("qwen3-coder-next-80b");
    expect(doc.routing["instruction-multi-constraint"]?.verdict).toBe("explore");
    // an explore route is still LOCAL, not escalate — must NOT be in escalateToFrontier
    expect(doc.escalateToFrontier).not.toContain("instruction-multi-constraint");
  });
});

// ── Missing data → explicit null + reason (never a guess) ─────────────────────────

describe("generateRoutingTable — missing evidence is surfaced, never guessed", () => {
  it("emits null model + an explicit 'pending' reason for a routable type with NO ledger evidence", () => {
    const doc = generateRoutingTable(baseInputs([])); // no evidence at all
    // every routable type is a hole → null + a reason mentioning pending/evidence
    const entry = doc.routing["classify"];
    expect(entry).toBeDefined();
    expect(entry?.model).toBeNull();
    expect(entry?.verdict).toBe("escalate-frontier");
    expect(entry?.attempts).toBe(0);
    expect(entry?.note ?? "").toMatch(/pending|no .*evidence/i);
    expect(doc.escalateToFrontier).toContain("classify");
  });

  it("model profile overallPass is null + reason when the ledger has < minSamples attempts (the qwen36-a3b hole)", () => {
    const doc = generateRoutingTable(
      baseInputs([
        // only 1 attempt — below minSamples=3 → cannot assert an overall pass rate
        row("classify", "qwen36-a3b", { successRate: 1, attempts: 1, recommendation: "explore", avgTokPerSec: 62 }),
      ])
    );
    const prof = doc.modelProfiles["qwen36-a3b"];
    expect(prof).toBeDefined();
    expect(prof?.overallPass).toBeNull();
    expect(prof?.note ?? "").toMatch(/pending|insufficient|evidence/i);
  });

  it("fills a model profile overallPass from the Model Scout registry when the ledger is thin (consume, don't race)", () => {
    const inputs = baseInputs([]);
    inputs.registry = [
      {
        id: "org/Qwen3.6-35B-A3B",
        quant: "Q4_K_M",
        sizeGB: 20,
        evaluatedAt: "2026-07-06T04:00:00.000Z",
        verdict: "winner",
        passRate: 0.9,
        avgTokPerSec: 62,
        scoresByTaskType: {},
        served: true,
        configKey: "qwen36-a3b",
      },
    ];
    const doc = generateRoutingTable(inputs);
    const prof = doc.modelProfiles["qwen36-a3b"];
    expect(prof?.overallPass).toBe(0.9);
    expect(prof?.note ?? "").toMatch(/registry|scout/i);
  });
});

// ── Thin (below-minSamples) evidence must NOT become a local route ────────────────
// Codex review #148, finding 1: ledgerReport() maps verdict:"unknown" (attempts < minSamples) to
// recommendation:"explore". A single lucky pass must escalate to FRONTIER, not persist a guessed
// local route — the same "insufficient evidence → null+reason" rule the model profiles already use.

describe("generateRoutingTable — thin evidence never becomes a local route", () => {
  it("escalates a below-minSamples 'explore' (unknown) row to frontier instead of routing local", () => {
    const doc = generateRoutingTable(
      baseInputs([
        // 1 attempt, verdict unknown → ledgerReport recommends "explore" — but it's not enough evidence.
        row("qa-factual", "mellum", {
          successRate: 1,
          attempts: 1,
          recommendation: "explore",
          verdict: "unknown",
          avgTokPerSec: 146,
        }),
      ])
    );
    const entry = doc.routing["qa-factual"];
    expect(entry?.model).toBeNull();
    expect(entry?.verdict).toBe("escalate-frontier");
    expect(entry?.note ?? "").toMatch(/insufficient|evidence|pending/i);
    expect(doc.escalateToFrontier).toContain("qa-factual");
  });

  it("still routes a genuine marginal (>= minSamples) as a local 'explore' route", () => {
    // guardrail on the fix: a real marginal verdict with enough evidence stays a local route.
    const doc = generateRoutingTable(
      baseInputs([
        row("plan-decompose", "qwen3-coder-next-80b", {
          successRate: 0.5,
          attempts: 4,
          recommendation: "explore",
          verdict: "marginal",
          avgTokPerSec: 69,
        }),
      ])
    );
    expect(doc.routing["plan-decompose"]?.model).toBe("qwen3-coder-next-80b");
    expect(doc.routing["plan-decompose"]?.verdict).toBe("explore");
  });
});

// ── Clobber-guard input: excluded-type evidence must not count as routable coverage ─
// Codex review #148, finding 2: summarizeEvidence must not let evidence for excluded task types
// (other / deep-research roles) masquerade as routable coverage — else the script's clobber guard
// (which refuses to overwrite when there is no routable evidence) would be bypassed.

describe("summarizeEvidence — only routable evidence counts toward coverage", () => {
  it("reports zero routable coverage when the ledger holds only excluded task types", () => {
    const s = summarizeEvidence({
      verdicts: [
        row("other", "mellum", { successRate: 1, attempts: 20, recommendation: "delegate-local" }),
        row("synthesis", "qwen3-coder-next-80b", { successRate: 1, attempts: 15, recommendation: "delegate-local" }),
      ],
    });
    expect(s.taskTypesWithEvidence).toBe(0);
    expect(s.routableAttempts).toBe(0);
    expect(s.ledgerAttempts).toBe(35); // total is still reported for transparency
  });

  it("counts routable attempts separately from excluded ones", () => {
    const s = summarizeEvidence({
      verdicts: [
        row("classify", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local" }),
        row("other", "mellum", { successRate: 1, attempts: 10, recommendation: "delegate-local" }),
      ],
    });
    expect(s.taskTypesWithEvidence).toBe(1);
    expect(s.routableAttempts).toBe(3);
    expect(s.ledgerAttempts).toBe(13);
  });
});

// ── Excluded task types preserve the routingTarget(UNKNOWN) invariant ─────────────

describe("generateRoutingTable — excluded task types", () => {
  it("never emits 'other' or deep-research roles into routing, even if they have ledger rows", () => {
    expect(EXCLUDED_FROM_ROUTING.has("other")).toBe(true);
    expect(EXCLUDED_FROM_ROUTING.has("synthesis")).toBe(true);
    const doc = generateRoutingTable(
      baseInputs([
        row("other", "mellum", { successRate: 1, attempts: 5, recommendation: "delegate-local", avgTokPerSec: 138 }),
        row("synthesis", "qwen3-coder-next-80b", { successRate: 1, attempts: 5, recommendation: "delegate-local" }),
      ])
    );
    expect(doc.routing["other"]).toBeUndefined();
    expect(doc.routing["synthesis"]).toBeUndefined();
  });
});

// ── Freshness stamp + source manifest ─────────────────────────────────────────────

describe("generateRoutingTable — freshness + provenance", () => {
  it("stamps generatedAt from the injected clock and carries the source manifest", () => {
    const inputs = baseInputs([
      row("classify", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 200 }),
    ]);
    inputs.sources = [
      { source: "capability-ledger", path: "./data/eval.db", present: true, records: 42, latest: "2026-07-03T00:00:00.000Z" },
    ];
    const doc = generateRoutingTable(inputs);
    expect(doc.generatedAt).toBe("2026-07-04T00:00:00.000Z");
    expect(doc.sources).toHaveLength(1);
    expect(doc.sources[0]?.source).toBe("capability-ledger");
    expect(doc._generator).toMatch(/generate-routing-table/);
  });

  it("is deterministic — identical inputs produce byte-identical output", () => {
    const mk = () =>
      generateRoutingTable(
        baseInputs([
          row("classify", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 200 }),
          row("sql", "mellum", { successRate: 0.5, attempts: 4, recommendation: "escalate-frontier" }),
        ])
      );
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
});

// ── Prototype-pollution guard: prototype-named keys never corrupt the accumulators ──
// Issue #161: the read path (routing-table.ts's routingTarget(), #159/#155) already guards
// against a caller-supplied taskType/modelId that collides with a JS prototype property name
// (task types — and, via an explicit task.modelId override, model ids — flow verbatim into the
// ledger). This mirrors that guard on the WRITE side: `routing`/`modelProfiles` are built from
// exactly those caller-controlled ledger fields, so a plain `{}` accumulator is exposed to the
// same class of bug (`acc["__proto__"] = entry` hijacks the object's real prototype instead of
// adding a key — the entry then silently vanishes from JSON.stringify output).

describe("generateRoutingTable — prototype-named keys never corrupt the accumulators (issue #161)", () => {
  it("a '__proto__' task type lands as a plain own entry, not a prototype hijack", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("__proto__", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 100 }),
        row("classify", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 200 }),
      ])
    );
    // the routing object's real [[Prototype]] must be untouched by the "__proto__" bucket
    expect(Object.getPrototypeOf(doc.routing)).toBeNull();
    // the bucket must be a retrievable OWN entry, not have vanished into the prototype slot
    expect(Object.prototype.hasOwnProperty.call(doc.routing, "__proto__")).toBe(true);
    expect(doc.routing["__proto__"]?.model).toBe("mellum");
    // an unrelated, normal task type is unaffected
    expect(doc.routing["classify"]?.model).toBe("mellum");
    // a real prototype hijack silently drops the key from JSON — assert it actually serializes
    const roundTripped = JSON.parse(JSON.stringify(doc.routing)) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
    expect((roundTripped["__proto__"] as { model: string }).model).toBe("mellum");
  });

  it("'constructor'/'toString' task types also land as safe own entries", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("constructor", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local" }),
        row("toString", "qwen3-coder-next-80b", { successRate: 1, attempts: 3, recommendation: "delegate-local" }),
      ])
    );
    expect(doc.routing["constructor"]?.model).toBe("mellum");
    expect(doc.routing["toString"]?.model).toBe("qwen3-coder-next-80b");
  });

  it("a '__proto__' MODEL ID in modelProfiles is likewise a safe own entry", () => {
    // modelId is equally caller-controllable (an explicit task.modelId override flows verbatim
    // into the ledger's model_id column), so modelProfiles is exposed to the identical bug class.
    const doc = generateRoutingTable(
      baseInputs([row("classify", "__proto__", { successRate: 1, attempts: 3, recommendation: "delegate-local" })])
    );
    expect(Object.getPrototypeOf(doc.modelProfiles)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(doc.modelProfiles, "__proto__")).toBe(true);
    expect(doc.modelProfiles["__proto__"]?.attempts).toBe(3);
  });

  it("round-trips a '__proto__' task type through disk + the real loader without corruption", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("__proto__", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 100 }),
      ])
    );
    const dir = mkdtempSync(join(tmpdir(), "routing-gen-proto-"));
    const path = join(dir, "m5-routing.json");
    writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");

    const table = loadRoutingTable(path);
    expect(routingTarget("__proto__", table)).toBe("mellum");
    // an unrelated, genuinely-absent type is still UNKNOWN — no accidental resolution via a
    // corrupted prototype
    expect(routingTarget("something-else-entirely", table)).toBe(UNKNOWN_ROUTE);
  });
});

// ── The CONTRACT: round-trips through the real loader ─────────────────────────────

describe("generateRoutingTable — round-trips through routing-table.ts (the loader contract)", () => {
  it("a generated table, written to disk and reloaded, drives routingTarget() correctly", () => {
    const doc = generateRoutingTable(
      baseInputs([
        row("code-implement", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 120 }),
        row("regex", "mellum", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 117 }),
        row("reason-math", "mellum", { successRate: 0.5, attempts: 4, recommendation: "escalate-frontier" }),
        row("reason-math", "qwen3-coder-next-80b", { successRate: 1, attempts: 3, recommendation: "delegate-local", avgTokPerSec: 82 }),
        row("sql", "mellum", { successRate: 0.5, attempts: 4, recommendation: "escalate-frontier" }),
        row("sql", "qwen3-coder-next-80b", { successRate: 0.33, attempts: 3, recommendation: "escalate-frontier" }),
      ])
    );

    const dir = mkdtempSync(join(tmpdir(), "routing-gen-"));
    const path = join(dir, "m5-routing.json");
    writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");

    const table = loadRoutingTable(path);
    // code-implement / regex share the mellum route (routing-equivalence)
    expect(routingTarget("code-implement", table)).toBe("mellum");
    expect(routingTarget("regex", table)).toBe(routingTarget("code-implement", table));
    // reason-math crosses a model boundary — must NOT collapse into the mellum cluster
    expect(routingTarget("reason-math", table)).toBe("qwen3-coder-next-80b");
    expect(routingTarget("reason-math", table)).not.toBe(routingTarget("code-implement", table));
    // sql is the characterized frontier gap
    expect(routingTarget("sql", table)).toBe(FRONTIER);
    // a type never emitted stays UNKNOWN
    expect(routingTarget("other", table)).toBe(UNKNOWN_ROUTE);
  });
});
