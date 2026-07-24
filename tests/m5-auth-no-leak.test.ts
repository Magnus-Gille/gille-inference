import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// m5-auth contract under test:
//   • bare call           → emit the raw owner token (for M5_API_KEY=$(m5-auth))
//   • --env               → export M5_API_KEY + explicit OpenAI/gateway-root URLs
//   • --env --tailnet     → as --env, but URLs → m5 tailnet :8080 (#109)
//   • --help / -h         → usage only, NEVER the token
//   • anything else        → no token, non-zero exit (gille-inference#97 leak guard)
// gille-inference#97: the raw owner token must NEVER reach stdout OR stderr for --help/-h
// or ANY unrecognized argument (unknown flags, empty-string args, trailing args, or a
// token-shaped arg echoed back). These tests spawn the in-repo bin/m5-auth with MOCKED
// `security` + `tailscale` on PATH so no real Keychain/tailnet is touched and a known
// sentinel token stands in for the real one.

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "bin", "m5-auth");
const SENTINEL = "hs_owner_FAKE_TEST_TOKEN_deadbeef";

let binDir: string; // security + a tailscale that resolves to a fixed IP
let binDirNoTs: string; // security + a tailscale that FAILS (exercises the MagicDNS fallback)

/** Write an executable mock script and mark it +x. */
function writeMock(dir: string, name: string, body: string): void {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
}

beforeAll(() => {
  // A fake `security` that emulates `security find-generic-password … -w`:
  // print the sentinel token to stdout and exit 0, regardless of args.
  const securityMock = `#!/usr/bin/env bash\nprintf '%s\\n' '${SENTINEL}'\n`;

  binDir = mkdtempSync(join(tmpdir(), "m5-auth-test-"));
  writeMock(binDir, "security", securityMock);
  // A fake `tailscale` that asserts it is called with the generic configured host (so a
  // resolver-shape regression is caught) and then prints a fixed tailnet IP. Asserting
  // argv is what makes the --tailnet contract test-enforced, not just review-enforced.
  writeMock(
    binDir,
    "tailscale",
    `#!/usr/bin/env bash\nif [ "$*" != "ip -4 inference-node" ]; then echo "fake-tailscale: unexpected argv: $*" >&2; exit 64; fi\nprintf '%s\\n' '192.0.2.10'\n`
  );

  // A second mock dir whose `tailscale` FAILS (non-zero, no stdout) — so resolve_m5_host
  // must fall back to the MagicDNS name `m5` cleanly under `set -euo pipefail`.
  binDirNoTs = mkdtempSync(join(tmpdir(), "m5-auth-noTS-"));
  writeMock(binDirNoTs, "security", securityMock);
  writeMock(binDirNoTs, "tailscale", `#!/usr/bin/env bash\nexit 1\n`);
});

