import { describe, it, expect } from "vitest";
import net from "node:net";
import http from "node:http";
import {
  buildCageArgv,
  buildCageProbeScript,
  parseCageProbeOutput,
  requestTransientCodeLoopUnitStop,
  runCageSelfTest,
  startGatewayRelay,
  stopTransientCodeLoopUnit,
  transientCodeLoopUnitFromArgv,
  type CageArgvOptions,
} from "../src/homeserver/code-loop-cage.js";

/**
 * The Phase-1 OS cage (docs/agentic-code-tool-design.md §6) — argv construction is PURE and
 * fully unit-tested offline; the live self-test is exercised on the box via
 * `homeserver code-loop cage-test`. These tests are the security trust anchor for the cage and
 * pin the composition VERIFIED to enforce the policy on the box (2026-07-02):
 *   systemd-run(MemoryMax/TasksMax) -> pasta(-T forwardPort; blocks all egress but the forward)
 *     -> bwrap(--share-net + fs cage) -> cmd
 * NOTE: systemd `IPAddressDeny` is a NO-OP in a --user scope on this box (verified), so egress is
 * enforced by pasta's namespace, NOT by systemd. A refactor must not reintroduce the false
 * IPAddressDeny reliance.
 */

const OPTS: CageArgvOptions = {
  sandboxDir: "/srv/gille-inference/data/code-loop-work/cl-x",
  homeDir: "/home/inference",
  forwardPort: 18080,
  nodeModulesDir: "/srv/gille-inference/node_modules",
  unitName: "code-loop-cl-20260815-abcdef12",
  piAgentDir: "/home/inference/.pi-code-loop",
};

function pairIndex(argv: string[], a: string, b: string): number {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === a && argv[i + 1] === b) return i;
  }
  return -1;
}

