import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initDb } from "../src/db.js";
import {
  buildEvidenceIdentityBundle,
  contentDigest,
  digestIdentity,
  labelIdentity,
} from "../src/homeserver/evidence-identity.js";
import {
  getEvidenceIdentitySnapshot,
  upsertEvidenceIdentitySnapshot,
} from "../src/homeserver/evidence-identity-store.js";
import {
  ROSTER_PROPOSAL_CONTRACT_VERSION,
  ROSTER_PROPOSAL_POLICY_EPOCH,
  ROSTER_PROPOSAL_PRINCIPAL,
  ROSTER_PROPOSAL_SCHEMA_EPOCH,
  backendCapabilityIdentity,
  candidateRosterDigest,
  canonicalRosterProposalDigest,
  canaryRegistryDigest,
  combinedRosterBaselineDigest,
  liveCatalogueIdentity,
  serverRosterObservationDigest,
  templateIdentityDigest,
  restoreDescriptorDigest,
  type RosterAdmissionDependencies,
  type RosterCandidateEntry,
  type RosterProposal,
  type ServerCanaryDefinition,
  type ServerRestoreDescriptor,
  type ServerRosterObservation,
  type ServerRosterObservationToken,
} from "../src/homeserver/roster-proposal.js";
import { jcsCanonicalize } from "../src/homeserver/learning-task-contract.js";
import { listKeys, rotateKey } from "../src/homeserver/keystore.js";

let upstream: Server;
let upstreamPort = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let serviceKey = "";
let otherOwnerKey = "";
let guestKey = "";
let proposalBody: RosterProposal;
let rosterDependencies: RosterAdmissionDependencies;
let upstreamMutations = 0;
const keyDefaults = {
  rpm: 1000,
  tpm: 1_000_000,
  dailyTokenBudget: 0,
  maxParallel: 1,
};
const huginProvenanceKeys = generateKeyPairSync("ed25519");

const models = [
  {
    key: "qwen-main",
    type: "llm",
    displayName: "Qwen Main",
    loaded: true,
    loadedContext: 8_192,
  },
  {
    key: "second",
    type: "llm",
    displayName: "Second",
    loaded: false,
    loadedContext: null,
  },
] as const;

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

