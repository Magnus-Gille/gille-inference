/**
 * #33: the MCP `ask` lane (mcp.ts's runChatCompletion) binds evidence identity via orchestrator.ts's
 * deriveEvidenceIdentity — the SAME derivation PR #32 wired into the delegate + delegate-shadow
 * lanes, and #33 itself wired into the code_loop lane (see homeserver-code-loop-job.test.ts's
 * "#33: code_loop lane binds evidence identity..." describe block).
 *
 * mcp.ts's public `ask` tool has NO stamp-INTAKE surface today (no `learning_task_stamp` in its
 * inputSchema, no LearningTaskContract admission of its own — confirmed against
 * docs/gateway-api-contract.md, which lists only `code_loop_start` and `POST /delegate` as
 * stamp-accepting surfaces). `RunChatArgs.learningTaskStamp` exists so the WRITE-SITE derivation is
 * in place and directly testable now — mirroring the "ready but dormant until a real caller
 * supplies one" shape the delegate lane had between #28 and #32 — while real stamp intake for `ask`
 * (schema field, validation, principal binding) is left as a distinct follow-up. This file exercises
 * `runChatCompletion` directly (bypassing the public tool schema), the same level PR #32's
 * orchestrator-evidence-identity.test.ts exercises `delegate()` at.
 *
 * Unlike homeserver-mcp.test.ts (which drives the full HTTP /mcp transport with a real gateway),
 * this file mirrors homeserver-gateway-degradation.test.ts's lighter pattern: call
 * `runChatCompletion` directly against a stub upstream + a real AdmissionController, so credit/quota
 * plumbing is real but no HTTP/JSON-RPC transport is needed. model-admin.js is mocked (like
 * orchestrator-evidence-identity.test.ts) so the served-model half of the identity is deterministic.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initDb, getDb } from "../src/db.js";
import { loadConfig } from "../src/homeserver/config.js";
import { AdmissionController } from "../src/homeserver/admission.js";
import type { HuginRequestStamp } from "../src/homeserver/learning-task-contract.js";

/** modelId -> the llama-swap /running `cmd` string this test wants "observed" for it. */
const servedCmdByModel = new Map<string, string | null>();
vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "mcp-ask-model" }],
  getRunningCmd: async (modelId: string) => servedCmdByModel.get(modelId) ?? null,
}));

let runChatCompletion: typeof import("../src/homeserver/mcp.js").runChatCompletion;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let reconstructEvidenceIdentity: typeof import("../src/homeserver/ledger.js").reconstructEvidenceIdentity;
let evidenceIdentityFromAdmittedStamp: typeof import("../src/homeserver/evidence-identity.js").evidenceIdentityFromAdmittedStamp;
let evidenceIdentityFromServedModelCmd: typeof import("../src/homeserver/evidence-identity.js").evidenceIdentityFromServedModelCmd;
let buildEvidenceIdentityBundle: typeof import("../src/homeserver/evidence-identity.js").buildEvidenceIdentityBundle;
let evidenceIdentityHash: typeof import("../src/homeserver/evidence-identity.js").evidenceIdentityHash;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "STUBBED COMPLETION" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
      );
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    })
  );
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-mcp-evidence-identity-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  const mcp = await import("../src/homeserver/mcp.js");
  runChatCompletion = mcp.runChatCompletion;
  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  const ledger = await import("../src/homeserver/ledger.js");
  reconstructEvidenceIdentity = ledger.reconstructEvidenceIdentity;
  const ei = await import("../src/homeserver/evidence-identity.js");
  evidenceIdentityFromAdmittedStamp = ei.evidenceIdentityFromAdmittedStamp;
  evidenceIdentityFromServedModelCmd = ei.evidenceIdentityFromServedModelCmd;
  buildEvidenceIdentityBundle = ei.buildEvidenceIdentityBundle;
  evidenceIdentityHash = ei.evidenceIdentityHash;
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  servedCmdByModel.clear();
});

const noopInflight = { inc: () => {}, dec: () => {}, current: () => 0 };

function makePrincipal(rec: ReturnType<typeof lookupKey>) {
  return {
    alias: rec!.alias,
    tier: rec!.tier,
    modelAllowList: rec!.modelAllowList,
    limits: { rpm: rec!.rpm, tpm: rec!.tpm, dailyTokenBudget: rec!.dailyTokenBudget },
    maxParallel: rec!.maxParallel,
    keyHash: rec!.keyHash,
    creditLimit: rec!.creditLimit,
  };
}

function testCfg() {
  return { ...loadConfig(), lmStudioBaseUrl: `http://127.0.0.1:${upstreamPort}/v1` };
}

let uniqueCounter = 0;
/** A structurally valid HuginRequestStamp — same hand-built shape as
 *  orchestrator-evidence-identity.test.ts's buildStamp(), since runChatCompletion (like
 *  delegateImpl) consumes an ALREADY-ADMITTED stamp and never re-validates it itself. */
