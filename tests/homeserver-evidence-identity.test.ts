/**
 * Pure unit tests for evidence-identity.ts (issue #5) — no DB, no fs beyond loading the existing
 * LearningTaskContract fixture already used by tests/homeserver-learning-task-contract.test.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseHuginRequestStamp } from "../src/homeserver/learning-task-contract.js";
import {
  assertAdmissibleEvidenceIdentity,
  buildEvidenceIdentityBundle,
  contentDigest,
  digestIdentity,
  evidenceIdentityDisclosure,
  evidenceIdentityFromAdmittedStamp,
  evidenceIdentityFromServedModelCmd,
  evidenceIdentityHash,
  findPlaceholderIdentityFields,
  labelIdentity,
  PlaceholderEvidenceIdentityError,
  unknownIdentity,
  type EvidenceIdentityBundle,
} from "../src/homeserver/evidence-identity.js";

interface SerializerFixture {
  stamp: unknown;
}

const fixtureBytes = readFileSync(new URL("./fixtures/hugin-learning-task-serializer-v1.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as SerializerFixture;

function realDigest(seed: string): string {
  return contentDigest(seed);
}

/** A fully "complete" bundle with genuine (test-synthesized but not placeholder-shaped) digests. */
function completeBundle(overrides: Partial<EvidenceIdentityBundle> = {}): EvidenceIdentityBundle {
  return buildEvidenceIdentityBundle({
    modelArtifact: digestIdentity({ id: "qwen3-30b-a3b-q4", version: "q4_k_m", digest: realDigest("qwen3-30b-a3b-q4"), origin: "server-observed" }),
    configEpoch: digestIdentity({ id: "epoch-a", version: "1", digest: realDigest("epoch-a"), origin: "server-observed" }),
    logicalTask: digestIdentity({ id: "source-doc:hugin/raw/abc", version: "raw-input-v1", digest: realDigest("logical-task"), origin: "learning-task-stamp" }),
    renderedPrompt: digestIdentity({ id: "source-doc:hugin/prompt/abc", version: "prompt-stage-v2", digest: realDigest("rendered-prompt"), origin: "learning-task-stamp" }),
    harness: digestIdentity({ id: "homeserver-executor", version: "learning-task-v1", digest: realDigest("harness"), origin: "learning-task-stamp" }),
    taxonomyVersion: labelIdentity("gille-inference/task-types@gille-inference-task-types-2026-07-19-v1", "learning-task-stamp"),
    verifierRubric: digestIdentity({ id: "sqlExec", version: "v1", digest: realDigest("verifier"), origin: "operator-declared" }),
    sampling: digestIdentity({ id: "sampling", version: "v1", digest: realDigest("sampling"), origin: "server-observed" }),
    toolPolicy: digestIdentity({ id: "tool-policy", version: "v1", digest: realDigest("tool-policy"), origin: "learning-task-stamp" }),
    lane: "delegate",
    ...overrides,
  });
}

