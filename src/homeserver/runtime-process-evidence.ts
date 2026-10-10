/** Read-only Linux listener-holder evidence. No argv, environment or executable bytes. */
import { createHash } from "node:crypto";
import { open, opendir, readlink, stat } from "node:fs/promises";
import { endianness } from "node:os";
import { performance } from "node:perf_hooks";
import { validateBackendTargets } from "./backend-activity-observation.js";
import { findLoopbackListener, parseProcessStartTicks } from "./runtime-proc-parsers.js";

export interface RuntimeProcessEvidence {
  state: "observed" | "unknown";
  reason: "sampled" | "unsupported-platform" | "invalid-process" | "namespace-mismatch" | "listener-mismatch" | "process-changed" | "read-failed" | "timeout";
  identitySha256: string | null;
  hostBootIdSha256: string | null;
}
/** Injection seam for deterministic fixtures; CLI always uses the native reader. */
export interface RuntimeProcessReader {
  platform: string;
  endianness: string;
  readText(path: string, maxBytes: number): Promise<string>;
  readLink(path: string): Promise<string>;
  executableIdentity(path: string): Promise<string>;
  descriptorNames(path: string): Promise<string[]>;
}
const nativeReader: RuntimeProcessReader = {
  platform: process.platform,
  endianness: endianness(),
  async readText(path, maxBytes) {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > maxBytes) throw new Error("metadata too large");
      return buffer.subarray(0, size).toString("utf8");
    } finally { await file.close(); }
  },
  readLink: readlink,
  async executableIdentity(path) {
    // Deliberately follow the kernel's /proc/PID/exe magic link, but never read its bytes/path.
    const info = await stat(path, { bigint: true });
    if (!info.isFile() || info.size <= 0n) throw new Error("invalid executable metadata");
    return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":");
  },
  async descriptorNames(path) {
    const directory = await opendir(path);
    const names: string[] = [];
    for await (const entry of directory) {
      if (names.length >= 1024 || !/^[0-9]+$/.test(entry.name)) throw new Error("descriptor limit");
      names.push(entry.name);
    }
    return names;
  },
};
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const unknown = (reason: RuntimeProcessEvidence["reason"]): RuntimeProcessEvidence => ({ state: "unknown", reason, identitySha256: null, hostBootIdSha256: null });
class ObservationFailure extends Error {
  constructor(readonly reason: RuntimeProcessEvidence["reason"]) { super(reason); }
}

/** Stable samples prove a declared PID held a listener descriptor, not exclusive handling or release identity. */
export async function observeRuntimeProcess(
  target: { pid: number; url: string },
  opts: { timeoutMs?: number; reader?: RuntimeProcessReader; signal?: AbortSignal } = {},
): Promise<RuntimeProcessEvidence> {
  validateBackendTargets([{ id: "runtime", url: target.url }]);
  if (!Number.isSafeInteger(target.pid) || target.pid < 1 || target.pid > 2147483647) throw new Error("invalid runtime PID");
  const timeoutMs = opts.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error("invalid observation timeout");
  const reader = opts.reader ?? nativeReader;
  if (reader.platform !== "linux" || reader.endianness !== "LE") return unknown("unsupported-platform");
  const url = new URL(target.url);
  const base = `/proc/${target.pid}`;
  const deadlineAt = performance.now() + timeoutMs;
  let expired = false;
  const check = (): void => { if (expired || opts.signal?.aborted || performance.now() >= deadlineAt) throw new ObservationFailure("timeout"); };
  const read = async <T>(operation: () => Promise<T>): Promise<T> => {
    check();
    const result = await operation();
    check();
    return result;
  };
  const snapshot = async (): Promise<{ identity: string; host: string }> => {
    const boot = (await read(() => reader.readText("/proc/sys/kernel/random/boot_id", 64))).trim();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(boot)) throw new ObservationFailure("invalid-process");
    const ticks = parseProcessStartTicks(await read(() => reader.readText(`${base}/stat`, 65536)), target.pid);
    if (ticks === null) throw new ObservationFailure("invalid-process");
    const namespaces: string[] = [];
    for (const kind of ["net", "pid"] as const) {
      const self = await read(() => reader.readLink(`/proc/self/ns/${kind}`));
      const other = await read(() => reader.readLink(`${base}/ns/${kind}`));
      if (!new RegExp(`^${kind}:\\[[1-9][0-9]*\\]$`).test(self) || self !== other) throw new ObservationFailure("namespace-mismatch");
      namespaces.push(self);
    }
    const executable = await read(() => reader.executableIdentity(`${base}/exe`));
    const tcp = await read(() => reader.readText("/proc/net/tcp", 1048576));
    const tcp6 = await read(() => reader.readText("/proc/net/tcp6", 1048576));
    const inode = findLoopbackListener(tcp, tcp6, url.hostname as "127.0.0.1" | "[::1]", Number(url.port || 80));
    if (inode === null) throw new ObservationFailure("listener-mismatch");
    const descriptors = await read(() => reader.descriptorNames(`${base}/fd`));
    if (descriptors.length > 1024 || descriptors.some(name => !/^[0-9]+$/.test(name))) throw new ObservationFailure("read-failed");
    let holdsListener = false;
    for (const descriptor of descriptors) {
      const link = await read(() => reader.readLink(`${base}/fd/${descriptor}`));
      if (link === `socket:[${inode}]`) { holdsListener = true; break; }
    }
    if (!holdsListener) throw new ObservationFailure("listener-mismatch");
    return {
      identity: digest(JSON.stringify(["runtime-listener-holder-v1", boot, namespaces, target.pid, ticks, executable, url.hostname, url.port || "80", inode])),
      host: digest(`host-boot-v1:${boot}`),
    };
  };
  const run = async (): Promise<RuntimeProcessEvidence> => {
    try {
      const before = await snapshot();
      const after = await snapshot();
      check();
      if (before.identity !== after.identity || before.host !== after.host) return unknown("process-changed");
      return { state: "observed", reason: "sampled", identitySha256: after.identity, hostBootIdSha256: after.host };
    } catch (error) { return unknown(error instanceof ObservationFailure ? error.reason : "read-failed"); }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<RuntimeProcessEvidence>(resolve => {
    timer = setTimeout(() => { expired = true; resolve(unknown("timeout")); }, timeoutMs);
  });
  try { return await Promise.race([run(), deadline]); }
  finally { expired = true; clearTimeout(timer); }
}