describe("buildCageArgv — manager-spawned transient service (resource confinement ONLY)", () => {
  it("runs a synchronous transient user service with exact startup and cleanup controls", () => {
    const argv = buildCageArgv(OPTS);
    expect(argv[0]).toBe("systemd-run");
    expect(argv).toContain("--user");
    expect(argv).not.toContain("--scope");
    expect(argv).toContain("--wait");
    expect(argv).toContain("--pipe");
    expect(argv).toContain("--service-type=exec");
    expect(argv).toContain("--expand-environment=no");
    expect(argv).toContain("--collect");
    expect(argv).toContain(`--unit=${OPTS.unitName}`);
    expect(pairIndex(argv, "-p", "RuntimeMaxSec=150")).toBeGreaterThan(-1);
    expect(pairIndex(argv, "-p", "KillMode=control-group")).toBeGreaterThan(-1);
  });

  it("bounds the subprocess tree: MemoryMax=8G and TasksMax=256 by default", () => {
    const argv = buildCageArgv(OPTS);
    expect(pairIndex(argv, "-p", "MemoryMax=8G")).toBeGreaterThan(-1);
    expect(pairIndex(argv, "-p", "TasksMax=256")).toBeGreaterThan(-1);
  });

  it("does NOT use systemd IPAddress properties (they are no-ops in a --user scope on this box)", () => {
    const argv = buildCageArgv(OPTS).join(" ");
    expect(argv).not.toContain("IPAddressDeny");
    expect(argv).not.toContain("IPAddressAllow");
  });

  it("only extracts exact code-loop job/probe units for bounded cleanup", () => {
    expect(transientCodeLoopUnitFromArgv(buildCageArgv(OPTS))).toBe(OPTS.unitName);
    expect(transientCodeLoopUnitFromArgv(buildCageArgv({ ...OPTS, unitName: "code-loop-cage-probe-4242" }))).toBe("code-loop-cage-probe-4242");
    expect(transientCodeLoopUnitFromArgv(["systemd-run", "--unit=home-gateway.service", "--", "true"])).toBeNull();
  });

  it("stops only a validated transient unit through the native user-manager transport", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    await stopTransientCodeLoopUnit("code-loop-cl-20260815-abcdef12", { PATH: "/usr/bin", HS_API_KEY: "ephemeral-secret" }, async (args, env) => {
      calls.push({ args, env });
      return { code: 0, stdout: "", stderr: "" };
    }, { uid: 4242, socketExists: () => false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(["--user", "stop", "code-loop-cl-20260815-abcdef12"]);
    expect(calls[0]!.env["XDG_RUNTIME_DIR"]).toBe("/run/user/4242");
    expect(calls[0]!.env).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
    expect(calls[0]!.env).not.toHaveProperty("HS_API_KEY");
    await expect(stopTransientCodeLoopUnit("home-gateway.service", {}, async () => {
      throw new Error("must not run");
    })).rejects.toThrow(/refusing/);
  });

  it("routes an engine kill to the exact manager-spawned service, never an argv-chosen unit", async () => {
    const stopped: string[] = [];
    const env = { PATH: "/usr/bin" };
    await requestTransientCodeLoopUnitStop(buildCageArgv(OPTS), env, async (unit, seenEnv) => {
      stopped.push(unit);
      expect(seenEnv).toBe(env);
    });
    expect(stopped).toEqual([OPTS.unitName]);
    expect(requestTransientCodeLoopUnitStop(["systemd-run", "--unit=ssh.service"], env, async () => {
      throw new Error("must not run");
    })).toBeNull();
  });

  it("copies the per-run relay capability from the client environment without putting it in argv", () => {
    const argv = buildCageArgv(OPTS);
    const capability = "ephemeral-client-capability-0123456789abcdef";
    expect(argv).not.toContain(capability);
    expect(argv).toContain("--setenv=HS_API_KEY");
    const shim = argv[argv.indexOf("/bin/sh") + 2]!;
    expect(shim).toContain("/usr/bin/env -i");
    expect(shim).toContain('HS_API_KEY="$HS_API_KEY"');
  });
});

describe("buildCageArgv — pasta (network confinement)", () => {
  it("chains pasta after the transient service wrapper, forwarding ONLY the loopback port (no --config-net)", () => {
    const argv = buildCageArgv(OPTS);
    const pasta = argv.indexOf("pasta");
    expect(pasta).toBeGreaterThan(argv.indexOf("systemd-run"));
    expect(pairIndex(argv, "-T", "18080")).toBeGreaterThan(-1);
    // --config-net would grant general NAT egress — it must NOT be present.
    expect(argv).not.toContain("--config-net");
  });
});

describe("buildCageArgv — bwrap (filesystem confinement)", () => {
  it("chains bwrap after pasta with --die-with-parent and SHARES pasta's netns", () => {
    const argv = buildCageArgv(OPTS);
    const bw = argv.indexOf("bwrap");
    expect(bw).toBeGreaterThan(argv.indexOf("pasta"));
    expect(argv.indexOf("--die-with-parent")).toBeGreaterThan(bw);
    // MUST share pasta's netns; unsharing net would make a fresh empty netns and cut the gateway.
    expect(argv).toContain("--share-net");
    expect(argv).not.toContain("--unshare-net");
    expect(argv).not.toContain("--unshare-all");
  });

  it("hides the entire home directory under a tmpfs (secrets, eval.db, ssh keys)", () => {
    const argv = buildCageArgv(OPTS);
    expect(pairIndex(argv, "--tmpfs", OPTS.homeDir)).toBeGreaterThan(-1);
  });

  it("read-only binds the toolchain (/usr) and never rw-binds anything but the sandbox", () => {
    const argv = buildCageArgv(OPTS);
    const roUsr = argv.indexOf("--ro-bind");
    expect(roUsr).toBeGreaterThan(-1);
    expect(argv.slice(roUsr, roUsr + 3)).toEqual(["--ro-bind", "/usr", "/usr"]);
    const rw: string[] = [];
    for (let i = 0; i < argv.length - 2; i++) {
      if (argv[i] === "--bind") rw.push(argv[i + 1]!);
    }
    expect(rw).toEqual([OPTS.sandboxDir]);
  });

  it("masks the migrated gateway secret directory after the broad /etc bind", () => {
    const argv = buildCageArgv(OPTS);
    const etcBind = pairIndex(argv, "--ro-bind-try", "/etc");
    const secretMask = pairIndex(argv, "--tmpfs", "/etc/gille-inference");
    expect(etcBind).toBeGreaterThan(-1);
    expect(secretMask).toBeGreaterThan(etcBind);
  });

  it("mount ORDER: tmpfs over $HOME first, then ro node_modules, then the rw sandbox bind", () => {
    const argv = buildCageArgv(OPTS);
    const tmpfsHome = pairIndex(argv, "--tmpfs", OPTS.homeDir);
    const nm = pairIndex(argv, "--ro-bind", OPTS.nodeModulesDir!);
    const sandbox = pairIndex(argv, "--bind", OPTS.sandboxDir);
    expect(tmpfsHome).toBeGreaterThan(-1);
    expect(nm).toBeGreaterThan(tmpfsHome);
    expect(sandbox).toBeGreaterThan(nm);
  });

  it("uses a static env -i shim so only the reviewed environment reaches the model process", () => {
    const argv = buildCageArgv(OPTS);
    expect(pairIndex(argv, "--chdir", OPTS.sandboxDir)).toBeGreaterThan(-1);
    const bw = argv.indexOf("bwrap");
    const shell = argv.indexOf("/bin/sh");
    expect(shell).toBeGreaterThan(bw);
    const shim = argv[shell + 2]!;
    expect(shim).toContain("/usr/bin/env -i");
    expect(shim).toContain(`HOME='${OPTS.sandboxDir}'`);
    expect(shim).toContain(`PI_CODING_AGENT_DIR='${OPTS.piAgentDir}'`);
    expect(shim).toContain('HS_API_KEY="$HS_API_KEY"');
    expect(argv.join(" ")).not.toContain("gateway-owner-key");
  });

  it("omits the node_modules bind when none is configured", () => {
    const argv = buildCageArgv({ ...OPTS, nodeModulesDir: null });
    expect(argv.join(" ")).not.toContain("node_modules");
  });
});

describe("buildCageArgv — extraRoBinds (pi visibility through the home tmpfs)", () => {
  // The 2026-07-02 live-smoke bug: --tmpfs $HOME hid ~/.local/bin/pi and ~/.pi-code-loop, so pi
  // was ENOENT inside the cage (arm-error in 94ms). Narrow ro binds must punch through the tmpfs.
  const BINDS = [
    "/home/inference/.local/bin",
    "/home/inference/.local/lib/node_modules",
    "/home/inference/.pi-code-loop",
  ];

  it("appends a --ro-bind-try pair per entry AFTER the home tmpfs (bwrap mount order is load-bearing)", () => {
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: BINDS });
    const tmpfsHome = pairIndex(argv, "--tmpfs", OPTS.homeDir);
    expect(tmpfsHome).toBeGreaterThan(-1);
    for (const p of BINDS) {
      const i = pairIndex(argv, "--ro-bind-try", p);
      expect(i).toBeGreaterThan(tmpfsHome);
      expect(argv[i + 2]).toBe(p); // bound at the same path
    }
  });

  it("places every extra ro-bind BEFORE the rw sandbox bind", () => {
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: BINDS });
    const sandbox = pairIndex(argv, "--bind", OPTS.sandboxDir);
    for (const p of BINDS) {
      expect(pairIndex(argv, "--ro-bind-try", p)).toBeLessThan(sandbox);
    }
  });

  it("uses --ro-bind-try, never --ro-bind (a missing path must not fail the cage)", () => {
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: ["/nonexistent/pi-bin"] });
    expect(pairIndex(argv, "--ro-bind-try", "/nonexistent/pi-bin")).toBeGreaterThan(-1);
    expect(pairIndex(argv, "--ro-bind", "/nonexistent/pi-bin")).toBe(-1);
  });

  it("omitted extraRoBinds → argv identical to before (backwards compatible)", () => {
    expect(buildCageArgv({ ...OPTS, extraRoBinds: [] })).toEqual(buildCageArgv(OPTS));
  });

  it("DROPS a bind equal to the home dir — a misconfigured piBin at $HOME/x must not re-expose home", () => {
    // dirname("$HOME/x") === $HOME: ro-binding it right after the tmpfs would undo the cage.
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: [OPTS.homeDir] });
    expect(pairIndex(argv, "--ro-bind-try", OPTS.homeDir)).toBe(-1);
    expect(argv).toEqual(buildCageArgv(OPTS));
  });

  it("DROPS a bind that is an ANCESTOR of the home dir (/home, /) — would expose home and siblings", () => {
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: ["/home", "/"] });
    expect(pairIndex(argv, "--ro-bind-try", "/home")).toBe(-1);
    expect(pairIndex(argv, "--ro-bind-try", "/")).toBe(-1);
  });

  it("keeps a merely prefix-similar sibling (/home/inference2 is NOT an ancestor of /home/inference)", () => {
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: ["/home/inference2/tools"] });
    expect(pairIndex(argv, "--ro-bind-try", "/home/inference2/tools")).toBeGreaterThan(-1);
  });

  it("keeps descendants of home (the whole point of the punch-through binds)", () => {
    const argv = buildCageArgv({ ...OPTS, extraRoBinds: ["/home/inference/.local/bin"] });
    expect(pairIndex(argv, "--ro-bind-try", "/home/inference/.local/bin")).toBeGreaterThan(-1);
  });
});

