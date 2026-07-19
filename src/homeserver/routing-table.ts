/**
 * Typed loader for the evidence-based routing table (docs/m5-routing.json).
 *
 * The cartography produced a task_type → model map (which local model is reliable for each
 * task type, or `escalate-frontier` when none is). This module turns that JSON into a typed,
 * memoized table and a single function — `routingTarget()` — that collapses a task type to the
 * canonical IDENTITY of where it is served (a model id, or the FRONTIER sentinel).
 *
 * Why this matters for Gate B: the migration plan's T2 proposes "≥90% top-1 task-type accuracy".
 * But top-1 accuracy is a LEAKY proxy for the thing Gate B actually cares about — "the router is
 * trustworthy". Two distinct task types that share a route (regex / unit-test-gen / code-implement
 * all → mellum) are routing-EQUIVALENT: classifying one as the other changes nothing downstream.
 * `routingTarget()` lets the validator measure ROUTING accuracy (did the prompt reach the right
 * model/tier?) alongside raw top-1, and isolate the safety-critical metric: gap-type recall
 * (escalation types must never collapse into a local route).
 *
 * It is also the foundation for T3 (wiring m5-routing.json into the macro-router): the router can
 * call `routingTarget(classifyTaskLLM(prompt))` to pick a model, escalating to frontier only for
 * the characterized gap types.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** A single per-task-type routing verdict from the cartography. */
export interface RoutingEntry {
  /** The local model that serves this type, or null when no local model is reliable. */
  model: string | null;
  passRate: number;
  tokPerSec: number | null;
  /** "delegate-local" | "escalate-frontier" | "explore" (etc). */
  verdict: string;
  note?: string;
}

/** The parsed routing table (subset of m5-routing.json we depend on). */
export interface RoutingTable {
  routing: Record<string, RoutingEntry>;
  /** Task types with no reliable local model — must go to a frontier model. */
  escalateToFrontier: string[];
}

/** Canonical routing target for task types that must escalate to a frontier model. */
export const FRONTIER = "FRONTIER";
/** Canonical routing target for task types absent from the evidence-based table. */
export const UNKNOWN_ROUTE = "UNKNOWN";

/** Default location of the routing JSON, resolved relative to this module (src/homeserver → repo/docs). */
function defaultRoutingPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "docs", "m5-routing.json");
}

/**
 * Load and parse the routing table from disk. Pass `filePath` to override (tests / alt configs).
 * Throws if the file is missing or malformed — a broken routing table is a hard error, not a
 * silently-empty map (a silent empty map would route everything to UNKNOWN/escalate).
 */
export function loadRoutingTable(filePath?: string): RoutingTable {
  const path = filePath ?? defaultRoutingPath();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RoutingTable>;
  if (!parsed.routing || typeof parsed.routing !== "object") {
    throw new Error(`routing-table: ${path} has no "routing" object`);
  }
  return {
    routing: parsed.routing,
    escalateToFrontier: parsed.escalateToFrontier ?? [],
  };
}

let cached: RoutingTable | null = null;

/** Memoized default table (the real docs/m5-routing.json). */
function defaultTable(): RoutingTable {
  if (cached === null) cached = loadRoutingTable();
  return cached;
}

/** Reset the memoized default table (test isolation). */
export function resetRoutingTable(): void {
  cached = null;
}

/**
 * Collapse a task type to the canonical IDENTITY of where it is served:
 *   - a model id (e.g. "mellum", "qwen3-coder-next-80b") for local routes;
 *   - FRONTIER for escalation types (model null, verdict escalate-frontier, or listed in
 *     escalateToFrontier — any of the three, defense in depth);
 *   - UNKNOWN_ROUTE for task types not present in the table (e.g. "other", deep-research roles).
 *
 * Two task types are "routing-equivalent" iff `routingTarget` returns the same string for both.
 *
 * @param table Optional injected table (defaults to the memoized real routing JSON).
 */
export function routingTarget(taskType: string, table?: RoutingTable): string {
  const t = table ?? defaultTable();
  if (t.escalateToFrontier.includes(taskType)) return FRONTIER;
  // Own-property lookup only: task types are now caller-supplied verbatim (#155), so a prototype-
  // named key ("__proto__"/"constructor"/"toString"/…) must NOT resolve to an inherited property
  // (which would be truthy with model===undefined and wrongly escalate to FRONTIER). An absent
  // type — prototype-named or not — falls through to UNKNOWN_ROUTE, per this function's contract.
  const entry = Object.prototype.hasOwnProperty.call(t.routing, taskType)
    ? t.routing[taskType]
    : undefined;
  if (!entry) return UNKNOWN_ROUTE;
  // A malformed `model` must escalate (FRONTIER), never leak a non-id into a downstream inference
  // call. `== null` catches null/undefined (dropped or misspelled key); the trim()==="" check
  // catches an empty/whitespace string (a hand-edited blank). This is the config-drift safety net
  // Gate B exists to guard — a broken table fails safe to a frontier model, never a bad local id.
  const model = entry.model;
  if (model == null || model.trim() === "" || entry.verdict === "escalate-frontier") return FRONTIER;
  return model;
}
