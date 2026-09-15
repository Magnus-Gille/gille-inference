import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HALOGEN_PILOT_PROFILE, halogenProfileHash } from "../src/homeserver/halogen-profile.js";
import { buildHalogenLaunch } from "../src/homeserver/halogen-runtime-plan.js";

const runId = "0123456789abcdef0123456789abcdef";
const runnerCommit = "b".repeat(40);
const profileHash = halogenProfileHash(HALOGEN_PILOT_PROFILE);
const containerId = "a".repeat(64);
const containerName = "gille-317-halogen-01";
const artifactDirectory = `/home/operator/halogen-eval-317/staging/${HALOGEN_PILOT_PROFILE.modelRevision}`;

type CommandRecord = { executable: string; args: string[] };
type State = {
  unitLoad: "not-found" | "loaded";
  unitActive: "active" | "inactive";
  containerRunning: boolean;
  containerLabel: string;
  stopRpcFails: boolean;
  containerStopFails: boolean;
  containerKillFails: boolean;
  commands: CommandRecord[];
};

const state: State = {
  unitLoad: "not-found",
  unitActive: "active",
  containerRunning: true,
  containerLabel: runId,
  stopRpcFails: false,
  containerStopFails: false,
  containerKillFails: false,
  commands: [],
};

function hostPlan(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runnerCommit,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    profileSha256: profileHash,
    name: containerName,
    runId,
    user: "operator",
    group: "operator",
    uid: 1000,
    protectedUnits: ["home-gateway.service", "llama-swap.service"],
    qualificationSha256: "c".repeat(64),
    expectedResidentModels: [],
    prior: {
      pid: 4242,
      startTicks: "123",
      argv: ["/usr/bin/llama-server", "--host", "127.0.0.1", "--port", "18099", "-m", "/home/operator/model.gguf"],
      cwd: "/home/operator",
      executableSha256: "d".repeat(64),
      modelPath: "/home/operator/model.gguf",
      modelBytes: 123,
      modelMtimeMs: 1,
      restoreName: "gille-317-prior-01",
    },
  };
}

function unitProperties(): string {
  const missing = state.unitLoad === "not-found";
  return [
    `Description=gille-317-halogen/${runId}`,
    `LoadState=${state.unitLoad}`,
    `ActiveState=${missing ? "inactive" : state.unitActive}`,
    `MainPID=${missing || state.unitActive !== "active" ? "0" : "1234"}`,
  ].join("\n");
}

let createHalogenHostOperations: (input: unknown) => any;

beforeAll(async () => {
  vi.doMock("node:child_process", () => ({
    execFile: (...raw: unknown[]) => {
      const executable = raw[0] as string;
      const args = raw[1] as string[];
      const callback = raw.at(-1) as (error: Error | null, result?: { stdout: string; stderr: string }) => void;
      state.commands.push({ executable, args: [...args] });

      if (executable === "/usr/bin/systemctl" && args[0] === "show") {
        callback(null, { stdout: unitProperties(), stderr: "" });
        return;
      }
      if (executable === "/usr/bin/sudo" && args.includes("/usr/bin/systemctl") && args.includes("stop")) {
        if (state.stopRpcFails) callback(Object.assign(new Error("mocked systemctl stop failure"), { code: 1 }));
        else {
          state.unitActive = "inactive";
          callback(null, { stdout: "", stderr: "" });
        }
        return;
      }
      if (executable === "/usr/bin/podman" && args[0] === "ps") {
        callback(null, { stdout: `${containerName}\n`, stderr: "" });
        return;
      }
      if (executable === "/usr/bin/podman" && args[0] === "inspect") {
        callback(null, {
          stdout: JSON.stringify([{
            Id: containerId,
            Config: { Labels: { "gille-inference.run-id": state.containerLabel } },
            State: { Running: state.containerRunning },
          }]),
          stderr: "",
        });
        return;
      }
      if (executable === "/usr/bin/podman" && ["stop", "kill"].includes(args[0]!)) {
        if ((args[0] === "stop" && state.containerStopFails) || (args[0] === "kill" && state.containerKillFails)) {
          callback(new Error("mocked container stop failure")); return;
        }
        state.containerRunning = false;
        state.unitActive = "inactive";
        callback(null, { stdout: `${containerId}\n`, stderr: "" });
        return;
      }
      callback(null, { stdout: "", stderr: "" });
    },
  }));
  ({ createHalogenHostOperations } = await import("../src/homeserver/halogen-host-operations.js"));
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-15T10:00:00Z"));
  state.unitLoad = "not-found";
  state.unitActive = "active";
  state.containerRunning = true;
  state.containerLabel = runId;
  state.stopRpcFails = false;
  state.containerStopFails = false;
  state.containerKillFails = false;
  state.commands = [];
});

