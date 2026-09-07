import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  SERVED_PROVENANCE_ERROR_CODES,
  SERVED_PROVENANCE_HELP,
  parseCaptureServedProvenanceArgs,
  runCaptureServedProvenance,
} from "../scripts/capture-served-provenance.js";
import { servedConfigurationIdentity, servedProvenanceSchema } from "../src/homeserver/served-provenance.js";
import type { ServedProcessProvenance } from "../src/homeserver/served-provenance-collector.js";

const ARGV = [
  "--pid", "12345",
  "--alias", "demo-public",
  "--gateway-build", "0123456789abcdef0123456789abcdef01234567",
];

function observation(overrides: Partial<ServedProcessProvenance> = {}): ServedProcessProvenance {
  return {
    capturedAt: "2026-09-07T12:00:00.000Z",
    freshness: "fresh",
    reasons: [],
    weights: [{ sha256: "a".repeat(64), binding: "unproven" }],
    projector: { kind: "not-applicable" },
    runtimeSha256: "b".repeat(64),
    launchFlags: {
      contextSize: 32768,
      parallelism: 1,
      temperature: 0,
      topP: 1,
      topK: 0,
      minP: 0,
      predictLimit: 4096,
    },
    environment: {
      osRelease: "linux",
      arch: "arm64",
      cpuCount: 12,
      memoryBytes: 64 * 1024 ** 3,
    },
    ...overrides,
  };
}

describe("capture served provenance", () => {
  it("accepts only the bounded public flags", () => {
    expect(parseCaptureServedProvenanceArgs(ARGV)).toEqual({
      pid: 12345,
      alias: "demo-public",
      gatewayBuild: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(() => parseCaptureServedProvenanceArgs([...ARGV, "--pid", "2"])).toThrow();
    expect(() => parseCaptureServedProvenanceArgs([...ARGV, "--unknown", "x"])).toThrow();
    expect(() => parseCaptureServedProvenanceArgs(["--pid", "0", "--alias", "demo"])).toThrow();
    expect(() => parseCaptureServedProvenanceArgs(["--pid", "1", "--alias", "unsafe label"])).toThrow();
    expect(() => parseCaptureServedProvenanceArgs(["--pid", "1", "--alias", "models/demo"])).toThrow();
    expect(() => parseCaptureServedProvenanceArgs(["--pid", "1", "--alias", "demo", "--gateway-build", "A".repeat(40)])).toThrow();
  });

  it("emits only schema JSON and preserves operator declaration versus observed evidence", () => {
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string) => void>();
    const captureProcess = vi.fn(() => observation());

    const exit = runCaptureServedProvenance(ARGV, { captureProcess, stdout, stderr });

    expect(exit).toBe(0);
    expect(captureProcess).toHaveBeenCalledWith(12345);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(stdout.mock.calls[0]![0]) as ReturnType<typeof servedProvenanceSchema.parse>;
    expect(servedProvenanceSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.modelAlias).toBe("demo-public");
    expect(snapshot.artifacts.gatewayBuild.sha).toEqual({
      source: "operator-declared",
      value: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(snapshot.artifacts.weights[0]?.binding).toBe("unproven");
    expect(snapshot.launchConfiguration).toEqual({
      contextSize: { source: "observed", value: 32768 },
      parallelism: { source: "observed", value: 1 },
      temperature: { source: "observed", value: 0 },
      topP: { source: "observed", value: 1 },
      topK: { source: "observed", value: 0 },
      minP: { source: "observed", value: 0 },
      predictLimit: { source: "observed", value: 4096 },
    });
    const diagnosticStdout = vi.fn<(line: string) => void>();
    expect(runCaptureServedProvenance(ARGV, {
      captureProcess: () => observation({ reasons: ["process-not-llama-server"] }),
      stdout: diagnosticStdout,
      stderr,
    })).toBe(0);
    expect(JSON.parse(diagnosticStdout.mock.calls[0]![0]).reasons).toContain("process-not-llama-server");
    expect(snapshot.environment).toEqual({
      source: "observed",
      value: {
        os: "linux",
        arch: "arm64",
        cpuCount: 12,
        memoryBytes: 64 * 1024 ** 3,
        resourceCeilings: { cpuCount: null, memoryBytes: null },
      },
    });
    expect(snapshot.completeness).toBe("incomplete");
  });

  it("returns a successful incomplete snapshot when the process observation is unavailable", () => {
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string) => void>();
    const exit = runCaptureServedProvenance(
      ["--pid", "12345", "--alias", "demo-public"],
      { captureProcess: () => observation({ freshness: "unavailable", weights: [], runtimeSha256: null }), stdout, stderr },
    );

    expect(exit).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    const snapshot = JSON.parse(stdout.mock.calls[0]![0]) as ReturnType<typeof servedProvenanceSchema.parse>;
    expect(snapshot.completeness).toBe("incomplete");
    expect(snapshot.freshness).toBe("unavailable");
    expect(snapshot.reasons).toContain("observation-unavailable");
    expect(snapshot.launchConfiguration.contextSize).toEqual({
      source: "unknown",
      reason: "observation-unavailable",
    });
  });

  it("keeps the documented synthetic sample schema-valid and identity-stable", () => {
    const docs = readFileSync(new URL("../docs/served-provenance.md", import.meta.url), "utf8");
    const sample = docs.match(/## Synthetic example[\s\S]*?```json\n([\s\S]*?)\n```/)?.[1];
    expect(sample).toBeDefined();
    const parsed = servedProvenanceSchema.parse(JSON.parse(sample!));
    expect(parsed.configurationIdentity).toBe(servedConfigurationIdentity(parsed));
  });

  it("uses fixed sanitized errors for invalid arguments and collector failures", () => {
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string) => void>();
    expect(runCaptureServedProvenance(["--pid", "not-a-pid", "--alias", "secret-value"], { stdout, stderr })).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(SERVED_PROVENANCE_ERROR_CODES.invalidArguments);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("not-a-pid");
    stderr.mockClear();

    expect(runCaptureServedProvenance(ARGV, {
      captureProcess: () => { throw new Error("private path and raw process details"); },
      stdout,
      stderr,
    })).toBe(1);
    expect(stderr).toHaveBeenCalledWith(SERVED_PROVENANCE_ERROR_CODES.internal);
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("private path");
  });

  it("keeps help as the only non-snapshot stdout mode", () => {
    const stdout = vi.fn<(line: string) => void>();
    const stderr = vi.fn<(line: string) => void>();
    expect(runCaptureServedProvenance(["--help"], { stdout, stderr })).toBe(0);
    expect(stdout).toHaveBeenCalledWith(SERVED_PROVENANCE_HELP);
    expect(stderr).not.toHaveBeenCalled();
  });
});
