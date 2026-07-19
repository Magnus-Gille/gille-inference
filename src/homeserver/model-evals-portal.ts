/**
 * model-evals-portal.ts — shape the scout registry for the public portal's
 * "New model evaluations" section (served by GET /portal/model-evals.json).
 *
 * Content-blind: only model id / quant / size / scores / verdict / served — no prompts, no
 * per-user data. Reads the same durable registry the weekly scout + Heimdall poster use.
 */
import { DEFAULT_REGISTRY_PATH, latestByModel, readRegistry } from "./model-registry.js";
import type { RegistryEntry } from "./scout-types.js";

export interface PortalEvalRow {
  id: string;
  quant: string;
  sizeGB: number;
  passRate: number; // [0,1]
  tokPerSec: number | null;
  verdict: string;
  served: boolean;
  evaluatedAt: string;
}

export interface ModelEvalsPayload {
  generatedAt: string;
  count: number;
  models: PortalEvalRow[];
}

/** Latest evaluation per model, newest first (pure given the entries). */
export function shapeEvals(entries: RegistryEntry[], nowIso: string): ModelEvalsPayload {
  const models = [...latestByModel(entries).values()]
    .sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt))
    .map((e) => ({
      id: e.id,
      quant: e.quant || "",
      sizeGB: e.sizeGB,
      passRate: e.passRate,
      tokPerSec: e.avgTokPerSec,
      verdict: e.verdict,
      served: e.served,
      evaluatedAt: e.evaluatedAt,
    }));
  return { generatedAt: nowIso, count: models.length, models };
}

/** Read the registry and shape it. Returns an empty payload if the registry is absent. */
export function modelEvalsPayload(path?: string): ModelEvalsPayload {
  const p = path ?? process.env["SCOUT_REGISTRY"] ?? DEFAULT_REGISTRY_PATH;
  return shapeEvals(readRegistry(p), new Date().toISOString());
}
