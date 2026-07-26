import { describe, expect, it, vi } from "vitest";
import { auditIncumbent } from "../src/homeserver/incumbent-audit.js";
import type { Probe } from "../src/homeserver/probes.js";

const probe: Probe = { id: "p", taskType: "triage", verifierName: "exact", prompt: "say ok", verifier: async () => ({ outcome: "pass", score: 1 }) };
const common = { model: "mellum", endpoint: "http://gateway/v1", trigger: "evidence-age", probes: [probe], probeBatteryVersion: "v1", corpusFingerprint: "sha256:corpus", now: () => new Date("2026-07-26T00:00:00.000Z") };

describe("auditIncumbent", () => {
  it("records a live command-derived identity and full deterministic evidence without routing effects", async () => {
    const record = await auditIncumbent({ ...common, getRunningCmd: vi.fn().mockResolvedValue("llama-server -m /models/mellum-Q4.gguf -c 8192"), chat: async () => ({ output: "ok", latencyMs: 12, tokPerSec: 2, promptTokens: 1, completionTokens: 1, reasoningChars: null, finishReason: "stop" }) });
    expect(record).toMatchObject({ source: "live-served-model", status: "completed", servedCommand: expect.stringContaining("mellum-Q4.gguf"), summary: { pass: 1, totalRuns: 1 } });
    expect(record.evidenceIdentity.modelArtifact).toMatchObject({ kind: "digest", origin: "server-observed" });
    expect(record.evidenceIdentity.configEpoch).toMatchObject({ kind: "digest", origin: "server-observed" });
  });

  it("keeps an unobservable model as durable unavailable evidence and sends no probe", async () => {
    const chat = vi.fn();
    const record = await auditIncumbent({ ...common, getRunningCmd: vi.fn().mockResolvedValue(null), chat });
    expect(record).toMatchObject({ status: "unavailable", unavailableReason: expect.stringContaining("not ready") });
    expect(record.summary).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
    expect(record.evidenceIdentity.modelArtifact).toMatchObject({ kind: "unknown", reason: "not-observed" });
  });

  it("refuses completed evidence when the served command changes during probes", async () => {
    const getRunningCmd = vi.fn().mockResolvedValueOnce("llama-server -m /models/mellum-Q4.gguf -c 8192").mockResolvedValueOnce("llama-server -m /models/mellum-Q4.gguf -c 16384");
    const record = await auditIncumbent({ ...common, getRunningCmd, chat: async () => ({ output: "ok", latencyMs: 12, tokPerSec: 2, promptTokens: 1, completionTokens: 1, reasoningChars: null, finishReason: "stop" }) });
    expect(record).toMatchObject({ status: "unavailable", unavailableReason: "served artifact/configuration changed during audit" });
    expect(record.summary).toBeUndefined();
    expect(getRunningCmd).toHaveBeenCalledTimes(2);
  });
});
