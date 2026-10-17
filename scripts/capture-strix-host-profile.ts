#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { release as kernelRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildStrixHostProfile,
  parseStrixHostProfileArgs,
  renderStrixHostProfileMarkdown,
  type StrixDrmDeviceInput,
  type StrixHostProfile,
  type StrixHostProfileArgs,
  type StrixHostProfileInput,
} from "../src/homeserver/strix-host-profile.js";

interface Dependencies {
  capture: (args: StrixHostProfileArgs) => StrixHostProfileInput;
  writePair: (prefix: string, profile: StrixHostProfile) => { jsonPath: string; markdownPath: string };
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function readText(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

export function parseSysfsNumber(raw: string | null, divisor = 1): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value / divisor : null;
}

function readNumber(path: string, divisor = 1): number | null {
  return parseSysfsNumber(readText(path), divisor);
}

function commandVersion(command: string, args: string[], pattern: RegExp): string | null {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
    return output.match(pattern)?.[1] ?? output.trim().split("\n")[0]?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

function hwmonValues(pattern: RegExp, divisor: number): number[] {
  try {
    return readdirSync("/sys/class/hwmon", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .flatMap((entry) => {
        const root = join("/sys/class/hwmon", entry.name);
        try {
          return readdirSync(root)
            .filter((name) => pattern.test(name))
            .map((name) => readNumber(join(root, name), divisor))
            .filter((value): value is number => value !== null);
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function drmDevices(): StrixDrmDeviceInput[] {
  try {
    return readdirSync("/sys/class/drm", { withFileTypes: true })
      .filter((entry) => /^card\d+$/.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => {
        const root = join("/sys/class/drm", entry.name, "device");
        return {
          card: entry.name,
          vendorId: readText(join(root, "vendor")),
          deviceId: readText(join(root, "device")),
          vramTotalBytes: readNumber(join(root, "mem_info_vram_total")),
          gttTotalBytes: readNumber(join(root, "mem_info_gtt_total")),
          performanceLevel: readText(join(root, "power_dpm_force_performance_level")),
          sclk: readText(join(root, "pp_dpm_sclk")),
          mclk: readText(join(root, "pp_dpm_mclk")),
        };
      });
  } catch {
    return [];
  }
}

function capture(args: StrixHostProfileArgs): StrixHostProfileInput {
  let rocmVersion = readText("/opt/rocm/.info/version");
  if (rocmVersion === null) rocmVersion = commandVersion("rocminfo", ["--version"], /(?:version|rocminfo)\s*[: ]\s*([^\n]+)/i);
  return {
    capturedAt: new Date().toISOString(),
    biosUma: args.biosUma,
    kernel: kernelRelease(),
    biosVersion: readText("/sys/class/dmi/id/bios_version"),
    boardName: readText("/sys/class/dmi/id/board_name"),
    mesaVersion: commandVersion("vulkaninfo", ["--summary"], /Mesa\s+([0-9]+(?:\.[0-9]+){1,3})/i),
    rocmVersion,
    meminfo: readText("/proc/meminfo") ?? "",
    kernelCmdline: readText("/proc/cmdline") ?? "",
    cpuGovernor: readText("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
    platformProfile: readText("/sys/firmware/acpi/platform_profile"),
    drmDevices: drmDevices(),
    temperaturesC: hwmonValues(/^temp\d+_input$/, 1000),
    powerW: hwmonValues(/^power\d+_(?:average|input)$/, 1_000_000),
  };
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* Preserve original failure. */ }
    throw error;
  }
}

function writePair(prefix: string, profile: StrixHostProfile): { jsonPath: string; markdownPath: string } {
  const resolved = resolve(prefix);
  const jsonPath = `${resolved}.json`;
  const markdownPath = `${resolved}.md`;
  atomicWrite(jsonPath, `${JSON.stringify(profile, null, 2)}\n`);
  atomicWrite(markdownPath, renderStrixHostProfileMarkdown(profile));
  return { jsonPath, markdownPath };
}

const DEFAULT_DEPS: Dependencies = {
  capture,
  writePair,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

export function runCaptureStrixHostProfile(argv: string[], deps: Dependencies = DEFAULT_DEPS): number {
  try {
    const args = parseStrixHostProfileArgs(argv);
    const profile = buildStrixHostProfile(deps.capture(args));
    const paths = deps.writePair(args.outPrefix, profile);
    deps.stdout(JSON.stringify({ status: "complete", ...paths, drmDevices: profile.drmDevices.length }));
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCaptureStrixHostProfile(process.argv.slice(2));
}
