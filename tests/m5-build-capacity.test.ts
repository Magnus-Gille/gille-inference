import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuildStatus, runBuild } from "../client/m5-build.mjs";

const dirs: string[] = [];
const config = { version: 1, sshTarget: "m5-build" };
function repo() {
  const root = mkdtempSync(join(tmpdir(), "m5-capacity-test-")); dirs.push(root);
  const git = (...args: string[]) => {
    const out = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    if (out.status !== 0) throw new Error(out.stderr);
  };
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  writeFileSync(join(root, "tracked.txt"), "tracked"); git("add", "tracked.txt"); git("commit", "-qm", "initial");
  return root;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function capacity(overrides: Record<string, unknown> = {}) {
  return {
    type: "capacity", total_bytes: 64 * 1024 ** 3, used_bytes: 32 * 1024 ** 3,
    free_bytes: 32 * 1024 ** 3, minimum_free_bytes: 1024 ** 3,
    warning_free_bytes: 8 * 1024 ** 3, observed_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...overrides,
  };
}

function childFor(lines: unknown[], closeCode = 0, capturedInput: string[] = []) {
  const child: any = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { write(value: string) { capturedInput.push(value); }, end() {} }; child.kill = vi.fn();
  queueMicrotask(() => { child.stdout.emit("data", Buffer.from(lines.map(line => JSON.stringify(line) + "\n").join(""))); child.emit("close", closeCode); });
  return child;
}

describe("M5 build capacity protocol", () => {
  it("sends the exact status request and accepts healthy or low numeric observations", async () => {
    const input: string[] = [];
    const result = await getBuildStatus({ config, spawnImpl: vi.fn(() => childFor([capacity({ free_bytes: 512 * 1024 ** 2 }), { type: "exit", code: 0 }], 0, input)) as any });
    expect(result.free_bytes).toBe(512 * 1024 ** 2);
    expect(input).toEqual(['{"version":1,"operation":"status"}\n']);
  });

  it.each([
    [capacity({ free_bytes: Number.MAX_SAFE_INTEGER + 1 }), "counter"],
    [capacity({ observed_at: "9999-01-01T00:00:00Z" }), "timestamp"],
    [capacity(), "duplicate"],
  ])("rejects malformed or duplicate status capacity records (%s)", async (record, _label) => {
    const records = _label === "duplicate" ? [record, record, { type: "exit", code: 0 }] : [record, { type: "exit", code: 0 }];
    await expect(getBuildStatus({ config, spawnImpl: vi.fn(() => childFor(records)) as any })).rejects.toMatchObject({ buildCode: "build_protocol_error" });
  });

  it("rejects nonterminal status and SSH exit mismatches", async () => {
    await expect(getBuildStatus({ config, spawnImpl: vi.fn(() => childFor([capacity()])) as any })).rejects.toMatchObject({ buildCode: "build_protocol_error" });
    await expect(getBuildStatus({ config, spawnImpl: vi.fn(() => childFor([capacity(), { type: "exit", code: 0 }], 1)) as any })).rejects.toMatchObject({ buildCode: "build_protocol_error" });
  });

  it("refuses low capacity with a safe local error and no remote message", async () => {
    const root = repo();
    const low = capacity({ free_bytes: 512 * 1024 ** 2 });
    const spawnImpl = vi.fn(() => childFor([low, { type: "error", code: 125, diagnostic_code: "build_capacity_low", message: "/private/secret" }], 125));
    await expect(runBuild({ cwd: root, command: ["true"], config, spawnImpl: spawnImpl as any, stdout: { write() {} } as any, stderr: { write() {} } as any }))
      .rejects.toMatchObject({ buildCode: "build_capacity_low", message: "Remote build filesystem has 536870912 bytes free of 68719476736; at least 1073741824 bytes free are required. Check m5 build status and request scoped cleanup." });
  });

  it("keeps compatibility with a legacy worker that has no capacity record", async () => {
    const root = repo();
    const output: Buffer[] = [];
    const result = await runBuild({ cwd: root, command: ["true"], config,
      spawnImpl: vi.fn(() => childFor([{ type: "stdout", data: Buffer.from("ok").toString("base64") }, { type: "exit", code: 0 }])) as any,
      stdout: { write(value: Buffer) { output.push(value); } } as any, stderr: { write() {} } as any });
    expect(result.exit_code).toBe(0); expect((result as any).capacity).toBeUndefined();
    expect(Buffer.concat(output).toString()).toBe("ok");
  });
});
