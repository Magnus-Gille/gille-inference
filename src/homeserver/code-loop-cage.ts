import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import { join, sep } from "node:path";
import { recordCodeLoopRelayDenied } from "./metrics.js";

/**
 * The Phase-1 OS cage for code_loop (docs/agentic-code-tool-design.md §6).
 *
 * The gateway runs as the uid that owns `.env` (all secrets) and `data/eval.db` (live keystore
 * + credits). Any code execution as that uid — pi's bash, OR `check_cmd` importing model-edited
 * source (RCE by construction) — must be OS-confined.
 *
 * IMPORTANT box finding (2026-07-02): `systemd-run --user --scope -p IPAddressDeny=any` is
 * SILENTLY IGNORED — an unprivileged user systemd manager cannot install the cgroup BPF egress
 * firewall, so the property is accepted (exit 0) but NOT enforced. Verified empirically: a
 * `/bin/true` primitive test passes but real egress stays OPEN. So egress is NOT enforced by
 * systemd here. The cage instead composes THREE mechanisms, each verified enforced on the box:
 *
 *   • `systemd-run --user` transient SERVICE — the dedicated user manager spawns the cage outside
 *     the gateway service's inherited NoNewPrivileges/private-device namespace. `--wait --pipe`
 *     preserves synchronous output, while RuntimeMaxSec + explicit validated-unit cleanup bound
 *     every detached tree. MemoryMax / TasksMax still cap the whole subprocess tree.
 *   • `pasta -T <port>` (passt) — NETWORK: runs the child in a fresh user+net namespace with NO
 *     general outbound route (all egress BLOCKED) and forwards ONLY the one loopback port to the
 *     host's loopback, where a per-run relay bridges to the gateway. So the ONLY reachable
 *     destination is the gateway callback.
 *   • `bwrap --share-net` — FILESYSTEM: shares pasta's restricted netns (so it must NOT unshare
 *     net), a read-only toolchain (/usr, /etc …), a tmpfs over the ENTIRE home directory (hides
 *     .env, eval.db, SSH keys), a read-only bind of the deploy dir's node_modules (npx walk-up),
 *     and a read-write bind of the sandbox ONLY.
 *
 * The design never CLAIMS confinement — it TESTS it: runCageSelfTest() runs a probe inside the
 * exact cage argv and asserts (fail-closed) that secrets are unreadable, writes to the read-only
 * toolchain fail, external egress is blocked, and the gateway IS reachable (HTTP 200). It runs at
 * provisioning time (`homeserver code-loop cage-test`) and at every job start.
 */

// ─── Argv construction (pure) ───────────────────────────────────────────────────────────

export interface CageArgvOptions {
  /** The job sandbox — the ONLY read-write bind. */
  sandboxDir: string;
  /** The home directory to hide under a tmpfs (secrets, eval.db, ssh keys). */
  homeDir: string;
  /**
   * Loopback port pasta forwards from the namespace to the HOST loopback, where a per-run relay
   * bridges to the gateway. This is the SINGLE egress hole. pi reaches the gateway at
   * http://127.0.0.1:<forwardPort>/v1 (in-namespace loopback).
   */
  forwardPort: number;
  /** Deploy-dir node_modules to ro-bind (null → omitted). */
  nodeModulesDir: string | null;
  /**
   * Extra READ-ONLY binds that must stay visible through the `--tmpfs homeDir` (the 2026-07-02
   * live-smoke bug: the tmpfs hid ~/.local/bin/pi and the provider config, so pi was ENOENT
   * in-cage). Mounted with `--ro-bind-try` — a missing path is skipped, never a cage failure.
   * GUARDED: any entry equal to (or an ancestor of) homeDir is DROPPED — mounting it right after
   * the tmpfs would re-expose the very tree the cage exists to hide (e.g. a misconfigured piBin
   * directly under $HOME derives $HOME itself as its bin dir).
   */
  extraRoBinds?: string[];
  /** Dedicated Pi provider-config directory; exposed to pi as an environment value only. */
  piAgentDir: string;
  /** Scrubbed PATH for the inner process. */
  innerPath?: string;
  /** Transient service unit name (addressable for bounded cleanup and the orphan sweep). */
  unitName: string;
  /** systemd MemoryMax for the subprocess tree. Default "8G". */
  memoryMax?: string;
  /** systemd TasksMax for the subprocess tree. Default 256. */
  tasksMax?: number;
  /** systemd RuntimeMaxSec backstop. Default 150 seconds. */
  runtimeMaxSec?: number;
}

