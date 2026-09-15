import { beforeAll, describe, expect, it, vi } from "vitest";
import { HALOGEN_PILOT_PROFILE, halogenProfileHash } from "../src/homeserver/halogen-profile.js";
import { HALOGEN_MEMORY_BYTES } from "../src/homeserver/halogen-runtime-plan.js";

type FuserResponse = { stdout?: string; error?: { code: number; stdout?: string; stderr?: string } };
type State = { fuser: FuserResponse[]; memory: number[]; gpuGroups: Record<string, string>; hashIndex: number };

const runnerCommit = "b".repeat(40);
const runId = "0123456789abcdef0123456789abcdef";
const priorPid = 4242;
const priorModel = "/home/operator/model.gguf";
const priorStartTicks = "123";
const qualificationHash = "e".repeat(64);
const profileHash = halogenProfileHash(HALOGEN_PILOT_PROFILE);
const state: State = { fuser: [], memory: [], gpuGroups: {}, hashIndex: 0 };

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
    callback(null, { stdout: "", stderr: "" });
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
