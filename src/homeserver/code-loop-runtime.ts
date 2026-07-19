import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { HomeserverConfig } from "./config.js";
import type { CodeLoopDeps, CodeLoopRequest } from "./code-loop-types.js";
import { startCodeLoop, getJobStatus, getJobResult, type CodeLoopStartConfig } from "./code-loop.js";
import type { AgentEngine } from "./code-loop-types.js";
import { makePiEngine, realSpawnPi, makeLlamaSwapReadinessProbe } from "./pi-engine.js";
import {
  buildCageArgv,
  runCageSelfTest,
  execCageCommand,
  startGatewayRelay,
  type CageRunnabilityProbe,
  type GatewayRelay,
} from "./code-loop-cage.js";
import { acquireGpuLease } from "./gpu-lease.js";
import {
  LearningTaskContractError,
  parseHuginRequestStamp,
  type LearningTaskCapabilityEpoch,
} from "./learning-task-contract.js";

/**
 * Composition root for code_loop's real dependencies (kept OUT of code-loop.ts so that module
 * stays pure + trivially unit-testable with fakes). Wires the pi engine, the OS cage, the GPU
 * lease, and the llama-swap readiness probe from HomeserverConfig.
 */

const GROWTH_CAP_BYTES = 50 * 1024 * 1024;
const RETENTION_TTL_MS = 24 * 60 * 60 * 1000;

/** Deploy root (for example `/srv/gille-inference`); node_modules + .env live here. */
function deployRoot(): string {
  return process.cwd();
}

function nodeModulesDir(): string | null {
  const nm = join(deployRoot(), "node_modules");
  return existsSync(nm) ? nm : null;
}

/** llama-swap origin (serves both /v1 and /running) derived from the configured base. */
function backendOrigin(cfg: HomeserverConfig): string {
  return cfg.lmStudioBaseUrl.replace(/\/v1$/, "");
}

/**
 * The narrow read-only paths that must stay visible through the cage's `--tmpfs $HOME` for pi to
 * be RUNNABLE (the 2026-07-02 live-smoke bug: pi lives at ~/.local/bin/pi — a symlink into
 * ~/.local/lib/node_modules — with its provider config in ~/.pi-code-loop; the tmpfs hid all of
 * it, so pi was ENOENT in-cage and every job died as an instant arm-error). Pure and exported
 * for tests. Returns (deduped):
 *   • the realpath'd bin dir holding the (sym)link — CANONICALIZED so a symlinked dir cannot
 *     smuggle an over-broad path past buildCageArgv's home-ancestor guard (lexical fallback when
 *     the dir does not resolve)
 *   • the node_modules ROOT containing the realpath'd target (or the realpath's dirname when the
 *     target is not under node_modules; lexical fallback when piBin does not resolve)
 *   • piAgentDir/models.json — the FILE, never the dir: on the box the agent dir ALSO holds
 *     pi's auth.json (its OAuth/API-key credential store), which must stay hidden in-cage
 * Every path is mounted ro-bind-try, so an already-visible or missing path is a harmless no-op.
 * buildCageArgv additionally DROPS any bind equal to / an ancestor of the caged home dir.
 */
export function piVisibilityBinds(piBin: string, piAgentDir: string): string[] {
  const out: string[] = [];
  const push = (p: string): void => {
    if (p !== "" && p !== "." && !out.includes(p)) out.push(p);
  };
  if (piBin !== "") {
    let binDir = dirname(piBin);
    try {
      binDir = realpathSync(binDir);
    } catch {
      /* missing bin dir → keep the lexical path (ro-bind-try makes it a no-op) */
    }
    push(binDir);
    let real: string;
    try {
      real = realpathSync(piBin);
    } catch {
      real = piBin; // missing piBin → fall back to the lexical path
    }
    const marker = `${sep}node_modules${sep}`;
    const idx = real.lastIndexOf(marker);
    // Keep up to and including "node_modules" (drop the trailing separator).
    push(idx !== -1 ? real.slice(0, idx + marker.length - 1) : dirname(real));
  }
  if (piAgentDir !== "") push(join(piAgentDir, "models.json"));
  return out;
}