const TRANSIENT_CODE_LOOP_UNIT_RE = /^(?:code-loop-cl-\d{8}-[0-9a-f]{8}|code-loop-cage-probe-\d+)$/;

/** Extract only the exact transient units this module is authorized to stop. */
export function transientCodeLoopUnitFromArgv(argv: string[]): string | null {
  const units = argv
    .filter((arg) => arg.startsWith("--unit="))
    .map((arg) => arg.slice("--unit=".length));
  return units.length === 1 && TRANSIENT_CODE_LOOP_UNIT_RE.test(units[0]!) ? units[0]! : null;
}

/**
 * True when ro-binding `p` would re-expose the caged home dir: p IS homeDir, or p is an
 * ANCESTOR of it (binding /home or / after the tmpfs would surface home and its siblings).
 * Descendants of homeDir are fine — punching those through the tmpfs is the feature.
 */
function bindExposesHome(p: string, homeDir: string): boolean {
  if (p === homeDir) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return homeDir.startsWith(prefix);
}

/**
 * Build the confinement argv PREFIX. The actual command (pi, bash -c check_cmd, the probe) is
 * appended after the trailing bwrap "--".
 */
export function buildCageArgv(o: CageArgvOptions): string[] {
  const memoryMax = o.memoryMax ?? "8G";
  const tasksMax = o.tasksMax ?? 256;
  const runtimeMaxSec = o.runtimeMaxSec ?? 150;
  const innerPath = o.innerPath ?? "/usr/local/bin:/usr/bin:/bin";
  // The capability itself stays in the systemd-run CLIENT environment (not argv). The manager
  // copies it into the transient service, then this trusted static shim constructs the exact
  // model-visible allowlist without ever interpolating the value into /proc/*/cmdline.
  const innerEnvShim =
    `exec /usr/bin/env -i PATH=${shq(innerPath)} HOME=${shq(o.sandboxDir)} ` +
    `PI_CODING_AGENT_DIR=${shq(o.piAgentDir)} HS_API_KEY="$HS_API_KEY" "$@"`;
  const safeRoBinds = (o.extraRoBinds ?? []).filter((p) => !bindExposesHome(p, o.homeDir));
  return [
    // The user manager creates the service in its own execution context, rather than inheriting
    // the gateway's NoNewPrivileges/private-device namespace as --scope did. Output remains
    // synchronous, and both systemd and the caller own bounded whole-cgroup cleanup.
    "systemd-run",
    "--user",
    "--wait",
    "--pipe",
    "--collect",
    "--quiet",
    "--service-type=exec",
    "--expand-environment=no",
    // NAME without '=VALUE' copies from the client environment without putting the per-run
    // capability in argv (other local users may be able to read process command lines).
    "--setenv=HS_API_KEY",
    `--unit=${o.unitName}`,
    "-p", `MemoryMax=${memoryMax}`,
    "-p", `TasksMax=${tasksMax}`,
    "-p", "CPUWeight=50",
    "-p", `RuntimeMaxSec=${runtimeMaxSec}`,
    "-p", "TimeoutStopSec=10s",
    "-p", "KillMode=control-group",
    "--",
    // pasta: fresh user+net namespace, NO general outbound (all egress blocked), forwarding ONLY
    // the one loopback port to the host loopback. No --config-net (which would give general NAT
    // egress). This is what actually blocks exfiltration on this box.
    "pasta",
    "-T", String(o.forwardPort),
    "--",
    // bwrap: filesystem view. MUST share pasta's netns (never --unshare-net / --unshare-all, which
    // would create a fresh empty netns and cut off the gateway). Mount ORDER is load-bearing:
    // tmpfs over $HOME first, then the narrow ro/rw binds punch through it.
    "bwrap",
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup",
    "--share-net",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc", "/etc",
    // The isolated service's real gateway.env lives below this broad /etc mount. Mask the entire
    // application directory after the bind so neither the current nor future secret files leak.
    "--tmpfs", "/etc/gille-inference",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    // Hide the ENTIRE home dir (secrets, eval.db, ssh keys, other checkouts).
    "--tmpfs", o.homeDir,
    // Narrow ro binds that punch back through the home tmpfs (mount order is load-bearing:
    // these MUST come after the tmpfs). ro-bind-try: a missing path never fails the cage.
    // Home-exposing entries (== homeDir or an ancestor) are dropped by the guard above.
    ...safeRoBinds.flatMap((p) => ["--ro-bind-try", p, p]),
    // Toolchain walk-up for check_cmd's `npx --no-install` (read-only).
    ...(o.nodeModulesDir !== null ? ["--ro-bind", o.nodeModulesDir, o.nodeModulesDir] : []),
    // The ONE read-write surface: the job sandbox.
    "--bind", o.sandboxDir, o.sandboxDir,
    "--chdir", o.sandboxDir,
    "--",
    "/bin/sh", "-c", innerEnvShim, "code-loop-env",
  ];
}

