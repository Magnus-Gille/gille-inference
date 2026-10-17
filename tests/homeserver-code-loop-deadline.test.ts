import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeLoopDeadline, CodeLoopDeadlineError, limitCodeLoopCageLifetime, withCodeLoopDeadline } from "../src/homeserver/code-loop-deadline.js";
import { validateCodeLoopRequest } from "../src/homeserver/code-loop.js";
import type { CodeLoopDeps } from "../src/homeserver/code-loop-types.js";

const config = { wallSDefault: 480, wallSMax: 900, turnsDefault: 24, turnsMax: 40, tokensDefault: 60_000, tokensMax: 120_000 };
afterEach(() => vi.useRealTimers());

describe("whole-job deadline contract", () => {
  it.each([0, 89, 180.5, 901, Number.NaN, "180", null])("rejects invalid total budget %s before execution", total => {
    expect(validateCodeLoopRequest({ instruction: "x", files: [{ path: "x", content: "x" }], caps: { total_wall_s: total as number } }, config).ok).toBe(false);
  });

  it("tightens the independent cgroup lifetime at each later phase", () => {
    const argv = ["systemd-run", "-p", "RuntimeMaxSec=930", "-p", "TimeoutStopSec=10s", "--", "bash"];
    expect(limitCodeLoopCageLifetime(argv, 105_900)).toContain("RuntimeMaxSec=105");
    expect(limitCodeLoopCageLifetime(argv, 15_000)).toContain("RuntimeMaxSec=15");
    expect(limitCodeLoopCageLifetime(argv, 1_000)).toContain("TimeoutStopSec=10s");
    expect(argv).toContain("RuntimeMaxSec=930");
    expect(limitCodeLoopCageLifetime(["git", "status"], 10)).toEqual(["git", "status"]);
  });

  it("checks the monotonic cutoff even when the event loop has not run its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const deadline = new CodeLoopDeadline(180);
    const runCommand = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const deps = withCodeLoopDeadline({ runCommand } as unknown as CodeLoopDeps, deadline);
    vi.spyOn(performance, "now").mockReturnValue(deadline.workEndsAt + 1);
    await expect(deps.runCommand(["git", "status"], { cwd: "/tmp", env: {}, timeoutMs: 30_000 })).rejects.toBeInstanceOf(CodeLoopDeadlineError);
    expect(runCommand).not.toHaveBeenCalled();
    deadline.dispose();
    vi.restoreAllMocks();
  });
});
