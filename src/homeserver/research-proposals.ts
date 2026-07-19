/**
 * research-proposals.ts — the structured deliverable of the weekly research sweep (Job B).
 *
 * A local model synthesizes the per-query deep-research reports into a list of concrete
 * "stuff we should try" proposals for running smarter models faster on the M5. This module owns
 * the Proposal type + a TOLERANT parser (local models wrap JSON in prose / code fences) + a guard.
 * Pure + testable — no I/O.
 */

export type ExpectedGain = "speed" | "intelligence" | "both";
export type Effort = "S" | "M" | "L";

export interface ResearchProposal {
  title: string;
  idea: string; // what to try, concretely
  rationale: string; // why it helps speed/intelligence on THIS box
  expectedGain: ExpectedGain;
  effort: Effort;
  sources: string[]; // source URLs backing the claim
}

function coerceGain(x: unknown): ExpectedGain {
  const s = String(x).toLowerCase();
  if (s.includes("both") || (s.includes("speed") && s.includes("intel"))) return "both";
  if (s.includes("speed") || s.includes("fast") || s.includes("latency") || s.includes("throughput")) return "speed";
  return "intelligence";
}

function coerceEffort(x: unknown): Effort {
  const s = String(x).toUpperCase();
  if (s.startsWith("S") || s.includes("LOW")) return "S";
  if (s.startsWith("L") || s.includes("HIGH")) return "L";
  return "M";
}

function coerceSources(x: unknown): string[] {
  if (Array.isArray(x)) return x.map((s) => String(s)).filter((s) => /^https?:\/\//.test(s)).slice(0, 8);
  if (typeof x === "string" && /^https?:\/\//.test(x)) return [x];
  return [];
}

/** True for an object with at least a usable title + idea. */
export function isResearchProposal(x: unknown): x is { title: unknown; idea: unknown } {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r["title"] === "string" && r["title"].trim() !== "" && typeof r["idea"] === "string";
}

/** Extract the first balanced top-level JSON array from arbitrary model text (handles code fences/prose). */
export function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse a synthesis model's output into validated proposals. Tolerant: strips prose/fences, parses
 * the first JSON array, coerces enum-ish fields, drops malformed items. Returns [] on total failure.
 */
export function parseProposals(modelOutput: string): ResearchProposal[] {
  const json = extractJsonArray(modelOutput);
  if (!json) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ResearchProposal[] = [];
  for (const item of arr) {
    if (!isResearchProposal(item)) continue;
    const r = item as Record<string, unknown>;
    out.push({
      title: String(r["title"]).trim().slice(0, 200),
      idea: String(r["idea"]).trim().slice(0, 1000),
      rationale: String(r["rationale"] ?? "").trim().slice(0, 1000),
      expectedGain: coerceGain(r["expectedGain"] ?? r["gain"]),
      effort: coerceEffort(r["effort"]),
      sources: coerceSources(r["sources"] ?? r["source"]),
    });
  }
  return out;
}
