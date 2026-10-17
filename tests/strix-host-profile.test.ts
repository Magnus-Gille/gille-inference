import { describe, expect, it } from "vitest";

import {
  buildStrixHostProfile,
  parseStrixHostProfileArgs,
  renderStrixHostProfileMarkdown,
} from "../src/homeserver/strix-host-profile.js";

describe("Strix host profile", () => {
  it("requires an explicit BIOS UMA observation and output prefix", () => {
    expect(parseStrixHostProfileArgs(["--bios-uma", "64G", "--out", "results/host"])).toEqual({
      biosUma: "64G",
      outPrefix: "results/host",
    });
    expect(() => parseStrixHostProfileArgs(["--out", "results/host"])).toThrow(/bios-uma/);
    expect(() => parseStrixHostProfileArgs(["--bios-uma", "64G", "--out", "x", "--out", "y"])).toThrow(/duplicate/);
  });

  it("normalizes observable host state and retains unavailable evidence as null", () => {
    const profile = buildStrixHostProfile({
      capturedAt: "2026-08-14T12:00:00.000Z",
      biosUma: "64G",
      kernel: "6.14.0",
      biosVersion: "1.2.3",
      boardName: "Strix Halo",
      mesaVersion: "25.2.0",
      rocmVersion: null,
      meminfo: "MemTotal:       131072000 kB\nMemAvailable:  104857600 kB\nSwapTotal:       8388608 kB\nSwapFree:        7340032 kB\n",
      kernelCmdline: "quiet splash amdgpu.gttsize=32768 secret_token=do-not-store ttm.pages_limit=25165824",
      cpuGovernor: "performance",
      platformProfile: "performance",
      drmDevices: [{
        card: "card1",
        vendorId: "0x1002",
        deviceId: "0x1586",
        vramTotalBytes: 68_719_476_736,
        gttTotalBytes: 32_212_254_720,
        performanceLevel: "auto",
        sclk: "0: 400Mhz\n1: 2900Mhz *",
        mclk: null,
      }],
      temperaturesC: [52.5, 61],
      powerW: [18.2, 42.4],
    });

    expect(profile.memory).toEqual({
      totalBytes: 134_217_728_000,
      availableBytes: 107_374_182_400,
      swapTotalBytes: 8_589_934_592,
      swapFreeBytes: 7_516_192_768,
    });
    expect(profile.kernelMemoryParameters).toEqual({
      "amdgpu.gttsize": "32768",
      "ttm.pages_limit": "25165824",
    });
    expect(JSON.stringify(profile)).not.toContain("secret_token");
    expect(profile.thermal.maxTemperatureC).toBe(61);
    expect(profile.power.maxObservedW).toBe(42.4);
    expect(renderStrixHostProfileMarkdown(profile)).toContain("Observed VRAM");
  });

  it("rejects invalid clocks and non-Strix-sized explicit values", () => {
    expect(() => buildStrixHostProfile({
      capturedAt: "not-a-date",
      biosUma: "64G",
      kernel: "6.14.0",
      biosVersion: null,
      boardName: null,
      mesaVersion: null,
      rocmVersion: null,
      meminfo: "",
      kernelCmdline: "",
      cpuGovernor: null,
      platformProfile: null,
      drmDevices: [],
      temperaturesC: [],
      powerW: [],
    })).toThrow(/capturedAt/);
  });
});