// ─── Per-run gateway relay (host loopback:forwardPort → gateway host:port) ───────────────

export interface GatewayRelay {
  port: number;
  /** High-entropy capability required from the one caged client; valid only for this relay. */
  clientApiKey: string;
  close: () => Promise<void>;
}

/**
 * The gateway paths the caged pi is allowed to reach through the relay — the SECURITY BOUNDARY
 * of the one egress hole. The upstream key should carry agent scope; the relay still treats a
 * legacy/admin-scoped key as possible during migration. A RAW byte-pipe could let
 * a prompt-injected pi POST /admin/keys (persist a key), unload models, toggle
 * maintenance, revoke keys — nullifying the cage's egress win. This allowlist restricts the relay
 * to the two routes pi legitimately needs plus the unauthenticated liveness probe the cage
 * self-test uses; everything else is 403'd WITHOUT contacting upstream.
 */
const RELAY_ALLOW: ReadonlyArray<{ method: string; path: string }> = [
  { method: "POST", path: "/v1/chat/completions" }, // pi inference (the loop)
  { method: "GET", path: "/v1/models" }, // pi may list models (read-only, content-blind)
  { method: "GET", path: "/healthz" }, // the cage self-test reachability arm (unauthenticated)
];

function relayPathAllowed(method: string | undefined, url: string | undefined): boolean {
  const m = (method ?? "").toUpperCase();
  // Match on the PATHNAME only — a query string must never be able to sneak a denied path past.
  const pathname = (url ?? "").split("?")[0];
  return RELAY_ALLOW.some((a) => a.method === m && a.path === pathname);
}

/**
 * Start the loopback gateway relay: 127.0.0.1:<forwardPort> → <gatewayHost>:<gatewayPort>. This is
 * the host end of the pasta `-T` forward — the caged pi's ONLY network path. It is NOT a raw
 * byte-pipe (that would expose every admin route to a prompt-injected pi via the owner-tier key):
 * it is a minimal HTTP forwarder that ONLY relays the allowlisted method+path (RELAY_ALLOW),
 * streaming request and response both ways (SSE-safe, with backpressure). A non-allowlisted request
 * is answered `403 code_loop relay: path not allowed` WITHOUT any upstream connection; non-HTTP /
 * garbage traffic closes the socket. Dependency-free (node:http). Authenticated routes require a
 * fresh 256-bit per-run client capability; the relay strips every caller bearer and injects the
 * configured gateway key only on the upstream hop. Thus the loopback port is not a bearer proxy
 * for unrelated local processes, and the real key never enters the cage.
 */
