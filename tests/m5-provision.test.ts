import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProvisionProfile, provisionProfile } from "../client/m5-provision.mjs";

const SECRET = "hs_owner_provision-never-print";
const tempDirs: string[] = [];

function tempConfig() {
  const dir = mkdtempSync(join(tmpdir(), "m5-provision-test-"));
  tempDirs.push(dir);
  return join(dir, "config.json");
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
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
    expect(ssh.args).toContain("agent");
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
    expect(sshCalls[1]).toContain("revoke");
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
});