function run(args: string[], dir: string = binDir, extraEnv: NodeJS.ProcessEnv = {}) {
  // Prepend the mock dir so our fake `security`/`tailscale` shadow the system ones, making
  // --tailnet resolution deterministic and independent of whether the host is on the tailnet.
  const env = { ...process.env, ...extraEnv, PATH: `${dir}:${process.env.PATH ?? ""}` };
  const r = spawnSync("bash", [SCRIPT, ...args], { env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function loadEnvAndCompose(dir: string = binDir, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...extraEnv, PATH: `${dir}:${process.env.PATH ?? ""}` };
  const script = [
    'eval "$("$1" --env)"',
    'printf "%s\\n" "$M5_GATEWAY_URL/delegate" "$M5_GATEWAY_URL/ledger" "$M5_OPENAI_BASE_URL/chat/completions"',
  ].join("\n");
  const r = spawnSync("bash", ["-c", script, "bash", SCRIPT], { env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("m5-auth — documented token-emitting paths still work", () => {
  it("bare call prints the token on stdout, exit 0", () => {
    const { code, stdout } = run([]);
    expect(code).toBe(0);
    expect(stdout).toContain(SENTINEL);
  });

  it("--env prints export lines incl. the token, exit 0", () => {
    const { code, stdout } = run(["--env"]);
    expect(code).toBe(0);
    expect(stdout).toContain("export M5_API_KEY=");
    expect(stdout).toContain("export M5_OPENAI_BASE_URL=");
    expect(stdout).toContain("export M5_GATEWAY_URL=");
    expect(stdout).toContain("export M5_BASE_URL=");
    expect(stdout).toContain(SENTINEL);
  });

  it("--env keeps M5_BASE_URL as the OpenAI-base compatibility alias and emits a gateway-root URL", () => {
    const { code, stdout } = run(["--env"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/export M5_OPENAI_BASE_URL=.*:8080\/v1/);
    expect(stdout).toMatch(/export M5_BASE_URL=.*:8080\/v1/);
    expect(stdout).toMatch(/export M5_GATEWAY_URL=.*:8080(?:['"])?\n/);
    expect(stdout).not.toMatch(/export M5_GATEWAY_URL=.*\/v1/);
  });
});

describe("m5-auth — --tailnet (gille-inference#109)", () => {
  // --tailnet rewrites the exported M5_BASE_URL to the m5 tailnet :8080 endpoint so a
  // batch harness bypasses Cloudflare (which 403s `error code: 1010` on non-browser UAs).
  for (const args of [
    ["--env", "--tailnet"],
    ["--tailnet", "--env"], // order-independent
  ]) {
    it(`${JSON.stringify(args)} exports the tailnet base URL + token, exit 0`, () => {
      const { code, stdout } = run(args);
      expect(code).toBe(0);
      expect(stdout).toContain("export M5_API_KEY=");
      expect(stdout).toContain(SENTINEL);
      // tailnet endpoint, NOT the Cloudflare-fronted public host.
      expect(stdout).toMatch(/export M5_OPENAI_BASE_URL=.*192\.0\.2\.10:8080\/v1/);
      expect(stdout).toMatch(/export M5_BASE_URL=.*192\.0\.2\.10:8080\/v1/);
      expect(stdout).toMatch(/export M5_GATEWAY_URL=.*192\.0\.2\.10:8080(?:['"])?\n/);
      // Canonical gateway-root composition can never create the non-route /v1/delegate.
      expect(`${stdout.match(/export M5_GATEWAY_URL=.*$/m)?.[0] ?? ""}/delegate`).not.toContain("/v1/delegate");
      expect(stdout).not.toContain("inference.example.com");
    });
  }

  it("--env --tailnet falls back to the MagicDNS name when tailscale is unavailable", () => {
    // tailscale fails (binDirNoTs) → use the configured generic host, not abort under pipefail.
    const { code, stdout } = run(["--env", "--tailnet"], binDirNoTs);
    expect(code).toBe(0);
    expect(stdout).toContain(SENTINEL);
    expect(stdout).toMatch(/export M5_OPENAI_BASE_URL=.*\bhttp:\/\/inference-node:8080\/v1/);
    expect(stdout).toMatch(/export M5_BASE_URL=.*\bhttp:\/\/inference-node:8080\/v1/);
    expect(stdout).toMatch(/export M5_GATEWAY_URL=.*\bhttp:\/\/inference-node:8080(?:['"])?\n/);
    expect(stdout).not.toContain("inference.example.com");
  });

  it("--tailnet WITHOUT --env is rejected (it only sets M5_BASE_URL), no token, non-zero exit", () => {
    const { code, stdout, stderr } = run(["--tailnet"]);
    expect(code).not.toBe(0);
    expect(stdout).not.toContain(SENTINEL);
    expect(stdout).not.toContain("hs_owner_");
    expect(stderr).not.toContain(SENTINEL);
    expect(stderr).toMatch(/tailnet/i);
  });
});

describe("m5-auth — authenticated base URL contract (#71)", () => {
  const badOverrides: Array<[string, NodeJS.ProcessEnv]> = [
    ["a gateway URL ending in /v1", { M5_GATEWAY_URL: "https://private.example/v1" }],
    ["an OpenAI base URL without /v1", { M5_OPENAI_BASE_URL: "https://private.example/api" }],
    [
      "a mismatched OpenAI/gateway pair",
      { M5_GATEWAY_URL: "https://gateway.example", M5_OPENAI_BASE_URL: "https://other.example/v1" },
    ],
  ];

  it.each(badOverrides)("rejects %s without reading or echoing sensitive values", (_label, extraEnv) => {
    const { code, stdout, stderr } = run(["--env"], binDir, extraEnv);
    expect(code).not.toBe(0);
    expect(stdout).not.toContain(SENTINEL);
    expect(stderr).not.toContain(SENTINEL);
    expect(stdout).not.toContain("private.example");
    expect(stderr).not.toContain("private.example");
    expect(stdout).not.toContain("gateway.example");
    expect(stderr).not.toContain("gateway.example");
    expect(stderr).toMatch(/base URL/i);
  });

  it("derives a gateway root from the legacy M5_BASE_URL-only input", () => {
    const { code, stdout } = run(["--env"], binDir, { M5_BASE_URL: "https://legacy.example/v1/" });
    expect(code).toBe(0);
    expect(stdout).toMatch(/export M5_OPENAI_BASE_URL=https:\/\/legacy\.example\/v1/);
    expect(stdout).toMatch(/export M5_GATEWAY_URL=https:\/\/legacy\.example\n/);
  });

  // Explicit M5_GATEWAY_URL / M5_OPENAI_BASE_URL override legacy M5_BASE_URL. A sole
  // first-class value derives its counterpart; an explicit pair must already agree.
  const validOverrideMatrix: Array<[string, NodeJS.ProcessEnv, string]> = [
    ["gateway only", { M5_GATEWAY_URL: "https://gateway.example/" }, "https://gateway.example"],
    ["OpenAI only", { M5_OPENAI_BASE_URL: "https://openai.example/v1/" }, "https://openai.example"],
    ["legacy only", { M5_BASE_URL: "https://legacy.example/v1/" }, "https://legacy.example"],
    [
      "matching first-class pair",
      { M5_GATEWAY_URL: "https://both.example", M5_OPENAI_BASE_URL: "https://both.example/v1" },
      "https://both.example",
    ],
  ];

  it.each(validOverrideMatrix)("loads valid %s overrides and composes the three route families", (_label, env, root) => {
    const result = loadEnvAndCompose(binDir, env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      `${root}/delegate`,
      `${root}/ledger`,
      `${root}/v1/chat/completions`,
    ]);
  });

  const invalidOverrideMatrix: Array<[string, NodeJS.ProcessEnv]> = [
    ["a path-only OpenAI base", { M5_OPENAI_BASE_URL: "/v1" }],
    ["a gateway with a path", { M5_GATEWAY_URL: "https://gateway.example/path" }],
    ["a gateway with a query", { M5_GATEWAY_URL: "https://gateway.example?private=1" }],
    ["a gateway with a fragment", { M5_GATEWAY_URL: "https://gateway.example#private" }],
    ["a non-HTTP(S) gateway", { M5_GATEWAY_URL: "ftp://gateway.example" }],
    ["an empty gateway override", { M5_GATEWAY_URL: "" }],
    ["an empty OpenAI override", { M5_OPENAI_BASE_URL: "" }],
    ["an empty legacy override", { M5_BASE_URL: "" }],
  ];

  it.each(invalidOverrideMatrix)("rejects %s before emitting the Keychain token", (_label, env) => {
    const { code, stdout, stderr } = run(["--env"], binDir, env);
    expect(code).not.toBe(0);
    expect(stdout).not.toContain(SENTINEL);
    expect(stderr).not.toContain(SENTINEL);
    expect(stderr).toMatch(/base URL/i);
  });
});

describe("m5-auth — leak guard (the #97 regression)", () => {
  for (const arg of ["--help", "-h"]) {
    it(`${arg} prints usage to stderr, NEVER the token, exit 0`, () => {
      const { code, stdout, stderr } = run([arg]);
      expect(code).toBe(0);
      expect(stdout).not.toContain(SENTINEL);
      expect(stdout).not.toContain("hs_owner_");
      expect(stderr).toMatch(/usage|m5-auth/i);
    });
  }

  // Includes the arity-leak cases (Codex #97 finding 1): a first-arg-only guard let
  // `--env extra`, `""`, and `"" --bogus` fall into the token path. Assert NEITHER
  // stdout NOR stderr ever carries the token on any non-documented invocation.
  for (const args of [
    ["--bogus"],
    ["-x"],
    ["foo", "bar"],
    ["token"],
    ["--env", "extra"], // trailing arg after --env must NOT emit
    [""], // a single empty arg is not a "bare call"
    ["", "--bogus"], // empty first arg must not open the token path
    ["--help", "extra"], // help only emits usage for an exact -h/--help
  ]) {
    it(`non-documented args ${JSON.stringify(args)} → no token in stdout OR stderr, non-zero exit`, () => {
      const { code, stdout, stderr } = run(args);
      expect(code).not.toBe(0);
      expect(stdout).not.toContain(SENTINEL);
      expect(stdout).not.toContain("hs_owner_");
      expect(stderr).not.toContain(SENTINEL);
      expect(stderr).not.toContain("hs_owner_");
    });
  }

  // Codex #97 finding 2: the error path must not echo the offending argument back —
  // if a caller fat-fingers a real token as an argument, it must not land in stderr/logs.
  it("a token-shaped unknown argument is NOT echoed to stderr", () => {
    const leaked = "hs_owner_THIS_LOOKS_LIKE_A_REAL_TOKEN";
    const { code, stdout, stderr } = run([leaked]);
    expect(code).not.toBe(0);
    expect(stdout).not.toContain(leaked);
    expect(stderr).not.toContain(leaked);
  });
});
