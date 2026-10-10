import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createInstallProcess } from "../src/homeserver/controlled-install-process.js";

const execPath = process.execPath;
const sleep = promisify(setTimeout);

type ProcessIds = { parent: number; descendant: number };

function processOptions(directory: string, script: string, marker: string, termGraceMs = 40) {
  return {
    executable: "/bin/sh",
    args: ["-c", script],
    cwd: directory,
    env: {
      PATH: "/usr/bin:/bin",
      LC_ALL: "C",
      MARKER: marker,
    },
    termGraceMs,
  };
}

async function waitForMarker(marker: string): Promise<ProcessIds> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const values = (await readFile(marker, "utf8")).trim().split(/\s+/).map(Number);
      if (values.length === 2 && values.every(pid => Number.isInteger(pid) && pid > 0)) {
        return { parent: values[0]!, descendant: values[1]! };
      }
    } catch {
      // The marker is the readiness signal; retry until the bounded deadline.
    }
    await sleep(5);
  }
  throw new Error("process readiness marker did not appear");
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGone(pids: ProcessIds): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!exists(pids.parent) && !exists(pids.descendant)) return;
    await sleep(10);
  }
  throw new Error(`owned process remains: ${pids.parent}/${pids.descendant}`);
}

function killGroup(pids: ProcessIds | undefined): void {
  if (!pids) return;
  try { process.kill(-pids.parent, "SIGKILL"); } catch { /* already gone */ }
  for (const pid of [pids.parent, pids.descendant]) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

async function withDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "controlled-install-process-"));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const ignoringTerm = [
  "trap '' TERM HUP INT",
  "( trap '' TERM HUP INT; while :; do sleep 1; done ) &",
  "grandchild=$!",
  "printf '%s %s\\n' \"$$\" \"$grandchild\" > \"$MARKER\"",
  "while :; do sleep 1; done",
].join("\n");

describe("controlled install foreground process adapter", () => {
  it("aborts and stops a TERM-ignoring child group with KILL and leaves no descendants", async () => {
    await withDirectory(async directory => {
      const marker = join(directory, "ready");
      const owned = createInstallProcess(processOptions(directory, ignoringTerm, marker));
      const controller = new AbortController();
      const run = owned.run(controller.signal);
      run.catch(() => undefined);
      let pids: ProcessIds | undefined;
      try {
        pids = await waitForMarker(marker);
        controller.abort();
        await expect(owned.stop(AbortSignal.timeout(2_000))).resolves.toBeUndefined();
        await expect(run).rejects.toThrow(/failed or cancelled/);
        await waitForGone(pids);
      } finally {
        killGroup(pids);
      }
    });
  });

  it("stops a surviving descendant after the foreground parent exits naturally", async () => {
    await withDirectory(async directory => {
      const marker = join(directory, "ready");
      const script = [
        "trap '' TERM HUP INT",
        "( trap '' TERM HUP INT; while :; do sleep 1; done ) &",
        "grandchild=$!",
        "printf '%s %s\\n' \"$$\" \"$grandchild\" > \"$MARKER\"",
        "exit 0",
      ].join("\n");
      const owned = createInstallProcess(processOptions(directory, script, marker));
      let pids: ProcessIds | undefined;
      try {
        const run = owned.run(new AbortController().signal);
        run.catch(() => undefined);
        pids = await waitForMarker(marker);
        await expect(run).resolves.toBeUndefined();
        await expect(owned.stop(AbortSignal.timeout(2_000))).resolves.toBeUndefined();
        await waitForGone(pids);
      } finally {
        killGroup(pids);
      }
    });
  });

  it("does not spawn when the run signal is already aborted", async () => {
    await withDirectory(async directory => {
      const marker = join(directory, "must-not-exist");
      const controller = new AbortController();
      controller.abort();
      const owned = createInstallProcess(processOptions(directory, "printf ready > \"$MARKER\"", marker));

      expect(() => owned.run(controller.signal)).toThrow(/aborted|abort/i);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reports a failed spawn without exposing the executable or path", async () => {
    await withDirectory(async directory => {
      const owned = createInstallProcess({
        ...processOptions(directory, "exit 0", join(directory, "unused")),
        executable: "/definitely/missing/controlled-install-executable",
      });

      await expect(owned.run(new AbortController().signal)).rejects.toThrow("install process spawn failed");
    });
  });

  it("reports nonzero foreground exit as failed work", async () => {
    await withDirectory(async directory => {
      const owned = createInstallProcess(processOptions(directory, "exit 7", join(directory, "unused")));

      await expect(owned.run(new AbortController().signal)).rejects.toThrow(/failed or cancelled/);
    });
  });
});

describe("controlled install checker CLI", () => {
  it("returns a sanitized result for malformed JSON", async () => {
    await withDirectory(async directory => {
      const malformed = join(directory, "malformed.json");
      const second = join(directory, "second.json");
      await writeFile(malformed, "{ private-path: not-json");
      await writeFile(second, "{}");
      const cli = resolve(dirname(new URL(import.meta.url).pathname), "../scripts/check-controlled-install.ts");
      const loader = resolve("node_modules/tsx/dist/loader.mjs");
      const child = spawn(execPath, ["--import", loader, cli, malformed, second], {
        cwd: resolve("."),
        env: { PATH: "/usr/bin:/bin", FORCE_COLOR: "0", NODE_NO_WARNINGS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      const exitCode = await new Promise<number>((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolveExit(code ?? -1));
      });

      expect(exitCode).toBe(2);
      expect(await stdout).toBe("");
      expect(await stderr).toBe('{"admit":false,"reasons":["input-read-failed"],"observedAt":null,"source":null}\n');
    });
  });
});

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", chunk => { output += chunk; });
    stream.once("end", () => resolveOutput(output));
    stream.once("error", reject);
  });
}
