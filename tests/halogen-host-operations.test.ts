import { beforeAll, describe, expect, it, vi } from "vitest";
import { HALOGEN_PILOT_PROFILE, halogenProfileHash } from "../src/homeserver/halogen-profile.js";
import { HALOGEN_MEMORY_BYTES } from "../src/homeserver/halogen-runtime-plan.js";

type FuserResponse = { stdout?: string; error?: { code: number; stdout?: string; stderr?: string } };
type State = { fuser: FuserResponse[]; memory: number[]; gpuGroups: Record<string, string>; hashIndex: number; psName: string; inspect: any; configJson: string | Error };

const runnerCommit = "b".repeat(40);
const runId = "0123456789abcdef0123456789abcdef";
const priorPid = 4242;
const priorModel = "/home/operator/model.gguf";
const priorStartTicks = "123";
const qualificationHash = "e".repeat(64);
const profileHash = halogenProfileHash(HALOGEN_PILOT_PROFILE);
const candidatePid = 9999;
const candidateStaticDir = "/run/containers/valid";
const artifactDirectory = `/home/operator/halogen-eval-317/staging/${HALOGEN_PILOT_PROFILE.modelRevision}`;
const state: State = { fuser: [], memory: [], gpuGroups: {}, hashIndex: 0, psName: "", inspect: null, configJson: "" };

const properties = (unit: string): string => {
  const missing = unit === "gille-317-halogen-01.service" || unit === "gille-317-prior-01.service";
  return [
    `Description=gille-317-halogen/${runId}`,
    `LoadState=${missing ? "not-found" : "loaded"}`,
    `ActiveState=${missing ? "inactive" : "active"}`,
    `SubState=${missing ? "dead" : "running"}`,
    "MainPID=1",
    "NRestarts=0",
    "ActiveEnterTimestampMonotonic=100",
    "ControlGroup=/system.slice/" + unit,
    "MemoryMax=103079215104",
    "MemorySwapMax=0",
    "OOMPolicy=kill",
    "KillMode=control-group",
    "TasksMax=512",
    "RuntimeMaxUSec=1800000000",
    "User=operator",
    "Group=operator",
    "LimitMEMLOCK=103079215104",
    "Result=success",
  ].join("\n");
};

const passwd = "operator:x:1000:1000::/home/operator:/bin/bash\n";
const group = "operator:x:1000:\n";
const priorStat = `4242 (llama-server) S ${Array.from({ length: 20 }, (_, index) => index === 18 ? priorStartTicks : "0").join(" ")}`;

function commandCallback(executable: string, args: string[], callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void): void {
  if (executable === "/usr/bin/systemctl") {
    callback(null, { stdout: properties(args[1]!), stderr: "" });
    return;
  }
  if (executable === "/usr/bin/sudo" && args.includes("/usr/bin/fuser")) {
    const response = state.fuser.shift() ?? { stdout: "" };
    if (response.error) {
      const error = Object.assign(new Error("mocked fuser failure"), response.error);
      callback(error, { stdout: response.error.stdout ?? "", stderr: response.error.stderr ?? "" });
    } else callback(null, { stdout: response.stdout ?? "", stderr: "" });
    return;
  }
  if (executable === "/usr/bin/podman" && args[0] === "ps") {
    callback(null, { stdout: state.psName, stderr: "" });
    return;
  }
  if (executable === "/usr/bin/podman" && args[0] === "inspect") {
    callback(null, { stdout: JSON.stringify(state.inspect === null ? [] : [state.inspect]), stderr: "" });
    return;
  }
  if (executable === "/usr/bin/podman" && args[0] === "image") {
    callback(null, { stdout: HALOGEN_PILOT_PROFILE.image.split("@")[1]!, stderr: "" });
    return;
  }
  callback(null, { stdout: "", stderr: "" });
}