describe("buildCageProbeScript — gateway arm does a real HTTP GET requiring a 200", () => {
  it("probes the forwarded loopback port with HTTP /healthz (not a bare TCP connect)", () => {
    const s = buildCageProbeScript({
      secretPath: "/srv/gille-inference/.env",
      readonlyProbePath: "/usr/.cage-probe",
      externalProbe: { host: "1.1.1.1", port: 443 },
      gatewayForwardPort: 18080,
      userManagerSocketPath: "/run/user/4242/systemd/private",
    });
    expect(s).toContain("/dev/tcp/127.0.0.1/18080");
    expect(s).toContain("GET /healthz");
    expect(s).toContain(" 200 ");
    expect(s).toContain("/dev/tcp/1.1.1.1/443");
    expect(s).toContain("/usr/.cage-probe");
  });
});

describe("buildCageProbeScript — optional pi runnability arm (job-runnability, not just confinement)", () => {
  const BASE = {
    secretPath: "/srv/gille-inference/.env",
    readonlyProbePath: "/usr/.cage-probe",
    externalProbe: { host: "1.1.1.1", port: 443 },
    gatewayForwardPort: 18080,
    userManagerSocketPath: "/run/user/4242/systemd/private",
  };

  it("asserts piBin exists (-e) and the agent dir's models.json FILE exists (-e), each with its own marker", () => {
    // The check targets models.json specifically — the bind is file-level so pi's auth.json
    // (credential store, same dir) stays hidden; a -d dir check would pass vacuously (the bind
    // mount point creates the dir) without proving the provider config is readable.
    const s = buildCageProbeScript({
      ...BASE,
      runnability: { piBin: "/home/inference/.local/bin/pi", piAgentDir: "/home/inference/.pi-code-loop" },
    });
    expect(s).toContain(`[ -e '/home/inference/.local/bin/pi' ]`);
    expect(s).toContain(`[ -e '/home/inference/.pi-code-loop/models.json' ]`);
    expect(s).toContain("cage-probe:pi=ok");
    expect(s).toContain("cage-probe:pi=MISSING");
    expect(s).toContain("cage-probe:models=ok");
    expect(s).toContain("cage-probe:models=MISSING");
    expect(s).not.toContain("auth.json");
  });

  it("omits the runnability probes when not provided (backwards compatible)", () => {
    const s = buildCageProbeScript(BASE);
    expect(s).not.toContain("cage-probe:pi=");
    expect(s).not.toContain("cage-probe:models=");
  });
});

