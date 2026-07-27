import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEvidenceIdentityBundle,
  contentDigest,
  digestIdentity,
  evidenceIdentityHash,
  labelIdentity,
  type EvidenceIdentityBundle,
} from "../src/homeserver/evidence-identity.js";
import type { EvidenceIdentitySnapshot } from "../src/homeserver/evidence-identity-store.js";
import type { ModelInfo } from "../src/homeserver/model-admin.js";
import {
  ROSTER_PROPOSAL_CONTRACT_VERSION,
  ROSTER_PROPOSAL_POLICY_EPOCH,
  ROSTER_PROPOSAL_PRINCIPAL,
  ROSTER_PROPOSAL_SCHEMA_EPOCH,
  RosterProposalContractError,
  admitRosterProposal as admitRosterProposalImpl,
  backendCapabilityIdentity,
  candidateRosterDigest,
  canonicalRosterProposalDigest,
  expireRosterProposals,
  getRosterProposalForPrincipal,
  isCanonicalRosterUtc,
  liveCatalogueIdentity,
  rosterDigest,
  rosterProposalEvents,
  serverRosterObservationDigest,
  templateIdentityDigest,
  restoreDescriptorDigest,
  canaryRegistryDigest,
  type RosterAdmissionDependencies,
  type RosterCandidateEntry,
  type RosterProposal,
  type ServerCanaryDefinition,
  type ServerRestoreDescriptor,
  type ServerRosterObservation,
  type ServerRosterObservationToken,
} from "../src/homeserver/roster-proposal.js";

const now = "2026-07-27T15:00:00Z";
const credentialBindingDigest = contentDigest("credential:hugin:test");

function admitRosterProposal(
  raw: unknown,
  principal: string,
  options: Parameters<typeof admitRosterProposalImpl>[2] = {},
) {
  return admitRosterProposalImpl(raw, principal, {
    ...options,
    credentialBindingDigest,
  });
}
const liveModels: ModelInfo[] = [{
  key: "qwen-main",
  type: "llm",
  displayName: "Qwen Main",
  loaded: true,
  loadedContext: 8_192,
  quantization: "q4-k-m",
}];

const evidenceBundle = buildEvidenceIdentityBundle({
  modelArtifact: digestIdentity({
    id: "qwen-main.gguf",
    version: "q4-k-m",
    digest: contentDigest("artifact"),
    origin: "server-observed",
  }),
  configEpoch: digestIdentity({
    id: "llama-swap-config",
    version: "v1",
    digest: contentDigest("candidate-config"),
    origin: "server-observed",
  }),
  logicalTask: labelIdentity("roster-evaluation", "operator-declared"),
  renderedPrompt: digestIdentity({
    id: "chat-template",
    version: "v1",
    digest: contentDigest("template"),
    origin: "server-observed",
  }),
  harness: labelIdentity("model-scout", "operator-declared"),
  taxonomyVersion: labelIdentity("roster-v1", "operator-declared"),
  verifierRubric: labelIdentity("roster-evidence-v1", "operator-declared"),
  sampling: labelIdentity("deterministic", "operator-declared"),
  toolPolicy: labelIdentity("no-tools", "operator-declared"),
  lane: "benchmark",
});

function snapshot(
  bundle: EvidenceIdentityBundle = evidenceBundle,
  lastSeenAt = "2026-07-27T14:59:00Z",
): EvidenceIdentitySnapshot {
  return {
    identityHash: evidenceIdentityHash(bundle),
    bundle,
    firstSeenAt: "2026-07-27T14:00:00Z",
    lastSeenAt,
    observationCount: 3,
  };
}

function candidate(overrides: Partial<RosterCandidateEntry> = {}): RosterCandidateEntry {
  const artifact = evidenceBundle.modelArtifact;
  const config = evidenceBundle.configEpoch;
  const template = evidenceBundle.renderedPrompt;
  if (artifact.kind !== "digest" || config.kind !== "digest" || template.kind !== "digest") {
    throw new Error("test fixture identities must be digests");
  }
  const entry = {
    model_id: "qwen-main",
    alias: "qwen-main",
    artifact_digest: artifact.digest,
    quantization: artifact.version,
    template_digest: template.digest,
    context_length: 16_384,
    serving_config_digest: config.digest,
    evidence_identity_hash: snapshot().identityHash,
    restore_descriptor_ref: contentDigest(
      `restore-ref:${overrides.model_id ?? "qwen-main"}:${overrides.context_length ?? 16_384}`,
    ),
    restore_descriptor_digest: contentDigest("placeholder"),
    ...overrides,
  };
  const descriptor = descriptorFor(entry);
  return {
    ...entry,
    restore_descriptor_digest: overrides.restore_descriptor_digest ?? descriptor.digest,
  };
}

function descriptorFor(entry: RosterCandidateEntry): ServerRestoreDescriptor {
  const withoutDigest = {
    modelId: entry.model_id,
    alias: entry.alias,
    artifactDigest: entry.artifact_digest,
    quantization: entry.quantization,
    templateDigest: entry.template_digest,
    contextLength: entry.context_length,
    servingConfigDigest: entry.serving_config_digest,
    evidenceIdentityHash: entry.evidence_identity_hash,
    ref: entry.restore_descriptor_ref,
  };
  return { ...withoutDigest, digest: restoreDescriptorDigest(withoutDigest) };
}

function canaryDefinition(
  operation: "load" | "unload" | "reload-config" = "reload-config",
  modelId = "qwen-main",
): ServerCanaryDefinition {
  const withoutDigest = {
    registryId: `canary:${operation}:${modelId}`,
    registryVersion: "version:v1",
    operation,
    modelId,
    routeDigest: contentDigest("route"),
    configDigest: contentDigest("canary-config"),
    verifierDigest: contentDigest("verifier"),
    postconditionsDigest: contentDigest("postconditions"),
  };
  return { ...withoutDigest, registryDigest: canaryRegistryDigest(withoutDigest) };
}

function desiredIdentity(
  modelId: string,
  contextLength: number,
): ServerRosterObservation["desired_roster"][number] {
  const entry = candidate({ model_id: modelId, alias: modelId, context_length: contextLength });
  return {
    model_id: modelId,
    alias: modelId,
    context_length: contextLength,
    artifact_digest: entry.artifact_digest,
    serving_config_digest: entry.serving_config_digest,
    template_digest: entry.template_digest,
    quantization: entry.quantization,
    evidence_identity_hash: entry.evidence_identity_hash,
    restore_descriptor_ref: entry.restore_descriptor_ref,
    restore_descriptor_digest: entry.restore_descriptor_digest,
  };
}

