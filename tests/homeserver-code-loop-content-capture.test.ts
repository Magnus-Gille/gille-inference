import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { ensureLedgerSchema } from "../src/homeserver/ledger.js";

vi.mock("../src/homeserver/model-admin.js", () => ({
  getLoaded: async () => [{ key: "qwen3-coder-next-80b" }],
  getRunningSnapshot: async () => [],
  getRunningCmd: async () => null,
}));
import {
  startCodeLoop,
  getJobResult,
  sweepCodeLoopSandboxes,
  codeLoopToolDefs,
  _resetCodeLoopStateForTests,
  type CodeLoopStartConfig,
} from "../src/homeserver/code-loop.js";
import { execCageCommand } from "../src/homeserver/code-loop-cage.js";
import { readDurableCodeLoopRunByWork, persistDurableCodeLoopRun, codeLoopRequestFingerprint } from "../src/homeserver/code-loop-store.js";
import type { CodeLoopDeps, CodeLoopRequest, EngineRunOptions } from "../src/homeserver/code-loop-types.js";
import { buildCodeLoopRuntime, handleCodeLoopTool, type CodeLoopGatewayContext } from "../src/homeserver/code-loop-runtime.js";
import { createLearningTaskCapabilityEpoch } from "../src/homeserver/learning-task-contract.js";
import type { HomeserverConfig } from "../src/homeserver/config.js";

/**
 * #487 — code_loop honours `content_capture:"none"` end to end: no instruction, seed, diff,
 * summary or engine detail persists in the durable store, the ledger, or the workroot once the job
 * is terminal, and an engine that cannot suppress its per-turn logging is refused before admission.
 */

const CAPS = { wallSDefault: 480, wallSMax: 900, turnsDefault: 24, turnsMax: 40, tokensDefault: 60_000, tokensMax: 120_000 };
let workroot = "";

beforeAll(() => {
  initDb(join(mkdtempSync(join(tmpdir(), "cl-cc-db-")), "test.db"));
  ensureLedgerSchema();
});

beforeEach(() => {
  _resetCodeLoopStateForTests();
  workroot = mkdtempSync(join(tmpdir(), "cl-cc-work-"));
});

function startCfg(): CodeLoopStartConfig {
  return { enabled: true, workroot, model: "qwen3-coder-next-80b", caps: CAPS, confinement: "off", cage: null };
}

function deps(opts: { suppressionCapable: boolean; seen?: EngineRunOptions[]; marker: string }): CodeLoopDeps {
  return {
    engine: {
      ...(opts.suppressionCapable ? { supportsContentCaptureSuppression: true } : {}),
      run: async (o) => {
        opts.seen?.push(o);
        // The agent edits a seeded file with the canary and reports it in its final message/detail.
        writeFileSync(join(o.sandboxDir, "a.txt"), `edited ${opts.marker}\n`);
        return {
          outcome: "completed",
          usage: { turns: 2, wall_ms: 500, prompt_tokens: 40, completion_tokens: 20 },
          finalMessage: `summary ${opts.marker}`,
          unparseableLines: 0,
          detail: "",
        };
      },
    },
    spawnPi: () => { throw new Error("not used"); },
    now: () => Date.now(),
    keyAlias: "cc-agent",
    readinessProbe: async () => true,
    maintenanceMode: () => false,
    growthCapBytes: 50 * 1024 * 1024,
    pollMs: 10_000,
    retentionTtlMs: 24 * 60 * 60 * 1000,
    runCommand: (argv, o) => execCageCommand(argv, o.timeoutMs, { cwd: o.cwd, env: o.env, signal: o.signal }),
    acquireLease: async () => ({ release: async () => {} }),
    cageSelfTest: async () => ({ ok: true, failures: [] }),
    cleanupUnit: async () => {},
  };
}

function request(marker: string, over: Partial<CodeLoopRequest> = {}): CodeLoopRequest {
  return {
    instruction: `Rewrite a.txt. ${marker}`,
    files: [{ path: "a.txt", content: `seed ${marker}\n` }],
    ...over,
  };
}

async function waitTerminal(workId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const r = getJobResult(workId, workroot);
    if (r.kind !== "running") return;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("job did not finish");
}

/** Concatenated bytes of every regular file under the workroot (sandbox, state dir, git dirs). */
function workrootText(): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(readFileSync(p).toString("latin1"));
    }
  };
  if (existsSync(workroot)) walk(workroot);
  return out.join("\n");
}

function dbText(): string {
  const db = getDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join("\n");
}

