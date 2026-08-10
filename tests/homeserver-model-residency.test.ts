import { describe, expect, it } from "vitest";
import {
  diagnoseModelResidency,
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
