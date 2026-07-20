/**
 * routing-table-generator.ts — the WRITER for docs/m5-routing.json (issue #145).
 *
 * Background: `routing-table.ts` LOADS the evidence-based task_type → model map, and the T3
 * macro-router consumes it via `routingTarget()`. But the JSON it reads was a hand-edited
 * snapshot with zero writers — it never learned from the evidence the system already collects
 * (the capability ledger, nightly delegations, the weekly Model Scout). This module closes that
 * loop: it turns ledger verdicts + the Model-Scout registry into a fresh, schema-compatible
 * routing table with a `generatedAt` freshness stamp and a `sources` provenance manifest.
 *
 * This module is PURE (no fs / no DB): it takes already-loaded evidence and returns a document.
 * The IO composition root is `scripts/generate-routing-table.ts`. The loader (`routing-table.ts`)
 * is the CONTRACT — the emitted `routing` + `escalateToFrontier` are exactly what it parses, and
 * `routingTarget()` must drive correctly off a generated table (pinned by the round-trip test).
 *
 * Design principles:
 *  - EVIDENCE-DRIVEN, with a small, DOCUMENTED set of curated overrides (MODEL_META below) for
 *    judgment the raw pass-rates cannot encode (e.g. "never route hard reasoning to mellum" —
 *    mellum passes the probe but has a documented math weakness). Overrides are auditable and
 *    surfaced in the manifest; they are the only non-evidence input.
 *  - MISSING DATA IS SURFACED, NEVER GUESSED. A routable task type with no evidence, or a model
 *    whose overall pass-rate cannot be asserted (< minSamples), emits an explicit null + a reason
 *    (e.g. the qwen36-a3b `overallPass` hole pending a fresh cartography). The weekly scout fills
 *    it later — this generator consumes that evidence, it does not race it.
 *  - FAIL-SAFE: an unknown/absent route escalates to a frontier model, never a blank local id.
 */

import { TASK_TYPES } from "./taxonomy.js";
import type { LedgerReportRow } from "./ledger.js";
import type { RegistryEntry } from "./scout-types.js";

// ── Curated model metadata (the ONLY non-evidence input) ─────────────────────────

export interface ModelMeta {
  /** True for long-chain-of-thought models (routed last for short tasks). */
  thinking: boolean;
  /** Human-readable role, carried into modelProfiles for the portal/ops. */
  role: string;
  /**
   * Task types this model must NEVER be selected for, regardless of a passing probe — curated
   * safety judgment. Today the only entry is mellum's documented math weakness: it passes the
   * reason-hard probe but is unsafe for the hard-reasoning tier (see docs/m5-routing.json note).
   */
  unsafeFor: string[];
}

export const MODEL_META: Record<string, ModelMeta> = {
  mellum: {
    thinking: false,
    role: "fast workhorse: code/extract/classify/summarize. WEAK at math & multi-constraint.",
    unsafeFor: ["reason-math", "reason-hard"],
  },
  "qwen3-coder-next-80b": {
    thinking: false,
    role: "strongest generalist + escalation target (math, rewrite, hard instruction-following).",
    unsafeFor: [],
  },
  gemma4: {
    thinking: true,
    role: "solid but slower; reasons efficiently. multimodal-capable.",
    unsafeFor: [],
  },
  "qwen36-a3b": {
    thinking: false,
    role: "Qwen3.6-35B-A3B non-thinking MoE workhorse (2026-07-02 upgrade of 3.5).",
    unsafeFor: [],
  },
};

