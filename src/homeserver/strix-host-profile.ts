export interface StrixHostProfileArgs {
  biosUma: string;
  outPrefix: string;
}

export interface StrixDrmDeviceInput {
  card: string;
  vendorId: string | null;
  deviceId: string | null;
  vramTotalBytes: number | null;
  gttTotalBytes: number | null;
  performanceLevel: string | null;
  sclk: string | null;
  mclk: string | null;
}

export interface StrixHostProfileInput {
  capturedAt: string;
  biosUma: string;
  kernel: string;
  biosVersion: string | null;
  boardName: string | null;
  mesaVersion: string | null;
  rocmVersion: string | null;
  meminfo: string;
  kernelCmdline: string;
  cpuGovernor: string | null;
  platformProfile: string | null;
  drmDevices: StrixDrmDeviceInput[];
  temperaturesC: number[];
  powerW: number[];
}

export interface StrixHostProfile {
  schemaVersion: 1;
  capturedAt: string;
  bios: {
    configuredUma: string;
    version: string | null;
    boardName: string | null;
  };
  software: {
    kernel: string;
    mesaVersion: string | null;
    rocmVersion: string | null;
  };
  memory: {
    totalBytes: number | null;
    availableBytes: number | null;
    swapTotalBytes: number | null;
    swapFreeBytes: number | null;
  };
  kernelMemoryParameters: Record<string, string>;
  power: {
    platformProfile: string | null;
    maxObservedW: number | null;
  };
  cpu: {
    governor: string | null;
  };
  thermal: {
    maxTemperatureC: number | null;
  };
  drmDevices: StrixDrmDeviceInput[];
  limitations: string[];
}

const KERNEL_MEMORY_KEYS = new Set([
  "amdgpu.gttsize",
  "amdgpu.sg_display",
  "amdgpu.vm_fragment_size",
  "amd_iommu",
  "ttm.page_pool_size",
  "ttm.pages_limit",
]);

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseStrixHostProfileArgs(argv: string[]): StrixHostProfileArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flag !== "--bios-uma" && flag !== "--out") throw new Error(`unrecognized argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    values.set(flag, nextValue(argv, index, flag));
    index++;
  }
  const biosUma = values.get("--bios-uma")?.trim();
  const outPrefix = values.get("--out")?.trim();
  if (!biosUma) throw new Error("--bios-uma is required (record the firmware setting, or 'unknown')");
  if (biosUma.length > 80 || /[\r\n\0]/.test(biosUma)) throw new Error("--bios-uma must be a bounded single-line value");
  if (!outPrefix) throw new Error("--out is required");
  return { biosUma, outPrefix };
}

function meminfoBytes(meminfo: string, key: string): number | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = meminfo.match(new RegExp(`^${escaped}:\\s+(\\d+)\\s+kB$`, "m"));
  return match ? Number(match[1]) * 1024 : null;
}

function kernelMemoryParameters(cmdline: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const field of cmdline.trim().split(/\s+/)) {
    const separator = field.indexOf("=");
    if (separator <= 0) continue;
    const key = field.slice(0, separator);
    if (!KERNEL_MEMORY_KEYS.has(key)) continue;
    result[key] = field.slice(separator + 1);
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function maxFinite(values: number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length === 0 ? null : Math.max(...finite);
}

function normalizeNullable(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function normalizeDevice(device: StrixDrmDeviceInput): StrixDrmDeviceInput {
  if (!/^card\d+$/.test(device.card)) throw new Error(`invalid DRM card id: ${device.card}`);
  const bytes = (value: number | null, label: string): number | null => {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer or null`);
    return value;
  };
  return {
    card: device.card,
    vendorId: normalizeNullable(device.vendorId),
    deviceId: normalizeNullable(device.deviceId),
    vramTotalBytes: bytes(device.vramTotalBytes, `${device.card}.vramTotalBytes`),
    gttTotalBytes: bytes(device.gttTotalBytes, `${device.card}.gttTotalBytes`),
    performanceLevel: normalizeNullable(device.performanceLevel),
    sclk: normalizeNullable(device.sclk),
    mclk: normalizeNullable(device.mclk),
  };
}

