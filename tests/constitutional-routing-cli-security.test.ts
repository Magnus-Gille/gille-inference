import { createHash } from "node:crypto";
import { chmodSync, constants, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertRecoverySignerReady,
  boundedProtectedRead,
  createWatchdogRecoverySocketClient,
  loadAuthorityConfig,
  protectedPath,
  resolveAuthorityConfigPath,
  sameOpenedInode,
  type UnixJsonTransport,
  verifiedFreshness,
} from "../scripts/constitutional-routing-cli.js";

const signerRoot = "/__constitutional_signer_test__";
const signerPath = `${signerRoot}/signer`;

// Models OS metadata and raw subprocess output; it does not claim kernel-level enforcement.
type ModeledNode = {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  size: number;
  file: boolean;
  directory: boolean;
  symlink: boolean;
};

type SignerModelOptions = {
  stdout?: string;
  file?: Partial<ModeledNode>;
  parent?: Partial<ModeledNode>;
  opened?: Array<Partial<ModeledNode>>;
};

function createSignerFsModel(options: SignerModelOptions = {}) {
  const file: ModeledNode = {
    dev: 1,
    ino: 101,
    uid: 0,
    mode: 0o100700,
    size: 64,
    file: true,
    directory: false,
    symlink: false,
    ...options.file,
  };
  const parent: ModeledNode = {
    dev: 1,
    ino: 100,
    uid: 0,
    mode: 0o40700,
    size: 0,
    file: false,
    directory: true,
    symlink: false,
    ...options.parent,
  };
  const trace: Array<Record<string, unknown>> = [];
  const violations: string[] = [];
  const opened = new Map<number, ModeledNode>();
  let nextFd = 7100;
  let openCount = 0;
  const isSyntheticPath = (path: string) => path === signerRoot
    || path.startsWith(`${signerRoot}/`);
  const violation = (message: string): never => {
    violations.push(message);
    throw new Error(`modeled signer adapter violation: ${message}`);
  };
  const stat = (node: ModeledNode) => ({
    dev: node.dev,
    ino: node.ino,
    uid: node.uid,
    mode: node.mode,
    size: node.size,
    isFile: () => node.file,
    isDirectory: () => node.directory,
    isSymbolicLink: () => node.symlink,
  });

  return {
    trace,
    violations,
    lstatSync: (realLstatSync: (...args: any[]) => unknown, path: unknown) => {
      const value = String(path);
      if (!isSyntheticPath(value)) return realLstatSync(path);
      trace.push({ kind: "lstat", path: value });
      if (value === signerPath) return stat(file);
      if (value === signerRoot) return stat(parent);
      return violation(`unexpected lstat path ${value}`);
    },
    openSync: (realOpenSync: (...args: any[]) => unknown, path: unknown, flags: unknown, ...rest: unknown[]) => {
      const value = String(path);
      if (!isSyntheticPath(value)) return realOpenSync(path, flags, ...rest);
      if (value !== signerPath) return violation(`unexpected open path ${value}`);
      const fd = nextFd++;
      const openedNode: ModeledNode = { ...file, ...(options.opened?.[openCount] ?? {}) };
      openCount += 1;
      opened.set(fd, openedNode);
      trace.push({ kind: "open", path: value, flags, fd });
      return fd;
    },
    fstatSync: (realFstatSync: (...args: any[]) => unknown, fd: number, ...rest: unknown[]) => {
      const node = opened.get(fd);
      if (!node) {
        if (fd >= 7100 && fd < nextFd) return violation(`unknown synthetic descriptor ${fd}`);
        return realFstatSync(fd, ...rest);
      }
      trace.push({ kind: "fstat", fd });
      return stat(node);
    },
    closeSync: (realCloseSync: (...args: any[]) => unknown, fd: number, ...rest: unknown[]) => {
      if (!opened.has(fd)) {
        if (fd >= 7100 && fd < nextFd) return violation(`unknown synthetic descriptor close ${fd}`);
        return realCloseSync(fd, ...rest);
      }
      opened.delete(fd);
      trace.push({ kind: "close", fd });
      return undefined;
    },
    execFileSync: (_command: string, _args: readonly string[], _options: Record<string, any>) => {
      const [command, args, execOptions] = [_command, _args, _options];
      trace.push({ kind: "execFileSync", command, args: [...args], options: execOptions });
      if (command !== "/dev/fd/3" || args.length !== 0) return violation(`unexpected subprocess ${command}`);
      return options.stdout ?? JSON.stringify({
        kind: "constitutional-recovery-signer-readiness",
        schema_version: 1,
        ready: true,
      });
    },
    remainingDescriptors: () => [...opened.keys()],
  };
}