afterEach(() => vi.useRealTimers());

async function cleanup(operations: any): Promise<unknown> {
  const outcome = operations.ensureCandidateStopped().then(() => undefined, (error: unknown) => error);
  await vi.runAllTimersAsync();
  return await outcome;
}

describe("Halogen cleanup identity and timeout", () => {
  it("includes the hard 30-minute podman stop timeout in the launch argv", () => {
    const launch = buildHalogenLaunch(HALOGEN_PILOT_PROFILE, {
      name: containerName,
      runId,
      user: "operator",
      group: "operator",
      uid: 1000,
      homeDirectory: "/home/operator",
      artifactDirectory,
    });
    expect(launch.args).toContain("--timeout=1800");
  });

  it("directly stops an owned running container by immutable ID when its unit is absent", async () => {
    const operations = createHalogenHostOperations(hostPlan());
    expect(await cleanup(operations)).toBeUndefined();

    const stop = state.commands.find((command) => command.executable === "/usr/bin/podman" && command.args[0] === "stop");
    expect(stop).toBeDefined();
    expect(stop!.args).toContain(containerId);
    expect(stop!.args).toContain("--time");
    expect(stop!.args).toContain("20");
    expect(stop!.args).not.toContain(containerName);
    expect(state.containerRunning).toBe(false);
    expect(state.commands.filter((command) => command.executable === "/usr/bin/podman" && command.args[0] === "inspect")).toHaveLength(2);
  });

  it("stops the owned container directly when the systemd stop RPC fails", async () => {
    state.unitLoad = "loaded";
    state.stopRpcFails = true;
    const operations = createHalogenHostOperations(hostPlan());
    expect(await cleanup(operations)).toBeUndefined();

    expect(state.commands.some((command) => command.executable === "/usr/bin/sudo" && command.args.includes("stop"))).toBe(true);
    const directStop = state.commands.find((command) => command.executable === "/usr/bin/podman" && command.args[0] === "stop");
    expect(directStop?.args).toContain(containerId);
    expect(directStop?.args).not.toContain(containerName);
  });

  it("rejects a foreign container before issuing any stop command", async () => {
    state.unitLoad = "loaded";
    state.containerLabel = "ffffffffffffffffffffffffffffffff";
    const operations = createHalogenHostOperations(hostPlan());
    expect(await cleanup(operations)).toMatchObject({ message: expect.stringMatching(/unowned container/) });

    expect(state.commands.some((command) => command.args.includes("stop"))).toBe(false);
    expect(state.commands.some((command) => command.executable === "/usr/bin/podman" && command.args[0] === "stop")).toBe(false);
  });
  it("kills only the same owned container ID when its stop RPC fails", async () => {
    state.containerStopFails = true;
    expect(await cleanup(createHalogenHostOperations(hostPlan()))).toBeUndefined();
    const kill = state.commands.find(c => c.executable === "/usr/bin/podman" && c.args[0] === "kill");
    expect(kill?.args).toEqual(["kill", "--signal", "KILL", containerId]);
    expect(state.containerRunning).toBe(false);
  });

  it("does not claim shutdown when both container stop and kill fail", async () => {
    state.containerStopFails = true;
    state.containerKillFails = true;
    const error = await cleanup(createHalogenHostOperations(hostPlan())) as Error;
    expect(error).toMatchObject({ message: "cannot verify candidate shutdown" });
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(state.containerRunning).toBe(true);
  });

});
