import { describe, expect, it } from "vitest";
import { observeRuntimeProcess, type RuntimeProcessReader } from "../src/homeserver/runtime-process-evidence.js";

const stat = `42 (runtime (worker)) S ${Array(18).fill("0").join(" ")} 100`;
const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode";
const tcp = `${header}\n 0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1000 0 789`;
function reader(overrides: Partial<RuntimeProcessReader> = {}): RuntimeProcessReader {
  return {
    platform: "linux", endianness: "LE",
    readText: async path => path.endsWith("boot_id") ? "12345678-1234-1234-1234-123456789abc\n" : path.endsWith("/stat") ? stat : path.endsWith("tcp6") ? header.replace("rem_address", "remote_address") : tcp,
    readLink: async path => path.endsWith("/net") ? "net:[101]" : path.endsWith("/pid") ? "pid:[102]" : "socket:[789]",
    executableIdentity: async () => "1:2:33261:4096:100:100",
    descriptorNames: async () => ["0", "1", "2"],
    ...overrides,
  };
}
const target = { pid: 42, url: "http://127.0.0.1:8080/metrics" };
describe("runtime process evidence", () => {
  it("produces only opaque identity and host hashes for a stable process holding the listener", async () => {
    const result = await observeRuntimeProcess(target, { reader: reader() });
    expect(result).toMatchObject({ state: "observed", reason: "sampled", identitySha256: expect.stringMatching(/^[a-f0-9]{64}$/), hostBootIdSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(result)).not.toContain("12345678-");
  });
  it("never reads cmdline, environ, or executable bytes", async () => {
    const paths: string[] = [];
    const fixture = reader();
    await observeRuntimeProcess(target, { reader: reader({ readText: async path => { paths.push(path); return fixture.readText(path, 1000000); } }) });
    expect(paths).not.toHaveLength(0);
    expect(paths.every(path => /\/(boot_id|stat|tcp|tcp6)$/.test(path))).toBe(true);
  });
  it("rejects process replacement between samples", async () => {
    let calls = 0;
    const fixture = reader();
    const result = await observeRuntimeProcess(target, { reader: reader({ readText: async (path, limit) => path.endsWith("/stat") && ++calls > 1 ? stat.replace(/100$/, "101") : fixture.readText(path, limit) }) });
    expect(result.reason).toBe("process-changed");
    expect(result.identitySha256).toBeNull();
  });
  it("rejects executable identity changes", async () => {
    let calls = 0;
    expect((await observeRuntimeProcess(target, { reader: reader({ executableIdentity: async () => String(++calls) }) })).reason).toBe("process-changed");
  });
  it("rejects namespace mismatch", async () => {
    const fixture = reader();
    expect((await observeRuntimeProcess(target, { reader: reader({ readLink: async path => path === "/proc/42/ns/net" ? "net:[999]" : fixture.readLink(path) }) })).reason).toBe("namespace-mismatch");
  });
  it("rejects a process that does not hold the listener", async () => {
    expect((await observeRuntimeProcess(target, { reader: reader({ descriptorNames: async () => [] }) })).reason).toBe("listener-mismatch");
  });
  it("fails closed for unsupported host, malformed boot ID and read errors", async () => {
    expect((await observeRuntimeProcess(target, { reader: reader({ platform: "darwin" }) })).reason).toBe("unsupported-platform");
    expect((await observeRuntimeProcess(target, { reader: reader({ readText: async () => "bad" }) })).state).toBe("unknown");
    expect((await observeRuntimeProcess(target, { reader: reader({ readText: async () => { throw new Error("private path"); } }) })).reason).toBe("read-failed");
  });
  it("bounds a stalled reader and stops follow-on reads", async () => {
    let links = 0;
    let release!: (value: string) => void;
    const result = await observeRuntimeProcess(target, { timeoutMs: 5, reader: reader({ readText: () => new Promise(resolve => { release = resolve; }), readLink: async () => { links++; return "net:[101]"; } }) });
    expect(result.reason).toBe("timeout");
    release("12345678-1234-1234-1234-123456789abc");
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(links).toBe(0);
  });
  it("rejects an expired sample even before the timer callback can run", async () => {
    const fixture = reader();
    let calls = 0;
    const result = await observeRuntimeProcess(target, { timeoutMs: 1, reader: reader({ readText: async (path, limit) => {
      if (calls++ === 0) {
        const stop = performance.now() + 5;
        while (performance.now() < stop) { /* model a blocked event loop */ }
      }
      return fixture.readText(path, limit);
    } }) });
    expect(result.reason).toBe("timeout");
    expect(calls).toBe(1);
  });
  it("rejects invalid caller input before I/O", async () => {
    await expect(observeRuntimeProcess({ ...target, pid: 0 })).rejects.toThrow();
    await expect(observeRuntimeProcess({ ...target, url: "http://example.com:8080/metrics" })).rejects.toThrow();
  });
});