// ── Model family map (issue #48) ──────────────────────────────────────────────────
//
// Family-diversity is a no-self-grading rule for anchored-calibration.ts: an adjudicator/judge whose
// model family matches the candidate it is grading is excluded from that candidate's anchored
// agreement set (grading your own family is not independent evidence). This is a DOCUMENTED,
// CURATED map — the same discipline as MODEL_META.unsafeFor above — never a blanket default, and it
// lives alongside MODEL_META because both are hand-maintained judgment overlays on model identity.
//
// Known local/served ids get an explicit family; `gpt-oss-120b` is included even though it is not a
// MODEL_META candidate because it is the default harvest judge (harvest.ts's HARVEST_JUDGE_DEFAULT)
// and must still classify correctly when it is itself graded as a candidate on some lane. A small set
// of FRONTIER vendor-prefix fallbacks is included for the design doc's "family-diverse frontier
// adjudicator" direction (grimnir docs/autonomous-improvement-design.md §3) even though no frontier
// adjudicator is wired into routing yet — so `modelFamilyOf` classifies them correctly the day one is.
// GROW THIS ONLY with a reviewed, demonstrated family relationship — an unrecognised id conservatively
// falls back to being its OWN singleton family (never silently grouped with something it might share
// provenance with), which is the fail-closed direction for a no-self-grading rule.
export const MODEL_FAMILY: Record<string, string> = {
  mellum: "mellum",
  "qwen3-coder-next-80b": "qwen",
  "qwen36-a3b": "qwen",
  gemma4: "gemma",
  "gpt-oss-120b": "gpt-oss",
};

/** Prefix fallbacks for ids not (yet) in `MODEL_FAMILY` — same growth discipline as the map above. */
const MODEL_FAMILY_PREFIXES: ReadonlyArray<[RegExp, string]> = [
  [/^qwen/i, "qwen"],
  [/^gemma/i, "gemma"],
  [/^gemini/i, "google"],
  [/^gpt-oss/i, "gpt-oss"],
  [/^(gpt-|o[0-9])/i, "openai"],
  [/^claude/i, "anthropic"],
  [/^(llama|meta-llama)/i, "llama"],
  [/^mellum/i, "mellum"],
  [/^mistral/i, "mistral"],
  [/^deepseek/i, "deepseek"],
];

/**
 * Model family for the no-self-grading check. An id in `MODEL_FAMILY` wins; otherwise a known
 * vendor-prefix pattern applies; otherwise the id is conservatively its OWN family (an unknown model
 * is judged self-graded only against an EXACT id match, never grouped with anything else it might
 * secretly share a family with — fail-closed for a safety exclusion means narrower matching, not
 * wider). Never throws; a null/empty id maps to the literal string `"(unknown)"`, its own singleton.
 */
export function modelFamilyOf(modelId: string | null | undefined): string {
  const id = (modelId ?? "").trim();
  if (!id) return "(unknown)";
  if (MODEL_FAMILY[id]) return MODEL_FAMILY[id];
  for (const [re, family] of MODEL_FAMILY_PREFIXES) if (re.test(id)) return family;
  return id;
}

// ── Task types excluded from the macro-routing table ─────────────────────────────

/** Deep-research pipeline roles — routed by the deep-research harness itself, not the macro-router. */
export const DEEP_RESEARCH_ROLES = [
  "research-plan",
  "source-distill",
  "claim-verify",
  "gap-check",
  "synthesis",
] as const;

/**
 * Task types that must NOT appear in the routing map. `other` is the fallback bucket (routingTarget
 * intentionally returns UNKNOWN for it); the deep-research roles are owned by the deep-research
 * harness's own config. Emitting them here would silently change routingTarget()'s contract.
 */
export const EXCLUDED_FROM_ROUTING: ReadonlySet<string> = new Set<string>([
  "other",
  ...DEEP_RESEARCH_ROLES,
]);

// ── Output shape (superset of the routing-table.ts loader contract) ──────────────

export interface GeneratedRoutingEntry {
  /** Serving model id, or null when no local model is reliable (→ frontier). */
  model: string | null;
  passRate: number;
  tokPerSec: number | null;
  verdict: "delegate-local" | "explore" | "escalate-frontier";
  /** Verdict-relevant ledger attempts behind this entry (0 = a pending hole). */
  attempts: number;
  note?: string;
}