function resignHuginProvenance(input: RosterProposal): RosterProposal {
  const proposal = structuredClone(input);
  proposal.provenance.source_receipt.proposalId = proposal.proposal_id;
  const {
    canonicalProposalDigest: _receiptDigest,
    signature: _receiptSignature,
    ...receiptBody
  } = proposal.provenance.source_receipt;
  proposal.provenance.source_receipt.canonicalProposalDigest = contentDigest(
    jcsCanonicalize(receiptBody),
  );
  proposal.provenance.source_receipt_digest = contentDigest(
    jcsCanonicalize(proposal.provenance.source_receipt),
  );
  const { provenance: _oldProvenance, proposal_digest: _oldProposalDigest, ...proposalContent } = proposal;
  proposal.provenance.proposal_content_digest = contentDigest(jcsCanonicalize(proposalContent));
  const { signature: _envelopeSignature, ...unsignedProvenance } = proposal.provenance;
  proposal.provenance.signature = {
    algorithm: "Ed25519",
    value_base64: sign(
      null,
      Buffer.from(jcsCanonicalize(unsignedProvenance)),
      huginProvenanceKeys.privateKey,
    ).toString("base64"),
  };
  const { proposal_digest: _digest, ...unsignedProposal } = proposal;
  return {
    ...unsignedProposal,
    proposal_digest: canonicalRosterProposalDigest(unsignedProposal),
  };
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.method !== "GET") upstreamMutations += 1;
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [
        { id: "qwen-main", object: "model" },
        { id: "second", object: "model" },
      ] }));
      return;
    }
    if (req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        running: [{
          model: "qwen-main",
          state: "ready",
          cmd: "llama-server -m /models/qwen-main.gguf -c 8192",
        }],
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => {
    upstreamPort = (upstream.address() as { port: number }).port;
    resolve();
  }));

  const dir = mkdtempSync(join(tmpdir(), "roster-proposal-gateway-"));
  initDb(join(dir, "test.db"));
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["LLAMASWAP_BASE_URL"] = `http://127.0.0.1:${upstreamPort}`;
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const { mintKey } = await import("../src/homeserver/keystore.js");
  serviceKey = mintKey({ alias: ROSTER_PROPOSAL_PRINCIPAL, tier: "owner", scope: "admin" }, keyDefaults).plaintextKey;
  otherOwnerKey = mintKey({ alias: "service:other-owner", tier: "owner", scope: "admin" }, keyDefaults).plaintextKey;
  guestKey = mintKey({ alias: "service:hugin-guest", tier: "guest" }, keyDefaults).plaintextKey;

  const bundle = buildEvidenceIdentityBundle({
    modelArtifact: digestIdentity({
      id: "/models/qwen-main.gguf",
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
  const evidenceHash = upsertEvidenceIdentitySnapshot(bundle, new Date().toISOString().replace(".000Z", "Z"));
  const artifact = bundle.modelArtifact;
  const config = bundle.configEpoch;
  const template = bundle.renderedPrompt;
  if (artifact.kind !== "digest" || config.kind !== "digest" || template.kind !== "digest") {
    throw new Error("fixture setup failed");
  }
  const entry: RosterCandidateEntry = {
    model_id: "qwen-main",
    alias: "qwen-main",
    artifact_digest: artifact.digest,
    quantization: artifact.version,
    template_digest: template.digest,
    context_length: 8_192,
    serving_config_digest: config.digest,
    evidence_identity_hash: evidenceHash,
    restore_descriptor_ref: contentDigest("restore:qwen"),
    restore_descriptor_digest: contentDigest("pending:qwen"),
  };
  const addedEntry: RosterCandidateEntry = {
    ...entry,
    model_id: "second",
    alias: "second",
    context_length: 4_096,
    restore_descriptor_ref: contentDigest("restore:second"),
    restore_descriptor_digest: contentDigest("pending:second"),
  };
  const makeDescriptor = (candidate: RosterCandidateEntry): ServerRestoreDescriptor => {
    const withoutDigest = {
      modelId: candidate.model_id,
      alias: candidate.alias,
      artifactDigest: candidate.artifact_digest,
      quantization: candidate.quantization,
      templateDigest: candidate.template_digest,
      contextLength: candidate.context_length,
      servingConfigDigest: candidate.serving_config_digest,
      evidenceIdentityHash: candidate.evidence_identity_hash,
      ref: candidate.restore_descriptor_ref,
    };
    return { ...withoutDigest, digest: restoreDescriptorDigest(withoutDigest) };
  };
  entry.restore_descriptor_digest = makeDescriptor(entry).digest;
  addedEntry.restore_descriptor_digest = makeDescriptor(addedEntry).digest;
  const canaryWithoutDigest = {
    registryId: "canary:load:second",
    registryVersion: "version:v1",
    operation: "load" as const,
    modelId: "second",
    routeDigest: contentDigest("canary-route"),
    configDigest: contentDigest("canary-config"),
    verifierDigest: contentDigest("canary-verifier"),
    postconditionsDigest: contentDigest("canary-postconditions"),
  };
  const canaryDefinition: ServerCanaryDefinition = {
    ...canaryWithoutDigest,
    registryDigest: canaryRegistryDigest(canaryWithoutDigest),
  };
  const baseline = liveCatalogueIdentity(models.map((model) => ({ ...model })));
  const created = new Date(Date.now() - 1_000).toISOString().replace(".000Z", "Z");
  const expires = new Date(Date.now() + 60_000).toISOString().replace(".000Z", "Z");
  const unsignedBase = {
    contract_version: ROSTER_PROPOSAL_CONTRACT_VERSION,
    proposal_id: "proposal:w5:http",
    idempotency_key: "idem:w5:http",
    producer: {
      component: "hugin",
      instance_id: "hugin:dispatcher:primary",
      serializer_version: "hugin-roster-proposal-v1",
    },
    expected_transport_principal_id: ROSTER_PROPOSAL_PRINCIPAL,
    axis: "served-model-roster",
    baseline: {
      catalogue_digest: baseline.catalogueDigest,
      roster_digest: candidateRosterDigest([entry]),
    },
    candidate: {
      entries: [entry, addedEntry],
      roster_digest: candidateRosterDigest([entry, addedEntry]),
    },
    delta: {
      operation: "load",
      model_id: "second",
      backend: "llamaswap",
      backend_capability_digest: backendCapabilityIdentity("llamaswap").capabilityDigest,
    },
    evidence: {
      schema_epoch: ROSTER_PROPOSAL_SCHEMA_EPOCH,
      policy_epoch: ROSTER_PROPOSAL_POLICY_EPOCH,
      freshness_seconds: 3_600,
    },
    canary: {
      operation: "load",
      model_id: "second",
      expected_state: "served",
      fallback_model_id: null,
      registry_id: "canary:load:second",
      registry_version: "version:v1",
      registry_digest: canaryDefinition.registryDigest,
      max_requests: 5,
      duration_seconds: 600,
      max_concurrency: 1,
    },
    requested_bounds: { max_changed_entries: 1 },
    requested_operations: ["admit", "arm"],
    created_at: created,
    expires_at: expires,
  };
  const receiptBody = {
    schemaVersion: "v1" as const, proposalId: unsignedBase.proposal_id, experimentRef: "ref:w5-http-fixture",
    evidenceFingerprints: [...new Set(unsignedBase.candidate.entries.map((entry) => entry.evidence_identity_hash))].sort(),
    targetId: "gille-served-model-roster" as const, axis: "served-model-roster" as const, owner: "gille-inference" as const, disposition: "proposal-only" as const,
    ownershipRegistry: { version: "v1" as const, digest: contentDigest("hugin-w4-registry") },
    base: { revision: "epoch:http:v1", digest: combinedRosterBaselineDigest(unsignedBase.baseline) },
    candidateContentDigest: unsignedBase.candidate.roster_digest, expiresAt: unsignedBase.expires_at,
    policyEpoch: { id: "grimnir-adr-008-v2" as const, constitutionId: "grimnir-autonomy-v2" as const, constitutionDigest: contentDigest("grimnir-autonomy-v2") }, signerKeyId: "hugin-autonomy-proposer" as const,
  };
  const sourceReceipt = { ...receiptBody, canonicalProposalDigest: contentDigest(jcsCanonicalize(receiptBody)), signature: `v1:hugin-autonomy-proposer:${"0".repeat(64)}` };
  const unsignedProvenance = {
    schema_version: "hugin-roster-provenance-v1" as const,
    source_receipt: sourceReceipt,
    source_receipt_digest: contentDigest(jcsCanonicalize(sourceReceipt)),
    source_base: receiptBody.base,
    proposal_content_digest: contentDigest(jcsCanonicalize(unsignedBase)),
    candidate_digest: unsignedBase.candidate.roster_digest,
    experiment_ref: receiptBody.experimentRef,
    evidence_fingerprints: receiptBody.evidenceFingerprints,
    policy_epoch: { id: receiptBody.policyEpoch.id, constitution_id: receiptBody.policyEpoch.constitutionId, constitution_digest: receiptBody.policyEpoch.constitutionDigest },
    constitution_digest: receiptBody.policyEpoch.constitutionDigest,
    principal_id: ROSTER_PROPOSAL_PRINCIPAL,
    issuer: { key_id: "hugin-roster-provenance" as const, algorithm: "Ed25519" as const },
  };
  const provenance = {
    ...unsignedProvenance,
    signature: {
      algorithm: "Ed25519" as const,
      value_base64: sign(null, Buffer.from(jcsCanonicalize(unsignedProvenance)), huginProvenanceKeys.privateKey).toString("base64"),
    },
  };
  const unsigned: Omit<RosterProposal, "proposal_digest"> = { ...unsignedBase, provenance };
  proposalBody = { ...unsigned, proposal_digest: canonicalRosterProposalDigest(unsigned) };
  const backendCapability = backendCapabilityIdentity("llamaswap");
  const observationUnsigned: Omit<ServerRosterObservation, "observation_digest"> = {
    schema_version: "gille-roster-server-observation-v1",
    observed_at: new Date().toISOString().replace(".000Z", "Z"),
    observation_epoch: "epoch:http:v1",
    catalogue: models.map((model) => ({
      model_id: model.key,
      type: model.type,
      quantization: null,
    })),
    backend_capability: {
      backend: backendCapability.backend,
      supported_operations: [...backendCapability.supportedOperations],
      alias_control: backendCapability.aliasControl,
      context_control: backendCapability.contextControl,
      capability_digest: backendCapability.capabilityDigest,
    },
    desired_roster: [{
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
    }],
    resident_model_ids: ["qwen-main", "second"],
    running_model_ids: ["qwen-main"],
  };
  const observation: ServerRosterObservation = {
    ...observationUnsigned,
    observation_digest: serverRosterObservationDigest(observationUnsigned),
  };
  const observationToken: ServerRosterObservationToken = {
    schema_version: "gille-roster-server-observation-token-v1",
    observation_epoch: observation.observation_epoch,
    observation_digest: observation.observation_digest,
  };
  rosterDependencies = {
    huginProvenanceTrust: { keyId: "hugin-roster-provenance", publicKeyPem: huginProvenanceKeys.publicKey.export({ type: "spki", format: "pem" }).toString() },
    readServerObservation: async () => structuredClone(observation),
    withServerObservationFence: (
      _expected: ServerRosterObservationToken,
      callback: (confirmedToken: unknown) => unknown,
    ): unknown => callback(observationToken),
    readEvidence: (hash) => getEvidenceIdentitySnapshot(hash),
    readCandidateTemplateIdentity: (modelId) => {
      const identity = {
        modelId,
        digest: template.digest,
        observedAt: new Date().toISOString().replace(".000Z", "Z"),
      };
      return {
        ...identity,
        identityDigest: templateIdentityDigest(identity),
      };
    },
    resolveRestoreDescriptor: (ref) => {
      const candidate = [entry, addedEntry].find(
        (item) => item.restore_descriptor_ref === ref,
      );
      return candidate ? makeDescriptor(candidate) : null;
    },
    resolveCanary: (id, version) =>
      id === canaryDefinition.registryId && version === canaryDefinition.registryVersion
        ? canaryDefinition
        : null,
    now: () => new Date(),
  };

  const gateway = await import("../src/homeserver/gateway.js");
  const handle = await gateway.startGateway({
    rosterAdmissionDependencies: rosterDependencies,
  });
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe("authenticated zero-mutation roster-proposal HTTP boundary", () => {
  it("denies unauthenticated, guest, and wrong-owner principals", async () => {
    const noAuth = await fetch(url("/v1/roster-proposals"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(proposalBody),
    });
    expect(noAuth.status).toBe(401);
    for (const key of [guestKey, otherOwnerKey]) {
      const response = await fetch(url("/v1/roster-proposals"), {
        method: "POST",
        headers: auth(key),
        body: JSON.stringify(proposalBody),
      });
      expect(response.status).toBe(403);
    }
  });

  it("composes protected registries to arm, exactly retry, scope reads, and expose no actuator", async () => {
    const accepted = await fetch(url("/v1/roster-proposals"), {
      method: "POST",
      headers: auth(serviceKey),
      body: JSON.stringify(proposalBody),
    });
    expect(accepted.status).toBe(201);
    const body = await accepted.json() as {
      state: string;
      proposalId: string;
      credentialBindingDigest: string;
    };
    expect(body.state).toBe("armed");
    expect(body.proposalId).toBe(proposalBody.proposal_id);

    const retry = await fetch(url("/v1/roster-proposals"), {
      method: "POST",
      headers: auth(serviceKey),
      body: JSON.stringify(proposalBody),
    });
    expect(retry.status).toBe(200);

    const rotated = rotateKey(ROSTER_PROPOSAL_PRINCIPAL, {}, keyDefaults);
    serviceKey = rotated.plaintextKey;

    const own = await fetch(url(`/v1/roster-proposals/${encodeURIComponent(proposalBody.proposal_id)}`), {
      headers: auth(serviceKey),
    });
    expect(own.status).toBe(200);
    const ownAfterRotation = await own.json() as {
      principalId: string;
      credentialBindingDigest: string;
    };
    expect(ownAfterRotation.principalId).toBe(ROSTER_PROPOSAL_PRINCIPAL);
    expect(ownAfterRotation.credentialBindingDigest).toBe(body.credentialBindingDigest);

    const rotatedRetry = await fetch(url("/v1/roster-proposals"), {
      method: "POST",
      headers: auth(serviceKey),
      body: JSON.stringify(proposalBody),
    });
    expect(rotatedRetry.status).toBe(200);
    const recovered = await rotatedRetry.json() as { credentialBindingDigest: string };
    expect(recovered.credentialBindingDigest).toBe(body.credentialBindingDigest);

    const {
      proposal_digest: _oldDigest,
      ...newUnsigned
    } = proposalBody;
    const nextUnsigned: Omit<RosterProposal, "proposal_digest"> = {
      ...newUnsigned,
      proposal_id: "proposal:w5:http:rotated",
      idempotency_key: "idem:w5:http:rotated",
    };
    const nextProposal = resignHuginProvenance({
      ...nextUnsigned,
      proposal_digest: canonicalRosterProposalDigest(nextUnsigned),
    });
    const next = await fetch(url("/v1/roster-proposals"), {
      method: "POST",
      headers: auth(serviceKey),
      body: JSON.stringify(nextProposal),
    });
    expect(next.status).toBe(422);
    const nextRecord = await next.json() as {
      principalId: string;
      credentialBindingDigest: string;
      reasonCode: string;
    };
    expect(nextRecord.principalId).toBe(ROSTER_PROPOSAL_PRINCIPAL);
    expect(nextRecord.credentialBindingDigest).not.toBe(body.credentialBindingDigest);
    expect(nextRecord.reasonCode).toBe("ACTIVE_PROPOSAL_EXISTS");

    const crossPrincipal = await fetch(url(`/v1/roster-proposals/${encodeURIComponent(proposalBody.proposal_id)}`), {
      headers: auth(otherOwnerKey),
    });
    expect(crossPrincipal.status).toBe(404);

    for (const suffix of ["apply", "re-arm", "widen"]) {
      const response = await fetch(
        url(`/v1/roster-proposals/${encodeURIComponent(proposalBody.proposal_id)}/${suffix}`),
        { method: "POST", headers: auth(serviceKey), body: "{}" },
      );
      expect(response.status).toBe(403);
    }
    expect(upstreamMutations).toBe(0);
  });

  it("confines the Hugin service key to submit and own-read while preserving normal owners", async () => {
    const keyCount = listKeys().length;
    const blocked: Array<[string, string, string | undefined]> = [
      ["GET", "/healthz", undefined],
      ["POST", "/v1/chat/completions", JSON.stringify({
        model: "qwen-main",
        messages: [{ role: "user", content: "do not run" }],
      })],
      ["POST", "/admin/models/load", JSON.stringify({ modelKey: "second" })],
      ["POST", "/admin/models/unload", JSON.stringify({ modelKey: "qwen-main" })],
      ["POST", "/admin/models/download", JSON.stringify({ modelKey: "second" })],
      ["POST", "/admin/routing-table/reload", "{}"],
      ["GET", "/admin/keys", undefined],
      ["POST", "/admin/keys", JSON.stringify({ alias: "must-not-exist", tier: "owner" })],
      ["GET", "/admin/maintenance", undefined],
      ["POST", "/admin/maintenance", JSON.stringify({ on: true })],
    ];
    for (const [method, path, body] of blocked) {
      const response = await fetch(url(path), {
        method,
        headers: auth(serviceKey),
        body,
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect(upstreamMutations).toBe(0);
    expect(listKeys()).toHaveLength(keyCount);
    expect(listKeys().some((key) => key.alias === "must-not-exist")).toBe(false);

    const ordinaryOwner = await fetch(url("/admin/keys"), {
      headers: auth(otherOwnerKey),
    });
    expect(ordinaryOwner.status).toBe(200);
    const maintenance = await fetch(url("/admin/maintenance"), {
      headers: auth(otherOwnerKey),
    });
    expect(maintenance.status).toBe(200);
    expect((await maintenance.json() as { maintenance: boolean }).maintenance)
      .toBe(false);
  });
});
