import { describe, expect, it } from "vitest";
import {
  buildHalogenLaunch,
  HALOGEN_MEMORY_BYTES,
  HALOGEN_RUNTIME_SECONDS,
  verifyHalogenHealth,
} from "../src/homeserver/halogen-runtime-plan.js";
import { HALOGEN_PILOT_PROFILE, halogenEnvironment } from "../src/homeserver/halogen-profile.js";

const profile = HALOGEN_PILOT_PROFILE;
const artifactDirectory = `/home/operator/staging/${profile.modelRevision}`;
const validOptions = { name: "gille-317-halogen-01", runId: "0123456789abcdef0123456789abcdef", user: "operator", group: "operator", uid: 1000, homeDirectory: "/home/operator", artifactDirectory };

type JsonObject = Record<string, unknown>;

function validHealth(overrides: JsonObject = {}): JsonObject {
  return {
    version: { api: "0.9.1", engine: "0.9.1", match: true },
    engine: { responds: true },
    checkpoint_format: "hgn",
    slots: profile.slots,
    slot_ctx: profile.context,
    kv_pool_positions: profile.context,
    ...overrides,
  };
}

describe("Halogen runtime launch plan", () => {
  it("builds a bounded systemd and podman argv without executing it", () => {
    const plan = buildHalogenLaunch(profile, validOptions);
    const { args } = plan;

    expect(plan.command).toBe("/usr/bin/sudo");
    expect(args.slice(0, 2)).toEqual(["-n", "/usr/bin/systemd-run"]);
    expect(args).toContain("--property=User=operator");
    expect(args).toContain("--property=Group=operator");
    expect(args).toContain("--property=Description=gille-317-halogen/0123456789abcdef0123456789abcdef");
    expect(args).toContain("--setenv=HOME=/home/operator");
    expect(args).toContain("--setenv=XDG_RUNTIME_DIR=/run/user/1000");
    expect(args).toContain("--property=SupplementaryGroups=render video");
    expect(args).toContain("--property=LimitMEMLOCK=" + HALOGEN_MEMORY_BYTES);
    expect(args).toContain("--ulimit=memlock=" + HALOGEN_MEMORY_BYTES + ":" + HALOGEN_MEMORY_BYTES);
    expect(args).toContain("--setenv=PATH=/usr/bin:/bin");
    expect(args).not.toContain("--user");
    expect(args).not.toContain("--global");
    expect(plan.unit).toBe("gille-317-halogen-01.service");
    expect(plan.container).toBe("gille-317-halogen-01");
    expect(args).toContain("--pull=never");
    expect(args).toContain("--label=gille-inference.run-id=0123456789abcdef0123456789abcdef");
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--read-only-tmpfs=false");
    expect(args).toContain("--image-volume=ignore");
    expect(args).toContain("--ipc=private");
    expect(args).toContain("--shm-size=512m");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add=ALL");

    expect(args).toContain(`--property=MemoryMax=${HALOGEN_MEMORY_BYTES}`);
    expect(args).toContain("--property=MemorySwapMax=0");
    expect(args).toContain(`--property=RuntimeMaxSec=${HALOGEN_RUNTIME_SECONDS}`);
    expect(args).toContain("--property=OOMPolicy=kill");
    expect(args).toContain("--property=KillMode=control-group");
    expect(args).toContain("--property=TasksMax=512");

    const volumeFlags = args.flatMap((arg, index) => arg === "--volume" ? [args[index + 1]!] : []);
    expect(volumeFlags).toEqual([`${artifactDirectory}:/models:ro`]);
    expect(volumeFlags.filter((volume) => volume.endsWith(":/models:ro"))).toHaveLength(1);
    expect(args).toContain("/usr/bin/podman");
    expect(args).toContain(profile.image);
    expect(args.at(-1)).toBe("all");
  });

  it.each([
    "short-run-id",
    "0123456789abcdef0123456789ABCDE",
    "0123456789abcdef0123456789abcde-",
  ])("rejects unsafe run identity %j", (runId) => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, runId })).toThrow();
  });

  it.each([
    "gille-317-halogen-1",
    "gille-317-halogen-001",
    "gille-317-halogen-01/../../x",
    "gille-317-halogen-01\n",
  ])("rejects unsafe unit name %j", (name) => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, name })).toThrow();
  });

  it.each([
    "relative/artifacts",
    "/srv/halogen/../secrets",
    "/srv/halogen/artifacts,other",
    "/srv/halogen/artifacts:other",
    "/srv/halogen/artifacts\nother",
    "/srv/halogen/artifacts\0other",
  ])("rejects unsafe artifact directory %j", (path) => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, artifactDirectory: path })).toThrow();
  });

  it("rejects an artifact directory for an unpinned model revision", () => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, artifactDirectory: "/home/operator/staging/wrong-revision" })).toThrow(/artifact revision directory mismatch/);
  });

  it("requires the fixed user home directory", () => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, homeDirectory: "/home/another-user" })).toThrow(/user home mismatch/);
  });

  it.each([
    ["root user", { user: "root" }],
    ["root group", { group: "root" }],
  ])("rejects privileged identity: %s", (_label, change) => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, ...change })).toThrow(/unprivileged identity required/);
  });

  it("rejects unknown launch options", () => {
    expect(() => buildHalogenLaunch(profile, { ...validOptions, privileged: true })).toThrow();
  });

  it("passes only explicit runtime environment and never inherits credential variables", () => {
    const plan = buildHalogenLaunch(profile, validOptions);
    const envPairs = plan.args.flatMap((arg, index) => arg === "--env" ? [plan.args[index + 1]!] : []);
    const envNames = envPairs.map((pair) => pair.split("=", 1)[0]);

    expect(envNames).toEqual([...Object.keys(halogenEnvironment(profile)), "PYTHONDONTWRITEBYTECODE"]);
    expect(envNames).not.toContain("HOME");
    expect(envNames).not.toContain("PATH");
    expect(envNames).not.toContain("OPENAI_API_KEY");
    expect(envNames).not.toContain("ANTHROPIC_API_KEY");
    expect(plan.args).not.toContain("--setenv=OPENAI_API_KEY=secret");
    expect(envPairs.every((pair) => pair.includes("="))).toBe(true);
  });
});