async function withSignerModel<T>(model: ReturnType<typeof createSignerFsModel>, run: (cli: typeof import("../scripts/constitutional-routing-cli.js")) => T | Promise<T>): Promise<T> {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      lstatSync: (...args: Parameters<typeof actual.lstatSync>) => model.lstatSync(actual.lstatSync as any, ...args) as any,
      openSync: (...args: Parameters<typeof actual.openSync>) => model.openSync(actual.openSync as any, ...args) as any,
      fstatSync: (...args: Parameters<typeof actual.fstatSync>) => model.fstatSync(actual.fstatSync as any, ...args) as any,
      closeSync: (...args: Parameters<typeof actual.closeSync>) => model.closeSync(actual.closeSync as any, ...args) as any,
    };
  });
  vi.doMock("node:child_process", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    return { ...actual, execFileSync: model.execFileSync as any };
  });
  try {
    const cli = await import("../scripts/constitutional-routing-cli.js");
    return await run(cli);
  } finally {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  }
}

function expectModeledReadinessExecution(model: ReturnType<typeof createSignerFsModel>) {
  expect(model.violations).toEqual([]);
  expect(model.remainingDescriptors()).toEqual([]);
  const opens = model.trace.filter((event) => event.kind === "open");
  const fstats = model.trace.filter((event) => event.kind === "fstat");
  const closes = model.trace.filter((event) => event.kind === "close");
  const executions = model.trace.filter((event) => event.kind === "execFileSync");
  expect(opens).toHaveLength(2);
  expect(new Set(opens.map((event) => event.fd)).size).toBe(2);
  expect(fstats.map((event) => event.fd)).toEqual(opens.map((event) => event.fd));
  expect(opens.every((event) => event.path === signerPath && event.flags === (constants.O_RDONLY | constants.O_NOFOLLOW))).toBe(true);
  expect(closes.map((event) => event.fd).sort((a, b) => Number(a) - Number(b))).toEqual(opens.map((event) => event.fd).sort((a, b) => Number(a) - Number(b)));
  expect(model.trace.filter((event) => event.kind === "lstat" && event.path === signerPath)).toHaveLength(4);
  expect(model.trace.filter((event) => event.kind === "lstat" && event.path === signerRoot)).toHaveLength(2);
  expect(executions).toHaveLength(1);
  const execution = executions[0];
  expect(execution.command).toBe("/dev/fd/3");
  expect(execution.args).toEqual([]);
  expect(execution.options).toMatchObject({
    input: '{"kind":"constitutional-recovery-signer-readiness","schema_version":1}\n',
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1_000_000,
  });
  expect((execution.options as { stdio: unknown[] }).stdio).toEqual(["pipe", "pipe", "inherit", opens[1].fd]);
}

function expectModeledGuardFailure(model: ReturnType<typeof createSignerFsModel>) {
  expect(model.violations).toEqual([]);
  expect(model.trace.filter((event) => event.kind === "execFileSync")).toHaveLength(0);
  const opens = model.trace.filter((event) => event.kind === "open");
  const closes = model.trace.filter((event) => event.kind === "close");
  expect(closes.map((event) => event.fd).sort((a, b) => Number(a) - Number(b))).toEqual(opens.map((event) => event.fd).sort((a, b) => Number(a) - Number(b)));
  expect(model.remainingDescriptors()).toEqual([]);
}

