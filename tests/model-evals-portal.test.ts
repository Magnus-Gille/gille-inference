/** shapeEvals — registry → portal "New model evaluations" payload (pure). */
import { describe, it, expect } from "vitest";
import { shapeEvals } from "../src/homeserver/model-evals-portal.js";
import type { RegistryEntry } from "../src/homeserver/scout-types.js";

const e = (over: Partial<RegistryEntry>): RegistryEntry => ({
  id: "org/M",
  quant: "Q4_K_M",
  sizeGB: 12,
  evaluatedAt: "2026-06-29T00:00:00.000Z",
  verdict: "interesting",
  passRate: 0.6,
  avgTokPerSec: 50,
  scoresByTaskType: {},
  served: false,
  ...over,
});

describe("shapeEvals", () => {
  it("keeps latest-per-model, newest first, content-blind fields only", () => {
    const p = shapeEvals(
      [
        e({ id: "org/A", evaluatedAt: "2026-06-20T00:00:00Z", verdict: "skip" }),
        e({ id: "org/A", evaluatedAt: "2026-06-29T00:00:00Z", verdict: "winner", served: true }),
        e({ id: "org/B", evaluatedAt: "2026-06-25T00:00:00Z" }),
      ],
      "2026-06-29T12:00:00Z"
    );
    expect(p.count).toBe(2);
    expect(p.models[0]!.id).toBe("org/A");
    expect(p.models[0]!.served).toBe(true);
    expect(p.models[0]!.verdict).toBe("winner");
    // no prompt/notes leakage — only the declared content-blind keys
    expect(Object.keys(p.models[0]!).sort()).toEqual(
      ["evaluatedAt", "id", "passRate", "quant", "served", "sizeGB", "tokPerSec", "verdict"].sort()
    );
  });
  it("empty registry → empty payload", () => {
    expect(shapeEvals([], "t").models).toEqual([]);
  });
});
