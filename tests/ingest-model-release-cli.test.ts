import { describe, expect, it, vi } from "vitest";

import { runReleaseIngestion } from "../scripts/ingest-model-release.js";
import {
  ReleaseUnavailableError,
  type ReleaseArchive,
} from "../src/homeserver/model-release-ingestion.js";

const ARCHIVE = {
  relativeDirectory: "Qwen--Qwen3.8-27B/0123456789012345678901234567890123456789",
  files: {
    "config.json": "{}",
    "release.json": "{}",
    "REPORT.md": "# report\n",
    "manifest.json": "{}",
  },
  inspection: {
    model: {
      id: "Qwen/Qwen3.8-27B",
      revision: "0123456789012345678901234567890123456789",
    },
  },
} as unknown as ReleaseArchive;

describe("runReleaseIngestion", () => {
  it("emits one machine-readable success row pointing to both JSON and Markdown", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const collect = vi.fn(async () => ARCHIVE);
    const write = vi.fn(() => [
      "/tmp/release/config.json",
      "/tmp/release/release.json",
      "/tmp/release/REPORT.md",
      "/tmp/release/manifest.json",
    ]);

    const exitCode = await runReleaseIngestion([], { collect, write, stdout, stderr });

    expect(exitCode).toBe(0);
    expect(collect).toHaveBeenCalledWith("Qwen/Qwen3.8-27B");
    expect(write).toHaveBeenCalledWith("data/model-releases", ARCHIVE);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stdout.mock.calls[0]![0])).toMatchObject({
      status: "archived",
      releaseJsonPath: "/tmp/release/release.json",
      reportPath: "/tmp/release/REPORT.md",
      filesWritten: 4,
    });
  });

  it("returns the documented not-yet-public status without writing", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const collect = vi.fn(async () => {
      throw new ReleaseUnavailableError("Qwen/Qwen3.8-27B", 401);
    });
    const write = vi.fn();

    const exitCode = await runReleaseIngestion([], { collect, write, stdout, stderr });

    expect(exitCode).toBe(3);
    expect(write).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(JSON.parse(stdout.mock.calls[0]![0])).toEqual({
      status: "unavailable",
      model: "Qwen/Qwen3.8-27B",
      httpStatus: 401,
    });
  });

  it("returns a normal failure for malformed arguments", async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const collect = vi.fn(async () => ARCHIVE);
    const write = vi.fn();

    const exitCode = await runReleaseIngestion(["--bogus"], { collect, write, stdout, stderr });

    expect(exitCode).toBe(1);
    expect(collect).not.toHaveBeenCalled();
    expect(stderr.mock.calls[0]![0]).toMatch(/unrecognized argument/);
  });
});