export interface GeneratedModelProfile {
  /** Overall pass-rate, or null when it cannot be asserted from the available evidence. */
  overallPass: number | null;
  tokPerSec: number | null;
  thinking: boolean;
  role: string;
  attempts: number;
  note?: string;
}

/** One provenance row for the source manifest (built by the IO layer). */
export interface SourceManifestEntry {
  source: string;
  path: string;
  present: boolean;
  records: number;
  latest: string | null;
  note?: string;
}

export interface RoutingTableDoc {
  _comment: string;
  _generator: string;
  generatedAt: string;
  sources: SourceManifestEntry[];
  globalRule: string;
  routing: Record<string, GeneratedRoutingEntry>;
  escalateToFrontier: string[];
  avoidForShortTasks: string[];
  modelProfiles: Record<string, GeneratedModelProfile>;
}

export interface GenerateInputs {
  /** Per-(task_type, model) rows from ledger.ledgerReport(policy). */
  verdicts: LedgerReportRow[];
  /** Durable Model-Scout registry entries (model-registry.readRegistry()). */
  registry: RegistryEntry[];
  /** Provenance manifest assembled by the IO layer (ledger / cartography / registry). */
  sources: SourceManifestEntry[];
  /** Injected ISO clock (Date is unavailable in some harnesses; keep the fn pure). */
  generatedAt: string;
  /** Only minSamples is consulted — below it an overall pass-rate cannot be asserted. */
  policy: { minSamples: number };
  /** Override the curated model metadata (tests). */
  modelMeta?: Record<string, ModelMeta>;
  /**
   * Optional live serving catalogue. When present, route selection ignores evidence for model IDs
   * that are not currently servable, while keeping their modelProfiles for audit/history.
   */
  servableModelIds?: string[];
  /** Override the routable task-type set (defaults to TASK_TYPES minus EXCLUDED_FROM_ROUTING). */
  routableTaskTypes?: string[];
}

// ── Selection helpers ────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Canonical routable task types (the taxonomy minus the excluded set), in stable taxonomy order. */
export function routableTaskTypes(): string[] {
  return TASK_TYPES.map((t) => t.id).filter((id) => !EXCLUDED_FROM_ROUTING.has(id));
}

/**
 * The task types to emit: the canonical set FIRST (taxonomy order, so absent types surface as
 * pending holes), then any extra evidence-backed task type the ledger has seen but the taxonomy
 * doesn't name (e.g. ad-hoc probe types like `instruction-multi-constraint`), sorted for
 * determinism. An explicit override wins verbatim.
 */
function resolveRoutableTypes(verdicts: LedgerReportRow[], override?: string[]): string[] {
  if (override) return override;
  const base = routableTaskTypes();
  const baseSet = new Set(base);
  const extras = [...new Set(verdicts.map((r) => r.taskType))]
    .filter((t) => !EXCLUDED_FROM_ROUTING.has(t) && !baseSet.has(t))
    .sort();
  return [...base, ...extras];
}

/**
 * Rank candidate rows: NON-THINKING first, then higher pass-rate, then faster (tok/s; null last),
 * then model id (asc) for a fully-deterministic tiebreak. Returns a new sorted array.
 */
function rankCandidates(
  rows: LedgerReportRow[],
  meta: Record<string, ModelMeta>
): LedgerReportRow[] {
  return [...rows].sort((a, b) => {
    const ta = meta[a.modelId]?.thinking ? 1 : 0;
    const tb = meta[b.modelId]?.thinking ? 1 : 0;
    if (ta !== tb) return ta - tb; // non-thinking (0) first
    if (b.successRate !== a.successRate) return b.successRate - a.successRate;
    const sa = a.avgTokPerSec ?? -1;
    const sb = b.avgTokPerSec ?? -1;
    if (sb !== sa) return sb - sa; // faster first
    return a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0;
  });
}

function isUnsafe(modelId: string, taskType: string, meta: Record<string, ModelMeta>): boolean {
  return (meta[modelId]?.unsafeFor ?? []).includes(taskType);
}

