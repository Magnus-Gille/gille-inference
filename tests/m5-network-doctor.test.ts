import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseLocalNetwork } from "../bin/m5-network-doctor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CLI = join(REPO_ROOT, "bin", "m5-network-doctor.mjs");
const TAINTED_URL = "https://private-gateway.invalid";
const TAINTED_IP = "192.0.2.73";
const TAINTED_AUTH_URL = "https://login.tailscale.invalid/auth/key=do-not-print";
const TAINTED_HEALTH = "health-secret-do-not-print";
const TAINTED_ERROR = "spawn failed at private-gateway.invalid:8443 with auth-token";

// These are protocol values, not operator-provided text. A diagnostic may choose a subset,
// but it must never interpolate a URL, IP, Tailscale response, or error into this field.
const REMEDIATION_ALLOWLIST = new Set([
  "Configure an explicit public base or select the private route explicitly.",
  "Correct the public base configuration; do not rotate credentials.",
  "Ask the owner to start Tailscale with its existing configuration, then rerun this diagnostic.",
  "Ask the owner to restore Tailscale login, then rerun this diagnostic.",
  "Ask the owner to check Tailscale device authorization.",
  "Wait for Tailscale startup, then rerun this diagnostic.",
  "Check that the local Tailscale CLI and service are available; their state is unverified.",
  "Check local Tailscale status with the owner; its state could not be classified.",
  "Check local Tailscale service responsiveness, then rerun this diagnostic.",
]);

const EXPECTED_KEYS = [
  "schema_version",
  "scope",
  "public_route",
  "tailscale",
  "gateway_reachability",
  "credential",
  "connector_session",
  "remediation",
];

type StatusResult = {
  status: number | null;
  stdout: string;
  error?: Error & { code?: string };
  signal?: NodeJS.Signals | null;
};

type StatusCall = {
  command: string;
  args: string[];
  options: Record<string, unknown>;
};

type Diagnostic = {
  schema_version: number;
  scope: string;
  public_route: string;
  tailscale: string;
  gateway_reachability: string;
  credential: string;
  connector_session: string;
  remediation: string[];
};

function injected(
  status: StatusResult | Error,
  env: NodeJS.ProcessEnv = {},
): { result: Diagnostic; call: StatusCall | undefined } {
  let call: StatusCall | undefined;
  const runStatus = (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ): StatusResult => {
    call = { command, args, options };
    if (status instanceof Error) throw status;
    return status;
  };
  const result = diagnoseLocalNetwork({ env, runStatus }) as Diagnostic;
  return { result, call };
}

function expectSafeShape(result: Diagnostic): void {
  expect(Object.keys(result)).toEqual(EXPECTED_KEYS);
  expect(result.schema_version).toBe(1);
  expect(result.scope).toBe("local_network_only");
  expect(result.gateway_reachability).toBe("not_checked");
  expect(result.credential).toBe("not_checked");
  expect(result.connector_session).toBe("not_inspected");
  expect(Array.isArray(result.remediation)).toBe(true);
  for (const item of result.remediation) {
    expect(REMEDIATION_ALLOWLIST.has(item), `unexpected remediation: ${item}`).toBe(true);
  }
}

function expectNoTaintedContent(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(TAINTED_URL);
  expect(serialized).not.toContain(TAINTED_IP);
  expect(serialized).not.toContain(TAINTED_AUTH_URL);
  expect(serialized).not.toContain(TAINTED_HEALTH);
  expect(serialized).not.toContain(TAINTED_ERROR);
}

function cleanEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["M5_GATEWAY_URL", "M5_OPENAI_BASE_URL", "M5_BASE_URL"]) delete env[key];
  return { ...env, ...overrides };
}

function validStatus(state: string): StatusResult {
  return {
    status: 0,
    stdout: JSON.stringify({
      BackendState: state,
      TailscaleIP: TAINTED_IP,
      AuthURL: TAINTED_AUTH_URL,
      Health: [TAINTED_HEALTH],
      PrivateGateway: TAINTED_URL,
    }),
  };
}

