import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * scripts/deploy-gateway.sh (issue #23) — the deploy/verify/dry-run tool that replaces the
 * manual rsync + restart + hand-checked-hash workflow used for the #20 deploy.
 *
 * These tests never ssh anywhere and never touch production. DEPLOY_REMOTE_HOST is always left
 * as an empty string, which flips the script's remote_exec()/rsync_dest() into a purely local
 * mode (see the script's own "Test seam" comment): "remote" commands run via `bash -c` against a
 * disposable local directory standing in for the M5 box, and rsync copies to that directory
 * directly instead of over ssh. Health/capability probes hit real short-lived HTTP servers on
 * 127.0.0.1, so the health-check code path itself (curl, HTTP status, auth header) is exercised
 * for real — only the network hop to the actual box is what's faked away.
 */

const SCRIPT = join(__dirname, "..", "scripts", "deploy-gateway.sh");
const OWNER_KEY = "test-owner-key-0123456789";

const cleanupDirs: string[] = [];
const cleanupServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupServers.length) await cleanupServers.pop()!();
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(d);
  return d;
}

function initSourceRepo(): string {
  const dir = tmpDir("dg-src-");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Deploy Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "fixture repo for deploy-gateway.sh tests\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

/** A real local HTTP server that always answers 200 — stands in for a healthy /healthz. */
function startOkServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = createServer((_req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const close = () => new Promise<void>((r) => server.close(() => r()));
      cleanupServers.push(close);
      resolvePromise({ url: `http://127.0.0.1:${port}/healthz`, close });
    });
  });
}

/** Stands in for /v1/capabilities/learning-task: 200 only for the expected bearer key. */
function startCapabilityServer(expectedKey: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const auth = req.headers.authorization ?? "";
      if (auth === `Bearer ${expectedKey}`) {
        res.writeHead(200);
        res.end("{}");
      } else {
        res.writeHead(401);
        res.end("{}");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      const close = () => new Promise<void>((r) => server.close(() => r()));
      cleanupServers.push(close);
      resolvePromise({ url: `http://127.0.0.1:${port}/v1/capabilities/learning-task`, close });
    });
  });
}

/** A URL nothing is listening on (server opened then immediately closed), for negative probes. */
async function closedPortUrl(): Promise<string> {
  const srv = await startOkServer();
  await srv.close();
  return srv.url;
}

/**
 * Runs the script via async spawn(), NOT spawnSync(). This test file's fixture HTTP servers run
 * in-process on the same Node event loop as the test runner; a synchronous spawnSync() would
 * block that event loop for the child's entire lifetime, starving the very servers curl is
 * trying to reach and producing a spurious connect timeout instead of a real pass/fail signal.
 */
function runScript(
  mode: string,
  cwd: string,
  env: Record<string, string>
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", [SCRIPT, mode], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolvePromise({ status: code ?? -1, stdout, stderr }));
  });
}

function baseEnv(remoteDir: string, overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    DEPLOY_REMOTE_HOST: "", // activates the local test seam — no ssh
    DEPLOY_REMOTE_DIR: remoteDir,
    DEPLOY_WORKDIR_PROBE_CMD: `echo ${remoteDir}`,
    DEPLOY_INSTALL_CMD: "true",
    DEPLOY_RESTART_CMD: "true",
    HOMESERVER_OWNER_KEY: OWNER_KEY,
    ...overrides,
  };
}