let seq = 0;
const canary = (label: string) => `CANARY_CL_${label}_${++seq}_${Math.random().toString(36).slice(2, 8)}`;

describe("code_loop content_capture:'none'", () => {
  it("advertises the opt-out on code_loop_start", () => {
    const start = (codeLoopToolDefs() as Array<{ name: string; inputSchema: any }>).find((t) => t.name === "code_loop_start")!;
    expect(start.inputSchema.properties.content_capture).toMatchObject({ type: "string", enum: ["none"] });
  });

  it("control: an ordinary run persists its result content (the scan can see it)", async () => {
    const marker = canary("CONTROL");
    const r = await startCodeLoop(request(marker, { client_run_id: `ctl-${seq}` }), startCfg(), deps({ suppressionCapable: true, marker }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content_capture).toBeUndefined();
    await waitTerminal(r.work_id);
    expect(workrootText()).toContain(marker);
    expect(dbText()).toContain(marker);
  });

  it("suppressed: the caller gets the result, but nothing content-bearing persists", async () => {
    const marker = canary("SUPPRESSED");
    const seen: EngineRunOptions[] = [];
    const r = await startCodeLoop(
      request(marker, { client_run_id: `sup-${seq}`, content_capture: "none" }),
      startCfg(),
      deps({ suppressionCapable: true, seen, marker }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content_capture).toBe("suppressed");
    await waitTerminal(r.work_id);

    // The engine was told to suppress per-turn capture (the relay injects the header).
    expect(seen[0]!.contentCapture).toBe("suppressed");

    // In-memory result is still delivered to the caller.
    const result = getJobResult(r.work_id, workroot);
    expect(result.kind).toBe("result");
    if (result.kind === "result") {
      expect(result.result.status).toBe("completed");
      expect(result.result.diff).toContain(marker);
      expect(result.result.summary).toContain(marker);
    }

    // Durable record keeps metadata only.
    const durable = readDurableCodeLoopRunByWork(workroot, r.work_id)!;
    expect(durable.status).toBe("completed");
    expect(durable.result).toBeNull();
    expect(durable.content_capture).toBe("suppressed");

    // The sandbox (seed + agent edits) is removed as soon as cleanup is proved.
    expect(readdirSync(workroot).filter((n) => n.startsWith(r.work_id))).toEqual([]);

    // Ledger row is metadata only.
    const row = getDb().prepare(`SELECT prompt_excerpt, prompt_hash, content_capture, outcome FROM delegations WHERE source = 'code-loop' ORDER BY ts DESC, rowid DESC LIMIT 1`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ prompt_excerpt: null, prompt_hash: "suppressed", content_capture: "suppressed" });

    expect(workrootText()).not.toContain(marker);
    expect(dbText()).not.toContain(marker);
  });

  it("after a restart a suppressed result is unavailable rather than recovered from disk", async () => {
    const marker = canary("RESTART");
    const r = await startCodeLoop(request(marker, { content_capture: "none" }), startCfg(), deps({ suppressionCapable: true, marker }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await waitTerminal(r.work_id);
    _resetCodeLoopStateForTests();
    expect(getJobResult(r.work_id, workroot)).toEqual({ kind: "terminal-unavailable", status: "completed" });
  });

  it("an engine that cannot suppress per-turn capture is refused before any admission work", async () => {
    const marker = canary("UNSUPPORTED");
    const seen: EngineRunOptions[] = [];
    const r = await startCodeLoop(request(marker, { content_capture: "none" }), startCfg(), deps({ suppressionCapable: false, seen, marker }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe("content-capture-unsupported");
    expect(seen).toHaveLength(0);
    expect(workrootText()).not.toContain(marker);
    expect(dbText()).not.toContain(marker);
  });

  it("an invalid content_capture value is an invalid request", async () => {
    const r = await startCodeLoop(
      request("x", { content_capture: "metadata" as unknown as "none" }),
      startCfg(),
      deps({ suppressionCapable: true, marker: "x" }),
    );
    expect(r).toMatchObject({ ok: false, refusal: "invalid-request" });
  });

  it("content_capture is part of the client_run_id request identity", () => {
    const base = request("same");
    expect(codeLoopRequestFingerprint({ ...base, content_capture: "none" })).not.toBe(codeLoopRequestFingerprint(base));
    // Omission keeps the pre-#487 fingerprint for durable legacy retries.
    expect(codeLoopRequestFingerprint(base)).toBe(codeLoopRequestFingerprint({ ...base }));
  });

  it("the durable store refuses to write a suppressed result even if a caller passes one", () => {
    const marker = canary("STORE");
    const workId = "cl-20261020-0000abcd";
    persistDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: `__internal__/${workId}`,
      request_fingerprint: "sha256:x",
      work_id: workId,
      status: "completed",
      usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
      result: { diff: marker, summary: marker } as never,
      started_at_ms: Date.now(),
      content_capture: "suppressed",
    });
    expect(readDurableCodeLoopRunByWork(workroot, workId)!.result).toBeNull();
    expect(workrootText()).not.toContain(marker);
  });

  it("the sweep reclaims a terminal suppressed sandbox without waiting for the TTL", async () => {
    const workId = "cl-20261020-0000beef";
    const marker = canary("SWEEP");
    const dir = join(workroot, `${workId}-leftover`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.txt"), marker);
    persistDurableCodeLoopRun(workroot, {
      schema_version: 1,
      client_run_id: `__internal__/${workId}`,
      request_fingerprint: "sha256:y",
      work_id: workId,
      status: "completed",
      usage: { turns: 1, wall_ms: 1, prompt_tokens: 1, completion_tokens: 1 },
      result: null,
      started_at_ms: Date.now(),
      cleanup_pending: false,
      content_capture: "suppressed",
    });
    await sweepCodeLoopSandboxes({ workroot, retentionTtlMs: 24 * 60 * 60 * 1000 }, { now: () => Date.now(), stopUnit: async () => {} });
    expect(existsSync(dir)).toBe(false);
    expect(workrootText()).not.toContain(marker);
  });
});

describe("code_loop runtime wiring of the opt-out", () => {
  function runtimeConfig(confinement: "off" | "required"): HomeserverConfig {
    return {
      lmStudioBaseUrl: "http://127.0.0.1:1234/v1",
      gatewayHost: "127.0.0.1",
      gatewayPort: 8080,
      hostMemoryAdmission: { mode: "off", modelBudgetBytes: new Map(), modelReclaimBytes: new Map(), reserveBytes: 0, retryAfterSeconds: 30 },
      codeLoop: "on",
      codeLoopPiBin: "",
      codeLoopNodeModulesDir: "",
      codeLoopApiKey: "test-only-key",
      codeLoopWorkroot: workroot,
      codeLoopModel: "qwen3-coder-next-80b",
      codeLoopPiAgentDir: "",
      codeLoopConfinement: confinement,
      codeLoopForwardPort: 18080,
      codeLoopCaps: CAPS,
    } as unknown as HomeserverConfig;
  }
  function context(over: Partial<CodeLoopGatewayContext> = {}): CodeLoopGatewayContext {
    return {
      authenticatedPrincipalId: "cc-agent",
      authentication: "gateway-owner-auth",
      gatewayRequestId: "opaque:cc",
      capabilityEpoch: createLearningTaskCapabilityEpoch(),
      ...over,
    };
  }
  const startArgs = (marker: string) => ({ instruction: `do ${marker}`, files: [{ path: "a.txt", content: marker }] });

  it("only the confined runtime (relay) claims per-turn suppression", () => {
    expect(buildCodeLoopRuntime(runtimeConfig("required"), () => false).deps.engine.supportsContentCaptureSuppression).toBe(true);
    expect(buildCodeLoopRuntime(runtimeConfig("off"), () => false).deps.engine.supportsContentCaptureSuppression).toBe(false);
  });

  it("the unconfined runtime refuses content_capture:'none' without writing anything", async () => {
    const marker = canary("RUNTIME_ARG");
    const out = await handleCodeLoopTool("code_loop_start", { ...startArgs(marker), content_capture: "none" }, runtimeConfig("off"), () => false, context());
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.text)).toMatchObject({ refusal: "content-capture-unsupported" });
    expect(workrootText()).not.toContain(marker);
    expect(dbText()).not.toContain(marker);
  });

  it("the /mcp X-Content-Capture header is equivalent to the argument", async () => {
    const marker = canary("RUNTIME_HEADER");
    const out = await handleCodeLoopTool("code_loop_start", startArgs(marker), runtimeConfig("off"), () => false, context({ transportContentCapture: "suppressed" }));
    expect(JSON.parse(out.text)).toMatchObject({ refusal: "content-capture-unsupported" });
    expect(workrootText()).not.toContain(marker);
  });

  it("a malformed argument is still rejected when the header is present", async () => {
    const out = await handleCodeLoopTool("code_loop_start", { ...startArgs("y"), content_capture: "full" }, runtimeConfig("off"), () => false, context({ transportContentCapture: "suppressed" }));
    expect(JSON.parse(out.text)).toMatchObject({ refusal: "invalid-request" });
  });
});