describe("parseCageProbeOutput — fail-closed verdict parsing", () => {
  const PASS = [
    "cage-probe:secret=denied",
    "cage-probe:outside-write=denied",
    "cage-probe:egress=blocked",
    "cage-probe:gateway=ok",
    "cage-probe:user-manager=denied",
  ].join("\n");

  it("all five base probes passing → ok", () => {
    const r = parseCageProbeOutput(PASS);
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it("a READABLE secret fails the cage", () => {
    const r = parseCageProbeOutput(PASS.replace("secret=denied", "secret=READABLE"));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("secret");
  });

  it("an escaped write to the ro toolchain fails the cage", () => {
    const r = parseCageProbeOutput(PASS.replace("outside-write=denied", "outside-write=WROTE"));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("outside-write");
  });

  it("open external egress fails the cage", () => {
    const r = parseCageProbeOutput(PASS.replace("egress=blocked", "egress=OPEN"));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("egress");
  });

  it("an unreachable gateway fails the cage (pi could never call home)", () => {
    const r = parseCageProbeOutput(PASS.replace("gateway=ok", "gateway=unreachable"));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("gateway");
  });

  it("a visible user-manager control socket fails the cage", () => {
    const r = parseCageProbeOutput(PASS.replace("user-manager=denied", "user-manager=VISIBLE"));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("user-manager");
  });

  it("a MISSING marker is a failure, never a silent pass (fail-closed)", () => {
    const r = parseCageProbeOutput("cage-probe:secret=denied\n");
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThanOrEqual(3);
  });

  it("empty / garbage output is a failure", () => {
    expect(parseCageProbeOutput("").ok).toBe(false);
    expect(parseCageProbeOutput("sh: bwrap: not found").ok).toBe(false);
  });

  describe("runnability arm (pi + models markers)", () => {
    const RUN = { piBin: "/home/inference/.local/bin/pi", piAgentDir: "/home/inference/.pi-code-loop" };
    const PASS_RUN = [PASS, "cage-probe:pi=ok", "cage-probe:models=ok"].join("\n");

    it("all six probes passing → ok", () => {
      const r = parseCageProbeOutput(PASS_RUN, RUN);
      expect(r.ok).toBe(true);
      expect(r.failures).toEqual([]);
    });

    it("pi MISSING fails, naming the invisible path", () => {
      const r = parseCageProbeOutput(PASS_RUN.replace("pi=ok", "pi=MISSING"), RUN);
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toContain("/home/inference/.local/bin/pi");
    });

    it("models MISSING fails, naming the invisible models.json path", () => {
      const r = parseCageProbeOutput(PASS_RUN.replace("models=ok", "models=MISSING"), RUN);
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toContain("/home/inference/.pi-code-loop/models.json");
    });

    it("a MISSING runnability marker is a failure (fail-closed), even when the base probes pass", () => {
      const r = parseCageProbeOutput(PASS, RUN);
      expect(r.ok).toBe(false);
      expect(r.failures.join(" ")).toContain("pi");
      expect(r.failures.join(" ")).toContain("models");
    });

    it("without the runnability option the extra markers are not required (base contract unchanged)", () => {
      expect(parseCageProbeOutput(PASS).ok).toBe(true);
    });
  });
});

describe("runCageSelfTest — drives the probe INSIDE the exact cage argv (fail-closed)", () => {
  const PASS_OUT = [
    "cage-probe:secret=denied",
    "cage-probe:outside-write=denied",
    "cage-probe:egress=blocked",
    "cage-probe:gateway=ok",
    "cage-probe:user-manager=denied",
  ].join("\n");

  function opts(exec: (argv: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string }>) {
    return {
      cageArgv: buildCageArgv(OPTS),
      secretPath: "/srv/gille-inference/.env",
      readonlyProbePath: "/usr/.cage-probe",
      externalProbe: { host: "1.1.1.1", port: 443 },
      gatewayForwardPort: 18080,
      userManagerSocketPath: "/run/user/4242/systemd/private",
      exec,
    };
  }

  it("execs the probe under the SAME cage argv prefix and parses a pass", async () => {
    let seen: string[] = [];
    const r = await runCageSelfTest(
      opts(async (argv) => {
        seen = argv;
        return { code: 0, stdout: PASS_OUT, stderr: "" };
      })
    );
    expect(r.ok).toBe(true);
    expect(seen.slice(0, 3)).toEqual(["systemd-run", "--user", "--wait"]);
    expect(seen).toContain("pasta");
    expect(seen).toContain("bwrap");
    const bash = seen.indexOf("bash");
    expect(bash).toBeGreaterThan(-1);
    expect(seen[bash + 1]).toBe("-c");
    expect(seen[bash + 2]).toContain("cage-probe:user-manager=denied");
  });

  it("a failing probe yields ok=false with the failures listed", async () => {
    const r = await runCageSelfTest(opts(async () => ({ code: 0, stdout: PASS_OUT.replace("secret=denied", "secret=READABLE"), stderr: "" })));
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("secret");
  });

  it("an exec failure (cage tooling missing) is ok=false, never a pass (fail-closed)", async () => {
    const r = await runCageSelfTest(
      opts(async () => {
        throw new Error("spawn systemd-run ENOENT");
      })
    );
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("ENOENT");
  });

  it("with runnability set, the probe script carries the pi checks and the parser requires their markers", async () => {
    let script = "";
    const r = await runCageSelfTest({
      ...opts(async (argv) => {
        script = argv[argv.length - 1]!;
        return { code: 0, stdout: PASS_OUT, stderr: "" }; // base probes pass, pi markers absent
      }),
      runnability: { piBin: "/home/inference/.local/bin/pi", piAgentDir: "/home/inference/.pi-code-loop" },
    });
    expect(script).toContain("cage-probe:pi=");
    expect(script).toContain("cage-probe:models=");
    expect(r.ok).toBe(false); // fail-closed: markers missing from output
    expect(r.failures.join(" ")).toContain("pi");
  });
});

describe("startGatewayRelay — HTTP-aware path-allowlisted forwarder (admin-exposure fix)", () => {
  // A stub upstream 'gateway' that records the requests it receives and echoes a marker. The
  // security property under test: ONLY the allowlisted paths reach it; everything else is refused
  // at the relay WITHOUT any upstream connection.
  interface Stub {
    port: number;
    hits: Array<{ method: string; url: string; body: string; authorization: string | undefined }>;
    close: () => Promise<void>;
  }
  async function startStub(): Promise<Stub> {
    const hits: Stub["hits"] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        hits.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization });
        if ((req.url ?? "").startsWith("/v1/chat/completions")) {
          // Stream two SSE-ish frames to exercise streaming passthrough.
          res.writeHead(200, { "content-type": "text/event-stream", "x-stub": "chat" });
          res.write("data: one\n\n");
          res.end("data: two\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json", "x-stub": "other" });
          res.end(JSON.stringify({ ok: true, url: req.url }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return {
      port: (server.address() as net.AddressInfo).port,
      hits,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  function request(
    port: number,
    method: string,
    path: string,
    body?: string,
    authorization?: string,
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: authorization === undefined ? {} : { authorization } }, (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: buf }));
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  it("forwards POST /v1/chat/completions verbatim, streaming the body and the SSE response", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    const r = await request(fwd, "POST", "/v1/chat/completions", JSON.stringify({ model: "m", messages: [] }), `Bearer ${relay.clientApiKey}`);
    expect(r.status).toBe(200);
    expect(r.headers["x-stub"]).toBe("chat");
    expect(r.body).toBe("data: one\n\ndata: two\n\n");
    expect(stub.hits).toHaveLength(1);
    expect(stub.hits[0]!.method).toBe("POST");
    expect(stub.hits[0]!.body).toContain('"model":"m"'); // request body streamed through
    expect(stub.hits[0]!.authorization).toBe("Bearer upstream-test-key");
    await relay.close();
    await stub.close();
  });

  it("forwards GET /v1/models (read-only, content-blind)", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    const r = await request(fwd, "GET", "/v1/models", undefined, `Bearer ${relay.clientApiKey}`);
    expect(r.status).toBe(200);
    expect(stub.hits.map((h) => h.url)).toContain("/v1/models");
    await relay.close();
    await stub.close();
  });

  it("forwards GET /healthz (the cage self-test reachability arm)", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    const r = await request(fwd, "GET", "/healthz", undefined, "Bearer forged-health-header");
    expect(r.status).toBe(200);
    expect(stub.hits.map((h) => h.url)).toContain("/healthz");
    expect(stub.hits[0]!.authorization).toBeUndefined();
    await relay.close();
    await stub.close();
  });

  it("requires the per-run capability on authenticated routes and never forwards a forged bearer", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    expect((await request(fwd, "GET", "/v1/models")).status).toBe(401);
    expect((await request(fwd, "GET", "/v1/models", undefined, "Bearer forged-local-token")).status).toBe(401);
    expect(stub.hits).toHaveLength(0);
    await relay.close();
    await stub.close();
  });

  it("REFUSES POST /admin/keys with 403 and NEVER forwards upstream (the escalated finding)", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    const r = await request(fwd, "POST", "/admin/keys", JSON.stringify({ alias: "x", tier: "owner" }));
    expect(r.status).toBe(403);
    expect(r.body).toContain("code_loop relay: path not allowed");
    expect(stub.hits).toHaveLength(0); // upstream never contacted
    await relay.close();
    await stub.close();
  });

  it("REFUSES a method mismatch (GET /v1/chat/completions) with 403, no upstream hit", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    const r = await request(fwd, "GET", "/v1/chat/completions");
    expect(r.status).toBe(403);
    expect(stub.hits).toHaveLength(0);
    await relay.close();
    await stub.close();
  });

  it("REFUSES other admin/model-management routes (unload, maintenance, revoke)", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    for (const [m, p] of [["POST", "/admin/unload"], ["POST", "/admin/maintenance"], ["POST", "/admin/keys/revoke"]] as const) {
      const r = await request(fwd, m, p);
      expect(r.status).toBe(403);
    }
    expect(stub.hits).toHaveLength(0);
    await relay.close();
    await stub.close();
  });

  it("path-allowlist matches the PATHNAME, ignoring query strings", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    const r = await request(fwd, "GET", "/v1/models?verbose=1", undefined, `Bearer ${relay.clientApiKey}`);
    expect(r.status).toBe(200);
    const r2 = await request(fwd, "POST", "/admin/keys?x=/v1/chat/completions");
    expect(r2.status).toBe(403);
    expect(stub.hits.map((h) => h.url)).not.toContain("/admin/keys?x=/v1/chat/completions");
    await relay.close();
    await stub.close();
  });

  it("closes the connection on non-HTTP / garbage traffic (never forwards)", async () => {
    const stub = await startStub();
    const fwd = await freePort();
    const relay = await startGatewayRelay(fwd, "127.0.0.1", stub.port, "upstream-test-key");
    await new Promise<void>((resolve) => {
      const c = net.connect(fwd, "127.0.0.1", () => c.write("this is not valid http\r\n\r\n"));
      c.on("close", () => resolve());
      c.on("error", () => resolve());
      setTimeout(() => { c.destroy(); resolve(); }, 1500);
    });
    expect(stub.hits).toHaveLength(0);
    await relay.close();
    await stub.close();
  });
});