function serverObservation(
  models: ModelInfo[] = liveModels,
  overrides: Partial<Omit<ServerRosterObservation, "observation_digest">> = {},
): ServerRosterObservation {
  const backend = overrides.backend_capability?.backend ?? "lmstudio";
  const capability = backendCapabilityIdentity(backend);
  const unsigned: Omit<ServerRosterObservation, "observation_digest"> = {
    schema_version: "gille-roster-server-observation-v1",
    observed_at: "2026-07-27T14:59:30Z",
    observation_epoch: "epoch:test:v1",
    catalogue: models.map((model) => ({
      model_id: model.key,
      type: model.type,
      quantization: model.quantization ?? null,
    })).sort((left, right) => left.model_id.localeCompare(right.model_id)),
    backend_capability: {
      backend: capability.backend,
      supported_operations: [...capability.supportedOperations],
      alias_control: capability.aliasControl,
      context_control: capability.contextControl,
      capability_digest: capability.capabilityDigest,
    },
    desired_roster: models
      .filter((model) => model.loaded)
      .map((model) => desiredIdentity(model.key, model.loadedContext ?? 1))
      .sort((left, right) => left.model_id.localeCompare(right.model_id)),
    resident_model_ids: models.map((model) => model.key).sort(),
    running_model_ids: models
      .filter((model) => model.loaded)
      .map((model) => model.key)
      .sort(),
    ...overrides,
  };
  return {
    ...unsigned,
    observation_digest: serverRosterObservationDigest(unsigned),
  };
}

function tokenFor(observation: ServerRosterObservation): ServerRosterObservationToken {
  return {
    schema_version: "gille-roster-server-observation-token-v1",
    observation_epoch: observation.observation_epoch,
    observation_digest: observation.observation_digest,
  };
}

function fenceFor(
  observation: ServerRosterObservation,
): RosterAdmissionDependencies["withServerObservationFence"] {
  return <T>(
    _expected: ServerRosterObservationToken,
    callback: (confirmedToken: unknown) => T,
  ): T => callback(tokenFor(observation));
}

function depsForObservation(
  base: RosterAdmissionDependencies,
  observation: ServerRosterObservation,
): RosterAdmissionDependencies {
  return {
    ...base,
    readServerObservation: async () => structuredClone(observation),
    withServerObservationFence: fenceFor(observation),
  };
}

function proposal(
  overrides: Partial<Omit<RosterProposal, "proposal_digest">> = {},
): RosterProposal {
  const baseline = liveCatalogueIdentity(liveModels);
  const desired = candidate({ context_length: 8_192 });
  const registry = canaryDefinition();
  const entries = overrides.candidate?.entries ?? [candidate()];
  const unsigned: Omit<RosterProposal, "proposal_digest"> = {
    contract_version: ROSTER_PROPOSAL_CONTRACT_VERSION,
    proposal_id: "proposal:w5:001",
    idempotency_key: "idem:w5:001",
    producer: {
      component: "hugin",
      instance_id: "hugin:dispatcher:primary",
      serializer_version: "hugin-roster-proposal-v1",
    },
    expected_transport_principal_id: ROSTER_PROPOSAL_PRINCIPAL,
    axis: "served-model-roster",
    baseline: {
      catalogue_digest: baseline.catalogueDigest,
      roster_digest: candidateRosterDigest([desired]),
    },
    candidate: {
      entries,
      roster_digest: candidateRosterDigest(entries),
    },
    delta: {
      operation: "reload-config",
      model_id: "qwen-main",
      backend: "lmstudio",
      backend_capability_digest: backendCapabilityIdentity("lmstudio").capabilityDigest,
    },
    evidence: {
      schema_epoch: ROSTER_PROPOSAL_SCHEMA_EPOCH,
      policy_epoch: ROSTER_PROPOSAL_POLICY_EPOCH,
      freshness_seconds: 3_600,
    },
    canary: {
      operation: "reload-config",
      model_id: "qwen-main",
      expected_state: "served",
      fallback_model_id: null,
      registry_id: registry.registryId,
      registry_version: registry.registryVersion,
      registry_digest: registry.registryDigest,
      max_requests: 5,
      duration_seconds: 600,
      max_concurrency: 1,
    },
    requested_bounds: { max_changed_entries: 1 },
    requested_operations: ["admit", "arm"],
    created_at: "2026-07-27T14:58:00Z",
    expires_at: "2026-07-27T16:00:00Z",
    ...overrides,
  };
  return { ...unsigned, proposal_digest: canonicalRosterProposalDigest(unsigned) };
}

let db: Database.Database;
let deps: RosterAdmissionDependencies;

function observationDeps(
  base: RosterAdmissionDependencies,
  models: ModelInfo[],
): RosterAdmissionDependencies {
  const observation = serverObservation(models);
  return depsForObservation(base, observation);
}

beforeEach(() => {
  db = new Database(":memory:");
  const evidence = snapshot();
  const observation = serverObservation();
  deps = {
    readServerObservation: vi.fn(async () => structuredClone(observation)),
    withServerObservationFence: vi.fn(fenceFor(observation)),
    readEvidence: vi.fn((hash) => hash === evidence.identityHash ? structuredClone(evidence) : null),
    readCandidateTemplateIdentity: vi.fn((modelId) => {
      const identity = {
        modelId,
        digest: evidenceBundle.renderedPrompt.kind === "digest"
          ? evidenceBundle.renderedPrompt.digest
          : "",
        observedAt: "2026-07-27T14:59:00Z",
      };
      return {
        ...identity,
        identityDigest: templateIdentityDigest(identity),
      };
    }),
    resolveRestoreDescriptor: vi.fn((ref) => {
      const candidates = [
        candidate(),
        candidate({ context_length: 8_192 }),
        candidate({ model_id: "second", alias: "second", context_length: 4_096 }),
        candidate({ model_id: "fallback", alias: "fallback", context_length: 4_096 }),
        candidate({ model_id: "second", alias: "second", context_length: 8_192 }),
      ];
      const entry = candidates.find((item) => item.restore_descriptor_ref === ref);
      return entry ? descriptorFor(entry) : null;
    }),
    resolveCanary: vi.fn((id, version) => {
      const definitions = [
        canaryDefinition(),
        canaryDefinition("load", "second"),
        canaryDefinition("unload", "qwen-main"),
      ];
      return definitions.find(
        (definition) =>
          definition.registryId === id && definition.registryVersion === version,
      ) ?? null;
    }),
    now: () => new Date(now),
  };
});