function buildStamp(opts: { harnessDigestSeed?: string } = {}): HuginRequestStamp {
  uniqueCounter++;
  const harnessSeed = opts.harnessDigestSeed ?? "harness-v1";
  const sha = (seed: string) => createHash("sha256").update(seed).digest("hex");
  return {
    task_instance_id: `mcp-ask-task-${uniqueCounter}`,
    attempt_id: "attempt-1",
    client_id: "test-client",
    expected_transport_principal_id: "service:test",
    idempotency_key: `opaque:idem-${uniqueCounter}`,
    request_id: `opaque:req-${uniqueCounter}`,
    stamped_at: "2026-07-20T00:00:00.000Z",
    contract_request: { contract_version: "grimnir.learning-task/v1", schema_revision: 1, features: [] },
    preflight: {
      request: {
        request_id: "opaque:preflight-req",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        requested_at: "2026-07-20T00:00:00.000Z",
        requested_capabilities: { contract_version: "grimnir.learning-task/v1", schema_revision: 1, features: [] },
      },
      response: {
        advertisement_id: "opaque:preflight-resp",
        endpoint: "/v1/capabilities/learning-task",
        protocol_version: "learning-task-preflight/v1",
        advertised_at: "2026-07-20T00:00:00.000Z",
        expires_at: "2026-07-20T00:15:00.000Z",
        authenticated_principal_id: "service:gille-inference",
        authentication: "service-auth",
        capabilities: { contract_version: "grimnir.learning-task/v1", schema_revision: 1, features: [] },
      },
    },
    source: {
      component: "hugin",
      system: "broker",
      id: "broker-001",
      created_at: "2026-07-20T00:00:00.000Z",
      accepted_at: "2026-07-20T00:00:00.000Z",
      principal: { id: "principal:owner", authentication: "gateway-owner-auth", scope: "owner" },
      content_owner: { id: "principal:owner", authority: "authenticated-owner" },
    },
    task_type: {
      id: "summarize",
      taxonomy_id: "gille-inference/task-types",
      taxonomy_version: "gille-inference-task-types-test-v1",
    },
    raw_input: {
      algorithm: "sha256",
      canonicalization: "jcs-rfc8785-utf8-v1",
      source_ref: `source-doc:test/raw/mcp-ask-${uniqueCounter}`,
      source_type: "raw-input",
      source_version: "raw-input-v1",
      digest: sha(`raw-input-mcp-ask-${uniqueCounter}`),
    },
    raw_fingerprint: {
      algorithm: "sha256",
      version: "trim-utf8-sha256-v1",
      digest: sha(`fingerprint-mcp-ask-${uniqueCounter}`),
    },
    hugin_envelope: {
      algorithm: "sha256",
      canonicalization: "jcs-rfc8785-utf8-v1",
      source_ref: "source-doc:test/prompt/1",
      source_type: "prompt-stage",
      source_version: "prompt-stage-v2",
      digest: sha("hugin-envelope-v1"),
    },
    origin_config: {
      prompt: {
        id: "test-prompt",
        version: "v1",
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:test/config/prompt-v1",
          source_type: "origin-prompt-config",
          source_version: "config-source-v1",
          digest: sha("prompt-config-v1"),
        },
      },
      harness: {
        id: "homeserver-executor",
        version: harnessSeed,
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: `source-doc:test/config/${harnessSeed}`,
          source_type: "origin-harness-config",
          source_version: "config-source-v1",
          digest: sha(harnessSeed),
        },
      },
      tool_policy: {
        id: "bounded-delegate",
        version: "v1",
        config_digest: {
          algorithm: "sha256",
          canonicalization: "jcs-rfc8785-utf8-v1",
          source_ref: "source-doc:test/config/tool-policy-v1",
          source_type: "origin-tool-policy-config",
          source_version: "config-source-v1",
          digest: sha("tool-policy-v1"),
        },
      },
    },
    macro_decision: {
      policy_id: "hugin-runtime-selection",
      version: "homeserver-delegate-learning-task-v1",
      decision_id: "learning-task:test",
      target: "m5",
      service: "gille-inference",
    },
  } as HuginRequestStamp;
}

function ledgerRowFor(prompt: string): { hash: string | null; lane: string | null } {
  const promptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  return getDb()
    .prepare(
      "SELECT evidence_identity_hash AS hash, evidence_lane AS lane FROM delegations WHERE source = 'mcp-ask' AND prompt_hash = ? ORDER BY ts DESC LIMIT 1"
    )
    .get(promptHash) as { hash: string | null; lane: string | null };
}