/** Select the routing entry for one task type from its ledger rows. */
export function selectRoutingEntry(
  taskType: string,
  rows: LedgerReportRow[],
  meta: Record<string, ModelMeta>,
  minSamples: number,
  servableModelIds?: ReadonlySet<string>
): GeneratedRoutingEntry {
  const forTypeAll = rows.filter((r) => r.taskType === taskType);
  const forType = servableModelIds
    ? forTypeAll.filter((r) => servableModelIds.has(r.modelId))
    : forTypeAll;
  const unavailableNote = (candidateRows: LedgerReportRow[], selectedModelId?: string): string => {
    if (!servableModelIds) return "";
    const best = rankCandidates(candidateRows, meta)[0];
    if (!best || servableModelIds.has(best.modelId) || best.modelId === selectedModelId) return "";
    return ` (unavailable: ${best.modelId})`;
  };

  if (forTypeAll.length === 0) {
    return {
      model: null,
      passRate: 0,
      tokPerSec: null,
      verdict: "escalate-frontier",
      attempts: 0,
      note: "no ledger evidence yet — escalating to frontier; pending cartography (Model Scout cron fills it)",
    };
  }

  if (forType.length === 0) {
    return {
      model: null,
      passRate: 0,
      tokPerSec: null,
      verdict: "escalate-frontier",
      attempts: 0,
      note: `no evidence for currently served models — escalating to frontier${unavailableNote(forTypeAll)}`,
    };
  }

  const safe = forType.filter((r) => !isUnsafe(r.modelId, taskType, meta));
  const delegate = safe.filter((r) => r.recommendation === "delegate-local");
  // ledgerReport() maps verdict:"unknown" (attempts < minSamples) to recommendation:"explore".
  // Gate explore candidates on having enough evidence so a single lucky pass does NOT persist a
  // guessed local route — thin evidence must fail safe to frontier (same rule as model profiles).
  const explore = safe.filter((r) => r.recommendation === "explore" && r.attempts >= minSamples);

  const excluded = forType.filter((r) => isUnsafe(r.modelId, taskType, meta)).map((r) => r.modelId);
  const excludedNote =
    excluded.length > 0 ? ` (safety-excluded: ${[...new Set(excluded)].sort().join(", ")})` : "";

  if (delegate.length > 0) {
    const best = rankCandidates(delegate, meta)[0]!;
    return {
      model: best.modelId,
      passRate: round2(best.successRate),
      tokPerSec: best.avgTokPerSec,
      verdict: "delegate-local",
      attempts: best.attempts,
      note: `viable ${best.passes}/${best.attempts} (rate ${round2(best.successRate)})${excludedNote}${unavailableNote(
        forTypeAll.filter((r) => !isUnsafe(r.modelId, taskType, meta) && r.recommendation === "delegate-local"),
        best.modelId
      )}`,
    };
  }

  if (explore.length > 0) {
    const best = rankCandidates(explore, meta)[0]!;
    return {
      model: best.modelId,
      passRate: round2(best.successRate),
      tokPerSec: best.avgTokPerSec,
      verdict: "explore",
      attempts: best.attempts,
      note: `marginal ${best.passes}/${best.attempts} (rate ${round2(best.successRate)}) — keep sampling${excludedNote}${unavailableNote(
        forTypeAll.filter((r) => !isUnsafe(r.modelId, taskType, meta) && r.recommendation === "explore" && r.attempts >= minSamples),
        best.modelId
      )}`,
    };
  }

  // No local model is viable, or the only signal is too thin → escalate. Summarise for context,
  // distinguishing "insufficient evidence" (thin) from "measured not-viable".
  const bestSeen = rankCandidates(forType, meta)[0]!;
  const thin = bestSeen.attempts < minSamples;
  return {
    model: null,
    passRate: round2(bestSeen.successRate),
    tokPerSec: null,
    verdict: "escalate-frontier",
    attempts: forType.reduce((s, r) => s + r.attempts, 0),
    note: thin
      ? `insufficient evidence — best ${bestSeen.modelId} has ${bestSeen.attempts} < ${minSamples} attempts; escalating, pending more (Model Scout cron fills it)${excludedNote}${unavailableNote(forTypeAll, bestSeen.modelId)}`
      : `no viable local model (best: ${bestSeen.modelId} ${round2(bestSeen.successRate)})${excludedNote}${unavailableNote(forTypeAll, bestSeen.modelId)}`,
  };
}

