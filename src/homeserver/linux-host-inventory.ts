/** Visible Linux procfs inventory. Never an all-host boundary or work/admission proof. */
import { createHash } from "node:crypto";
import { open, opendir, readlink, stat } from "node:fs/promises";
import { endianness } from "node:os";
import { performance } from "node:perf_hooks";
import { parseProcessStartTicks, parseProcPidNames, parseProcTcpSockets } from "./runtime-proc-parsers.js";

type Reason = "unsupported-platform" | "read-failed" | "invalid-metadata" | "namespace-mismatch"
  | "process-changed" | "snapshot-changed" | "unattributed-listener" | "timeout" | "cancelled";
export interface LinuxHostInventoryReader {
  platform: string;
  endianness: string;
  pidNames(): Promise<string[]>;
  descriptorNames(path: string): Promise<string[]>;
  readText(path: string, maxBytes: number): Promise<string>;
  readLink(path: string): Promise<string>;
  executableIdentity(path: string): Promise<string>;
}
interface ProcessSample {
  pid: number;
  state: "observed" | "unknown";
  reason: Reason | null;
  identitySha256: string | null;
  tcpEstablishedSockets: number | null;
}
interface Listener {
  family: "ipv4" | "ipv6";
  addressHex: string;
  port: number;
  inodeSha256: string;
  holderPids: number[];
}
export interface LinuxHostInventoryReport {
  source: "linux-host-inventory-v1";
  scope: "observer-visible-procfs";
  observation: "observed" | "partial" | "unknown";
  coverage: "unknown";
  observedAt: string | null;
  completedAt: string | null;
  hostBootIdSha256: string | null;
  namespaceIdentitySha256: string | null;
  processes: ProcessSample[];
  listeners: Listener[];
  reasons: Reason[];
}
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const empty = (reason: Reason): LinuxHostInventoryReport => ({ source: "linux-host-inventory-v1", scope: "observer-visible-procfs",
  observation: "unknown", coverage: "unknown", observedAt: null, completedAt: null, hostBootIdSha256: null,
  namespaceIdentitySha256: null, processes: [], listeners: [], reasons: [reason] });
class Failure extends Error {
  constructor(readonly reason: Reason) { super(reason); }
}
async function names(path: string, limit: number, onlyPids = false): Promise<string[]> {
  const directory = await opendir(path); const result: string[] = []; let entries = 0;
  for await (const entry of directory) {
    if (++entries > limit) throw new Failure("invalid-metadata");
    if (!onlyPids || /^[0-9]+$/.test(entry.name)) result.push(entry.name);
  }
  return result;
}
const nativeReader: LinuxHostInventoryReader = {
  platform: process.platform, endianness: endianness(),
  pidNames: () => names("/proc", 16384, true),
  descriptorNames: path => names(path, 4096),
  readLink: readlink,
  async readText(path, maxBytes) {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1); let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > maxBytes) throw new Failure("invalid-metadata");
      return buffer.subarray(0, size).toString("utf8");
    } finally { await file.close(); }
  },
  async executableIdentity(path) {
    // Only inode metadata, never executable path/content, argv or environment.
    const s = await stat(path, { bigint: true });
    if (!s.isFile() || s.size <= 0n) throw new Failure("invalid-metadata");
    return [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(":");
  },
};