describe("verifyHalogenHealth", () => {
  it("accepts a matching runtime, slot allocation, context, and KV pool report", () => {
    expect(verifyHalogenHealth(profile, validHealth())).toEqual([]);
  });

  it.each([
    ["runtime API version", { version: { api: "0.9.0", engine: "0.9.1", match: false } }, "malformed-or-wrong-runtime-health"],
    ["runtime engine version", { version: { api: "0.9.1", engine: "0.9.0", match: false } }, "malformed-or-wrong-runtime-health"],
    ["runtime match flag", { version: { api: "0.9.1", engine: "0.9.1", match: false } }, "malformed-or-wrong-runtime-health"],
    ["engine response", { engine: { responds: false } }, "malformed-or-wrong-runtime-health"],
    ["checkpoint format", { checkpoint_format: "gguf" }, "malformed-or-wrong-runtime-health"],
    ["slot count", { slots: profile.slots + 1 }, "slot-count-mismatch"],
    ["context size", { slot_ctx: profile.context + 1 }, "context-mismatch"],
    ["KV pool positions", { kv_pool_positions: profile.context + 1 }, "kv-pool-mismatch"],
  ] as const)("rejects %s drift", (_label, change, expectedReason) => {
    expect(verifyHalogenHealth(profile, validHealth(change))).toContain(expectedReason);
  });

  it("rejects a missing or structurally invalid health report", () => {
    expect(verifyHalogenHealth(profile, {})).toEqual(["malformed-or-wrong-runtime-health"]);
    expect(verifyHalogenHealth(profile, { ...validHealth(), slots: "1" })).toEqual([
      "malformed-or-wrong-runtime-health",
    ]);
  });
});