describe("m5-network-doctor — credential-free local contract", () => {
  it("returns the stable local-only shape and checks status with bounded, stdin-free options", () => {
    const { result, call } = injected(validStatus("Running"), cleanEnv({
      M5_GATEWAY_URL: `${TAINTED_URL}/`,
      M5_OPENAI_BASE_URL: `${TAINTED_URL}/v1/`,
    }));

    expectSafeShape(result);
    expect(result.public_route).toBe("configured");
    expect(result.tailscale).toBe("running");
    expect(result.remediation).toEqual([]);
    expect(call).toBeDefined();
    expect(call?.command).toBe("tailscale");
    expect(call?.args).toEqual(["status", "--json"]);
    expect(call?.options.timeout).toBe(3000);
    expect(call?.options.killSignal).toBe("SIGKILL");
    expect(call?.options.maxBuffer).toBe(1_048_576);
    expect(Array.isArray(call?.options.stdio)).toBe(true);
    expect((call?.options.stdio as unknown[])[0]).toBe("ignore");
    expect((call?.options.stdio as unknown[])[2]).toBe("ignore");
    expect(Object.keys(call?.options.env as Record<string, string>)).toEqual(["PATH"]);
    expectNoTaintedContent(result);
  });

  it.each([
    ["Running", "running"],
    ["Stopped", "stopped"],
    ["NeedsLogin", "needs_login"],
    ["NeedsMachineAuth", "needs_machine_auth"],
    ["Starting", "starting"],
    ["NoState", "unknown"],
  ] as const)("maps exact BackendState %s to %s", (backendState, expected) => {
    const { result } = injected(validStatus(backendState), cleanEnv());
    expectSafeShape(result);
    expect(result.tailscale).toBe(expected);
  });

  it("treats case variants and unknown BackendState values as unknown without echoing them", () => {
    const unknownState = `UNKNOWN-${TAINTED_HEALTH}`;
    const { result } = injected(
      { status: 0, stdout: JSON.stringify({ BackendState: unknownState, error: TAINTED_ERROR }) },
      cleanEnv(),
    );
    expectSafeShape(result);
    expect(result.tailscale).toBe("unknown");
    expectNoTaintedContent(result);
  });

  it("does not case-fold a known BackendState", () => {
    const { result } = injected(validStatus("running"), cleanEnv());
    expectSafeShape(result);
    expect(result.tailscale).toBe("unknown");
  });

  it.each([
    ["malformed JSON", { status: 0, stdout: `{ "BackendState": "Running", ${TAINTED_HEALTH}` }],
    ["wrong JSON shape", { status: 0, stdout: JSON.stringify(["Running", TAINTED_URL]) }],
    ["missing BackendState", { status: 0, stdout: JSON.stringify({ Health: TAINTED_HEALTH }) }],
    ["nonzero status with valid JSON", { status: 7, stdout: JSON.stringify({ BackendState: "Running" }) }],
  ] as const)("does not trust %s", (_label, status) => {
    const { result } = injected(status, cleanEnv());
    expectSafeShape(result);
    expect(result.tailscale).toBe(_label === "nonzero status with valid JSON" ? "unavailable" : "unknown");
    expectNoTaintedContent(result);
  });

  it("classifies ETIMEDOUT as timeout and does not expose the exception", () => {
    const error = Object.assign(new Error(TAINTED_ERROR), { code: "ETIMEDOUT" });
    const { result } = injected(error, cleanEnv());
    expectSafeShape(result);
    expect(result.tailscale).toBe("timeout");
    expectNoTaintedContent(result);
  });

  it.each([
    ["ENOENT", "unavailable"],
    ["EACCES", "unavailable"],
  ] as const)("classifies %s without exposing the exception", (code, expected) => {
    const error = Object.assign(new Error(TAINTED_ERROR), { code });
    const { result } = injected(error, cleanEnv());
    expectSafeShape(result);
    expect(result.tailscale).toBe(expected);
    expectNoTaintedContent(result);
  });

  it("keeps both missing public route and stopped Tailscale visible", () => {
    const { result } = injected(validStatus("Stopped"), cleanEnv());
    expectSafeShape(result);
    expect(result.public_route).toBe("unconfigured");
    expect(result.tailscale).toBe("stopped");
    expect(result.remediation.length).toBeGreaterThanOrEqual(2);
  });

  it("reports configured public route independently of gateway reachability", () => {
    const { result } = injected(
      Object.assign(new Error(TAINTED_ERROR), { code: "ECONNREFUSED" }),
      cleanEnv({ M5_GATEWAY_URL: TAINTED_URL }),
    );
    expectSafeShape(result);
    expect(result.public_route).toBe("configured");
    expect(result.gateway_reachability).toBe("not_checked");
    expectNoTaintedContent(result);
  });

  it("accepts a gateway root with one trailing slash and its exact /v1 pair", () => {
    const { result } = injected(validStatus("Running"), cleanEnv({
      M5_GATEWAY_URL: "https://gateway.example/",
      M5_OPENAI_BASE_URL: "https://gateway.example/v1/",
    }));
    expect(result.public_route).toBe("configured");
  });

  it.each([
    ["OpenAI first-class base", { M5_OPENAI_BASE_URL: "https://gateway.example/v1/" }],
    ["legacy base alias", { M5_BASE_URL: "https://gateway.example/v1/" }],
  ] as const)("accepts %s when it is the only public route declaration", (_label, env) => {
    const { result } = injected(validStatus("Running"), cleanEnv(env));
    expect(result.public_route).toBe("configured");
  });

  it("gives first-class bases precedence over a conflicting nonempty legacy alias", () => {
    const { result } = injected(validStatus("Running"), cleanEnv({
      M5_GATEWAY_URL: "https://gateway.example",
      M5_OPENAI_BASE_URL: "https://gateway.example/v1",
      M5_BASE_URL: "https://legacy.example/v1",
    }));
    expect(result.public_route).toBe("configured");
  });

  it.each([
    "M5_GATEWAY_URL",
    "M5_OPENAI_BASE_URL",
    "M5_BASE_URL",
  ] as const)("rejects an explicitly empty %s instead of falling through", (key) => {
    const env = cleanEnv({ M5_GATEWAY_URL: "https://gateway.example" });
    env[key] = "";
    const { result } = injected(validStatus("Stopped"), env);
    expect(result.public_route).toBe("invalid_configuration");
  });

  it.each([
    ["M5_GATEWAY_URL", "https://gateway.example/path"],
    ["M5_GATEWAY_URL", "https://gateway.example?secret=1"],
    ["M5_GATEWAY_URL", "https://gateway.example/#fragment"],
    ["M5_GATEWAY_URL", "ftp://gateway.example"],
    ["M5_GATEWAY_URL", "https://gateway.example//"],
    ["M5_OPENAI_BASE_URL", "https://gateway.example/chat"],
    ["M5_BASE_URL", "https://gateway.example/chat"],
  ] as const)("marks malformed %s as invalid without exposing its value", (key, value) => {
    const env = cleanEnv({ M5_GATEWAY_URL: "https://gateway.example" });
    delete env.M5_GATEWAY_URL;
    env[key] = value;
    const { result } = injected(validStatus("Running"), env);
    expect(result.public_route).toBe("invalid_configuration");
    expectNoTaintedContent(result);
  });

  it.each([
    ["https://other.example/v1", "first-class OpenAI base"],
    ["https://gateway.example/v2", "first-class OpenAI base"],
  ] as const)("rejects an inconsistent gateway/OpenAI pair (%s)", (openai, _label) => {
    const { result } = injected(validStatus("Running"), cleanEnv({
      M5_GATEWAY_URL: "https://gateway.example",
      M5_OPENAI_BASE_URL: openai,
    }));
    expect(result.public_route).toBe("invalid_configuration");
  });
});