let createHalogenHostOperations: (input: unknown) => any;
let readFileMock: ReturnType<typeof vi.fn>;
let statMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const cryptoActual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  vi.doMock("node:child_process", () => ({
    execFile: (...args: unknown[]) => commandCallback(
      args[0] as string,
      args[1] as string[],
      args.at(-1) as (error: Error | null, result?: { stdout: string; stderr: string }) => void,
    ),
  }));
  readFileMock = vi.fn(async (path: string) => {
    if (path === "/etc/passwd") return passwd;
    if (path === "/etc/group") return group;
    if (path === "/proc/vmstat") return "oom_kill 7\n";
    if (path === "/proc/meminfo") return `MemAvailable: ${Math.ceil((state.memory.shift() ?? 200 * 1024 ** 3) / 1024)} kB\n`;
    if (path === `${priorModel}`) return "model";
    if (path === `/proc/${priorPid}/cmdline`) return ["/usr/bin/llama-server", "--host", "127.0.0.1", "--port", "18099", "-m", priorModel].join("\u0000") + "\u0000";
    if (path === `/proc/${priorPid}/stat`) return priorStat;
    if (path === `/proc/${candidatePid}/status`) {
      return "Name: conmon\nNoNewPrivs:\t1\nCapEff:\t0000000000000000\n";
    }
    const cgroupLimit = path.match(/^\/sys\/fs\/cgroup\/system\.slice\/gille-317-halogen-01\.service\/(.+)$/)?.[1];
    if (cgroupLimit) {
      return { "memory.max": "103079215104", "memory.swap.max": "0", "pids.max": "512", "memory.oom.group": "1" }[cgroupLimit] ?? "";
    }
    if (path === `${candidateStaticDir}/config.json`) {
      if (state.configJson instanceof Error) throw state.configJson;
      return state.configJson;
    }
    const gpuPid = path.match(/^\/proc\/(\d+)\/cgroup$/)?.[1];
    if (gpuPid) return state.gpuGroups[gpuPid] ?? "0::/system.slice/unexpected.service\n";
    if (path.endsWith("/qualify-halogen.py")) return "qualification source";
    return "";
  });
  statMock = vi.fn(async (path: string) => path === priorModel
    ? { size: 123, mtimeMs: 1 }
    : { uid: 1000 });
  vi.doMock("node:fs/promises", () => ({
    readFile: readFileMock,
    readlink: vi.fn(async (path: string) => path.endsWith("/cwd") ? "/home/operator" : "/usr/bin/llama-server"),
    stat: statMock,
    lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
  }));
  vi.doMock("node:fs", () => ({
    createReadStream: vi.fn(() => ({
      async *[Symbol.asyncIterator]() { yield Buffer.from("fixture"); },
    })),
  }));
  vi.doMock("node:crypto", () => ({
    ...cryptoActual,
    createHash: vi.fn(() => {
      const digest = [
        "fff0a42b578148c4b0e515ab74d81c0bcd921d60476be1fe0497cc8e075e1b42",
        "216a59c2262d5080fb7217f74ef064b08e10976a72597c1a216c7fa43d9b2284",
        "d".repeat(64),
        qualificationHash,
      ][state.hashIndex++] ?? "f".repeat(64);
      return { update: vi.fn(() => ({ digest: () => digest })), digest: () => digest };
    }),
  }));
  vi.doMock("node:os", () => ({ networkInterfaces: () => ({ lo: [{ address: "127.0.0.1" }] }) }));
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  vi.spyOn(process, "getuid").mockReturnValue(1000);
  vi.spyOn(process, "getgid").mockReturnValue(1000);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));
  ({ createHalogenHostOperations } = await import("../src/homeserver/halogen-host-operations.js"));
});

function plan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runnerCommit,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    profileSha256: profileHash,
    name: "gille-317-halogen-01",
    runId,
    gatewayBaseUrl: "http://127.0.0.1:8080",
    user: "operator",
    group: "operator",
    uid: 1000,
    protectedUnits: ["home-gateway.service", "llama-swap.service", "whisper.service"],
    qualificationSha256: qualificationHash,
    expectedResidentModels: [],
    prior: {
      pid: priorPid,
      startTicks: priorStartTicks,
      argv: ["/usr/bin/llama-server", "--host", "127.0.0.1", "--port", "18099", "-m", priorModel],
      cwd: "/home/operator",
      executableSha256: "d".repeat(64),
      modelPath: priorModel,
      modelBytes: 123,
      modelMtimeMs: 1,
      restoreName: "gille-317-prior-01",
    },
  };
}

