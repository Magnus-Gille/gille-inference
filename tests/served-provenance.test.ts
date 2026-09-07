import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SERVED_PROVENANCE_COLLECTOR_REASON_CODES,
  SERVED_PROVENANCE_REASON_CODES,
  collectServedProvenance,
  servedProvenanceSchema,
  type EffectiveConfiguration,
  type Evidence,
  type ServedProvenanceInput,
} from "../src/homeserver/served-provenance.js";
import { SERVED_PROVENANCE_REASONS } from "../src/homeserver/served-provenance-collector.js";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function artifact(seed: string, binding: "verified-immutable" | "unproven" | "stale" = "verified-immutable") {
  return {
    contentSha256: { source: "observed" as const, value: digest(seed) },
    binding,
  };
}

const observed = <T>(value: T) => ({ source: "observed" as const, value });
const unknown = <T>(): Evidence<T> => ({ source: "unknown", reason: "required-evidence-unknown" });

function unknownEffectiveConfiguration(): EffectiveConfiguration {
  return {
    contextTokens: unknown<number>(),
    defaults: {
      maxTokens: unknown<number>(),
      temperature: unknown<number>(),
      topP: unknown<number | null>(),
      topK: unknown<number | null>(),
      minP: unknown<number | null>(),
    },
    limits: {
      maxTokens: unknown<number>(),
      maxInputTokens: unknown<number | null>(),
      maxOutputTokens: unknown<number | null>(),
    },
  };
}

function completeInput(): ServedProvenanceInput {
  return {
    modelAlias: "mellum",
    observedAt: "2026-09-07T10:00:00.000Z",
    freshness: "fresh",
    artifacts: {
      weights: [artifact("weights-1")],
      projector: { kind: "not-applicable" },
      runtimeBinary: artifact("runtime-1"),
      gatewayBuild: { sha: { source: "observed", value: "a".repeat(40) }, binding: "verified-immutable" },
    },
    identities: {
      quantization: { source: "observed", value: "q4_k_m" },
      tokenizer: { source: "observed", value: "tokenizer-v1" },
      chatTemplate: { source: "observed", value: "chat-template-v1" },
    },
    effectiveConfiguration: {
      contextTokens: observed(32768),
      defaults: {
        maxTokens: observed(4096),
        temperature: observed(0),
        topP: observed(1),
        topK: observed(0),
        minP: observed(0),
      },
      limits: {
        maxTokens: observed(8192),
        maxInputTokens: observed(32768),
        maxOutputTokens: observed(8192),
      },
    },
    environment: {
      source: "observed",
      value: {
        os: "linux",
        arch: "arm64",
        cpuCount: 12,
        memoryBytes: 64 * 1024 ** 3,
        resourceCeilings: { cpuCount: 10, memoryBytes: 48 * 1024 ** 3 },
      },
    },
  };
}