// ── Model profiles ───────────────────────────────────────────────────────────────

/** Latest served registry entry keyed by its served alias (configKey). */
function registryByServedAlias(registry: RegistryEntry[]): Map<string, RegistryEntry> {
  const m = new Map<string, RegistryEntry>();
  for (const e of registry) {
    if (!e.served || !e.configKey) continue;
    const existing = m.get(e.configKey);
    if (!existing || e.evaluatedAt > existing.evaluatedAt) m.set(e.configKey, e);
  }
  return m;
}

function buildModelProfile(
  modelId: string,
  rows: LedgerReportRow[],
  meta: Record<string, ModelMeta>,
  registryAlias: Map<string, RegistryEntry>,
  minSamples: number
): GeneratedModelProfile {
  const mine = rows.filter((r) => r.modelId === modelId);
  const totalAttempts = mine.reduce((s, r) => s + r.attempts, 0);
  const weightedPass =
    totalAttempts > 0
      ? mine.reduce((s, r) => s + r.successRate * r.attempts, 0) / totalAttempts
      : 0;

  // tok/s: attempts-weighted over rows that recorded a rate.
  let tokNum = 0;
  let tokDen = 0;
  for (const r of mine) {
    if (r.avgTokPerSec != null) {
      tokNum += r.avgTokPerSec * r.attempts;
      tokDen += r.attempts;
    }
  }
  const m = meta[modelId];
  const base: GeneratedModelProfile = {
    overallPass: null,
    tokPerSec: tokDen > 0 ? round2(tokNum / tokDen) : registryAlias.get(modelId)?.avgTokPerSec ?? null,
    thinking: m?.thinking ?? false,
    role: m?.role ?? "",
    attempts: totalAttempts,
  };

  if (totalAttempts >= minSamples) {
    base.overallPass = round2(weightedPass);
    return base;
  }

  // Ledger too thin to assert an overall pass-rate — fall back to the Model-Scout registry if it
  // has a full-battery number for this served alias (consume the scout's evidence, don't race it).
  const reg = registryAlias.get(modelId);
  if (reg) {
    base.overallPass = round2(reg.passRate);
    base.note = `overallPass from Model Scout registry (${reg.evaluatedAt.slice(0, 10)}); ledger has ${totalAttempts} attempt(s)`;
    return base;
  }

  base.note =
    totalAttempts === 0
      ? "overallPass pending — no ledger evidence and no Model Scout eval yet"
      : `overallPass pending — insufficient ledger evidence (${totalAttempts} < ${minSamples} attempts); Model Scout cron fills it`;
  return base;
}

// ── Main entry ───────────────────────────────────────────────────────────────────

