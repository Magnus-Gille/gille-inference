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
    // Benign defaults for the issue #30 interpreter preflight: a fixture ExecStart line whose
    // path is never actually stat'd because DEPLOY_INTERPRETER_CHECK_CMD is stubbed to "true".
    // Tests that specifically exercise the preflight override both of these directly.
    DEPLOY_EXECSTART_PROBE_CMD: `echo '{ path=${remoteDir}/node_modules/.bin/tsx ; argv[]=${remoteDir}/node_modules/.bin/tsx src/homeserver/cli.ts serve ; }'`,
    DEPLOY_INTERPRETER_CHECK_CMD: "true",
    // Benign no-op stub for the gi#49 autonomy-tick unit install/enable step: like every other
    // remote-mutating step, tests that don't specifically exercise it must never touch a real
    // user systemd session or $HOME/.config/systemd/user. Tests that care override this directly.
    DEPLOY_UNITS_INSTALL_CMD: "true",
    HOMESERVER_OWNER_KEY: OWNER_KEY,
    ...overrides,
  };
}

/** Writes docs/m5-routing.json into a source-repo fixture and commits it, so deploy-gateway.sh's
 *  routing-table seed logic (issue #44) has a real "committed table" to sync from. `content`
 *  defaults to a distinguishable fixture table so tests can assert exactly which bytes ended up
 *  on the "remote". */
