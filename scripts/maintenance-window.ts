#!/usr/bin/env tsx
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  childEnvironmentWithoutMaintenanceKey,
  parseMaintenanceWindowArgs,
  runMaintenanceWindowCommand,
} from "../src/homeserver/maintenance-window-client.js";

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function runChild(command: string[], _opened: unknown, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    let abortKillTimer: NodeJS.Timeout | undefined;
    const child = spawn(command[0]!, command.slice(1), {
      stdio: "inherit",
      env: childEnvironmentWithoutMaintenanceKey(process.env),
    });
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const abortForExpiry = (): void => {
      if (!child.killed) {
        child.kill("SIGTERM");
        abortKillTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        abortKillTimer.unref();
      }
    };
    signal.addEventListener("abort", abortForExpiry, { once: true });
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward);
    const cleanup = (): void => {
      for (const forwarded of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.removeListener(forwarded, forward);
      }
      signal.removeEventListener("abort", abortForExpiry);
      if (abortKillTimer) clearTimeout(abortKillTimer);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1));
    });
  });
}

async function main(): Promise<void> {
  const plan = parseMaintenanceWindowArgs(process.argv.slice(2));
  const evidence = await runMaintenanceWindowCommand(plan, {
    fetch,
    apiKey: process.env["M5_MAINTENANCE_KEY"] ?? "",
    runChild,
  });
  if (plan.evidencePath !== undefined) await atomicWriteJson(plan.evidencePath, evidence);
  console.log(JSON.stringify(evidence));
  process.exitCode = evidence.childExitCode;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
