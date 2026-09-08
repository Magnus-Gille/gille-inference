import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { M3_QUALIFICATION_CONTRACT } from "../src/homeserver/m3-qualification.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = resolve(repoRoot, "scripts/qualify-m3.ts");
const tsxLoader = resolve(repoRoot, "node_modules/tsx/dist/esm/index.mjs");
const inputDirs: string[] = [];

function holdInput(): Record<string, unknown> {
  return {
    contract: M3_QUALIFICATION_CONTRACT,
    version: 1,
    evaluation: { asOf: "2026-09-03T00:00:00.000Z" },
    window: {
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-09-02T00:00:00.000Z",
    },
    snapshot: {
      sha256: `sha256:${"a".repeat(64)}`,
      immutable: true,
      observedAt: "2026-09-02T00:00:00.000Z",
    },
    thresholds: null,
    candidates: [],
  };
}

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error,
  };
}

function writeInput(bytes: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "gille-qualify-m3-"));
  inputDirs.push(dir);
  const path = join(dir, "input.json");
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  while (inputDirs.length > 0) rmSync(inputDirs.pop()!, { force: true, recursive: true });
});

describe("qualify-m3 CLI", () => {
  it("prints help and accepts a valid report input with its byte hash", () => {
    const help = runCli(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("npx tsx scripts/qualify-m3.ts --input <path>");

    const bytes = Buffer.from(JSON.stringify(holdInput()));
    const inputPath = writeInput(bytes);
    const result = runCli(["--input", inputPath]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      inputSha256: string;
      report: { analysisVerdict: string; enablingDecision: unknown };
    };
    expect(output.inputSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(output.report.analysisVerdict).toBe("HOLD");
    expect(output.report.enablingDecision).toBeNull();
  });

  it("rejects malformed JSON without stdout or parse details", () => {
    const inputPath = writeInput('{"contract":');
    const result = runCli(["--input", inputPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("E_INPUT_JSON\n");
    expect(result.stderr).not.toContain(inputPath);
  });

  it("rejects an unexpected shape without emitting a GO report", () => {
    const inputPath = writeInput(JSON.stringify({ secret: "do-not-echo", candidates: "wrong" }));
    const result = runCli(["--input", inputPath]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stdout).not.toContain("GO");
    expect(result.stderr).toBe("E_INPUT_SCHEMA\n");
    expect(result.stderr).not.toContain("do-not-echo");
    expect(result.stderr).not.toContain(inputPath);
  });

  it("uses fixed usage and size failures", () => {
    const usage = runCli(["--input", "a", "--input", "b"]);
    expect(usage.status).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toBe("E_USAGE\n");

    const oversized = runCli(["--input", writeInput(Buffer.alloc(1024 * 1024 + 1, 0x20))]);
    expect(oversized.status).toBe(1);
    expect(oversized.stdout).toBe("");
    expect(oversized.stdout).not.toContain("GO");
    expect(oversized.stderr).toBe("E_INPUT_TOO_LARGE\n");

    const directory = mkdtempSync(join(tmpdir(), "gille-qualify-m3-directory-"));
    inputDirs.push(directory);
    const nonRegular = runCli(["--input", directory]);
    expect(nonRegular.status).toBe(1);
    expect(nonRegular.stdout).toBe("");
    expect(nonRegular.stderr).toBe("E_INPUT_READ\n");
  });
});
