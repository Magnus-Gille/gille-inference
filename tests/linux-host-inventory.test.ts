import { describe, expect, it, vi } from "vitest";
import { observeLinuxHostInventory, type LinuxHostInventoryReader } from "../src/homeserver/linux-host-inventory.js";

const header4 = "sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
const header6 = header4.replace("rem_address", "remote_address");
const row = (port: string, inode: number, state = "0A") => `0: 0100007F:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode}\n`;
const procStat = (pid: number, ticks = "100") => `${pid} (safe name) S ${Array(18).fill("0").join(" ")} ${ticks}`;
function fixture() {
  const text = vi.fn(async (path: string) => {
    if (path === "/proc/sys/kernel/random/boot_id") return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n";
    if (path === "/proc/net/tcp") return header4 + row("1F90", 90) + row("1F90", 91, "01");
    if (path === "/proc/net/tcp6") return header6;
    const match = path.match(/^\/proc\/(\d+)\/stat$/);
    if (match) return procStat(Number(match[1]));
    throw new Error("PRIVATE_UNEXPECTED_PATH");
  });
  const link = vi.fn(async (path: string) => {
    if (path.endsWith("/ns/net")) return "net:[40]";
    if (path.endsWith("/ns/pid")) return "pid:[41]";
    if (path.endsWith("/fd/0")) return "socket:[90]";
    if (path.endsWith("/fd/1")) return "socket:[91]";
    throw new Error("PRIVATE_LINK");
  });
  const reader: LinuxHostInventoryReader = { platform: "linux", endianness: "LE", pidNames: async () => ["20", "3"],
    descriptorNames: async () => ["0", "1"], readText: text, readLink: link, executableIdentity: async () => "1:2:3:4:5:6" };
  return { reader, text, link };
}
describe("Linux visible host inventory", () => {
  it("discovers all visible PIDs and shared listener holders, without claiming host or traffic coverage", async () => {
    const f = fixture(); const result = await observeLinuxHostInventory({ reader: f.reader });
    expect(result).toMatchObject({ observation: "observed", coverage: "unknown", scope: "observer-visible-procfs", reasons: [] });
    expect(result.processes.map(p => p.pid)).toEqual([3, 20]);
    expect(result.listeners).toHaveLength(1);
    expect(result.listeners[0]).toMatchObject({ family: "ipv4", port: 8080, holderPids: [3, 20] });
    expect(result.processes.every(p => p.tcpEstablishedSockets === 1)).toBe(true);
    expect(result.processes.every(p => p.identitySha256?.length === 64)).toBe(true);
    expect(f.text.mock.calls.every(([p]) => /^\/proc\/(sys\/kernel\/random\/boot_id|net\/tcp6?|\d+\/stat)$/.test(p))).toBe(true);
    expect(f.link.mock.calls.every(([p]) => /^\/proc\/(self\/ns\/(net|pid)|\d+\/(ns\/(net|pid)|fd\/\d+))$/.test(p))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("safe name");
  });
  it("retains an inaccessible process as unknown and does not invent an empty host", async () => {
    const f = fixture(); f.reader.descriptorNames = async path => { if (path.includes("/20/")) throw new Error("PRIVATE_DENIED"); return ["0", "1"]; };
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial"); expect(r.processes.find(p => p.pid === 20)?.state).toBe("unknown");
    expect(JSON.stringify(r)).not.toContain("PRIVATE_DENIED");
  });
  it("marks foreign namespaces unknown", async () => {
    const f = fixture(); const base = f.reader.readLink;
    f.reader.readLink = async p => p === "/proc/20/ns/net" ? "net:[99]" : base(p);
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial"); expect(r.processes.find(p => p.pid === 20)?.reason).toBe("namespace-mismatch");
  });
  it("reports listener sockets with no readable holder", async () => {
    const f = fixture(); f.reader.descriptorNames = async () => [];
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial"); expect(r.listeners[0].holderPids).toEqual([]);
    expect(r.reasons).toContain("unattributed-listener");
  });
  it("rejects truncated or malformed global inputs", async () => {
    for (const modify of [
      (r: LinuxHostInventoryReader) => { r.pidNames = async () => ["3", "3"]; },
      (r: LinuxHostInventoryReader) => { const read = r.readText; r.readText = async (p, n) => p === "/proc/net/tcp6" ? "truncated" : read(p, n); },
      (r: LinuxHostInventoryReader) => { const read = r.readText; r.readText = async (p, n) => p === "/proc/net/tcp" ? header4 + row("1F90", 90) + row("1F90", 90, "01") : read(p, n); },
      (r: LinuxHostInventoryReader) => { r.pidNames = async () => { throw new Error("PRIVATE_ERROR"); }; },
    ]) {
      const f = fixture(); modify(f.reader); const r = await observeLinuxHostInventory({ reader: f.reader });
      expect(r.observation).toBe("unknown"); expect(r.processes).toEqual([]);
      expect(JSON.stringify(r)).not.toContain("PRIVATE_ERROR");
    }
  });
  it("marks a PID set change between passes partial", async () => {
    const f = fixture(); let pass = 0; f.reader.pidNames = async () => ++pass === 1 ? ["3"] : ["3", "20"];
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial"); expect(r.reasons).toContain("snapshot-changed");
  });
  it("marks PID reuse during a sample unknown", async () => {
    const f = fixture(); const base = f.reader.readText; let tick = 0;
    f.reader.readText = async (p, n) => p === "/proc/20/stat" ? procStat(20, String(++tick)) : base(p, n);
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial"); expect(r.processes.find(p => p.pid === 20)?.reason).toBe("process-changed");
  });
  it("does not skip malformed or excessive descriptor names", async () => {
    const f = fixture(); f.reader.descriptorNames = async () => ["../cmdline"];
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial"); expect(f.link.mock.calls.some(([p]) => p.includes("cmdline"))).toBe(false);
  });
  it("does not treat a malformed socket link as absence of a socket", async () => {
    const f = fixture(); const base = f.reader.readLink;
    f.reader.readLink = async p => p.endsWith("/fd/1") ? "socket:[broken]" : base(p);
    const r = await observeLinuxHostInventory({ reader: f.reader });
    expect(r.observation).toBe("partial");
    expect(r.processes.every(p => p.state === "unknown")).toBe(true);
  });
  it("marks boot or listener changes between scans partial", async () => {
    for (const path of ["/proc/sys/kernel/random/boot_id", "/proc/net/tcp"]) {
      const f = fixture(); const base = f.reader.readText; let count = 0;
      f.reader.readText = async (p, n) => {
        if (p === path && ++count > 1) return path.endsWith("boot_id") ? "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee" : header4;
        return base(p, n);
      };
      expect((await observeLinuxHostInventory({ reader: f.reader })).reasons).toContain("snapshot-changed");
    }
  });
  it("never labels an empty PID enumeration observed", async () => {
    const f = fixture(); f.reader.pidNames = async () => [];
    expect((await observeLinuxHostInventory({ reader: f.reader })).observation).toBe("unknown");
  });
  it("stops a stalled read promptly without follow-on reads", async () => {
    const f = fixture(); let release!: (v: string[]) => void;
    f.reader.pidNames = () => new Promise(resolve => { release = resolve; });
    const r = await observeLinuxHostInventory({ reader: f.reader, timeoutMs: 5 });
    expect(r.reasons).toEqual(["timeout"]);
    const count = f.text.mock.calls.length; release(["3"]);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.text.mock.calls.length).toBe(count);
  });
  it("cancels pending reads without waiting for the deadline", async () => {
    const f = fixture(); const abort = new AbortController(); f.reader.pidNames = () => new Promise(() => {});
    const pending = observeLinuxHostInventory({ reader: f.reader, signal: abort.signal }); abort.abort();
    expect((await pending).reasons).toEqual(["cancelled"]);
  });
  it("does not start reads when cancelled or unsupported", async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    expect((await observeLinuxHostInventory({ reader: f.reader, signal: abort.signal })).reasons).toEqual(["cancelled"]);
    f.reader.platform = "darwin";
    expect((await observeLinuxHostInventory({ reader: f.reader })).reasons).toEqual(["unsupported-platform"]);
    expect(f.text).not.toHaveBeenCalled();
  });
});