function writeCommittedRoutingTable(srcDir: string, content = '{"routing":{},"escalateToFrontier":[],"_fixture":"committed"}\n'): void {
  mkdirSync(join(srcDir, "docs"), { recursive: true });
  writeFileSync(join(srcDir, "docs", "m5-routing.json"), content);
  execFileSync("git", ["add", "-A"], { cwd: srcDir });
  execFileSync("git", ["commit", "-q", "-m", "add fixture routing table"], { cwd: srcDir });
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
    // gi#49: the autonomy-tick systemd unit install/enable step must appear in the plan too.
    expect(r.stdout).toMatch(/PLAN: install\/enable user-scope systemd units \(gille-autonomy-tick/);
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

  describe("routing-table copy-if-absent seeding (issue #44)", () => {
    it("an already-adopted routing table SURVIVES a deploy (adopt -> deploy -> still adopted)", async () => {
      const src = initSourceRepo();
      writeCommittedRoutingTable(src, '{"routing":{},"escalateToFrontier":[],"_fixture":"committed-v2"}\n');
      const remote = tmpDir("dg-remote-");
      // Simulate the #7 routing-lifecycle CLI's `adopt` having already written a human-approved
      // table directly onto the box, out of band from any deploy.
      mkdirSync(join(remote, "docs"), { recursive: true });
      const adoptedContent = '{"routing":{"code-implement":{"model":"mellum"}},"escalateToFrontier":[],"_fixture":"ADOPTED-BY-OPERATOR"}\n';
      writeFileSync(join(remote, "docs", "m5-routing.json"), adoptedContent);

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
      // The whole point of #44: the deploy must NOT revert the box to the committed table.
      expect(readFileSync(join(remote, "docs", "m5-routing.json"), "utf8")).toBe(adoptedContent);
      expect(r.stdout).toMatch(/OK: docs\/m5-routing\.json already present on the remote -- left untouched/);
    });

    it("a fresh box with no routing table gets seeded with the committed copy", async () => {
      const src = initSourceRepo();
      const committedContent = '{"routing":{},"escalateToFrontier":[],"_fixture":"committed-v1"}\n';
      writeCommittedRoutingTable(src, committedContent);
      const remote = tmpDir("dg-remote-"); // no docs/m5-routing.json here at all

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
      expect(readFileSync(join(remote, "docs", "m5-routing.json"), "utf8")).toBe(committedContent);
      expect(r.stdout).toMatch(/SEEDED: docs\/m5-routing\.json was absent on the remote/);
    });

    it("the main rsync excludes docs/m5-routing.json (never deletes or reverts it via --delete either)", async () => {
      const src = initSourceRepo();
      writeCommittedRoutingTable(src, '{"routing":{},"escalateToFrontier":[],"_fixture":"committed"}\n');
      const remote = tmpDir("dg-remote-");
      mkdirSync(join(remote, "docs"), { recursive: true });
      const adoptedContent = '{"routing":{},"escalateToFrontier":[],"_fixture":"ADOPTED"}\n';
      writeFileSync(join(remote, "docs", "m5-routing.json"), adoptedContent);
      // An unrelated stale file that SHOULD be removed by --delete, to prove the exclude is
      // scoped to the one path and doesn't accidentally disable --delete generally.
      writeFileSync(join(remote, "docs", "stale-unrelated-file.md"), "should be deleted\n");

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
      expect(readFileSync(join(remote, "docs", "m5-routing.json"), "utf8")).toBe(adoptedContent);
      expect(existsSync(join(remote, "docs", "stale-unrelated-file.md"))).toBe(false);
    });
  });

  describe("ExecStart interpreter preflight before restart (issue #30)", () => {
    it("refuses to restart (and never invokes the restart command) when the ExecStart interpreter is missing", async () => {
      const src = initSourceRepo();
      const remote = tmpDir("dg-remote-");
      const missingTsxPath = join(remote, "node_modules", ".bin", "tsx"); // deliberately never created
      const sentinel = join(remote, "RESTARTED_SENTINEL");

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
          DEPLOY_EXECSTART_PROBE_CMD: `echo '{ path=${missingTsxPath} ; argv[]=${missingTsxPath} src/homeserver/cli.ts serve ; }'`,
          DEPLOY_INTERPRETER_CHECK_CMD: "", // empty falls back to the script's real default: test -x "$exec_path"
          DEPLOY_RESTART_CMD: `touch '${sentinel}'`,
        })
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/ExecStart interpreter .* is missing or not executable after/);
      expect(r.stderr).toMatch(/issue #30/);
      expect(existsSync(sentinel)).toBe(false); // restart must never have been attempted
      expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
    });

    it("proceeds with the restart when the ExecStart interpreter is present and executable", async () => {
      const src = initSourceRepo();
      const remote = tmpDir("dg-remote-");
      const tsxPath = join(remote, "node_modules", ".bin", "tsx");
      mkdirSync(join(remote, "node_modules", ".bin"), { recursive: true });
      writeFileSync(tsxPath, "#!/bin/sh\n");
      execFileSync("chmod", ["+x", tsxPath]);
      const sentinel = join(remote, "RESTARTED_SENTINEL");

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
          DEPLOY_EXECSTART_PROBE_CMD: `echo '{ path=${tsxPath} ; argv[]=${tsxPath} src/homeserver/cli.ts serve ; }'`,
          DEPLOY_INTERPRETER_CHECK_CMD: "", // real default: test -x "$exec_path"
          DEPLOY_RESTART_CMD: `touch '${sentinel}'`,
        })
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/OK: ExecStart interpreter present and executable/);
      expect(existsSync(sentinel)).toBe(true);
      expect(readFileSync(join(remote, ".deployed-commit"), "utf8").trim()).toBe(headSha(src));
    });
  });

  describe("local health probe default (issue #30)", () => {
    it("does not require DEPLOY_HEALTH_LOCAL_URL by default -- an unset local probe is skipped, not deploy-blocking", async () => {
      const src = initSourceRepo();
      const remote = tmpDir("dg-remote-");
      const tailnet = await startOkServer();
      const cap = await startCapabilityServer(OWNER_KEY);
      const r = await runScript(
        "deploy",
        src,
        baseEnv(remote, {
          // DEPLOY_HEALTH_LOCAL_URL intentionally omitted -- must default to unset/best-effort.
          DEPLOY_HEALTH_TAILNET_URL: tailnet.url,
          DEPLOY_CAPABILITY_URL: cap.url,
        })
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/SKIP: local health probe not configured/);
      expect(readFileSync(join(remote, ".deployed-commit"), "utf8").trim()).toBe(headSha(src));
    });

    it("still refuses when the REQUIRED tailnet probe is unset -- only the local default became optional", async () => {
      const src = initSourceRepo();
      const remote = tmpDir("dg-remote-");
      const cap = await startCapabilityServer(OWNER_KEY);
      const r = await runScript(
        "deploy",
        src,
        baseEnv(remote, {
          DEPLOY_CAPABILITY_URL: cap.url,
          // DEPLOY_HEALTH_TAILNET_URL intentionally omitted -- still mandatory.
        })
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/tailnet health URL is not set/);
      expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
    });
  });

  describe("gi#49 autonomy-tick systemd unit install/enable", () => {
    it("invokes the unit-install step after the remote install and before the restart, as part of a normal deploy", async () => {
      const src = initSourceRepo();
      const remote = tmpDir("dg-remote-");
      const orderLog = join(remote, "ORDER_LOG");
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
          DEPLOY_INSTALL_CMD: `echo install >> '${orderLog}'`,
          DEPLOY_UNITS_INSTALL_CMD: `echo units >> '${orderLog}'`,
          DEPLOY_RESTART_CMD: `echo restart >> '${orderLog}'`,
        })
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/Installing\/enabling the gi#49 autonomy-tick user-scope systemd timer/);
      // Order matters: npm install -> unit install/enable -> restart (never the reverse).
      const order = readFileSync(orderLog, "utf8").trim().split("\n");
      expect(order).toEqual(["install", "units", "restart"]);
      expect(readFileSync(join(remote, ".deployed-commit"), "utf8").trim()).toBe(headSha(src));
    });

    it("fails the whole deploy (nonzero, no marker, restart never reached) when the unit install/enable fails", async () => {
      const src = initSourceRepo();
      const remote = tmpDir("dg-remote-");
      const restartSentinel = join(remote, "RESTARTED_SENTINEL");
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
          DEPLOY_UNITS_INSTALL_CMD: "false", // simulates a failed cp/daemon-reload/enable --now
          DEPLOY_RESTART_CMD: `touch '${restartSentinel}'`,
        })
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/failed to install\/enable gille-autonomy-tick\.timer \(gi#49\)/);
      expect(existsSync(restartSentinel)).toBe(false); // restart must never have been attempted
      expect(existsSync(join(remote, ".deployed-commit"))).toBe(false);
    });
  });
});