export interface CodeLoopRuntime {
  startConfig: CodeLoopStartConfig;
  deps: CodeLoopDeps;
}

/**
 * Build the live runtime. `maintenanceMode` is injected (the gateway reads it from the admission
 * controller snapshot) so code_loop refuses during a model-scout window without importing the
 * controller.
 */
export interface CodeLoopGatewayContext {
  authenticatedPrincipalId: string;
  authentication: "gateway-owner-auth" | "service-auth";
  gatewayRequestId: string;
  capabilityEpoch: LearningTaskCapabilityEpoch;
}

export function buildCodeLoopRuntime(
  cfg: HomeserverConfig,
  maintenanceMode: () => boolean,
  gatewayContext?: CodeLoopGatewayContext,
): CodeLoopRuntime {
  const confinement = cfg.codeLoopConfinement;
  const home = homedir();
  const nm = nodeModulesDir();
  const secretPath = join(deployRoot(), ".env");
  const forwardPort = cfg.codeLoopForwardPort;
  // The gateway the per-run relay bridges to (the caged pi's ONLY reachable destination).
  const gatewayHost = cfg.gatewayHost;
  const gatewayPort = cfg.gatewayPort;

  // pi lives under $HOME (hidden by the cage tmpfs) — punch narrow ro holes for it, and have
  // the self-test PROVE runnability (not just confinement) at every job start.
  const extraRoBinds = piVisibilityBinds(cfg.codeLoopPiBin, cfg.codeLoopPiAgentDir);
  const runnability: CageRunnabilityProbe = {
    piBin: cfg.codeLoopPiBin !== "" ? cfg.codeLoopPiBin : null,
    piAgentDir: cfg.codeLoopPiAgentDir !== "" ? cfg.codeLoopPiAgentDir : null,
  };

  const cageBuildArgv = (sandboxDir: string, unitName: string): string[] =>
    buildCageArgv({
      sandboxDir,
      homeDir: home,
      forwardPort,
      nodeModulesDir: nm,
      unitName,
      extraRoBinds,
    });

  const basePiEngine = makePiEngine(
    {
      piBin: cfg.codeLoopPiBin,
      provider: "inference-local",
      piAgentDir: cfg.codeLoopPiAgentDir,
      apiKey: cfg.codeLoopApiKey,
      degeneracyRunThreshold: cfg.degeneracyRunThreshold,
    },
    {
      spawnPi: realSpawnPi,
      readinessProbe: makeLlamaSwapReadinessProbe(backendOrigin(cfg), cfg.codeLoopModel),
      pollMs: 5_000,
    }
  );

  // Wrap the engine so the host-side gateway relay (127.0.0.1:forwardPort → gateway) is up for the
  // whole pi run — the ONE egress hole the cage forwards. Closed on completion regardless of
  // outcome. check_cmd runs AFTER this (in code-loop.ts) and needs no gateway, so it is unaffected.
  const engine: AgentEngine = {
    run: async (opts) => {
      let relay: GatewayRelay | null = null;
      if (confinement !== "off") {
        try {
          relay = await startGatewayRelay(forwardPort, gatewayHost, gatewayPort);
        } catch {
          relay = null; // pi will simply fail to reach the gateway → the run surfaces the error
        }
      }
      try {
        return await basePiEngine.run(opts);
      } finally {
        if (relay !== null) await relay.close();
      }
    },
  };

  const deps: CodeLoopDeps = {
    engine,
    spawnPi: realSpawnPi,
    now: Date.now,
    keyAlias: gatewayContext?.authenticatedPrincipalId ?? null,
    ...(gatewayContext === undefined
      ? {}
      : {
          learningTaskAdmission: {
            capabilityEpoch: gatewayContext.capabilityEpoch,
            authenticatedPrincipalId: gatewayContext.authenticatedPrincipalId,
            authentication: gatewayContext.authentication,
            gatewayRequestId: gatewayContext.gatewayRequestId,
          },
        }),
    readinessProbe: makeLlamaSwapReadinessProbe(backendOrigin(cfg), cfg.codeLoopModel),
    maintenanceMode,
    growthCapBytes: GROWTH_CAP_BYTES,
    pollMs: 5_000,
    retentionTtlMs: RETENTION_TTL_MS,
    runCommand: (argv, opts) => execCageCommand(argv, opts.timeoutMs, { cwd: opts.cwd, env: opts.env }),
    acquireLease: async ({ model, timeoutMs, onLeaseLost }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const lease = await acquireGpuLease({
          model,
          purpose: "code-loop",
          dir: cfg.gpuLeaseDir,
          staleMs: cfg.gpuLeaseStaleMs,
          signal: ctrl.signal,
          onLeaseLost,
        });
        return { release: () => lease.release() };
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    },
    // Cage self-test in a throwaway probe sandbox under the workroot (design §6): asserts secrets
    // unreadable, ro-mount writes denied, external egress blocked, gateway reachable (200) — at
    // EVERY job start when confinement=required. Starts the same gateway relay so the gateway arm
    // is genuinely tested end-to-end.
    cageSelfTest: () => runCageSelfTestWithRelay(cageBuildArgv, secretPath, forwardPort, gatewayHost, gatewayPort, confinement, runnability),
  };

  const startConfig: CodeLoopStartConfig = {
    enabled: cfg.codeLoop === "on",
    // Absolutize: the default is the RELATIVE ./data/code-loop-work, but sandbox paths flow into
    // startsWith containment checks and bwrap --bind args, both of which need absolute paths.
    workroot: resolve(cfg.codeLoopWorkroot),
    model: cfg.codeLoopModel,
    caps: cfg.codeLoopCaps,
    confinement,
    cage: confinement === "off" ? null : { buildArgv: cageBuildArgv },
  };

  return { startConfig, deps };
}

