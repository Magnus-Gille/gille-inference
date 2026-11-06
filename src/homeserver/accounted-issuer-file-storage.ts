/** LOCAL physical-file CAS candidate. No bootstrap, recovery, collector, CLI or admission publisher. */
import * as fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import { canonicalNative, type IssuerDurableStorage } from "./accounted-host-issuer.js";

const MAX_STATE_BYTES = 524288, MAX_RECORD_BYTES = MAX_STATE_BYTES + 512;
const MAX_REVISION = 8192n; // At most two CAS transitions for each of the issuer's4096claims.
const HEX = /^[0-9a-f]{64}$(?![\s\S])/;
const NOFOLLOW = constants.O_NOFOLLOW, DIRECTORY = constants.O_DIRECTORY, NONBLOCK = constants.O_NONBLOCK;
export class AccountedIssuerStorageError extends Error {
  constructor(readonly code: string, readonly phase: string, cause?: unknown) {
    super(code, {cause}); this.name = "AccountedIssuerStorageError";
  }
}
class ExclusiveCollision extends Error {}
function need(test: unknown, code: string): asserts test {
  if (!test) throw new AccountedIssuerStorageError(code, "validation");
}
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function jsonState(state: unknown): {state: unknown; text: string} {
  const text = canonicalNative(state);
  need(Buffer.byteLength(text) <= MAX_STATE_BYTES, "state_bound");
  const snapshot: unknown = JSON.parse(text);
  need(canonicalNative(snapshot) === text, "state_not_lossless_json");
  return {state: snapshot, text};
}
interface RecordBody {
  schemaVersion: 1; revision: string; originVersion: string | null; parentVersion: string | null;
  state: unknown; stateDigest: string;
}
interface RecordView extends RecordBody {bytes: string; version: string}
function encode(revision: bigint, state: unknown, originVersion: string | null, parentVersion: string | null): RecordView {
  need(revision >= 0n && revision <= MAX_REVISION, "revision_bound");
  const value = jsonState(state), body: RecordBody = {schemaVersion: 1, revision: revision.toString(), originVersion, parentVersion, state: value.state, stateDigest: sha(value.text)};
  const bytes = canonicalNative(body);
  need(Buffer.byteLength(bytes) <= MAX_RECORD_BYTES, "record_bound");
  return {...body, bytes, version: sha("gille-inference/accounted/file-journal/v1\n" + bytes)};
}
/** Pure fixture/artifact encoder only. It does not create a file or initialize a backend. */
export function encodeInitialAccountedIssuerFileRecord(state: unknown): {bytes: string; version: string} {
  const value = encode(0n, state, null, null); return {bytes: value.bytes, version: value.version};
}
function decode(bytes: string, initialVersion: string): RecordView {
  need(Buffer.byteLength(bytes) <= MAX_RECORD_BYTES, "record_bound");
  const raw = JSON.parse(bytes) as Record<string, unknown>;
  need(raw && typeof raw === "object" && !Array.isArray(raw)
    && Object.keys(raw).sort().join(",") === "originVersion,parentVersion,revision,schemaVersion,state,stateDigest", "record_shape");
  need(raw.schemaVersion === 1 && typeof raw.revision === "string" && /^(0|[1-9][0-9]{0,4})$/.test(raw.revision), "record_version");
  const revision = BigInt(raw.revision);
  need(revision <= MAX_REVISION && typeof raw.stateDigest === "string" && HEX.test(raw.stateDigest), "record_version");
  if (revision === 0n) need(raw.originVersion === null && raw.parentVersion === null, "bootstrap_shape");
  else need(raw.originVersion === initialVersion && typeof raw.parentVersion === "string" && HEX.test(raw.parentVersion), "record_origin");
  const record = encode(revision, raw.state, raw.originVersion as string | null, raw.parentVersion as string | null);
  need(record.bytes === bytes && record.stateDigest === raw.stateDigest, "record_integrity");
  need(revision !== 0n || record.version === initialVersion, "bootstrap_unaccepted");
  return record;
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
function isExisting(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "EEXIST"; }
type Handle = Awaited<ReturnType<typeof fs.open>>;
interface Pin {path: string; stat: BigIntStats}
export interface AccountedIssuerFileStorageOptions {
  /** Trusted owner configuration, never command/request fields. Root authentication remains external. */
  directory: string; ownerUid: number; initialVersion: string;
}

export async function openAccountedIssuerFileStorage(options: AccountedIssuerFileStorageOptions): Promise<{storage: IssuerDurableStorage; close(): Promise<void>}> {
  const {directory, ownerUid, initialVersion} = options;
  need(typeof directory === "string" && directory.length <= 512 && /^[A-Za-z0-9_./-]+$/.test(directory)
    && isAbsolute(directory) && normalize(directory) === directory && directory !== "/" && !directory.endsWith("/"), "directory_path");
  need(Number.isSafeInteger(ownerUid) && ownerUid >= 0 && ownerUid <= 2147483647 && typeof initialVersion === "string" && HEX.test(initialVersion), "owner_configuration");
  // A privileged caller cannot silently select an actor-owned journal. Tests use their own nonroot UID.
  need(typeof process.geteuid === "function" && process.geteuid() === ownerUid, "owner_identity");
  need(typeof NOFOLLOW === "number" && typeof DIRECTORY === "number" && typeof NONBLOCK === "number", "platform_unavailable");
  let root: Handle | undefined;
  const pins: Pin[] = [];
  let closed = false, active = 0;
  function validDirectory(s: BigIntStats, target: boolean): void {
    need(s.isDirectory() && !s.isSymbolicLink(), "directory_type");
    need(s.uid === 0n || s.uid === BigInt(ownerUid), "directory_owner");
    // A root-owned sticky shared parent protects its child entries from other UIDs.
    const stickyRoot = !target && s.uid === 0n && (s.mode & 0o1000n) !== 0n;
    need((s.mode & 0o022n) === 0n || stickyRoot, "directory_writable");
    if (target) need(s.uid === BigInt(ownerUid) && (s.mode & 0o7777n) === 0o700n, "directory_private");
  }
  async function assertRoot(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); need(!closed && root, "storage_closed");
    for (const pin of pins) {
      const s = await fs.lstat(pin.path, {bigint: true}); signal.throwIfAborted();
      validDirectory(s, pin.path === directory);
      need(s.dev === pin.stat.dev && s.ino === pin.stat.ino && s.uid === pin.stat.uid && s.mode === pin.stat.mode, "directory_changed");
    }
    const s = await root.stat({bigint: true}), last = pins[pins.length - 1].stat;
    signal.throwIfAborted(); validDirectory(s, true); need(s.dev === last.dev && s.ino === last.ino, "directory_changed");
  }
  function validFile(s: BigIntStats, max: number): void {
    need(s.isFile() && s.uid === BigInt(ownerUid) && (s.mode & 0o7777n) === 0o600n && s.nlink === 1n
      && s.dev === pins[pins.length - 1].stat.dev && s.size >= 0n && s.size <= BigInt(max), "file_untrusted");
  }
  async function readNamed(name: string, max: number, signal: AbortSignal, durable = false): Promise<{text: string; stat: BigIntStats}> {
    await assertRoot(signal);
    const path = join(directory, name), handle = await fs.open(path, constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    try {
      const before = await handle.stat({bigint: true}); validFile(before, max);
      const buffer = Buffer.alloc(Number(before.size) + 1); let size = 0, reads = 0;
      while (size < buffer.length) {
        signal.throwIfAborted(); need(++reads <= 32, "read_bound");
        const r = await handle.read(buffer, size, buffer.length - size, size); if (!r.bytesRead) break; size += r.bytesRead;
      }
      need(BigInt(size) === before.size, "file_changed");
      const after = await handle.stat({bigint: true}), named = await fs.lstat(path, {bigint: true});
      need(same(before, after) && same(after, named), "file_changed"); await assertRoot(signal);
      if (durable) {
        // An explicit read can reconcile a fully written completion after a lost writer ack.
        await handle.sync(); signal.throwIfAborted();
        need(same(after, await handle.stat({bigint: true})) && same(after, await fs.lstat(path, {bigint: true})), "file_changed");
      }
      return {text: new TextDecoder("utf-8", {fatal: true}).decode(buffer.subarray(0, size)), stat: after};
    } finally {await handle.close();}
  }
  async function exists(name: string, signal: AbortSignal): Promise<boolean> {
    await assertRoot(signal);
    try {await fs.lstat(join(directory, name)); return true;} catch (error) {if (isMissing(error)) return false; throw error;}
  }
  async function syncDirectory(signal: AbortSignal): Promise<void> {
    await assertRoot(signal); await root!.sync(); await assertRoot(signal);
  }
  function transition(originVersion: string, oldVersion: string, newVersion: string, revision: string): string {
    return canonicalNative({schemaVersion: 1, originVersion, oldVersion, newVersion, revision});
  }
  async function current(signal: AbortSignal, ownLock?: {version: string; text: string}): Promise<{record: RecordView; stat: BigIntStats}> {
    const state = await readNamed("journal.json", MAX_RECORD_BYTES, signal), record = decode(state.text, initialVersion);
    const lock = `journal-${record.version}.lock`, completion = `journal-${record.version}.commit`;
    if (ownLock?.version === record.version) {
      need((await readNamed(lock, 2048, signal)).text === ownLock.text && !await exists(completion, signal), "lock_changed");
    } else need(!await exists(lock, signal) && !await exists(completion, signal), "journal_quarantined");
    if (record.parentVersion !== null) {
      const text = transition(initialVersion, record.parentVersion, record.version, record.revision);
      need((await readNamed(`journal-${record.parentVersion}.lock`, 2048, signal, true)).text === text
        && (await readNamed(`journal-${record.parentVersion}.commit`, 2048, signal, true)).text === text, "transition_incomplete");
      // Seal an observed completed entry before treating it as a durable predecessor.
      await syncDirectory(signal);
    }
    need(same(state.stat, await fs.lstat(join(directory, "journal.json"), {bigint: true})), "state_changed");
    return {record, stat: state.stat};
  }
  async function writeExclusive(name: string, text: string, signal: AbortSignal): Promise<BigIntStats> {
    await assertRoot(signal);
    let handle: Handle;
    try {handle = await fs.open(join(directory, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);}
    catch (error) {if (isExisting(error)) throw new ExclusiveCollision(); throw error;}
    try {
      validFile(await handle.stat({bigint: true}), MAX_RECORD_BYTES);
      signal.throwIfAborted(); await handle.writeFile(text, "utf8"); signal.throwIfAborted();
      await handle.sync(); signal.throwIfAborted();
      const s = await handle.stat({bigint: true}); validFile(s, MAX_RECORD_BYTES);
      need(s.size === BigInt(Buffer.byteLength(text)), "write_incomplete");
      need(same(s, await fs.lstat(join(directory, name), {bigint: true})), "file_changed");
      await assertRoot(signal); return s;
    } finally {await handle.close();}
  }
  async function run<T>(phase: string, fn: (stage: (value: string) => void) => Promise<T>): Promise<T> {
    need(!closed, "storage_closed"); active++; let stage = phase;
    try {return await fn(value => {stage = value;});}
    catch (error) {
      if (error instanceof AccountedIssuerStorageError) throw error;
      throw new AccountedIssuerStorageError("storage_outcome_unresolved", stage, error);
    } finally {active--;}
  }
  try {
    let path = "/";
    for (const component of ["", ...directory.slice(1).split("/")]) {
      if (component) path = join(path, component);
      const stat = await fs.lstat(path, {bigint: true}); validDirectory(stat, path === directory); pins.push({path, stat});
    }
    root = await fs.open(directory, constants.O_RDONLY | DIRECTORY | NOFOLLOW);
    await current(new AbortController().signal); // Refuse absent, corrupt or incomplete state; never initialize.
  } catch (error) {if (root) await root.close(); throw new AccountedIssuerStorageError("storage_open_refused", "open", error);}

  const storage: IssuerDurableStorage = {
    read(signal) {return run("read", async () => {const {record} = await current(signal); return {version: record.version, state: record.state};});},
    compareAndSwap(version, state, signal) {
      return run("cas", async stage => {
        need(typeof version === "string" && HEX.test(version), "expected_version");
        const snapshot = jsonState(state).state; signal.throwIfAborted();
        const before = await current(signal); if (before.record.version !== version) return false;
        const next = encode(BigInt(before.record.revision) + 1n, snapshot, initialVersion, version);
        const text = transition(initialVersion, version, next.version, next.revision), lock = `journal-${version}.lock`;
        stage("lock.create");
        try {await writeExclusive(lock, text, signal);} catch (error) {if (error instanceof ExclusiveCollision) return false; throw error;}
        // From this point every failure deliberately retains all receipts/temporary files.
        stage("lock.sync"); await syncDirectory(signal);
        const bound = await current(signal, {version, text});
        need(bound.record.version === version && same(before.stat, bound.stat), "state_changed_under_lock");
        const temp = `.journal-${randomBytes(32).toString("hex")}.tmp`;
        stage("state.write"); const written = await writeExclusive(temp, next.bytes, signal);
        need(same(bound.stat, await fs.lstat(join(directory, "journal.json"), {bigint: true})), "state_changed_under_lock");
        await assertRoot(signal); stage("state.rename");
        await fs.rename(join(directory, temp), join(directory, "journal.json"));
        await assertRoot(signal);
        // rename may update ctime; bind the same inode and complete content after replacement.
        const replaced = await readNamed("journal.json", MAX_RECORD_BYTES, signal);
        need(replaced.stat.dev === written.dev && replaced.stat.ino === written.ino && replaced.text === next.bytes, "replacement_changed");
        stage("state.sync"); await syncDirectory(signal);
        const completion = `journal-${version}.commit`;
        // O_EXCL preserves even a raced unknown receipt; no overwrite-capable completion rename.
        // Readers reject a partial receipt, or verify+sync its exact complete bytes before use.
        stage("completion.write"); await writeExclusive(completion, text, signal);
        stage("completion.sync"); await syncDirectory(signal);
        return true;
      });
    },
    async publishOnce() {throw new AccountedIssuerStorageError("publisher_unavailable", "publish");},
  };
  return {
    storage,
    async close() {
      if (closed) return; need(active === 0, "storage_busy"); closed = true; await root!.close();
    },
  };
}
