import { describe, expect, it } from "vitest";
import { eligibleIncumbents, parseIncumbentAuditMaxAgeMs } from "../src/homeserver/incumbent-audit-registry.js";
import { evidenceIdentityFromServedModelCmd } from "../src/homeserver/evidence-identity.js";

const cmd = "llama-server -m /models/mellum-Q4.gguf -c 8192";
const record = { schemaVersion: 1 as const, source: "live-served-model" as const, auditedAt: "2026-07-26T00:00:00.000Z", model: "mellum", trigger: "cadence", probeBatteryVersion: "v1", corpusFingerprint: "sha256:x", servedCommand: cmd, evidenceIdentity: evidenceIdentityFromServedModelCmd(cmd), status: "completed" as const, summary: {} as never };
describe("incumbent audit eligibility", () => {
  it("admits only a recent audit matching the currently observed serving command", () => {
    expect(eligibleIncumbents(new Map([["mellum", cmd]]), [record], Date.parse("2026-07-26T01:00:00Z"), 86_400_000).eligibleModelIds).toEqual(["mellum"]);
    const changed = eligibleIncumbents(new Map([["mellum", "llama-server -m /models/mellum-Q4.gguf -c 16384"]]), [record], Date.parse("2026-07-26T01:00:00Z"), 86_400_000);
    expect(changed.eligibleModelIds).toEqual([]); expect(changed.reasons.mellum).toContain("configuration changed");
  });
  it("keeps a missing or expired audit explicitly stale", () => {
    const r = eligibleIncumbents(new Map([["mellum", cmd], ["gemma4", cmd]]), [record], Date.parse("2026-07-28T00:00:00Z"), 86_400_000);
    expect(r.eligibleModelIds).toEqual([]); expect(r.reasons.mellum).toContain("age"); expect(r.reasons.gemma4).toContain("no incumbent audit");
  });
  it("rejects zero, negative, and non-finite age policies instead of widening eligibility", () => {
    for (const raw of ["0", "-1", "NaN", "Infinity"]) expect(() => parseIncumbentAuditMaxAgeMs(raw)).toThrow(/finite positive/);
    expect(() => eligibleIncumbents(new Map([["mellum", cmd]]), [record], Date.now(), Number.NaN)).toThrow(/finite and positive/);
  });
});