type MockTools = {
  dir: string;
  tailscaleArgs: string;
  securityMarker: string;
  curlMarker: string;
};

const mockDirs: string[] = [];

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
}

function mockTools(tailscale: string): MockTools {
  const dir = mkdtempSync(join(tmpdir(), "m5-network-doctor-test-"));
  mockDirs.push(dir);
  const tailscaleArgs = join(dir, "tailscale.args");
  const securityMarker = join(dir, "security.called");
  const curlMarker = join(dir, "curl.called");
  writeExecutable(
    join(dir, "tailscale"),
    ["#!/bin/sh", `printf '%s\\n' \"$*\" > \"$0.args\"`, tailscale, ""].join("\n"),
  );
  writeExecutable(
    join(dir, "security"),
    ["#!/bin/sh", `touch \"$0.called\"`, "exit 99", ""].join("\n"),
  );
  writeExecutable(
    join(dir, "curl"),
    ["#!/bin/sh", `touch \"$0.called\"`, "exit 99", ""].join("\n"),
  );
  return { dir, tailscaleArgs, securityMarker, curlMarker };
}

function runCli(
  args: string[],
  tools: MockTools,
  overrides: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string; tools: MockTools } {
  const env = cleanEnv({
    PATH: `${tools.dir}:${process.env.PATH ?? ""}`,
    ...overrides,
  });
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    tools,
  };
}