describe("gille roster-proposal v1 contract", () => {
  it("materializes and accepts the gille-owned seed/interchange fixture", async () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/gille-roster-proposal-v1-seed.json", import.meta.url),
      "utf8",
    )) as {
      seed_owner: string;
      seed_version: string;
      proposal: Omit<RosterProposal, "producer" | "proposal_digest">;
    };
    expect(fixture.seed_owner).toBe("gille-inference");
    expect(fixture.seed_version).toBe("gille-roster-proposal-v1-seed");
    const unsigned: Omit<RosterProposal, "proposal_digest"> = {
      ...fixture.proposal,
      producer: {
        component: "hugin",
        instance_id: "hugin:gille-test-seed",
        serializer_version: "hugin-roster-proposal-v1",
      },
    };
    const materialized: RosterProposal = {
      ...unsigned,
      proposal_digest: canonicalRosterProposalDigest(unsigned),
    };
    const result = await admitRosterProposal(
      materialized,
      ROSTER_PROPOSAL_PRINCIPAL,
      {
        db,
        dependencies: observationDeps(deps, []),
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.record.reasonCode).toBe("BASELINE_MISMATCH");
    }
  });

  it("accepts, persists, and arms one bounded proposal without an actuator dependency", async () => {
    const result = await admitRosterProposal(proposal(), ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps });
    expect(result.kind, result.kind === "rejected" ? String(result.record.reasonCode) : result.kind).toBe("armed");
    if (result.kind !== "armed") return;
    expect(result.record.state).toBe("armed");
    expect(result.record.principalId).toBe(ROSTER_PROPOSAL_PRINCIPAL);
    expect(result.record.baselineSnapshot.entries).toEqual([{
      model_id: "qwen-main",
      alias: "qwen-main",
      context_length: 8_192,
      artifact_digest: contentDigest("artifact"),
      serving_config_digest: contentDigest("candidate-config"),
      template_digest: contentDigest("template"),
      quantization: "q4-k-m",
      evidence_identity_hash: evidenceIdentityHash(evidenceBundle),
      restore_descriptor_ref: contentDigest("restore-ref:qwen-main:8192"),
      restore_descriptor_digest: candidate({ context_length: 8_192 }).restore_descriptor_digest,
    }]);
    expect(result.record.baselineSnapshot.snapshot_digest).toMatch(/^sha256:/);
    expect(result.record.admissionDigest).toMatch(/^sha256:/);
    expect(rosterProposalEvents(result.record.proposalId, db).map((event) => event.state))
      .toEqual(["submitted", "accepted", "armed"]);
    expect(deps.readServerObservation).toHaveBeenCalledTimes(1);
    expect(deps.readEvidence).toHaveBeenCalledTimes(1);
  });

  it("returns the same durable row on exact retry and conflicts on changed content", async () => {
    const first = await admitRosterProposal(proposal(), ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps });
    const retry = await admitRosterProposal(proposal(), ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps });
    expect(retry.kind).toBe("existing");
    if (first.kind === "armed" && retry.kind === "existing") {
      expect(retry.record.recordId).toBe(first.record.recordId);
    }
    expect(deps.readServerObservation).toHaveBeenCalledTimes(1);

    const changed = proposal({
      canary: {
        ...proposal().canary,
        max_requests: 4,
      },
    });
    expect(
      await admitRosterProposal(changed, ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps }),
    ).toEqual({ kind: "conflict" });
  });

  it("binds authenticated transport independently of producer/caller strings", async () => {
    await expect(
      admitRosterProposal(proposal(), "service:not-hugin", { db, dependencies: deps }),
    ).rejects.toBeInstanceOf(RosterProposalContractError);
    expect(getRosterProposalForPrincipal(ROSTER_PROPOSAL_PRINCIPAL, proposal().proposal_id, db)).toBeNull();
  });

  it("rejects unknown fields, digest drift, redundant .000Z, and impossible timestamps", async () => {
    const unknown = { ...proposal(), apply: true };
    await expect(admitRosterProposal(unknown, ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps }))
      .rejects.toBeInstanceOf(RosterProposalContractError);

    const drifted = { ...proposal(), proposal_digest: contentDigest("wrong") };
    await expect(admitRosterProposal(drifted, ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps }))
      .rejects.toThrow("proposal digest mismatch");

    expect(isCanonicalRosterUtc("2026-07-27T15:00:00Z")).toBe(true);
    expect(isCanonicalRosterUtc("2026-07-27T15:00:00.001Z")).toBe(true);
    expect(isCanonicalRosterUtc("2026-07-27T15:00:00.000Z")).toBe(false);
    expect(isCanonicalRosterUtc("2026-02-31T15:00:00Z")).toBe(false);
  });

  it("rejects duplicate identities and non-canonical candidate ordering", async () => {
    const duplicateAliasEntries = [
      candidate({ model_id: "a-model", alias: "same" }),
      candidate({ model_id: "b-model", alias: "same" }),
    ];
    await expect(
      admitRosterProposal(
        proposal({ candidate: { entries: duplicateAliasEntries, roster_digest: candidateRosterDigest(duplicateAliasEntries) } }),
        ROSTER_PROPOSAL_PRINCIPAL,
        { db, dependencies: deps },
      ),
    ).rejects.toThrow("duplicate aliases");

    const unsorted = [candidate({ model_id: "z-model", alias: "z-model" }), candidate({ model_id: "a-model", alias: "a-model" })];
    await expect(
      admitRosterProposal(
        proposal({ candidate: { entries: unsorted, roster_digest: candidateRosterDigest(unsorted) } }),
        ROSTER_PROPOSAL_PRINCIPAL,
        { db, dependencies: deps },
      ),
    ).rejects.toThrow("canonical-sort");
  });
});