/** Grab a free ephemeral loopback port for the relay test. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

// ─── withUserBusEnv — systemd-run --user needs the user-manager bus pointers ─────────────
// A systemd SYSTEM service env lacks XDG_RUNTIME_DIR/DBUS_SESSION_BUS_ADDRESS even when the
// user manager is running (lingering) — without them `systemd-run --user` fails to connect
// and the cage self-test fail-closes (observed live 2026-07-02 on first production start).
import { withUserBusEnv } from "../src/homeserver/code-loop-cage.js";

describe("withUserBusEnv", () => {
  it("uses the native private transport when the session-bus socket is absent", () => {
    const uid = 4242;
    const out = withUserBusEnv(
      { PATH: "/usr/bin" },
      { uid, socketExists: (path) => path === `/run/user/${uid}/systemd/private` },
    );
    expect(out["XDG_RUNTIME_DIR"]).toBe(`/run/user/${uid}`);
    expect(out["DBUS_SESSION_BUS_ADDRESS"]).toBe(`unix:path=/run/user/${uid}/systemd/private`);
    expect(out["PATH"]).toBe("/usr/bin");
  });
  it("leaves the bus address unset when neither reviewed transport is visible", () => {
    const out = withUserBusEnv({}, { uid: 4242, socketExists: () => false });
    expect(out).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  });
  it("sets the session-bus address only when its socket exists", () => {
    const out = withUserBusEnv({}, { uid: 4242, socketExists: (path) => path === "/run/user/4242/bus" });
    expect(out["DBUS_SESSION_BUS_ADDRESS"]).toBe("unix:path=/run/user/4242/bus");
  });
  it("preserves caller-provided values over the defaults", () => {
    const out = withUserBusEnv(
      { XDG_RUNTIME_DIR: "/run/user/999", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" },
      { uid: 4242, socketExists: () => false },
    );
    expect(out["XDG_RUNTIME_DIR"]).toBe("/run/user/999");
    expect(out["DBUS_SESSION_BUS_ADDRESS"]).toBe("unix:path=/x");
  });
  it("drops undefined entries (ProcessEnv shape) instead of stringifying them", () => {
    const out = withUserBusEnv({ FOO: undefined as unknown as string, BAR: "1" });
    expect(out).not.toHaveProperty("FOO");
    expect(out["BAR"]).toBe("1");
  });
});