export function generateRoutingTable(inputs: GenerateInputs): RoutingTableDoc {
  const meta = inputs.modelMeta ?? MODEL_META;
  const minSamples = inputs.policy.minSamples;
  const types = resolveRoutableTypes(inputs.verdicts, inputs.routableTaskTypes);
  const servableModelIds = inputs.servableModelIds
    ? new Set(inputs.servableModelIds)
    : undefined;

  // Object.create(null): taskType is caller-supplied verbatim (#155/#159), so a plain `{}`
  // accumulator is exposed to prototype-named keys ("__proto__"/"constructor"/…) — a
  // `routing["__proto__"] = entry` assignment on a normal object HIJACKS the object's real
  // prototype instead of adding a key, silently dropping the entry from the serialized table
  // (mirrors the read-path guard in routing-table.ts's routingTarget()). A null-prototype
  // object has no inherited "__proto__" setter to hijack, so every key — however named —
  // becomes a plain own property that serializes normally.
  const routing: Record<string, GeneratedRoutingEntry> = Object.create(null);
  const escalateToFrontier: string[] = [];
  for (const taskType of types) {
    const entry = selectRoutingEntry(taskType, inputs.verdicts, meta, minSamples, servableModelIds);
    routing[taskType] = entry;
    if (entry.model === null) escalateToFrontier.push(taskType);
  }

  // Model roster: curated known models + any model that appears in the ledger + served registry aliases.
  const registryAlias = registryByServedAlias(inputs.registry);
  const modelIds = new Set<string>([
    ...Object.keys(meta),
    ...inputs.verdicts.map((r) => r.modelId),
    ...registryAlias.keys(),
  ]);
  // Same guard as `routing` above: modelId is equally caller-controllable (an explicit
  // task.modelId override flows verbatim into the ledger's model_id column), so this
  // accumulator is exposed to the identical prototype-hijack class.
  const modelProfiles: Record<string, GeneratedModelProfile> = Object.create(null);
  for (const id of [...modelIds].sort()) {
    modelProfiles[id] = buildModelProfile(id, inputs.verdicts, meta, registryAlias, minSamples);
  }

  return {
    _comment:
      "Evidence-based routing table AUTO-GENERATED from the capability ledger (delegations table, " +
      "populated by cartography + nightly delegations) and the weekly Model Scout registry. " +
      "'escalate-frontier' = no reliable local model. A null model with attempts=0 is a pending " +
      "hole awaiting fresh evidence, not a characterized gap.",
    _generator:
      "scripts/generate-routing-table.ts — DO NOT hand-edit; re-run the generator. Curated safety " +
      "overrides live in src/homeserver/routing-table-generator.ts (MODEL_META.unsafeFor).",
    generatedAt: inputs.generatedAt,
    sources: inputs.sources,
    globalRule:
      "Prefer NON-THINKING models, then higher pass-rate, then faster decode. Curated safety " +
      "override: mellum is never selected for reason-math/reason-hard (documented math weakness) " +
      "even on a passing probe. Escalate to a frontier model when no local model is viable or the " +
      "evidence is still pending.",
    routing,
    escalateToFrontier,
    avoidForShortTasks: [...Object.keys(meta)].filter((id) => meta[id]?.thinking).sort(),
    modelProfiles,
  };
}

// ── Evidence summary (used by the IO layer's clobber guard) ──────────────────────

export interface EvidenceSummary {
  ledgerRows: number;
  /** Total verdict-relevant attempts across ALL rows (incl. excluded types) — reported for transparency. */
  ledgerAttempts: number;
  /** Attempts on ROUTABLE task types only — the clobber guard keys on this, not the total. */
  routableAttempts: number;
  taskTypesWithEvidence: number;
  routableTaskTypes: number;
}

/**
 * Summarise how much evidence backs a generation — lets the script refuse to clobber on empty data.
 * `routableAttempts`/`taskTypesWithEvidence` count ONLY routable task types, so evidence for excluded
 * types (other / deep-research roles) can never masquerade as routable coverage and slip past the guard.
 */
export function summarizeEvidence(inputs: Pick<GenerateInputs, "verdicts" | "routableTaskTypes">): EvidenceSummary {
  const types = resolveRoutableTypes(inputs.verdicts, inputs.routableTaskTypes);
  const routableSet = new Set(types);
  const withEvidence = new Set<string>();
  let attempts = 0;
  let routableAttempts = 0;
  for (const r of inputs.verdicts) {
    attempts += r.attempts;
    if (routableSet.has(r.taskType)) {
      withEvidence.add(r.taskType);
      routableAttempts += r.attempts;
    }
  }
  return {
    ledgerRows: inputs.verdicts.length,
    ledgerAttempts: attempts,
    routableAttempts,
    taskTypesWithEvidence: withEvidence.size,
    routableTaskTypes: types.length,
  };
}
