/**
 * Pure-helper tests for the model scout orchestrator (no network/fs/spawn).
 * decideVerdict uses the DEFAULT env thresholds (winner ≥0.7 pass & ≥15 tok/s; interesting ≥0.5).
 */
import { describe, it, expect, vi } from "vitest";
import { decideVerdict, slugifyId, safeLocalName, familyKey, setMaintenance } from "../scripts/weekly-model-scout.js";
import type { ProbeRunSummary } from "../src/homeserver/scout-types.js";

const summary = (passRate: number, tokps: number | null): ProbeRunSummary => ({
  model: "m",
  endpoint: "e",
  totalRuns: 10,
  pass: Math.round(passRate * 10),
  partial: 0,
  fail: 10 - Math.round(passRate * 10),
  error: 0,
  passRate,
  avgTokPerSec: tokps,
  emptyOutputs: 0,
  truncations: 0,
  finishReasons: { stop: 10 },
  byTaskType: [],
  results: [],
});

describe("decideVerdict", () => {
  it("winner needs both a high pass-rate AND enough speed", () => {
    expect(decideVerdict(summary(0.8, 30))).toBe("winner");
    expect(decideVerdict(summary(0.8, 5))).toBe("interesting"); // fast-enough bar fails → not a winner
    expect(decideVerdict(summary(0.8, null))).toBe("interesting");
  });
  it("interesting in the middle band", () => {
    expect(decideVerdict(summary(0.55, 50))).toBe("interesting");
  });
  it("skip when weak", () => {
    expect(decideVerdict(summary(0.3, 50))).toBe("skip");
  });
});

describe("slugifyId", () => {
  it("produces a safe lowercase-kebab slug from an HF id", () => {
    expect(slugifyId("zai-org/GLM-5.2")).toBe("glm-5-2");
    expect(slugifyId("unsloth/Qwen3-Coder-Next-GGUF")).toBe("qwen3-coder-next-gguf");
  });
  it("never yields path separators or traversal even for hostile ids", () => {
    const s = slugifyId("evil/../../etc/passwd");
    expect(s).not.toMatch(/[/.]/);
    expect(s).not.toContain("..");
  });
});

describe("safeLocalName (security: HF filename never reaches a local path)", () => {
  it("derives a clean single-file name", () => {
    expect(safeLocalName("foo-9b", "Q4_K_M", "Whatever-Q4_K_M.gguf")).toBe("foo-9b-Q4_K_M.gguf");
  });
  it("preserves the NNNNN-of-MMMMM shard suffix so llama.cpp finds parts", () => {
    expect(safeLocalName("oss", "MXFP4", "model-mxfp4-00002-of-00003.gguf")).toBe("oss-MXFP4-00002-of-00003.gguf");
  });
  it("strips path traversal / leading dashes / metacharacters from a hostile remote name", () => {
    const n = safeLocalName("m", "Q4_K_M", "../../etc/-rm -rf;$(x)\n.gguf");
    expect(n).toBe("m-Q4_K_M.gguf"); // remote junk discarded; name rebuilt from safe slug+quant
    expect(n).not.toMatch(/[/\\;$\n]/);
    expect(n.startsWith("-")).toBe(false);
  });
  it("sanitizes a hostile quant string too", () => {
    expect(safeLocalName("m", "../evil", "x.gguf")).toBe("m-EVIL.gguf");
  });
});

describe("familyKey", () => {
  it("collapses quant/finetune variants of the same base model", () => {
    expect(familyKey("unsloth/Qwen3-Coder-Next-GGUF")).toBe(familyKey("Qwen/Qwen3-Coder-Next"));
  });
  it("distinguishes genuinely different models", () => {
    expect(familyKey("org/Llama-4-8B")).not.toBe(familyKey("org/Gemma-4-9B"));
  });
});

// #105: engage the live gateway's bench/maintenance mode around the ephemeral VRAM-contending
// test window so guest traffic isn't silently degraded while a candidate model is being probed.
// setMaintenance returns a boolean (true = confirmed engaged/disengaged) rather than void so
// main() can tell "protection genuinely active" apart from "opted out" or "silently failed" —
// a scout run that believes it's protected when it isn't defeats the whole point of this PR.
describe("setMaintenance (#105 gateway-drain wiring)", () => {
  it("skips the HTTP call entirely when no api key is configured (opt-in, never blocks a run)", async () => {
    const fetchFn = vi.fn();
    const ok = await setMaintenance(true, { apiKey: "", fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(ok).toBe(false); // not engaged — but this is the documented opt-out, not a failure
  });

  it("POSTs {on:true, ttlSeconds} with the bearer token when engaging, and returns true", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const ok = await setMaintenance(true, { apiKey: "hs_owner_test", ttlSeconds: 7200, gatewayUrl: "http://127.0.0.1:8080", fetchFn });
    expect(ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8080/admin/maintenance");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer hs_owner_test");
    expect(JSON.parse(init.body as string)).toEqual({ on: true, ttlSeconds: 7200 });
  });

  it("POSTs {on:false} with no ttlSeconds when disengaging", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await setMaintenance(false, { apiKey: "hs_owner_test", fetchFn });
    const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ on: false });
  });

  it("never throws when the gateway is unreachable, and reports failure via the return value", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(setMaintenance(true, { apiKey: "hs_owner_test", fetchFn })).resolves.toBe(false);
  });

  it("never throws on a non-2xx response, and reports failure via the return value", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(setMaintenance(true, { apiKey: "hs_owner_test", fetchFn })).resolves.toBe(false);
  });

  // The gateway rejects ttlSeconds<=0 / non-finite with 400. A garbage/empty/negative
  // SCOUT_MAINTENANCE_TTL_S env var must not silently defeat protection for the whole run by
  // getting the ON request rejected — fall back to a safe default instead of sending it raw.
  for (const bad of [0, -5, NaN, Infinity]) {
    it(`falls back to a safe default ttlSeconds instead of sending an invalid value (${String(bad)})`, async () => {
      const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      const ok = await setMaintenance(true, { apiKey: "hs_owner_test", ttlSeconds: bad, fetchFn });
      expect(ok).toBe(true);
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit];
      const sent = JSON.parse(init.body as string) as { on: boolean; ttlSeconds: number };
      expect(sent.on).toBe(true);
      expect(Number.isFinite(sent.ttlSeconds)).toBe(true);
      expect(sent.ttlSeconds).toBeGreaterThan(0);
    });
  }
});
