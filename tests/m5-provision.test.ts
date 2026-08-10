import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommandRunner, ensureProvisionProfile, provisionProfile } from "../client/m5-provision.mjs";

const SECRET = "hs_owner_provision-never-print";
const tempDirs: string[] = [];

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "m5-provision-test-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: (encoding: string) => void };
    stderr: EventEmitter & { setEncoding: (encoding: string) => void };
    stdin: { end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn();
  return child;
}

describe("m5 provisioning command runner", () => {
  it("rejects a timed-out command even when it later closes cleanly", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const run = createCommandRunner({ spawn: () => child });
    const pending = expect(run("ssh", ["m5"], { timeoutMs: 100 })).rejects.toMatchObject({ code: "provision_command_timeout" });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 0, null);

    await pending;
  });

  it("escalates an unresponsive timed-out command to SIGKILL", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const run = createCommandRunner({ spawn: () => child });
    const pending = expect(run("ssh", ["m5"], { timeoutMs: 100 })).rejects.toMatchObject({ code: "provision_command_timeout" });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await pending;
  });
});

describe("m5 provisioning profile configuration", () => {
  it("creates a non-secret public profile atomically", () => {
    const configPath = tempConfig();
    const profile = ensureProvisionProfile({
      configPath,
      profile: "pi",
      publicGatewayUrl: "https://inference.example.test/ignored-path",
    });

    expect(profile).toEqual({ publicGatewayUrl: "https://inference.example.test" });
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      version: 1,
      profiles: { pi: { publicGatewayUrl: "https://inference.example.test" } },
    });
    expect(readFileSync(configPath, "utf8")).not.toContain("hs_owner_");
  });

  it("refuses to silently replace an existing public gateway URL", () => {
    const configPath = tempConfig();
    ensureProvisionProfile({ configPath, profile: "pi", publicGatewayUrl: "https://one.example.test" });
    expect(() => ensureProvisionProfile({
      configPath,
      profile: "pi",
      publicGatewayUrl: "https://two.example.test",
    })).toThrow(/different publicGatewayUrl/);
  });
});