describe("evidenceIdentityHash", () => {
  it("is deterministic for the same bundle", () => {
    const a = completeBundle();
    const b = completeBundle();
    expect(evidenceIdentityHash(a)).toBe(evidenceIdentityHash(b));
  });

  it("changes when ANY single field changes — including lane alone", () => {
    const base = completeBundle();
    const differentLane = completeBundle({ lane: "chat" });
    const differentHarness = completeBundle({
      harness: digestIdentity({ id: "homeserver-executor", version: "learning-task-v2", digest: realDigest("harness-v2"), origin: "learning-task-stamp" }),
    });
    const hashes = new Set([evidenceIdentityHash(base), evidenceIdentityHash(differentLane), evidenceIdentityHash(differentHarness)]);
    expect(hashes.size).toBe(3);
  });

  it("produces a stable sha256: digest string", () => {
    const hash = evidenceIdentityHash(completeBundle());
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

describe("evidenceIdentityDisclosure", () => {
  it("is 'legacy' for a null bundle (no identity ever recorded)", () => {
    expect(evidenceIdentityDisclosure(null)).toBe("legacy");
  });

  it("is 'complete' when every field and the lane are known", () => {
    expect(evidenceIdentityDisclosure(completeBundle())).toBe("complete");
  });

  it("is 'partial' when even one field is unknown", () => {
    const partial = completeBundle({ sampling: unknownIdentity("not-observed") });
    expect(evidenceIdentityDisclosure(partial)).toBe("partial");
  });

  it("is 'partial' when every field is known but lane is 'unknown'", () => {
    const partial = completeBundle({ lane: "unknown" });
    expect(evidenceIdentityDisclosure(partial)).toBe("partial");
  });

  it("never upgrades a partial bundle just by being read twice", () => {
    const partial = completeBundle({ toolPolicy: unknownIdentity("not-observed") });
    expect(evidenceIdentityDisclosure(partial)).toBe("partial");
    expect(evidenceIdentityDisclosure(partial)).toBe("partial");
  });
});

describe("placeholder / fictional identity rejection", () => {
  it("flags the grimnir contract fixture's own canonical synthetic identity as a placeholder", () => {
    const tainted = completeBundle({
      modelArtifact: labelIdentity("fixture-model-v1", "operator-declared"),
    });
    const offending = findPlaceholderIdentityFields(tainted);
    expect(offending).toContain("modelArtifact");
  });

  it("flags an all-zero digest as a placeholder", () => {
    const tainted = completeBundle({
      configEpoch: digestIdentity({ id: "x", version: "x", digest: "0".repeat(64), origin: "server-observed" }),
    });
    expect(findPlaceholderIdentityFields(tainted)).toContain("configEpoch");
  });

  it("flags a monochar digest of any repeated hex character, not only zeros", () => {
    const tainted = completeBundle({
      sampling: digestIdentity({ id: "x", version: "x", digest: "f".repeat(64), origin: "server-observed" }),
    });
    expect(findPlaceholderIdentityFields(tainted)).toContain("sampling");
  });

  it("flags common placeholder tokens case-insensitively", () => {
    for (const token of ["Placeholder", "TODO", "unknown-model", "fake-model"]) {
      const tainted = completeBundle({ harness: labelIdentity(token, "operator-declared") });
      expect(findPlaceholderIdentityFields(tainted)).toContain("harness");
    }
  });

  it("does NOT flag a genuine-looking real digest/label", () => {
    expect(findPlaceholderIdentityFields(completeBundle())).toEqual([]);
  });

  it("assertAdmissibleEvidenceIdentity throws PlaceholderEvidenceIdentityError naming every offending field", () => {
    const tainted = completeBundle({
      modelArtifact: labelIdentity("fixture-model-v1", "operator-declared"),
      toolPolicy: digestIdentity({ id: "x", version: "x", digest: "a".repeat(64), origin: "server-observed" }),
    });
    try {
      assertAdmissibleEvidenceIdentity(tainted);
      expect.unreachable("expected assertAdmissibleEvidenceIdentity to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PlaceholderEvidenceIdentityError);
      const placeholderErr = err as PlaceholderEvidenceIdentityError;
      expect(placeholderErr.fields).toEqual(["modelArtifact", "toolPolicy"]);
    }
  });

  it("assertAdmissibleEvidenceIdentity does not throw for a clean bundle", () => {
    expect(() => assertAdmissibleEvidenceIdentity(completeBundle())).not.toThrow();
  });
});

describe("digestIdentity / labelIdentity construction", () => {
  it("digestIdentity normalizes a bare hex digest to the sha256: prefix", () => {
    const hex = contentDigest("hello").slice("sha256:".length);
    const identity = digestIdentity({ id: "x", version: "1", digest: hex, origin: "server-observed" });
    expect(identity.digest).toBe(`sha256:${hex}`);
  });

  it("digestIdentity rejects a malformed digest instead of silently accepting it", () => {
    expect(() => digestIdentity({ id: "x", version: "1", digest: "not-a-digest", origin: "server-observed" })).toThrow();
  });

  it("labelIdentity never carries a digest field, honestly distinguishing it from a verified identity", () => {
    const label = labelIdentity("curated-role-name", "operator-declared");
    expect(label.kind).toBe("label");
    expect("digest" in label).toBe(false);
  });
});

describe("evidenceIdentityFromAdmittedStamp — consumes the stamp, never re-derives", () => {
  it("mechanically binds harness/tool_policy/prompt-stage identities to the stamp's own digests", () => {
    const stamp = parseHuginRequestStamp(structuredClone(fixture.stamp));
    const derived = evidenceIdentityFromAdmittedStamp(stamp);

    expect(derived.logicalTask.kind).toBe("digest");
    if (derived.logicalTask.kind === "digest") {
      expect(derived.logicalTask.digest).toBe(`sha256:${stamp.raw_input.digest}`);
      expect(derived.logicalTask.id).toBe(stamp.raw_input.source_ref);
    }

    expect(derived.renderedPrompt.kind).toBe("digest");
    if (derived.renderedPrompt.kind === "digest") {
      expect(derived.renderedPrompt.digest).toBe(`sha256:${stamp.hugin_envelope.digest}`);
    }

    expect(derived.harness.kind).toBe("digest");
    if (derived.harness.kind === "digest") {
      expect(derived.harness.id).toBe(stamp.origin_config.harness.id);
      expect(derived.harness.version).toBe(stamp.origin_config.harness.version);
      expect(derived.harness.digest).toBe(`sha256:${stamp.origin_config.harness.config_digest.digest}`);
    }

    expect(derived.toolPolicy.kind).toBe("digest");
    if (derived.toolPolicy.kind === "digest") {
      expect(derived.toolPolicy.id).toBe(stamp.origin_config.tool_policy.id);
    }
  });

  it("marks taxonomyVersion as a LABEL, not a fabricated digest — the stamp pins no separate taxonomy source document", () => {
    const stamp = parseHuginRequestStamp(structuredClone(fixture.stamp));
    const derived = evidenceIdentityFromAdmittedStamp(stamp);
    expect(derived.taxonomyVersion.kind).toBe("label");
    if (derived.taxonomyVersion.kind === "label") {
      expect(derived.taxonomyVersion.label).toBe(`${stamp.task_type.taxonomy_id}@${stamp.task_type.taxonomy_version}`);
    }
  });

  it("is a pure function of its input stamp — calling it twice yields byte-identical fields", () => {
    const stamp = parseHuginRequestStamp(structuredClone(fixture.stamp));
    const first = evidenceIdentityFromAdmittedStamp(stamp);
    const second = evidenceIdentityFromAdmittedStamp(stamp);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("evidenceIdentityFromServedModelCmd — genuine server-observed state, never fabricated", () => {
  it("returns honest unknowns for an absent cmd (model not currently loaded)", () => {
    const { modelArtifact, configEpoch } = evidenceIdentityFromServedModelCmd(null);
    expect(modelArtifact.kind).toBe("unknown");
    expect(configEpoch.kind).toBe("unknown");
    if (modelArtifact.kind === "unknown") expect(modelArtifact.reason).toBe("not-observed");
  });

  it("returns honest unknowns for an empty-string cmd", () => {
    const { modelArtifact } = evidenceIdentityFromServedModelCmd("   ");
    expect(modelArtifact.kind).toBe("unknown");
  });

  it("derives a real digest identity from a genuine llama-swap /running cmd", () => {
    const cmd = "/opt/llama.cpp/llama-server -m /models/Qwen3-30B-A3B-Instruct-Q4_K_M.gguf -c 32768 --parallel 2";
    const { modelArtifact, configEpoch } = evidenceIdentityFromServedModelCmd(cmd);
    expect(modelArtifact.kind).toBe("digest");
    if (modelArtifact.kind === "digest") {
      expect(modelArtifact.id).toBe("/models/Qwen3-30B-A3B-Instruct-Q4_K_M.gguf");
      expect(modelArtifact.origin).toBe("server-observed");
    }
    expect(configEpoch.kind).toBe("digest");
  });

  it("a changed context/runtime flag with the SAME model path yields a DIFFERENT configEpoch but the SAME modelArtifact", () => {
    const cmdA = "/opt/llama.cpp/llama-server -m /models/qwen3.gguf -c 16384";
    const cmdB = "/opt/llama.cpp/llama-server -m /models/qwen3.gguf -c 32768";
    const a = evidenceIdentityFromServedModelCmd(cmdA);
    const b = evidenceIdentityFromServedModelCmd(cmdB);
    expect(a.modelArtifact).toEqual(b.modelArtifact);
    expect(a.configEpoch).not.toEqual(b.configEpoch);
  });

  it("honestly reports unknown model artifact when the cmd carries no -m/--model flag", () => {
    const { modelArtifact, configEpoch } = evidenceIdentityFromServedModelCmd("/opt/llama.cpp/llama-server --ctx-size 8192");
    expect(modelArtifact.kind).toBe("unknown");
    // The epoch is still a real observed value even without a parseable model path.
    expect(configEpoch.kind).toBe("digest");
  });
});

describe("buildEvidenceIdentityBundle", () => {
  it("defaults every unspecified field to unknown('not-observed') rather than omitting it", () => {
    const bundle = buildEvidenceIdentityBundle({});
    expect(bundle.modelArtifact).toEqual({ kind: "unknown", reason: "not-observed" });
    expect(bundle.lane).toBe("unknown");
  });
});