export function startGatewayRelay(
  forwardPort: number,
  gatewayHost: string,
  gatewayPort: number,
  gatewayApiKey: string,
): Promise<GatewayRelay> {
  return new Promise((resolve, reject) => {
    if (gatewayApiKey === "") {
      reject(new Error("code_loop relay requires a configured upstream gateway key"));
      return;
    }
    const clientApiKey = randomBytes(32).toString("base64url");
    const sockets = new Set<net.Socket>();
    const server = http.createServer((req, res) => {
      if (!relayPathAllowed(req.method, req.url)) {
        // Drain the request body (so the socket can be reused / closed cleanly) but NEVER forward it.
        req.resume();
        try { recordCodeLoopRelayDenied(); } catch { /* metrics best-effort */ }
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "code_loop relay: path not allowed", type: "forbidden" } }));
        return;
      }
      const pathname = (req.url ?? "").split("?")[0];
      if (pathname !== "/healthz") {
        const supplied = req.headers.authorization ?? "";
        const expected = `Bearer ${clientApiKey}`;
        const suppliedBytes = Buffer.from(supplied);
        const expectedBytes = Buffer.from(expected);
        if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
          req.resume();
          try { recordCodeLoopRelayDenied(); } catch { /* metrics best-effort */ }
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "code_loop relay: invalid run capability", type: "unauthorized" } }));
          return;
        }
      }
      // Never forward caller-chosen auth. The ephemeral local capability is checked above, then
      // replaced only on authenticated inference routes with the real upstream gateway bearer.
      const headers = { ...req.headers };
      delete headers.authorization;
      if (pathname !== "/healthz") headers.authorization = `Bearer ${gatewayApiKey}`;
      const upstream = http.request(
        { host: gatewayHost, port: gatewayPort, method: req.method, path: req.url, headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 502, upRes.headers);
          upRes.pipe(res);
        }
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "code_loop relay: upstream error", type: "server_error" } }));
      });
      req.pipe(upstream);
    });
    // Non-HTTP / malformed traffic: close the socket, never forward.
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      else socket.destroy();
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(forwardPort, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve({
        port: forwardPort,
        clientApiKey,
        close: () =>
          new Promise<void>((res) => {
            // Destroy any lingering (e.g. long-lived SSE) sockets so close() can't hang.
            for (const s of sockets) s.destroy();
            server.close(() => res());
          }),
      });
    });
  });
}

// ─── Self-test (fail-closed) ────────────────────────────────────────────────────────────

const PROBES = ["secret", "outside-write", "egress", "gateway", "user-manager"] as const;
type ProbeName = (typeof PROBES)[number];

/** Expected marker value per probe when the cage HOLDS. */
const EXPECTED: Record<ProbeName, string> = {
  secret: "denied",
  "outside-write": "denied",
  egress: "blocked",
  gateway: "ok",
  "user-manager": "denied",
};

export interface CageSelfTestResult {
  ok: boolean;
  failures: string[];
  raw: string;
}

/**
 * Optional job-RUNNABILITY arm of the self-test. The five base probes prove CONFINEMENT but not
 * that a job can actually run — the 2026-07-02 live smoke passed the cage test yet pi was ENOENT
 * in-cage (the home tmpfs hid ~/.local/bin/pi and the provider config). When provided, the probe
 * also asserts these paths are visible inside the exact cage argv the jobs use. The agent-dir
 * check targets `<piAgentDir>/models.json` specifically — the bind is FILE-level (the dir also
 * holds pi's auth.json credential store, which must stay hidden), and a `-d` dir check would pass
 * vacuously anyway (the bind mount point materializes the dir in the tmpfs).
 */
export interface CageRunnabilityProbe {
  /** The pi binary path — must exist (-e follows the symlink to its target). */
  piBin?: string | null;
  /** PI_CODING_AGENT_DIR — `<dir>/models.json` must exist in-cage (the file-level bind). */
  piAgentDir?: string | null;
}