describe("served provenance", () => {
  it("creates a complete schema-versioned model with a stable configuration identity", () => {
    const result = collectServedProvenance(completeInput());

    expect(result.schemaVersion).toBe(1);
    expect(result.modelAlias).toBe("mellum");
    expect(result.completeness).toBe("complete");
    expect(result.reasons).toEqual([]);
    expect(result.artifacts.projector).toEqual({ kind: "not-applicable" });
    expect(result.launchConfiguration.contextSize).toEqual(unknown<number>());
    expect(result.configurationIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(servedProvenanceSchema.parse(result)).toEqual(result);
  });

  it("represents same-path byte replacement through a changed content digest", () => {
    const before = collectServedProvenance(completeInput());
    const after = collectServedProvenance({
      ...completeInput(),
      artifacts: { ...completeInput().artifacts, weights: [artifact("weights-2")] },
    });

    expect(after.artifacts.weights[0]?.contentSha256).not.toEqual(before.artifacts.weights[0]?.contentSha256);
    expect(after.configurationIdentity).not.toBe(before.configurationIdentity);
  });

  it("advances observation time without changing identity", () => {
    const before = collectServedProvenance(completeInput());
    const after = collectServedProvenance({ ...completeInput(), observedAt: "2026-09-07T11:00:00.000Z" });

    expect(after.observedAt).not.toBe(before.observedAt);
    expect(after.configurationIdentity).toBe(before.configurationIdentity);
  });

  it("excludes the operator display label from identity", () => {
    const first = collectServedProvenance(completeInput());
    const second = collectServedProvenance({ ...completeInput(), modelAlias: "renamed-public-label" });

    expect(first.modelAlias).not.toBe(second.modelAlias);
    expect(first.configurationIdentity).toBe(second.configurationIdentity);
  });

  it("changes identity when effective configuration changes", () => {
    const before = collectServedProvenance(completeInput());
    const base = completeInput();
    const changed: ServedProvenanceInput = {
      ...base,
      effectiveConfiguration: {
        ...base.effectiveConfiguration,
      contextTokens: observed(16384),
      },
    };
    const after = collectServedProvenance(changed);

    expect(after.configurationIdentity).not.toBe(before.configurationIdentity);
  });

  it("keeps explicit zero and negative-one launch flags in identity", () => {
    const base: ServedProvenanceInput = {
      ...completeInput(),
      effectiveConfiguration: unknownEffectiveConfiguration(),
      launchConfiguration: {
        contextSize: observed(0),
        parallelism: unknown<number>(),
        temperature: unknown<number>(),
        topP: unknown<number>(),
        topK: unknown<number>(),
        minP: unknown<number>(),
        predictLimit: observed(-1),
      },
    };
    const changedContext: ServedProvenanceInput = {
      ...base,
      launchConfiguration: { ...base.launchConfiguration!, contextSize: observed(4096) },
    };
    const changedPredict: ServedProvenanceInput = {
      ...base,
      launchConfiguration: { ...base.launchConfiguration!, predictLimit: observed(128) },
    };

    const initial = collectServedProvenance(base);
    expect(initial.launchConfiguration.contextSize).toEqual(observed(0));
    expect(initial.launchConfiguration.predictLimit).toEqual(observed(-1));
    expect(collectServedProvenance(changedContext).configurationIdentity)
      .not.toBe(initial.configurationIdentity);
    expect(collectServedProvenance(changedPredict).configurationIdentity)
      .not.toBe(initial.configurationIdentity);
  });

  it("excludes environment from identity", () => {
    const before = collectServedProvenance(completeInput());
    const base = completeInput();
    const changed: ServedProvenanceInput = {
      ...base,
      environment: {
      source: "observed",
        value: { ...base.environment!.value, os: "darwin", cpuCount: 24, memoryBytes: 128 * 1024 ** 3 },
      },
    };
    const after = collectServedProvenance(changed);

    expect(after.configurationIdentity).toBe(before.configurationIdentity);
  });

  it("canonicalizes object key order before hashing", () => {
    const base = completeInput();
    const reordered: ServedProvenanceInput = {
      ...base,
      artifacts: {
        gatewayBuild: base.artifacts.gatewayBuild,
        runtimeBinary: base.artifacts.runtimeBinary,
        projector: base.artifacts.projector,
        weights: base.artifacts.weights,
      },
      identities: {
        chatTemplate: base.identities.chatTemplate,
        tokenizer: base.identities.tokenizer,
        quantization: base.identities.quantization,
      },
      effectiveConfiguration: {
        limits: base.effectiveConfiguration.limits,
        defaults: base.effectiveConfiguration.defaults,
        contextTokens: base.effectiveConfiguration.contextTokens,
      },
    };

    expect(collectServedProvenance(reordered).configurationIdentity)
      .toBe(collectServedProvenance(base).configurationIdentity);
  });

  it.each([
    ["unproven", artifact("weights", "unproven")],
    ["stale", artifact("weights", "stale")],
  ] as const)("keeps required served-byte binding %s incomplete", (_label, weights) => {
    const result = collectServedProvenance({ ...completeInput(), artifacts: { ...completeInput().artifacts, weights: [weights] } });

    expect(result.completeness).toBe("incomplete");
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("keeps missing or unknown required evidence incomplete", () => {
    const base = completeInput();
    const { projector: _projector, ...artifactsWithoutProjector } = base.artifacts;
    const input: ServedProvenanceInput = {
      ...base,
      artifacts: { ...artifactsWithoutProjector, weights: [] },
      identities: {
        ...base.identities,
      tokenizer: { source: "unknown", reason: "required-evidence-unknown" },
      },
      effectiveConfiguration: {
        ...base.effectiveConfiguration,
        defaults: {
          ...base.effectiveConfiguration.defaults,
          temperature: { source: "unknown", reason: "required-evidence-unknown" },
        },
      },
    };
    const result = collectServedProvenance(input);

    expect(result.artifacts.projector).toEqual({
      contentSha256: { source: "unknown", reason: "required-evidence-unknown" },
      binding: "unproven",
    });
    expect(result.completeness).toBe("incomplete");
    expect(result.reasons).toContain("required-evidence-missing");
    expect(result.reasons).toContain("required-evidence-unknown");
  });

  it("normalizes an explicitly unresolved projector to unknown", () => {
    const base = completeInput();
    const result = collectServedProvenance({
      ...base,
      artifacts: {
        ...base.artifacts,
        projector: { kind: "unknown", reason: "observation-unavailable" },
      },
    });

    expect(result.artifacts.projector).toEqual({
      contentSha256: { source: "unknown", reason: "required-evidence-unknown" },
      binding: "unproven",
    });
    expect(result.completeness).toBe("incomplete");
  });

  it("keeps operator-declared required values incomplete", () => {
    const base = completeInput();
    const input: ServedProvenanceInput = {
      ...base,
      identities: {
        ...base.identities,
      quantization: { source: "operator-declared", value: "q4_k_m" },
      },
    };
    const result = collectServedProvenance(input);

    expect(result.completeness).toBe("incomplete");
    expect(result.reasons).toContain("required-evidence-operator-declared");
  });

  it("marks unavailable and stale observations incomplete", () => {
    const unavailable = collectServedProvenance({ ...completeInput(), observedAt: null, freshness: "unavailable" });
    const stale = collectServedProvenance({ ...completeInput(), freshness: "stale" });

    expect(unavailable.completeness).toBe("incomplete");
    expect(unavailable.reasons).toContain("observation-unavailable");
    expect(stale.completeness).toBe("incomplete");
    expect(stale.reasons).toContain("observation-stale");
  });

  it("normalizes missing environment to unknown and rejects locator-like identities", () => {
    const { environment: _environment, ...withoutEnvironment } = completeInput();
    const missingEnvironment = collectServedProvenance(withoutEnvironment);

    expect(missingEnvironment.environment).toEqual({ source: "unknown", reason: "required-evidence-unknown" });
    expect(missingEnvironment.completeness).toBe("incomplete");

    const badIdentity = completeInput();
    const invalid = {
      ...badIdentity,
      identities: { ...badIdentity.identities, tokenizer: observed("/models/tokenizer") },
    };
    expect(() => collectServedProvenance(invalid)).toThrow();
  });

  it("keeps unknown evidence reasons out of the stable identity", () => {
    const firstBase = completeInput();
    const secondBase = completeInput();
    const first: ServedProvenanceInput = {
      ...firstBase,
      effectiveConfiguration: {
        ...firstBase.effectiveConfiguration,
        defaults: {
          ...firstBase.effectiveConfiguration.defaults,
          temperature: { source: "unknown", reason: "required-evidence-unknown" },
        },
      },
    };
    const second: ServedProvenanceInput = {
      ...secondBase,
      effectiveConfiguration: {
        ...secondBase.effectiveConfiguration,
        defaults: {
          ...secondBase.effectiveConfiguration.defaults,
          temperature: { source: "unknown", reason: "required-evidence-missing" },
        },
      },
    };

    const firstResult = collectServedProvenance(first);
    const secondResult = collectServedProvenance(second);
    expect(firstResult.configurationIdentity).toBe(secondResult.configurationIdentity);
  });

  it("accepts and preserves every collector diagnostic reason code", () => {
    expect(SERVED_PROVENANCE_REASON_CODES).toEqual(expect.arrayContaining(SERVED_PROVENANCE_REASONS));
    expect(SERVED_PROVENANCE_COLLECTOR_REASON_CODES).toEqual(expect.arrayContaining(SERVED_PROVENANCE_REASONS));

    const base = completeInput();
    for (const reason of SERVED_PROVENANCE_REASONS) {
      const candidate = collectServedProvenance({
        ...base,
        identities: {
          ...base.identities,
          quantization: { source: "unknown", reason },
        },
      });
      const parsed = servedProvenanceSchema.parse({
        ...candidate,
        reasons: [...candidate.reasons, reason],
      });

      expect(parsed.reasons).toContain(reason);
      expect(parsed.identities.quantization).toEqual({ source: "unknown", reason });
    }
  });
});
