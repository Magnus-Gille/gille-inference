#!/usr/bin/env tsx
/** Diagnostic only: this output cannot satisfy the controlled-install host-probe schema. */
import { observeGpuLeaseMutex } from "../src/homeserver/gpu-lease-observation.js";
import { observeBackendActivity, validateBackendTargets } from "../src/homeserver/backend-activity-observation.js";

const usage = "Read-only: observe-install-activity --lease-dir DIR [--backend ID=http://127.0.0.1:PORT/metrics ...] [--timeout-ms 2000]";
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  let dir: string | undefined;
  let timeoutMs: number | undefined;
  const targets: Array<{ id: string; url: string }> = [];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error("invalid arguments");
    if (key === "--lease-dir" && dir === undefined) dir = value;
    else if (key === "--timeout-ms" && timeoutMs === undefined && /^[1-9][0-9]*$/.test(value)) timeoutMs = Number(value);
    else if (key === "--backend") {
      const split = value.indexOf("=");
      if (split < 1) throw new Error("invalid arguments");
      targets.push({ id: value.slice(0, split), url: value.slice(split + 1) });
    } else throw new Error("invalid arguments");
  }
  if (!dir || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs > 30_000))) throw new Error("invalid arguments");
  validateBackendTargets(targets);
  const [lease, backend] = await Promise.all([
    observeGpuLeaseMutex(dir, { timeoutMs }), observeBackendActivity(targets, { timeoutMs }),
  ]);
  console.log(JSON.stringify({ schemaVersion: 1, source: "install-activity-diagnostic-v1", lease, backend }));
  // Successful observation means known samples, never admission or an idle/coverage guarantee.
  process.exitCode = lease.state !== "unknown" && backend.targets.length > 0 &&
    backend.targets.every(t => t.state === "observed") ? 0 : 1;
}
main().catch(() => {
  console.error(JSON.stringify({ source: "install-activity-diagnostic-v1", reason: "invalid-input-or-observation-failed" }));
  process.exitCode = 2;
});