function toolWasCalled(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  while (mockDirs.length > 0) {
    const dir = mockDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("m5-network-doctor — CLI process boundary", () => {
  it("runs only tailscale status --json and never invokes credential or network helpers", () => {
    const tools = mockTools(
      `printf '%s\\n' '${JSON.stringify({
        BackendState: "Stopped",
        TailscaleIP: TAINTED_IP,
        AuthURL: TAINTED_AUTH_URL,
        Health: [TAINTED_HEALTH],
        Gateway: TAINTED_URL,
      })}'`,
    );
    const result = runCli([], tools, {
      M5_GATEWAY_URL: TAINTED_URL,
      M5_OPENAI_BASE_URL: `${TAINTED_URL}/v1`,
    });

    expect(result.status).toBe(0);
    const diagnostic = JSON.parse(result.stdout) as Diagnostic;
    expectSafeShape(diagnostic);
    expect(diagnostic.tailscale).toBe("stopped");
    expect(readFileSync(tools.tailscaleArgs, "utf8").trim()).toBe("status --json");
    expect(toolWasCalled(tools.securityMarker)).toBe(false);
    expect(toolWasCalled(tools.curlMarker)).toBe(false);
    expectNoTaintedContent(result.stdout + result.stderr);
  });

  it.each(["--help", "-h"])("prints help for %s and does not spawn any child", (arg) => {
    const tools = mockTools("exit 99");
    const result = runCli([arg], tools);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/m5-network-doctor|usage/i);
    expect(toolWasCalled(tools.tailscaleArgs)).toBe(false);
    expect(toolWasCalled(tools.securityMarker)).toBe(false);
    expect(toolWasCalled(tools.curlMarker)).toBe(false);
  });

  it("rejects invalid arguments with exit 2, a fixed non-echoing error, and no child", () => {
    const tools = mockTools("exit 99");
    const result = runCli(["--unknown", TAINTED_URL], tools);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/unexpected argument|usage|invalid argument/i);
    expect(result.stderr).not.toContain(TAINTED_URL);
    expect(toolWasCalled(tools.tailscaleArgs)).toBe(false);
    expect(toolWasCalled(tools.securityMarker)).toBe(false);
    expect(toolWasCalled(tools.curlMarker)).toBe(false);
  });

  it("returns exit 0 with an unavailable diagnostic when the local status command fails", () => {
    const tools = mockTools("printf '%s\\n' 'status output with ${TAINTED_ERROR}' >&2; exit 9");
    const result = runCli([], tools);
    expect(result.status).toBe(0);
    const diagnostic = JSON.parse(result.stdout) as Diagnostic;
    expectSafeShape(diagnostic);
    expect(diagnostic.tailscale).toBe("unavailable");
    expectNoTaintedContent(result.stdout + result.stderr);
    expect(toolWasCalled(tools.securityMarker)).toBe(false);
    expect(toolWasCalled(tools.curlMarker)).toBe(false);
  });

  it("kills a hanging status command at the 3-second bound and still exits 0", () => {
    const tools = mockTools("exec sleep 10");
    const started = Date.now();
    const result = runCli([], tools);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(7_000);
    expect(result.status).toBe(0);
    const diagnostic = JSON.parse(result.stdout) as Diagnostic;
    expectSafeShape(diagnostic);
    expect(diagnostic.tailscale).toBe("timeout");
    expect(toolWasCalled(tools.securityMarker)).toBe(false);
    expect(toolWasCalled(tools.curlMarker)).toBe(false);
  });

  it("bounds oversized status output and returns an unavailable diagnostic", () => {
    const tools = mockTools("head -c 1048577 /dev/zero");
    const result = runCli([], tools);
    expect(result.status).toBe(0);
    const diagnostic = JSON.parse(result.stdout) as Diagnostic;
    expectSafeShape(diagnostic);
    expect(diagnostic.tailscale).toBe("unavailable");
    expectNoTaintedContent(result.stdout + result.stderr);
    expect(toolWasCalled(tools.securityMarker)).toBe(false);
    expect(toolWasCalled(tools.curlMarker)).toBe(false);
  });
});