/**
 * Run the cage self-test with the gateway relay up (so the gateway arm is tested end-to-end).
 * Shared by the runtime (per-job-start gate) and the CLI (`code-loop cage-test` ship gate).
 * Fail-closed: any relay/probe/exec failure yields ok:false. When `runnability` is provided, the
 * probe additionally asserts pi + its agent dir are visible in-cage (job runnability, not just
 * confinement — the arm the 2026-07-02 live smoke was missing).
 */
export async function runCageSelfTestWithRelay(
  cageBuildArgv: (sandboxDir: string, unitName: string) => string[],
  secretPath: string,
  forwardPort: number,
  gatewayHost: string,
  gatewayPort: number,
  confinement: "required" | "off",
  runnability?: CageRunnabilityProbe
): Promise<{ ok: boolean; failures: string[] }> {
  if (confinement === "off") return { ok: true, failures: [] };
  let probeDir: string;
  try {
    probeDir = mkdtempSync(join(tmpdir(), "code-loop-cage-probe-"));
  } catch (err) {
    return { ok: false, failures: [`could not create probe sandbox: ${(err as Error).message}`] };
  }
  let relay: GatewayRelay | null = null;
  try {
    relay = await startGatewayRelay(forwardPort, gatewayHost, gatewayPort);
  } catch (err) {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    return { ok: false, failures: [`could not start gateway relay on 127.0.0.1:${forwardPort}: ${(err as Error).message}`] };
  }
  try {
    const r = await runCageSelfTest({
      cageArgv: cageBuildArgv(probeDir, `code-loop-cage-probe-${process.pid}`),
      secretPath,
      // A write to the read-only toolchain mount MUST fail (a tmpfs-over-home write would succeed
      // harmlessly, so probing /usr is the meaningful "no rw escape" test).
      readonlyProbePath: "/usr/.code-loop-cage-write-probe",
      externalProbe: { host: "1.1.1.1", port: 443 },
      gatewayForwardPort: forwardPort,
      exec: execCageCommand,
      runnability,
    });
    return { ok: r.ok, failures: r.failures };
  } finally {
    if (relay !== null) await relay.close();
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ─── MCP dispatch (owner-gated; called from mcp.ts callTool) ────────────────────────────

/**
 * Handle one code_loop_* tool call. The CALLER (mcp.ts) has ALREADY verified the owner gate
 * (tier === "owner" && keyHash !== null) — a non-owner never reaches here (it falls through to
 * the byte-identical unknown-tool error). Returns a JSON text block; never throws.
 */
export async function handleCodeLoopTool(
  name: string,
  args: Record<string, unknown>,
  cfg: HomeserverConfig,
  maintenanceMode: () => boolean,
  gatewayContext: CodeLoopGatewayContext,
): Promise<{ text: string; isError: boolean }> {
  const { startConfig, deps } = buildCodeLoopRuntime(cfg, maintenanceMode, gatewayContext);

  if (name === "code_loop_start") {
    if (Object.hasOwn(args, "client_run_id") && typeof args["client_run_id"] !== "string") {
      return {
        text: JSON.stringify({ refusal: "invalid-request", message: "`client_run_id` must be a string when supplied." }),
        isError: true,
      };
    }
    let learningTaskStamp;
    if (Object.hasOwn(args, "learning_task_stamp")) {
      try {
        learningTaskStamp = parseHuginRequestStamp(args["learning_task_stamp"]);
      } catch (err) {
        return {
          text: JSON.stringify({
            refusal: "invalid-request",
            message: err instanceof LearningTaskContractError ? err.message : "invalid learning_task_stamp",
          }),
          isError: true,
        };
      }
    }
    const req: CodeLoopRequest = {
      client_run_id: typeof args["client_run_id"] === "string" ? (args["client_run_id"] as string) : undefined,
      ...(learningTaskStamp === undefined ? {} : { learning_task_stamp: learningTaskStamp }),
      instruction: typeof args["instruction"] === "string" ? (args["instruction"] as string) : "",
      files: Array.isArray(args["files"]) ? (args["files"] as CodeLoopRequest["files"]) : [],
      check_cmd: typeof args["check_cmd"] === "string" ? (args["check_cmd"] as string) : undefined,
      protected: Array.isArray(args["protected"]) ? (args["protected"] as string[]) : undefined,
      task_type: typeof args["task_type"] === "string" ? (args["task_type"] as string) : undefined,
      caps: typeof args["caps"] === "object" && args["caps"] !== null ? (args["caps"] as CodeLoopRequest["caps"]) : undefined,
    };
    const r = await startCodeLoop(req, startConfig, deps);
    if (r.ok) {
      return {
        text: JSON.stringify({
          work_id: r.work_id,
          status: r.status,
          client_run_id: r.client_run_id,
          request_fingerprint: r.request_fingerprint,
          recovered: r.recovered,
          ...(r.learning_task_gateway_echo !== undefined
            ? { learning_task_gateway_echo: r.learning_task_gateway_echo }
            : {}),
          ...(r.result !== undefined ? { result: r.result } : {}),
          capabilities: r.capabilities,
        }),
        isError: false,
      };
    }
    return {
      text: JSON.stringify({
        refusal: r.refusal,
        message: r.message,
        ...(r.recovered_admission === true ? { recovered_admission: true } : {}),
        ...(r.learning_task_gateway_echo === undefined
          ? {}
          : { learning_task_gateway_echo: r.learning_task_gateway_echo }),
      }),
      isError: true,
    };
  }

  if (name === "code_loop_status") {
    const workId = typeof args["work_id"] === "string" ? (args["work_id"] as string) : "";
    const s = getJobStatus(workId, startConfig.workroot);
    if (s === null) return { text: JSON.stringify({ error: "unknown work_id", work_id: workId }), isError: true };
    return { text: JSON.stringify({ status: s.status, usage: s.usage }), isError: false };
  }

  if (name === "code_loop_result") {
    const workId = typeof args["work_id"] === "string" ? (args["work_id"] as string) : "";
    const r = getJobResult(workId, startConfig.workroot);
    if (r.kind === "unknown") return { text: JSON.stringify({ error: "unknown work_id", work_id: workId }), isError: true };
    if (r.kind === "running") return { text: JSON.stringify({ status: "running", work_id: workId }), isError: false };
    if (r.kind === "terminal-unavailable") {
      return {
        text: JSON.stringify({ status: r.status, work_id: workId, error: "terminal result unavailable after restart" }),
        isError: true,
      };
    }
    return { text: JSON.stringify(r.result), isError: false };
  }

  // Unreachable (mcp.ts only routes the three names here) — defensive.
  return { text: `Unknown tool '${name}'.`, isError: true };
}