describe("m5 provisioning credential ceremony", () => {
  it("uses only fixed remote commands, stdin-only Keychain storage, and no bearer result", async () => {
    const configPath = tempConfig();
    const calls: Array<{ command: string; args: string[]; input: string; captureStdout?: boolean }> = [];
    const run = async (command: string, args: string[], options: { input?: string; captureStdout?: boolean }) => {
      calls.push({ command, args, input: options.input ?? "", captureStdout: options.captureStdout });
      if (command === "security") return { code: 44, stdout: "", stderr: "" };
      if (command === "ssh" && args.includes("mint")) {
        return { code: 0, stdout: `minted owner key\n${SECRET}\n`, stderr: "" };
      }
      if (command === "script") return { code: 0, stdout: "", stderr: "" };
      throw new Error(`unexpected command ${command}`);
    };

    const result = await provisionProfile({
      profile: "pi",
      publicGatewayUrl: "https://inference.example.test",
      sshTarget: "magnus@m5",
      configPath,
      run,
      now: new Date("2026-08-10T21:59:00Z"),
    });

    expect(result).toEqual({ profileConfig: { publicGatewayUrl: "https://inference.example.test" } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const ssh = calls.find((call) => call.command === "ssh")!;
    expect(ssh.input).toContain("nsenter -t");
    const remoteArgs = ssh.args.slice(ssh.args.indexOf("sudo -n /bin/sh -s --") + 2);
    expect(["keys", ...remoteArgs]).toEqual([
      "keys", "mint", "--alias", "agent-pi-20260810T215900", "--tier", "owner", "--scope", "agent",
    ]);
    expect(ssh.args).not.toContain(SECRET);
    const store = calls.find((call) => call.command === "script")!;
    expect(store.args).toEqual([
      "-q", "/dev/null", "/usr/bin/security", "add-generic-password",
      "-a", "gateway-agent-pi", "-s", "gille-inference", "-w",
    ]);
    expect(store.input).toBe(`${SECRET}\n${SECRET}\n`);
    expect(store.captureStdout).toBe(false);
  });

  it("refuses a pre-existing Keychain item before the remote mint", async () => {
    const configPath = tempConfig();
    const run = async (command: string) => {
      if (command === "security") return { code: 0, stdout: "", stderr: "" };
      throw new Error("remote mint must not run");
    };
    await expect(provisionProfile({
      profile: "pi",
      publicGatewayUrl: "https://inference.example.test",
      sshTarget: "m5",
      configPath,
      run,
    })).rejects.toMatchObject({ code: "keychain_item_exists" });
  });

  it("revokes the exact fresh alias if Keychain storage fails", async () => {
    const configPath = tempConfig();
    const sshCalls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      if (command === "security") return { code: 44, stdout: "", stderr: "" };
      if (command === "ssh") {
        sshCalls.push(args);
        if (args.includes("mint")) return { code: 0, stdout: SECRET, stderr: "" };
        if (args.includes("revoke")) return { code: 0, stdout: "revoked", stderr: "" };
      }
      if (command === "script") return { code: 1, stdout: "", stderr: "Keychain rejected input" };
      throw new Error(`unexpected ${command}`);
    };
    await expect(provisionProfile({
      profile: "pi",
      publicGatewayUrl: "https://inference.example.test",
      sshTarget: "m5",
      configPath,
      run,
      now: new Date("2026-08-10T22:00:00Z"),
    })).rejects.toMatchObject({ code: "keychain_store_failed_revoked" });
    expect(sshCalls).toHaveLength(2);
    const revokeArgs = sshCalls[1].slice(sshCalls[1].indexOf("sudo -n /bin/sh -s --") + 2);
    expect(["keys", ...revokeArgs]).toEqual([
      "keys", "revoke", "--alias", "agent-pi-20260810T220000",
    ]);
    expect(JSON.stringify(sshCalls)).not.toContain(SECRET);
  });

  it("revokes the fresh alias if mint output is malformed rather than leaving an orphaned credential", async () => {
    const configPath = tempConfig();
    const sshCalls: string[][] = [];
    const run = async (command: string, args: string[]) => {
      if (command === "security") return { code: 44, stdout: "", stderr: "" };
      if (command === "ssh") {
        sshCalls.push(args);
        if (args.includes("mint")) return { code: 0, stdout: `${SECRET}\n${SECRET}`, stderr: "" };
        if (args.includes("revoke")) return { code: 0, stdout: "revoked", stderr: "" };
      }
      throw new Error(`unexpected ${command}`);
    };
    await expect(provisionProfile({
      profile: "pi", publicGatewayUrl: "https://inference.example.test", sshTarget: "m5", configPath, run,
    })).rejects.toMatchObject({ code: "mint_output_invalid_revoked" });
    expect(sshCalls).toHaveLength(2);
    expect(sshCalls[1]).toContain("revoke");
  });

  it("revokes the exact alias after an uncertain nonzero mint failure", async () => {
    const configPath = tempConfig();
    const sshCalls: string[][] = [];
    const alias = "agent-pi-20260810T220100";
    const run = async (command: string, args: string[]) => {
      if (command === "security") return { code: 44, stdout: "", stderr: "" };
      if (command === "ssh") {
        sshCalls.push(args);
        if (args.includes("mint")) return { code: 255, stdout: "", stderr: `disconnect after ${alias} ${SECRET}` };
        if (args.includes("revoke")) return { code: 0, stdout: "revoked", stderr: "" };
      }
      throw new Error(`unexpected ${command}`);
    };

    const failure = provisionProfile({
      profile: "pi",
      publicGatewayUrl: "https://inference.example.test",
      sshTarget: "m5",
      configPath,
      run,
      now: new Date("2026-08-10T22:01:00Z"),
    });
    await expect(failure).rejects.toMatchObject({ code: "mint_failed_revoked" });
    await expect(failure).rejects.not.toThrow(alias);
    await expect(failure).rejects.not.toThrow(SECRET);
    expect(sshCalls).toHaveLength(2);
    const revokeArgs = sshCalls[1].slice(sshCalls[1].indexOf("sudo -n /bin/sh -s --") + 2);
    expect(["keys", ...revokeArgs]).toEqual(["keys", "revoke", "--alias", alias]);
    expect(sshCalls.join(" ")).not.toContain(SECRET);
  });

  it("reports revocation uncertainty after a mint disconnect and failed revoke", async () => {
    const configPath = tempConfig();
    const sshCalls: string[][] = [];
    const alias = "agent-pi-20260810T220200";
    const run = async (command: string, args: string[]) => {
      if (command === "security") return { code: 44, stdout: "", stderr: "" };
      if (command === "ssh") {
        sshCalls.push(args);
        if (args.includes("mint")) throw new Error(`connection lost after ${alias} ${SECRET}`);
        if (args.includes("revoke")) throw new Error(`revoke unavailable ${SECRET}`);
      }
      throw new Error(`unexpected ${command}`);
    };

    const result = provisionProfile({
      profile: "pi",
      publicGatewayUrl: "https://inference.example.test",
      sshTarget: "m5",
      configPath,
      run,
      now: new Date("2026-08-10T22:02:00Z"),
    });
    await expect(result).rejects.toMatchObject({ code: "mint_failed_revocation_unknown" });
    await expect(result).rejects.not.toThrow(alias);
    await expect(result).rejects.not.toThrow(SECRET);
    expect(sshCalls).toHaveLength(2);
    expect(sshCalls[1]).toContain(alias);
  });
});