function runnabilityChecks(r: CageRunnabilityProbe | undefined): Array<{ name: string; path: string; what: string; test: string }> {
  const checks: Array<{ name: string; path: string; what: string; test: string }> = [];
  if (r?.piBin != null && r.piBin !== "") checks.push({ name: "pi", path: r.piBin, what: "pi binary", test: "-e" });
  if (r?.piAgentDir != null && r.piAgentDir !== "") {
    checks.push({ name: "models", path: join(r.piAgentDir, "models.json"), what: "pi provider config", test: "-e" });
  }
  return checks;
}

/**
 * Parse the probe output. FAIL-CLOSED: a missing marker is a failure — garbage output, a missing
 * bwrap/pasta, or a crashed probe must never read as a pass. When `runnability` is provided, its
 * markers are required too, and a failure names the invisible path.
 */
export function parseCageProbeOutput(stdout: string, runnability?: CageRunnabilityProbe): CageSelfTestResult {
  const failures: string[] = [];
  for (const probe of PROBES) {
    const m = stdout.match(new RegExp(`^cage-probe:${probe}=(.*)$`, "m"));
    if (!m) {
      failures.push(`${probe}: marker missing from probe output (fail-closed)`);
    } else if (m[1] !== EXPECTED[probe]) {
      failures.push(`${probe}: expected '${EXPECTED[probe]}', got '${m[1]}'`);
    }
  }
  for (const c of runnabilityChecks(runnability)) {
    const m = stdout.match(new RegExp(`^cage-probe:${c.name}=(.*)$`, "m"));
    if (!m) {
      failures.push(`${c.name}: marker missing from probe output (fail-closed)`);
    } else if (m[1] !== "ok") {
      failures.push(`${c.name}: ${c.what} '${c.path}' is not visible inside the cage (got '${m[1]}') — jobs cannot run`);
    }
  }
  return { ok: failures.length === 0, failures, raw: stdout };
}