describe("constitutional CLI protected roots", () => {
  it("refuses authority-config and owner-pin root substitution", () => {
    const fixed = resolveAuthorityConfigPath([], undefined, "/home/service");
    expect(fixed).toBe("/etc/gille-inference/autonomy/authority-config.json");
    expect(() => resolveAuthorityConfigPath(["--authority-config", "/tmp/attacker.json"], undefined, "/home/service")).toThrow(/fixed/);
    expect(() => resolveAuthorityConfigPath([], "/tmp/replacement.json", "/home/service")).toThrow(/substitution/);
  });

  it("refuses a symlink even when its target is a regular non-writable file", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-symlink-"));
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "safe");
    chmodSync(target, 0o400);
    symlinkSync(target, link);
    expect(() => protectedPath(link)).toThrow(/symlink/);
    expect(() => boundedProtectedRead(link)).toThrow(/symlink/);
  });

  it("refuses a protected file below a world-writable parent", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-parent-"));
    const file = join(root, "pin.pem");
    writeFileSync(file, "not-a-real-pin");
    chmodSync(file, 0o400);
    chmodSync(root, 0o777);
    expect(() => protectedPath(file)).toThrow(/parent is writable/);
  });

  it("requires the production config root to be owned by root, not merely the service UID", () => {
    const root = mkdtempSync(join(tmpdir(), "constitutional-same-uid-config-"));
    const file = join(root, "authority-config.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o600);
    expect(() => loadAuthorityConfig(file)).toThrow(/unexpected owner/);
  });

  it("rejects a rename/swap when the opened inode is not the validated inode", () => {
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 1, ino: 10 })).toBe(true);
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 1, ino: 11 })).toBe(false);
    expect(sameOpenedInode({ dev: 1, ino: 10 }, { dev: 2, ino: 10 })).toBe(false);
  });

  it("models recovery signer readiness with the unchanged production guard", async () => {
    expect(() => assertRecoverySignerReady("/etc/hosts", 0)).toThrow();

    const successModel = createSignerFsModel();
    await withSignerModel(successModel, (cli) => {
      expect(() => cli.assertRecoverySignerReady(signerPath, 0)).not.toThrow();
    });
    expectModeledReadinessExecution(successModel);

    const validResponse = {
      kind: "constitutional-recovery-signer-readiness",
      schema_version: 1,
      ready: true,
    };
    const closedResponseCases: Array<[string, unknown, string | RegExp]> = [
      ["ready false", { ...validResponse, ready: false }, "recovery signer readiness returned an invalid closed response"],
      ["empty stdout", "", /recovery signer readiness failed:/],
      ["malformed JSON", "{", /recovery signer readiness failed:/],
      ["wrong kind", { ...validResponse, kind: "other" }, "recovery signer readiness returned an invalid closed response"],
      ["wrong schema version", { ...validResponse, schema_version: 2 }, "recovery signer readiness returned an invalid closed response"],
      ["wrong ready type", { ...validResponse, ready: "true" }, "recovery signer readiness returned an invalid closed response"],
      ["missing key", { kind: validResponse.kind, schema_version: 1 }, "recovery signer readiness returned an invalid closed response"],
      ["extra key", { ...validResponse, extra: true }, "recovery signer readiness returned an invalid closed response"],
      ["non-object response", null, "recovery signer readiness returned an invalid closed response"],
    ];
    for (const [label, response, expectedError] of closedResponseCases) {
      const model = createSignerFsModel({ stdout: typeof response === "string" ? response : JSON.stringify(response) });
      let actualError: unknown;
      await withSignerModel(model, (cli) => {
        try {
          cli.assertRecoverySignerReady(signerPath, 0);
        } catch (error) {
          actualError = error;
        }
      });
      expect(actualError, label).toBeInstanceOf(Error);
      if (typeof expectedError === "string") {
        expect((actualError as Error).message, label).toBe(expectedError);
      } else {
        expect((actualError as Error).message, label).toMatch(expectedError);
      }
      expectModeledReadinessExecution(model);
    }

    const guardCases: Array<[string, SignerModelOptions, RegExp]> = [
      ["file symlink", { file: { symlink: true } }, /protected path must not be a symlink/],
      ["unsafe file mode", { file: { mode: 0o100720 } }, /protected path is group\/world writable/],
      ["unsafe parent mode", { parent: { mode: 0o40720 } }, /protected parent is writable or unexpectedly owned/],
      ["wrong file owner", { file: { uid: 1234 } }, /protected path has an unexpected owner/],
      ["wrong parent owner", { parent: { uid: 1234 } }, /protected parent is writable or unexpectedly owned/],
      ["parent symlink", { parent: { symlink: true } }, /protected parent is not a real directory/],
      ["non-executable file", { file: { mode: 0o100600 } }, /recovery signer is not a bounded regular executable/],
      ["non-regular file", { file: { mode: 0o040700, file: false, directory: true } }, /recovery signer is not a bounded regular executable/],
      ["oversized file", { file: { size: 1_000_001 } }, /recovery signer is not a bounded regular executable/],
      ["first-open inode mismatch", { opened: [{ ino: 999 }] }, /recovery signer is not a bounded regular executable/],
      ["second-open inode mismatch", { opened: [{}, { ino: 999 }] }, /protected helper changed during open or is not executable/],
    ];
    for (const [label, options, expectedError] of guardCases) {
      const model = createSignerFsModel(options);
      await withSignerModel(model, (cli) => {
        expect(() => cli.assertRecoverySignerReady(signerPath, 0), label).toThrow(expectedError);
      });
      expectModeledGuardFailure(model);
    }
  });

  it("expires replayed clock/liveness evidence against independent wall and monotonic time", () => {
    const unsigned = {
      healthy: true,
      observed_at: "2026-07-27T10:00:00Z",
      boot_id: "boot-a",
      monotonic_ns: "100000000000",
    };
    const record = {
      ...unsigned,
      digest: `sha256:${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`,
    };
    expect(() => verifiedFreshness(
      record,
      ["healthy"],
      unsigned,
      Date.parse("2026-07-27T10:14:59Z"),
      "boot-a",
      999_000_000_000n,
    )).not.toThrow();
    expect(() => verifiedFreshness(
      record,
      ["healthy"],
      unsigned,
      Date.parse("2026-07-27T10:15:01Z"),
      "boot-a",
      1_001_000_000_000n,
    )).toThrow(/replayed|stale/);
    expect(() => verifiedFreshness(
      record,
      ["healthy"],
      unsigned,
      Date.parse("2026-07-27T10:01:00Z"),
      "boot-b",
      160_000_000_000n,
    )).toThrow(/cross-boot/);
  });

  it("rejects a malformed route digest returned by the recovery service", () => {
    const transport: UnixJsonTransport = (_socket, endpoint) => {
      if (endpoint !== "/route/digest") throw new Error(`unexpected endpoint ${endpoint}`);
      return { digest: "sha256:not-a-real-digest" };
    };
    const client = createWatchdogRecoverySocketClient("/tmp/not-used.sock", transport);
    expect(() => client.readRouteDigest({
      epoch: 1,
      token: "11111111-1111-4111-8111-111111111111",
    })).toThrow(/invalid route digest/);
  });
});