export function buildStrixHostProfile(input: StrixHostProfileInput): StrixHostProfile {
  if (!Number.isFinite(Date.parse(input.capturedAt))) throw new Error("capturedAt must be an ISO timestamp");
  if (!input.kernel.trim()) throw new Error("kernel is required");
  const drmDevices = input.drmDevices.map(normalizeDevice).sort((left, right) => left.card.localeCompare(right.card));
  const limitations: string[] = [];
  if (input.biosUma.trim().toLowerCase() === "unknown") limitations.push("BIOS UMA setting was not observed; only effective DRM memory is recorded.");
  if (drmDevices.every((device) => device.vramTotalBytes === null)) limitations.push("No readable DRM VRAM total was found.");
  if (drmDevices.every((device) => device.gttTotalBytes === null)) limitations.push("No readable DRM GTT total was found.");
  if (input.powerW.length === 0) limitations.push("No readable hwmon power channel was found; use a wall meter for energy claims.");
  return {
    schemaVersion: 1,
    capturedAt: new Date(input.capturedAt).toISOString(),
    bios: {
      configuredUma: input.biosUma.trim(),
      version: normalizeNullable(input.biosVersion),
      boardName: normalizeNullable(input.boardName),
    },
    software: {
      kernel: input.kernel.trim(),
      mesaVersion: normalizeNullable(input.mesaVersion),
      rocmVersion: normalizeNullable(input.rocmVersion),
    },
    memory: {
      totalBytes: meminfoBytes(input.meminfo, "MemTotal"),
      availableBytes: meminfoBytes(input.meminfo, "MemAvailable"),
      swapTotalBytes: meminfoBytes(input.meminfo, "SwapTotal"),
      swapFreeBytes: meminfoBytes(input.meminfo, "SwapFree"),
    },
    kernelMemoryParameters: kernelMemoryParameters(input.kernelCmdline),
    power: {
      platformProfile: normalizeNullable(input.platformProfile),
      maxObservedW: maxFinite(input.powerW),
    },
    cpu: { governor: normalizeNullable(input.cpuGovernor) },
    thermal: { maxTemperatureC: maxFinite(input.temperaturesC) },
    drmDevices,
    limitations,
  };
}

function valueOrNa(value: string | number | null): string {
  return value === null ? "n/a" : String(value);
}

function gib(value: number | null): string {
  return value === null ? "n/a" : (value / 1024 ** 3).toFixed(2);
}

export function renderStrixHostProfileMarkdown(profile: StrixHostProfile): string {
  const lines = [
    "# Strix Halo host profile",
    "",
    `Captured: ${profile.capturedAt}`,
    "",
    "| Field | Value |",
    "|---|---:|",
    `| BIOS UMA (operator-observed) | ${profile.bios.configuredUma} |`,
    `| BIOS version | ${valueOrNa(profile.bios.version)} |`,
    `| Board | ${valueOrNa(profile.bios.boardName)} |`,
    `| Kernel | ${profile.software.kernel} |`,
    `| Mesa | ${valueOrNa(profile.software.mesaVersion)} |`,
    `| ROCm | ${valueOrNa(profile.software.rocmVersion)} |`,
    `| System memory (GiB) | ${gib(profile.memory.totalBytes)} |`,
    `| Available memory (GiB) | ${gib(profile.memory.availableBytes)} |`,
    `| Swap total/free (GiB) | ${gib(profile.memory.swapTotalBytes)} / ${gib(profile.memory.swapFreeBytes)} |`,
    `| Platform power profile | ${valueOrNa(profile.power.platformProfile)} |`,
    `| CPU governor | ${valueOrNa(profile.cpu.governor)} |`,
    `| Max observed temperature (C) | ${valueOrNa(profile.thermal.maxTemperatureC)} |`,
    `| Max observed hwmon power (W) | ${valueOrNa(profile.power.maxObservedW)} |`,
    "",
    "## DRM memory and clocks",
    "",
    "| Card | Vendor | Device | Observed VRAM (GiB) | Observed GTT (GiB) | Performance level | SCLK | MCLK |",
    "|---|---|---|---:|---:|---|---|---|",
    ...profile.drmDevices.map((device) =>
      `| ${device.card} | ${valueOrNa(device.vendorId)} | ${valueOrNa(device.deviceId)} | ${gib(device.vramTotalBytes)} | ${gib(device.gttTotalBytes)} | ${valueOrNa(device.performanceLevel)} | ${valueOrNa(device.sclk)?.replace(/\n/g, "; ")} | ${valueOrNa(device.mclk)?.replace(/\n/g, "; ")} |`
    ),
    "",
    "## Allow-listed kernel memory parameters",
    "",
    Object.keys(profile.kernelMemoryParameters).length === 0
      ? "None observed."
      : Object.entries(profile.kernelMemoryParameters).map(([key, value]) => `- ${key}=${value}`).join("\n"),
    "",
    "## Limitations",
    "",
    ...(profile.limitations.length === 0 ? ["None recorded."] : profile.limitations.map((item) => `- ${item}`)),
    "",
  ];
  return `${lines.join("\n")}\n`;
}
