import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { main } from "../scripts/check-observer-review-bundle.js";

const DIGEST = "a".repeat(64);
const REPORT = {
  source: "observer-review-bundle-v1" as const,
  valid: true,
  authorizesMutation: false as const,
  packetSha256: DIGEST,
  reasons: [] as string[],
};

function io() {
  return { writeStdout: vi.fn<(text: string) => void>(), writeStderr: vi.fn<(text: string) => void>() };
}

describe("check-observer-review-bundle CLI", () => {
  it("prints offline-only help and accepts no extra arguments", async () => {
    const output = io();
    await expect(main(["--help"], { ...output })).resolves.toBe(0);
    const help = output.writeStdout.mock.calls[0]![0]!;
    expect(help).toContain("integrity and structure offline only");
    expect(help).toContain("never authorizes M5 work or mutation");
    expect(help).toContain("performs Linux qualification");
    expect(output.writeStderr).not.toHaveBeenCalled();
  });

  it("rejects malformed argument counts with usage exit 2", async () => {
    const output = io();
    await expect(main([], { ...output })).resolves.toBe(2);
    expect(output.writeStdout).not.toHaveBeenCalled();
    expect(output.writeStderr).toHaveBeenCalledWith(expect.stringContaining("usage error"));
  });

  it("rejects uppercase, short, and otherwise malformed digests before checking", async () => {
    const check = vi.fn();
    for (const digest of ["A".repeat(64), "a".repeat(63), "g".repeat(64)]) {
      const output = io();
      await expect(main(["/bundle", digest], { ...output, checkObserverReviewBundle: check })).resolves.toBe(2);
      expect(output.writeStdout).not.toHaveBeenCalled();
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("emits the verifier's invalid report and exits 1 for a missing directory", async () => {
    const output = io();
    await expect(main(["/private/tmp/does-not-exist-observer-bundle", DIGEST], {
      ...output,
    })).resolves.toBe(1);
    expect(JSON.parse(output.writeStdout.mock.calls[0]![0]!)).toMatchObject({
      valid: false,
      authorizesMutation: false,
      reasons: ["bundle-read-failed"],
    });
  });

  it("sanitizes an unexpected malformed-JSON verifier failure", async () => {
    const output = io();
    const directory = mkdtempSync(join(tmpdir(), "observer-review-malformed-"));
    const packetPath = join(directory, "packet.json");
    writeFileSync(packetPath, "{ malformed JSON\n", "utf8");
    await expect(main([directory, DIGEST], { ...output })).resolves.toBe(1);
    const report = JSON.parse(output.writeStdout.mock.calls[0]![0]!);
    expect(report).toMatchObject({
      source: "observer-review-bundle-v1",
      valid: false,
      authorizesMutation: false,
      packetSha256: null,
      reasons: ["invalid-packet"],
    });
    expect(JSON.stringify(report)).not.toContain(directory);
    expect(output.writeStderr).not.toHaveBeenCalled();
    rmSync(directory, { recursive: true, force: true });
  });

  it("uses a fixed sanitized report when the verifier unexpectedly throws", async () => {
    const output = io();
    const secretPath = "/private/tmp/observer-review-secret-name-malformed-json";
    const check = vi.fn(async () => { throw new Error(`malformed JSON at ${secretPath}`); });
    await expect(main([secretPath, DIGEST], { ...output, checkObserverReviewBundle: check })).resolves.toBe(1);
    const report = JSON.parse(output.writeStdout.mock.calls[0]![0]!);
    expect(report).toEqual({
      source: "observer-review-bundle-v1",
      valid: false,
      authorizesMutation: false,
      packetSha256: null,
      reasons: ["unexpected wrapper failure"],
    });
    expect(JSON.stringify(report)).not.toContain(secretPath);
    expect(output.writeStderr).not.toHaveBeenCalled();
  });

  it("passes a valid fixture report through with exit 0", async () => {
    const output = io();
    const check = vi.fn(async (directory: string, expectedDigest: string) => ({
      ...REPORT,
      packetSha256: expectedDigest,
      reasons: [],
    }));
    await expect(main(["fixture/observer-review", DIGEST], {
      ...output,
      checkObserverReviewBundle: check,
    })).resolves.toBe(0);
    expect(check).toHaveBeenCalledWith("fixture/observer-review", DIGEST);
    expect(JSON.parse(output.writeStdout.mock.calls[0]![0]!)).toEqual(REPORT);
  });
});
