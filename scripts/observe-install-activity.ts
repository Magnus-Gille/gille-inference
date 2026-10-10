#!/usr/bin/env tsx
/** Diagnostic only: this output cannot satisfy the controlled-install host-probe schema. */
import { observeGpuLeaseMutex } from "../src/homeserver/gpu-lease-observation.js";
import { observeBackendActivity, validateBackendTargets } from "../src/homeserver/backend-activity-observation.js";
import { observeBoundBackendActivity } from "../src/homeserver/bound-backend-activity.js";

const usage = "Read-only: observe-install-activity --lease-dir DIR [--backend ID=http://127.0.0.1:PORT/metrics ...] [--runtime ID=PID ...] [--expect-runtime ID=SHA256 ...] [--expect-host SHA256] [--timeout-ms 2000]";
const digest = /^[a-f0-9]{64}$/;
const maxPid = 2_147_483_647;
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  let dir: string | undefined;
  let timeoutMs: number | undefined;
  const targets: Array<{ id: string; url: string }> = [];
  const runtimes = new Map<string, number>();
  const expectedRuntimes = new Map<string, string>();
  let expectedHost: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error("invalid arguments");
    if (key === "--lease-dir" && dir === undefined) dir = value;
    else if (key === "--timeout-ms" && timeoutMs === undefined && /^[1-9][0-9]*$/.test(value)) timeoutMs = Number(value);
    else if (key === "--backend") {
      const split = value.indexOf("=");
      if (split < 1) throw new Error("invalid arguments");
      targets.push({ id: value.slice(0, split), url: value.slice(split + 1) });
    } else if (key === "--runtime") {
      const split = value.indexOf("=");
      if (split < 1 || !/^[1-9][0-9]*$/.test(value.slice(split + 1))) throw new Error("invalid arguments");
      const pid = Number(value.slice(split + 1));
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > maxPid || runtimes.has(value.slice(0, split))) throw new Error("invalid arguments");
      runtimes.set(value.slice(0, split), pid);
    } else if (key === "--expect-runtime") {
      const split = value.indexOf("=");
      if (split < 1 || !digest.test(value.slice(split + 1)) || expectedRuntimes.has(value.slice(0, split))) throw new Error("invalid arguments");
      expectedRuntimes.set(value.slice(0, split), value.slice(split + 1));
    } else if (key === "--expect-host" && expectedHost === undefined && digest.test(value)) expectedHost = value;
    else throw new Error("invalid arguments");
  }
  if (!dir || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs > 30_000))) throw new Error("invalid arguments");
  validateBackendTargets(targets);
  const bound = runtimes.size > 0 || expectedRuntimes.size > 0 || expectedHost !== undefined;
  if (bound) {
    if (targets.length === 0 || runtimes.size !== targets.length || expectedRuntimes.size > runtimes.size ||
        [...runtimes.keys()].some(id => !targets.some(target => target.id === id)) ||
        [...expectedRuntimes.keys()].some(id => !runtimes.has(id))) throw new Error("invalid arguments");
  }
  const [lease, backend] = await Promise.all([
    observeGpuLeaseMutex(dir, { timeoutMs }),
    bound
      ? observeBoundBackendActivity(targets.map(target => ({ ...target, pid: runtimes.get(target.id)!, ...(expectedRuntimes.has(target.id) ? { expectedIdentitySha256: expectedRuntimes.get(target.id) } : {}) })), { timeoutMs, expectedHostBootIdSha256: expectedHost })
      : observeBackendActivity(targets, { timeoutMs }),
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