describe("fail-closed admission and durable lifecycle", () => {
  async function reasonFor(
    input: RosterProposal = proposal(),
    customDeps: RosterAdmissionDependencies = deps,
  ): Promise<string | null> {
    const result = await admitRosterProposal(input, ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: customDeps });
    expect(result.kind).toBe("rejected");
    return result.kind === "rejected" ? result.record.reasonCode : null;
  }

  it("durably rejects catalogue outage and baseline mismatch", async () => {
    const outage = {
      ...deps,
      readServerObservation: async () => { throw new Error("offline"); },
    };
    expect(await reasonFor(proposal(), outage)).toBe("ROSTER_OBSERVER_UNAVAILABLE");
    expect(rosterProposalEvents(proposal().proposal_id, db).map((event) => event.state))
      .toEqual(["submitted", "rejected"]);

    db = new Database(":memory:");
    const mismatch = proposal({
      proposal_id: "proposal:w5:baseline",
      idempotency_key: "idem:w5:baseline",
      baseline: {
        ...proposal().baseline,
        catalogue_digest: contentDigest("stale"),
      },
    });
    expect(await reasonFor(mismatch)).toBe("BASELINE_MISMATCH");
  });

  it.each([
    ["unknown model", candidate({ model_id: "unknown", alias: "unknown" }), "UNKNOWN_MODEL"],
    ["unverifiable artifact", candidate({ model_id: "qwen-main", alias: "qwen-main" }), "NON_RESIDENT_MODEL"],
  ])("rejects %s", async (_label, entry, reason) => {
    const models = liveModels;
    const baseline = liveCatalogueIdentity(models);
    const custom = proposal({
      baseline: {
        catalogue_digest: baseline.catalogueDigest,
        roster_digest: candidateRosterDigest([candidate({ context_length: 8_192 })]),
      },
      candidate: { entries: [entry], roster_digest: candidateRosterDigest([entry]) },
      canary: { ...proposal().canary, model_id: entry.model_id },
    });
    const incompleteArtifact = buildEvidenceIdentityBundle({
      ...evidenceBundle,
      modelArtifact: labelIdentity("unverified-artifact", "operator-declared"),
    });
    const customDeps = reason === "NON_RESIDENT_MODEL"
      ? { ...observationDeps(deps, models), readEvidence: () => snapshot(incompleteArtifact) }
      : observationDeps(deps, models);
    expect(await reasonFor(custom, customDeps)).toBe(
      reason === "NON_RESIDENT_MODEL" ? "EVIDENCE_SNAPSHOT_INVALID" : reason,
    );
  });

  it("admits one known unloaded catalogue addition with fresh exact artifact evidence", async () => {
    const second: ModelInfo = {
      key: "second",
      type: "llm",
      displayName: "Second",
      loaded: false,
      loadedContext: null,
      quantization: "q4-k-m",
    };
    const models = [...liveModels, second];
    const baseline = liveCatalogueIdentity(models);
    const unchanged = candidate({ context_length: 8_192 });
    const added = candidate({ model_id: "second", alias: "second", context_length: 4_096 });
    const entries = [unchanged, added];
    const input = proposal({
      proposal_id: "proposal:w5:add",
      idempotency_key: "idem:w5:add",
      baseline: {
        catalogue_digest: baseline.catalogueDigest,
        roster_digest: candidateRosterDigest([unchanged]),
      },
      candidate: { entries, roster_digest: candidateRosterDigest(entries) },
      canary: {
        ...proposal().canary,
        operation: "load",
        model_id: "second",
        registry_id: canaryDefinition("load", "second").registryId,
        registry_version: canaryDefinition("load", "second").registryVersion,
        registry_digest: canaryDefinition("load", "second").registryDigest,
      },
      delta: {
        operation: "load",
        model_id: "second",
        backend: "lmstudio",
        backend_capability_digest: backendCapabilityIdentity("lmstudio").capabilityDigest,
      },
    });
    const result = await admitRosterProposal(input, ROSTER_PROPOSAL_PRINCIPAL, {
      db,
      dependencies: observationDeps(deps, models),
    });
    expect(
      result.kind,
      result.kind === "rejected" ? String(result.record.reasonCode) : result.kind,
    ).toBe("armed");
  });

  it("admits one bounded removal with an unchanged pre-registered fallback", async () => {
    const fallback: ModelInfo = {
      key: "fallback",
      type: "llm",
      displayName: "Fallback",
      loaded: true,
      loadedContext: 4_096,
      quantization: "q4-k-m",
    };
    const models = [fallback, ...liveModels];
    const baseline = liveCatalogueIdentity(models);
    const remaining = candidate({ model_id: "fallback", alias: "fallback", context_length: 4_096 });
    const input = proposal({
      proposal_id: "proposal:w5:remove",
      idempotency_key: "idem:w5:remove",
      baseline: {
        catalogue_digest: baseline.catalogueDigest,
        roster_digest: candidateRosterDigest([
          candidate({ model_id: "fallback", alias: "fallback", context_length: 4_096 }),
          candidate({ context_length: 8_192 }),
        ]),
      },
      candidate: { entries: [remaining], roster_digest: candidateRosterDigest([remaining]) },
      canary: {
        ...proposal().canary,
        operation: "unload",
        model_id: "qwen-main",
        expected_state: "absent",
        fallback_model_id: "fallback",
        registry_id: canaryDefinition("unload", "qwen-main").registryId,
        registry_version: canaryDefinition("unload", "qwen-main").registryVersion,
        registry_digest: canaryDefinition("unload", "qwen-main").registryDigest,
      },
      delta: {
        operation: "unload",
        model_id: "qwen-main",
        backend: "lmstudio",
        backend_capability_digest: backendCapabilityIdentity("lmstudio").capabilityDigest,
      },
    });
    const result = await admitRosterProposal(input, ROSTER_PROPOSAL_PRINCIPAL, {
      db,
      dependencies: observationDeps(deps, models),
    });
    expect(result.kind).toBe("armed");
  });

  it("rejects a reload when its prior desired entry is no longer resolvable", async () => {
    const baselineRef = candidate({ context_length: 8_192 }).restore_descriptor_ref;
    expect(await reasonFor(proposal(), {
      ...deps,
      resolveRestoreDescriptor: (ref) =>
        ref === baselineRef ? null : deps.resolveRestoreDescriptor(ref),
    })).toBe("BASELINE_RESTORE_UNAVAILABLE");
  });

  it("rejects stale or nonresident prior state before admitting an unload", async () => {
    const fallback: ModelInfo = {
      key: "fallback",
      type: "llm",
      displayName: "Fallback",
      loaded: true,
      loadedContext: 4_096,
      quantization: "q4-k-m",
    };
    const models = [fallback, ...liveModels];
    const baseline = liveCatalogueIdentity(models);
    const remaining = candidate({
      model_id: "fallback",
      alias: "fallback",
      context_length: 4_096,
    });
    const registry = canaryDefinition("unload", "qwen-main");
    const input = proposal({
      proposal_id: "proposal:w5:baseline-unload",
      idempotency_key: "idem:w5:baseline-unload",
      baseline: {
        catalogue_digest: baseline.catalogueDigest,
        roster_digest: candidateRosterDigest([
          remaining,
          candidate({ context_length: 8_192 }),
        ]),
      },
      candidate: {
        entries: [remaining],
        roster_digest: candidateRosterDigest([remaining]),
      },
      delta: {
        operation: "unload",
        model_id: "qwen-main",
        backend: "lmstudio",
        backend_capability_digest: backendCapabilityIdentity("lmstudio").capabilityDigest,
      },
      canary: {
        ...proposal().canary,
        operation: "unload",
        model_id: "qwen-main",
        expected_state: "absent",
        fallback_model_id: "fallback",
        registry_id: registry.registryId,
        registry_version: registry.registryVersion,
        registry_digest: registry.registryDigest,
      },
    });
    const observed = observationDeps(deps, models);
    const baselineRef = candidate({ context_length: 8_192 }).restore_descriptor_ref;
    expect(await reasonFor(input, {
      ...observed,
      resolveRestoreDescriptor: (ref) => {
        const descriptor = observed.resolveRestoreDescriptor(ref);
        if (!descriptor || ref !== baselineRef) return descriptor;
        const stale = { ...descriptor, alias: "stale-alias" };
        return {
          ...stale,
          digest: restoreDescriptorDigest(stale),
        };
      },
    })).toBe("BASELINE_RESTORE_MISMATCH");

    db = new Database(":memory:");
    const staleObservation = serverObservation(models, {
      resident_model_ids: ["fallback"],
      running_model_ids: ["fallback"],
    });
    expect(await reasonFor(input, {
      ...depsForObservation(observed, staleObservation),
    })).toBe("BASELINE_NON_RESIDENT");
  });

  it.each(["model id", "alias"])(
    "rejects duplicate desired-roster %s identities",
    async (duplicateKind) => {
      const second: ModelInfo = {
        key: "second",
        type: "llm",
        displayName: "Second",
        loaded: false,
        loadedContext: null,
        quantization: "q4-k-m",
      };
      const models = [...liveModels, second];
      const firstEntry = candidate({ context_length: 8_192 });
      const secondEntry = duplicateKind === "model id"
        ? firstEntry
        : candidate({
          model_id: "second",
          alias: "qwen-main",
          context_length: 4_096,
        });
      const desired = [firstEntry, secondEntry].map((entry) => ({
        model_id: entry.model_id,
        alias: entry.alias,
        context_length: entry.context_length,
        artifact_digest: entry.artifact_digest,
        serving_config_digest: entry.serving_config_digest,
        template_digest: entry.template_digest,
        quantization: entry.quantization,
        evidence_identity_hash: entry.evidence_identity_hash,
        restore_descriptor_ref: entry.restore_descriptor_ref,
        restore_descriptor_digest: entry.restore_descriptor_digest,
      }));
      const baseline = liveCatalogueIdentity(models);
      const input = proposal({
        proposal_id: `proposal:w5:duplicate-${duplicateKind.replace(" ", "-")}`,
        idempotency_key: `idem:w5:duplicate-${duplicateKind.replace(" ", "-")}`,
        baseline: {
          catalogue_digest: baseline.catalogueDigest,
          roster_digest: candidateRosterDigest([firstEntry, secondEntry]),
        },
      });
      const observation = serverObservation(models, {
        desired_roster: desired,
        resident_model_ids: ["qwen-main", "second"],
      });
      expect(await reasonFor(
        input,
        depsForObservation(deps, observation),
      )).toBe("BASELINE_DUPLICATE");
    },
  );

  it("rejects duplicate catalogue keys and running models outside residency", async () => {
    const base = serverObservation();
    const duplicateCatalogue = serverObservation(liveModels, {
      catalogue: [...base.catalogue, { ...base.catalogue[0]! }],
    });
    expect(await reasonFor(
      proposal(),
      depsForObservation(deps, duplicateCatalogue),
    )).toBe("ROSTER_OBSERVATION_INVALID");

    db = new Database(":memory:");
    const second: ModelInfo = {
      key: "second",
      type: "llm",
      displayName: "Second",
      loaded: false,
      loadedContext: null,
      quantization: "q4-k-m",
    };
    const invalidRuntime = serverObservation([...liveModels, second], {
      resident_model_ids: ["qwen-main"],
      running_model_ids: ["qwen-main", "second"],
    });
    expect(await reasonFor(
      proposal({
        baseline: {
          ...proposal().baseline,
          catalogue_digest: liveCatalogueIdentity([...liveModels, second]).catalogueDigest,
        },
      }),
      depsForObservation(deps, invalidRuntime),
    )).toBe("ROSTER_OBSERVATION_INVALID");
  });

  it.each([
    ["digest drift", () => ({
      ...serverObservation(),
      observation_digest: contentDigest("wrong-observation"),
    })],
    ["unknown field", () => ({
      ...serverObservation(),
      private_locator: "/must/not/cross",
    })],
    ["noncanonical observation time", () => {
      const base = serverObservation();
      const { observation_digest: _oldDigest, ...unsigned } = {
        ...base,
        observed_at: "2026-07-27T14:59:30.000Z",
      };
      return {
        ...unsigned,
        observation_digest: serverRosterObservationDigest(unsigned),
      };
    }],
    ["future observation time", () => {
      const base = serverObservation();
      const { observation_digest: _oldDigest, ...unsigned } = {
        ...base,
        observed_at: "2026-07-27T15:00:06Z",
      };
      return {
        ...unsigned,
        observation_digest: serverRosterObservationDigest(unsigned),
      };
    }],
    ["desired roster overflow", () => {
      const base = serverObservation();
      const unsigned = {
        ...base,
        desired_roster: Array.from({ length: 65 }, (_, index) => ({
          ...base.desired_roster[0]!,
          model_id: `model:${String(index).padStart(3, "0")}`,
          alias: `alias:${String(index).padStart(3, "0")}`,
        })),
      };
      const { observation_digest: _oldDigest, ...withoutDigest } = unsigned;
      return {
        ...withoutDigest,
        observation_digest: serverRosterObservationDigest(withoutDigest),
      };
    }],
  ])("rejects closed observation %s", async (_label, makeObservation) => {
    expect(await reasonFor(proposal(), {
      ...deps,
      readServerObservation: async () => makeObservation(),
    })).toBe("ROSTER_OBSERVATION_INVALID");
  });

  it("rejects a self-consistent but noncanonical backend capability claim", async () => {
    const maliciousCapability = {
      schema_version: "gille-roster-backend-capability-v1" as const,
      backend: "llamaswap" as const,
      supported_operations: ["load", "unload", "reload-config"] as const,
      alias_control: false,
      context_control: false,
    };
    const maliciousDigest = rosterDigest(maliciousCapability);
    const observation = serverObservation(liveModels, {
      backend_capability: {
        backend: "llamaswap",
        supported_operations: [...maliciousCapability.supported_operations],
        alias_control: false,
        context_control: false,
        capability_digest: maliciousDigest,
      },
    });
    const input = proposal({
      delta: {
        operation: "reload-config",
        model_id: "qwen-main",
        backend: "llamaswap",
        backend_capability_digest: maliciousDigest,
      },
    });
    expect(await reasonFor(
      input,
      depsForObservation(deps, observation),
    )).toBe("BACKEND_CAPABILITY_MISMATCH");
  });

  it("rejects a backend-unsupported reload/config mutation", async () => {
    const capability = backendCapabilityIdentity("llamaswap");
    const input = proposal({
      delta: {
        operation: "reload-config",
        model_id: "qwen-main",
        backend: "llamaswap",
        backend_capability_digest: capability.capabilityDigest,
      },
      canary: {
        ...proposal().canary,
        operation: "reload-config",
      },
    });
    const observation = serverObservation(liveModels, {
      backend_capability: {
        backend: capability.backend,
        supported_operations: [...capability.supportedOperations],
        alias_control: capability.aliasControl,
        context_control: capability.contextControl,
        capability_digest: capability.capabilityDigest,
      },
    });
    expect(await reasonFor(
      input,
      depsForObservation(deps, observation),
    )).toBe("UNSUPPORTED_OPERATION");
  });

  it("rejects missing, incomplete, stale, and mismatched evidence", async () => {
    expect(await reasonFor(proposal(), { ...deps, readEvidence: () => null })).toBe("EVIDENCE_MISSING");

    db = new Database(":memory:");
    const incomplete = snapshot(buildEvidenceIdentityBundle({ modelArtifact: evidenceBundle.modelArtifact }));
    expect(await reasonFor(proposal(), { ...deps, readEvidence: () => incomplete }))
      .toBe("EVIDENCE_SNAPSHOT_INVALID");

    db = new Database(":memory:");
    expect(await reasonFor(proposal(), {
      ...deps,
      readEvidence: () => ({
        ...snapshot(evidenceBundle, "2026-07-27T12:00:00Z"),
        firstSeenAt: "2026-07-27T11:00:00Z",
      }),
    }))
      .toBe("EVIDENCE_STALE");

    db = new Database(":memory:");
    const mismatched = proposal({
      candidate: {
        entries: [candidate({ serving_config_digest: contentDigest("other-config") })],
        roster_digest: candidateRosterDigest([candidate({ serving_config_digest: contentDigest("other-config") })]),
      },
    });
    expect(await reasonFor(mismatched)).toBe("EVIDENCE_IDENTITY_MISMATCH");
  });

  it.each([
    ["returned hash", {
      ...snapshot(),
      identityHash: contentDigest("wrong-returned-hash"),
    }],
    ["bundle hash", {
      ...snapshot(),
      bundle: buildEvidenceIdentityBundle({
        ...evidenceBundle,
        configEpoch: digestIdentity({
          id: "llama-swap-config",
          version: "v2",
          digest: contentDigest("different-bundle"),
          origin: "server-observed",
        }),
      }),
    }],
    ["noncanonical metadata", {
      ...snapshot(),
      firstSeenAt: "2026-07-27T14:00:00.000Z",
    }],
    ["regressed metadata", {
      ...snapshot(),
      firstSeenAt: "2026-07-27T15:00:00Z",
      lastSeenAt: "2026-07-27T14:59:00Z",
    }],
    ["invalid count", {
      ...snapshot(),
      observationCount: 0,
    }],
  ])("rejects an invalid evidence snapshot: %s", async (_label, evidence) => {
    expect(await reasonFor(proposal(), {
      ...deps,
      readEvidence: () => evidence,
    })).toBe("EVIDENCE_SNAPSHOT_INVALID");
  });

  it("re-samples the protected clock after providers and rejects crossing expiry", async () => {
    const clock = [
      new Date("2026-07-27T14:59:59Z"),
      new Date("2026-07-27T15:00:01Z"),
    ];
    const input = proposal({
      proposal_id: "proposal:w5:provider-expiry",
      idempotency_key: "idem:w5:provider-expiry",
      expires_at: "2026-07-27T15:00:00Z",
    });
    const result = await admitRosterProposal(input, ROSTER_PROPOSAL_PRINCIPAL, {
      db,
      dependencies: {
        ...deps,
        readServerObservation: async () => {
          await Promise.resolve();
          return structuredClone(serverObservation());
        },
        now: () => clock.shift() ?? new Date("2026-07-27T15:00:01Z"),
      },
    });
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.record.reasonCode).toBe("PROPOSAL_EXPIRED");
      expect(result.record.updatedAt).toBe("2026-07-27T15:00:01Z");
      expect(result.record.baselineSnapshot?.observed_at)
        .toBe("2026-07-27T14:59:30Z");
      expect(result.record.decisionAt).toBe("2026-07-27T15:00:01Z");
    }
  });

  it.each([
    ["new epoch", (initial: ServerRosterObservation) => ({
      ...tokenFor(initial),
      observation_epoch: "epoch:test:v2",
    })],
    ["new digest", (initial: ServerRosterObservation) => ({
      ...tokenFor(initial),
      observation_digest: contentDigest("changed-observation"),
    })],
    ["malformed token", (_initial: ServerRosterObservation) => ({})],
  ])("rejects a fenced pre-commit %s without arming", async (caseName, confirmedTokenForCase) => {
    const initial = serverObservation();
    const id = caseName.replace(" ", "-");
    const result = await admitRosterProposal(
      proposal({
        proposal_id: `proposal:w5:fence-${id}`,
        idempotency_key: `idem:w5:fence-${id}`,
      }),
      ROSTER_PROPOSAL_PRINCIPAL,
      {
        db,
        dependencies: {
          ...depsForObservation(deps, initial),
          withServerObservationFence: <T>(
            _expected: ServerRosterObservationToken,
            callback: (rawConfirmedToken: unknown) => T,
          ): T => callback(confirmedTokenForCase(initial)),
        },
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.record.reasonCode).toBe(
        caseName === "malformed token"
          ? "OBSERVATION_REVALIDATION_UNAVAILABLE"
          : "OBSERVATION_CHANGED",
      );
      expect(result.record.state).toBe("rejected");
      expect(result.record.baselineSnapshot?.observation_epoch)
        .toBe(initial.observation_epoch);
    }
    expect(rosterProposalEvents(`proposal:w5:fence-${id}`, db))
      .toEqual([
        { sequence: 1, state: "submitted", reasonCode: null },
        {
          sequence: 2,
          state: "rejected",
          reasonCode: caseName === "malformed token"
            ? "OBSERVATION_REVALIDATION_UNAVAILABLE"
            : "OBSERVATION_CHANGED",
        },
      ]);
  });

  it("prevents a retained fence callback from mutating after the provider returns", async () => {
    const observation = serverObservation();
    let retained: ((confirmedToken: unknown) => unknown) | null = null;
    const result = await admitRosterProposal(
      proposal({
        proposal_id: "proposal:w5:fence-retained",
        idempotency_key: "idem:w5:fence-retained",
      }),
      ROSTER_PROPOSAL_PRINCIPAL,
      {
        db,
        dependencies: {
          ...depsForObservation(deps, observation),
          withServerObservationFence: <T>(
            _expected: ServerRosterObservationToken,
            callback: (confirmedToken: unknown) => T,
          ): T => {
            retained = callback as (confirmedToken: unknown) => unknown;
            return undefined as T;
          },
        },
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.record.reasonCode)
        .toBe("OBSERVATION_REVALIDATION_UNAVAILABLE");
    }
    expect(retained).not.toBeNull();
    expect(() => retained!(tokenFor(observation)))
      .toThrow("escaped its synchronous lifetime");
    const persisted = getRosterProposalForPrincipal(
      ROSTER_PROPOSAL_PRINCIPAL,
      "proposal:w5:fence-retained",
      db,
      new Date(now),
    );
    expect(persisted?.state).toBe("rejected");
    expect(rosterProposalEvents("proposal:w5:fence-retained", db))
      .toHaveLength(2);
  });

  it("rolls back an armed callback when a provider invokes the fence twice", async () => {
    const observation = serverObservation();
    const result = await admitRosterProposal(
      proposal({
        proposal_id: "proposal:w5:fence-twice",
        idempotency_key: "idem:w5:fence-twice",
      }),
      ROSTER_PROPOSAL_PRINCIPAL,
      {
        db,
        dependencies: {
          ...depsForObservation(deps, observation),
          withServerObservationFence: <T>(
            _expected: ServerRosterObservationToken,
            callback: (confirmedToken: unknown) => T,
          ): T => {
            callback(tokenFor(observation));
            return callback(tokenFor(observation));
          },
        },
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.record.reasonCode)
        .toBe("OBSERVATION_REVALIDATION_UNAVAILABLE");
      expect(result.record.state).toBe("rejected");
    }
    expect(rosterProposalEvents("proposal:w5:fence-twice", db)
      .map((event) => event.state))
      .toEqual(["submitted", "rejected"]);
  });

  it("rolls back an armed callback when a provider returns a thenable", async () => {
    const observation = serverObservation();
    const result = await admitRosterProposal(
      proposal({
        proposal_id: "proposal:w5:fence-thenable",
        idempotency_key: "idem:w5:fence-thenable",
      }),
      ROSTER_PROPOSAL_PRINCIPAL,
      {
        db,
        dependencies: {
          ...depsForObservation(deps, observation),
          withServerObservationFence: <T>(
            _expected: ServerRosterObservationToken,
            callback: (confirmedToken: unknown) => T,
          ): T => {
            callback(tokenFor(observation));
            return Promise.resolve(undefined) as T;
          },
        },
      },
    );
    expect(result.kind).toBe("rejected");
    if (result.kind === "rejected") {
      expect(result.record.reasonCode)
        .toBe("OBSERVATION_REVALIDATION_UNAVAILABLE");
      expect(result.record.state).toBe("rejected");
    }
    const events = rosterProposalEvents("proposal:w5:fence-thenable", db);
    expect(events).toEqual([
      { sequence: 1, state: "submitted", reasonCode: null },
      {
        sequence: 2,
        state: "rejected",
        reasonCode: "OBSERVATION_REVALIDATION_UNAVAILABLE",
      },
    ]);
    expect(events.some((event) => event.state === "armed")).toBe(false);
  });

  it("rejects an incoherent protected clock before any decision write", async () => {
    const clock = [
      new Date("2026-07-27T15:00:00Z"),
      new Date("2026-07-27T14:59:59Z"),
    ];
    await expect(
      admitRosterProposal(proposal(), ROSTER_PROPOSAL_PRINCIPAL, {
        db,
        dependencies: {
          ...deps,
          now: () => clock.shift() ?? new Date("2026-07-27T14:59:59Z"),
        },
      }),
    ).rejects.toThrow("protected admission clock became incoherent");
    expect(
      getRosterProposalForPrincipal(
        ROSTER_PROPOSAL_PRINCIPAL,
        proposal().proposal_id,
        db,
        new Date(now),
      ),
    ).toBeNull();
  });

  it("rejects excessive candidate delta and a canary outside the changed entry", async () => {
    const second: ModelInfo = {
      key: "second",
      type: "llm",
      displayName: "Second",
      loaded: true,
      loadedContext: 4_096,
      quantization: "q4-k-m",
    };
    const models = [...liveModels, second];
    const baseline = liveCatalogueIdentity(models);
    const entries = [
      candidate(),
      candidate({ model_id: "second", alias: "second", context_length: 8_192 }),
    ];
    const excessive = proposal({
      baseline: {
        catalogue_digest: baseline.catalogueDigest,
        roster_digest: candidateRosterDigest([
          candidate({ context_length: 8_192 }),
          candidate({ model_id: "second", alias: "second", context_length: 4_096 }),
        ]),
      },
      candidate: { entries, roster_digest: candidateRosterDigest(entries) },
    });
    expect(await reasonFor(excessive, observationDeps(deps, models))).toBe("BOUNDS_EXCEEDED");

    db = new Database(":memory:");
    const unchangedSecond = candidate({ model_id: "second", alias: "second", context_length: 4_096 });
    const oneChange = [candidate(), unchangedSecond];
    const wrongCanary = proposal({
      baseline: {
        catalogue_digest: baseline.catalogueDigest,
        roster_digest: candidateRosterDigest([
          candidate({ context_length: 8_192 }),
          unchangedSecond,
        ]),
      },
      candidate: { entries: oneChange, roster_digest: candidateRosterDigest(oneChange) },
      canary: { ...proposal().canary, model_id: "second" },
    });
    expect(await reasonFor(wrongCanary, observationDeps(deps, models))).toBe("CANARY_OUTSIDE_CHANGE");
  });

  it("allows only one armed proposal and automatically expires it durably across reopen", async () => {
    const first = await admitRosterProposal(proposal(), ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps });
    expect(first.kind).toBe("armed");
    const second = proposal({
      proposal_id: "proposal:w5:002",
      idempotency_key: "idem:w5:002",
    });
    expect(await reasonFor(second)).toBe("ACTIVE_PROPOSAL_EXISTS");

    expect(expireRosterProposals(new Date("2026-07-27T16:00:01Z"), db)).toBe(1);
    const expired = getRosterProposalForPrincipal(
      ROSTER_PROPOSAL_PRINCIPAL,
      proposal().proposal_id,
      db,
      new Date("2026-07-27T16:00:01Z"),
    );
    expect(expired?.state).toBe("expired");
    expect(expired?.reasonCode).toBe("TTL_EXPIRED");
    expect(expired?.decisionAt).toBe(now);
    expect(expired?.updatedAt).toBe("2026-07-27T16:00:01Z");
    expect(rosterProposalEvents(proposal().proposal_id, db).map((event) => event.state))
      .toEqual(["submitted", "accepted", "armed", "expired"]);
  });

  it("never exposes another principal's proposal through the scoped read", async () => {
    await admitRosterProposal(proposal(), ROSTER_PROPOSAL_PRINCIPAL, { db, dependencies: deps });
    expect(getRosterProposalForPrincipal("service:other", proposal().proposal_id, db)).toBeNull();
  });

  it("fails closed when observer, restore, or canary registries are unavailable", async () => {
    expect(await reasonFor(proposal(), {
      ...deps,
      readServerObservation: async () => null,
    })).toBe("ROSTER_OBSERVER_UNAVAILABLE");

    db = new Database(":memory:");
    const baselineRef = candidate({ context_length: 8_192 }).restore_descriptor_ref;
    expect(await reasonFor(proposal(), {
      ...deps,
      resolveRestoreDescriptor: (ref) =>
        ref === baselineRef ? deps.resolveRestoreDescriptor(ref) : null,
    })).toBe("RESTORE_DESCRIPTOR_UNAVAILABLE");

    db = new Database(":memory:");
    expect(await reasonFor(proposal(), {
      ...deps,
      resolveCanary: () => null,
    })).toBe("CANARY_REGISTRY_UNAVAILABLE");
  });

  it("recovers an exact retry across credential rotation while retaining the original audit binding", async () => {
    const first = await admitRosterProposal(
      proposal(),
      ROSTER_PROPOSAL_PRINCIPAL,
      { db, dependencies: deps },
    );
    expect(first.kind).toBe("armed");
    if (first.kind !== "armed") return;
    expect(first.record.credentialBindingDigest).toBe(credentialBindingDigest);

    const rotated = await admitRosterProposalImpl(
      proposal(),
      ROSTER_PROPOSAL_PRINCIPAL,
      {
        db,
        dependencies: deps,
        credentialBindingDigest: contentDigest("credential:hugin:rotated"),
      },
    );
    expect(rotated.kind).toBe("existing");
    if (rotated.kind === "existing") {
      expect(rotated.record.recordId).toBe(first.record.recordId);
      expect(rotated.record.credentialBindingDigest).toBe(credentialBindingDigest);
    }
  });

  it("detects durable row corruption and expires by numeric epoch", async () => {
    const input = proposal({
      expires_at: "2026-07-27T15:00:00.001Z",
    });
    const armed = await admitRosterProposal(
      input,
      ROSTER_PROPOSAL_PRINCIPAL,
      { db, dependencies: deps },
    );
    expect(armed.kind).toBe("armed");
    expect(expireRosterProposals(new Date("2026-07-27T15:00:00Z"), db)).toBe(0);
    expect(expireRosterProposals(new Date("2026-07-27T15:00:00.002Z"), db)).toBe(1);

    db.prepare(`
      UPDATE roster_proposals
         SET delta_json = '{"operation":"load"}'
       WHERE proposal_id = ?
    `).run(input.proposal_id);
    expect(() =>
      getRosterProposalForPrincipal(
        ROSTER_PROPOSAL_PRINCIPAL,
        input.proposal_id,
        db,
        new Date("2026-07-27T15:00:00.002Z"),
      ),
    ).toThrow("durable roster proposal is invalid");
  });

  it("fails closed on event-tail corruption during own-read", async () => {
    await admitRosterProposal(
      proposal(),
      ROSTER_PROPOSAL_PRINCIPAL,
      { db, dependencies: deps },
    );
    db.prepare(`
      DELETE FROM roster_proposal_events
       WHERE proposal_id = ? AND state = 'armed'
    `).run(proposal().proposal_id);
    expect(() =>
      getRosterProposalForPrincipal(
        ROSTER_PROPOSAL_PRINCIPAL,
        proposal().proposal_id,
        db,
        new Date(now),
      ),
    ).toThrow("durable roster proposal is invalid");
  });

  it.each(["submitted", "accepted", "armed"])(
    "fails closed when the %s event carries a reason",
    async (state) => {
      await admitRosterProposal(
        proposal(),
        ROSTER_PROPOSAL_PRINCIPAL,
        { db, dependencies: deps },
      );
      db.prepare(`
        UPDATE roster_proposal_events
           SET reason_code = 'tampered'
         WHERE proposal_id = ? AND state = ?
      `).run(proposal().proposal_id, state);
      expect(() =>
        getRosterProposalForPrincipal(
          ROSTER_PROPOSAL_PRINCIPAL,
          proposal().proposal_id,
          db,
          new Date(now),
        ),
      ).toThrow("durable roster proposal is invalid");
    },
  );

  it.each([
    ["noncanonical", "submitted", "2026-07-27T15:00:00.000Z"],
    ["backdated", "accepted", "2026-07-27T14:59:59Z"],
    ["terminal mismatch", "armed", "2026-07-27T15:00:01Z"],
  ])(
    "fails closed on %s lifecycle event time",
    async (_label, state, recordedAt) => {
      await admitRosterProposal(
        proposal(),
        ROSTER_PROPOSAL_PRINCIPAL,
        { db, dependencies: deps },
      );
      db.prepare(`
        UPDATE roster_proposal_events
           SET recorded_at = ?
         WHERE proposal_id = ? AND state = ?
      `).run(recordedAt, proposal().proposal_id, state);
      expect(() =>
        getRosterProposalForPrincipal(
          ROSTER_PROPOSAL_PRINCIPAL,
          proposal().proposal_id,
          db,
          new Date(now),
        ),
      ).toThrow("durable roster proposal is invalid");
    },
  );

  it("prevalidates a due record before expiry so corruption cannot be repaired", async () => {
    const input = proposal({ expires_at: "2026-07-27T15:00:01Z" });
    await admitRosterProposal(
      input,
      ROSTER_PROPOSAL_PRINCIPAL,
      { db, dependencies: deps },
    );
    db.prepare(`
      UPDATE roster_proposal_events
         SET reason_code = 'tampered'
       WHERE proposal_id = ? AND state = 'submitted'
    `).run(input.proposal_id);
    expect(() =>
      expireRosterProposals(new Date("2026-07-27T15:00:02Z"), db),
    ).toThrow("durable roster proposal is invalid");
    expect(
      (db.prepare(`
        SELECT state FROM roster_proposals WHERE proposal_id = ?
      `).get(input.proposal_id) as { state: string }).state,
    ).toBe("armed");
  });

  it("fails closed on mirrored credential/timestamp corruption during exact retry", async () => {
    await admitRosterProposal(
      proposal(),
      ROSTER_PROPOSAL_PRINCIPAL,
      { db, dependencies: deps },
    );
    db.prepare(`
      UPDATE roster_proposals
         SET credential_binding_digest = ?,
             expires_at_ms = expires_at_ms + 1
       WHERE proposal_id = ?
    `).run(contentDigest("tampered-credential"), proposal().proposal_id);
    await expect(
      admitRosterProposal(
        proposal(),
        ROSTER_PROPOSAL_PRINCIPAL,
        { db, dependencies: deps },
      ),
    ).rejects.toThrow("durable roster proposal is invalid");
  });
});