async function prepared(fuser: FuserResponse[], memory = [200 * 1024 ** 3]): Promise<any> {
  state.fuser = [{ stdout: `${priorPid}\n` }, ...fuser];
  state.memory = [...memory];
  state.gpuGroups = {};
  state.hashIndex = 0;
  const operations = createHalogenHostOperations(plan());
  await operations.preflight();
  return operations;
}

describe("createHalogenHostOperations.assertHeadroom", () => {
  it("rejects an unexpected GPU client PID", async () => {
    state.gpuGroups["31337"] = "0::/system.slice/other.service\n";
    const operations = await prepared([{ stdout: "31337\n" }]);
    await expect(operations.assertHeadroom()).rejects.toThrow("unexpected GPU client: 31337");
  });

  it("allows a protected Whisper cgroup GPU client", async () => {
    const operations = await prepared([{ stdout: "31337\n" }]);
    state.gpuGroups["31337"] = "0::/system.slice/whisper.service\n";
    await expect(operations.assertHeadroom()).resolves.toBeUndefined();
  });

  it("allows fuser exit 1 with empty stdout and stderr as no GPU users", async () => {
    const operations = await prepared([{ error: { code: 1, stdout: "", stderr: "" } }]);
    await expect(operations.assertHeadroom()).resolves.toBeUndefined();
  });

  it.each([
    ["permission", { code: 1, stdout: "", stderr: "permission denied" }],
    ["diagnostic", { code: 2, stdout: "", stderr: "fuser: failed to inspect" }],
  ])("fails closed on fuser %s errors", async (_label, error) => {
    const operations = await prepared([{ error }]);
    await expect(operations.assertHeadroom()).rejects.toThrow();
  });

  it("rejects malformed GPU inventory stdout", async () => {
    const operations = await prepared([{ stdout: "31337x\n" }]);
    await expect(operations.assertHeadroom()).rejects.toThrow("unrecognized GPU client inventory");
  });

  it("rejects insufficient available memory after preserving the 12 GiB reserve", async () => {
    const threshold = HALOGEN_MEMORY_BYTES + 12 * 1024 ** 3;
    const operations = await prepared([{ error: { code: 1, stdout: "", stderr: "" } }], [200 * 1024 ** 3, Math.floor((threshold - 1) / 1024) * 1024]);
    await expect(operations.assertHeadroom()).rejects.toThrow("insufficient RAM including 12GiB reserve");
  });
});

describe("createHalogenHostOperations gateway address (#323)", () => {
  it.each([
    ["missing", undefined],
    ["path", "http://127.0.0.1:8080/admin"],
    ["remote host", "http://203.0.113.7:8080"],
  ])("rejects a plan with %s gateway address", async (_name, gatewayBaseUrl) => {
    const invalid = plan() as Record<string, unknown>;
    if (gatewayBaseUrl === undefined) delete invalid.gatewayBaseUrl;
    else invalid.gatewayBaseUrl = gatewayBaseUrl;
    expect(() => createHalogenHostOperations(invalid)).toThrow();
  });
});

function deviceBinds(extra: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  return [
    { type: "bind", source: "/dev/kfd", destination: "/dev/kfd", options: ["rbind", "rw"] },
    { type: "bind", source: "/dev/dri/renderD128", destination: "/dev/dri/renderD128", options: ["rbind", "rw"] },
    ...extra,
  ];
}

function validContainer(): Record<string, unknown> {
  return {
    Id: "a".repeat(64),
    StaticDir: candidateStaticDir,
    State: { Pid: candidatePid, Running: true },
    Config: { Labels: { "gille-inference.run-id": runId } },
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Devices: [], GroupAdd: [] },
    Mounts: [{ Destination: "/models", Source: artifactDirectory, RW: false }],
  };
}

function validConfig(extraMounts: Array<Record<string, unknown>> = [], annotations: Record<string, string> | null = { "run.oci.keep_original_groups": "1" }): string {
  return JSON.stringify({ mounts: deviceBinds(extraMounts), annotations });
}