describe("#33: mcp/ask lane binds evidence identity via orchestrator.ts's deriveEvidenceIdentity", () => {
  it("a stamped ask call lands a reconstructable evidence identity tagged 'mcp-ask'", async () => {
    const k = mintKey({ alias: `mcp-ei-owner-${uniqueCounter}`, tier: "owner" }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;
    const principal = makePrincipal(rec);
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });

    const MODEL = "mcp-ask-model";
    const servedCmd = "llama-server -m /models/mcp-ask-Q4_K_M.gguf -c 32768";
    servedCmdByModel.set(MODEL, servedCmd);
    const stamp = buildStamp();
    const prompt = `stamped mcp-ask prompt [marker ${uniqueCounter}]`;

    const r = await runChatCompletion(principal, testCfg(), controller, noopInflight, {
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      exposureTaskText: prompt,
      maxTokens: 64,
      learningTaskStamp: stamp,
    });
    expect(r.ok).toBe(true);

    const row = ledgerRowFor(prompt);
    expect(row.hash).not.toBeNull();
    // Per-lane correctness (#33): tagged mcp-ask, never a delegate/delegate-shadow/code-loop tag.
    expect(row.lane).toBe("mcp-ask");

    const expectedBundle = buildEvidenceIdentityBundle({
      ...evidenceIdentityFromAdmittedStamp(stamp),
      ...evidenceIdentityFromServedModelCmd(servedCmd),
      lane: "mcp-ask",
    });
    expect(row.hash).toBe(evidenceIdentityHash(expectedBundle));

    const snapshot = reconstructEvidenceIdentity(row.hash!);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.bundle).toEqual(expectedBundle);
    expect(snapshot!.bundle.lane).toBe("mcp-ask");
    expect(snapshot!.bundle.harness.kind).toBe("digest");
    expect(snapshot!.bundle.modelArtifact.kind).toBe("digest");
  });

  it("an unstamped ask call keeps a null (legacy) evidence identity, no crash", async () => {
    const k = mintKey({ alias: `mcp-ei-owner-legacy-${uniqueCounter}`, tier: "owner" }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;
    const principal = makePrincipal(rec);
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });

    const MODEL = "mcp-ask-model";
    servedCmdByModel.set(MODEL, "llama-server -m /models/mcp-ask-Q4_K_M.gguf -c 32768");
    const prompt = `unstamped legacy mcp-ask prompt [marker ${uniqueCounter}]`;

    const r = await runChatCompletion(principal, testCfg(), controller, noopInflight, {
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      exposureTaskText: prompt,
      maxTokens: 64,
      // no learningTaskStamp
    });
    expect(r.ok).toBe(true);

    const row = ledgerRowFor(prompt);
    expect(row.hash).toBeNull();
    expect(row.lane).toBeNull();
  });

  it("a served-model lookup that resolves to nothing fails OPEN to unknown('not-observed'), never fabricated", async () => {
    const k = mintKey({ alias: `mcp-ei-owner-open-${uniqueCounter}`, tier: "owner" }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;
    const principal = makePrincipal(rec);
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });

    const MODEL = "mcp-ask-model";
    // No entry in servedCmdByModel -> getRunningCmd resolves null (not-observed).
    const stamp = buildStamp();
    const prompt = `stamped ask, no served-model observation [marker ${uniqueCounter}]`;

    const r = await runChatCompletion(principal, testCfg(), controller, noopInflight, {
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      exposureTaskText: prompt,
      maxTokens: 64,
      learningTaskStamp: stamp,
    });
    expect(r.ok).toBe(true);

    const row = ledgerRowFor(prompt);
    expect(row.hash).not.toBeNull();
    expect(row.lane).toBe("mcp-ask");
    const snapshot = reconstructEvidenceIdentity(row.hash!);
    expect(snapshot!.bundle.modelArtifact).toMatchObject({ kind: "unknown", reason: "not-observed" });
    expect(snapshot!.bundle.configEpoch).toMatchObject({ kind: "unknown", reason: "not-observed" });
  });

  it("a placeholder served-model path fails the write closed (defense in depth, mirrors the delegate lane)", async () => {
    const k = mintKey({ alias: `mcp-ei-owner-placeholder-${uniqueCounter}`, tier: "owner" }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;
    const principal = makePrincipal(rec);
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });

    const MODEL = "mcp-ask-model";
    // A cmd whose -m path is literally the placeholder token evidence-identity.ts rejects.
    servedCmdByModel.set(MODEL, "llama-server -m placeholder -c 4096");
    const stamp = buildStamp();
    const prompt = `stamped ask, tainted served-model observation [marker ${uniqueCounter}]`;

    // The ledger write throws (assertAdmissibleEvidenceIdentity); mcp.ts's ledger-write block is
    // best-effort (never breaks the request), so the tool call itself still succeeds...
    const r = await runChatCompletion(principal, testCfg(), controller, noopInflight, {
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      exposureTaskText: prompt,
      maxTokens: 64,
      learningTaskStamp: stamp,
    });
    expect(r.ok).toBe(true);

    // ...but nothing tainted was ever committed to the ledger.
    const row = ledgerRowFor(prompt);
    expect(row).toBeUndefined();
  });
});
