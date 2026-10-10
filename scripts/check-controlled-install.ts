#!/usr/bin/env tsx
/** Read-only contract checker. A stored observation is never live execution authorization. */
import { readFile, stat } from "node:fs/promises";
import { evaluateControlledInstall } from "../src/homeserver/controlled-install.js";

async function json(path: string): Promise<unknown> {
  if ((await stat(path)).size > 64 * 1024) throw new Error("input-too-large");
  const bytes = await readFile(path);
  if (bytes.byteLength > 64 * 1024) throw new Error("input-too-large");
  return JSON.parse(bytes.toString("utf8"));
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3 || args.includes("--help")) {
    console.log("Read-only: check-controlled-install PLAN.json OBSERVATION.json [BASELINE.json]");
    process.exitCode = args.includes("--help") ? 0 : 2;
    return;
  }
  const decision = evaluateControlledInstall(await json(args[0]!), await json(args[1]!),
    args[2] === undefined ? undefined : await json(args[2]));
  console.log(JSON.stringify(decision));
  process.exitCode = decision.admit ? 0 : 1;
}
main().catch(() => {
  // JSON parser and filesystem errors can contain input content or private paths.
  console.error(JSON.stringify({ admit: false, reasons: ["input-read-failed"], observedAt: null, source: null }));
  process.exitCode = 2;
});