describe("scripts/deploy-gateway.sh", () => {
  it("refuses a dirty source tree before touching the remote at all", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    writeFileSync(join(src, "uncommitted.txt"), "oops\n");
    const r = await runScript(
      "deploy",
      src,
      baseEnv(remote, { DEPLOY_WORKDIR_PROBE_CMD: "echo SHOULD_NOT_BE_CALLED" })
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/deploy source must be clean/);
    expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
  });

  it("refuses a non-addressable (non-git) source tree", async () => {
    const src = tmpDir("dg-notgit-");
    const remote = tmpDir("dg-remote-");
    const r = await runScript("deploy", src, baseEnv(remote));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not an addressable Git checkout/);
    expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
  });

  it("refuses when the remote WorkingDirectory does not match DEPLOY_REMOTE_DIR", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const r = await runScript("deploy", src, baseEnv(remote, { DEPLOY_WORKDIR_PROBE_CMD: "echo /some/other/path" }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the configured/);
    expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
  });

  it("leaves the marker absent when the tailnet health probe fails", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const local = await startOkServer();
    const badTailnet = await closedPortUrl();
    const r = await runScript(
      "deploy",
      src,
      baseEnv(remote, {
        DEPLOY_HEALTH_LOCAL_URL: local.url,
        DEPLOY_HEALTH_TAILNET_URL: badTailnet,
        DEPLOY_CAPABILITY_URL: "http://127.0.0.1:1/unused",
      })
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/tailnet health probe failed/);
    expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
  });

  it("leaves the marker absent when the authenticated capability probe is rejected (wrong key)", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const local = await startOkServer();
    const tailnet = await startOkServer();
    const cap = await startCapabilityServer(OWNER_KEY);
    const r = await runScript(
      "deploy",
      src,
      baseEnv(remote, {
        DEPLOY_HEALTH_LOCAL_URL: local.url,
        DEPLOY_HEALTH_TAILNET_URL: tailnet.url,
        DEPLOY_CAPABILITY_URL: cap.url,
        HOMESERVER_OWNER_KEY: "wrong-key",
      })
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/authenticated capability probe returned HTTP 401/);
    expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
  });

  it("writes the exact 40-char marker only after every probe passes, and never logs the bearer key", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const local = await startOkServer();
    const tailnet = await startOkServer();
    const cap = await startCapabilityServer(OWNER_KEY);
    const r = await runScript(
      "deploy",
      src,
      baseEnv(remote, {
        DEPLOY_HEALTH_LOCAL_URL: local.url,
        DEPLOY_HEALTH_TAILNET_URL: tailnet.url,
        DEPLOY_CAPABILITY_URL: cap.url,
      })
    );
    expect(r.status).toBe(0);
    const sha = headSha(src);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const marker = readFileSync(join(remote, ".deployed-commit"), "utf8").trim();
    expect(marker).toBe(sha);
    expect(r.stdout + r.stderr).not.toContain(OWNER_KEY);
  });

  it("restarts on the first deploy but skips the restart on an immediately repeated, unchanged deploy", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const local = await startOkServer();
    const tailnet = await startOkServer();
    const cap = await startCapabilityServer(OWNER_KEY);
    const env = baseEnv(remote, {
      DEPLOY_HEALTH_LOCAL_URL: local.url,
      DEPLOY_HEALTH_TAILNET_URL: tailnet.url,
      DEPLOY_CAPABILITY_URL: cap.url,
    });

    const r1 = await runScript("deploy", src, env);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toMatch(/Restarting home-gateway\.service \(payload changed\)/);

    const r2 = await runScript("deploy", src, env);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/Skipping restart -- rsync reported no changes/);
  });

  it("dry-run prints a plan and never mutates anything, even against a matching remote", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const r = await runScript("dry-run", src, baseEnv(remote));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PLAN: would deploy commit [0-9a-f]{40}/);
    expect(r.stdout).toMatch(/PLAN: remote WorkingDirectory verified/);
    expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
  });

  it("dry-run refuses on a path mismatch instead of silently planning against the wrong target", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const r = await runScript("dry-run", src, baseEnv(remote, { DEPLOY_WORKDIR_PROBE_CMD: "echo /wrong" }));
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/WorkingDirectory check FAILED|does not match the configured/);
  });

  it("verify reports the marker commit and confirms a spot-checked file's content", async () => {
    const src = initSourceRepo();
    mkdirSync(join(src, "src", "homeserver"), { recursive: true });
    writeFileSync(join(src, "src", "homeserver", "gateway.ts"), "export const marker = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: src });
    execFileSync("git", ["commit", "-q", "-m", "add gateway.ts"], { cwd: src });
    const sha = headSha(src);

    const remote = tmpDir("dg-remote-");
    mkdirSync(join(remote, "src", "homeserver"), { recursive: true });
    writeFileSync(join(remote, "src", "homeserver", "gateway.ts"), "export const marker = 1;\n");
    // learning-task-contract.ts (also in the default spot-check set) is deliberately omitted on
    // the remote here, to prove verify degrades to a WARN for a missing file instead of crashing.
    writeFileSync(join(remote, ".deployed-commit"), `${sha}\n`);

    const r = await runScript("verify", src, baseEnv(remote));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Marker commit: ${sha}`);
    expect(r.stdout).toMatch(/OK: src\/homeserver\/gateway\.ts content matches marker commit/);
  });

  it("verify flags a content mismatch instead of trusting a stale marker", async () => {
    const src = initSourceRepo();
    mkdirSync(join(src, "src", "homeserver"), { recursive: true });
    writeFileSync(join(src, "src", "homeserver", "gateway.ts"), "export const marker = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: src });
    execFileSync("git", ["commit", "-q", "-m", "add gateway.ts"], { cwd: src });
    const sha = headSha(src);

    const remote = tmpDir("dg-remote-");
    mkdirSync(join(remote, "src", "homeserver"), { recursive: true });
    writeFileSync(join(remote, "src", "homeserver", "gateway.ts"), "export const marker = 2; // hand-edited\n");
    writeFileSync(join(remote, ".deployed-commit"), `${sha}\n`);

    const r = await runScript("verify", src, baseEnv(remote));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/MISMATCH: src\/homeserver\/gateway\.ts differs from marker commit/);
  });

  it("verify WARNs on a spot-check file genuinely missing on the remote instead of aborting the whole run", async () => {
    // Regression test: an earlier version piped the remote hash lookup through `set -e` +
    // `pipefail` without a trailing `|| true`, so a truly-missing remote file (both shasum and
    // sha256sum failing) killed the entire `verify` process instead of reaching the intended
    // per-file WARN branch. Caught by hand-verifying an M5 (qwen3-30b-instruct) review of this
    // script's failure paths, which raised a different, false-positive claim about the deploy
    // path but prompted the empirical check that found this real bug in the verify path instead.
    const src = initSourceRepo();
    mkdirSync(join(src, "src", "homeserver"), { recursive: true });
    writeFileSync(join(src, "src", "homeserver", "gateway.ts"), "export const marker = 1;\n");
    execFileSync("git", ["add", "-A"], { cwd: src });
    execFileSync("git", ["commit", "-q", "-m", "add gateway.ts"], { cwd: src });
    const sha = headSha(src);

    const remote = tmpDir("dg-remote-"); // gateway.ts intentionally never created here
    writeFileSync(join(remote, ".deployed-commit"), `${sha}\n`);

    const r = await runScript("verify", src, baseEnv(remote));
    expect(r.status).not.toBe(0);
    // Must reach the graceful WARN branch and finish normally, not die with a bash/pipefail error.
    expect(r.stdout).toMatch(/WARN: could not hash remote src\/homeserver\/gateway\.ts/);
    expect(r.stdout).toContain(`Marker commit: ${sha}`);
    expect(r.stderr).not.toMatch(/set -e|pipefail|unbound variable/i);
  });

  it("verify reports no marker as a failure without mutating anything", async () => {
    const src = initSourceRepo();
    const remote = tmpDir("dg-remote-");
    const r = await runScript("verify", src, baseEnv(remote));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/no \.deployed-commit marker present/);
  });
});