/** Two bounded scans expose changes and read gaps; stability is not an atomic snapshot. */
export async function observeLinuxHostInventory(opts: {
  reader?: LinuxHostInventoryReader; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<LinuxHostInventoryReport> {
  const reader = opts.reader ?? nativeReader;
  const timeout = opts.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error("invalid inventory timeout");
  if (opts.signal?.aborted) return empty("cancelled");
  if (reader.platform !== "linux" || reader.endianness !== "LE") return empty("unsupported-platform");
  const deadline = performance.now() + timeout;
  let stopped: Reason | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveStop!: (report: LinuxHostInventoryReport) => void;
  const stopPromise = new Promise<LinuxHostInventoryReport>(resolve => { resolveStop = resolve; });
  const stop = (reason: Reason): void => { if (!stopped) { stopped = reason; resolveStop(empty(reason)); } };
  const cancelled = (): void => stop("cancelled");
  const check = (): void => {
    if (opts.signal?.aborted) stop("cancelled");
    if (performance.now() >= deadline) stop("timeout");
    if (stopped) throw new Failure(stopped);
  };
  const read = async <T>(op: () => Promise<T>): Promise<T> => { check(); const result = await op(); check(); return result; };
  const namespace = async (base: string, kind: "net" | "pid"): Promise<string> => {
    const value = await read(() => reader.readLink(`${base}/ns/${kind}`));
    if (!new RegExp(`^${kind}:\\[[1-9][0-9]{0,19}\\]$`).test(value)) throw new Failure("invalid-metadata");
    return value;
  };
  const scan = async (): Promise<LinuxHostInventoryReport> => {
    const observedAt = new Date().toISOString();
    const boot = (await read(() => reader.readText("/proc/sys/kernel/random/boot_id", 64))).trim();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) throw new Failure("invalid-metadata");
    const host = hash(`host-boot-v1:${boot}`);
    const ns = [await namespace("/proc/self", "net"), await namespace("/proc/self", "pid")];
    const pids = parseProcPidNames(await read(() => reader.pidNames()));
    if (!pids || pids.length === 0) throw new Failure("invalid-metadata");
    const sockets = parseProcTcpSockets(await read(() => reader.readText("/proc/net/tcp", 1048576)), await read(() => reader.readText("/proc/net/tcp6", 1048576)));
    if (!sockets) throw new Failure("invalid-metadata");
    const listeners: Listener[] = sockets.filter(s => s.state === 10).map(s => ({ family: s.family, addressHex: s.addressHex, port: s.port,
      inodeSha256: hash(`proc-socket-v1:${host}:${ns[0]}:${s.inode}`), holderPids: [] }));
    const listenSockets = sockets.filter(s => s.state === 10);
    const established = new Set(sockets.filter(s => s.state === 1 && s.inode !== "0").map(s => s.inode));
    const processes: ProcessSample[] = []; const reasons = new Set<Reason>();
    for (const pid of pids) {
      const base = `/proc/${pid}`;
      try {
        const identity = async (): Promise<string> => {
          const ticks = parseProcessStartTicks(await read(() => reader.readText(`${base}/stat`, 65536)), pid);
          if (ticks === null) throw new Failure("invalid-metadata");
          const processNs = [await namespace(base, "net"), await namespace(base, "pid")];
          if (processNs.some((value, i) => value !== ns[i])) throw new Failure("namespace-mismatch");
          const exe = await read(() => reader.executableIdentity(`${base}/exe`));
          if (typeof exe !== "string" || !/^[0-9]+(?::[0-9]+){5}$/.test(exe) || exe.length > 256) throw new Failure("invalid-metadata");
          return hash(JSON.stringify(["proc-process-v1", host, pid, ticks, processNs, exe]));
        };
        const before = await identity();
        const descriptors = await read(() => reader.descriptorNames(`${base}/fd`));
        if (descriptors.length > 4096 || new Set(descriptors).size !== descriptors.length || descriptors.some(v => !/^(0|[1-9][0-9]{0,9})$/.test(v))) throw new Failure("invalid-metadata");
        const held = new Set<string>();
        for (const fd of descriptors) {
          const value = await read(() => reader.readLink(`${base}/fd/${fd}`));
          const match = value.match(/^socket:\[([1-9][0-9]{0,19})\]$/);
          if (value.startsWith("socket:") && !match) throw new Failure("invalid-metadata");
          if (match) held.add(match[1]);
        }
        if (before !== await identity()) throw new Failure("process-changed");
        processes.push({ pid, state: "observed", reason: null, identitySha256: before,
          tcpEstablishedSockets: [...held].filter(inode => established.has(inode)).length });
        listenSockets.forEach((socket, i) => { if (held.has(socket.inode)) listeners[i].holderPids.push(pid); });
      } catch (error) {
        check(); // Deadline/cancellation must not turn into a per-process read gap and continue scanning.
        const reason = error instanceof Failure ? error.reason : "read-failed";
        reasons.add(reason);
        processes.push({ pid, state: "unknown", reason, identitySha256: null, tcpEstablishedSockets: null });
      }
    }
    if (listeners.some(listener => listener.holderPids.length === 0)) reasons.add("unattributed-listener");
    listeners.sort((a, b) => a.family.localeCompare(b.family) || a.port - b.port || a.addressHex.localeCompare(b.addressHex) || a.inodeSha256.localeCompare(b.inodeSha256));
    return { source: "linux-host-inventory-v1", scope: "observer-visible-procfs", observation: reasons.size ? "partial" : "observed", coverage: "unknown",
      observedAt, completedAt: new Date().toISOString(), hostBootIdSha256: host, namespaceIdentitySha256: hash(JSON.stringify(ns)), processes, listeners, reasons: [...reasons].sort() };
  };
  const run = async (): Promise<LinuxHostInventoryReport> => {
    try {
      const before = await scan(), after = await scan(); check();
      const signature = (r: LinuxHostInventoryReport): string => JSON.stringify([r.hostBootIdSha256, r.namespaceIdentitySha256, r.processes, r.listeners]);
      if (signature(before) !== signature(after)) {
        after.observation = "partial"; after.reasons = [...new Set([...before.reasons, ...after.reasons, "snapshot-changed" as const])].sort();
      }
      after.observedAt = before.observedAt;
      return after;
    } catch (error) { return empty(error instanceof Failure ? error.reason : "read-failed"); }
  };
  opts.signal?.addEventListener("abort", cancelled, { once: true });
  timer = setTimeout(() => stop("timeout"), timeout);
  try { return await Promise.race([run(), stopPromise]); }
  finally { stopped ??= "cancelled"; clearTimeout(timer); opts.signal?.removeEventListener("abort", cancelled); }
}