async function contained(configJson: string | Error, inspectOverride?: Record<string, unknown>): Promise<{ error?: unknown }> {
  state.psName = "";
  state.inspect = null;
  const operations = await prepared([{ error: { code: 1, stdout: "", stderr: "" } }]);
  state.psName = "gille-317-halogen-01";
  state.inspect = { ...validContainer(), ...(inspectOverride ?? {}) };
  state.configJson = configJson;
  state.gpuGroups[String(candidatePid)] = "0::/system.slice/gille-317-halogen-01.service\n";
  try {
    await operations.verifyContainment();
    return {};
  } catch (error) {
    return { error };
  }
}

describe("verifyContainment device binds (#327)", () => {
  it("passes a rootless container whose devices arrive as OCI binds despite empty Devices/GroupAdd", async () => {
    const outcome = await contained(validConfig());
    expect(outcome.error).toBeUndefined();
  });

  it.each([
    ["missing kfd bind", JSON.stringify({ mounts: deviceBinds().slice(1), annotations: { "run.oci.keep_original_groups": "1" } })],
    ["remapped destination", JSON.stringify({ mounts: [{ type: "bind", source: "/dev/kfd", destination: "/dev/gpu0", options: ["rbind", "rw"] }, deviceBinds()[1]], annotations: { "run.oci.keep_original_groups": "1" } })],
    ["read-only device bind", JSON.stringify({ mounts: [{ type: "bind", source: "/dev/kfd", destination: "/dev/kfd", options: ["rbind", "ro"] }, deviceBinds()[1]], annotations: { "run.oci.keep_original_groups": "1" } })],
    ["foreign device bind", validConfig([{ type: "bind", source: "/dev/sda", destination: "/dev/sda", options: ["rbind", "rw"] }])],
    ["whole /dev bind", JSON.stringify({ mounts: [{ type: "bind", source: "/dev", destination: "/dev", options: ["rbind", "rw"] }], annotations: { "run.oci.keep_original_groups": "1" } })],
    ["doubled-slash source", JSON.stringify({ mounts: [{ type: "bind", source: "//dev/kfd", destination: "//dev/kfd", options: ["rbind", "rw"] }], annotations: { "run.oci.keep_original_groups": "1" } })],
    ["untyped extra bind", validConfig([{ source: "/dev/sda", destination: "/dev/sda", options: ["rbind", "rw"] }])],
    ["non-device source to device destination", JSON.stringify({ mounts: [{ type: "bind", source: "/tmp/evil", destination: "/dev/kfd", options: ["rbind", "rw"] }, deviceBinds()[1]], annotations: { "run.oci.keep_original_groups": "1" } })],
    ["none-typed bind options", JSON.stringify({ mounts: [{ type: "none", source: "/dev/sda", destination: "/dev/sda", options: ["rbind", "rw"] }, ...deviceBinds()], annotations: { "run.oci.keep_original_groups": "1" } })],
  ])("rejects %s without further checks", async (_name, configJson) => {
    const callsBefore = readFileMock.mock.calls.length;
    const outcome = await contained(configJson);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/GPU device mapping mismatch/);
    const later = readFileMock.mock.calls.slice(callsBefore);
    expect(later.some(([path]) => typeof path === "string" && path.includes("/proc/9999/"))).toBe(false);
  });

  it("rejects a missing keep-groups annotation", async () => {
    const outcome = await contained(validConfig([], {}));
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/group identity/);
  });

  it("rejects a falsy keep-groups annotation", async () => {
    const outcome = await contained(validConfig([], { "run.oci.keep_original_groups": "0" }));
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/group identity/);
  });

  it("ignores typed pseudo-filesystem mounts under /dev", async () => {
    const outcome = await contained(validConfig([
      { type: "tmpfs", source: "shm", destination: "/dev/shm", options: ["nosuid", "noexec", "nodev"] },
    ]));
    expect(outcome.error).toBeUndefined();
  });

  it("rejects malformed OCI config naming the cause", async () => {
    const outcome = await contained("not-json{");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/unreadable \(parse\)/);
  });

  it("rejects a container without storage identity", async () => {
    const inspect = { ...validContainer(), StaticDir: undefined };
    const outcome = await contained(validConfig(), inspect);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/storage identity/);
  });

  it("rejects an unreadable OCI config", async () => {
    const outcome = await contained(new Error("EACCES"));
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String((outcome.error as Error).message)).toMatch(/OCI config unreadable/);
  });
});
