import { execFile } from "node:child_process";
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
 *   • `systemd-run --user --scope` — RESOURCE caps only: MemoryMax / TasksMax bound the whole
 *     subprocess TREE (the 2026-07-01 OOM lesson). (IP properties are NOT used — they are no-ops.)
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
  /** Transient scope unit name (addressable for the orphan sweep's best-effort stop). */
  unitName: string;
  /** systemd MemoryMax for the subprocess tree. Default "8G". */
  memoryMax?: string;
  /** systemd TasksMax for the subprocess tree. Default 256. */
  tasksMax?: number;
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
  const safeRoBinds = (o.extraRoBinds ?? []).filter((p) => !bindExposesHome(p, o.homeDir));
  return [
    // systemd transient scope: RESOURCE caps for the whole tree (MemoryMax/TasksMax DO work in a
    // --user scope; IP filtering does NOT and is deliberately absent — see the module header).
    "systemd-run",
    "--user",
    "--scope",
    "--collect",
    "--quiet",
    `--unit=${o.unitName}`,
    "-p", `MemoryMax=${memoryMax}`,
    "-p", `TasksMax=${tasksMax}`,
    "-p", "CPUWeight=50",
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
    "--setenv", "HOME", o.sandboxDir,
    "--",
  ];
}

// ─── Per-run gateway relay (host loopback:forwardPort → gateway host:port) ───────────────

export interface GatewayRelay {
  port: number;
  close: () => Promise<void>;
}

/**
 * The gateway paths the caged pi is allowed to reach through the relay — the SECURITY BOUNDARY
 * of the one egress hole. The service key is owner-tier (⇒ isAdmin on the gateway), so a RAW
 * byte-pipe would let a prompt-injected pi POST /admin/keys (persist a key), unload models, toggle
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
 * garbage traffic closes the socket. Dependency-free (node:http). The bearer header pi already
 * sends is forwarded unchanged — no auth changes here.
 */
export function startGatewayRelay(forwardPort: number, gatewayHost: string, gatewayPort: number): Promise<GatewayRelay> {
  return new Promise((resolve, reject) => {
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
      // Forward verbatim to the gateway, streaming both ways.
      const upstream = http.request(
        { host: gatewayHost, port: gatewayPort, method: req.method, path: req.url, headers: req.headers },
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

const PROBES = ["secret", "outside-write", "egress", "gateway"] as const;
type ProbeName = (typeof PROBES)[number];

/** Expected marker value per probe when the cage HOLDS. */
const EXPECTED: Record<ProbeName, string> = {
  secret: "denied",
  "outside-write": "denied",
  egress: "blocked",
  gateway: "ok",
};

export interface CageSelfTestResult {
  ok: boolean;
  failures: string[];
  raw: string;
}

/**
 * Optional job-RUNNABILITY arm of the self-test. The four base probes prove CONFINEMENT but not
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
  /** Command executor (DI; the real one is execCageCommand below). */
  exec: (argv: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  timeoutMs?: number;
  /** Optional job-runnability arm: assert pi + its agent dir are visible in-cage. */
  runnability?: CageRunnabilityProbe;
}

/** Build the bash probe script. Uses bash builtins only (/dev/tcp — no curl dependency). */
export function buildCageProbeScript(
  o: Pick<CageSelfTestOptions, "secretPath" | "readonlyProbePath" | "externalProbe" | "gatewayForwardPort" | "runnability">
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
 * first production start while the same test passed from an interactive shell. Default both
 * pointers from the uid; never override caller-provided values.
 */
export function withUserBusEnv(base: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    out["XDG_RUNTIME_DIR"] ??= `/run/user/${uid}`;
    out["DBUS_SESSION_BUS_ADDRESS"] ??= `unix:path=/run/user/${uid}/bus`;
  }
  return out;
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
    execFile(
      argv[0]!,
      argv.slice(1),
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, killSignal: "SIGKILL", cwd: opts.cwd, env: withUserBusEnv(opts.env ?? process.env) },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === "string") {
          // ENOENT etc. — the tool itself is missing; surface as a rejected exec.
          resolve({ code: null, stdout: String(stdout), stderr: `${(err as NodeJS.ErrnoException).code}: ${err.message}` });
          return;
        }
        const code = err ? ((err as { code?: number }).code ?? null) : 0;
        resolve({ code: typeof code === "number" ? code : null, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}
