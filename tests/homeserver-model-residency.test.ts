import { describe, expect, it } from "vitest";
import {
  MODEL_ACTIVITY_MAX_AGE_MS,
  classifyModelActivity,
  diagnoseModelResidency,
  type ModelActivitySample,
  type ModelResidencyDiagnostic,
  type ModelResidencyFacts,
  type SanitizedRunningEntry,
} from "../src/homeserver/model-residency.js";

const NOW_MS = Date.parse("2026-08-10T12:00:00.000Z");

function entry(overrides: Partial<SanitizedRunningEntry> = {}): SanitizedRunningEntry {
  return {
    model: "qwen-main",
    state: "ready",
    ttlSeconds: null,
    ...overrides,
  };
}

function diagnose(
  running: readonly SanitizedRunningEntry[],
  facts: Partial<ModelResidencyFacts> = {},
  nowMs = NOW_MS
): ModelResidencyDiagnostic[] {
  return diagnoseModelResidency({
    running,
    facts: {
      lastUseAtMsByModel: {},
      lifecycleStartAtMsByModel: {},
      activeCountByModel: {},
      ...facts,
    },
    nowMs,
  });
}

describe("model residency diagnostics", () => {
  it("classifies a model with a positive active count as serving", () => {
    expect(
      diagnose([entry()], {
        activeCountByModel: { "qwen-main": 1 },
      })
    ).toEqual([
      {
        model: "qwen-main",
        state: "ready",
        ttlSeconds: null,
        classification: "serving",
        activeCount: 1,
        lastUseAtMs: null,
        expiresAtMs: null,
        activity: { state: "unknown", reason: "not_probed", coverage: null, activeCount: null, observedAtMs: null },
      },
    ]);
  });

  it("classifies an inactive model as ttl_retained when last use is exactly at the TTL boundary", () => {
    expect(
      diagnose(
        [entry({ ttlSeconds: 60 })],
        {
          activeCountByModel: { "qwen-main": 0 },
          lastUseAtMsByModel: { "qwen-main": NOW_MS - 60_000 },
          lifecycleStartAtMsByModel: { "qwen-main": NOW_MS - 60_000 },
        }
      )[0]?.classification
    ).toBe("ttl_retained");
  });

  it("does not let a successful use from before the current lifecycle retain the model", () => {
    expect(
      diagnose(
        [entry({ ttlSeconds: 60 })],
        {
          activeCountByModel: { "qwen-main": 0 },
          lastUseAtMsByModel: { "qwen-main": NOW_MS - 1_000 },
          lifecycleStartAtMsByModel: { "qwen-main": NOW_MS },
        },
      )[0]?.classification,
    ).toBe("unknown");
    expect(
      diagnose(
        [entry({ ttlSeconds: 60 })],
        {
          activeCountByModel: { "qwen-main": 0 },
          lastUseAtMsByModel: { "qwen-main": NOW_MS - 1_000 },
          lifecycleStartAtMsByModel: { "qwen-main": NOW_MS - 2_000 },
        },
      )[0]?.classification,
    ).toBe("ttl_retained");
  });

  it("classifies an explicitly expired entry as unexpected", () => {
    expect(
      diagnose([entry({ ttlSeconds: null })], {
        activeCountByModel: { "qwen-main": 0 },
        expiresAtMsByModel: { "qwen-main": NOW_MS - 1 },
      })[0]?.classification
    ).toBe("unexpected");
  });

  it("classifies missing reliable facts as unknown", () => {
    expect(diagnose([entry()])[0]?.classification).toBe("unknown");
  });

  it("does not retain a model just outside the TTL or when last use is in the future", () => {
    expect(
      diagnose(
        [entry({ ttlSeconds: 60 })],
        { lastUseAtMsByModel: { "qwen-main": NOW_MS - 60_001 } }
      )[0]?.classification
    ).toBe("unknown");
    expect(
      diagnose(
        [entry({ ttlSeconds: 60 })],
        { lastUseAtMsByModel: { "qwen-main": NOW_MS + 1 } }
      )[0]?.classification
    ).toBe("unknown");
  });

  it("accepts a zero-second TTL only for last use at the injected now", () => {
    expect(
      diagnose([entry({ ttlSeconds: 0 })], {
        lastUseAtMsByModel: { "qwen-main": NOW_MS },
        lifecycleStartAtMsByModel: { "qwen-main": NOW_MS },
      })[0]?.classification
    ).toBe("ttl_retained");
    expect(
      diagnose([entry({ ttlSeconds: 0 })], {
        lastUseAtMsByModel: { "qwen-main": NOW_MS - 1 },
        lifecycleStartAtMsByModel: { "qwen-main": NOW_MS - 1 },
      })[0]?.classification
    ).toBe("unknown");
  });

  it("never guesses from a TTL without last use, from last use without a TTL, or from absent expiry", () => {
    expect(
      diagnose([entry({ ttlSeconds: 900 })], {
        activeCountByModel: { "qwen-main": 0 },
      })[0]?.classification
    ).toBe("unknown");
    expect(
      diagnose([entry()], {
        lastUseAtMsByModel: { "qwen-main": NOW_MS - 1 },
      })[0]?.classification
    ).toBe("unknown");
    expect(
      diagnose([entry({ ttlSeconds: 900 })], {
        activeCountByModel: { "qwen-main": 0 },
        lastUseAtMsByModel: { "qwen-main": NOW_MS - 901_000 },
      })[0]?.classification
    ).toBe("unknown");
  });

  it("lets current active-count evidence win over a stale expiry fact", () => {
    expect(
      diagnose([entry()], {
        activeCountByModel: { "qwen-main": 2 },
        expiresAtMsByModel: { "qwen-main": NOW_MS - 1 },
      })[0]?.classification
    ).toBe("serving");
  });

  it("returns only the persistable, non-sensitive diagnostic contract", () => {
    const diagnostic = diagnose([entry({ ttlSeconds: 30 })], {
      activeCountByModel: { "qwen-main": 0 },
      lastUseAtMsByModel: { "qwen-main": NOW_MS - 1_000 },
    })[0];

    expect(Object.keys(diagnostic ?? {}).sort()).toEqual([
      "activeCount",
      "activity",
      "classification",
      "expiresAtMs",
      "lastUseAtMs",
      "model",
      "state",
      "ttlSeconds",
    ]);
    expect(JSON.stringify(diagnostic)).not.toMatch(/cmd|proxy|request|token|prompt|response|secret|ip|hash/i);
  });

  it("rejects running entries carrying fields outside the sanitized snapshot contract", () => {
    const unsafe = {
      ...entry(),
      cmd: "private backend command",
      proxy: "private proxy address",
    } as unknown as SanitizedRunningEntry;

    expect(() => diagnose([unsafe])).toThrow(/sanitized running entry/);
  });

  it("normalizes unreliable numeric facts to unknown instead of guessing", () => {
    expect(
      diagnose([entry({ ttlSeconds: 60 })], {
        activeCountByModel: { "qwen-main": Number.NaN },
        lastUseAtMsByModel: { "qwen-main": Number.POSITIVE_INFINITY },
        expiresAtMsByModel: { "qwen-main": Number.NaN },
      })[0]
    ).toMatchObject({
      classification: "unknown",
      activeCount: null,
      lastUseAtMs: null,
      expiresAtMs: null,
    });
  });

  it("treats a non-finite or negative TTL as unreliable instead of retaining it", () => {
    expect(
      diagnose([entry({ ttlSeconds: Number.POSITIVE_INFINITY })], {
        lastUseAtMsByModel: { "qwen-main": NOW_MS },
      })[0]
    ).toMatchObject({ ttlSeconds: null, classification: "unknown" });
    expect(
      diagnose([entry({ ttlSeconds: -1 })], {
        lastUseAtMsByModel: { "qwen-main": NOW_MS },
      })[0]
    ).toMatchObject({ ttlSeconds: null, classification: "unknown" });
  });
});

