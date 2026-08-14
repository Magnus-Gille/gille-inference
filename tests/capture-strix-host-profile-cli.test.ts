import { describe, expect, it, vi } from "vitest";

import { parseSysfsNumber, runCaptureStrixHostProfile } from "../scripts/capture-strix-host-profile.js";

describe("capture Strix host profile CLI", () => {
  it("keeps missing or unreadable sysfs values distinct from an observed zero", () => {
    expect(parseSysfsNumber(null)).toBeNull();
    expect(parseSysfsNumber("not-a-number")).toBeNull();
    expect(parseSysfsNumber("0")).toBe(0);
    expect(parseSysfsNumber("42400000", 1_000_000)).toBe(42.4);
  });

  it("writes one JSON/Markdown pair from read-only observations", () => {
    const writePair = vi.fn(() => ({ jsonPath: "/tmp/host.json", markdownPath: "/tmp/host.md" }));
    const stdout = vi.fn();
    const exit = runCaptureStrixHostProfile(["--bios-uma", "64G", "--out", "host"], {
      capture: (args) => ({
        capturedAt: "2026-08-14T12:00:00.000Z",
        biosUma: args.biosUma,
        kernel: "6.14.0",
        biosVersion: null,
        boardName: null,
        mesaVersion: null,
        rocmVersion: null,
        meminfo: "MemTotal: 131072000 kB\n",
        kernelCmdline: "quiet",
        cpuGovernor: null,
        platformProfile: null,
        drmDevices: [],
        temperaturesC: [],
        powerW: [],
      }),
      writePair,
      stdout,
      stderr: vi.fn(),
    });
    expect(exit).toBe(0);
    expect(writePair).toHaveBeenCalledOnce();
    expect(stdout.mock.calls[0]![0]).not.toContain("64G");
  });
});
