#!/usr/bin/env tsx
/** Read-only diagnostic, not an installation admission check. */
import { observeLinuxHostInventory } from "../src/homeserver/linux-host-inventory.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node --import tsx scripts/observe-host-inventory.ts [--timeout-ms 1..30000]\nReads visible Linux procfs only; does not provide complete host coverage or installation admission.");
    return;
  }
  let timeoutMs = 5000;
  if (args.length !== 0) {
    if (args.length !== 2 || args[0] !== "--timeout-ms" || !/^[1-9][0-9]{0,4}$/.test(args[1])) throw new Error("invalid input");
    timeoutMs = Number(args[1]);
    if (timeoutMs > 30000) throw new Error("invalid input");
  }
  const report = await observeLinuxHostInventory({ timeoutMs });
  console.log(JSON.stringify(report));
  process.exitCode = report.observation === "observed" ? 0 : 1;
}
void main().catch(() => {
  console.log(JSON.stringify({ source: "linux-host-inventory-v1", observation: "unknown", coverage: "unknown", reason: "invalid-input-or-observation-failed" }));
  process.exitCode = 2;
});