describe("resident vs actively serving (INFER-376)", () => {
  const backend = (activeCount: number, ageMs = 1_000): ModelActivitySample =>
    ({ coverage: "all_backend_traffic", activeCount, observedAtMs: NOW_MS - ageMs });
  const gateway = (activeCount: number, ageMs = 1_000): ModelActivitySample =>
    ({ coverage: "gateway_admitted_only", activeCount, observedAtMs: NOW_MS - ageMs });

  it("shows a ready model with observed zero backend activity as resident and idle, not busy", () => {
    const [d] = diagnose([entry({ state: "ready" })], { activitySamplesByModel: { "qwen-main": [backend(0)] } });
    expect(d?.state).toBe("ready");
    expect(d?.activity).toEqual({ state: "idle", reason: null, coverage: "all_backend_traffic", activeCount: 0, observedAtMs: NOW_MS - 1_000 });
    expect(d?.classification).not.toBe("serving");
  });

  it("shows a ready model with active work as active and serving", () => {
    const [d] = diagnose([entry()], { activitySamplesByModel: { "qwen-main": [backend(2)] } });
    expect(d?.activity).toMatchObject({ state: "active", activeCount: 2, coverage: "all_backend_traffic" });
    expect(d?.classification).toBe("serving");
  });

  it("does not let a gateway-only zero hide direct backend activity", () => {
    expect(classifyModelActivity([gateway(0), backend(1)], NOW_MS)).toMatchObject({ state: "active", coverage: "all_backend_traffic" });
    // Gateway zero alone cannot see direct loopback consumers: unknown, never idle.
    expect(classifyModelActivity([gateway(0)], NOW_MS)).toEqual(
      { state: "unknown", reason: "partial_coverage", coverage: null, activeCount: null, observedAtMs: null });
  });

  it("accepts positive gateway evidence as active", () => {
    expect(classifyModelActivity([gateway(1), backend(0)], NOW_MS)).toMatchObject({ state: "active", coverage: "gateway_admitted_only" });
  });

  it("returns unknown for missing, stale, future, or malformed probes instead of guessing", () => {
    expect(classifyModelActivity(undefined, NOW_MS).reason).toBe("not_probed");
    expect(classifyModelActivity([], NOW_MS).reason).toBe("not_probed");
    expect(classifyModelActivity([backend(0, MODEL_ACTIVITY_MAX_AGE_MS + 1)], NOW_MS)).toMatchObject({ state: "unknown", reason: "stale" });
    expect(classifyModelActivity([backend(3, MODEL_ACTIVITY_MAX_AGE_MS + 1)], NOW_MS)).toMatchObject({ state: "unknown", reason: "stale" });
    expect(classifyModelActivity([backend(0, -1)], NOW_MS)).toMatchObject({ state: "unknown", reason: "future" });
    for (const bad of [
      { coverage: "all_backend_traffic", activeCount: -1, observedAtMs: NOW_MS },
      { coverage: "all_backend_traffic", activeCount: 0.5, observedAtMs: NOW_MS },
      { coverage: "somewhere", activeCount: 0, observedAtMs: NOW_MS },
      { coverage: "all_backend_traffic", activeCount: 0, observedAtMs: Number.NaN },
    ]) {
      expect(classifyModelActivity([bad as ModelActivitySample], NOW_MS)).toMatchObject({ state: "unknown", reason: "invalid" });
    }
    expect(classifyModelActivity([backend(0)], Number.NaN)).toMatchObject({ state: "unknown", reason: "invalid" });
  });

  it("keeps the freshness boundary inclusive at exactly the maximum age", () => {
    expect(classifyModelActivity([backend(0, MODEL_ACTIVITY_MAX_AGE_MS)], NOW_MS).state).toBe("idle");
  });

  it("defaults to unknown/not_probed when no activity samples are supplied", () => {
    const [d] = diagnose([entry()]);
    expect(d?.activity).toEqual({ state: "unknown", reason: "not_probed", coverage: null, activeCount: null, observedAtMs: null });
  });
});