export interface CageSelfTestOptions {
  /** The exact cage argv prefix the jobs will run under (buildCageArgv output). */
  cageArgv: string[];
  /** A secret file that MUST be unreadable inside the cage (e.g. <deployRoot>/.env). */
  secretPath: string;
  /** A read-only path (inside a ro mount, e.g. /usr/.cage-probe) a write MUST fail on. */
  readonlyProbePath: string;
  /** An external host:port that MUST be unreachable (egress blocked). */
  externalProbe: { host: string; port: number };
  /** The IN-NAMESPACE loopback port pasta forwards to the gateway; HTTP GET /healthz must be 200. */
  gatewayForwardPort: number;
  /** Outer gateway control socket that MUST remain absent from the model-driven inner cage. */
  userManagerSocketPath: string;
  /** Command executor (DI; the real one is execCageCommand below). */
  exec: (argv: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  timeoutMs?: number;
  /** Optional job-runnability arm: assert pi + its agent dir are visible in-cage. */
  runnability?: CageRunnabilityProbe;
}

/** Build the bash probe script. Uses bash builtins only (/dev/tcp — no curl dependency). */
export function buildCageProbeScript(
  o: Pick<CageSelfTestOptions, "secretPath" | "readonlyProbePath" | "externalProbe" | "gatewayForwardPort" | "userManagerSocketPath" | "runnability">
): string {
  // Runs INSIDE the cage. Every probe prints exactly one marker; the parser is fail-closed on a
  // missing marker. The gateway probe does a real HTTP GET /healthz and requires a 200 — a bare
  // TCP connect could succeed at the pasta layer even if the relay/gateway were down.
  return [
    `if cat ${shq(o.secretPath)} >/dev/null 2>&1; then echo "cage-probe:secret=READABLE"; else echo "cage-probe:secret=denied"; fi`,
    `if echo x > ${shq(o.readonlyProbePath)} 2>/dev/null; then echo "cage-probe:outside-write=WROTE"; rm -f ${shq(o.readonlyProbePath)} 2>/dev/null; else echo "cage-probe:outside-write=denied"; fi`,
    `if timeout 5 bash -c ${shq(`echo > /dev/tcp/${o.externalProbe.host}/${o.externalProbe.port}`)} 2>/dev/null; then echo "cage-probe:egress=OPEN"; else echo "cage-probe:egress=blocked"; fi`,
    `if timeout 6 bash -c ${shq(
      `exec 3<>/dev/tcp/127.0.0.1/${o.gatewayForwardPort}; printf 'GET /healthz HTTP/1.0\\r\\nHost: gw\\r\\n\\r\\n' >&3; head -1 <&3`
    )} 2>/dev/null | grep -q " 200 "; then echo "cage-probe:gateway=ok"; else echo "cage-probe:gateway=unreachable"; fi`,
    `if [ -S ${shq(o.userManagerSocketPath)} ]; then echo "cage-probe:user-manager=VISIBLE"; else echo "cage-probe:user-manager=denied"; fi`,
    // Runnability arm (when configured): the tmpfs-over-$HOME must not hide the pi install.
    ...runnabilityChecks(o.runnability).map(
      (c) => `if [ ${c.test} ${shq(c.path)} ]; then echo "cage-probe:${c.name}=ok"; else echo "cage-probe:${c.name}=MISSING"; fi`
    ),
  ].join("\n");
}

/** Minimal single-quote shell escaping for probe paths embedded in the bash script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run the probe INSIDE the exact cage argv the jobs use. Any exec failure (systemd-run / pasta /
 * bwrap missing, unit collision, timeout) is a FAILING result, never a pass.
 */
export async function runCageSelfTest(o: CageSelfTestOptions): Promise<CageSelfTestResult> {
  const script = buildCageProbeScript(o);
  const argv = [...o.cageArgv, "bash", "-c", script];
  try {
    const r = await o.exec(argv, o.timeoutMs ?? 60_000);
    const parsed = parseCageProbeOutput(r.stdout, o.runnability);
    if (!parsed.ok && r.code !== 0) {
      parsed.failures.push(`probe exited ${r.code === null ? "by timeout/signal" : r.code}: ${r.stderr.slice(0, 400)}`);
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, failures: [`cage probe exec failed: ${msg}`], raw: "" };
  }
}

/**
 * `systemd-run --user` must reach the USER manager's bus. A systemd SYSTEM service env lacks
 * XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS even when the user manager is running (lingering
 * enabled) — observed live 2026-07-02: the gateway's in-process cage self-test fail-closed on
 * first production start while the same test passed from an interactive shell. Default the
 * runtime directory from the uid. Prefer the ordinary session bus when visible; otherwise select
 * the user manager's private socket explicitly when that reviewed transport is visible. Live
 * issue-197 verification showed systemctl can use the private socket while systemd-run does not
 * auto-select it when the session bus is masked. Never override caller-provided values.
 */
export function withUserBusEnv(
  base: NodeJS.ProcessEnv | Record<string, string>,
  deps: { uid?: number | null; socketExists?: (path: string) => boolean } = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  const uid = deps.uid !== undefined ? deps.uid : (typeof process.getuid === "function" ? process.getuid() : null);
  if (uid !== null) {
    out["XDG_RUNTIME_DIR"] ??= `/run/user/${uid}`;
    const busPath = `/run/user/${uid}/bus`;
    const privatePath = `/run/user/${uid}/systemd/private`;
    const socketExists = deps.socketExists ?? existsSync;
    if (out["DBUS_SESSION_BUS_ADDRESS"] === undefined) {
      if (socketExists(busPath)) out["DBUS_SESSION_BUS_ADDRESS"] = `unix:path=${busPath}`;
      else if (socketExists(privatePath)) out["DBUS_SESSION_BUS_ADDRESS"] = `unix:path=${privatePath}`;
    }
  }
  return out;
}

export type UserSystemctlRunner = (
  args: string[],
  env: Record<string, string>,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runUserSystemctl: UserSystemctlRunner = (args, env) =>
  new Promise((resolve) => {
    execFile(
      "systemctl",
      args,
      { env, timeout: 10_000, maxBuffer: 64 * 1024, killSignal: "SIGKILL" },
      (err, stdout, stderr) => {
        const rawCode = err ? (err as { code?: number }).code : 0;
        resolve({
          code: typeof rawCode === "number" ? rawCode : null,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });

/**
 * Stop one exact code-loop transient service through its native user-manager transport. Unknown
 * (already collected) units are success; a bus/permission/active-unit failure propagates so a
 * sweep never marks a still-running tree orphaned. The runner seam keeps the security contract
 * deterministic in unit tests.
 */
export async function stopTransientCodeLoopUnit(
  unit: string,
  baseEnv: NodeJS.ProcessEnv | Record<string, string> = process.env,
  run: UserSystemctlRunner = runUserSystemctl,
  busDeps: { uid?: number | null; socketExists?: (path: string) => boolean } = {},
): Promise<void> {
  if (!TRANSIENT_CODE_LOOP_UNIT_RE.test(unit)) {
    throw new Error(`refusing to stop non-code-loop transient unit '${unit}'`);
  }
  const env = withUserBusEnv({
    PATH: baseEnv["PATH"] ?? "/usr/bin:/bin",
    ...(baseEnv["XDG_RUNTIME_DIR"] ? { XDG_RUNTIME_DIR: baseEnv["XDG_RUNTIME_DIR"] } : {}),
    ...(baseEnv["DBUS_SESSION_BUS_ADDRESS"]
      ? { DBUS_SESSION_BUS_ADDRESS: baseEnv["DBUS_SESSION_BUS_ADDRESS"] }
      : {}),
  }, busDeps);
  const stopped = await run(["--user", "stop", unit], env);
  if (stopped.code === 0) return;

  // CollectMode aggressively unloads a naturally completed service. Prove it is genuinely absent
  // before accepting a nonzero stop; never reinterpret a user-bus failure as successful cleanup.
  const shown = await run(["--user", "show", unit, "--property=LoadState", "--value"], env);
  if (shown.code === 0 && shown.stdout.trim() === "not-found") return;
  const detail = (stopped.stderr || shown.stderr || "unknown systemctl failure").trim().slice(0, 300);
  throw new Error(`could not stop transient code-loop unit '${unit}': ${detail}`);
}

/** Immediate best-effort stop used at the instant an engine cap is breached. */
export function requestTransientCodeLoopUnitStop(
  argv: string[],
  baseEnv: NodeJS.ProcessEnv | Record<string, string>,
  stop: (unit: string, env: NodeJS.ProcessEnv | Record<string, string>) => Promise<void> = stopTransientCodeLoopUnit,
): Promise<void> | null {
  const unit = transientCodeLoopUnitFromArgv(argv);
  if (unit === null) return null;
  return stop(unit, baseEnv);
}

/**
 * The real executor: execFile without a shell, bounded output, never throws on nonzero exit.
 * Optional cwd/env for host-side commands (git harvest, uncaged check_cmd) — the CAGED path
 * sets cwd via bwrap --chdir, but git/harvest run uncaged and need an explicit cwd.
 */
export function execCageCommand(
  argv: string[],
  timeoutMs: number,
  opts: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = withUserBusEnv(opts.env ?? process.env);
    const unit = transientCodeLoopUnitFromArgv(argv);
    execFile(
      argv[0]!,
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL", cwd: opts.cwd, env },
      async (err, stdout, stderr) => {
        let cleanupError = "";
        if (unit !== null) {
          try {
            await stopTransientCodeLoopUnit(unit, env);
          } catch (stopErr) {
            cleanupError = `\ntransient cleanup failed: ${(stopErr as Error).message}`;
          }
        }
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          // ENOENT etc. — the tool itself is missing; surface as a rejected exec.
          resolve({ code: null, stdout: String(stdout), stderr: `${(err as NodeJS.ErrnoException).code}: ${err.message}${cleanupError}` });
          return;
        }
        const code = err ? ((err as { code?: number }).code ?? null) : 0;
        resolve({
          code: cleanupError === "" && typeof code === "number" ? code : null,
          stdout: String(stdout),
          stderr: `${String(stderr)}${cleanupError}`,
        });
      }
    );
  });
}
